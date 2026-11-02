import type { AutonomyMode } from '../queue/types.js'

export type AutonomyTarget =
  | { kind: 'execution'; executionId: string }
  | { kind: 'desire'; desireId: string; operation: 'plan' | 'execute' | 'review' | 'checkin' }

export interface AutonomyMemoryRequest {
  memoryQuery?: string
  memoryOrder?: 'relevance' | 'newest'
  memoryTypes?: string[]
  memoryTimeRange?: { from?: string; before?: string }
  memorySleepCycle?: 'latest'
}

export interface ActivationUpdate {
  operationId: string
  activation: number
  reason: string
  instruction: string
  target?: AutonomyTarget | null
}

export interface ActivationAssessment {
  executionId: string
  assessedAt: string
  mode: AutonomyMode
  updates: ActivationUpdate[]
  levels: Record<string, ActivationUpdate & { assessedAt: string; mode?: AutonomyMode }>
  selected: ActivationUpdate[]
  assessmentReason?: string
  memoryRequest?: AutonomyMemoryRequest | null
}

/** Apply the Installation Owner's mode rule to the model's ordered updates. */
export function selectActivatedOperations(updates: ActivationUpdate[], mode: AutonomyMode): ActivationUpdate[] {
  if (mode === 'reactive') return []
  if (mode === 'semi') return updates.filter(update => update.activation === 100)
  const highest = updates.filter(update => update.activation > 0).reduce<ActivationUpdate | undefined>((best, update) => (
    !best || update.activation > best.activation ? update : best
  ), undefined)
  return highest ? [highest] : []
}
