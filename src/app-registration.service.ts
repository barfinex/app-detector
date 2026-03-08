import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@barfinex/config';

@Injectable()
export class AppRegistrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppRegistrationService.name);
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private detectorSnapshot: Record<string, unknown> | null = null;

  constructor(private readonly configService: ConfigService) {}

  /** Set config snapshot (key, sysname, symbols, intervals, etc.) for register/heartbeat payload. */
  setDetectorSnapshot(snapshot: Record<string, unknown> | null): void {
    this.detectorSnapshot = snapshot;
  }

  /** Trigger one heartbeat immediately (e.g. after snapshot is set). */
  async heartbeatNow(): Promise<void> {
    await this.send('/apps/registry/heartbeat', this.buildPayload());
  }

  async onModuleInit(): Promise<void> {
    await this.register();
    const intervalMs = Number(process.env.PROVIDER_REG_HEARTBEAT_MS || 15_000);
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(() => undefined);
    }, Math.max(5_000, intervalMs));
    this.heartbeatTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.unregister();
  }

  private async register(): Promise<void> {
    const payload = this.buildPayload();
    this.logger.log(
      `[app-registry] register ${JSON.stringify({
        appKey: payload.appKey,
        baseUrl: payload.baseUrl,
      })}`,
    );
    await this.send('/apps/registry/register', payload);
  }

  private async heartbeat(): Promise<void> {
    const payload = this.buildPayload();
    this.logger.debug(
      `[app-registry] heartbeat ${JSON.stringify({
        appKey: payload.appKey,
      })}`,
    );
    await this.send('/apps/registry/heartbeat', payload);
  }

  private async unregister(): Promise<void> {
    const payload = {
      appKey: this.getAppKey(),
      appType: 'detector',
      reason: 'shutdown',
    };
    this.logger.log(
      `[app-registry] unregister ${JSON.stringify({
        appKey: payload.appKey,
        reason: payload.reason,
      })}`,
    );
    await this.send('/apps/registry/unregister', payload);
  }

  private buildPayload(): Record<string, unknown> {
    const displayName =
      this.detectorSnapshot && typeof this.detectorSnapshot.sysname === 'string'
        ? this.detectorSnapshot.sysname
        : 'detector';
    const meta: Record<string, unknown> = {
      pid: process.pid,
      nodeEnv: process.env.NODE_ENV || 'development',
    };
    if (this.detectorSnapshot) {
      meta.detectorSnapshot = this.detectorSnapshot;
    }
    return {
      appKey: this.getAppKey(),
      appType: 'detector',
      baseUrl: this.getSelfBaseUrl(),
      displayName,
      version: process.env.npm_package_version || 'unknown',
      meta,
    };
  }

  private getProviderBaseUrl(): string {
    const cfg = this.configService.getConfig() as unknown as {
      provider?: { restApiUrl?: string };
    };
    const fromCfg = cfg?.provider?.restApiUrl;
    const raw =
      process.env.PROVIDER_API_URL ||
      (typeof fromCfg === 'string' && fromCfg.trim() ? fromCfg.trim() : 'http://localhost:8081/api');
    const normalized = raw.replace(/\/+$/, '');
    return normalized;
  }

  private getAppKey(): string {
    const cfg = this.configService.getConfig() as unknown as { detector?: Record<string, unknown> };
    const fromCfg = cfg?.detector?.key;
    if (typeof fromCfg === 'string' && fromCfg.trim()) return fromCfg.trim();
    return process.env.DETECTOR_APP_KEY || 'detector';
  }

  private getSelfBaseUrl(): string {
    const cfg = this.configService.getConfig() as unknown as { detector?: Record<string, unknown> };
    const fromCfg = cfg?.detector?.restApiUrl;
    if (typeof fromCfg === 'string' && fromCfg.trim()) return fromCfg.trim().replace(/\/+$/, '');
    const host = process.env.DETECTOR_PUBLIC_HOST || 'localhost';
    const port = process.env.DETECTOR_API_PORT || 8101;
    return `http://${host}:${port}/api`;
  }

  private async send(path: string, body: Record<string, unknown>): Promise<void> {
    const url = `${this.getProviderBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
    const token = process.env.PROVIDER_API_TOKEN || process.env.PROVIDER_BEARER_TOKEN || '';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      this.logger.debug(
        `[app-registry] request ${JSON.stringify({
          path,
          url,
          appKey: body.appKey,
          appType: body.appType,
        })}`,
      );
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        this.logger.warn(`[app-registry] request failed ${response.status}: ${url}`);
      } else {
        this.logger.debug(
          `[app-registry] response ${JSON.stringify({
            status: response.status,
            path,
            appKey: body.appKey,
          })}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[app-registry] provider unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
