import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { firstValueFrom, timeout } from 'rxjs';
import { DetectorService } from '@barfinex/detector';
import {
  AdvisorLlmDecisionRequest,
  AdvisorLlmDecisionResponse,
  AdvisorMarketRegime,
  BaseEvent,
  ConnectorType,
  Detector,
  DetectorConfigInput,
  EventMetadata,
  EventSource,
  MarketType,
  OrderBook,
  Position,
  Symbol,
  Trade,
  TradeSide,
  AdvisorLlmDecision,
  AdvisorDecision,
  SubscriptionType,
  DetectorEventType,
  assertEventSourceMatch,
} from '@barfinex/types';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { safeClientProxyEmit } from '@barfinex/utils';
import {
  AdvisorLlmHybridConfigService,
  AdvisorLlmHybridCustomConfig,
} from './advisor-llm-hybrid.config';

@Injectable()
export class AdvisorLlmHybridService extends DetectorService {
  protected readonly logger = new Logger(AdvisorLlmHybridService.name);
  private lastDecisionAt = 0;
  private lastDecision?: AdvisorLlmDecision;
  private latestSpreadPercent = 0;
  private latestBookDepth = 0;
  private consecutiveLosses = 0;
  private cooldownUntil = 0;
  private entryMomentBySymbol = new Map<string, number>();

  private get cfg(): AdvisorLlmHybridCustomConfig {
    return (this.options.customConfig ?? {}) as AdvisorLlmHybridCustomConfig;
  }

  constructor(
    @Inject(forwardRef(() => PluginDriverService))
    protected readonly pluginDriverService: PluginDriverService,
    protected readonly connectorService: ConnectorService,
    protected readonly keyService: KeyService,
    protected readonly orderService: OrderService,
    protected readonly configService: ConfigService,
    @Inject('PROVIDER_SERVICE') protected readonly client: ClientProxy,
    @Optional() @Inject('DETECTOR_CONFIG_SERVICE')
    private readonly localConfig?: AdvisorLlmHybridConfigService,
    @Optional() @Inject('DETECTOR_OPTIONS')
    private readonly detectorOptions?: Partial<Detector>,
  ) {
    super(
      pluginDriverService,
      connectorService,
      keyService,
      orderService,
      configService,
      client,
      detectorOptions
        ? { detector: detectorOptions as DetectorConfigInput }
        : localConfig,
    );
  }

  async onStart(): Promise<void> {
    this.logger.log('[onStart] AdvisorLlmHybrid started');
  }

