import { Controller, Get } from '@nestjs/common';
import { AlertService } from './alert.service';

@Controller()
export class AlertController {
    constructor(private alertService: AlertService) { }

    // @Get('price/bitcoin')
    // setDetector() {
    //     return this.providerService.getBitcoinPrice();
    // }

    // @Get('facts/cats')
    // getCatFacts() {
    //     return this.apiService.getAccountInfo();
    // }

    // @Get('facts/cats/deprecated')
    // getCatFactsWithAxiosLib() {
    //     return this.apiService.getCatFactsWithAxiosLib();
    // }
}