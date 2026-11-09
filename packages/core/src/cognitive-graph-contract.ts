/**
 * Browser-safe cognitive graph contracts.
 *
 * This module has no runtime dependencies so editors and the engine share one
 * persisted contract and one set of defaults.
 */

/** The actual saved entry presented by a streamed graph response. */
export interface ResponseEntryReference {
  mode: 'conversation' | 'inner';
  id: string;
}

export type GraphConditionValue = string | number | boolean | null;

/** Tests one output without treating false, zero, or empty strings as absent. */
export interface GraphOutputCondition {
  output: string;
  equals?: GraphConditionValue;
  notEquals?: GraphConditionValue;
  truthy?: boolean;
}

export interface GraphNodeActivation {
  mode?: 'required-inputs' | 'any-input' | 'always';
  requiredInputs?: string[];
  /** All conditions must match before this node is eligible to run. */
  when?: Array<GraphOutputCondition & { nodeId: string }>;
}

export interface GraphSchedulerContract {
  version: 1;
  activation: 'demand';
  skippedState: 'explicit';
  sideEffectOrder: 'serial-topological';
  /** 0 permits an ongoing event-driven behavior; positive values bound graph loops. */
  maxLoopIterations: number;
  /** Explicit input tail to resume when new input arrives as this invocation finishes. */
  eventInputNodeId?: string;
}

export const DEFAULT_GRAPH_SCHEDULER: GraphSchedulerContract = {
  version: 1,
  activation: 'demand',
  skippedState: 'explicit',
  sideEffectOrder: 'serial-topological',
  maxLoopIterations: 5,
};
