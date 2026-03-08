import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { TimeoutError } from 'rxjs';
import {
  CapitalAllocationTelemetryEvent,
  DetectorService,
  GlobalCapitalAllocatorOrchestrator,
  MlTelemetryEvent,
  PortfolioTelemetryEvent,
  RiskTelemetryEvent,
  SignalTelemetryEvent,
  TelemetryWriter,
} from '@barfinex/detector';
import {
  CapitalAllocatorActivePosition,
  CapitalAllocatorCandidateTrade,
  CapitalAllocatorDecision,
  GlobalCapitalAllocatorConfig,
  AggregateSignalScore,
  DEFAULT_TREND_PROFILE,
  applyMLHook,
  MLDirection,
  MLHookPolicy,
  MLSignalResponse,
  SignalDirection,
  TrendSignalEngine,
  TrendSignalProfile,
  DEFAULT_RISK_PROFILE,
  RiskDecision,
  RiskEngine,
  RiskProfile,
  PortfolioDecision,
  PortfolioEngine,
} from './enterprise.engines';
import { IndicatorsService } from '../../../../../libs/indicators/src';
import {
  Candle,
  Account,
  Trade,
  Order,
  OrderBook,
  Detector,
  TimeFrame,
  BaseEvent,
  ConnectorType,
  AdvisorDecision,
  AdvisorLlmDecisionRequest,
  AdvisorLlmDecisionResponse,
  AdvisorMarketRegime,
  DetectorConfigInput,
  DetectorSignalPayload,
  EventSource,
  EventMetadata,
  MarketType,
  SubscriptionType,
  assertEventSourceMatch,
} from '@barfinex/types';
import {
  FollowTrendConfigService,
  FollowTrendCustomConfig,
  FollowTrendIndicatorMapping,
  DEFAULT_INDICATOR_MAPPING,
} from './follow-trend.config';
import { FeatureBuilder } from './features/feature.builder';
import { EngineeredFeatureSet, FeatureComputationContext } from './features/feature.types';
import { alignHigherTimeframeTrend } from './features/feature.transforms';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { safeClientProxyEmit } from '@barfinex/utils';

type RiskAwareDetectorPayload = DetectorSignalPayload & {
  size: number;
  stopDistancePct: number;
  riskAmount: number;
  correlationId?: string;
};

interface FollowTrendMlPolicy extends MLHookPolicy {
  maxInFlight: number;
}

interface MlDecisionTelemetryMeta {
  ruleConfidence: number;
  mlConfidence?: number;
  finalConfidence: number;
  branch: 'ml-only' | 'hybrid' | 'fallback' | 'timeout';
  regime?: string;
  reasonCode?: string;
  reasons: string[];
  authorityMode: 'rule-first' | 'ai-dominant' | 'ai-autonomous';
  standDown: boolean;
  cooldownMs?: number;
  riskBoostApplied?: number;
  guardrailTriggers: string[];
}

interface MlEvaluationOutcome {
  decision: AggregateSignalScore;
  telemetry: MlDecisionTelemetryMeta;
  riskBoostApplied?: number;
}

interface FollowTrendGuardrailsConfig {
  timeoutDominance: {
    enabled: boolean;
    maxConsecutiveTimeouts: number;
    cooldownMs: number;
  };
  lossStreak: {
    enabled: boolean;
    maxConsecutiveLosses: number;
    cooldownMs: number;
  };
  volatilityShock: {
    enabled: boolean;
    atrPctThreshold: number;
    confidenceMultiplier: number;
  };
  conflictExplosion: {
    enabled: boolean;
    maxConsecutiveConflicts: number;
    confidenceMultiplier: number;
  };
}

interface FollowTrendIntentRateLimit {
  maxIntents: number;
  windowMs: number;
}

interface FollowTrendGlobalAllocatorConfig {
  enabled: boolean;
  maxTotalExposurePct: number;
  maxExposurePerSymbolPct: number;
  riskBudgetPct?: number;
  breachAction: 'scale' | 'deny';
  reservationTtlMs: number;
  idempotencyTtlMs: number;
}

@Injectable()
export class FollowTrendService extends DetectorService {
  private signalEngine: TrendSignalEngine = new TrendSignalEngine(DEFAULT_TREND_PROFILE);
  private readonly featureBuilder: FeatureBuilder;
  private riskEngine: RiskEngine = new RiskEngine(DEFAULT_RISK_PROFILE);
  private readonly portfolioEngine = new PortfolioEngine();
  private readonly processedCandleKeys = new Set<string>();
  private readonly processedCandleQueue: string[] = [];
  private readonly maxProcessedCandleKeys = 4096;
  private mlInFlight = 0;
  private readonly activeMlRequests = new Set<string>();
  private correlationSequence = 0;
  private autonomousCooldownUntil = 0;
  private mlConsecutiveTimeouts = 0;
  private mlConsecutiveConflicts = 0;
  private timeoutDominanceUntil = 0;

  constructor(
    @Inject(forwardRef(() => PluginDriverService))
    protected pluginDriverService: PluginDriverService,
    protected readonly connectorService: ConnectorService,
    protected readonly keyService: KeyService,
    protected readonly orderService: OrderService,
    protected readonly configService: ConfigService,
    @Inject('PROVIDER_SERVICE') client: ClientProxy,
    protected readonly localConfig: FollowTrendConfigService,
    protected readonly indicatorsService: IndicatorsService,
    protected readonly telemetryWriter: TelemetryWriter,
    @Optional() _mergedInitial?: Partial<Detector>,
    @Optional()
    protected readonly globalCapitalAllocator?: GlobalCapitalAllocatorOrchestrator,
  ) {
    super(
      pluginDriverService,
      connectorService,
      keyService,
      orderService,
      configService,
      client,
      _mergedInitial
        ? { detector: _mergedInitial as DetectorConfigInput }
        : localConfig,
      _mergedInitial,
    );
    this.indicators = {};
    this.featureBuilder = new FeatureBuilder(this.indicatorsService);
  }

  async onInit() {
    /**
     * SignalEngine — чистая бизнес-логика сигналов.
     * Не знает про Nest, Redis и Provider.
     */
    this.signalEngine = new TrendSignalEngine(this.getSignalProfile());
    /**
     * RiskEngine — pre-trade слой.
     * Работает до Inspector и не делает runtime-risk.
     */
    this.riskEngine = new RiskEngine(this.getRiskProfile());
    this.validateIndicatorMappingAgainstIndicators();

    for (const symbol of this.options.symbols) {
      const symbolName = symbol.name;
      this.indicators[symbolName] = this.indicators[symbolName] ?? {};

      for (const interval of this.options.intervals) {
        const group = this.indicatorsService.createIndicatorGroup(
          this.options.indicators ?? [],
          (config, error) => this.logger.warn(`[indicators] skip ${config.name}: ${String(error)}`),
        );
        this.indicators[symbolName][interval] = group;
        this.indicatorsService.warmupGroup(group, this.candles[symbolName]?.[interval]);
      }
    }
  }

  async onTrade(
    _trade: Trade,
    _connectorType?: ConnectorType,
    _marketType?: MarketType,
  ) {
    // Strategy orchestration executes on candle close.
  }

  async onCandleUpdate(candle: Candle, trade: Trade) {
    if (!this.isTrackedInterval(candle.interval)) return;
    this.indicatorsService.runGroup(
      this.indicators[candle.symbol.name]?.[candle.interval],
      'onCandleUpdate',
      candle,
      trade?.side,
    );
  }

  async onCandleOpen(candle: Candle) {
    if (!this.isTrackedInterval(candle.interval)) return;
    this.indicatorsService.runGroup(
      this.indicators[candle.symbol.name]?.[candle.interval],
      'onCandleOpen',
      candle,
    );
  }

