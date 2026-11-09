/**
 * Active Operator System
 *
 * Bounded autonomy policy and user-control services above the core work
 * coordinator. This module owns no executable queue and invokes no executor.
 *
 * The queue, work lifecycle, ordering, execution registry, and recovery owner
 * is packages/core/src/queue.
 */

// Types
export * from './types.js';

// State persistence
export {
  loadConfig as loadActiveOperatorConfig,
  saveConfig as saveActiveOperatorConfig,
  updateConfig as updateActiveOperatorConfig,
} from './state-persister.js';

// Mode controller
export {
  ModeController,
  getModeController,
  getOperatorMode,
} from './mode-controller.js';
