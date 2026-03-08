import * as fs from 'fs';
import * as path from 'path';
import { DetectorConfig, DetectorInstanceConfig, DetectorModuleConfig } from '@barfinex/types';

/**
 * Утилита для перевода SysName → kebab-case
 *  VolumeFollow → volume-follow
 *  FollowTrend  → follow-trend
 */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function resolveInstanceConfigPath(sysDir: string): string {
  const isDistRuntime =
    __dirname.toLowerCase().includes(`${path.sep}dist${path.sep}`) ||
    fs.existsSync(path.join(process.cwd(), 'dist'));

  const extensions = isDistRuntime ? ['js', 'ts'] : ['ts', 'js'];
  const candidates = extensions.map((ext) =>
    path.join(__dirname, 'instances', sysDir, `${sysDir}.config.${ext}`),
  );
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(
      `[detector-config] Instance config for "${sysDir}" was not found. Tried: ${candidates.join(', ')}`,
    );
  }
  return resolved;
}

function loadPluginsFromInstanceConfig(sysDir: string): DetectorModuleConfig['plugins'] | undefined {
  try {
    const instanceConfigPath = resolveInstanceConfigPath(sysDir);
    const raw = require(instanceConfigPath);
    const instanceConfig = raw.default ?? raw;
    const pluginModules = Array.isArray(instanceConfig.pluginModules) ? instanceConfig.pluginModules : [];
    const pluginMetas = Array.isArray(instanceConfig.pluginMetas) ? instanceConfig.pluginMetas : [];
    if (pluginModules.length === 0 && pluginMetas.length === 0) {
      return undefined;
    }
    return {
      modules: pluginModules,
      metas: pluginMetas,
    };
  } catch (error) {
    console.warn(
      `[detector-config] plugin config unavailable for "${sysDir}", continuing without plugins: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

export function resolveDetectorConfig(): DetectorModuleConfig {
  let jsonConfig: Partial<DetectorConfig> = {};

  try {
    const configPath = path.join(process.cwd(), 'config', 'config.detector.json');
    if (fs.existsSync(configPath)) {
      jsonConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')).general ?? {};
    }
  } catch (err: any) {
    console.error('⚠️ Ошибка чтения config.detector.json:', err.message);
  }

  const sysName = process.env.DETECTOR_SYSNAME || jsonConfig.sysName || 'test';
  const sysDir = toKebabCase(sysName);
  const defaultSysName =
    process.env.DETECTOR_DEFAULT_SYSNAME ||
    jsonConfig.defaultSysName ||
    jsonConfig.sysName ||
    sysName;
  const envMultiEnabled = process.env.DETECTOR_MULTI_ENABLED;
  const multiEnabled =
    envMultiEnabled === undefined
      ? jsonConfig.multiEnabled ?? true
      : ['1', 'true', 'yes', 'on'].includes(envMultiEnabled.toLowerCase().trim());
  const configuredInstances = Array.isArray(jsonConfig.instances)
    ? (jsonConfig.instances as DetectorInstanceConfig[])
    : [];
  const instances = configuredInstances.length > 0
    ? configuredInstances
    : [{ sysName, enabled: true }];
  const sanitizedInstances = sanitizeDetectorInstances(instances);
  const plugins = loadPluginsFromInstanceConfig(sysDir);

  return {
    apiPort: +(process.env.DETECTOR_PORT || process.env.DETECTOR_API_PORT || jsonConfig.apiPort || 3000),
    sysName,
    defaultSysName,
    multiEnabled,
    instances: sanitizedInstances,
    logLevel: process.env.DETECTOR_LOG_LEVEL || jsonConfig.logLevel || 'info',
    path: process.env.DETECTOR_PATH || jsonConfig.path || path.join(__dirname, 'instances'),
    plugins,
  };
}

function sanitizeDetectorInstances(instances: DetectorInstanceConfig[]): DetectorInstanceConfig[] {
  const isProduction = String(process.env.NODE_ENV ?? '').toLowerCase().trim() === 'production';
  return instances.map((instance) => {
    const sys = String(instance?.sysName || '').trim();
    if (!sys) {
      return { ...instance, enabled: false };
    }

    if (isProduction && isForbiddenInProduction(sys)) {
      console.warn(
        `[detector-config] disabling forbidden production instance "${sys}"`,
      );
      return { ...instance, enabled: false };
    }

    try {
      resolveInstanceConfigPath(toKebabCase(sys));
      return instance;
    } catch (error) {
      console.warn(
        `[detector-config] disabling instance "${sys}" because config file is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { ...instance, enabled: false };
    }
  });
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
