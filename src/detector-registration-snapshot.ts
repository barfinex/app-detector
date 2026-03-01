import type { Detector, PluginMeta } from '@barfinex/types';

/**
 * Builds a serializable config snapshot for app registry (register/heartbeat).
 * Strips secrets (apiToken), keeps only plugin metas (no class references).
 */
export function buildDetectorRegistrationSnapshot(options: Detector): Record<string, unknown> {
  const providers = (options.providers ?? []).map((p) => ({
    key: p.key,
    restApiUrl: p.restApiUrl,
    studioGuid: p.studioGuid,
    studioName: p.studioName,
    studioDescription: p.studioDescription,
    studioSocketApiUrl: p.studioSocketApiUrl,
    connectors: p.connectors,
  }));

  const plugins =
    options.plugins && Array.isArray(options.plugins.metas)
      ? { metas: options.plugins.metas as PluginMeta[] }
      : undefined;

  return {
    key: options.key,
    sysname: options.sysname,
    logLevel: options.logLevel ?? 'info',
    currency: options.currency ?? 'USDT',
    restApiUrl: options.restApiUrl,
    providers,
    symbols: options.symbols ?? [],
    intervals: options.intervals ?? [],
    subscriptions: options.subscriptions ?? [],
    qualityGate: options.qualityGate,
    performance: options.performance,
    customConfig: options.customConfig,
    plugins,
    useSandbox: options.useSandbox,
    useScratch: options.useScratch,
    isBlocked: options.isBlocked,
    isActive: options.isActive,
  };
}
