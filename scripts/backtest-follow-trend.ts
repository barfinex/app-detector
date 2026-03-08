import * as fs from 'fs';
import * as path from 'path';
import { DeterministicBacktestEngine, IndicatorsService } from './optional-enterprise';
import {
  DEFAULT_RISK_PROFILE,
  RiskEngine,
  RiskProfile,
  DEFAULT_TREND_PROFILE,
  SignalDirection,
  TrendSignalEngine,
  TrendSignalProfile,
} from '../src/instances/follow-trend/enterprise.engines';
import { Candle, Indicator, TimeFrame } from '@barfinex/types';
import { FeatureBuilder } from '../src/instances/follow-trend/features/feature.builder';
import {
  FollowTrendIndicatorMapping,
} from '../src/instances/follow-trend/follow-trend.config';

type CandleLike = Partial<Candle> & {
  open?: number;
  close?: number;
  high?: number;
  low?: number;
  volume?: number;
  time?: number;
  symbol?: string | { name?: string };
  interval?: TimeFrame | string;
};

export type AuthorityMode = 'rule-first' | 'ai-dominant' | 'ai-autonomous';
export type ValidationReplayMode = 'deterministic' | 'ml-feed' | 'hybrid-feed' | 'ai-autonomous';
export type ValidationRegimeFilter = 'all' | 'trend-only' | 'chop-only' | 'high-volatility-window';

const BACKTEST_SYMBOL = 'BTCUSDT';
const BACKTEST_INTERVAL = TimeFrame.min1;
const BACKTEST_INITIAL_EQUITY = 10_000;

const INDICATORS: Indicator[] = [
  {
    key: 'sma7',
    name: 'SMA',
    parameters: { period: 7, source: 'close' },
    visual: { group: 'SMA', paneSysName: 'candle_pane' },
  },
  {
    key: 'sma25',
    name: 'SMA',
    parameters: { period: 25, source: 'close' },
    visual: { group: 'SMA', paneSysName: 'candle_pane' },
  },
  {
    key: 'sma99',
    name: 'SMA',
    parameters: { period: 99, source: 'close' },
    visual: { group: 'SMA', paneSysName: 'candle_pane' },
  },
  {
    key: 'rsi14',
    name: 'RSI',
    parameters: { period: 14, source: 'close' },
    visual: { group: 'Momentum', paneSysName: 'rsi_pane' },
  },
  {
    key: 'adx14',
    name: 'ADX',
    parameters: { period: 14, source: 'close' },
    visual: { group: 'TrendStrength', paneSysName: 'adx_pane' },
  },
  {
    key: 'macd',
    name: 'MACD',
    parameters: { period: 26, source: 'close', fast: 12, slow: 26, signal: 9 } as never,
    visual: { group: 'Momentum', paneSysName: 'macd_pane' },
  },
  {
    key: 'atr14',
    name: 'ATR',
    parameters: { period: 14, source: 'close' },
    visual: { group: 'Volatility', paneSysName: 'atr_pane' },
  },
];

const INDICATOR_MAPPING: FollowTrendIndicatorMapping = {
  smaFastKey: 'sma7',
  smaMidKey: 'sma25',
  smaSlowKey: 'sma99',
  rsiKey: 'rsi14',
  adxKey: 'adx14',
  adxValueKey: 'adx',
  macdKey: 'macd',
  macdValueKey: 'histogram',
  atrKey: 'atr14',
};

type AutonomyBranch = 'ml-only' | 'hybrid' | 'fallback' | 'timeout';
type AutonomyRegimeBucket = 'TREND' | 'CHOP' | 'UNKNOWN';

interface DecisionAudit {
  ts: number;
  branch: AutonomyBranch;
  regime: string;
  finalConfidence: number;
  ruleConfidence: number;
  mlConfidence?: number;
  standDown: boolean;
  cooldownMs: number;
  riskBoostApplied: number;
  guardrailTriggers: string[];
  reasonCode?: string;
  reasons: string[];
  intent?: 'ENTER' | 'HOLD' | 'EXIT' | 'STAND_DOWN';
}

interface RiskAudit {
  ts: number;
  allowed: boolean;
  size: number;
}

interface ScalarStats {
  avg: number;
  p50: number;
  p95: number;
}

interface BranchTradeStats {
  trades: number;
  winRate: number;
  avgPnl: number;
}

interface RegimeDistributionStats {
  count: number;
  avg: number;
  p50: number;
  p95: number;
}

