import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, type LogLevel } from '@nestjs/common';
import { resolveDetectorConfig } from './config';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { resolve } from 'path';
import * as net from 'net';
import { buildDetectorConfig, Detector, DetectorInstanceConfig, DetectorModuleConfig } from '@barfinex/types';
import {
  FatalDetectorConfigurationError,
  validateDetectorInstanceConfig,
} from '@barfinex/detector';

// 👇 Загружаем .env.{APP_MODE}
dotenv.config({
  path: resolve(process.cwd(), `.env.${process.env.APP_MODE || 'local'}`),
});

function resolveNestLoggerLevels(): LogLevel[] {
  const level = String(process.env.LOG_LEVEL || 'log').trim().toLowerCase();
  switch (level) {
    case 'debug':
      return ['log', 'warn', 'error', 'debug'];
    case 'warn':
      return ['warn', 'error'];
    case 'error':
      return ['error'];
    case 'log':
    default:
      return ['log', 'warn', 'error'];
  }
}

async function bootstrap() {
  const config = resolveDetectorConfig();
  validateBootInstances(config);
  const PORT = config.apiPort || 8101;
  const host = '0.0.0.0';

  const isPortAvailable = await checkPortAvailability(PORT, host);
  if (!isPortAvailable) {
    throw new Error(
      `Detector startup aborted: port ${PORT} is already in use. Set DETECTOR_PORT to a free port and retry.`,
    );
  }

  // 👇 HTTPS (опционально, если заданы SSL_CERT и SSL_KEY)
  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    try {
      httpsOptions = {
        key: fs.readFileSync(resolve(process.cwd(), process.env.SSL_KEY)),
        cert: fs.readFileSync(resolve(process.cwd(), process.env.SSL_CERT)),
      };
      console.log('✅ HTTPS включён (сертификаты загружены)');
    } catch (err: any) {
      console.warn(
        `⚠️ Не удалось загрузить сертификаты (${process.env.SSL_KEY}, ${process.env.SSL_CERT}):`,
        err.message,
      );
    }
  }

  const app = await NestFactory.create(AppModule, {
    httpsOptions,
    logger: resolveNestLoggerLevels(),
  });

  // 🔹 глобальный префикс
  app.setGlobalPrefix('api', { exclude: ['metrics', 'metrics/prometheus'] });

  // 🔹 валидация DTO
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // 🔹 Swagger setup
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Detector API')
    .setDescription('API для управления детекторами и плагинами')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  registerProcessSignalHandlers(app);

  await app.listen(PORT, host);

  const proto = httpsOptions ? 'https' : 'http';
  console.log(`🚀 Detector API is running on: ${proto}://localhost:${PORT}/api`);
  console.log(`📘 Swagger docs: ${proto}://localhost:${PORT}/api/docs`);
  console.log(
    `🛰 Active detector sysName: ${config.sysName}, logLevel: ${config.logLevel}`,
  );
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ Detector bootstrap failed: ${message}`);
  process.exitCode = 1;
});

function registerProcessSignalHandlers(app: { close: () => Promise<void> }): void {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      console.log(`🛑 ${signal} received, shutting down detector...`);
      await app.close();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed during graceful shutdown: ${message}`);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

async function checkPortAvailability(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolvePromise(false);
        return;
      }
      resolvePromise(false);
    });
    server.once('listening', () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, host);
  });
}

