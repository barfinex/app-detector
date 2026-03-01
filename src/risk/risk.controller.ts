import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { ConnectorService } from '@barfinex/connectors';
import { OrderService } from '@barfinex/orders';
import { ConnectorType, MarketType, TradeSide } from '@barfinex/types';

type ClosePositionRequest = {
  symbol: string;
  connectorType: ConnectorType;
  marketType: MarketType;
  side?: TradeSide;
  quantity?: number;
  reason: string;
};

@Controller('risk')
export class RiskController {
  constructor(
    private readonly connectorService: ConnectorService,
    private readonly orderService: OrderService,
  ) {}

  @Post('close-position')
  async closePosition(@Body() body: ClosePositionRequest) {
    const readOnly = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.DETECTOR_READONLY ?? '').toLowerCase().trim(),
    );
    if (readOnly) {
      throw new ForbiddenException(
        'Detector is running in read-only mode (DETECTOR_READONLY=true)',
      );
    }

    const providerRestApiUrl =
      process.env.DETECTOR_PROVIDER_API_URL ||
      process.env.PROVIDER_API_URL ||
      `http://localhost:${process.env.PROVIDER_API_PORT || 8080}/api`;

    const account = await this.connectorService.getAccount({
      providerRestApiUrl,
      connectorType: body.connectorType,
      marketType: body.marketType,
    });

    const position = account.positions.find(
      p =>
        p.symbol?.name === body.symbol &&
        (body.side ? p.side === body.side : true),
    );
    if (!position) {
      return {
        success: false,
        message: `Position ${body.symbol} not found`,
      };
    }

    const result = await this.orderService.closePosition({
      account,
      position,
      quantity: body.quantity,
      providerRestApiUrl,
    });

    return {
      success: true,
      reason: body.reason,
      orderId: result.order.externalId,
      symbol: body.symbol,
      side: position.side,
      closedQuantity: body.quantity ?? position.quantity,
    };
  }
}
