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
    TimeFrame,
    DetectorConfigInput,
    DetectorEventType,
} from '@barfinex/types';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { PluginDriverService } from '@barfinex/plugin-driver';
import { KeyService } from '@barfinex/key';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';

import {
    SmaCrossoverTelegramConfigService,
    SmaCrossoverTelegramCustomConfig,
} from './sma-crossover-telegram.config';
import { Logger } from '@nestjs/common';

/** Ключ для хранения последних SMA по символу и таймфрейму */
function smaKey(symbol: string, interval: TimeFrame): string {
    return `${symbol}:${interval}`;
}

@Injectable()
export class SmaCrossoverTelegramService extends DetectorService {
    protected readonly logger = new Logger(SmaCrossoverTelegramService.name);

    /** Последние значения short/long SMA по символу и интервалу (для детекции пересечения) */
    private lastSma: Record<
        string,
        { short: number; long: number }
    > = {};

    constructor(
        @Inject(forwardRef(() => PluginDriverService))
        protected pluginDriverService: PluginDriverService,
        protected readonly connectorService: ConnectorService,
        protected readonly keyService: KeyService,
        protected readonly orderService: OrderService,
        protected readonly configService: ConfigService,
        @Inject('PROVIDER_SERVICE') client: ClientProxy,
        protected readonly localConfig: SmaCrossoverTelegramConfigService,
        mergedInitial?: Partial<Detector>,
    ) {
        const local = (localConfig?.detector ?? {}) as DetectorConfigInput;
        if (!local.providers || local.providers.length === 0) {
            throw new Error(
                '[SmaCrossoverTelegramService] No providers in config.',
            );
        }
        super(
            pluginDriverService,
            connectorService,
            keyService,
            orderService,
            configService,
            client,
            localConfig,
            mergedInitial,
        );
    }

    async onInit(): Promise<void> {
        this.logger.log('[onInit] SmaCrossoverTelegram: только уведомления в Telegram, сделок нет.');
    }

    async onTrade(trade: Trade): Promise<void> {
        // не нужны трейды для SMA по свечам
    }

    async onCandleUpdate(candle: Candle, trade: Trade): Promise<void> {
        // логика только по закрытию свечи
    }

    async onCandleOpen(candle: Candle): Promise<void> {
        // не используем
    }

    async onCandleClose(candle: Candle): Promise<void> {
        const { symbol, interval, close: closePrice } = candle;

        if (!interval || !this.options.intervals.includes(interval)) return;

        const cfg = (this.options.customConfig ?? {}) as SmaCrossoverTelegramCustomConfig;
        const shortPeriod = cfg.shortSmaPeriod ?? 10;
        const longPeriod = cfg.longSmaPeriod ?? 30;

        const candles = this.getSymbolCandlesState(symbol, interval, 'desc');
        if (!candles || candles.length < longPeriod) return;

        const shortSma =
            candles.slice(0, shortPeriod).reduce((sum, c) => sum + c.close, 0) / shortPeriod;
        const longSma =
            candles.slice(0, longPeriod).reduce((sum, c) => sum + c.close, 0) / longPeriod;

        const key = smaKey(symbol.name, interval);
        const prev = this.lastSma[key];

        this.lastSma[key] = { short: shortSma, long: longSma };

        if (!prev) return;

        // Пересечение снизу вверх: короткая SMA пересекает длинную снизу → LONG
        if (prev.short < prev.long && shortSma > longSma) {
            this.logger.log(
                `[SMA] LONG ${symbol.name} ${interval}: short=${shortSma.toFixed(2)} > long=${longSma.toFixed(2)}`,
            );
            this.registerEvent(DetectorEventType.ENTRY_SIGNAL, {
                symbols: [symbol],
                side: 'LONG',
                confidence: 1,
                message: `SMA crossover LONG: ${symbol.name} ${interval}, short=${shortSma.toFixed(2)} long=${longSma.toFixed(2)}`,
            });
        }

        // Пересечение сверху вниз: короткая SMA пересекает длинную сверху → SHORT
        if (prev.short > prev.long && shortSma < longSma) {
            this.logger.log(
                `[SMA] SHORT ${symbol.name} ${interval}: short=${shortSma.toFixed(2)} < long=${longSma.toFixed(2)}`,
            );
            this.registerEvent(DetectorEventType.ENTRY_SIGNAL, {
                symbols: [symbol],
                side: 'SHORT',
                confidence: 1,
                message: `SMA crossover SHORT: ${symbol.name} ${interval}, short=${shortSma.toFixed(2)} long=${longSma.toFixed(2)}`,
            });
        }
    }

    async onOrderClose(order: Order): Promise<void> {
        this.logger.debug(`[onOrderClose] ${order.symbol?.name ?? ''}`);
    }

    async onOrderOpen(order: Order): Promise<void> {
        this.logger.debug(`[onOrderOpen] ${order.symbol?.name ?? ''}`);
    }

    async onAccountUpdate(account: Account): Promise<void> {
        this.logger.debug(
            `[onAccountUpdate] ${account.connectorType}/${account.marketType}`,
        );
    }

    async onOrderBookUpdate(orderbook: OrderBook): Promise<void> {
        // не используем
    }
}
