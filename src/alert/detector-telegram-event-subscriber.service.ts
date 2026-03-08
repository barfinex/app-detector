import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBusService } from '@barfinex/event-bus';
import { SubscriptionType } from '@barfinex/types';
import { DetectorTelegramNotifierService } from './detector-telegram-notifier.service';

@Injectable()
export class DetectorTelegramEventSubscriberService implements OnModuleInit {
  constructor(
    private readonly eventBus: EventBusService,
    private readonly notifier: DetectorTelegramNotifierService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribe({
      channel: SubscriptionType.DETECTOR_SIGNAL_GENERATED,
      subscriptionId: `detector-telegram:${SubscriptionType.DETECTOR_SIGNAL_GENERATED}`,
      handler: (payload) => this.notifier.onSignalGenerated(payload),
    });
    await this.eventBus.subscribe({
      channel: SubscriptionType.DETECTOR_POSITION_OPEN_REQUEST,
      subscriptionId: `detector-telegram:${SubscriptionType.DETECTOR_POSITION_OPEN_REQUEST}`,
      handler: (payload) => this.notifier.onPositionOpen(payload),
    });
    await this.eventBus.subscribe({
      channel: SubscriptionType.DETECTOR_POSITION_CLOSE_REQUEST,
      subscriptionId: `detector-telegram:${SubscriptionType.DETECTOR_POSITION_CLOSE_REQUEST}`,
      handler: (payload) => this.notifier.onPositionClose(payload),
    });
    await this.eventBus.subscribe({
      channel: SubscriptionType.DETECTOR_SIGNAL_INVALIDATED,
      subscriptionId: `detector-telegram:${SubscriptionType.DETECTOR_SIGNAL_INVALIDATED}`,
      handler: (payload) => this.notifier.onSignalInvalidated(payload),
    });
  }
}
