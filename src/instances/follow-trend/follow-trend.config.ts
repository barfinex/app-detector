import { Injectable, Provider } from '@nestjs/common';
import { Detector, PluginMeta, SubscriptionType, Symbol, TimeFrame } from '@barfinex/types';

import { TradeJournalModule } from '@barfinex/plugins/trade-journal';

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
          restApiToken: 'xxx',
          accounts: []
        },
      ],

      symbols: this.symbols,
      orders: [],
      intervals: [TimeFrame.min1, TimeFrame.min5, TimeFrame.h1],

      indicators: [
        {
          name: 'SMA',
          parameters: { period: 14, source: 'close' },
          visual: { group: 'SMA-custom', paneSysName: 'candle_pane' },
        },
        {
          name: 'EMA',
          parameters: { period: 21, source: 'close' },
          visual: { group: 'SMA-custom', paneSysName: 'candle_pane' },
        },
        {
          name: 'Extremums',
          parameters: { period: 14, source: { peak: 'high', trough: 'low' } },
          visual: { paneSysName: 'volume_pane' },
        },
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
          type: SubscriptionType.INSPECTOR_EVENT,
          active: false,
        },
        {
          type: SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
          symbols: this.symbols,
          active: false,
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
