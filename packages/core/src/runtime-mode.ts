/**
 * Persisted headless startup state. The CLI skips boot-managed agents when this
 * flag is set. The routed UI/API changes the flag without stopping or resuming
 * running agents.
 */

import fs from 'fs';
import path from 'path';
import { systemPaths } from './path-builder.js';
import { audit } from './audit.js';

const RUNTIME_CONFIG_PATH = path.join(systemPaths.etc, 'runtime.json');

export interface RuntimeState {
  /** Skip boot-managed agents at system startup */
  headless: boolean;
  /** Who last changed the mode ('local' user or 'remote' session) */
  lastChangedBy: 'local' | 'remote';
  /** ISO timestamp of last mode change */
  changedAt: string;
  /** User ID who claimed runtime (null if not claimed) */
  claimedBy: string | null;
}

/**
 * Load runtime mode configuration
 */
export function getRuntimeMode(): RuntimeState {
  const defaultState: RuntimeState = {
    headless: false,
    lastChangedBy: 'local',
    changedAt: new Date().toISOString(),
    claimedBy: null,
  };

  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      const data = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8');
      return { ...defaultState, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error('[runtime-mode] Failed to load config:', error);
  }

  return defaultState;
}

/**
 * Save runtime mode configuration
 */
export function setRuntimeMode(
  partial: Partial<RuntimeState>,
  actor?: string
): void {
  try {
    const current = getRuntimeMode();
    const updated: RuntimeState = {
      ...current,
      ...partial,
      changedAt: new Date().toISOString(),
    };

    // Ensure etc/ directory exists
    const etcDir = systemPaths.etc;
    if (!fs.existsSync(etcDir)) {
      fs.mkdirSync(etcDir, { recursive: true });
    }

    // Atomic write with backup
    const tmpPath = RUNTIME_CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
    fs.renameSync(tmpPath, RUNTIME_CONFIG_PATH);

    // Audit the state change
    audit({
      category: 'system',
      level: 'info',
      event: 'runtime_mode_changed',
      message: `Runtime mode changed: ${current.headless ? 'headless' : 'active'} → ${updated.headless ? 'headless' : 'active'}`,
      metadata: {
        actor: actor || 'system',
        previousState: current,
        newState: updated,
        reason: updated.headless ? 'entering_headless_mode' : 'exiting_headless_mode',
      },
    });
  } catch (error) {
    console.error('[runtime-mode] Failed to save config:', error);
    throw error;
  }
}

/**
 * Check if currently in headless mode
 */
export function isHeadless(): boolean {
  return getRuntimeMode().headless;
}
