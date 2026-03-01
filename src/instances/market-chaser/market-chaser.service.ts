// apps/detector/src/instances/market-chaser/market-chaser.service.ts
import {
    forwardRef,
    Inject,
    Injectable,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    ConnectorType,
    MarketType,
    DetectorEventType,
    SignalDirection,
    TradeSide as TradeSideEnum,
    Symbol as SymbolType,
} from '@barfinex/types';
import { DetectorService } from '@barfinex/detector';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { MarketChaserConfigService, MarketChaserCustomConfig } from './market-chaser.config';

/**
 * IMPORTANT: this file assumes you already have:
 * - base DetectorService with:
 *    - registerEvent(eventType, payload)
 *    - openPosition({ symbol, side, quantity, connectorType, marketType, ... })
 *    - closePosition({ symbol, connectorType, marketType, ... })
 *    - maybe getCurrentPosition(...) or on position events
 * - market data events emitted in app via EventEmitter:
 *    - ORDERBOOK_UPDATED payload matches your template
 *    - CANDLE_UPDATED for h1 OR pipeline input (DetectorInput) events
 *
 * If your project uses pipeline DetectorInput/SignalSchema:
 * - Replace the market handlers below with a single handler receiving DetectorInput.
 */

type TradeSide = 'LONG' | 'SHORT';

type InstrumentIdentity = {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
};

type OrderBookLite = {
    bestBid: number;
    bestAsk: number;
    spreadPct: number;
    depth: number;
    ts: number;
};

type CandlePoint = {
    time: number;
    open?: number;
    high?: number;
    low?: number;
    close: number;
    volume?: number;
};

type Params = MarketChaserCustomConfig;

type State = {
    // market
    lastPrice: number | null;
    book: OrderBookLite | null;

    // candles (h1)
    candlesH1: CandlePoint[];

    // indicators
    emaFast: number | null;
    emaSlow: number | null;
    atr: number | null;
    trend: TradeSide | null;
    trailingStop: number | null;

    // position lifecycle
    positionSide: TradeSide | null;
    positionQty: number;
    entryPrice: number | null;

    // orchestration locks
    mode: 'IDLE' | 'OPENING' | 'IN_POSITION' | 'CLOSING' | 'FLIPPING' | 'BLOCKED';
    activeIntentId: string | null;
    activeOrderId: string | null;
    activeSinceTs: number | null;

    // risk / stats
    flipCooldownUntilTs: number;
    consecutiveFlips: number;
    dayPnlUsd: number;
    dayStartTs: number;

    // quality gate
    stopTradingMode: boolean;

    // pending flip (open opposite after close)
    pendingOpenSide: TradeSide | null;
    pendingOpenReason: string | null;
    requoteCount: number;
};

