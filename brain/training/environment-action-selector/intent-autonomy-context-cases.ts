import { createHash } from 'node:crypto'
import { addCase, intentOutput, type CaseSplit } from './development-cases.js'

// Synthetic selector requests, never runtime rules. Each family keeps its
// clock/catalog/camera siblings together; private diagnostics are not fitted.
const operations = [
  ['robot-autonomy-executor', 'Robot Autonomy Executor'], ['robot-status', 'Robot Status'],
  ['boredom-observer', 'Boredom Observer'], ['boredom-movement', 'Boredom Movement'],
  ['boredom-reflection', 'Boredom Reflection'], ['reflector', 'Mind Wandering'],
  ['daydreamer', 'Daydreamer'], ['curiosity', 'Curiosity'],
  ['curiosity-researcher', 'Curiosity Researcher'], ['inner-curiosity', 'Inner Curiosity'],
  ['train-of-thought', 'Train of Thought'], ['desire-agent', 'Desire Agent'], ['sleep-workflow', 'Sleep Workflow'],
]
const situations = [
  { id: 'open-activities', levels: {}, sources: ['persona.goals', 'persona.values', 'desires', 'activityHistory', 'conversationHistory'] },
  { id: 'ongoing-execution', levels: { 'robot-autonomy-executor': 100 }, sources: ['executionContext', 'activityHistory', 'conversationHistory', 'robotStatus', 'environment'] },
  { id: 'environment-interest', levels: { 'boredom-observer': 95 }, sources: ['environment', 'observationHistory', 'robotStatus', 'activityHistory', 'conversationHistory'] },
  { id: 'inner-interests', levels: { 'inner-curiosity': 75, 'desire-agent': 65 }, sources: ['persona.personality', 'persona.goals', 'innerDialogue', 'desires', 'activityHistory'] },
]
const topics = {
  development: ['shared astronomy project', 'learning a new board game', 'the garden observations', 'an unfinished drawing'],
  evaluation: ['the model railway project', 'our pottery lesson', 'the coastal field notes', 'a half-built kite'],
}
for (const split of ['development', 'evaluation'] as const) {
  for (let fold = 0; fold < 4; fold++) for (const situation of situations) for (const mode of ['semi', 'full'] as const) {
    for (const recall of [false, true]) {
      const topic = topics[split][fold]!
      const memory = recall ? { memoryQuery: topic, memoryTypes: ['conversation'] } : {}
      const required = [...situation.sources]
      if (recall) required.push('memory')
      const instructions = Array.from({ length: split === 'development' ? 4 : 2 }, (_, variant) => {
        const camera = variant % 2 === 0
        const date = `${split === 'development' ? '2031-03' : '2032-08'}-${String(8 + fold * 3 + variant % 3).padStart(2, '0')}`
        const identity = createHash('sha256').update(`${split}:${situation.id}:${fold}:${recall}:${variant}`).digest('hex')
        const catalog = variant % 3 === 0 ? operations : variant % 3 === 1 ? [...operations].reverse()
          : operations.filter(([id], index) => index < 5 || Object.hasOwn(situation.levels, id!))
        return JSON.stringify({
          trigger: { cycleId: `${identity.slice(0, 8)}-${identity.slice(8, 12)}-${identity.slice(12, 16)}-${identity.slice(16, 20)}-${identity.slice(20, 32)}`, step: 1,
            triggerSource: 'autonomy', graph: 'robot-autonomy-controller', requestedBy: 'robot-autonomy-controller' },
          sourceObservationAt: `${date}T12:00:00.000Z`, previousMemoryRequest: recall ? memory : null,
          mode, localTime: `${date}T12:01:00.000Z`, timeZone: 'UTC',
          operations: catalog
            .map(([id, name]) => ({ id, name, activation: (situation.levels as Record<string, number>)[id!] ?? 0,
              assessedAt: `${date}T12:00:00.000Z` })),
          sourceAvailability: { persona: true, conversationHistory: true, innerDialogue: true, robotActions: true,
            memory: true, robotStatus: true, environment: true, vision: camera, executionContext: true,
            activityHistory: true, observationHistory: true, desires: true },
        })
      })
      const source = addCase('intent', `autonomy-context-${situation.id}-${recall ? 'recall' : 'assessment'}`, instructions, [], {
        ...intentOutput(required, [], false, false), needsToolUse: false, taskPlanner: 'specialist', ...memory,
      }, {}, split as CaseSplit)
      source.id = `intent-${split}-autonomy-context-${situation.id}-${mode}-${fold}-${recall ? 'recall' : 'assessment'}`
      source.fold = fold
      source.inputSource = 'autonomy'
      source.outputContract = 'autonomy-context'
      source.contextRequirements = {
        taskContext: { required,
          optional: [...new Set(['persona.identity', 'persona.background', 'persona.personality', 'persona.values', 'persona.goals',
            'conversationHistory', 'innerDialogue', 'robotActions', 'robotStatus', 'environment', 'executionContext', 'observationHistory', 'desires'])]
            .filter(value => !required.includes(value)) },
        conversationContext: { required: [], optional: [] },
      }
    }
  }
}
