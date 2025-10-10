import { Injectable, Provider } from '@nestjs/common';
import {
    Detector,
    DetectorConfigInput,
    Symbol as TradingSymbol,
    TimeFrame,
    Provider as MarketProvider, // 👈 чтобы не пересекался с Nest Provider
    ConnectorType,
    MarketType,
    PluginMeta,
} from '@barfinex/types';

import { TradeJournalService } from '@barfinex/plugins/trade-journal/src';
import { OrderflowTradeAnalyticsService } from '@barfinex/plugins/orderflow-trade-analytics/src';
import { z } from 'zod';

/**
 * 🔹 Схема для customConfig VolumeFollow стратегии
 */
export const VolumeFollowConfigSchema = z.object({
    maxTradesMemory: z.number().int().positive().default(200),
    bigTradeThreshold: z.number().positive().default(50_000),
    orderbookImbalanceRatio: z.number().positive().default(2),
    deltaWindow: z.number().int().positive().default(30),
    deltaThreshold: z.number().min(0).max(1).default(0.7),
    vwapTolerance: z.number().positive().default(0.005),
    stopLoss: z.number().positive().default(0.005),
    maxHoldTime: z.number().int().positive().default(30 * 60 * 1000), // 30 минут
    trailingStopDistance: z.number().positive().default(0.005),
    takeProfits: z
        .array(
            z.object({
                profit: z.number().positive(),
                ratio: z.number().positive(),
            }),
        )
        .default([
            { profit: 0.01, ratio: 0.25 },
            { profit: 0.02, ratio: 0.25 },
            { profit: 0.03, ratio: 0.5 },
        ]),
});

export type VolumeFollowConfig = z.infer<typeof VolumeFollowConfigSchema>;

/**
 * Метаданные плагина
 */
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
    {
        studioGuid: 'orderflow-trade-analytics-dev',
        title: 'Orderflow & Trade Analytics',
        description:
            'Аналитика по трейдам и ордербуку: delta ratio, CVD, VWAP крупных сделок, дисбаланс стакана',
        version: '0.1.0',
        author: 'Barfinex',
        visibility: 'public',
        pluginApi: '/plugins-api/orderflow-trade-analytics-dev',
    },
];

/**
 * Сервисы плагинов
 */
export const pluginServices = [
    TradeJournalService,
    OrderflowTradeAnalyticsService,
];

/**
 * Сервис конфигурации VolumeFollow стратегии
 */
@Injectable()
export class VolumeFollowConfigService {
    private readonly symbols: TradingSymbol[] = [
        { name: 'BTCUSDT', leverage: 10, quantity: 0.001 },
        { name: 'ETHUSDT', leverage: 10, quantity: 0.001 },
    ];

    private readonly quoteCurrency = 'USDT';

    get detector(): DetectorConfigInput {
        const intervals: TimeFrame[] = [TimeFrame.min1, TimeFrame.min5];

        const provider: MarketProvider = {
            key: 'volume-follow-key',
            restApiToken: 'dev-token',
            restApiUrl: 'http://localhost:8081/api',
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
            studioGuid: 'volume-follow-guid',
            studioName: 'Volume Follow Provider',
            studioDescription:
                'Detector strategy based on whale trades, deltas and orderbook imbalance',
            studioSocketApiUrl: 'ws://localhost:8081/ws',
        };

        // 🔹 валидируем customConfig
        const customConfig = VolumeFollowConfigSchema.parse({
            maxTradesMemory: 200,
            bigTradeThreshold: 50_000,
            orderbookImbalanceRatio: 2,
            deltaWindow: 30,
            deltaThreshold: 0.7,
            vwapTolerance: 0.005,
            stopLoss: 0.005,
            maxHoldTime: 30 * 60 * 1000,
            trailingStopDistance: 0.005,
            takeProfits: [
                { profit: 0.01, ratio: 0.25 },
                { profit: 0.02, ratio: 0.25 },
                { profit: 0.03, ratio: 0.5 },
            ],
        });

        return {
            sysname: 'VolumeFollow',
            logLevel: 'info',
            preloadHistory: false,
            currency: this.quoteCurrency,
            restApiUrl: provider.restApiUrl,
            providers: [provider],
            symbols: this.symbols,
            intervals,
            subscriptions: [],
            indicators: [],
            orders: [],
            useSandbox: true,
            useScratch: false,
            plugins: {
                modules: pluginServices, // 👈 теперь сервисы, а не модули
                metas: pluginMetas,
            },
            customConfig,
        };
    }
}

/**
 * Универсальные DI токены
 */
export const DETECTOR_CONFIG_SERVICE = 'DETECTOR_CONFIG_SERVICE';
export const DETECTOR_OPTIONS = 'DETECTOR_OPTIONS';

/**
 * Провайдер готового Detector
 */
export const DetectorOptionsProvider: Provider = {
    provide: 'DETECTOR_OPTIONS',
    useFactory: async (
        configService: VolumeFollowConfigService,
    ): Promise<DetectorConfigInput> => {
        return configService.detector;
    },
    inject: [VolumeFollowConfigService],
};
