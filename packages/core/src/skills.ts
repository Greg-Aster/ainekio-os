/** Shared trust and policy contracts used by Agency and the operator. */

import fs from 'node:fs';
import { storageClient } from './storage-client.js';

export type SkillRisk = 'low' | 'medium' | 'high';
export type TrustLevel = 'observe' | 'suggest' | 'supervised_auto' | 'bounded_auto' | 'adaptive_auto';
const TRUST_LEVEL_VALUES: readonly TrustLevel[] = [
  'observe',
  'suggest',
  'supervised_auto',
  'bounded_auto',
  'adaptive_auto',
];
/**
 * Load current trust level from persona/decision-rules.json
 */
export function loadTrustLevel(options: { strict?: boolean } = {}): TrustLevel {
  try {
    const result = storageClient.resolvePath({
      category: 'config',
      subcategory: 'persona',
      relativePath: 'decision-rules.json',
    });
    if (!result.success || !result.path) {
      throw new Error(result.error || 'Could not resolve decision-rules path');
    }
    const data = fs.readFileSync(result.path, 'utf-8');
    const rules = JSON.parse(data);
    // Handle both trustLevel and trust_level for compatibility
    const trustLevel = rules.trustLevel ?? rules.trust_level;
    if (!TRUST_LEVEL_VALUES.includes(trustLevel)) {
      throw new Error(`Unsupported trust level: ${String(trustLevel)}`);
    }
    return trustLevel;
  } catch (error) {
    if (options.strict) {
      throw new Error(`Could not load trust level: ${(error as Error).message}`, { cause: error });
    }
    console.warn('[skills] Could not load trust level, defaulting to observe');
    return 'observe';
  }
}
