/**
 * Centralized logging with per-module verbosity control
 */
import fs from 'node:fs';
import path from 'node:path';
import { systemPaths } from './path-builder.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export interface LoggingConfig {
  level: LogLevel;
  levels: Record<string, LogLevel>;
  audit: { enabled: boolean; retentionDays: number };
}

const defaults: LoggingConfig = {
  level: 'info', levels: {},
  audit: { enabled: true, retentionDays: 7 },
};
let cached: { version: string; value: LoggingConfig } | undefined;

/** Machine logging policy is shared by every process through its existing config file. */
export function readLoggingConfig(): LoggingConfig {
  const filename = path.join(systemPaths.etc, 'logging.json');
  let version: string;
  try {
    const stat = fs.statSync(filename, { bigint: true });
    version = `${stat.mtimeNs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { ...defaults, audit: { ...defaults.audit } };
  }
  if (cached?.version === version) return cached.value;
  const saved: Partial<LoggingConfig> = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const levels = Object.fromEntries(Object.entries(saved.levels || {}).filter(([, value]) => typeof value === 'string'));
  const value: LoggingConfig = { level: saved.level ?? defaults.level, levels,
    audit: { ...defaults.audit, ...saved.audit } };
  cached = { version, value };
  return value;
}

export function updateLoggingConfig(updates: Partial<LoggingConfig>): LoggingConfig {
  const previous = readLoggingConfig();
  const value: LoggingConfig = { level: updates.level ?? previous.level, levels: updates.levels ?? previous.levels,
    audit: { ...previous.audit, ...updates.audit } };
  const filename = path.join(systemPaths.etc, 'logging.json');
  fs.mkdirSync(systemPaths.etc, { recursive: true });
  const next = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(next, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(next, filename);
  } finally { if (fs.existsSync(next)) fs.unlinkSync(next); }
  cached = undefined;
  return value;
}

function shouldLog(module: string, level: LogLevel): boolean {
  let cfg: LoggingConfig;
  try { cfg = readLoggingConfig(); }
  catch (error) {
    process.stderr.write(`[logging] Cannot read logging policy: ${String(error)}\n`);
    return false;
  }
  const configured = cfg.levels[module];
  const moduleLevel = typeof configured === 'string' ? configured : cfg.level;
  
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'none'];
  const moduleLevelIndex = levels.indexOf(moduleLevel);
  const requestedLevelIndex = levels.indexOf(level);
  
  return requestedLevelIndex >= moduleLevelIndex;
}

export function createLogger(module: string) {
  return {
    debug: (...args: any[]) => {
      if (shouldLog(module, 'debug')) {
        console.log(`[${module}]`, ...args);
      }
    },
    info: (...args: any[]) => {
      if (shouldLog(module, 'info')) {
        console.log(`[${module}]`, ...args);
      }
    },
    warn: (...args: any[]) => {
      if (shouldLog(module, 'warn')) {
        console.warn(`[${module}]`, ...args);
      }
    },
    error: (...args: any[]) => {
      if (shouldLog(module, 'error')) {
        console.error(`[${module}]`, ...args);
      }
    },
  };
}
