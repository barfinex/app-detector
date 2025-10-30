import * as fs from 'fs';
import * as path from 'path';
import { DetectorConfig, DetectorModuleConfig } from '@barfinex/types';

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

    // 🔍 динамически грузим configClass для нужного инстанса
    const instanceConfigPath = path.join(__dirname, 'instances', sysDir, `${sysDir}.config.js`);
    let plugins: DetectorModuleConfig['plugins'] | undefined;

    console.log('📂 Loading instance config from:', instanceConfigPath);

    if (fs.existsSync(instanceConfigPath)) {
        try {
            const raw = require(instanceConfigPath);
            const instanceConfig = raw.default ?? raw;
            console.log('📦 instanceConfig keys:', Object.keys(instanceConfig));

            if (instanceConfig.pluginModules && instanceConfig.pluginMetas) {
                plugins = {
                    modules: instanceConfig.pluginModules,
                    metas: instanceConfig.pluginMetas,
                };
                console.log('✅ Plugins loaded:', {
                    modules: instanceConfig.pluginModules.length,
                    metas: instanceConfig.pluginMetas.length,
                });
            } else {
                console.warn('⚠️ No pluginModules/metas found in instance config!');
            }
        } catch (err: any) {
            console.error('❌ Ошибка загрузки instance config:', err.message);
        }
    } else {
        console.warn(`⚠️ Instance config not found at ${instanceConfigPath}`);
    }

    return {
        apiPort: +(process.env.DETECTOR_API_PORT || jsonConfig.apiPort || 3000),
        sysName,
        logLevel: process.env.DETECTOR_LOG_LEVEL || jsonConfig.logLevel || 'info',
        path: process.env.DETECTOR_PATH || jsonConfig.path || path.join(__dirname, 'instances'),
        plugins, // 👈 сюда попадут плагины инстанса
    };
}