  async onCandleClose(
    candle: Candle,
    connectorType?: ConnectorType,
    marketType?: MarketType,
    metadata?: EventMetadata,
  ) {
    if (!this.isTrackedInterval(candle.interval)) return;
    this.indicatorsService.runGroup(
      this.indicators[candle.symbol.name]?.[candle.interval],
      'onCandleClose',
      candle,
    );

    if (!this.isDecisionInterval(candle.interval)) return;
    if (this.isOpenPosition(candle.symbol)) return;
    const correlationId = this.buildCorrelationId(candle);
    if (!this.markCandleAsProcessing(candle, correlationId)) {
      this.logger.debug(`[idempotency] skip duplicate candle ${correlationId}`);
      return;
    }

    // 1) Build features (warmup gate lives here).
    const mapping = this.getIndicatorMapping();
    const featureByInterval = this.buildFeatureSets(candle.symbol.name, candle.close, mapping);
    const orderedFeatures = this.enrichWithHigherTimeframeAlignment(featureByInterval);
    if (this.isWarmupPending(candle.symbol.name, orderedFeatures)) return;

    // 2) SignalEngine aggregate (direction/score/confidence/reasons).
    const aggregate = this.aggregateSignal(candle.symbol.name, orderedFeatures);
    const mlOutcome = await this.evaluateMlHook(
      candle,
      aggregate,
      connectorType,
      marketType,
      correlationId,
    );
    const finalSignal = mlOutcome.decision;
    if (mlOutcome.telemetry.standDown && finalSignal.direction !== SignalDirection.Neutral) {
      this.logger.warn(
        `[authority] stand-down suppress ${candle.symbol.name}, cooldownMs=${mlOutcome.telemetry.cooldownMs ?? 0}`,
      );
      await this.telemetryWriter.emitRisk(
        this.buildRiskTelemetry(
          candle,
          {
            allowed: false,
            reason: 'stand-down',
            size: 0,
            riskPct: 0,
            riskAmount: 0,
            stopDistancePct: 0,
            notional: 0,
            riskBoostApplied: mlOutcome.riskBoostApplied ?? 0,
          },
          correlationId,
        ),
      );
      return;
    }
    const atrPct = this.extractAtrPct(orderedFeatures);

    // 3) Telemetry (signal explainability, no trading side effects).
    if (!this.shouldSampleSignalTelemetry(finalSignal.direction)) {
      await this.telemetryWriter.emitSignal(
        this.buildSignalTelemetry(candle, aggregate, finalSignal, correlationId, mlOutcome.telemetry),
      );
    }
    this.logger.log(
      `[signal] ${candle.symbol.name} ${finalSignal.direction} @ ${candle.close} score=${finalSignal.totalScore.toFixed(4)} confidence=${finalSignal.confidence.toFixed(4)} breakdown=${this.formatBreakdown(finalSignal)}`,
    );

    // 4) RiskEngine pre-trade sizing/suppression (before Inspector).
    const account = this.resolveAccount(connectorType, marketType);
    const riskDecision = this.riskEngine.evaluate({
      symbol: candle.symbol.name,
      price: candle.close,
      equity: this.extractAccountEquity(account),
      currentExposureNotional: this.extractCurrentExposure(account),
      regime: finalSignal.diagnostics?.regime ? String(finalSignal.diagnostics.regime) : undefined,
      volatility: { atrPct },
      signal: {
        direction: finalSignal.direction,
        score: finalSignal.totalScore,
        confidence: finalSignal.confidence,
      },
      riskBoost: mlOutcome.riskBoostApplied,
    });

    // 5) Telemetry for risk decision.
    await this.telemetryWriter.emitRisk(
      this.buildRiskTelemetry(candle, riskDecision, correlationId),
    );

    // 6) Register open intent. Inspector applies runtime SL/TP and guardrails later.
    if (!riskDecision.allowed) {
      this.logger.debug(
        `[risk] suppress ${candle.symbol.name}: reason=${riskDecision.reason ?? 'unknown'} diagnostics=${riskDecision.diagnostics?.join('|') ?? 'none'}`,
      );
      return;
    }
    if (finalSignal.direction === SignalDirection.Neutral) return;

    const rawPortfolioDecision = this.evaluatePortfolioScaling(
      candle,
      riskDecision,
      account,
      correlationId,
    );
    const portfolioDecision = this.applyPortfolioSafety(
      rawPortfolioDecision,
      riskDecision,
      correlationId,
    );
    await this.telemetryWriter.emitPortfolio(
      this.buildPortfolioTelemetry(candle, portfolioDecision, correlationId),
    );
    if (!portfolioDecision.allow) {
      this.logger.debug(
        `[portfolio] suppress ${candle.symbol.name}: ${portfolioDecision.denyReason ?? 'unknown'} diagnostics=${portfolioDecision.diagnostics.join('|')}`,
      );
      return;
    }
    const side: 'LONG' | 'SHORT' =
      finalSignal.direction === SignalDirection.Up ? 'LONG' : 'SHORT';
    const intentRateLimit = this.getIntentRateLimitConfig();
    const rateLimitCheck = this.checkIntentRateLimit({
      instanceId: this.options.sysname || this.constructor.name,
      symbol: candle.symbol.name,
      interval: candle.interval ?? this.options.intervals[0] ?? TimeFrame.min1,
      eventTs: this.resolveCandleCloseTime(candle),
      maxIntents: intentRateLimit.maxIntents,
      windowMs: intentRateLimit.windowMs,
    });
    // WHY: Защита от дребезга сигналов и runaway loops на min1/multi-instance.
    if (!rateLimitCheck.allowed) {
      await this.telemetryWriter.emitRisk(
        this.buildRiskTelemetry(
          candle,
          {
            ...riskDecision,
            allowed: false,
            reason: 'rate-limit',
          },
          correlationId,
        ),
      );
      this.logger.warn(
        `[intent-rate-limit] suppress ${rateLimitCheck.key} count=${rateLimitCheck.currentCount} windowMs=${intentRateLimit.windowMs}`,
      );
      return;
    }

    const globalAllocationDecision = await this.evaluateGlobalCapitalAllocation({
      candle,
      side,
      correlationId,
      riskDecision,
      portfolioDecision,
      account,
    });
    await this.telemetryWriter.emitCapitalAllocation(
      this.buildCapitalAllocationTelemetry(candle, globalAllocationDecision, correlationId),
    );
    if (!globalAllocationDecision.allowed) {
      this.logger.debug(
        `[capital] suppress ${candle.symbol.name}: reason=${globalAllocationDecision.reason ?? 'unknown'} totalBefore=${globalAllocationDecision.diagnostics.totalExposureBefore.toFixed(2)} totalAfter=${globalAllocationDecision.diagnostics.totalExposureAfter.toFixed(2)}`,
      );
      return;
    }

    const finalScaleFactor = portfolioDecision.scaleFactor * globalAllocationDecision.scaleFactor;
    const scaledSize = riskDecision.size * finalScaleFactor;
    if (!Number.isFinite(scaledSize) || scaledSize <= 0 || finalScaleFactor <= 0) {
      return;
    }

    this.emitPositionOpenIntent(
      {
        symbol: candle.symbol,
        side,
        confidence: finalSignal.confidence,
        strategyId: this.options.sysname || this.constructor.name,
        size: scaledSize,
        stopDistancePct: riskDecision.stopDistancePct,
        riskAmount: riskDecision.riskAmount * finalScaleFactor,
        correlationId,
      },
      connectorType,
      marketType,
      correlationId,
      metadata?.traceId || metadata?.eventId,
    );
    this.logger.log(
      `[risk] intent ${candle.symbol.name} side=${side} size=${scaledSize.toFixed(6)} stopDistancePct=${riskDecision.stopDistancePct.toFixed(6)} riskPct=${riskDecision.riskPct.toFixed(4)} portfolioScale=${portfolioDecision.scaleFactor.toFixed(4)} globalScale=${globalAllocationDecision.scaleFactor.toFixed(4)}`,
    );
  }

  async onOrderClose(_order: Order) {}
  async onOrderOpen(_order: Order) {}
  async onAccountUpdate(_account: Account) {}
  async onOrderBookUpdate(_orderbook: OrderBook) {}

  private aggregateSignal(
    symbol: string,
    orderedFeatures: Array<EngineeredFeatureSet | null>,
  ): AggregateSignalScore {
    const perInterval = this.options.intervals.map((interval, index) => {
      const features = orderedFeatures[index] ?? null;
      if (!features) {
        return {
          interval,
          score: 0,
          reasons: ['no-features'],
        };
      }

      const barsCount = this.candles[symbol]?.[interval]?.length ?? 0;
      return this.signalEngine.evaluateInterval(features, {
        barsCount,
        timestamp: features.meta?.timestamp,
      });
    });

    return this.signalEngine.aggregate(perInterval);
  }

