import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEnvironmentSelectorJsonSchema, validateEnvironmentSelectorOutput } from '../../environment-interface/task-selection.js'
import { environmentActionParserNode } from './action-parser.node.js'
import { prepareEnvironmentCommand } from '../../environment-interface/store.js'

const description = 'Raise the right front leg, hold it beside the body, then lower it slowly.'
const selection = { response: '', taskDecision: { outcome: 'act', objective: description,
  completionCriteria: 'The requested movement finishes.', reason: 'The requested movement.',
  continuationPolicy: 'none', requiredCompletionBasis: 'action_result' }, program: { steps: [
  { kind: 'action', action: { type: 'requestMotion', description } },
] } }
const observation = { sessionId: 'p4', environmentId: 'ainekio', timestamp: new Date().toISOString(),
  capabilities: { actions: ['requestMotion', 'stop'] } }

test('the model can select an unrestricted movement description without a named-motion or joint planner', async () => {
  const schema = buildEnvironmentSelectorJsonSchema({ actions: observation.capabilities.actions })
  assert.equal(JSON.stringify(schema).includes('generatedMotion'), false)
  assert.equal(JSON.stringify(schema).includes('robotMotionPlan'), false)
  assert.equal(JSON.stringify(schema).includes('requestMotion'), true)
  const output = validateEnvironmentSelectorOutput(JSON.stringify(selection), 'p4')
  assert.deepEqual(output.errors, [])
  assert.equal(output.value?.program?.steps[0].kind, 'action')
  const parsed = await environmentActionParserNode.execute({ response: JSON.stringify(selection), observation,
    routingAnalysis: { needsAction: true }, sessionId: 'p4' }, {}, {})
  assert.equal(parsed.valid, true)
  assert.equal(parsed.program.steps[0].action.description, description)
  assert.equal(parsed.program.steps[0].action.sessionId, 'p4')
  const work = prepareEnvironmentCommand(parsed.program.steps[0].action, { sessionId: 'p4' })
  assert.equal(work.input.type, 'requestMotion')
  assert.equal(work.input.description, description)
  assert.equal('frames' in work.input, false)
  assert.equal('endPose' in work.input, false)
})

test('the retired joint-plan action is absent from command admission', () => {
  assert.throws(() => prepareEnvironmentCommand(JSON.parse(JSON.stringify({
    type: 'robotMotionPlan', sessionId: 'p4',
    frames: [{ durationMs: 300, targets: ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4']
      .map(joint => ({ joint, degrees: 90 })) }], endPose: 'hold',
  }))), /Invalid environment action type/)
})

test('motion descriptions use the advertised action contract and require their actual payload', async () => {
  const unavailable = await environmentActionParserNode.execute({ response: JSON.stringify(selection),
    observation: { ...observation, capabilities: { actions: ['stop'] } }, sessionId: 'p4' }, {}, {})
  assert.equal(unavailable.valid, false)
  assert.equal(unavailable.actionAdmission.reason, 'action_capability_unavailable')
  for (const action of [{ type: 'requestMotion' }, { type: 'requestMotion', description: '' },
    { type: 'requestMotion', description, command: 'wave' }]) {
    const parsed = validateEnvironmentSelectorOutput(JSON.stringify({ response: '', taskDecision: selection.taskDecision,
      program: { steps: [{ kind: 'action', action }] } }), 'p4')
    assert.ok(parsed.errors.length)
  }
})
