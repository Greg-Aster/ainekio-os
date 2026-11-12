import type { EnvironmentObservation } from '@metahuman/core'

export type Specialist = 'intent' | 'task'
export type CaseSplit = 'development' | 'evaluation' | 'regression'
export interface ContextRequirement {
  required: string[]
  optional: string[]
  anyOf?: string[][]
}
export type IntentRequirements = Partial<Record<'taskContext' | 'conversationContext', ContextRequirement>>
export interface SpecialistCase {
  id: string
  specialist: Specialist
  suite: string
  risk: 'low' | 'high'
  fold: number
  split: CaseSplit
  instructions: string[]
  routes: Record<string, boolean | string | string[]>
  inputs?: Record<string, unknown>
  expected: Record<string, any>
  targets?: Record<number, Record<string, any>>
  contextRequirements?: IntentRequirements
  responseOptional?: true
  inputSource?: 'user' | 'autonomy'
  outputContract?: 'autonomy-context'
  visualTask?: true
  taskEvidence?: Record<string, unknown>
}
export const ROUTE_FIELDS = ['needsResponse', 'needsAction', 'needsGoalReview', 'needsToolUse', 'taskPlanner', 'taskContext', 'conversationContext'] as const
export const intentOutput = (task: string[], conversation: string[], response = true, action = false, goalReview = false) => ({
  needsResponse: response, needsAction: action, needsGoalReview: goalReview, needsToolUse: false, taskContext: task, conversationContext: conversation,
})
// Synthetic corpus annotations only; runtime route decisions belong to the model.
export function routes(selected: string[], memoryQuery?: string, personaSections = ['personality']): SpecialistCase['routes'] {
  const fields: Record<string, string> = { needsConversationHistory: 'conversationHistory', needsMemory: 'memory',
    needsRobotStatus: 'robotStatus', needsEnvironment: 'environment', needsVision: 'vision', needsExecutionContext: 'executionContext' }
  const sources = selected.flatMap(field => fields[field] ? [fields[field]!] : [])
  const persona = selected.includes('needsPersona') ? personaSections.map(section => `persona.${section}`) : []
  const needsResponse = selected.includes('needsResponse'), needsAction = selected.includes('needsAction')
  return { needsResponse, needsAction, needsGoalReview: selected.includes('needsGoalReview'),
    taskContext: needsAction || !needsResponse ? [...sources, ...(!needsResponse ? persona : [])] : [],
    conversationContext: needsResponse ? [...(needsAction ? [] : sources), ...persona] : [],
    ...(memoryQuery ? { memoryQuery } : {}) }
}
export const cases: SpecialistCase[] = []
/** Reviewed corpus choice; never a runtime routing rule or prompt directive. */
export function allowResponseChoice(source: SpecialistCase): void {
  source.responseOptional = true
  source.contextRequirements = { ...source.contextRequirements,
    conversationContext: { required: [], optional: ['persona.personality'] } }
}
export function addCase(specialist: Specialist, suite: string, instructions: string[], selected: string[],
  expected: Record<string, any> | null, inputs: Record<string, unknown> = {}, split: CaseSplit = 'development', memoryQuery?: string, personaSections?: string[]) {
  const familyIndex = cases.filter(item => item.specialist === specialist && item.split === split).length
  const routing = specialist === 'intent' && expected ? expected : routes(selected, memoryQuery, personaSections)
  if (specialist === 'intent') {
    routing.needsToolUse ??= false
    routing.needsGoalReview ??= false
  }
  cases.push({ id: `${specialist}-${split}-${String(familyIndex + 1).padStart(3, '0')}`, specialist, suite,
    risk: routing.needsAction === true || (Array.isArray(routing.taskContext) && routing.taskContext.includes('executionContext')) ? 'high' : 'low',
    fold: familyIndex % 4, split, instructions, routes: routing, inputs, expected: expected ?? routing })
  return cases[cases.length - 1]!
}
export const TIME = '2030-01-15T12:00:00.000Z'
export const RETIRED_GAIT_DIRECTIONS = new Set([
  'walk', 'walk_forward', 'walk_backward', 'backward', 'forward', 'left', 'right',
  'turn_left', 'turn_right', 'run', 'crawl', 'crab', 'crab_backward', 'crab_forward',
  'crab_right', 'crab_turn_left', 'crab_turn_right',
])
export function observation(): EnvironmentObservation {
  return { adapter: 'synthetic-training-adapter', environmentId: 'training-room', sessionId: 'training-body', timestamp: TIME,
    state: { batteryPercent: 72, posture: 'standing' }, capabilities: {
      actions: ['requestMotion', 'move', 'stop', 'captureImage', 'faceExpression'],
      expressionLibrary: [
        { name: 'neutral', label: 'Neutral resting face' },
        { name: 'happy', label: 'Warm cheerful face' },
        { name: 'curious', label: 'Attentive curious face' },
      ],
      movement: true, visual: true,
    } }
}
export const task = (objective: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({
  taskDecision: { objective, completionCriteria: 'The selected program receives correlated completion results.',
    outcome: 'act', reason: 'The current request selects this activity.', continuationPolicy: 'none',
    requiredCompletionBasis: 'action_result', ...extra }, program: { steps },
})
export const action = (name: string) => {
  if (name === 'stop') return { kind: 'action', action: { type: 'stop' } }
  if (RETIRED_GAIT_DIRECTIONS.has(name)) return { kind: 'action', action: { type: 'move', direction: name } }
  return { kind: 'action', action: { type: 'requestMotion', description: name } }
}
export const noTask = () => ({ taskDecision: null, program: null })
