import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, mock } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-expression-'))
process.env.METAHUMAN_ROOT = root
globalThis.fetch = async () => { throw new Error('Physical dispatch and network calls are forbidden in this fixture') }
const { eventBus } = await import('../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('../audit.js')
setAuditEnabled(false)
const submission = await import('../queue/work-submission.js')
mock.module(new URL('../queue/work-submission.js', import.meta.url).href, { namedExports: {
  ...submission, submitCoordinatorWork: async (input: any) => manager.enqueue(input),
} })
const { runDurableGraph, withGraphWork } = await import('../durable-execution/runtime.js')
const { getQueueManager } = await import('../queue/unified-queue-manager.js')
const { openExecutionStore } = await import('../durable-execution/storage.js')
const { deliverDurableWorkReceipt } = await import('../durable-execution/work-results.js')
const { writeEnvironmentBridgeState, subscribeEnvironmentActions, recordEnvironmentActionResult,
  readEnvironmentBridgeState, publishEnvironmentObservation } = await import('./store.js')
const { submitDisplayFeedback, displayFeedbackToken } = await import('./display-feedback.js')
const { handleEnvironmentBridgeStatus } = await import('../api/handlers/environment-bridge.js')
const { validateSvelteFlowGraph } = await import('../cognitive-graph-schema.js')
const manager = getQueueManager()
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }) })

test('body-event reaction tokens survive release and distinguish replacement faces', async t => {
  const { environmentFaceExpressionNode } = await import('../nodes/environment/expression.node.js')
  const { environmentSendActionNode } = await import('../nodes/environment/send-action.node.js')
  const dispatched: any[] = []
  t.mock.method(environmentSendActionNode, 'execute', async (input: any) => {
    dispatched.push(input.action)
    return { success: true, targetSessionId: 'body' } as any
  })
  for (const kind of ['tipped', 'rapid_movement']) {
    const context: any = { graphExecution: { occurrenceId: `fixture-${kind}` },
      environmentObservation: { state: { bodyEvent: { name: 'body_event', data: { kind } } } } }
    const reaction = await environmentFaceExpressionNode.execute({ control: kind }, context,
      { expression: 'surprised', timeoutMs: 60000 })
    assert.match(reaction.token, /^be_[a-f0-9]{29}$/)
    assert.equal(dispatched.at(-1).displayTimeoutMs, 60000)
    const wire = dispatched.at(-1)
    assert.equal(wire.displayToken, reaction.token)
    const repeated = await environmentFaceExpressionNode.execute({ control: kind }, context,
      { expression: 'surprised', timeoutMs: 60000 })
    assert.equal(repeated.token, reaction.token)
    await environmentFaceExpressionNode.execute({ token: reaction.token }, context, { operation: 'release' })
    assert.equal(dispatched.at(-1).displayToken, reaction.token)
    assert.equal(dispatched.at(-1).displayRelease, true)
    const replacement = await environmentFaceExpressionNode.execute({ control: 'finished' }, context, { expression: 'happy' })
    assert.match(replacement.token, /^[a-f0-9]{32}$/)
    assert.notEqual(replacement.token, reaction.token)
  }
  const ordinary = await environmentFaceExpressionNode.execute({ control: 'tipped' },
    { requestId: 'ordinary-face' } as any, { expression: 'confused' })
  assert.match(ordinary.token, /^[a-f0-9]{32}$/)
})

