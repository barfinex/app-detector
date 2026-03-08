import { Injectable } from '@nestjs/common';
import { Detector, PluginMeta, SubscriptionType, Symbol, TimeFrame } from '@barfinex/types';
import {
  DEFAULT_TREND_PROFILE,
  MLHookPolicy,
  TrendSignalProfile,
  DEFAULT_RISK_PROFILE,
  RiskProfile,
} from './enterprise.engines';

import { TradeJournalModule } from '@barfinex/plugins/trade-journal/src';

export const pluginMetas: PluginMeta[] = [
  {
    studioGuid: 'trade-journal-dev',
    title: 'Trade Journal',
    description: 'Журнал сделок для ручного и автоматического логирования',
    version: '0.1.0',
    author: 'Barfinex',
    visibility: 'public',
    pluginApi: '/plugins-api/trade-journal-dev',
  },
];

export const pluginModules = [
  TradeJournalModule,
];

/** Ключи должны совпадать с key в detector.indicators. */
export interface FollowTrendIndicatorMapping {
  smaFastKey: string;
  smaMidKey: string;
  smaSlowKey: string;
  rsiKey: string;
  adxKey: string;
  adxValueKey: string;
  macdKey: string;
  macdValueKey: string;
  atrKey?: string;
  atrValueKey?: string;
}

export interface FollowTrendCustomConfig {
  // legacyReadOnly: boolean;
  authorityMode?: 'rule-first' | 'ai-dominant' | 'ai-autonomous';
  signalProfile?: TrendSignalProfile;
  riskProfile?: RiskProfile;
  mlHook?: MLHookPolicy & {
    enabled?: boolean;
    advisorTimeoutMs?: number;
    maxInFlight?: number;
  };
  portfolio?: {
    enabled?: boolean;
    targetVolatility: number;
    maxLookbackBars?: number;
    correlationSoftCap?: number;
    minTradeNotional?: number;
    minScaleFactor?: number;
  };
  globalAllocator?: {
    enabled?: boolean;
    maxTotalExposurePct?: number;
    maxExposurePerSymbolPct?: number;
    riskBudgetPct?: number;
    breachAction?: 'scale' | 'deny';
    reservationTtlMs?: number;
    idempotencyTtlMs?: number;
  };
  intentRateLimit?: {
    maxIntents?: number;
    windowSec?: number;
  };
  telemetry?: {
    sampleNeutralSignals?: boolean;
  };
  guardrails?: {
    timeoutDominance?: {
      enabled?: boolean;
      maxConsecutiveTimeouts?: number;
      cooldownMs?: number;
    };
    lossStreak?: {
      enabled?: boolean;
      maxConsecutiveLosses?: number;
      cooldownMs?: number;
    };
    volatilityShock?: {
      enabled?: boolean;
      atrPctThreshold?: number;
      confidenceMultiplier?: number;
    };
    conflictExplosion?: {
      enabled?: boolean;
      maxConsecutiveConflicts?: number;
      confidenceMultiplier?: number;
    };
  };
  indicatorMapping?: FollowTrendIndicatorMapping;
}

export const DEFAULT_INDICATOR_MAPPING: FollowTrendIndicatorMapping = {
  smaFastKey: 'sma7',
  smaMidKey: 'sma25',
  smaSlowKey: 'sma99',
  rsiKey: 'rsi14',
  adxKey: 'adx14',
  adxValueKey: 'adx',
  macdKey: 'macd',
  macdValueKey: 'histogram',
};


@Injectable()
export class FollowTrendConfigService {
  private symbols: Symbol[] = [
    { name: 'BTCUSDT', leverage: 10, quantity: 0.001 },
    { name: 'ETHUSDT', leverage: 10, quantity: 0.001 },
  ];

  private quoteCurrency = 'USDT';