  private buildFeatureSets(
    symbol: string,
    price: number,
    mapping: FollowTrendIndicatorMapping,
  ): Map<TimeFrame, EngineeredFeatureSet | null> {
    const byInterval = new Map<TimeFrame, EngineeredFeatureSet | null>();
    for (const interval of this.options.intervals) {
      const ctx = this.createFeatureContext(symbol, interval, price);
      const featureSet = this.featureBuilder.buildTrendFeatures(ctx, mapping);
      byInterval.set(interval, featureSet);
    }
    return byInterval;
  }

  private enrichWithHigherTimeframeAlignment(
    byInterval: Map<TimeFrame, EngineeredFeatureSet | null>,
  ): Array<EngineeredFeatureSet | null> {
    return this.options.intervals.map((interval, index) => {
      const lower = byInterval.get(interval) ?? null;
      if (!lower) return null;

      const higher = this.findHigherTimeframeFeature(index, byInterval);
      if (higher) {
        lower.values.htfAlignment = alignHigherTimeframeTrend(lower, higher);
      }
      return lower;
    });
  }

  private findHigherTimeframeFeature(
    lowerIndex: number,
    byInterval: Map<TimeFrame, EngineeredFeatureSet | null>,
  ): EngineeredFeatureSet | null {
    for (let index = lowerIndex + 1; index < this.options.intervals.length; index += 1) {
      const higherInterval = this.options.intervals[index];
      const higher = byInterval.get(higherInterval) ?? null;
      if (higher) return higher;
    }
    return null;
  }

  private createFeatureContext(
    symbol: string,
    interval: TimeFrame,
    price: number,
  ): FeatureComputationContext {
    return {
      symbol,
      interval,
      price,
      candles: this.candles[symbol]?.[interval] ?? [],
      indicatorsGroup: this.indicators[symbol]?.[interval],
    };
  }

  private isTrackedInterval(interval: TimeFrame | undefined): interval is TimeFrame {
    if (!interval) return false;
    return this.options.intervals.includes(interval);
  }

  private isDecisionInterval(interval: TimeFrame): boolean {
    return interval === (this.options.intervals[0] ?? interval);
  }

  private isWarmupPending(
    symbol: string,
    orderedFeatures: Array<EngineeredFeatureSet | null>,
  ): boolean {
    const signalProfile = this.getSignalProfile();
    const strictWarmup = signalProfile.readiness?.strictWarmup === true;
    const defaultMinBars = signalProfile.readiness?.defaultMinBars ?? 0;
    const minByInterval = signalProfile.readiness?.minBarsByInterval ?? {};

    return this.options.intervals.some((interval, index) => {
      const featureSet = orderedFeatures[index] ?? null;
      if (!featureSet) return true;
      if (!strictWarmup) return false;
      const barsCount = this.candles[symbol]?.[interval]?.length ?? 0;
      const minBars = minByInterval[interval] ?? defaultMinBars;
      return barsCount < minBars;
    });
  }

  private getSignalProfile(): TrendSignalProfile {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    return customConfig?.signalProfile ?? DEFAULT_TREND_PROFILE;
  }

  private getRiskProfile(): RiskProfile {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    return customConfig?.riskProfile ?? DEFAULT_RISK_PROFILE;
  }

  private getIndicatorMapping(): FollowTrendIndicatorMapping {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    return customConfig?.indicatorMapping ?? DEFAULT_INDICATOR_MAPPING;
  }

  private validateIndicatorMappingAgainstIndicators(): void {
    const mapping = this.getIndicatorMapping();
    const configuredKeys = new Set(
      (this.options.indicators ?? []).map((config) => this.indicatorsService.indicatorKey(config)),
    );
    const requiredKeys = [
      mapping.smaFastKey,
      mapping.smaMidKey,
      mapping.smaSlowKey,
      mapping.rsiKey,
      mapping.adxKey,
      mapping.macdKey,
    ];
    const missing = requiredKeys.filter((key) => !configuredKeys.has(key));
    if (missing.length > 0) {
      this.logger.warn(
        `[signal-mapping] Missing indicators in config: ${missing.join(', ')}. Strategy may stay in Neutral state.`,
      );
    }
  }

  private formatBreakdown(result: AggregateSignalScore): string {
    return result.perInterval
      .map((entry) => {
        const reasons = entry.reasons.length > 0 ? entry.reasons.join('|') : 'none';
        return `${entry.interval}:${entry.score.toFixed(4)}:${reasons}`;
      })
      .join(', ');
  }

  private extractAtrPct(features: Array<EngineeredFeatureSet | null>): number | undefined {
    for (const featureSet of features) {
      const atrPct = featureSet?.values?.atrPct;
      if (typeof atrPct === 'number' && Number.isFinite(atrPct) && atrPct > 0) {
        return atrPct;
      }
    }
    return undefined;
  }

  private resolveAccount(
    connectorType?: ConnectorType,
    marketType?: MarketType,
  ): Account | undefined {
    if (connectorType && marketType) {
      return this.accounts.find(
        (account) =>
          account.connectorType === connectorType && account.marketType === marketType,
      );
    }
    return this.accounts[0];
  }

