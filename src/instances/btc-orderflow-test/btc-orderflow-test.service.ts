import {
    Inject,
    Injectable,
    Optional,
    Logger,
    forwardRef,
} from '@nestjs/common';
import { DetectorService } from '@barfinex/detector';
import {
    Candle,
    ConnectorType,
    Detector,
    DetectorConfigInput,
    MarketType,
    OrderBook,
    Position,
    Trade,
    TradeSide,
} from '@barfinex/types';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import {
    BtcOrderflowTestConfigService,
    BtcOrderflowTestCustomConfig,
} from './btc-orderflow-test.config';

type FlowTrade = {
    ts: number;
    price: number;
    volume: number;
    side: TradeSide;
};

@Injectable()
export class BtcOrderflowTestService extends DetectorService {
    protected readonly logger = new Logger(BtcOrderflowTestService.name);
    private readonly tradesWindow: FlowTrade[] = [];
    private latestOrderbookImbalance = 1;
    private latestSpreadPercent = 0;
    private entryMomentBySymbol = new Map<string, number>();

    private get cfg(): BtcOrderflowTestCustomConfig {
        return (this.options.customConfig ?? {}) as BtcOrderflowTestCustomConfig;
    }

    constructor(
        @Inject(forwardRef(() => PluginDriverService))
        protected readonly pluginDriverService: PluginDriverService,
        protected readonly connectorService: ConnectorService,
        protected readonly keyService: KeyService,
        protected readonly orderService: OrderService,
        protected readonly configService: ConfigService,
        @Inject('PROVIDER_SERVICE') protected readonly client: ClientProxy,
        @Optional() @Inject('DETECTOR_CONFIG_SERVICE')
        private readonly localConfig?: BtcOrderflowTestConfigService,
        @Optional() @Inject('DETECTOR_OPTIONS')
        private readonly detectorOptions?: Partial<Detector>,
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
    }

    async onStart(): Promise<void> {
        this.logger.log('[onStart] BtcOrderflowTest started');
    }