  get detector(): Detector {
    return {
      key: null,
      sysname: 'FollowTrendDetector',
      logLevel: 'info',
      currency: this.quoteCurrency,

      restApiUrl: '',
      providers: [
        {
          restApiUrl: 'http://localhost:8081/api',
          key: '7a366b3b3bdb9fa6cf0a8aa0ac611e6550706831c54294c0dbb4027b250c0608',
          apiToken: 'xxx',
          accounts: []
        },
      ],

      symbols: this.symbols,
      orders: [],
      intervals: [TimeFrame.min1, TimeFrame.min5, TimeFrame.h1],

      // key — под каким именем индикатор доступен в стратегии (indicatorMapping ссылается на эти ключи)
      indicators: [
        { key: 'sma7', name: 'SMA', parameters: { period: 7, source: 'close' }, visual: { group: 'SMA', paneSysName: 'candle_pane' } },
        { key: 'sma25', name: 'SMA', parameters: { period: 25, source: 'close' }, visual: { group: 'SMA', paneSysName: 'candle_pane' } },
        { key: 'sma99', name: 'SMA', parameters: { period: 99, source: 'close' }, visual: { group: 'SMA', paneSysName: 'candle_pane' } },
        { key: 'rsi14', name: 'RSI', parameters: { period: 14, source: 'close' }, visual: { group: 'Momentum', paneSysName: 'rsi_pane' } },
        { key: 'adx14', name: 'ADX', parameters: { period: 14, source: 'close' }, visual: { group: 'TrendStrength', paneSysName: 'adx_pane' } },
        {
          key: 'macd',
          name: 'MACD',
          parameters: { period: 26, source: 'close', fast: 12, slow: 26, signal: 9 } as any,
          visual: { group: 'Momentum', paneSysName: 'macd_pane' },
        },
        { key: 'extremums', name: 'Extremums', parameters: { period: 14, source: { peak: 'high', trough: 'low' } }, visual: { paneSysName: 'volume_pane' } },
      ],

      subscriptions: [
        {
          type: SubscriptionType.PROVIDER_ACCOUNT_EVENT,
          active: true,
        },
        {
          type: SubscriptionType.PROVIDER_MARKETDATA_TRADE,
          symbols: this.symbols,
          active: false,
        },
        {
          type: SubscriptionType.PROVIDER_SYMBOLS,
          active: false,
        },
        {
          type: SubscriptionType.PROVIDER_SYMBOL_PRICES,
          active: false,
        },
        {
          type: SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK,
          symbols: this.symbols,
          active: false,
        },
        {
          type: SubscriptionType.INSPECTOR_RISK_LIMIT_BREACH,
          active: false,
        },
        {
          type: SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
          symbols: this.symbols,
          active: true,
        },
      ],

      useSandbox: false,
      useScratch: false,
      isBlocked: false,
      isActive: true,

      useNotifications: {
        telegram: {
          token: process.env.TELEGRAM_BOT_TOKEN ?? '',
          chatId: process.env.TELEGRAM_CHAT_ID ?? '',
          messageFormat: 'Alert: {event} triggered. Threshold: {value}',
          isActive: false,
        },
      },

      advisor: undefined,
      qualityGate: {
        enabled: false,
      },
      performance: {
        enabled: true,
        writeToQuestDb: true,
      },
      customConfig: {
        // legacyReadOnly: false,
        authorityMode: 'rule-first',
        signalProfile: DEFAULT_TREND_PROFILE,
        riskProfile: {
          ...DEFAULT_RISK_PROFILE,
          riskPctFloor: 0.0025,
          riskPctCeil: 0.015,
          confidenceCurve: [
            { minConfidence: 0, maxConfidence: 0.6, riskPct: 0.004 },
            { minConfidence: 0.6, maxConfidence: 0.8, riskPct: 0.008 },
            { minConfidence: 0.8, maxConfidence: 1, riskPct: 0.012 },
          ],
          regimeMultipliers: {
            trending: 1.1,
            ranging: 0.75,
            volatile: 0.8,
            lowvolatility: 1.05,
            unknown: 0.65,
          },
        },
        mlHook: {
          mode: 'assist',
          timeoutMs: 600,
          minMLConfidence: 0.6,
          maxAssistDelta: 0.2,
          enabled: true,
          advisorTimeoutMs: 800,
          maxInFlight: 8,
        },
        portfolio: {
          enabled: true,
          targetVolatility: 0.02,
          maxLookbackBars: 200,
          correlationSoftCap: 0.6,
          minTradeNotional: 25,
          minScaleFactor: 0.05,
        },
        globalAllocator: {
          enabled: false,
          maxTotalExposurePct: 60,
          maxExposurePerSymbolPct: 25,
          riskBudgetPct: undefined,
          breachAction: 'scale',
          reservationTtlMs: 30_000,
          idempotencyTtlMs: 120_000,
        },
        intentRateLimit: {
          maxIntents: 6,
          windowSec: 30,
        },
        telemetry: {
          sampleNeutralSignals: true,
        },
        guardrails: {
          timeoutDominance: {
            enabled: true,
            maxConsecutiveTimeouts: 3,
            cooldownMs: 3 * 60_000,
          },
          lossStreak: {
            enabled: true,
            maxConsecutiveLosses: 4,
            cooldownMs: 10 * 60_000,
          },
          volatilityShock: {
            enabled: true,
            atrPctThreshold: 0.04,
            confidenceMultiplier: 0.5,
          },
          conflictExplosion: {
            enabled: true,
            maxConsecutiveConflicts: 4,
            confidenceMultiplier: 0.4,
          },
        },
        indicatorMapping: DEFAULT_INDICATOR_MAPPING,
      } as FollowTrendCustomConfig,

      plugins: {
        modules: pluginModules,
        metas: pluginMetas
      }
    };
  }
}

// export const FollowTrendOptionsProvider: Provider = {
//   provide: 'INITIAL_OPTIONS',
//   useFactory: (configService: FollowTrendConfigService): Detector => {
//     return configService.detector;
//   },
//   inject: [FollowTrendConfigService],
// };
