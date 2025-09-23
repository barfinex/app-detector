import { Injectable } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { from, Observable, lastValueFrom } from 'rxjs';
import { catchError, retry, map } from 'rxjs/operators';

@Injectable()
export class AlertService {
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
        const message = `${text} ${JSON.stringify(object)}`;

        const request = from(
            this.bot.telegram.sendMessage('@barfinex_network', message) // Send message via Telegram bot
        ).pipe(
            retry(2), // Retry the operation twice in case of failure
            catchError((error) => {
                throw new Error(`Failed to send message: ${error.message}`);
            })
        );

        return await lastValueFrom(request); // Convert Observable back to Promise
    }
}
