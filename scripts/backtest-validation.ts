import * as fs from 'fs';
import * as path from 'path';
import { Candle, TimeFrame } from '@barfinex/types';
import {
  AuthorityMode,
  BacktestFollowTrendResult,
  generateDeterministicCandles,
  runBacktestFollowTrend,
  ValidationReplayMode,
} from './backtest-follow-trend';

type DatasetKind = 'full-dataset' | 'trend-only' | 'chop-only' | 'high-volatility-window';

interface ValidationRunnerInput {
  authorityMode: AuthorityMode;
  replayMode: ValidationReplayMode;
  dateFrom?: string | number;
  dateTo?: string | number;
  symbol?: string;
  interval?: TimeFrame;
  candlesPath?: string;
  candles?: Candle[];
  datasetKind?: DatasetKind;
}

interface StabilityFlags {
  statuses: Array<'UNSTABLE' | 'NO EDGE' | 'VOLATILE AI'>;
}

interface KpiCheck {
  isAutonomousSuccess: boolean;
  checks: {
    sharpe: boolean;
    maxDD: boolean;
    PF: boolean;
    exposure: boolean;
    guardrailRate: boolean;
    overrideRate: boolean;
  };
}

export interface ValidationResult {
  mode: AuthorityMode;
  replayMode: ValidationReplayMode;
  dataset: DatasetKind;
  input: Omit<ValidationRunnerInput, 'candles'>;
  result: BacktestFollowTrendResult;
  stability: StabilityFlags;
  kpi: KpiCheck;
}

interface ValidationReportRows {
  comparisonRows: Array<Record<string, string | number>>;
  deltaRows: Array<Record<string, string | number>>;
}

const DEFAULT_MODES: AuthorityMode[] = ['rule-first', 'ai-dominant', 'ai-autonomous'];
const DEFAULT_DATASETS: DatasetKind[] = [
  'full-dataset',
  'trend-only',
  'chop-only',
  'high-volatility-window',
];

function parseSingleArg(name: string): string | null {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.slice(name.length + 3).trim();
}

function parseDateArg(input?: string | number): number | null {
  if (input === undefined || input === null || input === '') return null;
  const numeric = Number(input);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(input));
  return Number.isFinite(parsed) ? parsed : null;
}

function toDayKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function loadCandlesFromJson(filePath: string): Candle[] {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw) as Array<
    Partial<Candle> & {
      symbol?: string | { name?: string };
      interval?: TimeFrame | string;
    }
  >;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array of candles, got ${typeof parsed}`);
  }
  return parsed
    .map((item, index) => {
      const open = Number(item.open ?? item.close ?? 0);
      const close = Number(item.close ?? item.open ?? 0);
      const high = Number(item.high ?? Math.max(open, close));
      const low = Number(item.low ?? Math.min(open, close));
      const volume = Number(item.volume ?? 0);
      const time = Number(item.time ?? index);
      const symbolName =
        typeof item.symbol === 'string'
          ? item.symbol
          : item.symbol?.name
            ? String(item.symbol.name)
            : 'BTCUSDT';
      return {
        open,
        close,
        high,
        low,
        volume,
        time,
        interval: (item.interval as TimeFrame | undefined) ?? TimeFrame.min1,
        symbol: { name: symbolName.toUpperCase() },
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

function applyBaseFilters(candles: Candle[], input: ValidationRunnerInput): Candle[] {
  const requestedSymbol = input.symbol?.trim().toUpperCase();
  const dateFromTs = parseDateArg(input.dateFrom);
  const dateToTs = parseDateArg(input.dateTo);
  return candles.filter((candle) => {
    if (requestedSymbol && candle.symbol.name.toUpperCase() !== requestedSymbol) return false;
    if (input.interval && candle.interval !== input.interval) return false;
    if (dateFromTs !== null && candle.time < dateFromTs) return false;
    if (dateToTs !== null && candle.time > dateToTs) return false;
    return true;
  });
}

function classifyRegime(candles: Candle[], index: number, lookback = 48): 'TREND' | 'CHOP' {
  const from = Math.max(0, index - lookback);
  const slice = candles.slice(from, index + 1);
  if (slice.length < 8) return 'CHOP';
  const first = slice[0].close;
  const last = slice[slice.length - 1].close;
  const drift = first > 0 ? (last - first) / first : 0;
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev <= 0) continue;
    returns.push((curr - prev) / prev);
  }
  const volatility = stdev(returns);
  if (Math.abs(drift) >= 0.006 && volatility <= 0.02) return 'TREND';
  return 'CHOP';
}

function rollingVolatility(candles: Candle[], index: number, lookback = 64): number {
  const from = Math.max(1, index - lookback + 1);
  const returns: number[] = [];
  for (let i = from; i <= index; i += 1) {
    const prev = candles[i - 1]?.close ?? 0;
    const curr = candles[i]?.close ?? 0;
    if (prev <= 0) continue;
    returns.push((curr - prev) / prev);
  }
  return stdev(returns);
}

function selectHighVolatilityWindow(candles: Candle[]): Candle[] {
  if (candles.length < 150) return candles;
  const windowSize = Math.max(120, Math.floor(candles.length * 0.2));
  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start + windowSize <= candles.length; start += 1) {
    const end = start + windowSize - 1;
    const score = rollingVolatility(candles, end, Math.min(96, windowSize));
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return candles.slice(bestStart, bestStart + windowSize);
}

function buildDatasetCandles(candles: Candle[], dataset: DatasetKind): Candle[] {
  if (dataset === 'full-dataset') return candles;
  if (dataset === 'high-volatility-window') return selectHighVolatilityWindow(candles);
  const filtered = candles.filter((_, index) => {
    const regime = classifyRegime(candles, index);
    return dataset === 'trend-only' ? regime === 'TREND' : regime === 'CHOP';
  });
  return filtered.length >= Math.max(50, Math.floor(candles.length * 0.1)) ? filtered : candles;
}

function computeStabilityFlags(
  current: ValidationResult,
  baseline: ValidationResult | undefined,
): StabilityFlags {
  if (!baseline || current.mode === 'rule-first') {
    return { statuses: [] };
  }
  const statuses: Array<'UNSTABLE' | 'NO EDGE' | 'VOLATILE AI'> = [];
  const maxDDBreach =
    baseline.result.maxDrawdownPct > 0
      ? current.result.maxDrawdownPct > baseline.result.maxDrawdownPct * 1.3
      : current.result.maxDrawdownPct > baseline.result.maxDrawdownPct;
  if (maxDDBreach) statuses.push('UNSTABLE');
  const noEdge =
    current.result.sharpe < baseline.result.sharpe &&
    current.result.profitFactor < baseline.result.profitFactor;
  if (noEdge) statuses.push('NO EDGE');
  const volatileAi =
    baseline.result.autonomySummary.equityVolatility > 0
      ? current.result.autonomySummary.equityVolatility >
        baseline.result.autonomySummary.equityVolatility * 1.5
      : current.result.autonomySummary.equityVolatility > baseline.result.autonomySummary.equityVolatility;
  if (volatileAi) statuses.push('VOLATILE AI');
  return { statuses };
}

function computeKpi(current: ValidationResult, baseline: ValidationResult | undefined): KpiCheck {
  if (current.mode !== 'ai-autonomous' || !baseline) {
    return {
      isAutonomousSuccess: false,
      checks: {
        sharpe: false,
        maxDD: false,
        PF: false,
        exposure: false,
        guardrailRate: false,
        overrideRate: false,
      },
    };
  }
  const sharpe = current.result.sharpe >= baseline.result.sharpe;
  const maxDD = current.result.maxDrawdownPct <= baseline.result.maxDrawdownPct * 1.15;
  const PF = current.result.profitFactor >= baseline.result.profitFactor * 0.9;
  const exposure =
    current.result.autonomySummary.exposurePct <= baseline.result.autonomySummary.exposurePct * 1.25;
  const guardrailRate = current.result.autonomySummary.guardrailTriggerRate > 0;
  const overrideRate = current.result.autonomySummary.overrideRate > 0.1;
  const checks = { sharpe, maxDD, PF, exposure, guardrailRate, overrideRate };
  return {
    isAutonomousSuccess: Object.values(checks).every(Boolean),
    checks,
  };
}

export function runValidation(input: ValidationRunnerInput): ValidationResult {
  const sourceCandles =
    input.candles ??
    (input.candlesPath ? loadCandlesFromJson(input.candlesPath) : undefined) ??
    undefined;
  const runResult = runBacktestFollowTrend({
    authorityMode: input.authorityMode,
    replayMode: input.replayMode,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    symbol: input.symbol,
    interval: input.interval,
    candles: sourceCandles,
  });
  return {
    mode: input.authorityMode,
    replayMode: input.replayMode,
    dataset: input.datasetKind ?? 'full-dataset',
    input: {
      authorityMode: input.authorityMode,
      replayMode: input.replayMode,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      symbol: input.symbol,
      interval: input.interval,
      candlesPath: input.candlesPath,
      datasetKind: input.datasetKind,
    },
    result: runResult,
    stability: { statuses: [] },
    kpi: {
      isAutonomousSuccess: false,
      checks: {
        sharpe: false,
        maxDD: false,
        PF: false,
        exposure: false,
        guardrailRate: false,
        overrideRate: false,
      },
    },
  };
}

export function runValidationMatrix(baseInput: Omit<ValidationRunnerInput, 'authorityMode'>): ValidationResult[] {
  const baseCandles = baseInput.candles ??
    (baseInput.candlesPath ? loadCandlesFromJson(baseInput.candlesPath) : undefined) ??
    generateDeterministicCandles();
  const filteredBaseCandles = applyBaseFilters(baseCandles, {
    ...baseInput,
    authorityMode: 'rule-first',
    replayMode: baseInput.replayMode,
  });
  const results: ValidationResult[] = [];

  for (const dataset of DEFAULT_DATASETS) {
    const datasetCandles = buildDatasetCandles(filteredBaseCandles, dataset);
    const byMode = new Map<AuthorityMode, ValidationResult>();
    for (const mode of DEFAULT_MODES) {
      const replayMode: ValidationReplayMode =
        mode === 'ai-autonomous' ? 'ai-autonomous' : baseInput.replayMode ?? 'deterministic';
      const result = runValidation({
        ...baseInput,
        authorityMode: mode,
        replayMode,
        candles: datasetCandles,
        datasetKind: dataset,
      });
      byMode.set(mode, result);
      results.push(result);
    }
    const baseline = byMode.get('rule-first');
    for (const mode of DEFAULT_MODES) {
      const current = byMode.get(mode);
      if (!current) continue;
      current.stability = computeStabilityFlags(current, baseline);
      current.kpi = computeKpi(current, baseline);
    }
  }

  return results;
}

function toPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function toNum(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

export function buildValidationReport(results: ValidationResult[]): ValidationReportRows {
  const comparisonRows = results.map((item) => ({
    Dataset: item.dataset,
    Mode: item.mode,
    Sharpe: toNum(item.result.sharpe),
    MaxDD: toNum(item.result.maxDrawdownPct),
    PF: toNum(item.result.profitFactor),
    Exposure: toPct(item.result.autonomySummary.exposurePct),
    OverrideRate: toPct(item.result.autonomySummary.overrideRate),
    GuardrailRate: toPct(item.result.autonomySummary.guardrailTriggerRate),
    EquityVol: toNum(item.result.autonomySummary.equityVolatility, 6),
    Stability: item.stability.statuses.join(', ') || 'OK',
    AutonomousKPI: item.mode === 'ai-autonomous' ? (item.kpi.isAutonomousSuccess ? 'PASS' : 'FAIL') : '-',
  }));

  const deltaRows: Array<Record<string, string | number>> = [];
  const datasetGroups = new Map<DatasetKind, ValidationResult[]>();
  for (const item of results) {
    const bucket = datasetGroups.get(item.dataset) ?? [];
    bucket.push(item);
    datasetGroups.set(item.dataset, bucket);
  }
  for (const [dataset, group] of datasetGroups.entries()) {
    const baseline = group.find((entry) => entry.mode === 'rule-first');
    if (!baseline) continue;
    for (const item of group) {
      if (item.mode === 'rule-first') continue;
      deltaRows.push({
        Dataset: dataset,
        Mode: item.mode,
        'Δ Sharpe': toNum(item.result.sharpe - baseline.result.sharpe),
        'Δ MaxDD': toNum(item.result.maxDrawdownPct - baseline.result.maxDrawdownPct),
        'Δ PF': toNum(item.result.profitFactor - baseline.result.profitFactor),
        'Δ Exposure': toPct(
          item.result.autonomySummary.exposurePct - baseline.result.autonomySummary.exposurePct,
        ),
        'Δ OverrideRate': toPct(
          item.result.autonomySummary.overrideRate - baseline.result.autonomySummary.overrideRate,
        ),
        'Δ GuardrailRate': toPct(
          item.result.autonomySummary.guardrailTriggerRate -
            baseline.result.autonomySummary.guardrailTriggerRate,
        ),
        'Δ EquityVol': toNum(
          item.result.autonomySummary.equityVolatility -
            baseline.result.autonomySummary.equityVolatility,
          6,
        ),
      });
    }
  }

  return { comparisonRows, deltaRows };
}

function writeReport(results: ValidationResult[]): string {
  const reportsDir = path.resolve(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `validation-${timestamp}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    results,
    report: buildValidationReport(results),
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

