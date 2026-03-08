import { Candle, ConnectorType, MarketType, SubscriptionType, SubscriptionValue, TimeFrame } from '@barfinex/types';
import { createClient, type RedisClientType } from 'redis';

interface SmokeOptions {
  redisHost: string;
  redisPort: number;
  detectorApiBaseUrl: string;
  connectorType: ConnectorType;
  marketType: MarketType;
  interval: TimeFrame;
  candlesPerSymbol: number;
}

const CANDLE_EVENT_PATTERN: SubscriptionType.PROVIDER_MARKETDATA_CANDLE =
  SubscriptionType.PROVIDER_MARKETDATA_CANDLE;

interface SmokeCandleRaw {
  closeTime: number;
  correlationId: string;
}

interface DetectorInstanceCounters {
  processedCandles?: number;
  processedTrades?: number;
}

interface DetectorInstanceSnapshot {
  sysName: string;
  lifecycleState: string;
  isActive: boolean;
  route?: {
    connectorType?: ConnectorType;
    marketType?: MarketType;
    symbols?: string[];
  };
  routeSummary?: string;
  counters?: DetectorInstanceCounters;
}

interface DetectorInstancesResponse {
  success: boolean;
  data?: DetectorInstanceSnapshot[];
}

function parseEnumValue<T extends Record<string, string>>(
  enumType: T,
  raw: string | undefined,
  fallback: T[keyof T],
): T[keyof T] {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  const values = Object.values(enumType);
  const matched = values.find((value) => String(value).toLowerCase() === normalized);
  return matched ?? fallback;
}

