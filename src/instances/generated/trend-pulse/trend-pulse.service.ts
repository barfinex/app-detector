import { DetectorService } from '@barfinex/detector';

export class TrendPulseService extends DetectorService {
  private readonly strategyId = "trend-pulse";
  private readonly maxPositions = 1;
  private readonly cooldownCandles = 3;
  private readonly maxHoldCandles = 24;
  private readonly stopLossAtr = 1.8;
  private readonly takeProfitAtr = 2.4;
  private readonly aiPolicy = "assist";

  private candleIndex = 0;
  private lastEntryCandleIndex = -1;

  protected onCandleClose(candle: unknown): void {
    this.candleIndex += 1;

    const candleRecord = (candle ?? {}) as Record<string, unknown>;
    const price = this.safeNumber(candleRecord['close']);
    if (price <= 0) return;

    if (this.cooldownCandles > 0 && this.lastEntryCandleIndex >= 0) {
      const candlesSinceLastEntry = this.candleIndex - this.lastEntryCandleIndex;
      if (candlesSinceLastEntry <= this.cooldownCandles) return;
    }

    if (this.getOpenOrdersCount() >= this.maxPositions) return;

    const featureValues = this.computeFeatureValues(candleRecord, price);

    const longSignal = (((featureValues["smaFast"] ?? 0) > 0) && ((featureValues["rsi"] ?? 0) >= 55));
    const shortSignal = ((featureValues["rsi"] ?? 0) <= 45);

    if (longSignal) {
      this.lastEntryCandleIndex = this.candleIndex;
      this.registerEvent('ENTRY_SIGNAL' as any, {
        symbols: candleRecord['symbol'] ? [candleRecord['symbol']] : [],
        side: 'LONG',
        confidence: 1,
        strategyId: this.strategyId,
        meta: this.buildMeta(),
      });
      return;
    }

    if (shortSignal) {
      this.lastEntryCandleIndex = this.candleIndex;
      this.registerEvent('ENTRY_SIGNAL' as any, {
        symbols: candleRecord['symbol'] ? [candleRecord['symbol']] : [],
        side: 'SHORT',
        confidence: 1,
        strategyId: this.strategyId,
        meta: this.buildMeta(),
      });
    }
  }

  private computeFeatureValues(candle: Record<string, unknown>, price: number): Record<string, number> {
    const raw = candle['raw'];
    const rawFeatures = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['features'] : undefined;
    const values: Record<string, number> = { price };
    values["smaFast"] = this.safeNumber((rawFeatures as Record<string, unknown>)["smaFast"] ?? (candle as Record<string, unknown>)["smaFast"]);
    values["smaSlow"] = this.safeNumber((rawFeatures as Record<string, unknown>)["smaSlow"] ?? (candle as Record<string, unknown>)["smaSlow"]);
    values["rsi"] = this.safeNumber((rawFeatures as Record<string, unknown>)["rsi"] ?? (candle as Record<string, unknown>)["rsi"]);
    values["atrPct"] = this.safeNumber((rawFeatures as Record<string, unknown>)["atrPct"] ?? (candle as Record<string, unknown>)["atrPct"]);
    return values;
  }

  private getOpenOrdersCount(): number {
    const runtimeOrders = (this as { orders?: unknown }).orders;
    return Array.isArray(runtimeOrders) ? runtimeOrders.length : 0;
  }

  private buildMeta(): Record<string, unknown> {
    return {
      aiPolicy: this.aiPolicy,
      risk: {
        maxPositions: this.maxPositions,
        cooldownCandles: this.cooldownCandles,
      },
      exit: {
        maxHoldCandles: this.maxHoldCandles,
        stopLossATR: this.stopLossAtr,
        takeProfitATR: this.takeProfitAtr,
      },
    };
  }

  private safeNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
}
