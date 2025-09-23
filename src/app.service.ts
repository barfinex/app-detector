import { Connector, ConnectorType, Provider, Symbol } from '@barfinex/types';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@barfinex/config';

@Injectable()
export class AppService {

    constructor(private readonly configService: ConfigService) { }

    // getProvider(): Provider {
    //     return this.configService.getConfig().provider;
    // }

    // getDetectorApiPort(): number {
    //     return this.configService.getConfig().detector.general.apiPort;
    // }

    // getSymbols(): Symbol[] {
    //     return this.configService.getConfig().detector.symbols;
    // }

    // getQuoteCurrency(): string {
    //     return this.configService.getConfig().detector.general.quoteCurrency;
    // }

    // getSubscriptionCandles(): DetectorSubscriptionCandles {
    //     return this.configService.getConfig().detector.subscriptions.candles;
    // }

    // getDetectorGeneralConfig(): DetectorGeneralConfig {
    //     return this.configService.getConfig().detector.general;
    // }
}
