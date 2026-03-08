type AnyRecord = Record<string, any>;

function optionalRequire<T = AnyRecord>(moduleName: string): T | null {
  if (String(process.env.BARFINEX_DISABLE_SUBSCRIPTION_LIBS || '').toLowerCase() === 'true') {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName) as T;
  } catch {
    return null;
  }
}

const backtestPkg = optionalRequire<AnyRecord>('@barfinex/backtest-engine');
const indicatorsPkg = optionalRequire<AnyRecord>('@barfinex/indicators');

export class DeterministicBacktestEngine {
  private readonly impl: any;

  constructor() {
    const Impl = backtestPkg?.DeterministicBacktestEngine as any;
    this.impl = Impl ? new Impl() : null;
  }

  run(params: AnyRecord): AnyRecord {
    if (this.impl?.run) {
      return this.impl.run(params);
    }
    return {
      stats: { trades: 0, pnl: 0 },
      equityCurve: [],
      diagnostics: { fallback: true },
    };
  }
}

export class IndicatorsService {
  private readonly impl: any;

  constructor() {
    const Impl = indicatorsPkg?.IndicatorsService as any;
    this.impl = Impl ? new Impl() : null;
  }

  createIndicatorGroup(configs: AnyRecord[], onError?: (config: AnyRecord, error: unknown) => void): AnyRecord {
    if (this.impl?.createIndicatorGroup) {
      return this.impl.createIndicatorGroup(configs, onError);
    }
    return {};
  }

  warmupGroup(group: AnyRecord | undefined, candles: AnyRecord[] | undefined): void {
    if (this.impl?.warmupGroup) {
      this.impl.warmupGroup(group, candles);
    }
  }

  runGroup(group: AnyRecord | undefined, method: string, candle: AnyRecord, side?: unknown): void {
    if (this.impl?.runGroup) {
      this.impl.runGroup(group, method, candle, side);
    }
  }

  getIndicatorNumber(group: AnyRecord | undefined, key: string, preferredKey?: string): number | undefined {
    if (this.impl?.getIndicatorNumber) {
      return this.impl.getIndicatorNumber(group, key, preferredKey);
    }
    return undefined;
  }
}
