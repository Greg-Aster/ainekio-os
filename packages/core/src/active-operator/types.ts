import type { AutonomyMode } from '../queue/types.js';

export const DEFAULT_BOREDOM_INACTIVITY_MINUTES = 10;

/** Configuration for the active autonomy mode. */
export interface ActiveOperatorConfig {
  autonomyMode: AutonomyMode;
  semiAssessmentMinutes: number;
  boredomInactivityMinutes?: number;
}

export const DEFAULT_CONFIG: ActiveOperatorConfig = {
  autonomyMode: 'reactive',
  semiAssessmentMinutes: 5,
};

export type OperatorMode = AutonomyMode;
