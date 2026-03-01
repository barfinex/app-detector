import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { DetectorCoreModule, DetectorModule } from '@barfinex/detector';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ConfigModule as CustomConfigModule } from '@barfinex/config';
import { ConnectorModule } from '@barfinex/connectors';

import { resolveDetectorConfig } from './config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { RiskController } from './risk/risk.controller';
import { OrderModule } from '@barfinex/orders';
import { AppRegistrationService } from './app-registration.service';
import { DetectorRegistrationBridgeService } from './detector-registration-bridge.service';
import { AlertModule } from './alert/alert.module';
import { DetectorTelegramNotifierService } from './alert/detector-telegram-notifier.service';

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
        // DetectorCoreModule,
        DetectorModule.register(resolveDetectorConfig()),

        // 🔹 клиент для Redis
        ClientsModule.register([
            {
                name: 'PROVIDER_SERVICE',
                transport: Transport.REDIS,
                options: {
                    host: process.env.REDIS_HOST || 'localhost',
                    port: +(process.env.REDIS_PORT || 6379),
                    retryAttempts: 10,
                    retryDelay: 5000,
                },
            },
        ]),
    ],
    controllers: [AppController, RiskController],
    providers: [
        AppService,
        AppRegistrationService,
        DetectorRegistrationBridgeService,
        DetectorTelegramNotifierService,
    ],
})
export class AppModule { }