    async onTrade(
        trade: Trade,
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<void> {
        if (trade.symbol.name !== this.cfg.symbol) return;

        this.ingestTrade(trade);

        const position = this.positions.findBySymbol(trade.symbol);
        if (position) {
            await this.manageOpenPosition(position, trade.price, connectorType, marketType);
            return;
        }

        const signal = this.computeEntrySignal();
        if (!signal) return;

        const quantity = this.options.symbols.find(s => s.name === this.cfg.symbol)?.quantity ?? 0.001;
        await this.openPosition({
            symbol: trade.symbol,
            side: signal,
            quantity,
            price: trade.price,
            connectorType,
            marketType,
        });
        this.entryMomentBySymbol.set(trade.symbol.name, Date.now());
        this.logger.log(
            `[onTrade] Open ${signal} ${trade.symbol.name} price=${trade.price.toFixed(2)} qty=${quantity}`,
        );
    }

    async onOrderBookUpdate(
        orderbook: OrderBook,
        _connectorType: ConnectorType,
        _marketType: MarketType,
    ): Promise<void> {
        if (orderbook.symbol.name !== this.cfg.symbol) return;
        const depth = 10;
        const bids = (orderbook.bids ?? []).slice(0, depth);
        const asks = (orderbook.asks ?? []).slice(0, depth);
        const bidVol = bids.reduce((sum, x) => sum + Number(x.volume ?? 0), 0);
        const askVol = asks.reduce((sum, x) => sum + Number(x.volume ?? 0), 0);
        this.latestOrderbookImbalance = bidVol / (askVol + 1e-9);

        const bestBid = Number(bids[0]?.price ?? 0);
        const bestAsk = Number(asks[0]?.price ?? 0);
        this.latestSpreadPercent =
            bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
    }

    async onCandleClose(
        candle: Candle,
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<void> {
        if (candle.symbol.name !== this.cfg.symbol) return;
        const position = this.positions.findBySymbol(candle.symbol);
        if (!position) return;
        await this.manageOpenPosition(position, candle.close, connectorType, marketType);
    }

    private ingestTrade(trade: Trade): void {
        this.tradesWindow.push({
            ts: trade.time,
            price: trade.price,
            volume: trade.volume,
            side: trade.side,
        });
        const border = Date.now() - this.cfg.flowWindowMs;
        while (this.tradesWindow.length > 0 && this.tradesWindow[0]!.ts < border) {
            this.tradesWindow.shift();
        }
    }

    private computeEntrySignal(): TradeSide | null {
        if (this.latestSpreadPercent > this.cfg.maxSpreadPercent) return null;
        if (this.tradesWindow.length < this.cfg.minTradesForSignal) return null;

        let buyVolume = 0;
        let sellVolume = 0;
        let vwapNum = 0;
        let vwapDen = 0;

        for (const t of this.tradesWindow) {
            if (t.side === TradeSide.LONG) buyVolume += t.volume;
            else sellVolume += t.volume;
            vwapNum += t.price * t.volume;
            vwapDen += t.volume;
        }

        const totalVolume = buyVolume + sellVolume;
        if (totalVolume <= 0 || vwapDen <= 0) return null;
        const notional = this.tradesWindow.reduce((sum, t) => sum + t.price * t.volume, 0);
        if (notional < this.cfg.minNotionalForSignal) return null;

        const deltaRatio = buyVolume / totalVolume;
        const vwap = vwapNum / vwapDen;
        const lastPrice = this.tradesWindow[this.tradesWindow.length - 1]!.price;
        const vwapDeviation = Math.abs(lastPrice - vwap) / vwap;
        if (vwapDeviation > 0.003) return null;

        const longSignal =
            deltaRatio >= this.cfg.longDeltaRatioMin &&
            this.latestOrderbookImbalance >= this.cfg.orderbookImbalanceLongMin;
        const shortSignal =
            deltaRatio <= this.cfg.shortDeltaRatioMax &&
            this.latestOrderbookImbalance <= this.cfg.orderbookImbalanceShortMax;

        if (longSignal) return TradeSide.LONG;
        if (shortSignal) return TradeSide.SHORT;
        return null;
    }

    private async manageOpenPosition(
        position: Position,
        lastPrice: number,
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<void> {
        const sideMultiplier = position.side === TradeSide.LONG ? 1 : -1;
        const pnlPct = sideMultiplier * ((lastPrice - position.entryPrice) / position.entryPrice) * 100;

        const tpHit = pnlPct >= this.cfg.takeProfitPercent;
        const slHit = pnlPct <= -this.cfg.stopLossPercent;

        const entryMoment =
            this.entryMomentBySymbol.get(position.symbol.name) ??
            position.entryTime ??
            Date.now();
        const expired = Date.now() - entryMoment >= this.cfg.maxHoldTimeMs;

        this.updateTrailingStop(lastPrice, position, this.cfg.trailingStopPercent / 100);
        const refreshedPosition = this.positions.findBySymbol(position.symbol) ?? position;
        const trailingHit =
            refreshedPosition.trailingStop !== undefined &&
            ((position.side === TradeSide.LONG && lastPrice <= refreshedPosition.trailingStop) ||
                (position.side === TradeSide.SHORT && lastPrice >= refreshedPosition.trailingStop));

        if (!tpHit && !slHit && !expired && !trailingHit) return;

        await this.closePosition({
            position: refreshedPosition,
            connectorType,
            marketType,
        });
        this.entryMomentBySymbol.delete(position.symbol.name);
        this.logger.log(
            `[manageOpenPosition] Close ${position.symbol.name} reason=${
                tpHit ? 'TP' : slHit ? 'SL' : expired ? 'TIME' : 'TRAIL'
            } pnl=${pnlPct.toFixed(2)}%`,
        );
    }
}

