// apps/detector/src/instances/market-chaser/market-chaser.config.ts
import { Injectable } from '@nestjs/common';
import {
    ConnectorType,
    DetectorConfigInput,
    MarketType,
    Provider,
    Symbol as TradingSymbol,
    TimeFrame,
} from '@barfinex/types';

/**
 * Параметры стратегии MarketChaser (в customConfig).
 * Always-in-market trend follower: EMA21/55 h1, ATR trailing, flip on stop breach.
 */
export interface MarketChaserCustomConfig {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    interval: 'h1';
    emaFastLen: number;
    emaSlowLen: number;
    atrLen: number;
    atrMult: number;
    notionalUsd: number;
    tickOffset: number;
    entryTimeoutMs: number;
    maxRequotes: number;
    fallbackToMarket: boolean;
    maxSpreadPct: number;
    minDepth: number;
    minFlipCooldownSec: number;
    maxConsecutiveFlips: number;
    maxDailyLossUsd: number;
    requireMaturity: string;
}

@Injectable()
export class MarketChaserConfigService {
    private readonly symbols: TradingSymbol[] = [
        { name: 'BTCUSDT', leverage: 5, quantity: 0.001 },
    ];

    get detector(): DetectorConfigInput {
        const provider: Provider = {
            key: 'market-chaser-provider',
            apiToken: 'dev-token',
            restApiUrl: process.env.PROVIDER_REST_API_URL || 'http://localhost:8081/api',
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
            studioGuid: 'market-chaser-guid',
            studioName: 'Market Chaser Provider',
            studioDescription: 'Always-in-market trend follower (EMA/ATR, flip on stop)',
            studioSocketApiUrl: process.env.PROVIDER_WS_URL || 'ws://localhost:8081/ws',
        };

        const customConfig: MarketChaserCustomConfig = {
            symbol: 'BTCUSDT',
            connectorType: ConnectorType.binance,
            marketType: MarketType.futures,
            interval: 'h1',
            emaFastLen: 21,
            emaSlowLen: 55,
            atrLen: 14,
            atrMult: 2.5,
            notionalUsd: 2,
            tickOffset: 0.5,
            entryTimeoutMs: 2000,
            maxRequotes: 3,
            fallbackToMarket: true,
            maxSpreadPct: 0.001,
            minDepth: 10,
            minFlipCooldownSec: 90,
            maxConsecutiveFlips: 8,
            maxDailyLossUsd: 15,
            requireMaturity: 'INTRADAY',
        };

        return {
            sysname: 'MarketChaser',
            logLevel: 'info',
            preloadHistory: false,
            currency: 'USDT',
            restApiUrl: provider.restApiUrl,
            providers: [provider],
            symbols: this.symbols,
            intervals: [TimeFrame.h1],
            subscriptions: [],
            indicators: [],
            orders: [],
            useSandbox: true,
            useScratch: false,
            qualityGate: {
                enabled: true,
                minClosedTrades: 10,
                minWinRate: 0.35,
                minAvgRr: 0.6,
                maxConsecutiveLosses: 6,
                cooldownMs: 5 * 60 * 1000,
            },
            performance: {
                enabled: true,
                writeToQuestDb: true,
                questTableTrades: 'detector_trade_metrics',
                questTableSummary: 'detector_performance_summary',
            },
            customConfig,
            plugins: { modules: [], metas: [] },
        };
    }
}