test('Face Expression node delivers one display command and preserves recorded posture', async () => {
  const timestamp = new Date().toISOString()
  const pose = { version: 1, jointMapVersion: 1, kind: 'reference', reference: 'stand',
    sourceActionId: 'earlier-stand', updatedAt: timestamp }
  const library = [{ name: 'bow', label: 'Bow', group: 'Motion faces' }, { name: 'thinking', label: 'Thinking' }]
  writeEnvironmentBridgeState({ enabled: true, updatedAt: timestamp, feedback: [], sessions: {
    body: { sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', status: 'connected',
      firstSeenAt: timestamp, lastSeenAt: timestamp,
      latestObservation: { sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', timestamp,
        capabilities: { actions: ['faceExpression'], expressionLibrary: library },
        state: { body: { authenticated: true }, commandedPose: pose } } },
  } })
  const unsubscribe = subscribeEnvironmentActions('body', () => {})
  try {
    const graph = validateSvelteFlowGraph({ name: 'Display fixture', version: '1.0', format: 'svelte-flow',
      scheduler: { version: 1, activation: 'demand', skippedState: 'explicit', sideEffectOrder: 'serial-topological', maxLoopIterations: 0 },
      nodes: [{ id: 'face', type: 'environmentNode', position: { x: 0, y: 0 },
        data: { nodeType: 'environment_face_expression', properties: { expression: 'bow', sessionId: 'body' } } }], edges: [] })
    const work = manager.enqueue({ type: 'generic', handler: 'graph.resume', username: 'fixture', source: 'user', input: {} })
    assert.ok(manager.claim(work.id))
    const result = await withGraphWork(work, id => manager.attachExecution(work.id, id),
      () => runDurableGraph({ graph, context: { username: 'fixture' } }), async input => manager.enqueue(input))
    manager.complete(work.id, true)
    assert.notEqual(result.status, 'failed', result.error?.stack)
    const output = result.nodes.get('face')!.outputs!
    assert.equal(output.success, true, output.message)
    const actions = manager.getAllTasks().filter(task => task.type === 'environment_command')
    assert.equal(actions.length, 1)
    const action = actions[0]!
    assert.equal(action.input.type, 'faceExpression')
    assert.equal(action.input.expression, 'bow')
    assert.equal(action.input.displayTimeoutMs, 60000)
    assert.match(String(action.input.displayToken), /^[a-f0-9]{32}$/)
    assert.equal(action.input.command, undefined)
    assert.equal(action.resource, 'environment-display:body')
    assert.ok(manager.claim(action.id))
    recordEnvironmentActionResult({ id: 'face-unknown', actionId: String(action.input.id), timestamp,
      type: 'outcome_unknown', message: 'Simulated display connection interrupted',
      data: { producer: 'environment-bridge', delivery: { outcome: 'unknown' } } })
    assert.equal(manager.getTask(action.id)?.state, 'failed')
    const next = manager.enqueue({ type: 'environment_command', handler: 'environment.command', username: 'fixture', source: 'environment',
      resource: 'environment-display:body', input: { id: 'newer-display', type: 'faceExpression', sessionId: 'body', expression: 'thinking' } })
    assert.ok(manager.claim(next.id), 'an unknown display delivery does not own the display lane')
    recordEnvironmentActionResult({ id: 'face-completed', actionId: String(action.input.id), timestamp,
      type: 'completed', message: 'Simulated face applied' })
    assert.deepEqual(readEnvironmentBridgeState().sessions.body.latestObservation?.state?.commandedPose, pose)
    const store = openExecutionStore('fixture')
    try {
      assert.equal(store.dispatches(result.executionId!).filter(effect => effect.actionId).length, 1)
      assert.equal(store.get(result.executionId!).status, 'completed')
      assert.equal((store.event(result.executionId!, 'face-unknown').payload as any).feedback.type, 'outcome_unknown')
      assert.equal(store.event(result.executionId!, 'face-completed').parentEventId, 'face-unknown')
      assert.equal(manager.getTask(action.id)?.state, 'failed', 'later evidence does not rewrite historical Coordinator failure')
      assert.equal(manager.getTask(next.id)?.state, 'leased', 'late old receipt does not complete the new display')
      manager.complete(next.id, true)

    } finally { store.close() }
    const response = await handleEnvironmentBridgeStatus({ query: { view: 'expression-options' } } as any)
    assert.deepEqual((response.data as any).expressionLibrary, library)
  } finally { unsubscribe() }
})

function feedbackGraph(fail = false) {
  return validateSvelteFlowGraph({ name: fail ? 'Failed feedback fixture' : 'Feedback handoff fixture', version: '1.0', format: 'svelte-flow',
    scheduler: { version: 1, activation: 'demand', skippedState: 'explicit', sideEffectOrder: 'serial-topological', maxLoopIterations: 0 },
    nodes: [
      { id: 'input', type: 'inputNode', position: { x: 0, y: 0 }, data: { nodeType: 'user_input', properties: {} } },
      { id: 'thinking', type: 'environmentNode', position: { x: 1, y: 0 }, data: { nodeType: 'environment_expression_feedback', properties: { timeoutMs: 12345 } } },
      { id: 'on', type: 'environmentNode', position: { x: 2, y: 0 }, data: { nodeType: 'environment_face_expression', properties: { sessionId: 'body' } } },
      { id: 'off', type: 'environmentNode', position: { x: 3, y: 0 }, data: { nodeType: 'environment_face_expression', properties: { operation: 'release', sessionId: 'body' } } },
    ], edges: [
      { id: 'input-thinking', source: 'input', sourceHandle: 'message', target: 'thinking', targetHandle: 'control' },
      { id: 'thinking-control', source: 'thinking', sourceHandle: 'control', target: 'on', targetHandle: 'control' },
      { id: 'thinking-face', source: 'thinking', sourceHandle: 'feedback', target: 'on', targetHandle: 'feedback' },
      { id: 'on-off', source: 'on', sourceHandle: 'control', target: 'off', targetHandle: 'control' },
      ...(!fail ? [{ id: 'token', source: 'on', sourceHandle: 'token', target: 'off', targetHandle: 'token' }] : []),
    ] })
}

