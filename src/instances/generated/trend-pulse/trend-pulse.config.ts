export class TrendPulseConfigService {
  public readonly detector = {
    schemaVersion: '1.0.0',
    strategyName: 'Trend Pulse',
    description: 'Simple trend-following detector from engineered features.',
    timeframe: 'min5',
    subscriptions: ['CANDLE_CLOSE'],
    features: ['smaFast', 'smaSlow', 'rsi', 'atrPct'],
    aiPolicy: 'assist',
    risk: {
      maxPositions: 1,
      cooldownCandles: 3,
    },
    exit: {
      stopLossATR: 1.8,
      takeProfitATR: 2.4,
      maxHoldCandles: 24,
    },
    sysname: 'trend-pulse',
  } as const;
}
