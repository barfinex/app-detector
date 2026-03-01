import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DetectorManagerService } from '@barfinex/detector';
import { AppRegistrationService } from './app-registration.service';
import { buildDetectorRegistrationSnapshot } from './detector-registration-snapshot';

/**
 * After detector is ready, pushes its config snapshot to app registry (heartbeat)
 * so provider has key, sysname, symbols, intervals, etc. and can set studioKey.
 */
@Injectable()
export class DetectorRegistrationBridgeService implements OnApplicationBootstrap {
  constructor(
    private readonly detectorManager: DetectorManagerService,
    private readonly appRegistration: AppRegistrationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const detector = this.detectorManager.getActiveDetector();
    if (!detector?.options) return;
    const snapshot = buildDetectorRegistrationSnapshot(detector.options);
    this.appRegistration.setDetectorSnapshot(snapshot);
    await this.appRegistration.heartbeatNow().catch(() => undefined);
  }
}
