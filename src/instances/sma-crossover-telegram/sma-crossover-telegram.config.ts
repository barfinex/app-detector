import { Injectable } from '@nestjs/common';
import {
    Detector,
    DetectorConfigInput,
    Symbol as TradingSymbol,
    TimeFrame,
    Provider,
    ConnectorType,
    MarketType,
    buildDetectorConfig,
    PluginMeta,
    SubscriptionType,
} from '@barfinex/types';

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

export const pluginModules = [TradeJournalModule];

export interface SmaCrossoverTelegramCustomConfig {
    /** Период короткой SMA */
    shortSmaPeriod: number;
    /** Период длинной SMA */
    longSmaPeriod: number;
}

@Injectable()
export class SmaCrossoverTelegramConfigService {
    private symbols: TradingSymbol[] = [
        { name: 'BTCUSDT', leverage: 10, quantity: 0.001 },
        { name: 'ETHUSDT', leverage: 10, quantity: 0.001 },
    ];

    private quoteCurrency = 'USDT';

    get detector(): DetectorConfigInput {
        const intervals: TimeFrame[] = [TimeFrame.min5, TimeFrame.min15];

        const provider: Provider = {
            key: 'sma-crossover-telegram-key',
            apiToken: process.env.PROVIDER_API_TOKEN ?? 'test-token',
            restApiUrl: process.env.PROVIDER_API_URL ?? 'http://localhost:8081/api',
            connectors: [
                {
                    isActive: true,
                    connectorType: ConnectorType.binance,
                    markets: [
                        { marketType: MarketType.futures, symbols: this.symbols },
                        { marketType: MarketType.spot, symbols: this.symbols },
                    ],
                },
            ],
            accounts: [],
            isAvailable: true,
            studioGuid: 'sma-crossover-telegram',
            studioName: 'SMA Crossover Telegram',
            studioDescription: 'Тест: пересечение SMA → уведомление в Telegram без сделок',
            studioSocketApiUrl: process.env.PROVIDER_WS_URL ?? 'ws://localhost:8081/ws',
        };

        return {
            sysname: 'SmaCrossoverTelegram',
            logLevel: 'info',
            currency: this.quoteCurrency,
            restApiUrl: provider.restApiUrl,
            providers: [provider],
            symbols: this.symbols,
            intervals,
            subscriptions: [
                { type: SubscriptionType.PROVIDER_ACCOUNT_EVENT, active: true },
                {
                    type: SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
                    symbols: this.symbols,
                    active: true,
                },
            ],
            indicators: [],
            orders: [],
            useSandbox: false,
            useScratch: false,
            qualityGate: { enabled: false },
            performance: { enabled: true, writeToQuestDb: false },
            customConfig: {
                shortSmaPeriod: 10,
                longSmaPeriod: 30,
            } as SmaCrossoverTelegramCustomConfig,
            plugins: {
                modules: pluginModules,
                metas: pluginMetas,
            },
        };
    }
}