function main(): void {
  const authorityModeArg = parseSingleArg('authorityMode') as AuthorityMode | null;
  const replayModeArg = (parseSingleArg('replayMode') as ValidationReplayMode | null) ?? 'deterministic';
  const dateFrom = parseSingleArg('dateFrom') ?? undefined;
  const dateTo = parseSingleArg('dateTo') ?? undefined;
  const symbol = parseSingleArg('symbol') ?? undefined;
  const intervalArg = parseSingleArg('interval') as TimeFrame | null;
  const candlesPath = parseSingleArg('candles') ?? undefined;
  const datasetArg = parseSingleArg('dataset') as DatasetKind | null;
  const replayMode = replayModeArg;
  const interval = intervalArg ?? undefined;

  if (authorityModeArg) {
    const sourceCandles = candlesPath ? loadCandlesFromJson(candlesPath) : generateDeterministicCandles();
    const baseCandles = applyBaseFilters(sourceCandles, {
      authorityMode: authorityModeArg,
      replayMode,
      dateFrom,
      dateTo,
      symbol,
      interval,
    });
    const datasetCandles = datasetArg ? buildDatasetCandles(baseCandles, datasetArg) : baseCandles;
    const result = runValidation({
      authorityMode: authorityModeArg,
      replayMode,
      dateFrom,
      dateTo,
      symbol,
      interval,
      candles: datasetCandles,
      datasetKind: datasetArg ?? 'full-dataset',
      candlesPath,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const matrixResults = runValidationMatrix({
    replayMode,
    dateFrom,
    dateTo,
    symbol,
    interval,
    candlesPath,
  });
  const validationReport = buildValidationReport(matrixResults);
  console.table(validationReport.comparisonRows);
  console.table(validationReport.deltaRows);
  const reportPath = writeReport(matrixResults);
  const uniqueDays = new Set(
    matrixResults.flatMap((entry) => entry.result.byDay.map((row) => String(row.period))),
  ).size;
  console.log(
    JSON.stringify(
      {
        runs: matrixResults.length,
        datasets: DEFAULT_DATASETS,
        modes: DEFAULT_MODES,
        uniqueDays,
        reportPath,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main();
}

