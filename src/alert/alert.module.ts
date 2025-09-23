import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertService } from './alert.service';
import { HttpModule } from '@nestjs/axios';
import { TelegrafModule } from 'nestjs-telegraf';

@Module({
  imports: [
    HttpModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('TELEGRAM_BOT_TOKEN')
      }),
    }),
  ],
  providers: [AlertService],
  exports: [AlertService],
})
export class AlertModule { }