interface PeriodRow {
  period: string;
  decisions: number;
  trades: number;
  overrideRate: number;
  conflictRate: number;
  strongConflictRate: number;
  standDownRate: number;
  avgCooldownMs: number;
  avgRiskBoostApplied: number;
  avgFinalConfidence: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

export interface BacktestFollowTrendRunOptions {
  candlesPath?: string | null;
  candles?: CandleLike[];
  authorityMode?: AuthorityMode;
  replayMode?: ValidationReplayMode;
  dateFrom?: string | number;
  dateTo?: string | number;
  symbol?: string;
  interval?: TimeFrame;
}

export interface BacktestFollowTrendResult {
  candles: number;
  trades: number;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  signalStats: { up: number; down: number; neutral: number };
  autonomySummary: {
    authorityMode: AuthorityMode;
    replayMode: ValidationReplayMode;
    overrideRate: number;
    conflictRate: number;
    strongConflictRate: number;
    standDownRate: number;
    guardrailTriggerRate: number;
    avgCooldownMs: number;
    guardrailTriggerCounts: Record<string, number>;
    riskBoostApplied: ScalarStats;
    finalConfidenceByRegime: Record<AutonomyRegimeBucket, RegimeDistributionStats>;
    branchTradeStats: Record<AutonomyBranch, BranchTradeStats>;
    maxDD: number;
    PF: number;
    sharpe: number;
    exposurePct: number;
    tradeFrequency: number;
    avgHoldBars: number;
    equityVolatility: number;
    overrideImpact: {
      aiPrimaryPnl: number;
      rulePnl: number;
      deltaPnl: number;
      aiVsRuleRatio: number;
    };
  };
  byDay: PeriodRow[];
  byWeek: PeriodRow[];
}

function safeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedP = Math.max(0, Math.min(1, p));
  const index = Math.floor((sorted.length - 1) * clampedP);
  return sorted[index];
}

