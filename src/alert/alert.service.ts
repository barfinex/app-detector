import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { from, lastValueFrom } from 'rxjs';
import { catchError, retry } from 'rxjs/operators';

@Injectable()
export class AlertService {
    private readonly logger = new Logger(AlertService.name);
    private lastSentAt = 0;
    private lastFingerprint = '';

    constructor(@InjectBot() private readonly bot: Telegraf) { }

    /**
     * Test the bot: retrieves information about the bot.
     * @returns A Promise resolving with bot information.
     */
    public async testBot(): Promise<any> {
        const request = from(this.bot.telegram.getMe()) // Convert Promise to Observable
            .pipe(
                retry(2), // Retry the operation twice in case of failure
                catchError((error) => {
                    throw new Error(`Failed to fetch bot info: ${error.message}`);
                })
            );

        return await lastValueFrom(request); // Convert Observable back to Promise
    }

    /**
     * Sends a message to a Telegram channel.
     * @param text - The message text to send.
     * @param object - Additional data to include in the message.
     * @returns A Promise resolving with the response from Telegram.
     */
    public async sendMessage(text: string, object: any): Promise<any> {
        const chatId =
            process.env.DETECTOR_TELEGRAM_CHAT_ID ||
            process.env.TELEGRAM_CHAT_ID ||
            '';
        if (!chatId) {
            throw new Error(
                'Telegram chat is not configured. Set DETECTOR_TELEGRAM_CHAT_ID or TELEGRAM_CHAT_ID.',
            );
        }

        const message = `${text} ${JSON.stringify(object)}`;
        const minIntervalMs = Number(
            process.env.DETECTOR_TELEGRAM_MIN_INTERVAL_MS || 15_000,
        );
        const dedupWindowMs = Number(
            process.env.DETECTOR_TELEGRAM_DEDUP_WINDOW_MS || 120_000,
        );
        const now = Date.now();
        const fingerprint = `${chatId}|${message}`;

        // Best-practice anti-spam gate: throttle + duplicate suppression.
        if (now - this.lastSentAt < minIntervalMs) {
            this.logger.warn('Telegram message suppressed by throttle window');
            return { suppressed: true, reason: 'throttle' };
        }
        if (
            this.lastFingerprint === fingerprint &&
            now - this.lastSentAt < dedupWindowMs
        ) {
            this.logger.warn('Telegram message suppressed as duplicate');
            return { suppressed: true, reason: 'duplicate' };
        }

        const request = from(
            this.bot.telegram.sendMessage(chatId, message),
        ).pipe(
            retry(2), // Retry the operation twice in case of failure
            catchError((error) => {
                throw new Error(`Failed to send message: ${error.message}`);
            })
        );

        const response = await lastValueFrom(request); // Convert Observable back to Promise
        this.lastSentAt = now;
        this.lastFingerprint = fingerprint;
        return response;
    }
}
