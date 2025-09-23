import {
    Injectable,
    Logger,
    Inject,
    forwardRef,
    Optional,
} from '@nestjs/common';
import { DetectorService } from '@barfinex/detector';
import {
    Candle,
    Trade,
    OrderBook,
    TradeSide,
    Detector,
    Position,
    ConnectorType,
    MarketType,
    DetectorConfigInput,
} from '@barfinex/types';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';

import {
    VolumeFollowConfig,
    VolumeFollowConfigService,
} from './volume-follow.config';

import { OrderflowTradeAnalyticsService } from '@barfinex/plugins/orderflow-trade-analytics';
import { ORDERFLOW_ANALYTICS } from '@barfinex/plugins/orderflow-trade-analytics/orderflow-trade-analytics.constants';

/**
 * Detector Service: VolumeFollow
 */
@Injectable()
export class VolumeFollowService extends DetectorService {
    protected readonly logger = new Logger(VolumeFollowService.name);

    /** Сервис аналитики ордерфлоу (плагин) */
    private analytics?: OrderflowTradeAnalyticsService;

    /** Доступ к кастомной конфигурации */
    private get cfg(): VolumeFollowConfig {
        return (this.options.customConfig ?? {}) as VolumeFollowConfig;
    }

    constructor(
        @Inject(forwardRef(() => PluginDriverService))
        protected readonly pluginDriverService: PluginDriverService,
        protected readonly connectorService: ConnectorService,
        protected readonly keyService: KeyService,
        protected readonly orderService: OrderService,
        protected readonly configService: ConfigService,
        @Inject('PROVIDER_SERVICE')
        protected readonly client: ClientProxy,

        @Optional()
        @Inject('DETECTOR_CONFIG_SERVICE')
        private readonly localConfig?: VolumeFollowConfigService,

        @Optional()
        @Inject('DETECTOR_OPTIONS')
        private readonly detectorOptions?: Partial<Detector>,

        @Optional()
        @Inject(ORDERFLOW_ANALYTICS)
        private readonly analyticsFromDI?: OrderflowTradeAnalyticsService,
    ) {
        super(
            pluginDriverService,
            connectorService,
            keyService,
            orderService,
            configService,
            client,
            detectorOptions
                ? { detector: detectorOptions as DetectorConfigInput }
                : localConfig,
        );

        if (this.options.providers?.length) {
            this.logger.debug(
                `[constructor] ✅ Providers: ${this.options.providers
                    .map((p) => `${p.key}@${p.restApiUrl}`)
                    .join(', ')}`,
            );
        } else {
            this.logger.warn('[constructor] ❌ No providers passed into options');
        }
    }

    /** Инициализация детектора */
    public async initializeDetector() {
        await super.initializeDetector();
        this.logger.debug('[initializeDetector] after parent');

        // this.analytics =
        //     this.pluginDriverService.findPlugin(OrderflowTradeAnalyticsService);

        // if (this.analytics) {
        //     this.logger.debug(`[initializeDetector] Analytics plugin ready`);
        // } else {
        //     this.logger.warn(`[initializeDetector] Analytics plugin not found`);
        // }
    }

    /** Lazy-init getter для аналитики */
    private getAnalytics(): OrderflowTradeAnalyticsService | undefined {
        if (!this.analytics) {
            this.analytics =
                this.pluginDriverService.findPlugin(OrderflowTradeAnalyticsService);
            if (this.analytics) {
                this.logger.debug(`[LazyInit] Analytics plugin found`);
            }
        }
        return this.analytics;
    }

    /** Запуск жизненного цикла */
    async initDetectorLifecycle(): Promise<void> {
        await super.initDetectorLifecycle(); // регистрируются плагины

        this.logger.debug(`[initDetectorLifecycle] VolumeFollowService init done`);

        this.analytics =
            this.pluginDriverService.findPlugin(OrderflowTradeAnalyticsService);

        if (this.analytics) {
            this.logger.debug(`[initDetectorLifecycle] Analytics plugin ready`);
        } else {
            this.logger.warn(`[initDetectorLifecycle] Analytics plugin not found`);
        }
    }

    // ===== Hooks =====


    async onStart() {
        this.logger.log(`[onStart] VolumeFollow started`);
    }

    // async onInit() {
    //     this.logger.log(`[onInit] VolumeFollow started`);
    // }


    async onTrade(
        trade: Trade,
        connectorType: ConnectorType,
        marketType: MarketType,
    ) {
        const analytics = this.getAnalytics();
        analytics?.ingestTrade({
            symbol: trade.symbol.name,
            price: trade.price,
            volume: trade.volume,
            side: trade.side,
            time: trade.time,
        });

        // this.analytics.test();

        const activePosition = this.positions.findBySymbol(trade.symbol);

        if (
            !activePosition &&
            trade.volume * trade.price >= this.cfg.bigTradeThreshold
        ) {
            await this.tryEnterPosition(trade, connectorType, marketType);
        }

        if (activePosition) {
            await this.tryExitPosition(trade, activePosition, connectorType, marketType);
            this.updateTrailingStop(
                trade.price,
                activePosition,
                this.cfg.trailingStopDistance,
            );
        }
    }