async function runFixture(graph: ReturnType<typeof feedbackGraph>) {
  const work = manager.enqueue({ type: 'generic', handler: 'graph.resume', username: 'fixture', source: 'user', input: {} })
  assert.ok(manager.claim(work.id))
  try {
    return await withGraphWork(work, id => manager.attachExecution(work.id, id),
      () => runDurableGraph({ graph, context: { username: 'fixture', userMessage: 'Tell me what you see, then bow.', allowMemoryWrites: false } }),
      async input => manager.enqueue(input))
  } finally { manager.complete(work.id, true) }
}

test('Pass-through thinking, conditional release and replay preserve input and dispatch identity', async () => {
  const unsubscribe = subscribeEnvironmentActions('body', () => {})
  try {
    const graph = feedbackGraph()
    const result = await runFixture(graph)
    assert.notEqual(result.status, 'failed', result.error?.stack)
    assert.equal(result.nodes.get('on')!.outputs!.control, 'Tell me what you see, then bow.')
    const ledger = manager.exportState()
    const commands = [...new Map([...(ledger.items ?? []), ...(ledger.history ?? []), ...(ledger.durableReceipts ?? [])].map(task => [task.id, task])).values()]
      .filter(task => task.type === 'environment_command' && task.durable?.executionId === result.executionId)
    assert.equal(commands.length, 2)
    const on = commands.find(task => task.input.displayRelease === false)!
    const off = commands.find(task => task.input.displayRelease === true)!
    assert.equal(on.input.expression, 'thinking')
    assert.equal(on.input.displayTimeoutMs, 12345)
    assert.equal(on.input.displayBackground, true)
    assert.equal(off.input.displayToken, on.input.displayToken)
    assert.equal(off.input.expression, undefined)
    assert.equal(on.state, 'cancelled', 'the unsent thinking SET is superseded by its matching release')
    assert.equal(on.startedAt, undefined)
    assert.equal(off.state, 'queued', 'the release remains deliverable')
    await deliverDurableWorkReceipt(on, manager)
    assert.ok(manager.claim(off.id))
    recordEnvironmentActionResult({ id: 'face-release-completed', actionId: String(off.input.id), timestamp: new Date().toISOString(),
      type: 'completed', message: 'Simulated release' })
    const store = openExecutionStore('fixture')
    try {
      assert.equal(store.get(result.executionId!).status, 'completed')
      assert.ok(store.dispatches(result.executionId!).filter(effect => effect.actionId).every(effect => ['completed', 'cancelled'].includes(effect.status)))
      assert.ok(store.events(result.executionId!).some(event => event.kind === 'dispatch_cancelled'))
    } finally { store.close() }
    const replay = await runDurableGraph({ graph, executionId: result.executionId, context: { username: 'fixture' } })
    assert.notEqual(replay.status, 'failed', replay.error?.stack)
    assert.equal(manager.getAllTasks().filter(task => task.type === 'environment_command' && task.durable?.executionId === result.executionId).length, 0)
  } finally { unsubscribe() }
})

test('Graph failure admits a display-only conditional error through the same Coordinator', async () => {
  const unsubscribe = subscribeEnvironmentActions('body', () => {})
  try {
    const result = await runFixture(feedbackGraph(true))
    assert.equal(result.status, 'failed')
    assert.match(result.error!.message, /requires its token/)
    const on = result.nodes.get('on')!.outputs!
    const report = manager.getAllTasks().find(task => task.handler === 'environment.display-feedback' && task.input.feedback?.token === on.token)
    assert.ok(report)
    assert.equal(report.input.feedback.ifToken, on.token)
    assert.equal(report.input.feedback.expression, 'confused')
    assert.equal(report.input.feedback.timeoutMs, 5000)
    assert.equal(report.input.feedback.background, false)
    assert.equal(report.input.feedback.sessionId, 'body')
  } finally { unsubscribe() }
})