function buildScalarStats(values: number[]): ScalarStats {
  return {
    avg: average(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function normalizeBranch(value: unknown): AutonomyBranch {
  if (value === 'ml-only' || value === 'hybrid' || value === 'timeout') return value;
  return 'fallback';
}

function normalizeRegimeBucket(value: unknown): AutonomyRegimeBucket {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase();
  if (normalized === 'TREND' || normalized === 'TRENDING') return 'TREND';
  if (normalized === 'CHOP' || normalized === 'CHOPPY' || normalized === 'RANGING') return 'CHOP';
  return 'UNKNOWN';
}

function isConflictDecision(decision: DecisionAudit): boolean {
  const reasonCode = String(decision.reasonCode ?? '').toLowerCase();
  const hasConflictReasonCode = reasonCode.includes('conflict');
  const hasConflictReason = decision.reasons.some((reason) => reason.toLowerCase().includes('conflict'));
  const hasConflictTrigger = decision.guardrailTriggers.some((trigger) =>
    trigger.toLowerCase().includes('conflict'),
  );
  return hasConflictReasonCode || hasConflictReason || hasConflictTrigger;
}

function isStrongConflictDecision(decision: DecisionAudit): boolean {
  const reasonCode = String(decision.reasonCode ?? '').toLowerCase();
  return (
    reasonCode.includes('strong_conflict') ||
    decision.guardrailTriggers.some(
      (trigger) => trigger === 'conflict-explosion' || trigger === 'conflict-explosion-active',
    )
  );
}

function computeSharpeFromEquityCurve(equityCurve: Array<{ ts: number; equity: number }>): number {
  if (equityCurve.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = safeNumber(equityCurve[i - 1]?.equity, 0);
    const curr = safeNumber(equityCurve[i]?.equity, 0);
    if (prev <= 0) continue;
    returns.push((curr - prev) / prev);
  }
  if (returns.length < 2) return 0;
  const mean = average(returns);
  const variance = average(returns.map((value) => (value - mean) ** 2));
  const stdev = Math.sqrt(variance);
  if (stdev <= 0) return 0;
  return mean / stdev;
}

function toDayKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toIsoWeekKey(ts: number): string {
  const date = new Date(ts);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - dayNum + 3);
  const isoYear = utc.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function buildPeriodRows(
  periodKeys: string[],
  decisionByPeriod: Map<string, DecisionAudit[]>,
  tradesByPeriod: Map<string, Array<{ pnl: number; branch: AutonomyBranch }>>,
): PeriodRow[] {
  return periodKeys.map((period) => {
    const decisions = decisionByPeriod.get(period) ?? [];
    const trades = tradesByPeriod.get(period) ?? [];
    const standDownCooldowns = decisions
      .filter((decision) => decision.standDown)
      .map((decision) => Math.max(0, safeNumber(decision.cooldownMs, 0)));
    const riskBoosts = decisions.map((decision) => safeNumber(decision.riskBoostApplied, 0));
    const finalConfidences = decisions.map((decision) => safeNumber(decision.finalConfidence, 0));
    const wins = trades.filter((trade) => trade.pnl > 0).length;
    const totalPnl = trades.reduce((acc, trade) => acc + trade.pnl, 0);
    return {
      period,
      decisions: decisions.length,
      trades: trades.length,
      overrideRate: decisions.length
        ? decisions.filter((decision) => decision.branch === 'ml-only').length / decisions.length
        : 0,
      conflictRate: decisions.length
        ? decisions.filter((decision) => isConflictDecision(decision)).length / decisions.length
        : 0,
      strongConflictRate: decisions.length
        ? decisions.filter((decision) => isStrongConflictDecision(decision)).length / decisions.length
        : 0,
      standDownRate: decisions.length
        ? decisions.filter((decision) => decision.standDown).length / decisions.length
        : 0,
      avgCooldownMs: average(standDownCooldowns),
      avgRiskBoostApplied: average(riskBoosts),
      avgFinalConfidence: average(finalConfidences),
      winRate: trades.length ? wins / trades.length : 0,
      avgPnl: trades.length ? totalPnl / trades.length : 0,
      totalPnl,
    };
  });
}

function simpleSma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const window = values.slice(Math.max(0, values.length - period));
  const sum = window.reduce((acc, value) => acc + value, 0);
  return sum / Math.max(1, window.length);
}

function simpleEma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function simpleRsi(values: number[], period: number): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const start = Math.max(1, values.length - period);
  for (let i = start; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function normalizeDirection(direction: SignalDirection, score: number): SignalDirection {
  if (direction !== SignalDirection.Neutral) return direction;
  if (score > 0.05) return SignalDirection.Up;
  if (score < -0.05) return SignalDirection.Down;
  return SignalDirection.Neutral;
}

function parseCandlesArg(): string | null {
  const candlesArg = process.argv.find((arg) => arg.startsWith('--candles='));
  if (candlesArg) return candlesArg.replace('--candles=', '').trim();
  if (process.argv.length > 2 && !process.argv[2].startsWith('--')) return process.argv[2];
  return null;
}

function parseSingleArg(name: string): string | null {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.slice(name.length + 3).trim();
}

function parseDateArg(input: string | number | undefined): number | null {
  if (input === undefined || input === null || input === '') return null;
  const numeric = Number(input);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(input));
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeCandles(input: CandleLike[]): Candle[] {
  return input
    .map((item, index) => {
      const open = Number(item.open ?? item.close ?? 0);
      const close = Number(item.close ?? item.open ?? 0);
      const high = Number(item.high ?? Math.max(open, close));
      const low = Number(item.low ?? Math.min(open, close));
      const volume = Number(item.volume ?? 0);
      const time = Number(item.time ?? index);
      const rawSymbol = typeof item.symbol === 'string' ? item.symbol : item.symbol?.name;
      const symbolName = rawSymbol ? String(rawSymbol).trim().toUpperCase() : BACKTEST_SYMBOL;
      const interval = (item.interval as TimeFrame | undefined) ?? BACKTEST_INTERVAL;

      return {
        open,
        close,
        high,
        low,
        volume,
        time,
        interval,
        symbol: { name: symbolName || BACKTEST_SYMBOL },
      } as Candle;
    })
    .filter(
      (candle) =>
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.close) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.volume) &&
        Number.isFinite(candle.time),
    )
    .sort((a, b) => a.time - b.time);
}

function applyCandleFilters(
  candles: Candle[],
  options: Pick<BacktestFollowTrendRunOptions, 'dateFrom' | 'dateTo' | 'symbol' | 'interval'>,
): Candle[] {
  const dateFromTs = parseDateArg(options.dateFrom);
  const dateToTs = parseDateArg(options.dateTo);
  const requestedSymbol = options.symbol?.trim().toUpperCase();
  const requestedInterval = options.interval;
  return candles.filter((candle) => {
    if (requestedSymbol && candle.symbol.name.toUpperCase() !== requestedSymbol) return false;
    if (requestedInterval && candle.interval !== requestedInterval) return false;
    if (dateFromTs !== null && candle.time < dateFromTs) return false;
    if (dateToTs !== null && candle.time > dateToTs) return false;
    return true;
  });
}

function loadCandlesFromJson(filePath: string): Candle[] {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw) as CandleLike[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array of candles, got ${typeof parsed}`);
  }
  return normalizeCandles(parsed);
}

export function generateDeterministicCandles(count = 1200): Candle[] {
  const candles: Candle[] = [];
  const baseTs = Date.UTC(2025, 0, 1, 0, 0, 0);
  let prevClose = 42_000;

  for (let i = 0; i < count; i += 1) {
    const drift = i * 1.25;
    const wave = Math.sin(i / 24) * 180 + Math.sin(i / 7) * 55;
    const noise = Math.cos(i / 9) * 30;
    const close = Math.max(100, 42_000 + drift + wave + noise);
    const open = prevClose;
    const spread = Math.abs(Math.sin(i / 5) * 35) + 12;
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread;
    const volume = 100 + Math.abs(Math.sin(i / 11) * 40);

    candles.push({
      open,
      close,
      high,
      low,
      volume,
      time: baseTs + i * 60_000,
      interval: BACKTEST_INTERVAL,
      symbol: { name: BACKTEST_SYMBOL },
    });

    prevClose = close;
  }

  return candles;
}

function buildSignalPipeline(profile: TrendSignalProfile, riskProfile: RiskProfile) {
  const indicatorsService = new IndicatorsService();
  const featureBuilder = new FeatureBuilder(indicatorsService);
  const signalEngine = new TrendSignalEngine(profile);
  const riskEngine = new RiskEngine(riskProfile);
  const indicatorGroup = indicatorsService.createIndicatorGroup(INDICATORS);
  const history: Candle[] = [];
  const signalStats = { up: 0, down: 0, neutral: 0 };

  const strategy = (candle: Candle) => {
    indicatorsService.runGroup(indicatorGroup, 'onCandleClose', candle);
    history.push(candle);

    const featureSet = featureBuilder.buildTrendFeatures(
      {
        symbol: candle.symbol.name,
        interval: candle.interval ?? BACKTEST_INTERVAL,
        price: candle.close,
        candles: history,
        indicatorsGroup: indicatorGroup,
      },
      INDICATOR_MAPPING,
    );

    if (!featureSet) {
      const closes = history.map((entry) => entry.close);
      const fallback = featureBuilder.buildGenericFeatures({
        symbol: candle.symbol.name,
        interval: candle.interval ?? BACKTEST_INTERVAL,
        price: candle.close,
        candles: history,
        indicatorsGroup: indicatorGroup,
      });
      const momentum = fallback.values.returnPct ?? 0;
      const trendUp = momentum >= 0;
      fallback.values.smaFast = trendUp ? candle.close * 0.999 : candle.close * 1.001;
      fallback.values.smaMid = trendUp ? candle.close * 0.998 : candle.close * 1.002;
      fallback.values.smaSlow = trendUp ? candle.close * 0.997 : candle.close * 1.003;
      fallback.values.rsi = trendUp ? 62 : 38;
      fallback.values.adx = 25;
      const emaFast = simpleEma(closes.slice(-80), 12);
      const emaSlow = simpleEma(closes.slice(-80), 26);
      fallback.values.macdHistogram = trendUp ? Math.abs(emaFast - emaSlow) : -Math.abs(emaFast - emaSlow);
      const fallbackSignal = signalEngine.evaluateInterval(fallback, {
        barsCount: history.length,
        timestamp: candle.time,
      });
      const fallbackAggregate = signalEngine.aggregate([fallbackSignal]);
      const fallbackDirection = normalizeDirection(
        fallbackAggregate.direction,
        fallbackAggregate.totalScore,
      );
      if (fallbackDirection === SignalDirection.Up) signalStats.up += 1;
      else if (fallbackDirection === SignalDirection.Down) signalStats.down += 1;
      else signalStats.neutral += 1;
      return {
        direction: fallbackDirection,
        score: fallbackAggregate.totalScore,
        confidence: fallbackAggregate.confidence,
      };
    }

    const intervalSignal = signalEngine.evaluateInterval(featureSet, {
      barsCount: history.length,
      timestamp: candle.time,
    });
    const aggregate = signalEngine.aggregate([intervalSignal]);
    const direction = normalizeDirection(aggregate.direction, aggregate.totalScore);
    if (direction === SignalDirection.Up) signalStats.up += 1;
    else if (direction === SignalDirection.Down) signalStats.down += 1;
    else signalStats.neutral += 1;

    return {
      direction,
      score: aggregate.totalScore,
      confidence: aggregate.confidence,
    };
  };

  return { strategy, riskEngine, signalStats };
}

function computeDailyEquityVolatility(equityCurve: Array<{ ts: number; equity: number }>): number {
  if (equityCurve.length < 3) return 0;
  const dayEndEquity = new Map<string, number>();
  for (const point of equityCurve) {
    dayEndEquity.set(toDayKey(point.ts), safeNumber(point.equity, 0));
  }
  const ordered = Array.from(dayEndEquity.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  if (ordered.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1][1];
    const curr = ordered[i][1];
    if (prev <= 0) continue;
    returns.push((curr - prev) / prev);
  }
  if (returns.length < 2) return 0;
  const mean = average(returns);
  return Math.sqrt(average(returns.map((value) => (value - mean) ** 2)));
}

function computeHoldingStats(
  candles: Candle[],
  trades: Array<{ entryTs: number; exitTs: number }>,
): { exposurePct: number; avgHoldBars: number } {
  if (candles.length === 0 || trades.length === 0) {
    return { exposurePct: 0, avgHoldBars: 0 };
  }
  const tsToIndex = new Map<number, number>();
  candles.forEach((candle, index) => tsToIndex.set(candle.time, index));
  let totalBarsInPosition = 0;
  for (const trade of trades) {
    const entryIndex = tsToIndex.get(trade.entryTs);
    const exitIndex = tsToIndex.get(trade.exitTs);
    if (entryIndex === undefined || exitIndex === undefined) continue;
    totalBarsInPosition += Math.max(1, exitIndex - entryIndex + 1);
  }
  const avgHoldBars = totalBarsInPosition / Math.max(1, trades.length);
  const exposurePct = totalBarsInPosition / Math.max(1, candles.length);
  return { exposurePct, avgHoldBars };
}

function computeTradeFrequency(tradesCount: number, candles: Candle[]): number {
  if (tradesCount <= 0 || candles.length === 0) return 0;
  const uniqueDays = new Set(candles.map((candle) => toDayKey(candle.time))).size;
  if (uniqueDays === 0) return 0;
  return tradesCount / uniqueDays;
}

export function runBacktestFollowTrend(
  options: BacktestFollowTrendRunOptions = {},
): BacktestFollowTrendResult {
  const candlesArg = options.candlesPath ?? parseCandlesArg();
  const authorityMode: AuthorityMode = options.authorityMode ?? 'rule-first';
  const replayMode: ValidationReplayMode = options.replayMode ?? 'deterministic';
  const candles = options.candles
    ? normalizeCandles(options.candles)
    : candlesArg
      ? loadCandlesFromJson(candlesArg)
      : generateDeterministicCandles();
  const filteredCandles = applyCandleFilters(candles, options);

  if (filteredCandles.length === 0) {
    throw new Error('No candles loaded for backtest');
  }

  const signalProfile: TrendSignalProfile = {
    ...DEFAULT_TREND_PROFILE,
    thresholds: {
      ...DEFAULT_TREND_PROFILE.thresholds,
      adxMin: 10,
    },
    aggregation: {
      ...DEFAULT_TREND_PROFILE.aggregation,
      minScoreForUp: 0.35,
      maxScoreForDown: -0.35,
    },
    readiness: {
      ...DEFAULT_TREND_PROFILE.readiness,
      strictWarmup: false,
      defaultMinBars: 50,
    },
  };
  const riskProfile: RiskProfile = {
    ...DEFAULT_RISK_PROFILE,
    minConfidence: 0,
    maxPositionNotionalPct: 1,
    exposureCapPct: 1,
  };
  const { strategy, riskEngine, signalStats } = buildSignalPipeline(signalProfile, riskProfile);
  const decisionAudit: DecisionAudit[] = [];
  const riskAudit: RiskAudit[] = [];
  let activeCandleTs = 0;
  const strategyWithAudit = (candle: Candle) => {
    activeCandleTs = safeNumber(candle.time, 0);
    const decision = strategy(candle);
    const decisionMeta = decision as typeof decision & {
      finalConfidence?: number;
      ruleConfidence?: number;
      mlConfidence?: number;
      branch?: AutonomyBranch;
      reasonCode?: string;
      reasons?: string[];
      authorityMode?: 'rule-first' | 'ai-dominant' | 'ai-autonomous';
      standDown?: boolean;
      cooldownMs?: number;
      riskBoostApplied?: number;
      guardrailTriggers?: string[];
      intent?: 'ENTER' | 'HOLD' | 'EXIT' | 'STAND_DOWN';
      regime?: string;
    };
    decisionAudit.push({
      ts: activeCandleTs,
      branch: normalizeBranch(decisionMeta.branch),
      regime: String(decisionMeta.regime ?? 'Unknown'),
      finalConfidence: safeNumber(decisionMeta.finalConfidence, decision.confidence),
      ruleConfidence: safeNumber(decisionMeta.ruleConfidence, decision.confidence),
      mlConfidence:
        decisionMeta.mlConfidence === undefined ? undefined : safeNumber(decisionMeta.mlConfidence, 0),
      standDown: Boolean(decisionMeta.standDown || decisionMeta.intent === 'STAND_DOWN'),
      cooldownMs: Math.max(0, Math.floor(safeNumber(decisionMeta.cooldownMs, 0))),
      riskBoostApplied: safeNumber(decisionMeta.riskBoostApplied, 0),
      guardrailTriggers: Array.isArray(decisionMeta.guardrailTriggers)
        ? decisionMeta.guardrailTriggers.map((trigger) => String(trigger))
        : [],
      reasonCode: decisionMeta.reasonCode,
      reasons: Array.isArray(decisionMeta.reasons)
        ? decisionMeta.reasons.map((reason) => String(reason))
        : [],
      intent: decisionMeta.intent,
    });
    return decision;
  };
  const riskEngineWithAudit = {
    evaluate: (ctx: Parameters<typeof riskEngine.evaluate>[0]) => {
      const evaluated = riskEngine.evaluate(ctx);
      riskAudit.push({
        ts: activeCandleTs,
        allowed: evaluated.allowed,
        size: safeNumber(evaluated.size, 0),
      });
      return evaluated;
    },
  };
  const backtestEngine = new DeterministicBacktestEngine();

  const result = backtestEngine.run({
    candles: filteredCandles,
    strategy: strategyWithAudit,
    riskEngine: riskEngineWithAudit,
    riskProfile,
    replayMode,
    config: {
      initialEquity: BACKTEST_INITIAL_EQUITY,
      feePct: 0.0004,
      slippagePct: 0.0002,
    },
  });
  const decisionsCount = decisionAudit.length;
  const conflictCount = decisionAudit.filter((decision) => isConflictDecision(decision)).length;
  const strongConflictCount = decisionAudit.filter((decision) => isStrongConflictDecision(decision)).length;
  const standDownEvents = decisionAudit.filter((decision) => decision.standDown);
  const standDownCooldownValues = standDownEvents.map((decision) => decision.cooldownMs);
  const guardrailCounts: Record<string, number> = {};
  for (const decision of decisionAudit) {
    for (const guardrail of decision.guardrailTriggers) {
      guardrailCounts[guardrail] = (guardrailCounts[guardrail] ?? 0) + 1;
    }
  }
  const riskBoostValues = decisionAudit.map((decision) => decision.riskBoostApplied);
  const confidenceByRegime: Record<AutonomyRegimeBucket, number[]> = {
    TREND: [],
    CHOP: [],
    UNKNOWN: [],
  };
  for (const decision of decisionAudit) {
    const bucket = normalizeRegimeBucket(decision.regime);
    confidenceByRegime[bucket].push(decision.finalConfidence);
  }
  const decisionByTs = new Map<number, DecisionAudit>();
  for (const decision of decisionAudit) {
    if (!decisionByTs.has(decision.ts)) {
      decisionByTs.set(decision.ts, decision);
    }
  }
  const entryBranchByTs = new Map<number, AutonomyBranch>();
  for (const riskEntry of riskAudit) {
    if (!riskEntry.allowed || riskEntry.size <= 0) continue;
    const sourceDecision = decisionByTs.get(riskEntry.ts);
    entryBranchByTs.set(riskEntry.ts, sourceDecision?.branch ?? 'fallback');
  }
  const tradesByBranch: Record<AutonomyBranch, number[]> = {
    'ml-only': [],
    hybrid: [],
    fallback: [],
    timeout: [],
  };
  const winsByBranch: Record<AutonomyBranch, number> = {
    'ml-only': 0,
    hybrid: 0,
    fallback: 0,
    timeout: 0,
  };
  for (const trade of result.trades) {
    const branch = entryBranchByTs.get(trade.entryTs) ?? 'fallback';
    tradesByBranch[branch].push(trade.pnl);
    if (trade.pnl > 0) {
      winsByBranch[branch] += 1;
    }
  }
  const branchStats: Record<AutonomyBranch, BranchTradeStats> = {
    'ml-only': {
      trades: tradesByBranch['ml-only'].length,
      winRate: tradesByBranch['ml-only'].length
        ? winsByBranch['ml-only'] / tradesByBranch['ml-only'].length
        : 0,
      avgPnl: average(tradesByBranch['ml-only']),
    },
    hybrid: {
      trades: tradesByBranch.hybrid.length,
      winRate: tradesByBranch.hybrid.length ? winsByBranch.hybrid / tradesByBranch.hybrid.length : 0,
      avgPnl: average(tradesByBranch.hybrid),
    },
    fallback: {
      trades: tradesByBranch.fallback.length,
      winRate: tradesByBranch.fallback.length
        ? winsByBranch.fallback / tradesByBranch.fallback.length
        : 0,
      avgPnl: average(tradesByBranch.fallback),
    },
    timeout: {
      trades: tradesByBranch.timeout.length,
      winRate: tradesByBranch.timeout.length ? winsByBranch.timeout / tradesByBranch.timeout.length : 0,
      avgPnl: average(tradesByBranch.timeout),
    },
  };
  const confidenceDistributionByRegime: Record<AutonomyRegimeBucket, RegimeDistributionStats> = {
    TREND: {
      count: confidenceByRegime.TREND.length,
      ...buildScalarStats(confidenceByRegime.TREND),
    },
    CHOP: {
      count: confidenceByRegime.CHOP.length,
      ...buildScalarStats(confidenceByRegime.CHOP),
    },
    UNKNOWN: {
      count: confidenceByRegime.UNKNOWN.length,
      ...buildScalarStats(confidenceByRegime.UNKNOWN),
    },
  };
  const dayKeys = new Set<string>();
  const weekKeys = new Set<string>();
  const decisionsByDay = new Map<string, DecisionAudit[]>();
  const decisionsByWeek = new Map<string, DecisionAudit[]>();
  for (const decision of decisionAudit) {
    const dayKey = toDayKey(decision.ts);
    const weekKey = toIsoWeekKey(decision.ts);
    dayKeys.add(dayKey);
    weekKeys.add(weekKey);
    const dayBucket = decisionsByDay.get(dayKey) ?? [];
    dayBucket.push(decision);
    decisionsByDay.set(dayKey, dayBucket);
    const weekBucket = decisionsByWeek.get(weekKey) ?? [];
    weekBucket.push(decision);
    decisionsByWeek.set(weekKey, weekBucket);
  }
  const tradesByDay = new Map<string, Array<{ pnl: number; branch: AutonomyBranch }>>();
  const tradesByWeek = new Map<string, Array<{ pnl: number; branch: AutonomyBranch }>>();
  for (const trade of result.trades) {
    const ts = trade.exitTs;
    const branch = entryBranchByTs.get(trade.entryTs) ?? 'fallback';
    const dayKey = toDayKey(ts);
    const weekKey = toIsoWeekKey(ts);
    dayKeys.add(dayKey);
    weekKeys.add(weekKey);
    const dayBucket = tradesByDay.get(dayKey) ?? [];
    dayBucket.push({ pnl: trade.pnl, branch });
    tradesByDay.set(dayKey, dayBucket);
    const weekBucket = tradesByWeek.get(weekKey) ?? [];
    weekBucket.push({ pnl: trade.pnl, branch });
    tradesByWeek.set(weekKey, weekBucket);
  }
  const byDay = buildPeriodRows(Array.from(dayKeys).sort(), decisionsByDay, tradesByDay);
  const byWeek = buildPeriodRows(Array.from(weekKeys).sort(), decisionsByWeek, tradesByWeek);
  const guardrailTriggerRate =
    decisionsCount > 0
      ? decisionAudit.filter((decision) => decision.guardrailTriggers.length > 0).length / decisionsCount
      : 0;
  const { exposurePct, avgHoldBars } = computeHoldingStats(filteredCandles, result.trades);
  const tradeFrequency = computeTradeFrequency(result.trades.length, filteredCandles);
  const equityVolatility = computeDailyEquityVolatility(result.equityCurve);
  const aiPrimaryPnl = tradesByBranch['ml-only'].reduce((acc, pnl) => acc + pnl, 0);
  const rulePnl =
    tradesByBranch.fallback.reduce((acc, pnl) => acc + pnl, 0) +
    tradesByBranch.hybrid.reduce((acc, pnl) => acc + pnl, 0) +
    tradesByBranch.timeout.reduce((acc, pnl) => acc + pnl, 0);
  const autonomySummary = {
    authorityMode,
    replayMode,
    overrideRate:
      decisionsCount > 0
        ? decisionAudit.filter((decision) => decision.branch === 'ml-only').length / decisionsCount
        : 0,
    conflictRate: decisionsCount > 0 ? conflictCount / decisionsCount : 0,
    strongConflictRate: decisionsCount > 0 ? strongConflictCount / decisionsCount : 0,
    standDownRate: decisionsCount > 0 ? standDownEvents.length / decisionsCount : 0,
    guardrailTriggerRate,
    avgCooldownMs: average(standDownCooldownValues),
    guardrailTriggerCounts: guardrailCounts,
    riskBoostApplied: buildScalarStats(riskBoostValues),
    finalConfidenceByRegime: confidenceDistributionByRegime,
    branchTradeStats: branchStats,
    maxDD: result.maxDrawdownPct,
    PF: result.profitFactor,
    sharpe: computeSharpeFromEquityCurve(result.equityCurve),
    exposurePct,
    tradeFrequency,
    avgHoldBars,
    equityVolatility,
    overrideImpact: {
      aiPrimaryPnl,
      rulePnl,
      deltaPnl: aiPrimaryPnl - rulePnl,
      aiVsRuleRatio: rulePnl === 0 ? 0 : aiPrimaryPnl / rulePnl,
    },
  };

  return {
    candles: filteredCandles.length,
    trades: result.trades.length,
    finalEquity: Number(result.finalEquity.toFixed(2)),
    totalReturnPct: Number(result.totalReturnPct.toFixed(4)),
    maxDrawdownPct: Number(result.maxDrawdownPct.toFixed(4)),
    winRate: Number(result.winRate.toFixed(4)),
    profitFactor: Number(result.profitFactor.toFixed(4)),
    sharpe: Number(computeSharpeFromEquityCurve(result.equityCurve).toFixed(4)),
    signalStats,
    autonomySummary: {
      ...autonomySummary,
      overrideRate: Number(autonomySummary.overrideRate.toFixed(4)),
      conflictRate: Number(autonomySummary.conflictRate.toFixed(4)),
      strongConflictRate: Number(autonomySummary.strongConflictRate.toFixed(4)),
      standDownRate: Number(autonomySummary.standDownRate.toFixed(4)),
      guardrailTriggerRate: Number(autonomySummary.guardrailTriggerRate.toFixed(4)),
      avgCooldownMs: Number(autonomySummary.avgCooldownMs.toFixed(2)),
      riskBoostApplied: {
        avg: Number(autonomySummary.riskBoostApplied.avg.toFixed(4)),
        p50: Number(autonomySummary.riskBoostApplied.p50.toFixed(4)),
        p95: Number(autonomySummary.riskBoostApplied.p95.toFixed(4)),
      },
      maxDD: Number(autonomySummary.maxDD.toFixed(4)),
      PF: Number(autonomySummary.PF.toFixed(4)),
      sharpe: Number(autonomySummary.sharpe.toFixed(4)),
      exposurePct: Number(autonomySummary.exposurePct.toFixed(4)),
      tradeFrequency: Number(autonomySummary.tradeFrequency.toFixed(4)),
      avgHoldBars: Number(autonomySummary.avgHoldBars.toFixed(4)),
      equityVolatility: Number(autonomySummary.equityVolatility.toFixed(6)),
      overrideImpact: {
        aiPrimaryPnl: Number(autonomySummary.overrideImpact.aiPrimaryPnl.toFixed(4)),
        rulePnl: Number(autonomySummary.overrideImpact.rulePnl.toFixed(4)),
        deltaPnl: Number(autonomySummary.overrideImpact.deltaPnl.toFixed(4)),
        aiVsRuleRatio: Number(autonomySummary.overrideImpact.aiVsRuleRatio.toFixed(4)),
      },
    },
    byDay,
    byWeek,
  };
}

function main(): void {
  const authorityMode = (parseSingleArg('authorityMode') as AuthorityMode | null) ?? 'rule-first';
  const replayMode = (parseSingleArg('replayMode') as ValidationReplayMode | null) ?? 'deterministic';
  const symbolArg = parseSingleArg('symbol');
  const intervalArg = parseSingleArg('interval');
  const dateFrom = parseSingleArg('dateFrom');
  const dateTo = parseSingleArg('dateTo');
  const result = runBacktestFollowTrend({
    authorityMode,
    replayMode,
    symbol: symbolArg ?? undefined,
    interval: (intervalArg as TimeFrame | null) ?? undefined,
    dateFrom: dateFrom ?? undefined,
    dateTo: dateTo ?? undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.byDay.length > 0) console.table(result.byDay);
  if (result.byWeek.length > 0) console.table(result.byWeek);
}

if (require.main === module) {
  main();
}