  async onTrade(
    trade: Trade,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<void> {
    if (trade.symbol.name !== this.cfg.symbol) return;

    const position = this.positions.findBySymbol(trade.symbol);
    if (position) {
      await this.manageOpenPosition(position, trade.price, connectorType, marketType);
    }

    const now = Date.now();
    if (now - this.lastDecisionAt < this.cfg.decisionCooldownMs) return;
    this.lastDecisionAt = now;

    const decision = await this.fetchAdvisorDecision(this.cfg.symbol);
    this.lastDecision = decision;
    this.registerEvent(DetectorEventType.DECISION_CONTEXT_UPDATED, {
      symbols: [{ name: this.cfg.symbol }],
      decision: decision.decision,
      direction: decision.direction,
      confidence: decision.confidence,
      rationale: decision.rationale,
      reasoningCode: decision.reasoningCode,
      spreadPct: this.latestSpreadPercent,
      ts: Date.now(),
    });
    await this.applyDecision(decision, trade, connectorType, marketType);
  }

  async onOrderBookUpdate(
    orderbook: OrderBook,
    _connectorType: ConnectorType,
    _marketType: MarketType,
  ): Promise<void> {
    if (orderbook.symbol.name !== this.cfg.symbol) return;
    const bestBid = Number(orderbook.bids?.[0]?.price ?? 0);
    const bestAsk = Number(orderbook.asks?.[0]?.price ?? 0);
    this.latestBookDepth = (orderbook.bids?.length ?? 0) + (orderbook.asks?.length ?? 0);
    this.latestSpreadPercent =
      bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
  }

  private async applyDecision(
    decision: AdvisorLlmDecision,
    trade: Trade,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<void> {
    const position = this.positions.findBySymbol(trade.symbol);
    const now = Date.now();
    if (decision.intent === 'STAND_DOWN') {
      const requestedCooldown = Number(decision.cooldownMs ?? this.cfg.standDownDefaultCooldownMs ?? 0);
      const safeCooldownMs = Number.isFinite(requestedCooldown) ? Math.max(0, requestedCooldown) : 0;
      if (safeCooldownMs > 0) {
        this.cooldownUntil = Math.max(this.cooldownUntil, now + safeCooldownMs);
      }
      this.registerEvent(DetectorEventType.DECISION_CONTEXT_UPDATED, {
        symbols: [{ name: trade.symbol.name }],
        decision: decision.decision,
        intent: 'STAND_DOWN',
        cooldownMs: safeCooldownMs,
        cooldownUntil: this.cooldownUntil,
        ts: now,
      });
      // STAND_DOWN blocks only new entries. Exit flow remains available below.
      if (!position) {
        this.logger.warn(
          `[applyDecision] stand-down active for ${trade.symbol.name}, cooldownMs=${safeCooldownMs}`,
        );
        return;
      }
    }
    if (decision.validUntil && now > decision.validUntil) {
      this.logger.debug('[applyDecision] skip expired decision');
      return;
    }
    const constraintBlock = this.checkDecisionConstraints(decision, Boolean(position));
    if (constraintBlock) {
      this.logger.debug(`[applyDecision] constraint blocked: ${constraintBlock}`);
      return;
    }

    if (!position && this.latestSpreadPercent > this.cfg.maxSpreadPercent) {
      this.logger.debug(
        `[applyDecision] spread too high=${this.latestSpreadPercent.toFixed(3)}%`,
      );
      return;
    }

    if (!position) {
      if (
        decision.decision !== AdvisorDecision.TRADE ||
        (decision.confidence ?? 0) < this.cfg.minConfidenceToEnter ||
        !decision.direction
      ) {
        return;
      }

      const risk = this.evaluateEntryRiskGate();
      if (!risk.allowed) {
        this.logger.debug(`[applyDecision] risk gate blocked entry: ${risk.reason}`);
        this.registerEvent(DetectorEventType.RISK_CONTEXT_UPDATED, {
          symbols: [{ name: trade.symbol.name }],
          reason: risk.reason ?? 'risk_blocked',
          spreadPct: this.latestSpreadPercent,
          depth: this.latestBookDepth,
          sizeMultiplier: risk.sizeMultiplier,
          ts: Date.now(),
        });
        return;
      }

      const baseQuantity =
        this.options.symbols.find(s => s.name === this.cfg.symbol)?.quantity ?? 0.001;
      const quantity = Math.max(0.0001, Number((baseQuantity * risk.sizeMultiplier).toFixed(6)));
      this.emitDetectorPositionIntent(
        SubscriptionType.DETECTOR_POSITION_OPEN_REQUEST,
        {
          symbol: {
            ...trade.symbol,
            quantity,
            leverage: Number((this.cfg as any).defaultLeverage ?? 1),
          },
          side: decision.direction === 'LONG' ? 'LONG' : 'SHORT',
          confidence: Number(decision.confidence ?? 0),
          strategyId: this.options.key || this.options.sysname || 'advisor-llm-hybrid',
        },
        connectorType,
        marketType,
      );
      this.entryMomentBySymbol.set(trade.symbol.name, Date.now());
      this.logger.log(
        `[applyDecision] intent_open ${decision.direction} ${trade.symbol.name} conf=${decision.confidence.toFixed(2)} rationale=${decision.rationale}`,
      );
      return;
    }

    const shouldExitByDecision =
      decision.decision === AdvisorDecision.NO_TRADE ||
      (decision.confidence ?? 0) < this.minHoldConfidence(decision) ||
      (decision.direction &&
        ((decision.direction === 'LONG' && position.side === TradeSide.SHORT) ||
          (decision.direction === 'SHORT' && position.side === TradeSide.LONG)));

    if (!shouldExitByDecision) return;

    const pnlPct =
      (position.side === TradeSide.LONG ? 1 : -1) *
      ((trade.price - position.entryPrice) / position.entryPrice) *
      100;
    this.emitDetectorPositionIntent(
      SubscriptionType.DETECTOR_POSITION_CLOSE_REQUEST,
      {
        symbol: {
          ...position.symbol,
          quantity: Math.abs(Number(position.quantity ?? 0)),
          leverage: Number((this.cfg as any).defaultLeverage ?? 1),
        },
        side: position.side === TradeSide.LONG ? 'LONG' : 'SHORT',
        confidence: Number(decision.confidence ?? 0),
        strategyId: this.options.key || this.options.sysname || 'advisor-llm-hybrid',
      },
      connectorType,
      marketType,
    );
    this.onPositionClosed(pnlPct, 'advisor');
    this.entryMomentBySymbol.delete(trade.symbol.name);
    this.logger.log(
      `[applyDecision] intent_close by advisor decision=${decision.decision} conf=${decision.confidence.toFixed(2)}`,
    );
  }

  private async manageOpenPosition(
    position: Position,
    lastPrice: number,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<void> {
    const sideMultiplier = position.side === TradeSide.LONG ? 1 : -1;
    const pnlPct = sideMultiplier * ((lastPrice - position.entryPrice) / position.entryPrice) * 100;
    const tpHit = pnlPct >= this.cfg.fallbackTakeProfitPercent;
    const slHit = pnlPct <= -this.cfg.fallbackStopLossPercent;

    const entryMoment =
      this.entryMomentBySymbol.get(position.symbol.name) ??
      position.entryTime ??
      Date.now();
    const expired = Date.now() - entryMoment >= this.cfg.fallbackMaxHoldMs;

    this.updateTrailingStop(lastPrice, position, this.cfg.fallbackStopLossPercent / 100);
    const refreshed = this.positions.findBySymbol(position.symbol) ?? position;
    const trailingHit =
      refreshed.trailingStop !== undefined &&
      ((position.side === TradeSide.LONG && lastPrice <= refreshed.trailingStop) ||
        (position.side === TradeSide.SHORT && lastPrice >= refreshed.trailingStop));

    if (!tpHit && !slHit && !expired && !trailingHit) return;

    this.emitDetectorPositionIntent(
      SubscriptionType.DETECTOR_POSITION_CLOSE_REQUEST,
      {
        symbol: {
          ...refreshed.symbol,
          quantity: Math.abs(Number(refreshed.quantity ?? 0)),
          leverage: Number((this.cfg as any).defaultLeverage ?? 1),
        },
        side: refreshed.side === TradeSide.LONG ? 'LONG' : 'SHORT',
        confidence: Number(this.lastDecision?.confidence ?? 0),
        strategyId: this.options.key || this.options.sysname || 'advisor-llm-hybrid',
      },
      connectorType,
      marketType,
    );
    this.onPositionClosed(pnlPct, tpHit ? 'tp' : slHit ? 'sl' : expired ? 'time' : 'trail');
    this.entryMomentBySymbol.delete(position.symbol.name);
    this.logger.log(
      `[manageOpenPosition] intent_close reason=${tpHit ? 'tp' : slHit ? 'sl' : expired ? 'time' : 'trail'} pnl=${pnlPct.toFixed(2)}%`,
    );
  }

  private emitDetectorPositionIntent(
    type:
      | SubscriptionType.DETECTOR_POSITION_OPEN_REQUEST
      | SubscriptionType.DETECTOR_POSITION_CLOSE_REQUEST
      | SubscriptionType.DETECTOR_POSITION_REDUCE_REQUEST
      | SubscriptionType.DETECTOR_POSITION_FLIP_REQUEST,
    payload: {
      symbol: Symbol;
      side: 'LONG' | 'SHORT';
      confidence: number;
      strategyId: string;
    },
    connectorType: ConnectorType,
    marketType: MarketType,
  ): void {
    assertEventSourceMatch(type, EventSource.DETECTOR);
    const now = Date.now();
    const event: BaseEvent<typeof type, typeof payload> = {
      eventId: `detector:${this.options.sysname || 'advisor-llm-hybrid'}:${type}:${now}`,
      type,
      source: EventSource.DETECTOR,
      timestamp: now,
      correlationId: `${this.options.key || this.options.sysname || 'advisor-llm-hybrid'}:${payload.symbol.name}:${type}`,
      payload,
    };
    const metadata: EventMetadata = {
      eventId: event.eventId,
      traceId: event.correlationId || event.eventId,
      timestamp: now,
      version: 1,
      source: EventSource.DETECTOR,
    };
    safeClientProxyEmit({
      client: this.client,
      pattern: type,
      payload: {
        value: event,
        metadata,
        options: {
          connectorType,
          marketType,
          key: this.options.key || this.options.sysname || 'advisor-llm-hybrid',
          updateMoment: now,
        },
      },
      logger: this.logger,
      errorContext: '[detector.advisorLlmHybrid.emitDetectorPositionIntent]',
    });
  }

  private async fetchAdvisorDecision(symbol: string): Promise<AdvisorLlmDecision> {
    try {
      const connectorCtx = this.getPrimaryConnectorContext();
      const request: AdvisorLlmDecisionRequest = {
        requestId: `${symbol}:${Date.now()}`,
        sessionId: this.options.key,
        idempotencyKey: `${this.options.key}:${symbol}:${this.lastDecisionAt}`,
        symbol,
        connectorType: connectorCtx.connectorType,
        marketType: connectorCtx.marketType,
        marketRegime: this.lastDecision ? AdvisorMarketRegime.MIXED : AdvisorMarketRegime.UNKNOWN,
        riskBudget: {
          maxPositionUsd: Number(process.env.ADVISOR_MAX_POSITION_USD || 1000),
          maxSpreadPct: Number(this.cfg.maxSpreadPercent ?? 0.4),
        },
        issuedAt: Date.now(),
      };
      const response = await firstValueFrom(
        this.client
          .send<AdvisorLlmDecisionResponse, AdvisorLlmDecisionRequest>(
            SubscriptionType.ADVISOR_DECISION_REQUEST,
            request,
          )
          .pipe(timeout(8000)),
      );
      if (!response?.validation?.accepted) {
        const reason = response?.validation?.reasons?.join(',') || 'advisor_rejected';
        return this.defaultNoTrade(symbol, reason);
      }
      return response.approvedDecision;
    } catch (error) {
      this.logger.warn(
        `[fetchAdvisorDecision] fallback NO_TRADE: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.defaultNoTrade(symbol, 'advisor_unavailable');
    }
  }

  private evaluateEntryRiskGate(): {
    allowed: boolean;
    reason?: string;
    sizeMultiplier: number;
  } {
    if (Date.now() < this.cooldownUntil) {
      return {
        allowed: false,
        reason: `cooldown_active_ms=${this.cooldownUntil - Date.now()}`,
        sizeMultiplier: 0,
      };
    }
    if (this.latestSpreadPercent > this.cfg.maxSpreadPercent) {
      return { allowed: false, reason: 'spread_guard', sizeMultiplier: 0 };
    }
    const minDepth = Number((this.cfg as any).minOrderBookDepth || 20);
    if (this.latestBookDepth < minDepth) {
      return {
        allowed: false,
        reason: `depth_guard_${this.latestBookDepth}_lt_${minDepth}`,
        sizeMultiplier: 0,
      };
    }

    const perf = this.getPerformanceSnapshot();
    if ((perf as any).stopTradingMode) {
      return { allowed: false, reason: 'stop_trading_mode', sizeMultiplier: 0 };
    }
    const sizeMultiplier = Math.max(0.2, Math.min(1, Number((perf as any).recommendedSizeMultiplier ?? 1)));
    return { allowed: true, sizeMultiplier };
  }

  private onPositionClosed(pnlPct: number, reason: string): void {
    if (pnlPct < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0;
    }
    const maxLossStreak = Number((this.cfg as any).lossStreakCooldownThreshold || 3);
    if (this.consecutiveLosses >= maxLossStreak) {
      const cooldownMs = Number((this.cfg as any).lossStreakCooldownMs || 10 * 60 * 1000);
      this.cooldownUntil = Date.now() + cooldownMs;
      this.logger.warn(
        `[onPositionClosed] loss streak=${this.consecutiveLosses}, cooldownMs=${cooldownMs}, reason=${reason}`,
      );
    }
  }

  private defaultNoTrade(symbol: string, rationale: string): AdvisorLlmDecision {
    return {
      decision: AdvisorDecision.NO_TRADE,
      symbol,
      confidence: 0,
      trend: 'unknown',
      rationale,
      windowSec: 120,
      generatedAt: Date.now(),
    };
  }

  private minHoldConfidence(decision: AdvisorLlmDecision): number {
    const base = Number(this.cfg.minConfidenceToHold ?? 0);
    if (decision.horizonClass === 'scalp') return Math.min(1, base + 0.05);
    if (decision.horizonClass === 'swing') return Math.max(0, base - 0.05);
    return base;
  }

  private checkDecisionConstraints(decision: AdvisorLlmDecision, hasPosition: boolean): string | null {
    for (const raw of decision.constraints ?? []) {
      const rule = String(raw).trim().toLowerCase();
      if (!rule) continue;
      if (rule === 'no_new_entry' && !hasPosition) {
        return 'no_new_entry';
      }
      if (rule.startsWith('max_spread_pct:')) {
        const limit = Number(rule.split(':')[1]);
        if (Number.isFinite(limit) && this.latestSpreadPercent > limit) return 'max_spread_pct';
      }
      if (rule.startsWith('min_depth:')) {
        const minDepth = Number(rule.split(':')[1]);
        if (Number.isFinite(minDepth) && this.latestBookDepth < minDepth) return 'min_depth';
      }
    }
    return null;
  }

  private getPrimaryConnectorContext(): {
    connectorType: ConnectorType;
    marketType: MarketType;
  } {
    for (const provider of this.options.providers ?? []) {
      const connector = provider.connectors?.find(c => c.isActive) ?? provider.connectors?.[0];
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
}