test('joined finite-work failures select the configured error face, including after receipt replay', async () => {
  const { workResultWaitNode } = await import('../nodes/utility/work-result-wait.node.js')
  const { environmentExpressionFeedbackNode } = await import('../nodes/environment/expression.node.js')
  for (const state of ['failed', 'expired', 'completed', 'cancelled']) {
    const event = { eventId: 'terminal', kind: 'work_result', payload: {
      effectId: 'conversation-work', result: { state, result: null,
        error: state === 'failed' ? { code: 'handler_failed', message: 'Backend disconnected' } : null },
    } }
    for (const replay of [false, true]) {
      const context = { graphExecution: { occurrenceId: 'display-occurrence',
        pendingEvents: () => replay ? [] : [event], events: () => [event], waitForEvent: () => event } } as any
      const joined = await workResultWaitNode.execute({ work: { effectId: 'conversation-work' } }, context, {})
      const result = await environmentExpressionFeedbackNode.execute({ token: 'current-turn', workResult: joined.result }, context,
        { ...environmentExpressionFeedbackNode.properties, operation: 'release', errorExpression: 'confused', errorTimeoutMs: 4321 })
      const failed = state === 'failed' || state === 'expired'
      assert.equal(result.feedback.operation, failed ? 'set' : 'release', `${state}, replay=${replay}`)
      assert.equal(result.token, 'current-turn')
      if (failed) {
        assert.equal(result.feedback.expression, 'confused')
        assert.equal(result.feedback.timeoutMs, 4321)
        assert.equal(result.feedback.ifToken, 'current-turn', 'An old failure cannot replace a newer turn face')
        assert.equal(result.feedback.background, false)
      }
    }
  }
})

test('The model contract exposes only advertised expressions and keeps display actions distinct from motion', async () => {
  const { buildEnvironmentSelectorJsonSchema, buildEnvironmentSelectorEnvelope } = await import('./task-selection.js')
  const { environmentActionParserNode } = await import('../nodes/environment/action-parser.node.js')
  const observation = readEnvironmentBridgeState().sessions.body.latestObservation!
  const schema = buildEnvironmentSelectorJsonSchema({ actions: ['faceExpression'], expressions: ['bow', 'thinking'] }) as any
  const activity = schema.anyOf.find((branch: any) => branch.properties.program.type === 'object')
  const action = activity.properties.program.properties.steps.items.anyOf[0].properties.action
  assert.deepEqual(action.required, ['type', 'expression'])
  assert.deepEqual(action.properties.expression.enum, ['bow', 'thinking'])
  assert.equal(action.properties.command, undefined)
  assert.equal(action.additionalProperties, false)
  const envelope = JSON.parse(buildEnvironmentSelectorEnvelope({ instruction: 'Show the bow face', observation }))
  assert.deepEqual(envelope.currentEnvironment.capabilities.expressionLibrary, observation.capabilities.expressionLibrary)
  assert.ok(envelope.capabilityRules.includes('faceExpression changes only the display to an expression from expressionLibrary; expression is the library identifier. It does not move the body.'))
  const selection = (expression: string) => JSON.stringify({ response: '', program: { steps: [{ kind: 'action', action: { type: 'faceExpression', expression } }] },
    taskDecision: { objective: 'Show the requested face', completionCriteria: 'Display command completes', outcome: 'act',
      reason: 'Requested expression', continuationPolicy: 'none', requiredCompletionBasis: 'action_result' } })
  const accepted = await environmentActionParserNode.execute({ response: selection('bow'), observation, sessionId: 'body' }, {}, {})
  assert.equal(accepted.valid, true, accepted.error)
  assert.equal(accepted.program.steps[0].action.type, 'faceExpression')
  assert.equal(accepted.program.steps[0].action.expression, 'bow')
  const rejected = await environmentActionParserNode.execute({ response: selection('invented_face'), observation, sessionId: 'body' }, {}, {})
  assert.equal(rejected.valid, false)
  assert.equal(rejected.program, null)
  assert.match(rejected.error, /expression library/)
})

