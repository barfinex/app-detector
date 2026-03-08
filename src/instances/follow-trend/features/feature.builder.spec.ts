import { Candle, Symbol, TimeFrame } from '@barfinex/types';
import { IndicatorsService } from '../../../../../../libs/indicators/src';
import { FeatureBuilder } from './feature.builder';
import { FollowTrendIndicatorMapping } from '../follow-trend.config';

const SYMBOL: Symbol = { name: 'BTCUSDT', quantity: 0.001, leverage: 1 };

const MAPPING: FollowTrendIndicatorMapping = {
  smaFastKey: 'smaFast',
  smaMidKey: 'smaMid',
  smaSlowKey: 'smaSlow',
  rsiKey: 'rsi',
  adxKey: 'adx',
  adxValueKey: 'adx',
  macdKey: 'macd',
  macdValueKey: 'histogram',
};

function candle(time: number, close: number, high = close + 1, low = close - 1): Candle {
  return {
    open: close,
    close,
    high,
    low,
    volume: 1,
    time,
    interval: TimeFrame.min1,
    symbol: SYMBOL,
  };
}

describe('FeatureBuilder', () => {
  it('calculates maSpread correctly', () => {
    const indicators = {
      smaFast: { lastValue: 110 },
      smaMid: { lastValue: 105 },
      smaSlow: { lastValue: 100 },
      rsi: { lastValue: 55 },
      adx: { lastValue: { adx: 26 } },
      macd: { lastValue: { histogram: 1.25 } },
    };

    const builder = new FeatureBuilder(new IndicatorsService());
    const featureSet = builder.buildTrendFeatures(
      {
        symbol: 'BTCUSDT',
        interval: TimeFrame.min1,
        price: 100,
        candles: [candle(1, 99), candle(2, 100)],
        indicatorsGroup: indicators,
      },
      MAPPING,
    );

    expect(featureSet).not.toBeNull();
    expect(featureSet!.values.maSpread).toBeCloseTo(0.1, 8);
  });

  it('calculates returnPct and logReturn from last two closes', () => {
    const builder = new FeatureBuilder(new IndicatorsService());
    const generic = builder.buildGenericFeatures({
      symbol: 'BTCUSDT',
      interval: TimeFrame.min1,
      price: 102,
      candles: [candle(1, 100), candle(2, 102)],
      indicatorsGroup: {},
    });

    expect(generic.values.returnPct).toBeCloseTo(0.02, 8);
    expect(generic.values.logReturn).toBeCloseTo(Math.log(1.02), 8);
  });

  it('calculates zScore on known series', () => {
    const builder = new FeatureBuilder(new IndicatorsService());
    const candles: Candle[] = [];
    for (let index = 1; index <= 21; index += 1) {
      candles.push(candle(index, index));
    }

    const generic = builder.buildGenericFeatures({
      symbol: 'BTCUSDT',
      interval: TimeFrame.min1,
      price: 21,
      candles,
      indicatorsGroup: {},
    });

    expect(generic.values.zScore).toBeCloseTo(1.6475089, 6);
  });

  it('calculates rangePct from latest candle', () => {
    const builder = new FeatureBuilder(new IndicatorsService());
    const generic = builder.buildGenericFeatures({
      symbol: 'BTCUSDT',
      interval: TimeFrame.min1,
      price: 100,
      candles: [candle(1, 100, 104, 96), candle(2, 101, 105, 95)],
      indicatorsGroup: {},
    });

    expect(generic.values.rangePct).toBeCloseTo(0.1, 8);
  });

  it('returns null for trend features when required indicators are missing', () => {
    const builder = new FeatureBuilder(new IndicatorsService());
    const featureSet = builder.buildTrendFeatures(
      {
        symbol: 'BTCUSDT',
        interval: TimeFrame.min1,
        price: 100,
        candles: [candle(1, 100), candle(2, 101)],
        indicatorsGroup: {
          smaFast: { lastValue: 101 },
          smaMid: { lastValue: 100 },
        },
      },
      MAPPING,
    );

    expect(featureSet).toBeNull();
  });
});
