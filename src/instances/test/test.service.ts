import {
    forwardRef,
    Inject,
    Injectable,
    Optional,
    Logger,
} from '@nestjs/common';
import { DetectorService } from '@barfinex/detector';
import {
    Candle,
    Account,
    Trade,
    Order,
    OrderBook,
    TradeSide,
    Detector,
    TimeFrame,
    DetectorConfigInput,
} from '@barfinex/types';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';

import { TestConfigService } from './test.config';
import { buildDetectorConfig } from '@barfinex/types';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class TestService extends DetectorService {
    protected readonly logger = new Logger(TestService.name);

    private sandbox: {
        fastSmaResult: number[];
        slowSmaResult: number[];
        allowOrders: boolean;
    };

    constructor(
        @Inject(forwardRef(() => PluginDriverService))
        protected pluginDriverService: PluginDriverService,
        protected readonly connectorService: ConnectorService,
        protected readonly keyService: KeyService,
        protected readonly orderService: OrderService,
        protected readonly configService: ConfigService,

        @Inject('PROVIDER_SERVICE') client: ClientProxy,
        //   protected readonly moduleRef: ModuleRef, // 👈 передаём наверх

        @Inject('LOCAL_CONFIG') @Optional() localConfig?: TestConfigService,
        // @Inject('INITIAL_OPTIONS') @Optional() initialOptions?: Partial<Detector>,
    ) {
        // 1. База — initialOptions
        // const initial = (initialOptions ?? {}) as DetectorConfigInput;

        // 2. Локальные настройки перекрывают initial
        const local = (localConfig?.detector ?? {}) as DetectorConfigInput;



        console.log('⚡ localConfig:', localConfig);
        // console.log('⚡ initialOptions:', initialOptions);

        // 3. Финальный билд
        // const mergedOptions = buildDetectorConfig({
        //     ...initial,
        //     ...local,
        //     providers: local.providers ?? initial.providers ?? [],
        // });

        // ===================== Debug =====================
        // console.log('⚡ Initial.providers:', initial.providers?.length ?? 0);
        console.log('⚡ Local.providers:', local.providers?.length ?? 0);
        // console.log('⚡ Final.providers:', mergedOptions.providers?.length ?? 0);
        // ================================================

        // Жёсткая проверка
        if (!local.providers ||  local.providers.length === 0) {
            throw new Error(
                `[TestService] No providers detected local=${local.providers?.length ?? 0}`,
            );
        }

        super(
            pluginDriverService,
            connectorService,
            keyService,
            orderService,
            configService,
            client,
            // moduleRef, // 👈 не забудь
            // mergedOptions,
        );

        this.indicators = this.indicators || {};

        // Подключаем плагины
        // this.registerPlugins([
        //     // new StatsPlugin(this.options.plugins?.stats ?? {}),
        // ]);

        this.sandbox = {
            fastSmaResult: [],
            slowSmaResult: [],
            allowOrders: false,
        };
    }

    /**
     * Вызывается после полной инициализации DetectorService
     */
    async onInit() {
        this.logger.log('[onInit] Custom TestService initialized');

        this.options.symbols.forEach((symbol) => {
            const symbolName = symbol.name;

            this.options.intervals.forEach((interval: TimeFrame) => {
                const candles = [...(this.candles[symbolName]?.[interval] ?? [])].reverse();

                candles.forEach((candle) => {
                    const group = this.indicators[symbolName]?.[interval];
                    if (group) {
                        Object.values(group).forEach((indicator: any) => {
                            if (typeof indicator.onCandleClose === 'function') {
                                indicator.onCandleClose(candle);
                            }
                        });
                    }
                });
            });
        });
    }

    // ===================== Event Hooks =====================

    async onTrade(trade: Trade) {
        this.logger.debug(
            `[onTrade] ${trade.symbol.name} price=${trade.price} volume=${trade.volume}`,
        );
    }

    async onCandleUpdate(candle: Candle, trade: Trade) {
        this.runIndicators(candle.symbol.name, candle.interval, 'onCandleUpdate', candle, trade.side);
    }

    async onCandleOpen(candle: Candle) {
        this.runIndicators(candle.symbol.name, candle.interval, 'onCandleOpen', candle);
    }

    async onCandleClose(candle: Candle) {
        this.runIndicators(candle.symbol.name, candle.interval, 'onCandleClose', candle);
    }

    async onOrderClose(order: Order) {
        this.logger.debug(`[onOrderClose] ${order.symbol?.name ?? ''}`);
    }

    async onOrderOpen(order: Order) {
        this.logger.debug(`[onOrderOpen] ${order.symbol?.name ?? ''}`);
    }

    async onAccountUpdate(account: Account) {
        this.logger.debug(
            `[onAccountUpdate] ${account.connectorType}/${account.marketType}`,
        );
    }

    async onOrderBookUpdate(orderbook: OrderBook) {
        this.logger.debug(`[onOrderBookUpdate] ${orderbook.symbol.name}`);
    }

    // ===================== Helpers =====================

    private runIndicators(
        symbol: string,
        interval: TimeFrame,
        method: 'onCandleUpdate' | 'onCandleOpen' | 'onCandleClose',
        candle: Candle,
        side?: TradeSide,
    ) {
        const group = this.indicators[symbol]?.[interval];
        if (!group) return;

        Object.values(group).forEach((indicator: any) => {
            if (typeof indicator[method] === 'function') {
                side ? indicator[method](candle, side) : indicator[method](candle);
            }
        });
    }
}
