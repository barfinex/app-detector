import { Injectable } from '@nestjs/common';
import { IndicatorsService, BfxIndicatorGroup } from '../../../../../../libs/indicators/src';
import { Candle } from '@barfinex/types';
import { FollowTrendIndicatorMapping } from '../follow-trend.config';
import { EngineeredFeatureSet, FeatureComputationContext } from './feature.types';
import { rollingAverageRangePct, rollingMean, rollingStd } from './feature.transforms';

const Z_SCORE_PERIOD = 20;
const ATR_FALLBACK_PERIOD = 14;

@Injectable()
export class FeatureBuilder {
  constructor(private readonly indicatorsService: IndicatorsService) {}

  buildTrendFeatures(
    ctx: FeatureComputationContext,
    mapping: FollowTrendIndicatorMapping,
  ): EngineeredFeatureSet | null {
    const group = ctx.indicatorsGroup as BfxIndicatorGroup | undefined;
    if (!group) return null;

    const smaFast = this.indicatorsService.getIndicatorNumber(group, mapping.smaFastKey);
    const smaMid = this.indicatorsService.getIndicatorNumber(group, mapping.smaMidKey);
    const smaSlow = this.indicatorsService.getIndicatorNumber(group, mapping.smaSlowKey);
    const rsi = this.indicatorsService.getIndicatorNumber(group, mapping.rsiKey);
    const adx = this.indicatorsService.getIndicatorNumber(group, mapping.adxKey, mapping.adxValueKey);
    const macdHistogram = this.indicatorsService.getIndicatorNumber(
      group,
      mapping.macdKey,
      mapping.macdValueKey,
    );

    if (
      typeof smaFast !== 'number' ||
      typeof smaMid !== 'number' ||
      typeof smaSlow !== 'number' ||
      typeof rsi !== 'number' ||
      typeof adx !== 'number' ||
      typeof macdHistogram !== 'number'
    ) {
      return null;
    }

    const generic = this.buildGenericFeatures(ctx);
    const maSpread = generic.price > 0 ? (smaFast - smaSlow) / generic.price : 0;
    const atrFromIndicator = this.resolveAtrPctFromIndicators(group, generic.price, mapping);

    return {
      ...generic,
      values: {
        ...generic.values,
        smaFast,
        smaMid,
        smaSlow,
        rsi,
        adx,
        macdHistogram,
        maSpread,
        atrPct: atrFromIndicator ?? generic.values.atrPct,
      },
    };
  }

  buildGenericFeatures(ctx: FeatureComputationContext): EngineeredFeatureSet {
    const candlesAsc = [...(ctx.candles ?? [])]
      .filter((candle) =>
        Number.isFinite(candle?.close) &&
        Number.isFinite(candle?.high) &&
        Number.isFinite(candle?.low) &&
        Number.isFinite(candle?.time),
      )
      .sort((a, b) => a.time - b.time);

    const lastCandle = candlesAsc[candlesAsc.length - 1];
    const prevCandle = candlesAsc[candlesAsc.length - 2];
    const resolvedPrice = ctx.price > 0 ? ctx.price : lastCandle?.close ?? 0;

    const returnPct =
      lastCandle && prevCandle && prevCandle.close > 0
        ? (lastCandle.close - prevCandle.close) / prevCandle.close
        : 0;
    const logReturn =
      lastCandle && prevCandle && lastCandle.close > 0 && prevCandle.close > 0
        ? Math.log(lastCandle.close / prevCandle.close)
        : 0;

    const rangePct =
      lastCandle && resolvedPrice > 0
        ? (lastCandle.high - lastCandle.low) / resolvedPrice
        : 0;

    const closes = candlesAsc.map((candle) => candle.close);
    const mean = rollingMean(closes, Z_SCORE_PERIOD);
    const std = rollingStd(closes, Z_SCORE_PERIOD);
    const zScore =
      Number.isFinite(mean) && Number.isFinite(std) && std! > 0
        ? (resolvedPrice - mean!) / std!
        : 0;

    const atrPctFallback =
      rollingAverageRangePct(candlesAsc, ATR_FALLBACK_PERIOD, resolvedPrice) ??
      rangePct;

    return {
      interval: ctx.interval,
      price: resolvedPrice,
      values: {
        rangePct,
        atrPct: atrPctFallback,
        returnPct,
        logReturn,
        zScore,
      },
      meta: {
        lookback: candlesAsc.length,
        timestamp: lastCandle?.time,
      },
    };
  }

  private resolveAtrPctFromIndicators(
    group: BfxIndicatorGroup,
    price: number,
    mapping: FollowTrendIndicatorMapping,
  ): number | undefined {
    if (price <= 0) return undefined;

    if (mapping.atrKey) {
      const atr = this.indicatorsService.getIndicatorNumber(group, mapping.atrKey, mapping.atrValueKey);
      if (typeof atr === 'number' && Number.isFinite(atr)) return atr / price;
    }

    const fallbackKey = Object.keys(group).find((key) => key.toLowerCase().includes('atr'));
    if (!fallbackKey) return undefined;

    const atr = this.indicatorsService.getIndicatorNumber(group, fallbackKey);
    if (typeof atr === 'number' && Number.isFinite(atr)) return atr / price;

    return undefined;
  }
}