function validateBootInstances(config: DetectorModuleConfig): void {
  const enabledInstances = (config.instances ?? []).filter((item) => item.enabled !== false);
  const bootTargets = enabledInstances.length > 0
    ? enabledInstances
    : [{ sysName: config.defaultSysName ?? config.sysName, enabled: true } as DetectorInstanceConfig];
  enforceProductionBootSafetyGate(bootTargets);
  const disabledSysNames = new Set<string>();
  const healthyBootTargets: DetectorInstanceConfig[] = [];

  for (const instance of bootTargets) {
    try {
      if (!instance?.sysName) {
        throw new FatalDetectorConfigurationError('Instance sysName is required');
      }
      const configModule = loadInstanceConfigModule(config.path, instance.sysName);
      const configClass = Object.values(configModule).find(
        (exp) => typeof exp === 'function' && exp.name.endsWith('ConfigService'),
      ) as (new () => { detector: Partial<Detector> }) | undefined;
      if (!configClass) {
        throw new FatalDetectorConfigurationError(
          `Config class is missing for detector instance "${instance.sysName}"`,
        );
      }

      const localConfigService = new configClass();
      const baseOptions = buildDetectorConfig(localConfigService.detector ?? {});
      const mergedOptions: Partial<Detector> = {
        ...baseOptions,
        ...(instance.options ?? {}),
        sysname: instance.options?.sysname ?? baseOptions.sysname ?? instance.sysName,
      };
      validateDetectorInstanceConfig(mergedOptions);
      healthyBootTargets.push(instance);
    } catch (error) {
      const sysName = String(instance?.sysName || 'unknown');
      disabledSysNames.add(sysName);
      console.warn(
        `⚠️ Detector instance disabled during bootstrap validation: ${sysName} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (Array.isArray(config.instances) && config.instances.length > 0) {
    config.instances = config.instances.map((instance) => {
      if (!instance?.sysName) {
        return { ...instance, enabled: false };
      }
      if (disabledSysNames.has(instance.sysName)) {
        return { ...instance, enabled: false };
      }
      return instance;
    });
  }

  if (healthyBootTargets.length === 0) {
    console.error(
      '⚠️ No valid detector instances passed bootstrap validation. Service will continue in degraded mode.',
    );
  }
}

function enforceProductionBootSafetyGate(instances: DetectorInstanceConfig[]): void {
  const nodeEnv = String(process.env.NODE_ENV ?? '').toLowerCase().trim();
  if (nodeEnv !== 'production') {
    return;
  }

  const forbidden = instances
    .map((instance) => instance?.sysName?.trim())
    .filter((sysName): sysName is string => Boolean(sysName))
    .filter((sysName) => isForbiddenInProduction(sysName));

  if (forbidden.length === 0) {
    return;
  }

  const uniqueForbidden = Array.from(new Set(forbidden)).sort((a, b) => a.localeCompare(b));
  for (const instance of instances) {
    const sysName = instance?.sysName?.trim();
    if (!sysName) continue;
    if (!uniqueForbidden.includes(sysName)) continue;
    instance.enabled = false;
  }
  console.warn(
    `⚠️ Production safety gate: disabled forbidden detector instances: ${uniqueForbidden.join(', ')}.`,
  );
}

function loadInstanceConfigModule(instancesPath: string, sysName: string): Record<string, unknown> {
  const dir = toKebabCase(sysName);
  const isDistRuntime = __dirname.toLowerCase().includes('\\dist\\') || fs.existsSync(resolve(process.cwd(), 'dist'));
  const extensions = isDistRuntime ? ['js', 'ts'] : ['ts', 'js'];
  const candidatePath = extensions
    .map((ext) => resolve(instancesPath, dir, `${dir}.config.${ext}`))
    .find((candidate) => fs.existsSync(candidate));
  if (!candidatePath) {
    throw new FatalDetectorConfigurationError(
      `Instance config file not found for "${sysName}" in "${instancesPath}"`,
    );
  }
  return require(candidatePath) as Record<string, unknown>;
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function isForbiddenInProduction(sysName: string): boolean {
  const normalized = toKebabCase(sysName);
  if (normalized === 'empty' || normalized === 'test' || normalized === 'template') {
    return true;
  }
  return (
    normalized === 'generated' ||
    normalized.startsWith('generated/') ||
    normalized.startsWith('generated-') ||
    normalized.startsWith('generated.')
  );
}
