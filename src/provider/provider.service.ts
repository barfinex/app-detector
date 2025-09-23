import { ConsoleLogger, ForbiddenException, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
// import axios from 'axios';
import { catchError, map, lastValueFrom, interval, of, throwError } from 'rxjs';
import { mergeMap, retry } from 'rxjs/operators';
import { Account, Detector, MarketType, Order, ConnectorType, OrderType, TimeFrame, Candle } from '@barfinex/types';
import { AlertService } from '../alert/alert.service';
import { type } from 'os';

@Injectable()
export class ProviderService {

    constructor(private http: HttpService, private alertService: AlertService) { }

    private isDebug: boolean = true

    async sendMessage(text: string, object: any): Promise<any> {

        await this.alertService.sendMessage(text, object);
    }

}