function readOptions(): SmokeOptions {
  const candlesPerSymbolRaw = Number(process.env.SMOKE_CANDLES_PER_SYMBOL ?? 12);
  return {
    redisHost: process.env.REDIS_HOST ?? 'localhost',
    redisPort: Number(process.env.REDIS_PORT ?? 6379),
    detectorApiBaseUrl: (process.env.DETECTOR_API_BASE_URL ?? 'http://localhost:8101').replace(/\/+$/, ''),
    connectorType: parseEnumValue(
      ConnectorType,
      process.env.SMOKE_CONNECTOR_TYPE,
      ConnectorType.binance,
    ),
    marketType: parseEnumValue(
      MarketType,
      process.env.SMOKE_MARKET_TYPE,
      MarketType.futures,
    ),
    interval: parseEnumValue(TimeFrame, process.env.SMOKE_INTERVAL, TimeFrame.min1),
    candlesPerSymbol: Math.max(10, Math.min(20, Math.floor(candlesPerSymbolRaw))),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildCandleSeries(symbolName: string, interval: TimeFrame, count: number): Candle[] {
  const oneMinuteMs = 60_000;
  const intervalMs = interval === TimeFrame.min5 ? 5 * oneMinuteMs : oneMinuteMs;
  const startCloseTime = Date.now() - count * intervalMs;
  const basePrice = symbolName === 'BTCUSDT' ? 62_000 : 3_200;
  const candles: Candle[] = [];

  for (let index = 0; index < count; index += 1) {
    const closeTime = startCloseTime + (index + 1) * intervalMs;
    const drift = index * (symbolName === 'BTCUSDT' ? 12 : 1.5);
    const wave = Math.sin(index / 2) * (symbolName === 'BTCUSDT' ? 35 : 8);
    const close = Math.max(1, basePrice + drift + wave);
    const open = index === 0 ? close * 0.998 : candles[index - 1].close;
    const spread = Math.max(0.5, Math.abs(Math.cos(index / 3)) * (symbolName === 'BTCUSDT' ? 18 : 4));
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread;
    const volume = symbolName === 'BTCUSDT' ? 120 + index * 1.5 : 240 + index * 2.1;

    candles.push({
      open,
      close,
      high,
      low,
      volume,
      time: closeTime,
      interval,
      symbol: { name: symbolName },
      raw: { closeTime } satisfies SmokeCandleRaw,
    });
  }

  return candles;
}

function buildCorrelationId(sysName: string, candle: Candle, sequence: number): string {
  const closeTime = Number(
    ((candle.raw as { closeTime?: number } | undefined)?.closeTime ?? candle.time ?? 0),
  );
  return `${sysName}:${candle.symbol.name}:${candle.interval}:${closeTime}:${sequence}`;
}

function buildDetectorInstancesUrl(detectorApiBaseUrl: string): string {
  const trimmedBaseUrl = detectorApiBaseUrl.replace(/\/+$/, '');
  if (trimmedBaseUrl.endsWith('/api')) {
    return `${trimmedBaseUrl}/detector/instances`;
  }
  return `${trimmedBaseUrl}/api/detector/instances`;
}

function emitCandleEvent(
  client: RedisClientType,
  connectorType: ConnectorType,
  marketType: MarketType,
  candle: Candle,
): void {
  const payload: SubscriptionValue = {
    value: candle,
    options: {
      connectorType,
      marketType,
      updateMoment: candle.time,
    },
  };
  void client.publish(CANDLE_EVENT_PATTERN, JSON.stringify(payload));
}

async function fetchDetectorInstances(detectorApiBaseUrl: string): Promise<DetectorInstancesResponse> {
  const url = buildDetectorInstancesUrl(detectorApiBaseUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`/detector/instances unavailable: HTTP ${response.status}`);
  }
  return (await response.json()) as DetectorInstancesResponse;
}

function printInstanceSummary(instances: DetectorInstanceSnapshot[]): void {
  console.log('[smoke] detector instances snapshot:');
  for (const instance of instances) {
    const processedCandles = instance.counters?.processedCandles ?? 0;
    const processedTrades = instance.counters?.processedTrades ?? 0;
    const routeSummary = instance.routeSummary ?? 'default';
    console.log(
      `[smoke] instance=${instance.sysName} state=${instance.lifecycleState} active=${instance.isActive} route=${routeSummary} candles=${processedCandles} trades=${processedTrades}`,
    );
  }
}

function assertDelivery(
  instances: DetectorInstanceSnapshot[],
  expectedEvents: number,
  expectedSymbols: string[],
): void {
  const totalProcessedCandles = instances.reduce((acc, instance) => {
    return acc + (instance.counters?.processedCandles ?? 0);
  }, 0);
  if (totalProcessedCandles < 1) {
    throw new Error(
      `delivery assertion failed: processedCandles=${totalProcessedCandles}, expected at least 1 routed candle from ${expectedEvents} emitted`,
    );
  }
  const hasReadyInstance = instances.some((instance) => instance.lifecycleState === 'READY');
  if (!hasReadyInstance) {
    throw new Error('delivery assertion failed: no READY detector instances in /detector/instances');
  }
  assertMultiRouting(instances, expectedSymbols);
  console.log(
    `[smoke] delivery assertion passed: totalProcessedCandles=${totalProcessedCandles}, emitted=${expectedEvents}`,
  );
}

function assertMultiRouting(instances: DetectorInstanceSnapshot[], expectedSymbols: string[]): void {
  for (const symbol of expectedSymbols) {
    const routedInstances = instances.filter((instance) => {
      const routeSymbols = instance.route?.symbols ?? [];
      return routeSymbols.some((value) => value.toUpperCase() === symbol.toUpperCase());
    });
    if (routedInstances.length === 0) {
      continue;
    }
    const routedProcessed = routedInstances.reduce((acc, instance) => {
      return acc + (instance.counters?.processedCandles ?? 0);
    }, 0);
    if (routedProcessed < 1) {
      const names = routedInstances.map((instance) => instance.sysName).join(', ');
      throw new Error(
        `multi-routing assertion failed: symbol=${symbol} routedInstances=[${names}] have processedCandles=0`,
      );
    }
  }
}

async function waitForDeliveryAndAssert(
  detectorApiBaseUrl: string,
  expectedEvents: number,
  expectedSymbols: string[],
): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const body = await fetchDetectorInstances(detectorApiBaseUrl);
      const instances = Array.isArray(body.data) ? body.data : [];
      printInstanceSummary(instances);
      assertDelivery(instances, expectedEvents, expectedSymbols);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[smoke] delivery check attempt ${attempt}/${maxAttempts}: ${message}`);
      if (attempt === maxAttempts) throw error;
      await sleep(500);
    }
  }
}

async function main(): Promise<void> {
  const options = readOptions();
  const symbols = ['BTCUSDT', 'ETHUSDT'];
  const client = createClient({
    url: `redis://${options.redisHost}:${options.redisPort}`,
    socket: {
      reconnectStrategy: (retries) => Math.min(10_000, 250 * Math.pow(2, Math.min(retries, 8))),
    },
  });

  // WHY: Этот smoke test проверяет multi routing, ML timeout fallback, portfolio scaling
  // и отсутствие cross-instance гонок на реальном event transport без bootstrap Nest app.
  await client.connect();
  console.log(
    `[smoke] connected to redis ${options.redisHost}:${options.redisPort}, route=${options.connectorType}/${options.marketType}, interval=${options.interval}`,
  );

  let sequence = 0;
  let emittedCandles = 0;
  for (const symbol of symbols) {
    const series = buildCandleSeries(symbol, options.interval, options.candlesPerSymbol);
    for (const candle of series) {
      const correlationId = buildCorrelationId('smoke-replay', candle, sequence++);
      const raw = candle.raw as SmokeCandleRaw | undefined;
      candle.raw = {
        closeTime: raw?.closeTime ?? candle.time,
        correlationId,
      } satisfies SmokeCandleRaw;
      emitCandleEvent(client, options.connectorType, options.marketType, candle);
      emittedCandles += 1;
      console.log(
        `[smoke] emitted ${symbol} closeTime=${candle.time} correlationId=${correlationId}`,
      );
      await sleep(35);
    }
  }

  await sleep(800);
  await waitForDeliveryAndAssert(options.detectorApiBaseUrl, emittedCandles, symbols);

  await client.quit();
  console.log('[smoke] completed');
}

main().catch((error: unknown) => {
  console.error(
    `[smoke] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
