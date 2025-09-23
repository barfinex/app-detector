import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { DetectorService } from '@barfinex/detector';
import {
    Candle,
    Account,
    Trade,
    Order,
    OrderBook,
    TradeSide,
    Detector,
    OrderSide,
    OrderType,
    OrderSourceType
} from '@barfinex/types';
import { EmptyConfigService } from './empty.config';
import 'moment-timezone';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class EmptyService extends DetectorService {

    private sandbox: {
        fastSmaResult: number[]
        slowSmaResult: number[]
        allowOrders: boolean
    };

    constructor(
        @Inject(forwardRef(() => PluginDriverService))
        protected pluginDriverService: PluginDriverService,
        protected readonly connectorService: ConnectorService,
        protected readonly keyService: KeyService,
        protected readonly orderService: OrderService,
        protected readonly configService: ConfigService,

        @Inject('PROVIDER_SERVICE')
        client: ClientProxy,
        //   protected readonly moduleRef: ModuleRef, // 👈 передаём наверх

        protected readonly localConfig: EmptyConfigService,

        // @Inject('INITIAL_OPTIONS') initialOptions: Detector,
    ) {

        // локальные дефолты из конфига стратегии
        const local = localConfig?.detector ?? {};
        // что реально передаём в базовый сервис:
        const mergedOptions: Partial<Detector> = { 
            //...initialOptions, 
            ...local };

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

        // initialOptions = localConfig.detector


        this.indicators = []

        // this.registerPlugins([

        // ]);
    }



    async onInit() {


        this.options.symbols.forEach(symbol => {

            const symbolName = symbol.name

            this.options.intervals.forEach(interval => {

                [...this.candles[symbol.name][interval]].reverse().forEach(candle => {
                    Object.keys(this.indicators[symbolName][interval]).forEach(indicator => {
                        this.indicators[symbolName][interval][indicator].onCandleClose(candle)
                    });
                });
            })
        })

        this.sandbox = {
            fastSmaResult: [],
            slowSmaResult: [],
            allowOrders: false
        }

        // console.log("this.options полностью заполненный:", this.options);

    }




    async onTrade(trade: Trade) {


    }

    async onCandleUpdate(candle: Candle, trade: Trade) {

        const symbolName = candle.symbol.name
        const interval = candle.interval

        if (interval && this.options.intervals.find(q => q == interval))
            Object.keys(this.indicators[symbolName][interval]).forEach(indicator => {
                this.indicators[symbolName][interval][indicator].onCandleUpdate(candle, trade.side)
            });
    }

    async onCandleOpen(candle: Candle) {

        const symbolName = candle.symbol.name
        const interval = candle.interval

        if (interval && this.options.intervals.find(q => q == interval))
            Object.keys(this.indicators[symbolName][interval]).forEach(indicator => {
                this.indicators[symbolName][interval][indicator].onCandleOpen(candle)
            });


    }

    // async onCandleClose(candle: Candle) {
    //     if (candle.interval && this.options.intervals.find(q => q == candle.interval))
    //         Object.keys(this.indicators[candle.symbol][candle.interval]).forEach(indicator => {
    //             this.indicators[candle.symbol][candle.interval][indicator].onCandleClose(candle)
    //         });


    // }

    async onCandleClose(candle: Candle) {
        const { symbol, interval, close: closePrice } = candle;

        if (!interval || !this.options.intervals.includes(interval)) return;

        // const symbolObj = { name: symbol }; // Приведение к типу Symbol
        const candles = this.getSymbolCandlesState(symbol, interval, 'desc');
        if (!candles || candles.length < 20) return;

        const fastPeriod = 5;
        const slowPeriod = 20;

        const fastSma = candles.slice(0, fastPeriod).reduce((sum, c) => sum + c.c, 0) / fastPeriod;
        const slowSma = candles.slice(0, slowPeriod).reduce((sum, c) => sum + c.c, 0) / slowPeriod;

        this.sandbox.fastSmaResult.push(fastSma);
        this.sandbox.slowSmaResult.push(slowSma);

        if (this.sandbox.fastSmaResult.length < 2 || this.sandbox.slowSmaResult.length < 2) return;

        const prevFast = this.sandbox.fastSmaResult[this.sandbox.fastSmaResult.length - 2];
        const prevSlow = this.sandbox.slowSmaResult[this.sandbox.slowSmaResult.length - 2];

        const provider = this.options.providers[0];
        const account = this.accounts.find(a => a.symbols?.some(s => s.name === symbol.name));
        if (!account) return;

        const permissible = this.getPermissibleQuantity(account, symbol, closePrice, provider);
        if (!permissible.acceptable) return;

        const quantity = permissible.acceptableQuantityMin;

        // BUY: пересечение снизу вверх
        if (prevFast < prevSlow && fastSma > slowSma && !this.isOpenOrder(symbol)) {
            const order: Order = {
                symbol,
                side: OrderSide.BUY,
                type: OrderType.MARKET,
                price: closePrice,
                quantity,
                useSandbox: this.options.useSandbox,
                connectorType: account.connectorType,
                marketType: account.marketType,
                source: {
                    type: OrderSourceType.detector,
                    key: this.options.key,
                    restApiUrl: this.options.restApiUrl,
                },
            };

            await this.openOrder(order, provider);
            console.log(`[SMA] BUY signal for ${symbol}: fastSMA ${fastSma.toFixed(2)} > slowSMA ${slowSma.toFixed(2)}`);
        }

        // SELL: пересечение сверху вниз
        if (prevFast > prevSlow && fastSma < slowSma && this.isOpenOrder(symbol)) {
            const openOrder = account.orders.find(o => o.symbol?.name === symbol.name);
            if (openOrder) {
                await this.closeOrder(openOrder, closePrice, provider);
                console.log(`[SMA] SELL signal for ${symbol}: fastSMA ${fastSma.toFixed(2)} < slowSMA ${slowSma.toFixed(2)}`);
            }
        }
    }




    async onOrderClose(order: Order) { }
    async onOrderOpen(order: Order) { }
    async onAccountUpdate(account: Account) {



    }

    async onOrderBookUpdate(orderbook: OrderBook) { }

    private getTest() {

        return 'this.fastSmaResult';
    }


}


