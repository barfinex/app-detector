import { Injectable, Provider } from '@nestjs/common';
import {
  ConnectorType,
  DetectorConfigInput,
  Detector as DetectorOptions,
  MarketType,
  Provider as MarketProvider,
  Symbol as TradingSymbol,
  TimeFrame,
} from '@barfinex/types';

export interface AdvisorLlmHybridCustomConfig {
  symbol: string;
  decisionCooldownMs: number;
  minConfidenceToEnter: number;
  minConfidenceToHold: number;
  maxSpreadPercent: number;
  fallbackTakeProfitPercent: number;
  fallbackStopLossPercent: number;
  fallbackMaxHoldMs: number;
}

@Injectable()
export class AdvisorLlmHybridConfigService {
  private readonly symbols: TradingSymbol[] = [
    { name: 'BTCUSDT', leverage: 5, quantity: 0.001 },
  ];

  get detector(): DetectorConfigInput {
    const provider: MarketProvider = {
      key: 'advisor-llm-hybrid-provider',
      apiToken: 'dev-token',
      restApiUrl: 'http://localhost:8081/api',
      connectors: [
        {
          isActive: true,
          connectorType: ConnectorType.binance,
          markets: [{ marketType: MarketType.futures, symbols: this.symbols }],
        },
      ],
      accounts: [],
      isAvailable: true,
      studioGuid: 'advisor-llm-hybrid-guid',
      studioName: 'Advisor LLM Hybrid Provider',
      studioDescription: 'Hybrid detector delegating market reasoning to advisor LLM',
      studioSocketApiUrl: 'ws://localhost:8081/ws',
    };

    const customConfig: AdvisorLlmHybridCustomConfig = {
      symbol: 'BTCUSDT',
      decisionCooldownMs: 30_000,
      minConfidenceToEnter: 0.62,
      minConfidenceToHold: 0.48,
      maxSpreadPercent: 0.25,
      fallbackTakeProfitPercent: 0.7,
      fallbackStopLossPercent: 0.45,
      fallbackMaxHoldMs: 20 * 60 * 1000,
    };

    return {
      sysname: 'AdvisorLlmHybrid',
      logLevel: 'info',
      preloadHistory: false,
      currency: 'USDT',
      restApiUrl: provider.restApiUrl,
      providers: [provider],
      symbols: this.symbols,
      intervals: [TimeFrame.min1, TimeFrame.min5, TimeFrame.h1],
      subscriptions: [],
      indicators: [],
      orders: [],
      useSandbox: true,
      useScratch: false,
      qualityGate: {
        enabled: true,
        minClosedTrades: 30,
        minWinRate: 0.45,
        minAvgRr: 1,
        maxConsecutiveLosses: 4,
        cooldownMs: 10 * 60 * 1000,
      },
      performance: {
        enabled: true,
        writeToQuestDb: true,
      },
      customConfig,
      plugins: {
        modules: [],
        metas: [],
      },
    };
  }
}

export const DetectorOptionsProvider: Provider = {
  provide: 'DETECTOR_OPTIONS',
  useFactory: async (
    configService: AdvisorLlmHybridConfigService,
  ): Promise<Partial<DetectorOptions>> => {
    return configService.detector as Partial<DetectorOptions>;
  },
  inject: [AdvisorLlmHybridConfigService],
};

