import {
    Injectable,
    Logger,
    LoggerService,
  } from '@nestjs/common';
  
  @Injectable()
  export class CommonService {
    private readonly loggerService: LoggerService;
  
    constructor() {
      this.loggerService = new Logger(CommonService.name);
    }
  }
  