    async onOrderBookUpdate(
        orderbook: OrderBook,
        connectorType: ConnectorType,
        marketType: MarketType,
    ) {


        // console.log("OrderBook update:", orderbook.symbol.name);

        const analytics = this.getAnalytics();
        analytics?.ingestOrderbook({
            symbol: orderbook.symbol.name,
            bids: orderbook.bids,
            asks: orderbook.asks,
            time: orderbook.time,
        });
    }

    async onCandleClose(
        candle: Candle,
        _connectorType: ConnectorType,
        _marketType: MarketType,
    ) {
        const p = this.positions.findBySymbol(candle.symbol);
        if (p) await this.tryExitByTime(candle, p);
    }

    // ===== Strategy Logic =====

    private async tryEnterPosition(
        trade: Trade,
        connectorType: ConnectorType,
        marketType: MarketType,
    ) {
        const analytics = this.getAnalytics();
        if (!analytics) return;

        const symbol = trade.symbol.name;

        const imbalance = analytics.getOrderBookImbalanceFromState(symbol);
        if (imbalance == null) return;

        const delta = analytics.getTradeDeltaByLastN(symbol, this.cfg.deltaWindow);
        const vwap = analytics.getBigTradesVWAPFromState(
            symbol,
            this.cfg.bigTradeThreshold,
        );
        if (vwap == null) return;

        const priceNearVWAP =
            Math.abs(trade.price - vwap) / vwap < this.cfg.vwapTolerance;

        const longSignal =
            trade.side === TradeSide.LONG &&
            imbalance > this.cfg.orderbookImbalanceRatio &&
            delta > this.cfg.deltaThreshold &&
            priceNearVWAP;

        const shortSignal =
            trade.side === TradeSide.SHORT &&
            imbalance < 1 / this.cfg.orderbookImbalanceRatio &&
            delta < 1 - this.cfg.deltaThreshold &&
            priceNearVWAP;

        if (longSignal || shortSignal) {
            this.logger.debug(
                `[tryEnterPosition] Signal → ${longSignal ? 'LONG' : 'SHORT'} @${trade.price}`,
            );

            await this.openPosition({
                symbol: trade.symbol,
                connectorType,
                marketType,
                side: longSignal ? TradeSide.LONG : TradeSide.SHORT,
                quantity: trade.volume,
                price: trade.price,
            });
        }
    }

    private async tryExitPosition(
        trade: Trade,
        position: Position,
        connectorType: ConnectorType,
        marketType: MarketType,
    ) {
        let current = position;
        const pnl = (trade.price - current.entryPrice) / current.entryPrice;
        const dir = current.side;

        for (let i = 0; i < this.cfg.takeProfits.length; i++) {
            const tp = this.cfg.takeProfits[i];
            if (current.tpExecuted?.[i]) continue;

            const hitTP =
                (dir === TradeSide.LONG && pnl >= tp.profit) ||
                (dir === TradeSide.SHORT && -pnl >= tp.profit);

            if (!hitTP) continue;

            const qty = current.quantity * tp.ratio;
            this.logger.warn(`[TP${i + 1}] Closing ${qty} @${trade.price}`);

            await this.closePosition({
                position: current,
                connectorType,
                marketType,
                quantity: qty,
            });

            const refreshed = this.positions.findBySymbol(current.symbol);
            if (!refreshed) return;

            refreshed.tpExecuted = refreshed.tpExecuted ?? [];
            refreshed.tpExecuted[i] = true;
            this.updateTrailingStop(
                trade.price,
                refreshed,
                this.cfg.trailingStopDistance / 2,
            );

            current = refreshed;
        }

        const stopLossHit =
            (dir === TradeSide.LONG && pnl <= -this.cfg.stopLoss) ||
            (dir === TradeSide.SHORT && -pnl >= -this.cfg.stopLoss);

        if (stopLossHit) {
            this.logger.warn(`[Exit] Stop-Loss hit @${trade.price}`);
            await this.closePosition({
                position: current,
                connectorType,
                marketType,
            });
        }
    }

    private async tryExitByTime(candle: Candle, position: Position) {
        const holdingTime = Date.now() - (position.entryTime ?? Date.now());
        if (holdingTime > this.cfg.maxHoldTime) {
            this.logger.warn(`[Exit] Time limit reached → closing`);
            await this.closePosition({
                position,
                connectorType: position.connectorType,
                marketType: position.marketType,
            });
        }
    }
}