  private extractAccountEquity(account?: Account): number {
    if (!account) return 0;
    const quoteCurrency = (this.options.currency ?? 'USDT').toUpperCase();
    const quoteAsset = account.assets.find(
      (asset) => asset.symbol?.name?.toUpperCase() === quoteCurrency,
    );
    if (quoteAsset) {
      const wallet = Number(quoteAsset.walletBalance ?? 0);
      if (Number.isFinite(wallet) && wallet > 0) return wallet;
      const available = Number(quoteAsset.availableBalance ?? 0);
      if (Number.isFinite(available) && available > 0) return available;
    }

    return account.assets.reduce((acc, asset) => {
      const value = Number(asset.walletBalance ?? asset.availableBalance ?? 0);
      return acc + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
  }

  private extractCurrentExposure(account?: Account): number {
    if (!account) return 0;
    return (account.positions ?? []).reduce((acc, position) => {
      const quantity = Math.abs(Number(position.quantity ?? 0));
      const entryPrice = Number(position.entryPrice ?? position.lastPrice ?? 0);
      if (!Number.isFinite(quantity) || !Number.isFinite(entryPrice)) return acc;
      return acc + quantity * Math.max(0, entryPrice);
    }, 0);
  }

  private extractSymbolExposure(account: Account | undefined, symbolName: string): number {
    if (!account) return 0;
    return (account.positions ?? []).reduce((acc, position) => {
      if (position.symbol?.name !== symbolName) return acc;
      const quantity = Math.abs(Number(position.quantity ?? 0));
      const entryPrice = Number(position.entryPrice ?? position.lastPrice ?? 0);
      if (!Number.isFinite(quantity) || !Number.isFinite(entryPrice)) return acc;
      return acc + quantity * Math.max(0, entryPrice);
    }, 0);
  }

  private buildCapitalAllocatorPositions(account: Account | undefined): CapitalAllocatorActivePosition[] {
    if (!account) return [];
    return (account.positions ?? []).map((position) => {
      const quantity = Number(position.quantity ?? 0);
      const referencePrice = Number(position.entryPrice ?? position.lastPrice ?? 0);
      const notional = Math.abs(quantity) * Math.max(0, referencePrice);
      return {
        symbol: position.symbol?.name ?? 'UNKNOWN',
        notional,
        direction: quantity >= 0 ? 'LONG' : 'SHORT',
      };
    });
  }

  private emitPositionOpenIntent(
    payload: RiskAwareDetectorPayload,
    connectorType?: ConnectorType,
    marketType?: MarketType,
    correlationId?: string,
    traceId?: string,
  ): void {
    const type = SubscriptionType.DETECTOR_POSITION_OPEN_REQUEST;
    assertEventSourceMatch(type, EventSource.DETECTOR);
    for (const provider of this.providers ?? []) {
      for (const connector of provider.connectors ?? []) {
        if (!connector.isActive) continue;
        if (connectorType && connector.connectorType !== connectorType) continue;

        for (const market of connector.markets ?? []) {
          if (marketType && market.marketType !== marketType) continue;
          const now = Date.now();
          const event: BaseEvent<SubscriptionType.DETECTOR_POSITION_OPEN_REQUEST, RiskAwareDetectorPayload> =
            {
              eventId: `detector:${this.options.sysname}:POSITION_OPENED:${now}`,
              type,
              source: EventSource.DETECTOR,
              timestamp: now,
              // WHY: correlationId связывает весь трейс candle->signal->risk->portfolio->intent.
              correlationId,
              payload,
            };
          const metadata = this.buildEventMetadata(event.eventId, traceId || correlationId);
          safeClientProxyEmit({
            client: this.client,
            pattern: type,
            payload: {
              value: event,
              metadata,
              options: {
                connectorType: connector.connectorType,
                marketType: market.marketType,
                key: this.options.key,
                updateMoment: now,
              },
            },
            logger: this.logger,
            errorContext: '[detector.followTrend.emitPositionOpenIntent]',
          });
        }
      }
    }
  }

  private buildSignalTelemetry(
    candle: Candle,
    ruleDecision: AggregateSignalScore,
    finalDecision: AggregateSignalScore,
    correlationId: string,
    mlMeta?: MlDecisionTelemetryMeta,
  ): SignalTelemetryEvent {
    const reasons = finalDecision.perInterval.flatMap((entry) => entry.reasons ?? []);
    return {
      ts: this.resolveCandleCloseTime(candle),
      eventType: 'signal',
      source: 'detector',
      detector: this.options.sysname || this.constructor.name,
      sysName: this.options.sysname || this.constructor.name,
      instanceId: this.options.sysname || this.constructor.name,
      correlationId,
      symbol: candle.symbol.name,
      interval: this.resolvePrimaryInterval(finalDecision),
      direction: finalDecision.direction,
      score: finalDecision.totalScore,
      confidence: finalDecision.confidence,
      ruleConfidence: ruleDecision.confidence,
      mlConfidence: mlMeta?.mlConfidence,
      finalConfidence: finalDecision.confidence,
      branch: mlMeta?.branch,
      regime: finalDecision.diagnostics?.regime
        ? String(finalDecision.diagnostics.regime)
        : mlMeta?.regime,
      reasonCode: mlMeta?.reasonCode,
      reasons,
      authorityMode: mlMeta?.authorityMode,
      standDown: mlMeta?.standDown,
      cooldownMs: mlMeta?.cooldownMs,
      riskBoostApplied: mlMeta?.riskBoostApplied,
      guardrailTriggers: mlMeta?.guardrailTriggers,
    };
  }

  private buildRiskTelemetry(
    candle: Candle,
    decision: RiskDecision,
    correlationId: string,
  ): RiskTelemetryEvent {
    return {
      ts: this.resolveCandleCloseTime(candle),
      eventType: 'risk',
      source: 'detector',
      detector: this.options.sysname || this.constructor.name,
      sysName: this.options.sysname || this.constructor.name,
      instanceId: this.options.sysname || this.constructor.name,
      correlationId,
      symbol: candle.symbol.name,
      allowed: decision.allowed,
      reason: decision.reason,
      size: decision.size,
      riskPct: decision.riskPct,
      riskAmount: decision.riskAmount,
      stopDistancePct: decision.stopDistancePct,
      notional: decision.notional,
      riskBoostApplied: decision.riskBoostApplied,
    };
  }

  private resolvePrimaryInterval(aggregate: AggregateSignalScore): TimeFrame {
    const strongest = aggregate.perInterval
      .slice()
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
    return strongest?.interval ?? this.options.intervals[0] ?? TimeFrame.min1;
  }

  private buildMlTelemetry(
    candle: Candle,
    correlationId: string,
    policy: MLHookPolicy,
    ruleDecision: AggregateSignalScore,
    fallbackUsed: boolean,
    timeoutTriggered: boolean,
    latencyMs: number,
    finalDecision: AggregateSignalScore,
    mlConfidence: number | undefined,
    branch: 'ml-only' | 'hybrid' | 'fallback' | 'timeout',
    reasonCode: string | undefined,
    reasons: string[],
    authorityMode: 'rule-first' | 'ai-dominant' | 'ai-autonomous',
    standDown: boolean,
    cooldownMs: number | undefined,
    riskBoostApplied: number | undefined,
    guardrailTriggers: string[],
  ): MlTelemetryEvent {
    return {
      ts: this.resolveCandleCloseTime(candle),
      eventType: 'ml',
      source: 'detector',
      detector: this.options.sysname || this.constructor.name,
      sysName: this.options.sysname || this.constructor.name,
      instanceId: this.options.sysname || this.constructor.name,
      correlationId,
      symbol: candle.symbol.name,
      mode: policy.mode,
      usedFallback: fallbackUsed,
      timeout: timeoutTriggered,
      latencyMs,
      direction: finalDecision.direction,
      confidence: finalDecision.confidence,
      ruleConfidence: ruleDecision.confidence,
      mlConfidence,
      finalConfidence: finalDecision.confidence,
      branch,
      regime: finalDecision.diagnostics?.regime
        ? String(finalDecision.diagnostics.regime)
        : undefined,
      reasonCode,
      reasons,
      authorityMode,
      standDown,
      cooldownMs,
      riskBoostApplied,
      guardrailTriggers,
    };
  }

  private buildPortfolioTelemetry(
    candle: Candle,
    decision: PortfolioDecision,
    correlationId: string,
  ): PortfolioTelemetryEvent {
    return {
      ts: this.resolveCandleCloseTime(candle),
      eventType: 'portfolio',
      source: 'detector',
      detector: this.options.sysname || this.constructor.name,
      sysName: this.options.sysname || this.constructor.name,
      instanceId: this.options.sysname || this.constructor.name,
      correlationId,
      symbol: candle.symbol.name,
      allow: decision.allow,
      scaleFactor: decision.scaleFactor,
      portfolioVolBefore: decision.portfolioVolBefore,
      portfolioVolAfter: decision.portfolioVolAfter,
      averageCorrelationToPortfolio: decision.averageCorrelationToPortfolio,
      diagnostics: decision.diagnostics,
    };
  }

  private buildCapitalAllocationTelemetry(
    candle: Candle,
    decision: CapitalAllocatorDecision,
    correlationId: string,
  ): CapitalAllocationTelemetryEvent {
    const totalEquity = Math.max(0, Number(decision.diagnostics.totalEquity ?? 0));
    const maxTotalExposurePct =
      totalEquity > 0
        ? (Math.max(0, decision.diagnostics.maxTotalExposure) / totalEquity) * 100
        : 0;
    const maxExposurePerSymbolPct =
      totalEquity > 0
        ? (Math.max(0, decision.diagnostics.maxSymbolExposure) / totalEquity) * 100
        : 0;
    const riskBudgetPct =
      totalEquity > 0 && decision.diagnostics.maxInstanceExposure !== undefined
        ? (Math.max(0, decision.diagnostics.maxInstanceExposure) / totalEquity) * 100
        : undefined;
    const breachAction: 'scale' | 'deny' = !decision.allowed ? 'deny' : 'scale';
    return {
      ts: this.resolveCandleCloseTime(candle),
      eventType: 'capital_allocation',
      source: 'detector',
      detector: this.options.sysname || this.constructor.name,
      sysName: this.options.sysname || this.constructor.name,
      instanceId: this.options.sysname || this.constructor.name,
      correlationId,
      idempotencyKey: decision.diagnostics.idempotencyKey ?? '',
      symbol: candle.symbol.name,
      allowed: decision.allowed,
      breachAction,
      scaleFactor: decision.scaleFactor,
      maxTotalExposurePct,
      maxExposurePerSymbolPct,
      riskBudgetPct,
      candidateNotional: decision.diagnostics.candidateNotional,
      scaledNotional: decision.diagnostics.scaledNotional,
      reservedNotional: decision.diagnostics.reservedNotional,
      reservationExpiresAt: decision.diagnostics.reservationExpiresAt,
      activeReservationsCount: decision.diagnostics.activeReservationsCount,
      exposureBefore: decision.diagnostics.totalExposureBefore,
      exposureAfter: decision.diagnostics.totalExposureAfter,
      exposurePctBefore: decision.diagnostics.exposurePctBefore,
      exposurePctAfter: decision.diagnostics.exposurePctAfter,
      totalExposureLimitNotional: decision.diagnostics.maxTotalExposure,
      totalEquity,
      reason: decision.reason,
    };
  }

  private async evaluateGlobalCapitalAllocation(params: {
    candle: Candle;
    side: 'LONG' | 'SHORT';
    correlationId: string;
    riskDecision: RiskDecision;
    portfolioDecision: PortfolioDecision;
    account?: Account;
  }): Promise<CapitalAllocatorDecision> {
    const config = this.getGlobalAllocatorConfig();
    const baseNotional = params.riskDecision.notional * params.portfolioDecision.scaleFactor;
    const safeCandidateNotional = Math.max(0, Number(baseNotional));
    const equity = this.extractAccountEquity(params.account);
    const totalExposureBefore = this.extractCurrentExposure(params.account);
    const symbolExposureBefore = this.extractSymbolExposure(params.account, params.candle.symbol.name);
    const closeTime = this.resolveCandleCloseTime(params.candle);
    const idempotencyKey = this.buildCapitalAllocationIdempotencyKeyFromInput({
      instanceId: this.options.sysname || this.constructor.name,
      symbol: params.candle.symbol.name,
      direction: params.side,
      closeTime,
      intentType: 'open',
    });
    const candidate: CapitalAllocatorCandidateTrade = {
      symbol: params.candle.symbol.name,
      direction: params.side,
      size: params.riskDecision.size * params.portfolioDecision.scaleFactor,
      notional: baseNotional,
      closeTime,
      intentType: 'open',
      correlationId: params.correlationId,
      idempotencyKey,
    };
    const maxTotalExposure = (equity * config.maxTotalExposurePct) / 100;
    const maxSymbolExposure = (equity * config.maxExposurePerSymbolPct) / 100;
    const maxInstanceExposure =
      config.riskBudgetPct === undefined ? undefined : (equity * config.riskBudgetPct) / 100;
    const exposurePctBefore = equity > 0 ? (totalExposureBefore / equity) * 100 : 0;
    const disabledBaseDiagnostics = {
      idempotencyKey,
      totalEquity: equity,
      candidateNotional: safeCandidateNotional,
      scaledNotional: safeCandidateNotional,
      reservedNotional: 0,
      reservationExpiresAt: undefined,
      activeReservationsCount: 0,
      totalExposureBefore,
      totalExposureAfter: totalExposureBefore + safeCandidateNotional,
      exposurePctBefore,
      exposurePctAfter: equity > 0 ? ((totalExposureBefore + safeCandidateNotional) / equity) * 100 : 0,
      symbolExposureBefore,
      symbolExposureAfter: symbolExposureBefore + safeCandidateNotional,
      instanceExposureBefore: 0,
      instanceExposureAfter: safeCandidateNotional,
      maxTotalExposure,
      maxSymbolExposure,
      maxInstanceExposure,
    };
    if (!config.enabled) {
      return {
        allowed: true,
        scaleFactor: 1,
        reason: 'ok',
        diagnostics: disabledBaseDiagnostics,
      };
    }
    const fallbackDecision: CapitalAllocatorDecision = {
      allowed: true,
      scaleFactor: 1,
      reason: 'ok',
      diagnostics: disabledBaseDiagnostics,
    };

    if (!this.globalCapitalAllocator) {
      return fallbackDecision;
    }

    const activePositions = this.buildCapitalAllocatorPositions(params.account);
    const globalConfig: GlobalCapitalAllocatorConfig = {
      enabled: config.enabled,
      maxTotalExposurePct: config.maxTotalExposurePct,
      maxExposurePerSymbolPct: config.maxExposurePerSymbolPct,
      perInstanceRiskBudgetPct: config.riskBudgetPct,
      breachAction: config.breachAction,
    };
    return this.globalCapitalAllocator.evaluate({
      config: globalConfig,
      candidate,
      activePositions,
      equity,
      instance: {
        instanceId: this.options.sysname || this.constructor.name,
        strategyId: this.options.sysname || this.constructor.name,
        detector: this.options.sysname || this.constructor.name,
      },
      reservationTtlMs: config.reservationTtlMs,
      idempotencyTtlMs: config.idempotencyTtlMs,
    });
  }

  private buildCapitalAllocationIdempotencyKeyFromInput(params: {
    instanceId: string;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    closeTime: number;
    intentType: 'open';
  }): string {
    return `${params.instanceId}:${params.symbol}:${params.direction}:${params.closeTime}:${params.intentType}`;
  }

  private evaluatePortfolioScaling(
    candle: Candle,
    riskDecision: RiskDecision,
    account: Account | undefined,
    correlationId: string,
  ): PortfolioDecision {
    const config = this.getPortfolioConfig();
    if (!config.enabled) {
      return {
        allow: true,
        scaleFactor: 1,
        scaledNotional: riskDecision.notional,
        portfolioVolBefore: 0,
        portfolioVolAfter: 0,
        averageCorrelationToPortfolio: 0,
        diagnostics: ['portfolio:disabled', correlationId],
      };
    }

    const positions = (account?.positions ?? []).map((position) => ({
      symbol: position.symbol?.name ?? '',
      notional:
        Math.abs(Number(position.quantity ?? 0)) *
        Math.max(0, Number(position.entryPrice ?? position.lastPrice ?? 0)),
    }));
    const trackedSymbols = new Set<string>([
      ...positions.map((position) => position.symbol),
      candle.symbol.name,
    ]);
    const returnsBySymbol: Record<string, number[]> = {};
    for (const symbol of trackedSymbols) {
      if (!symbol) continue;
      returnsBySymbol[symbol] = this.extractReturnsSeries(symbol, config.maxLookbackBars);
    }

    return this.portfolioEngine.evaluate({
      equity: this.extractAccountEquity(account),
      targetVolatility: config.targetVolatility,
      maxLookbackBars: config.maxLookbackBars,
      correlationSoftCap: config.correlationSoftCap,
      positions,
      candidate: {
        symbol: candle.symbol.name,
        notional: riskDecision.notional,
        minTradeNotional: config.minTradeNotional,
      },
      returnsBySymbol,
    });
  }

  private extractReturnsSeries(symbol: string, maxLookbackBars: number): number[] {
    // WHY: H1 returns (N=200) дают устойчивую covariance-оценку и дешевле, чем min5 в runtime.
    const preferredIntervals = [TimeFrame.h1, TimeFrame.min5, this.options.intervals[0] ?? TimeFrame.min1];
    for (const interval of preferredIntervals) {
      const bars = this.candles[symbol]?.[interval] ?? [];
      if (bars.length < 2) continue;
      const start = Math.max(1, bars.length - maxLookbackBars);
      const returns: number[] = [];
      for (let index = start; index < bars.length; index += 1) {
        const prevClose = Number(bars[index - 1]?.close ?? 0);
        const nextClose = Number(bars[index]?.close ?? 0);
        if (!Number.isFinite(prevClose) || !Number.isFinite(nextClose) || prevClose <= 0) continue;
        returns.push((nextClose - prevClose) / prevClose);
      }
      if (returns.length > 0) return returns;
    }
    return [];
  }

  private async evaluateMlHook(
    candle: Candle,
    ruleDecision: AggregateSignalScore,
    connectorType: ConnectorType | undefined,
    marketType: MarketType | undefined,
    correlationId: string,
  ): Promise<MlEvaluationOutcome> {
    const policy = this.getMlHookPolicy();
    const authorityMode = this.getAuthorityMode();
    const guardrails = this.getGuardrailsConfig();
    const baseMeta: MlDecisionTelemetryMeta = {
      ruleConfidence: ruleDecision.confidence,
      finalConfidence: ruleDecision.confidence,
      branch: 'fallback',
      regime: ruleDecision.diagnostics?.regime
        ? String(ruleDecision.diagnostics.regime)
        : undefined,
      reasonCode: 'ml_disabled',
      reasons: ['ml:disabled'],
      authorityMode,
      standDown: false,
      cooldownMs: undefined,
      riskBoostApplied: 0,
      guardrailTriggers: [],
    };
    if (policy.mode === 'disabled') {
      await this.telemetryWriter.emitMl(
        this.buildMlTelemetry(
          candle,
          correlationId,
          policy,
          ruleDecision,
          false,
          false,
          0,
          ruleDecision,
          undefined,
          'fallback',
          'ml_disabled',
          ['ml:disabled'],
          authorityMode,
          false,
          undefined,
          0,
          [],
        ),
      );
      return {
        decision: ruleDecision,
        telemetry: baseMeta,
        riskBoostApplied: 0,
      };
    }

    const startedAt = Date.now();
    let mlResponse: MLSignalResponse | null = null;
    let timeoutTriggered = false;
    let fallbackUsed = false;
    const guardrailTriggers: string[] = [];
    if (this.mlInFlight >= policy.maxInFlight) {
      // WHY: Защита от ML storm при min1 candles — не даем in-flight расти без лимита.
      this.logger.warn(
        `[ml-hook] in-flight overflow for ${this.options.sysname}:${candle.symbol.name}, current=${this.mlInFlight}, max=${policy.maxInFlight}`,
      );
      fallbackUsed = true;
      await this.telemetryWriter.emitMl(
        this.buildMlTelemetry(
          candle,
          correlationId,
          policy,
          ruleDecision,
          true,
          false,
          0,
          ruleDecision,
          undefined,
          'fallback',
          'ml_inflight_overflow',
          ['ml:inflight-overflow'],
          authorityMode,
          false,
          undefined,
          0,
          [],
        ),
      );
      return {
        decision: ruleDecision,
        telemetry: {
          ...baseMeta,
          branch: 'fallback',
          reasonCode: 'ml_inflight_overflow',
          reasons: ['ml:inflight-overflow'],
        },
        riskBoostApplied: 0,
      };
    }
    try {
      const regime = this.toAdvisorMarketRegime(
        ruleDecision.diagnostics?.regime ? String(ruleDecision.diagnostics.regime) : undefined,
      );
      mlResponse = await this.requestAdvisorMlDecision(
        candle,
        connectorType,
        marketType,
        correlationId,
        policy.timeoutMs,
        regime,
      );
    } catch (error) {
      fallbackUsed = true;
      timeoutTriggered = error instanceof TimeoutError;
      this.logger.warn(
        `[ml-hook] fallback to rule-based ${candle.symbol.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const effectivePolicy = this.resolveAdaptiveMlPolicy(ruleDecision, mlResponse, policy);
    const autonomousMode = authorityMode === 'ai-autonomous';
    const dominantMode = authorityMode === 'ai-dominant';
    const effectiveAuthorityPolicy =
      autonomousMode || dominantMode ? { ...effectivePolicy, mode: 'autonomous' as const } : effectivePolicy;
    const combined = applyMLHook(ruleDecision, mlResponse, effectiveAuthorityPolicy);

    const rawAdvisorDecision = (mlResponse?.raw ?? null) as
      | {
          intent?: string;
          cooldownMs?: number;
          riskBoost?: number;
        }
      | null;
    const requestedIntent = String(rawAdvisorDecision?.intent ?? '').toUpperCase();
    const requestedCooldownMs = Number(rawAdvisorDecision?.cooldownMs ?? 0);
    const requestedRiskBoost = Number(rawAdvisorDecision?.riskBoost ?? 0);
    const riskBoostApplied =
      Number.isFinite(requestedRiskBoost) && requestedRiskBoost !== 0
        ? Math.max(-1, Math.min(3, requestedRiskBoost))
        : 0;

    if (timeoutTriggered) {
      this.mlConsecutiveTimeouts += 1;
    } else {
      this.mlConsecutiveTimeouts = 0;
    }
    const isConflict =
      mlResponse?.direction !== MLDirection.Neutral &&
      ((ruleDecision.direction === SignalDirection.Up && mlResponse?.direction === MLDirection.Down) ||
        (ruleDecision.direction === SignalDirection.Down && mlResponse?.direction === MLDirection.Up));
    if (isConflict) {
      this.mlConsecutiveConflicts += 1;
    } else {
      this.mlConsecutiveConflicts = 0;
    }

    let finalDecision = fallbackUsed ? ruleDecision : combined.decision;
    if (autonomousMode && mlResponse && !fallbackUsed) {
      const mlDirection =
        mlResponse.direction === MLDirection.Up
          ? SignalDirection.Up
          : mlResponse.direction === MLDirection.Down
            ? SignalDirection.Down
            : SignalDirection.Neutral;
      const scoreSign = mlDirection === SignalDirection.Up ? 1 : mlDirection === SignalDirection.Down ? -1 : 0;
      const scoreMagnitude = Math.max(Math.abs(ruleDecision.totalScore), Number(mlResponse.confidence ?? 0));
      finalDecision = {
        ...ruleDecision,
        direction: mlDirection,
        totalScore: scoreSign * scoreMagnitude,
        confidence: Math.max(0, Math.min(1, Number(mlResponse.confidence ?? 0))),
        diagnostics: {
          ...(ruleDecision.diagnostics ?? {}),
          notes: Array.from(
            new Set<string>([
              ...((ruleDecision.diagnostics?.notes ?? []) as string[]),
              ...combined.notes,
              'ml:autonomous-primary',
            ]),
          ),
        },
      };
      if (isConflict && guardrails.conflictExplosion.enabled) {
        finalDecision = {
          ...finalDecision,
          confidence:
            finalDecision.confidence *
            Math.max(0, Math.min(1, guardrails.conflictExplosion.confidenceMultiplier)),
        };
      }
    }

    if (
      autonomousMode &&
      guardrails.timeoutDominance.enabled &&
      this.mlConsecutiveTimeouts >= guardrails.timeoutDominance.maxConsecutiveTimeouts
    ) {
      this.timeoutDominanceUntil = Date.now() + guardrails.timeoutDominance.cooldownMs;
      guardrailTriggers.push('timeout-dominance');
    }
    if (autonomousMode && Date.now() < this.timeoutDominanceUntil) {
      finalDecision = ruleDecision;
      guardrailTriggers.push('timeout-dominance-active');
    }
    const lossStreak = Number((this.getPerformanceSnapshot() as any)?.consecutiveLosses ?? 0);
    if (
      autonomousMode &&
      guardrails.lossStreak.enabled &&
      lossStreak >= guardrails.lossStreak.maxConsecutiveLosses
    ) {
      this.autonomousCooldownUntil = Math.max(
        this.autonomousCooldownUntil,
        Date.now() + guardrails.lossStreak.cooldownMs,
      );
      guardrailTriggers.push('loss-streak');
    }
    const atrPct = Number(ruleDecision.diagnostics?.volatility?.atrPct ?? 0);
    if (
      autonomousMode &&
      guardrails.volatilityShock.enabled &&
      Number.isFinite(atrPct) &&
      atrPct >= guardrails.volatilityShock.atrPctThreshold
    ) {
      finalDecision = {
        ...finalDecision,
        confidence:
          finalDecision.confidence *
          Math.max(0, Math.min(1, guardrails.volatilityShock.confidenceMultiplier)),
      };
      guardrailTriggers.push('volatility-shock');
    }
    if (
      autonomousMode &&
      guardrails.conflictExplosion.enabled &&
      this.mlConsecutiveConflicts >= guardrails.conflictExplosion.maxConsecutiveConflicts
    ) {
      finalDecision = {
        ...finalDecision,
        confidence:
          finalDecision.confidence *
          Math.max(0, Math.min(1, guardrails.conflictExplosion.confidenceMultiplier)),
      };
      guardrailTriggers.push('conflict-explosion');
    }

    const standDownRequested = requestedIntent === 'STAND_DOWN' && autonomousMode;
    const standDownCooldownMs =
      standDownRequested && Number.isFinite(requestedCooldownMs) && requestedCooldownMs > 0
        ? Math.max(0, Math.floor(requestedCooldownMs))
        : undefined;
    if (standDownRequested) {
      this.autonomousCooldownUntil = Math.max(
        this.autonomousCooldownUntil,
        Date.now() + (standDownCooldownMs ?? guardrails.lossStreak.cooldownMs),
      );
      guardrailTriggers.push('stand-down');
    }
    const standDownActive = Date.now() < this.autonomousCooldownUntil;

    const branch: 'ml-only' | 'hybrid' | 'fallback' | 'timeout' = timeoutTriggered
      ? 'timeout'
      : fallbackUsed
        ? 'fallback'
        : effectiveAuthorityPolicy.mode === 'override' || effectiveAuthorityPolicy.mode === 'autonomous'
          ? 'ml-only'
          : 'hybrid';
    const reasonCode = this.resolveMlReasonCode(combined.notes, branch);
    const mlConfidence = mlResponse?.confidence;
    await this.telemetryWriter.emitMl(
      this.buildMlTelemetry(
        candle,
        correlationId,
        effectiveAuthorityPolicy,
        ruleDecision,
        fallbackUsed,
        timeoutTriggered,
        Date.now() - startedAt,
        finalDecision,
        mlConfidence,
        branch,
        reasonCode,
        combined.notes,
        authorityMode,
        standDownActive,
        standDownCooldownMs,
        riskBoostApplied,
        guardrailTriggers,
      ),
    );
    return {
      decision: finalDecision,
      telemetry: {
        ruleConfidence: ruleDecision.confidence,
        mlConfidence,
        finalConfidence: finalDecision.confidence,
        branch,
        regime: finalDecision.diagnostics?.regime
          ? String(finalDecision.diagnostics.regime)
          : undefined,
        reasonCode,
        reasons: combined.notes,
        authorityMode,
        standDown: standDownActive,
        cooldownMs: standDownCooldownMs,
        riskBoostApplied,
        guardrailTriggers,
      },
      riskBoostApplied,
    };
  }

  private resolveAdaptiveMlPolicy(
    ruleDecision: AggregateSignalScore,
    mlResponse: MLSignalResponse | null,
    basePolicy: FollowTrendMlPolicy,
  ): FollowTrendMlPolicy {
    if (!mlResponse || basePolicy.mode === 'disabled') return basePolicy;

    const regime = ruleDecision.diagnostics?.regime
      ? String(ruleDecision.diagnostics.regime).toLowerCase()
      : '';
    const atrPct = Number(ruleDecision.diagnostics?.volatility?.atrPct ?? 0);
    const isConflict =
      mlResponse.direction !== MLDirection.Neutral &&
      ((ruleDecision.direction === SignalDirection.Up && mlResponse.direction === MLDirection.Down) ||
        (ruleDecision.direction === SignalDirection.Down && mlResponse.direction === MLDirection.Up));
    const adaptive = { ...basePolicy };

    if (isConflict && mlResponse.confidence < 0.7) {
      adaptive.mode = 'assist';
      adaptive.maxAssistDelta = Math.min(0.15, Number(adaptive.maxAssistDelta ?? 0.2));
      return adaptive;
    }
    if (regime.includes('ranging') || regime.includes('low') || atrPct > 0.03) {
      adaptive.mode = 'assist';
      adaptive.maxAssistDelta = Math.min(0.1, Number(adaptive.maxAssistDelta ?? 0.2));
      return adaptive;
    }
    if (
      (regime.includes('trending') || regime.includes('volatile')) &&
      mlResponse.confidence >= 0.8
    ) {
      adaptive.mode = 'override';
      return adaptive;
    }
    return adaptive;
  }

  private resolveMlReasonCode(
    notes: string[],
    branch: 'ml-only' | 'hybrid' | 'fallback' | 'timeout',
  ): string {
    if (branch === 'timeout') return 'ml_timeout';
    if (branch === 'fallback') return 'ml_fallback';
    if (notes.includes('ml:below-threshold')) return 'ml_below_threshold';
    if (notes.includes('ml:autonomous') || notes.includes('ml:autonomous-primary')) {
      return 'ml_autonomous';
    }
    if (notes.includes('ml:override')) return 'ml_override';
    if (notes.includes('ml:assist')) return 'ml_assist';
    return branch === 'ml-only' ? 'ml_only' : 'ml_hybrid';
  }

  private async requestAdvisorMlDecision(
    candle: Candle,
    connectorType: ConnectorType | undefined,
    marketType: MarketType | undefined,
    correlationId: string,
    timeoutMs: number,
    marketRegime: AdvisorMarketRegime,
  ): Promise<MLSignalResponse | null> {
    this.mlInFlight += 1;
    this.activeMlRequests.add(correlationId);
    const connectorContext = this.getPrimaryConnectorContext(connectorType, marketType);
    const request: AdvisorLlmDecisionRequest = {
      requestId: correlationId,
      sessionId: this.options.key || this.options.sysname,
      idempotencyKey: correlationId,
      symbol: candle.symbol.name,
      connectorType: connectorContext.connectorType,
      marketType: connectorContext.marketType,
      marketRegime,
      riskBudget: {
        maxPositionUsd: Number(process.env.ADVISOR_MAX_POSITION_USD || 1000),
        maxSpreadPct: Number(process.env.ADVISOR_MAX_SPREAD_PCT || 0.4),
      },
      issuedAt: this.resolveCandleCloseTime(candle),
    };
    try {
      const response = await new Promise<AdvisorLlmDecisionResponse>((resolve, reject) => {
        let settled = false;
        const clear = (timer: NodeJS.Timeout, unsubscribe: () => void) => {
          clearTimeout(timer);
          unsubscribe();
        };

        const source$ = this.client.send<AdvisorLlmDecisionResponse, AdvisorLlmDecisionRequest>(
          SubscriptionType.ADVISOR_DECISION_REQUEST,
          request,
        );
        const timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          clear(timeoutHandle, () => subscription.unsubscribe());
          reject(new TimeoutError());
        }, Math.max(100, timeoutMs));

        const subscription = source$.subscribe({
          next: (value) => {
            if (settled) return;
            if (!this.activeMlRequests.has(correlationId)) {
              // WHY: Late ML response после timeout/dispose не должна менять итог сигнала.
              return;
            }
            settled = true;
            clear(timeoutHandle, () => subscription.unsubscribe());
            resolve(value);
          },
          error: (error: unknown) => {
            if (settled) return;
            settled = true;
            clear(timeoutHandle, () => subscription.unsubscribe());
            reject(error);
          },
          complete: () => {
            if (settled) return;
            settled = true;
            clear(timeoutHandle, () => subscription.unsubscribe());
            reject(new Error('advisor stream completed without decision'));
          },
        });
      });

      if (!response?.approvedDecision) {
        return null;
      }
      if (!response.validation?.accepted) {
        return {
          direction: MLDirection.Neutral,
          confidence: 0,
          reasons: response.validation?.reasons ?? ['advisor:rejected'],
        };
      }

      const approved = response.approvedDecision;
      const direction =
        approved.decision === AdvisorDecision.TRADE
          ? approved.direction === 'LONG'
            ? MLDirection.Up
            : approved.direction === 'SHORT'
              ? MLDirection.Down
              : MLDirection.Neutral
          : MLDirection.Neutral;

      return {
        direction,
        confidence: Number(approved.confidence ?? 0),
        reasons: approved.rationale ? [approved.rationale] : [],
        raw: approved,
      };
    } finally {
      this.activeMlRequests.delete(correlationId);
      this.mlInFlight = Math.max(0, this.mlInFlight - 1);
    }
  }

  private toAdvisorMarketRegime(regime: string | undefined): AdvisorMarketRegime {
    const normalized = String(regime ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) return AdvisorMarketRegime.UNKNOWN;
    if (normalized.includes('trend')) return AdvisorMarketRegime.TREND;
    if (normalized.includes('rang')) return AdvisorMarketRegime.RANGE;
    if (normalized.includes('volatile')) return AdvisorMarketRegime.BREAKOUT;
    if (normalized.includes('low')) return AdvisorMarketRegime.RANGE;
    return AdvisorMarketRegime.MIXED;
  }

  private getPrimaryConnectorContext(
    connectorType?: ConnectorType,
    marketType?: MarketType,
  ): { connectorType: ConnectorType; marketType: MarketType } {
    if (connectorType && marketType) {
      return { connectorType, marketType };
    }
    for (const provider of this.options.providers ?? []) {
      const connector = provider.connectors?.find((item) => item.isActive) ?? provider.connectors?.[0];
      if (!connector) continue;
      const market = connector.markets?.[0];
      if (!market) continue;
      return {
        connectorType: connector.connectorType,
        marketType: market.marketType,
      };
    }
    return {
      connectorType: ConnectorType.binance,
      marketType: MarketType.futures,
    };
  }

  private getMlHookPolicy(): FollowTrendMlPolicy {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    const mlHook = customConfig?.mlHook;
    if (mlHook?.enabled === false) {
      return { mode: 'disabled', timeoutMs: 300, maxInFlight: 8 };
    }
    return {
      mode: mlHook?.mode ?? 'disabled',
      timeoutMs: mlHook?.timeoutMs ?? 600,
      minMLConfidence: mlHook?.minMLConfidence ?? 0.6,
      maxAssistDelta: mlHook?.maxAssistDelta ?? 0.2,
      maxInFlight: Math.max(1, Math.floor(mlHook?.maxInFlight ?? 8)),
    };
  }

  private getAuthorityMode(): 'rule-first' | 'ai-dominant' | 'ai-autonomous' {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    const mode = customConfig?.authorityMode;
    if (mode === 'ai-dominant' || mode === 'ai-autonomous') return mode;
    return 'rule-first';
  }

  private getGuardrailsConfig(): FollowTrendGuardrailsConfig {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    const guardrails = customConfig?.guardrails;
    return {
      timeoutDominance: {
        enabled: guardrails?.timeoutDominance?.enabled !== false,
        maxConsecutiveTimeouts: Math.max(
          1,
          Math.floor(Number(guardrails?.timeoutDominance?.maxConsecutiveTimeouts ?? 3)),
        ),
        cooldownMs: Math.max(1_000, Math.floor(Number(guardrails?.timeoutDominance?.cooldownMs ?? 180_000))),
      },
      lossStreak: {
        enabled: guardrails?.lossStreak?.enabled !== false,
        maxConsecutiveLosses: Math.max(
          1,
          Math.floor(Number(guardrails?.lossStreak?.maxConsecutiveLosses ?? 4)),
        ),
        cooldownMs: Math.max(1_000, Math.floor(Number(guardrails?.lossStreak?.cooldownMs ?? 600_000))),
      },
      volatilityShock: {
        enabled: guardrails?.volatilityShock?.enabled !== false,
        atrPctThreshold: Math.max(0, Number(guardrails?.volatilityShock?.atrPctThreshold ?? 0.04)),
        confidenceMultiplier: Math.max(
          0,
          Math.min(1, Number(guardrails?.volatilityShock?.confidenceMultiplier ?? 0.5)),
        ),
      },
      conflictExplosion: {
        enabled: guardrails?.conflictExplosion?.enabled !== false,
        maxConsecutiveConflicts: Math.max(
          1,
          Math.floor(Number(guardrails?.conflictExplosion?.maxConsecutiveConflicts ?? 4)),
        ),
        confidenceMultiplier: Math.max(
          0,
          Math.min(1, Number(guardrails?.conflictExplosion?.confidenceMultiplier ?? 0.4)),
        ),
      },
    };
  }

  private getPortfolioConfig(): {
    enabled: boolean;
    targetVolatility: number;
    maxLookbackBars: number;
    correlationSoftCap: number;
    minTradeNotional: number;
    minScaleFactor: number;
  } {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    const config = customConfig?.portfolio;
    return {
      enabled: config?.enabled !== false,
      targetVolatility: config?.targetVolatility ?? 0.02,
      maxLookbackBars: config?.maxLookbackBars ?? 200,
      correlationSoftCap: config?.correlationSoftCap ?? 0.6,
      minTradeNotional: config?.minTradeNotional ?? 25,
      minScaleFactor: Math.max(0, Number(config?.minScaleFactor ?? 0.05)),
    };
  }

  private buildCorrelationId(candle: Candle): string {
    const closeTime = this.resolveCandleCloseTime(candle);
    const seq = this.correlationSequence++;
    return `${this.options.sysname}:${candle.symbol.name}:${candle.interval}:${closeTime}:${seq}`;
  }

  private markCandleAsProcessing(candle: Candle, correlationId: string): boolean {
    const closeTime = this.resolveCandleCloseTime(candle);
    // WHY: Защита от двойной обработки при Redis replay / reconnect.
    const key = `${this.options.sysname}:${candle.symbol.name}:${candle.interval}:${closeTime}`;
    if (this.processedCandleKeys.has(key)) {
      return false;
    }
    this.processedCandleKeys.add(key);
    this.processedCandleQueue.push(key);
    if (this.processedCandleQueue.length > this.maxProcessedCandleKeys) {
      const evicted = this.processedCandleQueue.shift();
      if (evicted) {
        this.processedCandleKeys.delete(evicted);
      }
    }
    this.logger.debug(`[idempotency] accepted ${correlationId}`);
    return true;
  }

  protected resolveCandleCloseTime(candle: Candle): number {
    const legacyCandle = candle as Candle & { closeTime?: number };
    const raw = candle.raw as { closeTime?: number } | undefined;
    const closeTime = Number(
      raw?.closeTime ??
      legacyCandle.closeTime ??
      candle.time,
    );
    return Number.isFinite(closeTime) && closeTime > 0 ? closeTime : 0;
  }

  private shouldSampleSignalTelemetry(direction: SignalDirection): boolean {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    const sampleNeutralSignals = customConfig?.telemetry?.sampleNeutralSignals ?? false;
    // WHY: Снижение нагрузки QuestDB при min1 multi-instance.
    return sampleNeutralSignals && direction === SignalDirection.Neutral;
  }

  private getIntentRateLimitConfig(): FollowTrendIntentRateLimit {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    const rateLimit = customConfig?.intentRateLimit;
    return {
      maxIntents: Math.max(1, Math.floor(rateLimit?.maxIntents ?? 6)),
      windowMs: Math.max(1_000, Math.floor((rateLimit?.windowSec ?? 30) * 1_000)),
    };
  }

  private getGlobalAllocatorConfig(): FollowTrendGlobalAllocatorConfig {
    const customConfig = (this.options.customConfig as FollowTrendCustomConfig | undefined) ?? undefined;
    const allocator = customConfig?.globalAllocator;
    const envEnabled = process.env.DETECTOR_GLOBAL_ALLOCATOR_ENABLED;
    const enabledFromConfig = allocator?.enabled ?? false;
    const enabled =
      envEnabled === undefined
        ? enabledFromConfig
        : ['1', 'true', 'yes', 'on'].includes(envEnabled.toLowerCase().trim());
    return {
      enabled,
      maxTotalExposurePct: Math.max(0, Number(allocator?.maxTotalExposurePct ?? 60)),
      maxExposurePerSymbolPct: Math.max(0, Number(allocator?.maxExposurePerSymbolPct ?? 25)),
      riskBudgetPct:
        allocator?.riskBudgetPct === undefined
          ? undefined
          : Math.max(0, Number(allocator.riskBudgetPct)),
      breachAction: allocator?.breachAction === 'deny' ? 'deny' : 'scale',
      reservationTtlMs: Math.max(1_000, Math.floor(Number(allocator?.reservationTtlMs ?? 30_000))),
      idempotencyTtlMs: Math.max(1_000, Math.floor(Number(allocator?.idempotencyTtlMs ?? 120_000))),
    };
  }

  private applyPortfolioSafety(
    decision: PortfolioDecision,
    riskDecision: RiskDecision,
    correlationId: string,
  ): PortfolioDecision {
    const config = this.getPortfolioConfig();
    const safeScale = Number(decision.scaleFactor);
    if (!Number.isFinite(safeScale) || safeScale < 0) {
      return {
        ...decision,
        allow: false,
        denyReason: 'invalid-scale-factor',
        scaleFactor: 0,
        scaledNotional: 0,
        diagnostics: [...decision.diagnostics, 'portfolio:deny:invalid-scale', correlationId],
      };
    }
    if (safeScale < config.minScaleFactor) {
      return {
        ...decision,
        allow: false,
        denyReason: 'below-min-scale-threshold',
        diagnostics: [...decision.diagnostics, 'portfolio:deny:min-scale', correlationId],
      };
    }
    if (!Number.isFinite(riskDecision.size) || riskDecision.size < 0) {
      return {
        ...decision,
        allow: false,
        denyReason: 'invalid-risk-size',
        scaleFactor: 0,
        scaledNotional: 0,
        diagnostics: [...decision.diagnostics, 'portfolio:deny:negative-size', correlationId],
      };
    }
    return decision;
  }

//   private isLegacyReadOnly(): boolean {
//     const readonly = Boolean((this.options.customConfig as any)?.legacyReadOnly);
//     if (readonly) {
//       this.logger.warn(
//         '[legacy] FollowTrendService is running in read-only mode; signals/execution disabled',
//       );
//     }
//     return readonly;
//   }
}





