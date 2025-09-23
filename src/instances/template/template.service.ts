import { Inject, Injectable } from '@nestjs/common';
import { DetectorService } from '@barfinex/detector';
import { SMA } from '@barfinex/indicators';
//import { sessionPlugin } from '@barfinex/plugins/session';
// import { VirtualTakesOptions, virtualTakesPlugin } from '@barfinex/plugins/virtual-takes';
// import { ReportPluginAPI, IndicatorsSchema } from '@barfinex/plugins/report';
// import { StatsPlugin, StatsPluginAPI } from '@barfinex/plugins/stats';
//import { TradingSystem } from '../../../tradingsystem';
import { math } from '@barfinex/utils';
import {
    Detector,
    OrderType,
    Candle,
    Account,
    Trade,
    Order,
    OrderBook,
    OrderSide,
    OrderEnv,
    Symbol,
    ConnectorType,
    MarketType
} from '@barfinex/types';
// import { IAnimal } from '../../IAnimal';
// import { ConsoleLogger } from '@nestjs/common/services';
// import { BTCUSDT } from './template.config'
// import { TemplateOptions } from './template.interface';
import { HttpService } from '@nestjs/axios';
// import { PluginDriverService } from 'apps/detector/src/plugin-driver/plugin-driver.service';
// import { ProviderService } from '../../../provider/provider.service';
// import { SessionService } from '../../../session/session.service';



// interface IProps {
//     pluginDriverService: PluginDriverService,
//     http: HttpService
// }

@Injectable()
export class TemplateService extends DetectorService {
    // declare additions: Detector;
    // declare plugins: StatsPluginAPI & ReportPluginAPI;
    private sma: SMA;
    private slowSMA: SMA;
    private fastSmaResult: number[] = [];
    private slowSmaResult: number[] = [];
    private allowOrders = true;


    // private additions: TemplateOptions

    constructor(props: any
        // private readonly sessionService: SessionService

    ) {
        // constructor(@Inject("IAnimal") private animal: IAnimal) {
        //@ts-ignore
        super(props);

        // this.options = BTCUSDT;
        // this.sma = new SMA({ period: this.additions.fastPeriod });
        // this.slowSMA = new SMA({ period: this.additions.slowPeriod });

        // sessionService = new SessionService(this.options);


        // this.registerPlugins([
        //     //sessionPlugin(this.options),
        //     //virtualTakesPlugin(this.options),
        //     // statsPlugin(this.options),
        // ]);
    }



    // public getIndicators = (): IndicatorsSchema => {
    //     return [
    //         {
    //             name: 'ft',
    //             figures: [
    //                 {
    //                     name: 'fast',
    //                     getValue: () => {
    //                         return this.fastSmaResult[0];
    //                     },
    //                 },
    //                 {
    //                     name: 'slow',
    //                     getValue: () => {
    //                         return this.slowSmaResult[0];
    //                     },
    //                 },
    //             ],
    //             inChart: true,
    //         },
    //     ];
    // };

    async openMonitoring(options: { symbol: Symbol, fastSMA?: number[], slowSMA?: number[], connectorType: ConnectorType, marketType: MarketType }) {

        const { symbol, fastSMA, slowSMA, connectorType, marketType } = options

        const percent = Math.abs(math.percentChange(fastSMA[0], slowSMA[0]));
        const order = this.orders[0];

        if (percent < 1) {
            this.allowOrders = true;
        }

        // if (
        //     fastSMA[0] > fastSMA[1] &&
        //     slowSMA[0] > slowSMA[1] &&
        //     fastSMA[0] > slowSMA[0] &&
        //     percent >= this.additions.openPercent &&
        //     this.allowOrders &&
        //     !order
        // ) {
        //     await this.openOrder({
        //         symbol: symbol,
        //         side: OrderSide.SELL,
        //         type: OrderType.MARKET,
        //         quantity: 12,
        //         useSandbox: false,
        //         connectorType,
        //         marketType,
        //         source: undefined
        //     });
        //     this.allowOrders = false;
        // }

        // if (
        //     fastSMA[0] < fastSMA[1] &&
        //     slowSMA[0] < slowSMA[1] &&
        //     fastSMA[0] < slowSMA[0] &&
        //     percent >= this.additions.openPercent &&
        //     !order &&
        //     this.allowOrders
        // ) {
        //     await this.openOrder({
        //         symbol: symbol,
        //         side: OrderSide.BUY,
        //         type: OrderType.MARKET,
        //         quantity: 12,
        //         useSandbox: false,
        //         connectorType,
        //         marketType,
        //         source: undefined
        //     });
        //     this.allowOrders = false;
        // }
    }


    async onTradeUpdate(trade: Trade) {



        // //private orderCounter = 123;
        // console.log("this.ordersCount:", this.ordersCount);

        // console.log("this.currentCandle:", this.currentCandle);



        //this.createOrder();


        // try {
        //     // Проверяем статус активного ордера, только на закрытие свечи
        //     const fastSMA = this.getFastSMA(candle);
        //     const slowSMA = this.getSlowSMA(candle);

        //     // this.indicators = { fastSMA: fastSMA, slowSMA: slowSMA };
        //     await this.openMonitoring(fastSMA, slowSMA);
        // } catch (e) {
        //     console.log(this.getName(), e);
        // }
    }


    async onCandleUpdate({ close: candle }: Candle) {



        // //private orderCounter = 123;
        // console.log("this.ordersCount:", this.ordersCount);

        // console.log("this.currentCandle:", this.currentCandle);



        //this.createOrder();


        // try {
        //     // Проверяем статус активного ордера, только на закрытие свечи
        //     const fastSMA = this.getFastSMA(candle);
        //     const slowSMA = this.getSlowSMA(candle);

        //     // this.indicators = { fastSMA: fastSMA, slowSMA: slowSMA };
        //     await this.openMonitoring(fastSMA, slowSMA);
        // } catch (e) {
        //     console.log(this.getName(), e);
        // }
    }


    async onOrderClose(order: Order) { }
    async onOrderOpen(order: Order) { }
    async onAccountUpdate(account: Account) {

        //console.log("account!!>>:", account);
        //this.createOrder(OrderSide.BUY, 12);

    }
    async onCandleOpen(candle: Candle) { }
    async onCandleClose(candle: Candle) { }
    async onTrade(trade: Trade) { }
    async onOrderBookUpdate(orderbook: OrderBook) { }


    private getFastSMA(value: number) {
        // this.fastSmaResult.unshift(this.sma.nextValue({ close: value }));

        if (this.fastSmaResult.length === 3) {
            this.fastSmaResult.splice(-1);
        }

        return this.fastSmaResult;
    }

    private getSlowSMA(value: number) {
        // this.slowSmaResult.unshift(this.slowSMA.nextValue({ close: value }));

        if (this.slowSmaResult.length === 3) {
            this.slowSmaResult.splice(-1);
        }

        return this.slowSmaResult;
    }
}