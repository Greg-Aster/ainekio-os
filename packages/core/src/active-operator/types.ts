import type { AutonomyMode } from '../queue/types.js';

/** Configuration for the active autonomy mode. */
export interface ActiveOperatorConfig {
  autonomyMode: AutonomyMode;
  semiAssessmentMinutes: number;
}

export const DEFAULT_CONFIG: ActiveOperatorConfig = {
  autonomyMode: 'reactive',
  semiAssessmentMinutes: 5,
};

export type OperatorMode = AutonomyMode;
