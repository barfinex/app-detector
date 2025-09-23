import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { DetectorService } from '@barfinex/detector';
import { SMA } from '@barfinex/indicators';
import { math } from '@barfinex/utils';
import {
    Candle,
    Account,
    Trade,
    Order,
    OrderBook,
    TradeSide,
    Detector
} from '@barfinex/types';
import { FollowTrendConfigService } from './follow-trend.config';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class FollowTrendService extends DetectorService {

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

        protected readonly localConfig: FollowTrendConfigService,

        // @Inject('INITIAL_OPTIONS') initialOptions: Partial<Detector>,
    ) {

        // локальные дефолты из конфига стратегии
        const local = localConfig?.detector ?? {};
        // что реально передаём в базовый сервис:
        // const mergedOptions: Partial<Detector> = { ...initialOptions, ...local };

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

        this.indicators = [] as any;

        // this.registerPlugins([
        //     // new SessionPlugin(this.options.plugins['SessionPlugin']),
        //     // new StatsPlugin(this.options.plugins.stats),
        //     // new DebugPlugin(this.options.plugins['DebugPlugin']),
        //     // new VirtualTakesPlugin(this.options.plugins['VirtualTakesPlugin']),
        //     // new ReportPlugin(this.options.plugins['ReportPlugin']),
        //     // new GridPlugin(this.options.plugins['GridPlugin']),
        //     // new NeuroVisionPlugin(this.options.plugins['NeuroVisionPlugin'])
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

    }


    async onTrade(trade: Trade) {

        console.log("trade:", trade);

        const symbol = 'BTCUSDT'

        if (trade.symbol.name == symbol) {

            // console.log("trade:", trade);


            const enum TrendDirection {
                'Up' = 'Up',
                'Down' = 'Down',
                'Ranging' = 'Ranging',
            }


            let trendDirection: TrendDirection = TrendDirection.Ranging



            if (!this.isOpenPosition(trade.symbol)) {


                // console.log('trade:', trade);

                const permissibleQuantity = null //this.getPermissibleQuantity(account, trade.symbol, trade.price, this.options.providers[0])

                if (permissibleQuantity) {

                    const quantity = permissibleQuantity.acceptableQuantityMin
                    //  console.log("permissibleQuantity:", permissibleQuantity);

                    if (permissibleQuantity.acceptable) {

                        trendDirection = TrendDirection.Ranging

                        // this
                        // this.options.intervals.forEach(interval => {
                        //     console.log("this.indicators[symbol][interval]:", this.indicators[symbol][interval]);
                        // })

                        this.options.intervals.forEach(interval => {
                            if (trade.price > this.indicators[symbol][interval].sma7.result[0] &&
                                trade.price > this.indicators[symbol][interval].sma25.result[0] &&
                                trade.price > this.indicators[symbol][interval].sma99.result[0]) {
                                trendDirection = TrendDirection.Up
                            }
                            if (trade.price < this.indicators[symbol][interval].sma7.result[0] &&
                                trade.price < this.indicators[symbol][interval].sma25.result[0] &&
                                trade.price < this.indicators[symbol][interval].sma99.result[0]) {
                                trendDirection = TrendDirection.Down
                            }
                        })


                        this.options.symbols.forEach(symbol => {
                            this.options.intervals.forEach(interval => {

                                Object.keys(this.indicators[symbol.name][interval]).forEach(indicatorName => {

                                });

                            })
                        })

                    }
                    else {
                        return console.log('Have not enough available Balance In USD', { permissibleQuantity });
                    }


                }

            } else {

            }


        }

    }

    async onCandleUpdate(candle: Candle, trade: Trade) {

        const symbolName = candle.symbol.name
        const interval = candle.interval


        if (candle.interval && this.options.intervals.find(q => q == interval))
            Object.keys(this.indicators[symbolName][interval]).forEach(indicator => {
                this.indicators[symbolName][interval][indicator].onCandleUpdate(candle, trade.side)
            });
    }

    async onCandleOpen(candle: Candle) {

        const symbolName = candle.symbol.name
        const interval = candle.interval

        if (candle.interval && this.options.intervals.find(q => q == interval))
            Object.keys(this.indicators[symbolName][interval]).forEach(indicator => {
                this.indicators[symbolName][interval][indicator].onCandleOpen(candle)
            });

    }


    async onCandleClose(candle: Candle) {

        const symbolName = candle.symbol.name
        const interval = candle.interval

        if (candle.interval && this.options.intervals.find(q => q == interval))
            Object.keys(this.indicators[symbolName][interval]).forEach(indicator => {
                this.indicators[symbolName][interval][indicator].onCandleClose(candle)
            });


    }


    async onOrderClose(order: Order) { }
    async onOrderOpen(order: Order) { }
    async onAccountUpdate(account: Account) {


    }

    async onOrderBookUpdate(orderbook: OrderBook) { }

}

export const CustomDecorator = (): MethodDecorator => {
    return (
        target: Object,
        propertyKey: string | symbol,
        descriptor: PropertyDescriptor
    ) => {

        const originalMethod = descriptor.value;

        descriptor.value = function () {
            const serviceInstance = this;
            // console.log(serviceInstance.myService);

        }

        return descriptor;
    }
};





