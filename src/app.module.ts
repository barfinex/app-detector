import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { DetectorModule } from '@barfinex/detector';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ConfigModule as CustomConfigModule } from '@barfinex/config';
import { ConnectorModule } from '@barfinex/connectors';

import { resolveDetectorConfig } from './config';
import { RiskController } from './risk/risk.controller';
import { OrderModule } from '@barfinex/orders';
import { AppRegistrationService } from './app-registration.service';
import { DetectorRegistrationBridgeService } from './detector-registration-bridge.service';
import { AlertModule } from './alert/alert.module';
import { DetectorTelegramNotifierService } from './alert/detector-telegram-notifier.service';
import { DetectorTelegramEventSubscriberService } from './alert/detector-telegram-event-subscriber.service';
import { MetricsModule } from './metrics/metrics.module';

// import { builtinPluginModules, builtinPluginMetas } from './plugins.config';

@Module({
    imports: [
        // 🔹 глобальный конфиг NestJS
        NestConfigModule.forRoot({
            envFilePath:
                process.env.NODE_ENV === 'production'
                    ? '.env.production'
                    : '.env.local',
            isGlobal: true,
        }),

        // 🔹 твой кастомный конфиг
        CustomConfigModule,

        // 🔹 модули Barfinex
        ConnectorModule,
        OrderModule,
        AlertModule,
        MetricsModule,
        // DetectorCoreModule,
        DetectorModule.register(resolveDetectorConfig()),

    ],
    controllers: [AppController, RiskController],
    providers: [
        AppService,
        AppRegistrationService,
        DetectorRegistrationBridgeService,
        DetectorTelegramNotifierService,
        DetectorTelegramEventSubscriberService,
    ],
})
export class AppModule { }
