import { Candle, TimeFrame } from '@barfinex/types';
import { SignalFeatureSet } from '../enterprise.engines';

export interface FeatureComputationContext {
  symbol: string;
  interval: TimeFrame;
  price: number;
  candles: Candle[];
  indicatorsGroup: unknown;
}

export interface EngineeredFeatureSet extends SignalFeatureSet {
  values: Record<string, number>;
  meta?: {
    lookback: number;
    timestamp?: number;
  };
}