test('Environment Mode thinking/response-thinking/release dispatches do not block or trigger spurious graph_resume wakes', async () => {
  const timestamp = new Date().toISOString()
  writeEnvironmentBridgeState({ enabled: true, updatedAt: timestamp, feedback: [], sessions: {
    body: { sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', status: 'connected',
      firstSeenAt: timestamp, lastSeenAt: timestamp,
      latestObservation: { sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', timestamp,
        capabilities: { actions: ['faceExpression'], expressionLibrary: [{ name: 'thinking', label: 'Thinking' }] },
        state: { body: { authenticated: true } } } },
  } })
  const unsubscribe = subscribeEnvironmentActions('body', () => {})
  try {
    const graph = validateSvelteFlowGraph({ name: 'Environment expression lifecycle fixture', version: '1.0', format: 'svelte-flow',
      scheduler: { version: 1, activation: 'demand', skippedState: 'explicit', sideEffectOrder: 'serial-topological', maxLoopIterations: 0 },
      nodes: [
        { id: 'input', type: 'inputNode', position: { x: 0, y: 0 }, data: { nodeType: 'user_input', properties: {} } },
        { id: 'thinking-on', type: 'environmentNode', position: { x: 1, y: 0 },
          data: { nodeType: 'environment_expression_feedback', properties: { operation: 'set', expression: 'thinking', timeoutMs: 60000, background: true } } },
        { id: 'thinking-out', type: 'environmentNode', position: { x: 2, y: 0 },
          data: { nodeType: 'environment_face_expression', properties: { operation: 'set', timeoutMs: 60000, background: true, sessionId: 'body' } } },
        { id: 'json', type: 'utilityNode', position: { x: 3, y: 0 }, data: { nodeType: 'json_parser', properties: {} } },
        { id: 'wait', type: 'utilityNode', position: { x: 4, y: 0 }, data: { nodeType: 'work_result_wait', properties: {} } },
        { id: 'response-thinking', type: 'environmentNode', position: { x: 5, y: 0 },
          data: { nodeType: 'environment_expression_feedback', properties: { operation: 'set', expression: 'thinking', timeoutMs: 60000, background: true },
            activation: { mode: 'required-inputs', requiredInputs: ['control'] } } },
        { id: 'response-thinking-out', type: 'environmentNode', position: { x: 6, y: 0 },
          data: { nodeType: 'environment_face_expression', properties: { operation: 'set', timeoutMs: 60000, background: true, sessionId: 'body' } } },
        { id: 'thinking-off', type: 'environmentNode', position: { x: 7, y: 0 },
          data: { nodeType: 'environment_expression_feedback', properties: { operation: 'release', timeoutMs: 60000, background: true },
            activation: { mode: 'required-inputs', requiredInputs: ['control'] } } },
        { id: 'thinking-off-out', type: 'environmentNode', position: { x: 8, y: 0 },
          data: { nodeType: 'environment_face_expression', properties: { operation: 'set', timeoutMs: 60000, background: false, sessionId: 'body' } } },
      ],
      edges: [
        { id: 'in-on', source: 'input', sourceHandle: 'message', target: 'thinking-on', targetHandle: 'control' },
        { id: 'on-ctrl', source: 'thinking-on', sourceHandle: 'control', target: 'thinking-out', targetHandle: 'control' },
        { id: 'on-fb', source: 'thinking-on', sourceHandle: 'feedback', target: 'thinking-out', targetHandle: 'feedback' },
        { id: 'out-json', source: 'thinking-out', sourceHandle: 'control', target: 'json', targetHandle: 'text' },
        { id: 'json-wait', source: 'json', sourceHandle: 'data', target: 'wait', targetHandle: 'work' },
        { id: 'wait-resp', source: 'wait', sourceHandle: 'result', target: 'response-thinking', targetHandle: 'control' },
        { id: 'on-resp-tok', source: 'thinking-on', sourceHandle: 'token', target: 'response-thinking', targetHandle: 'token' },
        { id: 'resp-ctrl', source: 'response-thinking', sourceHandle: 'control', target: 'response-thinking-out', targetHandle: 'control' },
        { id: 'resp-fb', source: 'response-thinking', sourceHandle: 'feedback', target: 'response-thinking-out', targetHandle: 'feedback' },
        { id: 'resp-off', source: 'response-thinking-out', sourceHandle: 'control', target: 'thinking-off', targetHandle: 'control' },
        { id: 'on-off-tok', source: 'thinking-on', sourceHandle: 'token', target: 'thinking-off', targetHandle: 'token' },
        { id: 'off-ctrl', source: 'thinking-off', sourceHandle: 'control', target: 'thinking-off-out', targetHandle: 'control' },
        { id: 'off-fb', source: 'thinking-off', sourceHandle: 'feedback', target: 'thinking-off-out', targetHandle: 'feedback' },
      ],
    })
    const work1 = manager.enqueue({ type: 'generic', handler: 'graph.resume', username: 'fixture', source: 'user', input: {} })
    assert.ok(manager.claim(work1.id))
    let executionId = ''
    try {
      const pass1 = await withGraphWork(work1, id => manager.attachExecution(work1.id, id),
        () => runDurableGraph({ graph, context: { username: 'fixture', userMessage: '{"effectId":"work-1"}' } }),
        async input => manager.enqueue(input))
      executionId = pass1.executionId!
      assert.equal(pass1.status, 'waiting')
    } finally { manager.complete(work1.id, true) }

    const finishDisplay = async (task: any, tag: string) => {
      assert.equal(task.input.type, 'faceExpression')
      assert.ok(manager.claim(task.id), `claim ${tag}`)
      recordEnvironmentActionResult({ id: `${tag}-accepted`, actionId: String(task.input.id), timestamp, type: 'accepted', message: 'Accepted' })
      publishEnvironmentObservation({ id: `obs-${tag}`, sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', timestamp,
        metadata: { actionId: String(task.input.id) },
        capabilities: { actions: ['faceExpression'], expressionLibrary: [{ name: 'thinking', label: 'Thinking' }] },
        state: { body: { authenticated: true } } }, { username: 'fixture' })
      recordEnvironmentActionResult({ id: `${tag}-completed`, actionId: String(task.input.id), timestamp, type: 'completed', message: 'Applied' })
      await deliverDurableWorkReceipt(task, manager)
    }

    const thinkingTask = manager.getAllTasks().find(t => t.type === 'environment_command' && t.durable?.executionId === executionId)!
    assert.equal(thinkingTask.input.displayBackground, true)
    assert.equal(thinkingTask.input.displayRelease, false)
    await finishDisplay(thinkingTask, 'thinking')

    const store = openExecutionStore('fixture')
    try {
      assert.equal(store.dispatches(executionId).filter(d => d.kind === 'graph_resume').length, 0,
        'thinking-out accepted/observation/completed/work_result must not enqueue graph_resume')
      assert.equal(store.get(executionId).status, 'waiting')
      store.deliverEvent(executionId, { eventId: 'work-1-done', kind: 'work_result',
        payload: { effectId: 'work-1', result: { state: 'completed', result: null, error: null } } })
    } finally { store.close() }

    const work2 = manager.enqueue({ type: 'generic', handler: 'graph.resume', username: 'fixture', source: 'user', input: { executionId } })
    assert.ok(manager.claim(work2.id))
    try {
      const pass2 = await withGraphWork(work2, id => manager.attachExecution(work2.id, id),
        () => runDurableGraph({ graph, executionId, context: { username: 'fixture' } }),
        async input => manager.enqueue(input))
      assert.equal(pass2.status, 'waiting')
    } finally { manager.complete(work2.id, true) }

    const ledger = manager.exportState()
    const pass2Commands = [...new Map([...(ledger.items ?? []), ...(ledger.history ?? []), ...(ledger.durableReceipts ?? [])].map(task => [task.id, task])).values()]
      .filter(t => t.type === 'environment_command' && t.durable?.executionId === executionId && t.id !== thinkingTask.id)
    const respTask = pass2Commands.find(t => t.input.displayRelease === false)!
    const releaseTask = pass2Commands.find(t => t.input.displayRelease === true)!
    assert.equal(respTask.input.displayToken, thinkingTask.input.displayToken)
    assert.equal(respTask.input.displayBackground, true)
    assert.equal(respTask.state, 'cancelled', 'queued response-thinking SET is superseded by matching release')
    await deliverDurableWorkReceipt(respTask, manager)
    assert.equal(releaseTask.input.displayToken, thinkingTask.input.displayToken)
    assert.equal(releaseTask.input.displayRelease, true)
    await finishDisplay(releaseTask, 'thinking-off')

    const store2 = openExecutionStore('fixture')
    try {
      assert.equal(store2.get(executionId).status, 'completed')
      assert.deepEqual(
        store2.dispatches(executionId).filter(d => d.kind === 'graph_resume').map(d => d.effectId),
        [`${executionId}:resume:work-1-done`],
        'only the work-1-done resume may be scheduled; display accepted/observation/completed/work_result must enqueue zero graph_resume dispatches',
      )
    } finally { store2.close() }
  } finally { unsubscribe() }
})

