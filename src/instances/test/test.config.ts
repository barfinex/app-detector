import { Injectable, Provider as NestProvider } from '@nestjs/common';
import {
    Detector,
    DetectorConfigInput,
    Symbol as TradingSymbol,
    TimeFrame,
    Provider,
    ConnectorType,
    MarketType,
    buildDetectorConfig,
    PluginMeta
} from '@barfinex/types';

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
export class TestConfigService {
    private symbols: TradingSymbol[] = [
        { name: 'BTCUSDT', leverage: 10, quantity: 0.001 },
        { name: 'ETHUSDT', leverage: 10, quantity: 0.001 },
    ];

    private quoteCurrency = 'USDT';

    get detector(): DetectorConfigInput {
        const intervals: TimeFrame[] = [TimeFrame.min1, TimeFrame.min5];

        const provider: Provider = {
            key: 'test-key',
            restApiToken: 'test-token',
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
            studioGuid: 'test-guid',
            studioName: 'Mock Provider',
            studioDescription: 'Test mock provider for local dev',
            studioSocketApiUrl: 'ws://localhost:8081/ws',
        };

        return {
            sysname: 'Test',
            logLevel: 'info2',
            currency: this.quoteCurrency,
            restApiUrl: provider.restApiUrl,
            providers: [provider],
            symbols: this.symbols,
            intervals,
            subscriptions: [],
            indicators: [],
            orders: [],
            useSandbox: false,
            useScratch: false,
            plugins: {
                modules: pluginModules,
                metas: pluginMetas
            }
        };
    }
}

// export const TestOptionsProvider: NestProvider = {
//     provide: 'INITIAL_OPTIONS',
//     useFactory: (configService: TestConfigService): Detector => {
//         const cfg = configService.detector;
//         return buildDetectorConfig(cfg);
//     },
//     inject: [TestConfigService],
// };
