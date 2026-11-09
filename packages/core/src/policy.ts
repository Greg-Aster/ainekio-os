/** Shared trust ordering used by Agency and operator policy. */

import type { TrustLevel } from './skills.js';

const TRUST_HIERARCHY: Record<TrustLevel, number> = {
  observe: 0,
  suggest: 1,
  supervised_auto: 2,
  bounded_auto: 3,
  adaptive_auto: 4,
};

/**
 * Check if current trust level meets minimum requirement
 */
export function meetsMinimumTrust(current: TrustLevel, required: TrustLevel): boolean {
  return TRUST_HIERARCHY[current] >= TRUST_HIERARCHY[required];
}
