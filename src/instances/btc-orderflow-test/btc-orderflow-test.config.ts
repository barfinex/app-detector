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

export interface BtcOrderflowTestCustomConfig {
    symbol: string;
    flowWindowMs: number;
    minTradesForSignal: number;
    minNotionalForSignal: number;
    longDeltaRatioMin: number;
    shortDeltaRatioMax: number;
    orderbookImbalanceLongMin: number;
    orderbookImbalanceShortMax: number;
    maxSpreadPercent: number;
    takeProfitPercent: number;
    stopLossPercent: number;
    trailingStopPercent: number;
    maxHoldTimeMs: number;
}

@Injectable()
export class BtcOrderflowTestConfigService {
    private readonly symbols: TradingSymbol[] = [
        { name: 'BTCUSDT', leverage: 5, quantity: 0.001 },
    ];

    get detector(): DetectorConfigInput {
        const provider: MarketProvider = {
            key: 'btc-orderflow-test-provider',
            apiToken: 'dev-token',
            restApiUrl: 'http://localhost:8081/api',
            connectors: [
                {
                    isActive: true,
                    connectorType: ConnectorType.binance,
                    markets: [
                        { marketType: MarketType.futures, symbols: this.symbols },
                    ],
                },
            ],
            accounts: [],
            isAvailable: true,
            studioGuid: 'btc-orderflow-test-guid',
            studioName: 'BTC Orderflow Test Provider',
            studioDescription: 'Single-instrument BTCUSDT detector for orderflow validation',
            studioSocketApiUrl: 'ws://localhost:8081/ws',
        };

        const customConfig: BtcOrderflowTestCustomConfig = {
            symbol: 'BTCUSDT',
            flowWindowMs: 90_000,
            minTradesForSignal: 25,
            minNotionalForSignal: 150_000,
            longDeltaRatioMin: 0.62,
            shortDeltaRatioMax: 0.38,
            orderbookImbalanceLongMin: 1.2,
            orderbookImbalanceShortMax: 0.84,
            maxSpreadPercent: 0.25,
            takeProfitPercent: 0.7,
            stopLossPercent: 0.45,
            trailingStopPercent: 0.3,
            maxHoldTimeMs: 15 * 60 * 1000,
        };

        return {
            sysname: 'BtcOrderflowTest',
            logLevel: 'info',
            preloadHistory: false,
            currency: 'USDT',
            restApiUrl: provider.restApiUrl,
            providers: [provider],
            symbols: this.symbols,
            intervals: [TimeFrame.min1, TimeFrame.min5],
            subscriptions: [],
            indicators: [],
            orders: [],
            useSandbox: true,
            useScratch: false,
            qualityGate: {
                enabled: true,
                minClosedTrades: 20,
                minWinRate: 0.42,
                minAvgRr: 0.9,
                maxConsecutiveLosses: 4,
                cooldownMs: 10 * 60 * 1000,
            },
            performance: {
                enabled: true,
                writeToQuestDb: true,
                questTableTrades: 'detector_trade_metrics',
                questTableSummary: 'detector_performance_summary',
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
        configService: BtcOrderflowTestConfigService,
    ): Promise<Partial<DetectorOptions>> => {
        return configService.detector as Partial<DetectorOptions>;
    },
    inject: [BtcOrderflowTestConfigService],
};

