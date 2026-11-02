import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-training-curator-'))
process.env.METAHUMAN_ROOT = root
globalThis.fetch = async () => { throw new Error('Curator graph test must not call a real model') }
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('../../audit.js')
setAuditEnabled(false)
const { validateSvelteFlowGraph } = await import('../../cognitive-graph-schema.js')
const { executionDefinition } = await import('../../durable-execution/graph-contract.js')
const { openExecutionStore } = await import('../../durable-execution/storage.js')
const { recordEnvironmentTrainingOutput, readEnvironmentTrainingProposal } = await import('../../environment-training-bank.js')
const { executeGraph } = await import('../../graph-executor.js')
const { nodeExecutors } = await import('../index.js')
const { EXECUTION_OBSERVATION_ENCODING } = await import('../utility/execution-context.node.js')
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }) })

test('curator LLM call runs through graph and saves a proposal from original input and evidence', async () => {
  const graph = validateSvelteFlowGraph(JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dirname, '../../../../../etc/cognitive-graphs/environment-training-curator-mode.json'), 'utf8')))
  const username = 'curator-fixture'
  const store = openExecutionStore(username)
  const originalMessage = 'Please wave.'
  const source = store.enter(username, executionDefinition(graph), 'original-request', {
    graph, context: { userMessage: originalMessage,
      userMessageEntry: { role: 'user', content: originalMessage, timestamp: '2026-10-25T12:00:00Z' },
      providerConfiguration: { privateToken: 'never-send-to-curator' } },
  })
  const candidate = recordEnvironmentTrainingOutput({ username, executionId: source.executionId,
    occurrenceId: 'test', nodeId: 'intent-orchestrator', graphHash: 'test-graph', specialist: 'intent',
    messages: [{ role: 'system', content: 'Original routing instructions' },
      { role: 'user', content: 'Current user message: Please wave.' }],
    observedOutput: '{"needsResponse":false,"needsAction":true,"taskContext":[],"conversationContext":[]}',
  })
  const repeated = recordEnvironmentTrainingOutput({ username, executionId: source.executionId,
    occurrenceId: 'repeated', nodeId: 'intent-orchestrator', graphHash: 'test-graph', specialist: 'intent',
    messages: [{ role: 'system', content: candidate.system }, { role: 'user', content: candidate.user }],
    observedOutput: candidate.observedOutput,
  })
  store.db.transaction(() => store.commitTransition(source.executionId, 'task', {
    transitionId: 'task', task: { executionId: source.executionId, objectiveId: 'wave-objective',
      objective: 'Wave at the person.', instruction: originalMessage, source: 'user',
      completionCriteria: 'The selected gesture has been performed.',
      decision: { outcome: 'incomplete', objectiveComplete: false, reason: 'Only acceptance is recorded.',
        requiredCompletionBasis: 'command' }, selectedAction: { type: 'command', command: 'wave' },
      actionId: 'wave-action', actionStatus: 'accepted', feedback: null, baselineFrame: null,
      updatedAt: '2026-10-25T12:00:00Z' },
  }))()
  store.appendEvent(source.executionId, { eventId: 'wave-accepted', kind: 'action_accepted', actionId: 'wave-action',
    payload: { state: 'accepted' } })
  store.appendEvent(source.executionId, { eventId: 'user-revision', kind: 'user_steering',
    payload: { userMessage: 'Wave with the other leg.',
      userMessageEntry: { role: 'user', content: 'Wave with the other leg.' } } })
  const observation = { frameId: 'result-frame', target: { identity: null,
    box: { x: .2, y: .3, width: .1, height: .2 }, uncertainty: 'Gesture not visually confirmed.' } }
  store.appendEvent(source.executionId, { eventId: 'visual-result', kind: 'work_result',
    payload: { effectId: 'visual-review', result: { state: 'completed',
      graphResults: [{ nodeId: 'vision', outputs: observation }] } } })
  store.cancel(source.executionId, { eventId: 'user-stop', kind: 'user_cancelled',
    payload: { reason: 'Stop the gesture.' } })
  store.close()
  const previous = nodeExecutors.get('model_router')!
  let modelMessages: unknown
  nodeExecutors.set('model_router', async inputs => {
    modelMessages = inputs.messages
    return { response: JSON.stringify({ verdict: 'correct', reason: 'The saved output selected the action route.' }) }
  })
  try {
    const state = await executeGraph(graph, { username, userId: username, cognitiveMode: 'environment',
      environmentTrainingReview: { bank: 'decision', candidateId: candidate.id } })
    assert.equal(state.status, 'completed', state.error?.stack)
    const messages = modelMessages as Array<{ role: string; content: string }>
    const prompt = graph.nodes.find(node => node.data.nodeType === 'environment_training_review_input')?.data.properties?.systemPrompt
    assert.deepEqual(messages[0], { role: 'system', content: prompt }, 'Review instructions remain unchanged')
    const supplied = JSON.parse(messages[1].content)
    assert.deepEqual(supplied.decisionIdentity,
      { id: candidate.id, sourceDigest: candidate.sourceDigest, executionId: source.executionId })
    assert.deepEqual(supplied.originalInput, { system: candidate.system, user: candidate.user })
    const evidence = supplied.executionEvidence
    assert.equal(evidence.trajectory.originalInput.userMessage, originalMessage)
    assert.equal(evidence.trajectory.originalInput.userMessageEntry.role, 'user')
    assert.equal(evidence.trajectory.task.actionStatus, 'accepted')
    assert.equal(evidence.trajectory.task.decision.objectiveComplete, false)
    assert.equal(evidence.trajectory.status, 'cancelled')
    assert.equal(evidence.trajectory.observationEncoding, EXECUTION_OBSERVATION_ENCODING)
    assert.deepEqual(evidence.trajectory.events.map((event: any) => event.eventId),
      ['wave-accepted', 'user-revision', 'visual-result', 'user-stop'])
    assert.equal(evidence.trajectory.events[0].actionId, 'wave-action')
    assert.equal(evidence.trajectory.events[1].payload.userMessage, 'Wave with the other leg.')
    assert.deepEqual(evidence.trajectory.events[2].payload.result.graphResults[0].outputs, observation)
    assert.deepEqual(new Set(evidence.trajectory.decisions.map((decision: any) => decision.id)),
      new Set([candidate.id, repeated.id]), 'Repeated text retains separate recorded occurrences')
    assert.match(evidence.scope, /does not automatically attribute/)
    assert.doesNotMatch(messages[1].content, /privateToken|never-send-to-curator/)
    assert.equal(readEnvironmentTrainingProposal(username, 'decision', candidate.id)?.verdict, 'correct')
  } finally { nodeExecutors.set('model_router', previous) }
})
