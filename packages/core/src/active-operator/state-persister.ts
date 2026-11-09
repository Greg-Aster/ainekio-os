/**
 * Persistence for Active Operator mode.
 *
 * Executable work and in-progress recovery live only in packages/core/src/queue.
 * This module persists autonomy admission configuration and nothing else.
 */

import fs from 'node:fs';
import path from 'node:path';
import { systemPaths } from '../paths.js';
import type { ActiveOperatorConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export const ACTIVE_OPERATOR_CONFIG_FILE = path.join(systemPaths.etc, 'active-operator.json');

function normalizeConfig(loaded: Partial<ActiveOperatorConfig> & { semiInactivityMinutes?: number }): ActiveOperatorConfig {
  const interval = loaded.semiAssessmentMinutes ?? loaded.semiInactivityMinutes;
  return {
    autonomyMode: ['reactive', 'semi', 'full'].includes(loaded.autonomyMode || '')
      ? loaded.autonomyMode!
      : DEFAULT_CONFIG.autonomyMode,
    semiAssessmentMinutes: typeof interval === 'number'
      && Number.isFinite(interval) && interval > 0
      ? interval : DEFAULT_CONFIG.semiAssessmentMinutes,
  };
}

export function loadConfig(): ActiveOperatorConfig {
  try {
    if (!fs.existsSync(ACTIVE_OPERATOR_CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    return normalizeConfig(JSON.parse(fs.readFileSync(ACTIVE_OPERATOR_CONFIG_FILE, 'utf8')));
  } catch (error) {
    console.error('[active-operator] Failed to load config:', error);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: ActiveOperatorConfig): void {
  fs.mkdirSync(path.dirname(ACTIVE_OPERATOR_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(ACTIVE_OPERATOR_CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function updateConfig(updates: Partial<ActiveOperatorConfig>): ActiveOperatorConfig {
  const current = loadConfig();
  const updated = normalizeConfig({
    ...current,
    ...updates,
  });
  saveConfig(updated);
  return updated;
}
