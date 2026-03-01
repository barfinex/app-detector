import { Injectable, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { SubscriptionType } from '@barfinex/types';
import { AlertService } from './alert.service';

type DetectorEventPayload = {
  eventId?: string;
  type?: string;
  timestamp?: number;
  payload?: {
    symbol?: { name?: string };
    side?: string;
    confidence?: number;
    strategyId?: string;
  };
};

type SubscriptionValue = {
  value?: DetectorEventPayload;
  options?: {
    connectorType?: string;
    marketType?: string;
    key?: string;
    updateMoment?: number;
  };
};

@Injectable()
export class DetectorTelegramNotifierService {
  private readonly logger = new Logger(DetectorTelegramNotifierService.name);

  constructor(private readonly alerts: AlertService) {}

  @EventPattern(SubscriptionType.DETECTOR_SIGNAL_GENERATED)
  async onSignalGenerated(@Payload() message: SubscriptionValue): Promise<void> {
    await this.forward('signal', message);
  }

  @EventPattern(SubscriptionType.DETECTOR_POSITION_OPEN_REQUEST)
  async onPositionOpen(@Payload() message: SubscriptionValue): Promise<void> {
    await this.forward('position_open', message);
  }

  @EventPattern(SubscriptionType.DETECTOR_POSITION_CLOSE_REQUEST)
  async onPositionClose(@Payload() message: SubscriptionValue): Promise<void> {
    await this.forward('position_close', message);
  }

  @EventPattern(SubscriptionType.DETECTOR_SIGNAL_INVALIDATED)
  async onSignalInvalidated(@Payload() message: SubscriptionValue): Promise<void> {
    await this.forward('signal_invalidated', message);
  }

  private async forward(kind: string, message: SubscriptionValue): Promise<void> {
    const enabled = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.DETECTOR_TELEGRAM_ENABLED ?? '').toLowerCase().trim(),
    );
    if (!enabled) return;

    const event = message?.value;
    const signal = event?.payload ?? {};
    const symbol = signal.symbol?.name ?? 'UNKNOWN';
    const side = signal.side ?? 'N/A';
    const confidence = Number(signal.confidence ?? 0);
    const strategy = signal.strategyId ?? 'detector';
    const connector = message?.options?.connectorType ?? 'unknown';
    const market = message?.options?.marketType ?? 'unknown';

    const text = `[Barfinex Detector] ${kind}`;
    const payload = {
      strategy,
      symbol,
      side,
      confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(4)) : 0,
      connector,
      market,
      eventType: event?.type ?? null,
      ts: event?.timestamp ?? Date.now(),
    };

    try {
      await this.alerts.sendMessage(text, payload);
    } catch (error) {
      this.logger.warn(
        `Telegram notify failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
