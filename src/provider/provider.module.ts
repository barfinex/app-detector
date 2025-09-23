//import { HttpModule } from '@nestjs/axios';
// import { HttpModule } from 'nestjs-http-promise'
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ProviderService } from './provider.service';
// import { ProviderController } from './provider.controller';
import { AlertModule } from '../alert/alert.module';
// import { ConfigModule as NestConfigModule } from '@nestjs/config';
// import { ConfigModule as CustomConfigModule } from '@barfinex/config';

@Module({
    imports: [
        // CustomConfigModule,
        // NestConfigModule.forRoot(),
        HttpModule,
        AlertModule,
    ],
    providers: [ProviderService],
    exports: [ProviderService]
    // controllers: [ProviderController],
})
export class ProviderModule { }