test('Environment Mode static thinking-out properties and Robot Display Feedback settle without spurious graph_resume', async () => {
  const envGraph = JSON.parse(fs.readFileSync(new URL('../../../../etc/cognitive-graphs/environment-mode.json', import.meta.url), 'utf8'))
  const feedbackGraphDef = validateSvelteFlowGraph(JSON.parse(
    fs.readFileSync(new URL('../../../../etc/cognitive-graphs/robot-display-feedback-mode.json', import.meta.url), 'utf8')))
  for (const nodeId of ['thinking-out', 'response-thinking-out']) {
    const node = envGraph.nodes.find((n: any) => n.id === nodeId)
    assert.equal(node.data.properties.background, true, `${nodeId} static background property must be true`)
  }
  const timestamp = new Date().toISOString()
  writeEnvironmentBridgeState({ enabled: true, updatedAt: timestamp, feedback: [], sessions: {
    body: { sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', status: 'connected',
      firstSeenAt: timestamp, lastSeenAt: timestamp,
      latestObservation: { sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', timestamp,
        capabilities: { actions: ['faceExpression'], expressionLibrary: [{ name: 'thinking', label: 'Thinking' }, { name: 'confused', label: 'Confused' }] },
        state: { body: { authenticated: true } } } },
  } })
  const unsubscribe = subscribeEnvironmentActions('body', () => {})
  try {
    const bgToken = displayFeedbackToken('bg-turn')
    const errToken = displayFeedbackToken('err-turn')
    for (const scenario of [
      { id: 'bg', feedback: { token: bgToken, operation: 'set' as const, expression: 'thinking', timeoutMs: 60000, background: true, sessionId: 'body' } },
      { id: 'err', feedback: { token: errToken, ifToken: errToken, operation: 'set' as const, expression: 'confused', timeoutMs: 5000, background: false, sessionId: 'body' } },
    ]) {
      const work = await submitDisplayFeedback('fixture', scenario.feedback, `fb-${scenario.id}`)
      assert.ok(manager.claim(work.id))
      let executionId = ''
      try {
        const res = await withGraphWork(work, id => manager.attachExecution(work.id, id),
          () => runDurableGraph({ graph: feedbackGraphDef, context: { username: 'fixture', environmentDisplayFeedback: scenario.feedback } }),
          async input => manager.enqueue(input))
        executionId = res.executionId!
      } finally { manager.complete(work.id, true) }

      const action = manager.getAllTasks().find(t => t.type === 'environment_command' && t.durable?.executionId === executionId)!
      assert.equal(action.input.displayToken, scenario.feedback.token)
      assert.equal(action.input.displayIfToken, scenario.feedback.ifToken)
      assert.equal(action.input.displayBackground, scenario.feedback.background)
      assert.ok(manager.claim(action.id))
      recordEnvironmentActionResult({ id: `fb-${scenario.id}-accepted`, actionId: String(action.input.id), timestamp, type: 'accepted', message: 'Accepted' })
      publishEnvironmentObservation({ id: `obs-fb-${scenario.id}`, sessionId: 'body', environmentId: 'fixture', adapter: 'ainekio-gateway', timestamp,
        metadata: { actionId: String(action.input.id) },
        capabilities: { actions: ['faceExpression'], expressionLibrary: [{ name: 'thinking', label: 'Thinking' }, { name: 'confused', label: 'Confused' }] },
        state: { body: { authenticated: true } } }, { username: 'fixture' })
      recordEnvironmentActionResult({ id: `fb-${scenario.id}-completed`, actionId: String(action.input.id), timestamp, type: 'completed', message: 'Applied' })
      await deliverDurableWorkReceipt(action, manager)

      const store = openExecutionStore('fixture')
      try {
        assert.equal(store.get(executionId).status, 'completed', `${scenario.id} display feedback must settle to completed`)
        assert.equal(store.dispatches(executionId).filter(d => d.kind === 'graph_resume').length, 0,
          `${scenario.id} display feedback must enqueue zero graph_resume dispatches`)
      } finally { store.close() }
    }
  } finally { unsubscribe() }
})
