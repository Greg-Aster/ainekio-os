// Synthetic corpus migration only. Runtime behavior is selected by the model;
// Core remains the owner of the advertised interface and execution contract.

export function refreshLocomotionFixture(inputs: Record<string, any>): void {
  const capabilities = inputs.observation?.capabilities
  if (!capabilities || !capabilities.actions.includes('move')) return
  capabilities.locomotion = {
    ...capabilities.locomotion,
    commands: capabilities.locomotion?.commands ?? ['walk', 'crawl', 'run', 'crab'],
    goalKinds: ['distance', 'relativeTurn', 'approach', 'follow', 'visual'],
  }
}

export function migrateLocomotionReference(expected: Record<string, any>): { output: Record<string, any>; reason?: string } {
  const steps = expected.program?.steps ?? []
  if (steps.some((step: any) => step.action?.type === 'move' && !step.action.locomotionGoal)) {
    return { output: { delegatePlanning: true }, reason: 'Retired bare gait or cycle-based action requires planning under the goal-directed locomotion contract.' }
  }
  let changed = false
  for (const step of steps) {
    if (step.kind === 'behavior' && step.motion && !step.motion.locomotionGoal) {
      step.motion.locomotionGoal = { kind: 'visual', target: step.target, completionCriteria: step.completionCriteria }
      changed = true
    }
  }
  return { output: expected, ...(changed ? { reason: 'Existing visual behavior target and completion criteria retained as its explicit locomotion goal.' } : {}) }
}