function now(): number {
    return Date.now();
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

// --- Indicator helpers (simple, stable, no deps) ---
function emaNext(prevEma: number | null, price: number, len: number): number {
    const k = 2 / (len + 1);
    if (prevEma == null) return price;
    return price * k + prevEma * (1 - k);
}

function trueRange(prevClose: number, high: number, low: number): number {
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function computeAtrSeries(candles: CandlePoint[], atrLen: number): number | null {
    // Wilder ATR: start with SMA(TR), then recursive
    if (candles.length < atrLen + 1) return null;

    // ensure we have high/low
    const hasHL = candles.every((c) => typeof c.high === 'number' && typeof c.low === 'number');
    if (!hasHL) return null;

    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const cur = candles[i];
        trs.push(trueRange(prev.close, cur.high!, cur.low!));
    }

    if (trs.length < atrLen) return null;

    // initial ATR = SMA of first atrLen TRs
    let atr = 0;
    for (let i = 0; i < atrLen; i++) atr += trs[i];
    atr /= atrLen;

    // Wilder smoothing for remaining
    for (let i = atrLen; i < trs.length; i++) {
        atr = (atr * (atrLen - 1) + trs[i]) / atrLen;
    }

    return atr;
}

function sideToSignalDirection(side: TradeSide): SignalDirection {
    return side === 'LONG' ? 'LONG' : 'SHORT';
}

function makeIntentId(sysname: string, reason: string): string {
    return `${sysname}:${reason}:${now()}`;
}

@Injectable()
export class MarketChaserService extends DetectorService implements OnModuleInit, OnModuleDestroy {

    private readonly sysname = 'MarketChaser';

    private readonly p: Params;
    private readonly instrument: InstrumentIdentity;

    private state: State;

    constructor(
        @Inject(forwardRef(() => PluginDriverService))
        protected readonly pluginDriverService: PluginDriverService,
        protected readonly connectorService: ConnectorService,
        protected readonly keyService: KeyService,
        protected readonly orderService: OrderService,
        protected readonly configService: ConfigService,
        @Inject('PROVIDER_SERVICE') protected readonly client: ClientProxy,
        @Optional()
        @Inject('DETECTOR_CONFIG_SERVICE')
        private readonly localConfig?: MarketChaserConfigService,
    ) {
        super(
            pluginDriverService,
            connectorService,
            keyService,
            orderService,
            configService,
            client,
            localConfig,
        );

        const params = (this.options.customConfig ?? {}) as Partial<Params>;
        this.p = {
            symbol: params.symbol ?? 'BTCUSDT',
            connectorType: (params.connectorType ?? ConnectorType.binance) as ConnectorType,
            marketType: (params.marketType ?? MarketType.futures) as MarketType,
            interval: 'h1',
            emaFastLen: params.emaFastLen ?? 21,
            emaSlowLen: params.emaSlowLen ?? 55,
            atrLen: params.atrLen ?? 14,
            atrMult: params.atrMult ?? 2.5,
            notionalUsd: params.notionalUsd ?? 2,
            tickOffset: params.tickOffset ?? 0.5,
            entryTimeoutMs: params.entryTimeoutMs ?? 2000,
            maxRequotes: params.maxRequotes ?? 3,
            fallbackToMarket: params.fallbackToMarket ?? true,
            maxSpreadPct: params.maxSpreadPct ?? 0.001,
            minDepth: params.minDepth ?? 10,
            minFlipCooldownSec: params.minFlipCooldownSec ?? 90,
            maxConsecutiveFlips: params.maxConsecutiveFlips ?? 8,
            maxDailyLossUsd: params.maxDailyLossUsd ?? 15,
            requireMaturity: params.requireMaturity ?? 'INTRADAY',
        };

        this.instrument = {
            symbol: this.p.symbol,
            connectorType: this.p.connectorType,
            marketType: this.p.marketType,
        };

        this.state = this.initState();
    }

    private initState(): State {
        return {
            lastPrice: null,
            book: null,
            candlesH1: [],

            emaFast: null,
            emaSlow: null,
            atr: null,
            trend: null,
            trailingStop: null,

            positionSide: null,
            positionQty: 0,
            entryPrice: null,

            mode: 'IDLE',
            activeIntentId: null,
            activeOrderId: null,
            activeSinceTs: null,

            flipCooldownUntilTs: 0,
            consecutiveFlips: 0,
            dayPnlUsd: 0,
            dayStartTs: now(),

            stopTradingMode: false,

            pendingOpenSide: null,
            pendingOpenReason: null,
            requoteCount: 0,
        };
    }

    // ============================================================
    // Lifecycle
    // ============================================================
    onModuleInit(): void {
        this.registerEvent(DetectorEventType.DETECTOR_STARTED, { symbols: [] });
    }

    async onModuleDestroy(): Promise<void> {
        this.registerEvent(DetectorEventType.DETECTOR_STOPPED, { symbols: [] });
    }

    // ============================================================
    // Market events handlers (adjust event names if yours differ)
    // ============================================================

    @OnEvent(DetectorEventType.ORDERBOOK_UPDATED)
    onOrderbookUpdated(payload: any): void {
        // payload per template:
        // { symbols:[{name}], bestBid,bestAsk,spreadPct,depth,connectorType,marketType,ts }
        if (!this.isOurInstrument(payload)) return;

        const bestBid = Number(payload.bestBid);
        const bestAsk = Number(payload.bestAsk);

        if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return;

        this.state.book = {
            bestBid,
            bestAsk,
            spreadPct: Number(payload.spreadPct ?? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2))),
            depth: Number(payload.depth ?? 0),
            ts: Number(payload.ts ?? now()),
        };

        // If we don't have last trade price, approximate by mid
        if (this.state.lastPrice == null) {
            this.state.lastPrice = (bestAsk + bestBid) / 2;
        }

        void this.evaluateAndAct('ORDERBOOK_UPDATED');
    }

    @OnEvent(DetectorEventType.TICK_RECEIVED)
    onTick(payload: any): void {
        // payload per template: {symbols:[{name}], price, quantity}
        if (!this.isOurSymbol(payload)) return;

        const price = Number(payload.price);
        if (!Number.isFinite(price) || price <= 0) return;

        this.state.lastPrice = price;

        void this.evaluateAndAct('TICK_RECEIVED');
    }

    @OnEvent(DetectorEventType.CANDLE_UPDATED)
    onCandleUpdated(payload: any): void {
        // expected: { symbols:[{name}], interval, open, high, low, close, volume?, ts? }
        if (!this.isOurSymbol(payload)) return;
        if (payload.interval !== this.p.interval) return;

        const c: CandlePoint = {
            time: Number(payload.ts ?? now()),
            open: payload.open != null ? Number(payload.open) : undefined,
            high: payload.high != null ? Number(payload.high) : undefined,
            low: payload.low != null ? Number(payload.low) : undefined,
            close: Number(payload.close),
            volume: payload.volume != null ? Number(payload.volume) : undefined,
        };

        if (!Number.isFinite(c.close) || c.close <= 0) return;

        // Maintain rolling window (~400 candles enough for EMA55 + ATR)
        const arr = this.state.candlesH1;
        arr.push(c);
        if (arr.length > 500) arr.shift();

        // Update indicators
        this.state.emaFast = emaNext(this.state.emaFast, c.close, this.p.emaFastLen);
        this.state.emaSlow = emaNext(this.state.emaSlow, c.close, this.p.emaSlowLen);
        this.state.atr = computeAtrSeries(arr, this.p.atrLen);

        const prevTrend = this.state.trend;
        this.state.trend = this.deriveTrend();
        this.updateTrailingStopFromPrice();

        this.registerEvent(DetectorEventType.INDICATOR_UPDATED, {
            symbols: [{ name: this.p.symbol }],
            interval: this.p.interval,
            key: 'marketChaser.indicators',
            prev: {
                emaFast: prevTrend ? this.state.emaFast : undefined,
            },
            next: {
                emaFast: this.state.emaFast,
                emaSlow: this.state.emaSlow,
                atr: this.state.atr,
                trend: this.state.trend,
                trailingStop: this.state.trailingStop,
            },
            meta: {
                emaFastLen: this.p.emaFastLen,
                emaSlowLen: this.p.emaSlowLen,
                atrLen: this.p.atrLen,
                atrMult: this.p.atrMult,
            },
            ts: now(),
        });

        void this.evaluateAndAct('CANDLE_UPDATED');
    }

    // Optional: if you emit risk context updates
    @OnEvent(DetectorEventType.RISK_CONTEXT_UPDATED)
    onRiskContextUpdated(payload: any): void {
        if (!payload?.symbols?.some((s: any) => s?.name === this.p.symbol) && payload?.symbols?.[0] !== this.p.symbol) return;
        if (payload.stopTradingMode === true) {
            this.state.stopTradingMode = true;
            this.state.mode = 'BLOCKED';
            this.registerEvent(DetectorEventType.RISK_TRIGGERED, {
                symbols: [{ name: this.p.symbol }],
                reason: 'stopTradingMode from risk context',
            });
        }
    }

    // ============================================================
    // Order / Position events (adjust to your actual event names)
    // ============================================================

    @OnEvent(DetectorEventType.ORDER_PLACED)
    onOrderPlaced(payload: any): void {
        // If your exchange layer emits order id, capture it
        // payload: { order }
        const order = payload?.order;
        const symbol = order?.symbol?.name ?? payload?.symbols?.[0]?.name;
        if (symbol !== this.p.symbol) return;

        this.state.activeOrderId = order?.id ?? this.state.activeOrderId;

        // keep state as is; we will timeout/await fill
    }

    @OnEvent(DetectorEventType.ORDER_FILLED)
    onOrderFilled(payload: any): void {
        const order = payload?.order;
        const symbol = order?.symbol?.name ?? payload?.symbols?.[0]?.name;
        if (symbol !== this.p.symbol) return;

        // You might distinguish open vs close fills by order.reduceOnly or some field.
        // We'll infer by mode.
        if (this.state.mode === 'OPENING' || this.state.mode === 'FLIPPING') {
            // Open fill -> position opened
            const side: TradeSide = (order?.side === 'BUY' ? 'LONG' : 'SHORT') as TradeSide;
            const qty = Number(order?.filledQuantity ?? order?.quantity ?? 0);
            const entryPrice = Number(order?.avgPrice ?? order?.price ?? this.state.lastPrice ?? 0);

            this.state.positionSide = side;
            this.state.positionQty = qty;
            this.state.entryPrice = entryPrice;
            this.state.mode = 'IN_POSITION';
            this.state.activeOrderId = null;
            this.state.activeIntentId = null;
            this.state.activeSinceTs = null;
            this.state.requoteCount = 0;

            this.updateTrailingStopFromPrice(true);

            this.registerEvent(DetectorEventType.POSITION_OPENED, {
                symbols: [{ name: this.p.symbol }],
                side,
                quantity: qty,
                entryPrice,
                connectorType: this.p.connectorType,
                marketType: this.p.marketType,
                ts: now(),
            });

            return;
        }

        if (this.state.mode === 'CLOSING') {
            // Close fill -> position closed
            const closePrice = Number(order?.avgPrice ?? order?.price ?? this.state.lastPrice ?? 0);
            const qty = this.state.positionQty;

            const pnlAbs = this.estimatePnlUsd(closePrice);
            const pnlPct = this.estimatePnlPct(closePrice);

            this.state.dayPnlUsd += pnlAbs;

            this.registerEvent(DetectorEventType.POSITION_CLOSED, {
                symbols: [{ name: this.p.symbol }],
                side: this.state.positionSide,
                closePrice,
                quantity: qty,
                pnlAbs,
                pnlPct,
                ts: now(),
            });

            this.registerEvent(DetectorEventType.PERFORMANCE_SNAPSHOT, {
                symbols: [{ name: this.p.symbol }],
                snapshot: {
                    dayPnlUsd: this.state.dayPnlUsd,
                    consecutiveFlips: this.state.consecutiveFlips,
                },
                ts: now(),
            });

            // Reset position
            this.state.positionSide = null;
            this.state.positionQty = 0;
            this.state.entryPrice = null;
            this.state.trailingStop = null;

            this.state.activeOrderId = null;
            this.state.activeSinceTs = null;
            this.state.mode = 'IDLE';

            void this.evaluateAndAct('AFTER_CLOSE_FILLED');
        }
    }

    // ============================================================
    // Core decision loop
    // ============================================================

    private async evaluateAndAct(reason: string): Promise<void> {
        // daily reset (simple 24h rolling)
        if (now() - this.state.dayStartTs > 24 * 60 * 60 * 1000) {
            this.state.dayStartTs = now();
            this.state.dayPnlUsd = 0;
            this.state.consecutiveFlips = 0;
        }

        // Pending flip: open opposite side after close
        if (this.state.mode === 'IDLE' && this.state.pendingOpenSide) {
            const pendingSide = this.state.pendingOpenSide;
            const pendingReason = this.state.pendingOpenReason ?? 'pendingFlipOpen';
            this.state.pendingOpenSide = null;
            this.state.pendingOpenReason = null;
            await this.tryOpen(pendingSide, pendingReason);
            return;
        }

        // Hard block
        if (this.state.stopTradingMode) {
            this.registerNoAction(`blocked: stopTradingMode (${reason})`);
            return;
        }

        // Need price + book at least for execution gating
        const lastPrice = this.state.lastPrice;
        const book = this.state.book;
        if (lastPrice == null || book == null) {
            this.registerNoAction(`waiting market refs (${reason})`);
            return;
        }

        // Indicator readiness
        const trend = this.state.trend;
        const atr = this.state.atr;
        if (trend == null || atr == null || !Number.isFinite(atr) || atr <= 0) {
            this.registerNoAction(`waiting indicators (${reason})`);
            return;
        }

        // Quality gates
        const gate = this.checkQualityGates(reason);
        if (!gate.allowed) {
            this.registerNoAction(`quality gate: ${gate.reason}`);
            return;
        }

        // Order lifecycle guard: if we're in OPENING/CLOSING/FLIPPING, handle timeout only
        if (this.state.mode === 'OPENING' || this.state.mode === 'CLOSING' || this.state.mode === 'FLIPPING') {
            await this.checkActiveIntentTimeout();
            return;
        }
        if (this.state.mode === 'BLOCKED') {
            this.registerNoAction(`mode BLOCKED (${reason})`);
            return;
        }

        // Always-in-market logic:
        if (this.state.positionSide == null) {
            await this.tryOpen(trend, `open:${trend}:${reason}`);
            return;
        }

        // In position: update trailing and maybe flip
        this.updateTrailingStopFromPrice();

        const stop = this.state.trailingStop;
        if (stop == null) {
            this.registerNoAction(`no trailing stop (${reason})`);
            return;
        }

        if (this.state.positionSide === 'LONG' && lastPrice < stop) {
            await this.tryFlip('SHORT', `flip:LONG->SHORT stop_breach (${reason})`);
            return;
        }

        if (this.state.positionSide === 'SHORT' && lastPrice > stop) {
            await this.tryFlip('LONG', `flip:SHORT->LONG stop_breach (${reason})`);
            return;
        }

        // Optionally: if trend changed against our position, flip earlier (but can cause chop).
        // We'll keep MVP strict: stop breach triggers flip.
        this.registerNoAction(`holding ${this.state.positionSide} (${reason})`);
    }

    private deriveTrend(): TradeSide | null {
        if (this.state.emaFast == null || this.state.emaSlow == null) return null;
        if (this.state.emaFast > this.state.emaSlow) return 'LONG';
        if (this.state.emaFast < this.state.emaSlow) return 'SHORT';
        return this.state.trend; // unchanged
    }

    private updateTrailingStopFromPrice(forceReset = false): void {
        const lastPrice = this.state.lastPrice;
        const atr = this.state.atr;
        if (lastPrice == null || atr == null || atr <= 0) return;

        const side = this.state.positionSide;
        if (side == null) return;

        const k = this.p.atrMult;

        if (side === 'LONG') {
            const candidate = lastPrice - k * atr;
            if (forceReset || this.state.trailingStop == null) {
                this.state.trailingStop = candidate;
            } else {
                this.state.trailingStop = Math.max(this.state.trailingStop, candidate);
            }
            return;
        }

        if (side === 'SHORT') {
            const candidate = lastPrice + k * atr;
            if (forceReset || this.state.trailingStop == null) {
                this.state.trailingStop = candidate;
            } else {
                this.state.trailingStop = Math.min(this.state.trailingStop, candidate);
            }
        }
    }

    private checkQualityGates(reason: string): { allowed: boolean; reason: string | null } {
        const book = this.state.book!;
        const spreadOk = book.spreadPct <= this.p.maxSpreadPct;
        const depthOk = book.depth >= this.p.minDepth;
        const cooldownOk = now() >= this.state.flipCooldownUntilTs;

        // Data maturity: if you have it from pipeline, wire it in.
        // For now, we assume OK.
        const maturityOk = true;

        const lossOk = this.state.dayPnlUsd >= -Math.abs(this.p.maxDailyLossUsd);
        const flipsOk = this.state.consecutiveFlips <= this.p.maxConsecutiveFlips;

        const allowed = spreadOk && depthOk && cooldownOk && maturityOk && lossOk && flipsOk;

        const gateReason =
            !spreadOk
                ? `spreadPct ${book.spreadPct} > max ${this.p.maxSpreadPct}`
                : !depthOk
                    ? `depth ${book.depth} < min ${this.p.minDepth}`
                    : !cooldownOk
                        ? `flip cooldown active`
                        : !lossOk
                            ? `daily loss limit hit dayPnlUsd=${this.state.dayPnlUsd}`
                            : !flipsOk
                                ? `max consecutive flips hit=${this.state.consecutiveFlips}`
                                : null;

        this.registerEvent(DetectorEventType.CONDITION_EVALUATED, {
            symbols: [{ name: this.p.symbol }],
            conditionId: 'marketChaser.qualityGates',
            result: { allowed, reason: gateReason, trigger: reason },
            ts: now(),
        });

        if (gateReason) {
            this.registerEvent(DetectorEventType.QUALITY_GATE_STATE, {
                symbols: [{ name: this.p.symbol }],
                allowed: false,
                reason: gateReason,
                ts: now(),
            });
        } else {
            this.registerEvent(DetectorEventType.QUALITY_GATE_STATE, {
                symbols: [{ name: this.p.symbol }],
                allowed: true,
                reason: null,
                ts: now(),
            });
        }

        return { allowed, reason: gateReason };
    }

    private async tryOpen(side: TradeSide, reason: string): Promise<void> {
        if (this.state.mode !== 'IDLE') return;

        const book = this.state.book!;
        const lastPrice = this.state.lastPrice!;

        const qty = this.computeQty(lastPrice);
        if (qty <= 0) {
            this.registerNoAction(`qty<=0 (${reason})`);
            return;
        }

        const intentId = makeIntentId(this.sysname, reason);
        this.state.activeIntentId = intentId;
        this.state.activeSinceTs = now();
        this.state.mode = 'OPENING';

        // “best point” limit price close to top-of-book
        const limitPrice = this.computeEntryLimitPrice(side, book);

        this.registerEvent(DetectorEventType.ENTRY_SIGNAL, {
            symbols: [{ name: this.p.symbol }],
            side: sideToSignalDirection(side),
            confidence: 0.60,
            reason,
            entryPrice: limitPrice,
            ts: now(),
            intentId,
        });

        const symbolObj: SymbolType = { name: this.p.symbol };
        const sideEnum = side === 'LONG' ? TradeSideEnum.LONG : TradeSideEnum.SHORT;

        try {
            await this.openPosition({
                symbol: symbolObj,
                side: sideEnum,
                quantity: qty,
                price: limitPrice,
                connectorType: this.p.connectorType,
                marketType: this.p.marketType,
            });

            this.registerEvent(DetectorEventType.ORDER_PLACED, {
                symbols: [symbolObj],
                order: {
                    symbol: symbolObj,
                    side: side === 'LONG' ? 'BUY' : 'SELL',
                    type: 'LIMIT',
                    price: limitPrice,
                    quantity: qty,
                    intentId,
                },
            });
        } catch (e: any) {
            this.state.mode = 'IDLE';
            this.state.activeIntentId = null;
            this.state.activeSinceTs = null;

            this.registerEvent(DetectorEventType.ERROR_OCCURRED, {
                symbols: [{ name: this.p.symbol }],
                reason: 'openPosition failed',
                error: String(e?.message ?? e),
            });
        }
    }

    private async tryFlip(targetSide: TradeSide, reason: string): Promise<void> {
        // cooldown + risk counters
        if (now() < this.state.flipCooldownUntilTs) {
            this.registerNoAction(`flip blocked by cooldown (${reason})`);
            return;
        }

        // If already in target direction, no flip
        if (this.state.positionSide === targetSide) {
            this.registerNoAction(`already ${targetSide} (${reason})`);
            return;
        }

        // count flips
        this.state.consecutiveFlips += 1;
        this.state.flipCooldownUntilTs = now() + this.p.minFlipCooldownSec * 1000;

        // Close first (MVP safe)
        this.state.mode = 'CLOSING';
        const intentId = makeIntentId(this.sysname, reason);
        this.state.activeIntentId = intentId;
        this.state.activeSinceTs = now();

        this.registerEvent(DetectorEventType.EXIT_SIGNAL, {
            symbols: [{ name: this.p.symbol }],
            side: this.state.positionSide ? sideToSignalDirection(this.state.positionSide) : undefined,
            reason,
            ts: now(),
            intentId,
        });

        const symbolObj: SymbolType = { name: this.p.symbol };
        const position = this.positions.findBySymbol(symbolObj);
        if (!position) {
            this.logger.warn(`[tryFlip] No position in manager for ${this.p.symbol}, cannot close`);
            this.state.mode = 'IDLE';
            this.state.activeIntentId = null;
            this.state.activeSinceTs = null;
            this.state.pendingOpenSide = targetSide;
            this.state.pendingOpenReason = reason;
            await this.evaluateAndAct('AFTER_CLOSE_SKIP_NO_POSITION');
            return;
        }

        try {
            await this.closePosition({
                position,
                connectorType: this.p.connectorType,
                marketType: this.p.marketType,
            });
        } catch (e: any) {
            this.state.stopTradingMode = true;
            this.state.mode = 'BLOCKED';
            this.registerEvent(DetectorEventType.RISK_TRIGGERED, {
                symbols: [{ name: this.p.symbol }],
                reason: `closePosition failed during flip: ${String(e?.message ?? e)}`,
            });
            return;
        }

        this.state.pendingOpenSide = targetSide;
        this.state.pendingOpenReason = reason;
        this.state.positionSide = null;
        this.state.positionQty = 0;
        this.state.entryPrice = null;
        this.state.trailingStop = null;
        this.state.mode = 'IDLE';
        this.state.activeOrderId = null;
        this.state.activeIntentId = null;
        this.state.activeSinceTs = null;
        await this.evaluateAndAct('AFTER_CLOSE_FILLED');
    }

    private async checkActiveIntentTimeout(): Promise<void> {
        if (this.state.activeSinceTs == null) return;
        const elapsed = now() - this.state.activeSinceTs;

        if (elapsed < this.p.entryTimeoutMs) return;

        // Only handle timeouts for OPENING (entry chase); for CLOSING we keep waiting.
        if (this.state.mode !== 'OPENING') return;

        const book = this.state.book;
        const lastPrice = this.state.lastPrice;
        if (!book || !lastPrice) return;

        const retries = this.state.requoteCount;

        if (retries < this.p.maxRequotes) {
            this.state.requoteCount = retries + 1;
            this.state.activeSinceTs = now();

            const side = this.state.trend; // entry direction
            if (!side) return;

            const newLimitPrice = this.computeEntryLimitPrice(side, book);

            // In a perfect world: cancel old order + place new limit
            // MVP: just place another openPosition intent (your OMS should dedupe by intentId or you cancel by order id)
            const intentId = this.state.activeIntentId ?? makeIntentId(this.sysname, 'requote');
            this.registerEvent(DetectorEventType.CONFIG_UPDATED, {
                symbols: [{ name: this.p.symbol }],
                scope: 'plugin',
                pluginName: this.sysname,
                change: { requote: retries + 1, newLimitPrice },
                ts: now(),
            });

            try {
                const qty = this.computeQty(lastPrice);
                const symbolObj: SymbolType = { name: this.p.symbol };
                await this.openPosition({
                    symbol: symbolObj,
                    side: side === 'LONG' ? TradeSideEnum.LONG : TradeSideEnum.SHORT,
                    quantity: qty,
                    price: newLimitPrice,
                    connectorType: this.p.connectorType,
                    marketType: this.p.marketType,
                });
            } catch (e: any) {
                this.registerEvent(DetectorEventType.ERROR_OCCURRED, {
                    symbols: [{ name: this.p.symbol }],
                    reason: 'requote openPosition failed',
                    error: String(e?.message ?? e),
                });
            }

            return;
        }

        // fallback to market
        if (this.p.fallbackToMarket) {
            const side = this.state.trend;
            if (!side) return;

            this.registerEvent(DetectorEventType.CONFIG_UPDATED, {
                symbols: [{ name: this.p.symbol }],
                scope: 'plugin',
                pluginName: this.sysname,
                change: { fallbackToMarket: true },
                ts: now(),
            });

            try {
                const qty = this.computeQty(lastPrice);
                const symbolObj: SymbolType = { name: this.p.symbol };
                await this.openPosition({
                    symbol: symbolObj,
                    side: side === 'LONG' ? TradeSideEnum.LONG : TradeSideEnum.SHORT,
                    quantity: qty,
                    connectorType: this.p.connectorType,
                    marketType: this.p.marketType,
                });
            } catch (e: any) {
                this.state.stopTradingMode = true;
                this.state.mode = 'BLOCKED';
                this.registerEvent(DetectorEventType.RISK_TRIGGERED, {
                    symbols: [{ name: this.p.symbol }],
                    reason: `fallback MARKET open failed: ${String(e?.message ?? e)}`,
                });
            }
        }
    }

    // ============================================================
    // Utils
    // ============================================================

    private computeQty(lastPrice: number): number {
        const notional = Math.max(0, this.p.notionalUsd);
        if (notional === 0) return 0;
        const raw = notional / lastPrice;

        // BTC qty precision in futures often 0.001 or 0.0001 depending on venue.
        // Without meta, pick a safe-ish rounding (6 decimals).
        const qty = Math.floor(raw * 1e6) / 1e6;
        return qty;
    }

    private computeEntryLimitPrice(side: TradeSide, book: OrderBookLite): number {
        const bid = book.bestBid;
        const ask = book.bestAsk;

        // We don’t know tickSize; approximate “offset” as very small relative move
        const mid = (ask + bid) / 2;
        const approxTick = Math.max(mid * 0.000001, 0.1); // ~0.0001% or 0.1$ fallback

        const offset = this.p.tickOffset * approxTick;

        if (side === 'LONG') {
            // chase buy near bid, but not above ask
            return clamp(bid + offset, bid, ask);
        }
        // SHORT
        return clamp(ask - offset, bid, ask);
    }

    private estimatePnlUsd(closePrice: number): number {
        if (this.state.entryPrice == null || this.state.positionSide == null) return 0;
        const entry = this.state.entryPrice;
        const qty = this.state.positionQty;

        if (this.state.positionSide === 'LONG') return (closePrice - entry) * qty;
        return (entry - closePrice) * qty;
    }

    private estimatePnlPct(closePrice: number): number {
        if (this.state.entryPrice == null) return 0;
        const pnlUsd = this.estimatePnlUsd(closePrice);
        const entryNotional = this.state.entryPrice * Math.max(this.state.positionQty, 0);
        if (entryNotional <= 0) return 0;
        return pnlUsd / entryNotional;
    }

    private registerNoAction(reason: string): void {
        this.registerEvent(DetectorEventType.NO_ACTION, {
            symbols: [{ name: this.p.symbol }],
            reason,
            ts: now(),
        });
    }

    private isOurSymbol(payload: any): boolean {
        const s = payload?.symbols?.[0]?.name ?? payload?.symbols?.[0];
        return s === this.p.symbol;
    }

    private isOurInstrument(payload: any): boolean {
        if (!this.isOurSymbol(payload)) return false;
        const ct = payload?.connectorType ?? this.p.connectorType;
        const mt = payload?.marketType ?? this.p.marketType;
        return ct === this.p.connectorType && mt === this.p.marketType;
    }
}