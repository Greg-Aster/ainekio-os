import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EnvironmentTrainingCandidate } from './environment-training-bank.js'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-training-bank-'))
process.env.METAHUMAN_ROOT = fixtureRoot
globalThis.fetch = async () => { throw new Error('Training bank tests must not access network services') }
const { eventBus } = await import('./infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('./audit.js')
setAuditEnabled(false)
const { validateSvelteFlowGraph } = await import('./cognitive-graph-schema.js')
const { ExecutionCheckpointer } = await import('./durable-execution/checkpointer.js')
const { executionDefinition } = await import('./durable-execution/graph-contract.js')
const { ExecutionStore } = await import('./durable-execution/store.js')
const { collectEnvironmentTrainingCandidates, readEnvironmentTrainingEvidence } = await import('./environment-training-bank.js')
after(() => { eventBus.disconnect(); fs.rmSync(fixtureRoot, { recursive: true, force: true }) })

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

test('rolling bank reads each committed intent and task decision once without accepting precomputed outputs', async () => {
  const graph = validateSvelteFlowGraph(JSON.parse(fs.readFileSync(
    new URL('../../../etc/cognitive-graphs/environment-mode.json', import.meta.url), 'utf8')))
  const definition = executionDefinition(graph)
  const store = new ExecutionStore(path.join(fixtureRoot, 'bank.sqlite'))
  try {
    const execution = store.create('training-test', definition)
    const lease = store.claim(execution.executionId, definition)
    const saver = new ExecutionCheckpointer(store, lease)
    const now = Date.now()
    const entries = [
      ['intent-orchestrator', { nodeId: 'intent-orchestrator', status: 'completed', startTime: now,
        endTime: now + 1, inputs: { message: 'Please bow.' },
        outputs: { raw: '{"needsResponse":false,"needsAction":true,"taskContext":[],"conversationContext":[]}' } }],
      ['4', { nodeId: '4', status: 'completed', startTime: now + 2, endTime: now + 3,
        inputs: { messages: [{ role: 'system', content: 'task instructions' }, { role: 'user', content: '{"currentInstruction":"Please bow."}' }] },
        outputs: { response: '{"taskDecision":null,"program":null}' } }],
    ]
    let config = await saver.put({ configurable: { thread_id: execution.executionId } }, {
      v: 4, id: randomUUID(), ts: new Date(now).toISOString(),
      channel_values: { nodeEntries: entries }, channel_versions: {}, versions_seen: {},
    }, { source: 'loop', step: 0, parents: {} })
    await saver.putWrites(config, [['nodeEntries', entries], ['counts', { 'intent-orchestrator': 1, '4': 1 }]], 'first')
    config = await saver.put(config, {
      v: 4, id: randomUUID(), ts: new Date(now + 4).toISOString(),
      channel_values: { nodeEntries: entries }, channel_versions: {}, versions_seen: {},
    }, { source: 'loop', step: 1, parents: {} })
    await saver.putWrites(config, [['nodeEntries', entries], ['counts', { 'intent-orchestrator': 1, '4': 1 }]], 'second')
    const found = await collectEnvironmentTrainingCandidates(store, 'training-test', graph)
    assert.equal(found.matchingExecutions, 1)
    assert.equal(found.candidates.length, 2)
    const intent = found.candidates.find(candidate => candidate.specialist === 'intent')!
    assert.equal(intent.user, 'Current user message: Please bow.')
    assert.match(intent.system, /Environment Intent Orchestrator/)
    const task = found.candidates.find(candidate => candidate.specialist === 'task')!
    assert.equal(task.system, 'task instructions')
    assert.equal(task.user, '{"currentInstruction":"Please bow."}')
    assert.equal(task.observedOutput, '{"taskDecision":null,"program":null}')
  } finally { store.close() }
})

test('training evidence preserves an ordered attributed episode after reopening the execution store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-training-evidence-'))
  const file = path.join(root, 'executions.sqlite')
  const definition = { graphId: 'fixture', graphHash: 'fixture-hash', runtimeVersion: 'fixture',
    checkpointSchemaVersion: 4, nodeVersions: {} }
  let store = new ExecutionStore(file)
  try {
    const frame = { id: 'observed-frame', timestamp: '2026-10-25T12:00:00Z', mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,cHJpdmF0ZS1waXhlbHM=', metadata: { robotId: 'fixture-body', epoch: 3, counter: 5 } }
    const original = { userMessage: 'Inspect the target.',
      userMessageEntry: { role: 'user', content: 'Inspect the target.', timestamp: frame.timestamp },
      environmentObservation: { timestamp: frame.timestamp, visual: frame, state: { body: { authenticated: true } } },
      robotOperatorContext: { robotObserver: { cycleId: 'original-cycle', triggerSource: 'user' } },
      providerConfiguration: { privateToken: 'must-not-enter-evidence' }, username: 'training-owner' }
    const execution = store.enter('training-owner', definition, 'original-request', { graph: {}, context: original })
    const id = execution.executionId
    const task = { executionId: id, objectiveId: 'objective-one', objective: 'Identify the target.',
      instruction: original.userMessage, source: 'user', completionCriteria: 'Target identity is established by observation.',
      decision: { outcome: 'incomplete', objectiveComplete: false, reason: 'Image capture alone does not identify the target.',
        requiredCompletionBasis: 'observation' }, selectedAction: { type: 'captureImage' }, actionId: 'capture-one',
      actionStatus: 'completed', feedback: null, baselineFrame: null, updatedAt: frame.timestamp }
    store.db.transaction(() => store.commitTransition(id, 'task-checkpoint', { transitionId: 'task-record', task }))()
    const accepted = store.appendEvent(id, { eventId: 'accepted', kind: 'action_accepted', actionId: 'capture-one',
      payload: { state: 'accepted' } })
    store.appendEvent(id, { eventId: 'captured', kind: 'physical_result', actionId: 'capture-one', parentEventId: accepted.eventId,
      payload: { feedback: { type: 'completed', message: 'Capture completed.' },
        environmentObservation: original.environmentObservation } })
    const correction = 'Inspect the other target.'
    store.appendEvent(id, { eventId: 'human-correction', kind: 'user_steering',
      payload: { userMessage: correction, userMessageEntry: { role: 'user', content: correction } } })
    store.appendEvent(id, { eventId: 'autonomous-continuation', kind: 'autonomy_trigger',
      payload: { robotOperatorContext: { plannerDecision: { observed: 'The second target remains unresolved.',
        instruction: 'Inspect the other target.', reason: 'Continue the corrected purpose.' } } } })
    const interpretation = { frameId: frame.id, target: { box: { x: .2, y: .3, width: .1, height: .2 },
      identity: null, candidates: ['cup', 'bowl'], uncertainty: 'The outline is ambiguous.' } }
    store.appendEvent(id, { eventId: 'interpretation', kind: 'work_result', workItemId: 'vision-work',
      payload: { effectId: 'vision-effect', result: { state: 'completed', graphResults: [{ nodeId: 'vision', outputs: interpretation }],
        result: { observation: interpretation, stdout: 'not-semantic-evidence' } },
      environmentObservation: { ...original.environmentObservation,
        visual: { ...frame, id: 'next-observed-frame' } } } })
    store.cancel(id, { eventId: 'cancelled', kind: 'user_cancelled', payload: { reason: 'Stop this investigation.' } })
    const candidate = (suffix: string): EnvironmentTrainingCandidate => ({ id: `decision-${suffix}`, sourceDigest: 'same-output',
      specialist: 'task', executionId: id, checkpointNamespace: `occurrence-${suffix}`, nodeId: 'task-model', graphHash: definition.graphHash,
      recordedAt: frame.timestamp, system: 'Instructions.', user: 'Same repeated input.', observedOutput: '{"program":null}' })
    const candidates = [candidate('first'), candidate('second'), { ...candidate('unrelated'), executionId: 'other-execution' }]
    store.close()
    store = new ExecutionStore(file)
    const result = readEnvironmentTrainingEvidence(store, id, candidates)
    const trajectory = result.trajectory
    assert.equal(trajectory.executionId, id)
    assert.equal(trajectory.status, 'cancelled')
    assert.equal(trajectory.originalInput.userMessage, original.userMessage)
    assert.equal(trajectory.originalInput.userMessageEntry.role, 'user')
    assert.equal(trajectory.task?.decision.objectiveComplete, false, 'Command completion must not imply goal completion')
    assert.deepEqual(trajectory.events.map(event => event.eventId), ['accepted', 'captured', 'human-correction', 'autonomous-continuation', 'interpretation', 'cancelled'])
    assert.deepEqual(trajectory.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6])
    assert.equal(trajectory.events[0].actionId, 'capture-one')
    assert.equal(trajectory.events[1].parentEventId, accepted.eventId)
    assert.equal(record(trajectory.events[2].payload).userMessage, correction)
    assert.equal(trajectory.events[3].kind, 'autonomy_trigger')
    assert.deepEqual(record(record(record(trajectory.events[4].payload).result).result).observation, interpretation)
    assert.deepEqual(record(trajectory.events[4].payload).observationChanges,
      [{ path: ['visual', 'id'], value: 'next-observed-frame' }])
    assert.deepEqual(trajectory.decisions.map(decision => decision.id), ['decision-first', 'decision-second'])
    assert.ok('checkpointNamespace' in trajectory.decisions[0])
    assert.ok('checkpointNamespace' in trajectory.decisions[1])
    assert.equal(trajectory.decisions[0].checkpointNamespace, 'occurrence-first')
    assert.equal(trajectory.decisions[1].checkpointNamespace, 'occurrence-second')
    assert.equal(record(record(record(trajectory.events[1].payload).environmentObservation).visual).id, frame.id)
    assert.doesNotMatch(JSON.stringify(result), /privateToken|must-not-enter-evidence|cHJpdmF0ZS1waXhlbHM=|not-semantic-evidence/)
    assert.match(result.scope, /does not automatically attribute/)
    assert.deepEqual(readEnvironmentTrainingEvidence(store, id, candidates), result, 'Review reads do not duplicate or alter evidence')
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('older evidence without admitted input or supplied decision references remains explicitly unattributed', () => {
  const store = new ExecutionStore(path.join(fixtureRoot, 'unattributed.sqlite'))
  try {
    const execution = store.create('training-test', { graphId: 'fixture', graphHash: 'fixture-hash',
      runtimeVersion: 'fixture', checkpointSchemaVersion: 4, nodeVersions: {} })
    store.appendEvent(execution.executionId, { eventId: 'receipt', kind: 'physical_result', actionId: 'recorded-action',
      payload: { feedback: { type: 'completed', message: 'Command completed.' } } })
    const evidence = readEnvironmentTrainingEvidence(store, execution.executionId)
    assert.equal(evidence.trajectory.originalInput, null)
    assert.equal(evidence.trajectory.task, null)
    assert.deepEqual(evidence.trajectory.decisions, [])
    assert.deepEqual(evidence.events[0].feedback, { type: 'completed', message: 'Command completed.' })
    assert.equal(evidence.events[0].actionId, 'recorded-action')
  } finally { store.close() }
})
