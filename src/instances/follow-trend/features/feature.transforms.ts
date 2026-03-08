import { Candle } from '@barfinex/types';
import { EngineeredFeatureSet } from './feature.types';

export function rollingMean(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(values.length - period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function rollingStd(values: number[], period: number): number | null {
  const mean = rollingMean(values, period);
  if (!Number.isFinite(mean)) return null;

  const window = values.slice(values.length - period);
  const variance =
    window.reduce((sum, value) => sum + (value - mean!) ** 2, 0) / period;
  return Math.sqrt(variance);
}

export function rollingAverageRangePct(
  candlesAsc: Candle[],
  period: number,
  price: number,
): number | null {
  if (period <= 0 || candlesAsc.length < period || price <= 0) return null;
  const window = candlesAsc.slice(candlesAsc.length - period);
  const avgRange =
    window.reduce((sum, candle) => sum + (candle.high - candle.low), 0) / period;
  return avgRange / price;
}

function trendDirection(featureSet: EngineeredFeatureSet): -1 | 0 | 1 {
  const { price } = featureSet;
  const smaFast = featureSet.values.smaFast;
  const smaMid = featureSet.values.smaMid;
  const smaSlow = featureSet.values.smaSlow;

  if (
    Number.isFinite(price) &&
    Number.isFinite(smaFast) &&
    Number.isFinite(smaMid) &&
    Number.isFinite(smaSlow)
  ) {
    const bullish =
      price > smaFast && smaFast > smaMid && smaMid > smaSlow;
    const bearish =
      price < smaFast && smaFast < smaMid && smaMid < smaSlow;
    if (bullish) return 1;
    if (bearish) return -1;
  }

  return 0;
}

export function alignHigherTimeframeTrend(
  lowerTF: EngineeredFeatureSet,
  higherTF: EngineeredFeatureSet,
): number {
  const lowerDirection = trendDirection(lowerTF);
  const higherDirection = trendDirection(higherTF);

  if (lowerDirection !== 0 && lowerDirection === higherDirection) return 1;
  if (lowerDirection !== 0 && higherDirection !== 0 && lowerDirection !== higherDirection) return -1;
  return 0;
}
