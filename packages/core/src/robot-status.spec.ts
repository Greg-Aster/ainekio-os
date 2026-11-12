import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SvelteFlowGraph } from './cognitive-graph-schema.js'

const originalRoot = process.env.METAHUMAN_ROOT
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-robot-status-'))
process.env.METAHUMAN_ROOT = testRoot
globalThis.fetch = async () => { throw new Error('Network access is forbidden in the Robot Status fixture') }
const { eventBus } = await import('./infrastructure/event-bus/client.js')
eventBus.disconnect()
const { setAuditEnabled } = await import('./audit.js')
setAuditEnabled(false)

const {
  loadRobotStatus,
  parseRobotStatusSituation,
  robotStatusPath,
  saveRobotStatus,
} = await import('./robot-status.js')
const { robotStatusContextBuilderNode } = await import('./nodes/robot-status/context-builder.node.js')
const { robotStatusNode } = await import('./nodes/robot-status/status.node.js')
const { robotStatusOutNode } = await import('./nodes/robot-status/out.node.js')
const { robotStatusWriterNode } = await import('./nodes/robot-status/writer.node.js')
const { buildEnvironmentSelectorEnvelope } = await import('./environment-interface/task-selection.js')
const { robotGoalReviewParserNode } = await import('./nodes/robot-operator/goal-review-parser.node.js')
const { runDurableGraph } = await import('./durable-execution/runtime.js')
const { openExecutionStore } = await import('./durable-execution/storage.js')
const { ExecutionCheckpointer } = await import('./durable-execution/checkpointer.js')
const { validateSvelteFlowGraph, DEFAULT_GRAPH_SCHEDULER } = await import('./cognitive-graph-schema.js')

// Literal fixture inputs use the existing Text Input/JSON Parser contracts. The
// real output nodes commit through the canonical graph saver and projection relay.
async function statusGraph(username: string, steps: Array<{ type?: 'robot_status_out' | 'robot_status_writer'; inputs: Record<string, unknown> }>) {
  const graph: SvelteFlowGraph = { name: 'Robot Status owner fixture', version: '1.0', format: 'svelte-flow',
    scheduler: DEFAULT_GRAPH_SCHEDULER, nodes: [], edges: [] }
  const addNode = (id: string, nodeType: string, properties: Record<string, unknown> = {}) => {
    graph.nodes.push({ id, type: 'genericNode', position: { x: graph.nodes.length * 100, y: 0 },
      data: { label: id, nodeType, properties } })
  }
  for (const [index, step] of steps.entries()) {
    const id = `status-${index}`
    addNode(id, step.type ?? 'robot_status_out')
    for (const [field, value] of Object.entries(step.inputs)) {
      const input = `${id}-${field}`
      const parsed = `${input}-json`
      const isText = typeof value === 'string'
      addNode(input, 'text_input', { message: isText ? value : JSON.stringify(value) })
      if (!isText) {
        addNode(parsed, 'json_parser')
        graph.edges.push({ id: `${input}-parse`, source: input, sourceHandle: 'text', target: parsed, targetHandle: 'text' })
      }
      graph.edges.push({ id: `${input}-out`, source: isText ? input : parsed,
        sourceHandle: isText ? 'text' : 'data', target: id, targetHandle: field })
    }
    if (index) graph.edges.push({ id: `${id}-ordered`, source: `status-${index - 1}`, sourceHandle: 'status',
      target: id, targetHandle: '', data: { kind: 'control' } })
  }
  const result = await runDurableGraph({ graph: validateSvelteFlowGraph(graph),
    context: { username, userId: username, requestId: randomUUID(), environment: 'server' } })
  assert.equal(result.status, 'completed', result.error?.stack)
  const outputs = steps.map((_, index) => {
    const node = result.nodes.get(`status-${index}`)
    assert.equal(node?.status, 'completed')
    return node!.outputs!
  })
  const store = openExecutionStore(username)
  try {
    assert.equal(store.pendingDispatches().filter(dispatch => dispatch.executionId === result.executionId).length, 0,
      'Every status projection must have a committed delivery receipt')
  } finally { store.close() }
  return { executionId: result.executionId!, outputs }
}

after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true })
  if (originalRoot === undefined) delete process.env.METAHUMAN_ROOT
  else process.env.METAHUMAN_ROOT = originalRoot
})

const situation = {
  situationalSummary: 'Connected and attentive beside the work area.',
  environmentDescription: 'A dim work area is the latest supported environment context.',
  currentGoal: 'Continue inspecting the work area.',
  currentIntent: 'Use the next fresh observation to choose a useful continuation.',
  userContext: 'The user is working nearby.',
  uncertainties: ['No fresh image was supplied to this status update.'],
}

const sources = {
  sourceUpdatedAt: {
    environment: '2026-08-27T18:00:00.000Z',
    telemetry: '2026-08-27T18:00:01.000Z',
    conversation: '2026-08-27T18:00:02.000Z',
    robotHistory: '2026-08-27T18:00:03.000Z',
    agency: '2026-08-27T18:00:04.000Z',
  },
  body: {
    sessionId: 'robot-1',
    environmentId: 'ainekio',
    connectionStatus: 'connected',
    observationAt: '2026-08-27T18:00:00.000Z',
    telemetryAt: '2026-08-27T18:00:01.000Z',
    battery: {
      voltage: 7.4,
      observedAt: '2026-08-27T18:00:01.000Z',
    },
    motion: {
      available: true,
      activity: 'idle',
      observedAt: '2026-08-27T18:00:01.000Z',
    },
    state: { posture: 'standing' },
    telemetry: { vbat: 7.4 },
    capabilities: { actions: ['requestMotion'] },
  },
  lastAction: {
    actionId: 'action-1',
    type: 'requestMotion',
    description: 'Wave.',
    status: 'completed',
    message: 'Wave completed.',
    completedAt: '2026-08-27T18:00:03.000Z',
  },
  activeDesires: [{
    id: 'desire-1',
    title: 'Find the cat',
    status: 'planning' as const,
    nextAction: 'desire-agent' as const,
    updatedAt: '2026-08-27T18:00:04.000Z',
  }],
}

test('body activity keeps its telemetry time when a newer observation arrives', async () => {
  const telemetryAt = '2026-10-28T18:00:00.000Z'
  const observationAt = '2026-10-29T19:59:12.000Z'
  const result = await robotStatusContextBuilderNode.execute!({
    instruction: 'Report the recorded body state.',
    environmentSummary: { sessions: [{ sessionId: 'robot-1', environmentId: 'ainekio',
      status: 'connected', latestObservation: { timestamp: observationAt,
        state: { body: { motionAvailable: true } }, capabilities: {} } }] },
    robotTelemetry: [{ sessionId: 'robot-1', updatedAt: telemetryAt,
      robotStatus: { state: 'active', vbat: 7.4 } }],
  }, {})
  assert.equal(result.sourceFacts.body.observationAt, observationAt)
  assert.equal(result.sourceFacts.body.telemetryAt, telemetryAt)
  assert.deepEqual(result.sourceFacts.body.motion,
    { available: true, activity: 'active', observedAt: telemetryAt })
})

test('observation-only status projections do not renew carried activity evidence', async () => {
  const username = 'status-carried-activity'
  const telemetryAt = '2026-10-28T18:00:00.000Z'
  const initial = structuredClone(sources)
  initial.body = { ...initial.body, observationAt: telemetryAt, telemetryAt,
    motion: { available: true, activity: 'active', observedAt: '2026-10-29T18:00:00.000Z' } }
  saveRobotStatus(username, situation, initial)
  for (const [sessionId, available] of [['robot-1', false], ['other-robot', true]] as const) {
    const observationAt = '2026-10-29T19:59:12.000Z'
    const { outputs } = await statusGraph(username, [{ inputs: {
      observation: { sessionId, environmentId: 'ainekio', timestamp: observationAt,
        state: { body: { motionAvailable: available } }, capabilities: {} },
      userInstruction: 'Hello.',
    } }])
    const expected = sessionId === 'robot-1'
      ? { available, activity: 'active', observedAt: telemetryAt }
      : { available, activity: '', observedAt: '' }
    assert.deepEqual(outputs[0].status.body.motion, expected)
    assert.deepEqual(loadRobotStatus(username)?.body?.motion, expected)
    assert.equal(loadRobotStatus(username)?.body?.observationAt, observationAt)
  }
})

test('fresh telemetry replaces activity whose old timestamp was renewed by an observation', () => {
  const username = 'status-inflated-activity-time'
  const before = structuredClone(sources)
  before.body = { ...before.body, observationAt: '2026-10-29T20:00:00.000Z',
    telemetryAt: '2026-10-28T18:00:00.000Z',
    motion: { available: false, activity: 'active', observedAt: '2026-10-29T20:00:00.000Z' } }
  saveRobotStatus(username, situation, before)
  const next = { ...structuredClone(before), body: { ...before.body,
    observationAt: '2026-10-29T19:00:00.000Z', telemetryAt: '2026-10-29T19:59:00.000Z',
    telemetry: { state: 'idle' },
    motion: { available: true, activity: 'idle', observedAt: '2026-10-29T19:59:00.000Z' } } }
  const updated = saveRobotStatus(username, situation, next)
  assert.deepEqual(updated.body?.motion,
    { available: false, activity: 'idle', observedAt: '2026-10-29T19:59:00.000Z' })
  assert.deepEqual(loadRobotStatus(username)?.body?.motion, updated.body?.motion)
})

test('reading legacy activity dates uses its telemetry source without rewriting stored evidence', () => {
  const username = 'status-legacy-activity-read'
  saveRobotStatus(username, situation, sources)
  const file = robotStatusPath(username)
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
  legacy.body.motion.observedAt = '2026-10-29T20:59:00.850103+00:00'
  for (const telemetryAt of ['2026-10-28T18:05:33.063Z', '']) {
    legacy.body.telemetryAt = telemetryAt
    const raw = JSON.stringify(legacy)
    fs.writeFileSync(file, raw)
    const loaded = loadRobotStatus(username)!
    assert.equal(loaded.body?.motion.observedAt, telemetryAt)
    assert.equal(loaded.body?.motion.activity, legacy.body.motion.activity)
    assert.deepEqual(loaded.history, legacy.history)
    assert.deepEqual(loaded.body?.state, legacy.body.state)
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'Reading repairs the projection, not the archived evidence')
  }
})

test('equal-time observation updates keep incoming field precedence', () => {
  const username = 'status-equal-observation-time'
  saveRobotStatus(username, situation, sources)
  const next = structuredClone(sources)
  next.body = { ...next.body, state: { posture: 'seated' },
    capabilities: { ...next.body.capabilities, actions: ['captureImage'] },
    motion: { ...next.body.motion, available: false } }
  const updated = saveRobotStatus(username, situation, next)
  assert.deepEqual(updated.body?.state, next.body.state)
  assert.deepEqual(updated.body?.capabilities, next.body.capabilities)
  assert.equal(updated.body?.motion.available, false)
  assert.equal(updated.body?.motion.observedAt, sources.body.telemetryAt)
})

test('Robot Status strictly validates semantic model output', () => {
  assert.deepEqual(parseRobotStatusSituation(situation), situation)
  assert.throws(
    () => parseRobotStatusSituation({ ...situation, action: 'walk' }),
    /exactly the six situation fields/,
  )
  assert.throws(
    () => parseRobotStatusSituation({ ...situation, situationalSummary: '' }),
    /requires a situationalSummary/,
  )
})

test('Robot Status output nodes require the checkpoint owner rather than writing tasks independently', async () => {
  await assert.rejects(robotStatusOutNode.execute!({ taskDecision: { objective: 'An unowned task.' } },
    { username: 'unowned-status-output' }), /requires checkpointed execution/)
  await assert.rejects(robotStatusWriterNode.execute!({ response: JSON.stringify(situation), sourceFacts: sources },
    { username: 'unowned-status-output' }), /requires checkpointed execution/)
  assert.equal(loadRobotStatus('unowned-status-output'), null)
})

test('Robot Status storage keeps deterministic facts and bounded history in one profile snapshot', () => {
  const username = 'robot-status-owner'
  const first = saveRobotStatus(username, situation, sources)
  assert.deepEqual(first.body?.battery, {
    voltage: 7.4,
    observedAt: '2026-08-27T18:00:01.000Z',
  })
  assert.deepEqual(first.body?.motion, {
    available: true,
    activity: 'idle',
    observedAt: '2026-08-27T18:00:01.000Z',
  })
  assert.equal(first.body?.telemetry.vbat, 7.4)
  assert.equal(first.lastAction?.status, 'completed')
  assert.equal(first.agency.activeDesires[0]?.title, 'Find the cat')
  assert.deepEqual(first.history, [])

  for (let index = 0; index < 10; index += 1) {
    saveRobotStatus(username, {
      ...situation,
      situationalSummary: `Status update ${index}`,
    }, sources)
  }
  const loaded = loadRobotStatus(username)
  assert.equal(loaded?.history.length, 8)
  assert.equal(loaded?.history.at(-1)?.situationalSummary, 'Status update 8')
  assert.equal(robotStatusPath(username), path.join(testRoot, 'profiles', username, 'state', 'robot-status.json'))
})

test('Robot Status projects execution lifecycle without rewriting or reviving its objective', async () => {
  for (const outcome of ['act', 'wait', 'failed']) for (const state of ['running', 'waiting', 'idle', 'completed', 'failed', 'cancelled'] as const) {
    const username = `status-execution-${state}-${outcome}`
    const store = openExecutionStore(username)
    try {
      const definition = { graphId: 'status-owner-fixture', graphHash: 'fixture-v1', runtimeVersion: 'fixture-v1',
        checkpointSchemaVersion: 1, nodeVersions: {} }
      const execution = store.create(username, definition)
      const lease = store.claim(execution.executionId, definition)
      const task = { objectiveId: randomUUID(), executionId: execution.executionId,
        objective: 'Inspect the work area.', completionCriteria: 'Report the observed target location.',
        instruction: 'Inspect the work area and report the target location.', source: 'user',
        decision: { outcome, objectiveComplete: false, reason: outcome === 'failed' ? 'The selected action was rejected.' : 'Inspect another area.' },
        selectedAction: null, actionId: '', actionStatus: '', feedback: null, baselineFrame: null,
        updatedAt: new Date().toISOString() }
      await new ExecutionCheckpointer(store, lease).put({ configurable: { thread_id: execution.executionId } }, {
        v: 4, id: randomUUID(), ts: task.updatedAt,
        channel_values: { executionTransition: { transitionId: 'objective', task } },
        channel_versions: {}, versions_seen: {},
      }, { source: 'loop', step: 0, parents: {} })
      saveRobotStatus(username, situation, sources)
      if (state === 'cancelled') store.cancel(execution.executionId, { eventId: 'cancel', kind: 'user_cancelled', payload: {} })
      else if (state === 'idle') store.settle(lease, 'waiting', 'user_or_autonomy')
      else if (state !== 'running') store.settle(lease, state)

      const read = await robotStatusNode.execute!({}, { username }, { historyLimit: 3 })
      const active = outcome !== 'failed' && ['running', 'waiting'].includes(state)
      assert.equal(read.task?.executionStatus ?? null, active ? state : null)
      assert.equal(read.task?.objective ?? null, active ? task.objective : null)
      assert.equal(read.context.situation.currentGoal, active ? task.objective : '')
      assert.equal(read.context.situation.currentIntent, active ? task.decision.reason : '',
        'Terminal executions retain their decision as history, not current intent')
      const parked = outcome !== 'failed' && state === 'idle'
      assert.deepEqual(read.context.parkedGoals?.map((goal: any) => [goal.executionId, goal.objective, goal.updatedAt]),
        parked ? [[task.executionId, task.objective, task.updatedAt]] : [])
      assert.deepEqual(store.task(execution.executionId), task, 'A status read cannot rewrite the execution decision')
      const saved = saveRobotStatus(username, situation, sources)
      assert.equal(saved.situation.currentGoal, read.context.situation.currentGoal)
      assert.equal(saved.situation.currentIntent, read.context.situation.currentIntent)
      assert.equal(saved.task?.executionStatus ?? null, active ? state : null)
      assert.deepEqual(saved.parkedGoals, read.status.parkedGoals)
      assert.equal('history' in read.context, false, 'Prior summaries belong to the separate history output')
      if (parked) {
        store.release(lease)
        const resumed = store.claim(execution.executionId, definition)
        store.db.transaction(() => store.commitTransition(execution.executionId, 'resumed-checkpoint', {
          transitionId: 'resumed-work', status: 'running',
        }))()
        const running = loadRobotStatus(username)!
        assert.equal(running.task?.executionId, task.executionId)
        assert.equal(running.situation.currentGoal, task.objective)
        assert.deepEqual(running.parkedGoals, [])
        store.settle(resumed, 'waiting', 'user_or_autonomy')
        store.release(resumed)
        const resting = loadRobotStatus(username)!
        assert.equal(resting.task, null)
        assert.equal(resting.parkedGoals[0].objectiveId, task.objectiveId)
        assert.deepEqual(store.task(execution.executionId), task)
      }
    } finally { store.close() }
  }
})

test('out-of-order projections retain facts together with their independent source timestamps', () => {
  const username = 'robot-status-out-of-order'
  const time = (second: number) => `2026-08-27T18:00:${String(second).padStart(2, '0')}.000Z`
  const latest = structuredClone(sources)
  const visual = {
    observationId: 'visual-source:save:visual-observation', executionId: 'visual-source', occurrenceId: 'visual-source:save',
    environmentId: latest.body.environmentId, adapter: 'fixture-adapter', robotId: null, sessionId: latest.body.sessionId,
    interpretedAt: time(11), summary: 'An object is visible near a chair.', uncertainties: ['Its identity is uncertain.'],
    frameIds: ['latest-frame'], frames: [{ id: 'latest-frame', timestamp: time(10), actionId: 'newest-action' }],
  }
  latest.sourceUpdatedAt = { environment: time(10), telemetry: time(20), conversation: time(10), robotHistory: time(10), agency: time(10) }
  latest.lastAction = { ...latest.lastAction, actionId: 'newest-action', completedAt: time(10) }
  latest.body = { ...latest.body, observationAt: time(10), telemetryAt: time(20),
    battery: { voltage: 7.4, observedAt: time(20) }, motion: { available: true, activity: 'idle', observedAt: time(20) } }
  saveRobotStatus(username, situation, { ...latest, latestVisualObservation: visual })

  for (const second of [8, 9, 10]) {
    const older = structuredClone(latest)
    older.sourceUpdatedAt.environment = time(second)
    older.sourceUpdatedAt.telemetry = time(15)
    older.sourceUpdatedAt.robotHistory = time(Math.min(second, 9))
    older.lastAction = { ...older.lastAction, actionId: `older-action-${second}`, completedAt: time(Math.min(second, 9)) }
    older.body = { ...older.body, observationAt: time(second), telemetryAt: time(15), telemetry: { vbat: 6.2 },
      battery: { voltage: 6.2, observedAt: time(15) }, motion: { available: false, activity: 'old-state', observedAt: time(15) } }
    const snapshot = saveRobotStatus(username, situation, { ...older, latestVisualObservation: {
      ...visual, observationId: 'older-view', interpretedAt: time(25), frameIds: ['older-frame'],
      frames: [{ id: 'older-frame', timestamp: time(7) }],
    } })
    assert.deepEqual(snapshot.latestVisualObservation, visual, 'A later interpretation of an old image is not a newer view')
    assert.equal(snapshot.lastAction?.actionId, 'newest-action')
    assert.equal(snapshot.sourceUpdatedAt.robotHistory, time(10))
    assert.equal(snapshot.body?.observationAt, time(10))
    assert.equal(snapshot.sourceUpdatedAt.environment, time(10))
    assert.equal(snapshot.body?.telemetryAt, time(20))
    assert.equal(snapshot.sourceUpdatedAt.telemetry, time(20))
    assert.deepEqual(snapshot.body?.telemetry, latest.body.telemetry)
    assert.deepEqual(snapshot.body?.battery, latest.body.battery)
    assert.deepEqual(snapshot.body?.motion, {
      // Keep the existing incoming-observation precedence when source times tie.
      available: second === 10 ? older.body.motion.available : latest.body.motion.available,
      activity: latest.body.motion.activity,
      observedAt: latest.body.telemetryAt,
    })
  }

  const freshTelemetry = structuredClone(latest)
  freshTelemetry.body = { ...freshTelemetry.body, observationAt: time(9), telemetryAt: time(25), telemetry: { vbat: 7.1 },
    battery: { voltage: 7.1, observedAt: time(25) } }
  freshTelemetry.sourceUpdatedAt.environment = time(9)
  freshTelemetry.sourceUpdatedAt.telemetry = time(25)
  const updated = saveRobotStatus(username, situation, freshTelemetry)
  assert.deepEqual(updated.latestVisualObservation, visual, 'A general refresh retains image identity and capture time')
  assert.equal(updated.body?.observationAt, time(10))
  assert.equal(updated.body?.telemetryAt, time(25))
  assert.deepEqual(updated.body?.battery, freshTelemetry.body.battery)
  assert.deepEqual(updated.body?.telemetry, freshTelemetry.body.telemetry)
  assert.equal(updated.sourceUpdatedAt.environment, time(10))
  assert.equal(updated.sourceUpdatedAt.telemetry, time(25))
})

test('Robot Status context separates current facts from bounded narrative context', async () => {
  const result = await robotStatusContextBuilderNode.execute!({
    instruction: 'Return the compact status JSON.',
    environmentSummary: {
      sessions: [{
        sessionId: 'robot-1',
        environmentId: 'ainekio',
        status: 'connected',
        lastSeenAt: '2026-08-27T18:00:00.000Z',
        latestObservation: {
          timestamp: '2026-08-27T18:00:00.000Z',
          state: { posture: 'standing', body: { motionAvailable: true } },
          location: { label: 'work area' },
          visual: {
            id: 'frame-1',
            timestamp: '2026-08-27T18:00:00.000Z',
            source: 'robot-camera',
            dataUrl: 'data:image/jpeg;base64,secret-image-data',
          },
          capabilities: {
            actions: ['requestMotion'],
            movement: true,
            visual: true,
          },
        },
      }],
    },
    robotTelemetry: [{
      sessionId: 'robot-1',
      updatedAt: '2026-08-27T18:00:01.000Z',
      robotStatus: { vbat: 7.4, state: 'idle' },
    }],
    conversationHistory: [{
      role: 'user',
      content: 'Please keep looking for the cat.',
      timestamp: '2026-08-27T18:00:02.000Z',
    }],
    robotHistory: [{
      role: 'robot',
      timestamp: '2026-08-27T18:00:03.000Z',
      meta: {
        bridgeRecord: {
          direction: 'inbound',
          status: 'completed',
          actionId: 'action-1',
          message: 'Wave completed.',
          action: { id: 'action-1', type: 'requestMotion', description: 'wave' },
        },
      },
    }],
    activeDesires: sources.activeDesires,
    previousStatus: { situation, history: [{ currentGoal: 'Find the cat' }] },
  }, {})

  assert.equal(result.sourceFacts.body.telemetry.vbat, 7.4)
  assert.deepEqual(result.sourceFacts.body.battery, {
    voltage: 7.4,
    observedAt: '2026-08-27T18:00:01.000Z',
  })
  assert.deepEqual(result.sourceFacts.body.motion, {
    available: true,
    activity: 'idle',
    observedAt: '2026-08-27T18:00:01.000Z',
  })
  assert.equal(result.sourceFacts.lastAction.description, 'wave')
  assert.equal(result.sourceFacts.lastAction.status, 'completed')
  assert.equal(result.sourceFacts.activeDesires[0].title, 'Find the cat')
  assert.deepEqual(result.sourceFacts.body.capabilities.actions, ['requestMotion'])
  assert.equal(result.context.environmentEvidence.location.label, 'work area')
  assert.equal(JSON.stringify(result.context).includes('secret-image-data'), false)
  assert.equal(result.messages.length, 2)
})

test('Robot Status retains the semantic description of the last generated movement', async () => {
  const result = await robotStatusContextBuilderNode.execute!({
    instruction: 'Return the compact status JSON.',
    robotHistory: [{
      role: 'robot',
      timestamp: '2026-08-27T18:00:03.000Z',
      meta: {
        bridgeRecord: {
          direction: 'inbound',
          status: 'completed',
          actionId: 'motion-1',
          message: 'done',
          action: {
            id: 'motion-1',
            type: 'requestMotion',
            description: 'Raised both front legs, paused, then returned to standing.',
          },
        },
      },
    }],
  }, {})

  assert.equal(
    result.sourceFacts.lastAction.description,
    'Raised both front legs, paused, then returned to standing.',
  )
})

test('Robot Status writer and reusable input node share the same canonical snapshot', async () => {
  const username = 'robot-status-writer-owner'
  const { executionId, outputs: [, written] } = await statusGraph(username, [
    { inputs: { taskDecision: { objective: situation.currentGoal, outcome: 'act', objectiveComplete: false,
      reason: 'Inspect the work area.', requiredCompletionBasis: 'visual_observation' } } },
    { type: 'robot_status_writer', inputs: {
      response: JSON.stringify({ ...situation, currentGoal: 'A different objective suggested by status prose.' }),
      sourceFacts: { ...sources, body: { ...sources.body, state: {
        body: { robotId: 'selected-body' },
        gateway: { robots: { 'selected-body': { model: 'v2-12servo' } } },
      } } },
    } },
  ])
  assert.equal(written.persisted, true)
  assert.equal(written.event.meta.type, 'robot_status')
  assert.match(written.event.content, /^Robot Status saved\.\n/)
  assert.match(written.event.content, /Robot: selected-body \(v2-12servo\)/)
  assert.match(written.event.content, /Bridge session: robot-1 \(connected\)/)
  assert.match(written.event.content, /Observation time: 2026-08-27T18:00:00.000Z/)
  assert.match(written.event.content, /Telemetry time: 2026-08-27T18:00:01.000Z/)
  assert.match(written.event.content, /Battery: 7\.4 V/)
  assert.match(written.event.content, /Motion: available\nBody state: idle/)
  assert.match(written.event.content, /Last action: Wave\. — completed/)
  assert.match(written.event.content, /Environment: A dim work area is the latest supported environment context\./)
  assert.match(written.event.content, /Goal: Continue inspecting the work area\./)
  assert.match(written.event.content, /Intent: Inspect the work area\./)
  assert.match(written.event.content, /User context: The user is working nearby\./)
  assert.match(written.event.content, /Active desires: Find the cat \(planning\)/)
  assert.match(written.event.content, /Uncertainties: No fresh image was supplied to this status update\./)
  assert.equal(written.event.content.includes(situation.situationalSummary), false)

  const read = await robotStatusNode.execute!({}, { username }, { historyLimit: 3 })
  assert.equal(read.found, true)
  assert.equal(read.status.updatedAt, written.status.updatedAt)
  assert.equal(read.context.situation.currentGoal, '', 'The fixture graph ended; its saved objective is historical')
  assert.equal(read.task, null)
  assert.equal(read.context.body.battery.voltage, 7.4)
  assert.equal(read.context.body.identity.robotId, 'selected-body')
  assert.equal(read.context.body.motion.available, true)
  assert.equal(read.context.lastAction.description, 'Wave.')
  assert.equal(read.context.agency.activeDesires[0].title, 'Find the cat')
  assert.equal(read.context.agency.activeDesires[0].nextAction, 'desire-agent')
  assert.equal('reason' in read.context.agency.activeDesires[0], false)
  assert.equal('telemetry' in read.context.body, false)
  assert.equal('capabilities' in read.context.body, false)
  assert.equal(JSON.stringify(read.context).length < 6_000, true)
  assert.equal(read.historyContext.task, null)
  const saved = openExecutionStore(username)
  try { assert.equal(saved.task(executionId)?.objective, situation.currentGoal) } finally { saved.close() }
  assert.deepEqual(Object.keys(read.historyContext).sort(), ['history', 'situation', 'task', 'updatedAt'])
})

test('Robot Status Out persists the Environment LLM task and correlated action result without another model call', async () => {
  const username = 'robot-status-out-owner'
  const selectedAction = { type: 'requestMotion', description: 'walk_forward' }
  const initialInput = {
    observation: {
      sessionId: 'robot-1',
      environmentId: 'ainekio',
      timestamp: '2026-09-02T18:00:00.000Z',
      state: { posture: 'standing', body: { motionAvailable: true } },
      capabilities: {
        actions: ['requestMotion'],
        movement: true,
        visual: true,
      },
    },
    instruction: 'Move closer to inspect the object.',
    userInstruction: 'Move closer to inspect the object.',
    inputSource: 'user',
    taskDecision: {
      objective: 'Inspect the object from closer range.',
      outcome: 'act',
      reason: 'The advertised forward walk is the appropriate current step.',
      objectiveComplete: false,
      continuationPolicy: 'bounded',
      requiredCompletionBasis: 'visual_observation',
      motionClass: 'open_loop_displacement',
      actionPurpose: 'information_gain',
      visualEvidenceMode: 'comparison',
    },
    actions: [selectedAction],
    response: 'I will move closer for a better view.',
    bridgeRecord: {
      status: 'coordinated_for_adapter',
      message: 'Queued for the robot adapter.',
      requestedActions: [selectedAction],
      commands: [{ id: 'action-2' }],
    },
    frames: [{
      id: 'before-action-2',
      timestamp: '2026-09-02T18:00:00.000Z',
      source: 'robot-camera',
      metadata: { correlationId: 'cycle-2' },
    }],
  }
  const completedInput = {
    observation: {
      sessionId: 'robot-1',
      environmentId: 'ainekio',
      timestamp: '2026-09-02T18:00:05.000Z',
      state: { posture: 'standing', body: { motionAvailable: true } },
      capabilities: {
        actions: ['requestMotion'],
        movement: true,
        visual: true,
      },
    },
    instruction: 'Move closer to inspect the object.',
    inputSource: 'user',
    taskDecision: {
      objective: 'Inspect the object from closer range.',
      outcome: 'complete',
      reason: 'The correlated result and current view satisfy the objective.',
      objectiveComplete: true,
      continuationPolicy: 'none',
      requiredCompletionBasis: 'visual_observation',
      completionEvidence: 'The object occupies more of the current view.',
    },
    terminalFeedback: {
      id: 'feedback-2',
      timestamp: '2026-09-02T18:00:05.000Z',
      type: 'completed',
      actionId: 'action-2',
      message: 'Forward walk completed.',
    },
    actionContext: { actionId: 'action-2', requested: selectedAction },
    bridgeRecord: { status: 'no_actions', message: 'No further action selected.' },
  }
  const { executionId, outputs: [initial, completed] } = await statusGraph(username,
    [{ inputs: initialInput }, { inputs: completedInput }])

  assert.equal(initial.persisted, true)
  assert.equal(initial.task.objective, 'Inspect the object from closer range.')
  assert.equal(initial.task.selectedAction.description, 'walk_forward')
  assert.equal(initial.task.actionId, 'action-2')
  assert.equal(initial.task.baselineFrame.id, 'before-action-2')
  assert.equal(initial.lastAction.description, 'walk_forward')

  assert.equal(completed.task.decision.objectiveComplete, true)
  assert.equal(completed.task.actionStatus, 'completed')
  assert.equal(completed.task.feedback.actionId, 'action-2')
  assert.equal(completed.lastAction.description, 'walk_forward')
  assert.equal(completed.lastAction.status, 'completed')
  assert.equal(completed.status.situation.currentGoal, '')
  assert.equal(loadRobotStatus(username)?.task, null)
  const store = openExecutionStore(username)
  try {
    assert.equal(store.task(executionId)?.decision.objectiveComplete, true)
    assert.equal(store.task(executionId)?.objectiveId, initial.task.objectiveId)
    assert.equal(completed.task.executionId, executionId)
  } finally { store.close() }
})

test('Robot Status Out preserves the originating task instruction while recording an autonomous next step', async () => {
  const username = 'robot-status-goal-continuation-owner'
  const initialInput = {
    taskDecision: {
      objective: 'Find the cat.',
      outcome: 'continue',
      reason: 'A better-lit viewpoint may provide useful evidence.',
      objectiveComplete: false,
      requiredCompletionBasis: 'visual_observation',
      observationSummary: 'The latest view is too dark to establish the cat location.',
      nextInstruction: 'Move to a better-lit area and continue looking for the cat.',
    },
  }
  const continuationInput = {
    instruction: 'Move to a better-lit area and continue looking for the cat.',
    inputSource: 'autonomy',
    taskDecision: {
      objective: 'Find the cat.',
      outcome: 'act',
      reason: 'Changing viewpoint may improve the available visual evidence.',
      objectiveComplete: false,
      requiredCompletionBasis: 'action_result',
    },
    actions: [{ type: 'requestMotion', description: 'walk_forward' }],
    bridgeRecord: {
      status: 'coordinated_for_adapter',
      requestedActions: [{ type: 'requestMotion', description: 'walk_forward' }],
      commands: [{ id: 'continuation-action' }],
    },
  }
  const { outputs: [, delegatedStep] } = await statusGraph(username,
    [{ inputs: initialInput }, { inputs: continuationInput }])

  assert.equal(delegatedStep.task.objective, 'Find the cat.')
  assert.equal(delegatedStep.task.instruction, 'Find the cat.')
  assert.equal(delegatedStep.task.decision.reason, 'Changing viewpoint may improve the available visual evidence.')
  assert.equal(delegatedStep.task.source, 'user')
  assert.equal(delegatedStep.task.selectedAction.description, 'walk_forward')
})

test('Robot Status Out preserves the execution origin rather than inferring steering from input prose', async () => {
  const username = 'robot-status-user-restatement-owner'
  const initialInput = {
    instruction: 'Inspect the keys when useful.',
    inputSource: 'autonomy',
    taskDecision: {
      objective: 'Find the missing keys.',
      outcome: 'wait',
      reason: 'No current image is available.',
      objectiveComplete: false,
      requiredCompletionBasis: 'visual_observation',
    },
  }
  const restatedInput = {
    instruction: 'Please continue helping me find my missing keys.',
    userInstruction: 'Please continue helping me find my missing keys.',
    inputSource: 'user',
    taskDecision: {
      objective: 'Find the missing keys.',
      outcome: 'act',
      reason: 'The user renewed the existing search request.',
      objectiveComplete: false,
      requiredCompletionBasis: 'visual_observation',
    },
  }
  const { outputs: [initial, restated] } = await statusGraph(username,
    [{ inputs: initialInput }, { inputs: restatedInput }])

  assert.equal(restated.task.objective, 'Find the missing keys.')
  assert.equal(restated.task.instruction, 'Inspect the keys when useful.')
  assert.equal(restated.task.source, 'autonomy')
  assert.equal(restated.task.objectiveId, initial.task.objectiveId)
})

test('a new workflow does not copy a previous workflow intent into its new user context', async () => {
  const username = 'robot-status-intent-owner'
  const earlier = await statusGraph(username, [{ inputs: {
    userInstruction: 'The earlier activity.', response: 'That activity is finished.',
    taskDecision: { objective: 'An earlier activity.', completionCriteria: 'The activity is finished.',
      outcome: 'complete', objectiveComplete: true, reason: 'The earlier activity is finished.' },
  } }])
  const { outputs: [next] } = await statusGraph(username, [{ inputs: {
    userInstruction: 'A separate conversation.', response: 'A new conversational reply.', taskDecision: null,
  } }])
  assert.equal(next.status.situation.userContext, 'A separate conversation.')
  assert.equal(next.status.situation.currentIntent, '')
  const store = openExecutionStore(username)
  try {
    assert.equal(store.task(earlier.executionId)?.decision.reason, 'The earlier activity is finished.')
    assert.equal(next.status.history.some((entry: any) => entry.currentIntent === 'The earlier activity is finished.'), false)
  } finally { store.close() }
})

test('Robot Status Out records a new action within the execution without replacing its objective', async () => {
  const username = 'robot-status-standalone-action-owner'
  const initialInput = {
    instruction: 'Locate the missing object.',
    userInstruction: 'Locate the missing object.',
    inputSource: 'user',
    taskDecision: {
      objective: 'Locate the missing object.',
      outcome: 'act',
      reason: 'A new viewpoint is needed.',
      objectiveComplete: false,
      requiredCompletionBasis: 'visual_observation',
    },
    actions: [{ type: 'captureImage', target: 'current_surroundings' }],
    bridgeRecord: {
      status: 'coordinated_for_adapter',
      requestedActions: [{ type: 'captureImage', target: 'current_surroundings' }],
      commands: [{ id: 'search-capture' }],
    },
  }
  const standaloneInput = {
    instruction: 'Turn right forty-five degrees.',
    userInstruction: 'Turn right forty-five degrees.',
    inputSource: 'user',
    taskDecision: null,
    actions: [{ type: 'requestMotion', description: 'turn_right_45' }],
    bridgeRecord: {
      status: 'coordinated_for_adapter',
      requestedActions: [{ type: 'requestMotion', description: 'turn_right_45' }],
      commands: [{ id: 'standalone-turn' }],
    },
  }
  const returnedInput = {
    taskDecision: null,
    terminalFeedback: {
      type: 'completed',
      actionId: 'standalone-turn',
      message: 'Turn completed.',
    },
    actionContext: {
      actionId: 'standalone-turn',
      requested: { type: 'requestMotion', description: 'turn_right_45' },
    },
  }
  const { outputs: [initial, standalone, returned] } = await statusGraph(username,
    [{ inputs: initialInput }, { inputs: standaloneInput }, { inputs: returnedInput }])

  assert.equal(standalone.task.objective, 'Locate the missing object.')
  assert.equal(standalone.task.actionId, 'standalone-turn')
  assert.equal(standalone.task.actionStatus, 'coordinated_for_adapter')
  assert.equal(standalone.task.feedback, null)
  assert.deepEqual(standalone.task.decision, initial.task.decision)
  assert.equal(standalone.task.objectiveId, initial.task.objectiveId)
  assert.equal(standalone.lastAction.description, 'turn_right_45')
  assert.equal(standalone.lastAction.actionId, 'standalone-turn')

  assert.equal(returned.task.objective, 'Locate the missing object.')
  assert.equal(returned.task.actionId, 'standalone-turn')
  assert.equal(returned.task.actionStatus, 'completed')
  assert.equal(returned.task.feedback.actionId, 'standalone-turn')
  assert.deepEqual(returned.task.decision, initial.task.decision)
  assert.equal(returned.lastAction.description, 'turn_right_45')
  assert.equal(returned.lastAction.status, 'completed')

  // A different execution may share the status file, but must not adopt its goal.
  const { executionId, outputs: [unrelated] } = await statusGraph(username, [{ inputs: standaloneInput }])
  assert.notEqual(executionId, initial.task.executionId)
  assert.equal(unrelated.task, null)
})

test('correlated terminal facts advance without a semantic objective change', async () => {
  for (const type of ['completed', 'failed', 'cancelled']) {
    const { outputs: [sent, returned] } = await statusGraph(`result-facts-${type}`, [
      { inputs: { taskDecision: { objective: 'Inspect the area.', completionCriteria: 'The target is identified.',
        outcome: 'act', objectiveComplete: false, reason: 'Obtain evidence.' },
        actions: [{ type: 'captureImage' }],
        bridgeRecord: { status: 'coordinated_for_adapter', commands: [{ id: 'current-action' }] } } },
      { inputs: { taskDecision: null,
        terminalFeedback: { actionId: 'current-action', type, message: 'Returned physical evidence.' },
        actionContext: { actionId: 'current-action', requested: { type: 'captureImage' } } } },
    ])
    assert.equal(returned.task.actionStatus, type)
    assert.equal(returned.task.feedback.actionId, 'current-action')
    assert.deepEqual(returned.task.decision, sent.task.decision)
    assert.equal(returned.task.objectiveId, sent.task.objectiveId)
    assert.equal(returned.task.completionCriteria, sent.task.completionCriteria)
  }
})

test('Robot Status Out projects the correlated LLM completion decision from the same execution', async () => {
  const username = 'robot-status-overlapping-result-owner'
  const initialInput = {
    instruction: 'Inspect the work area.',
    userInstruction: 'Inspect the work area.',
    inputSource: 'user',
    taskDecision: {
      objective: 'Inspect the work area.',
      outcome: 'act',
      reason: 'A current image is needed.',
      objectiveComplete: false,
      requiredCompletionBasis: 'visual_observation',
    },
    actions: [{ type: 'captureImage', target: 'current_surroundings' }],
    bridgeRecord: {
      status: 'coordinated_for_adapter',
      requestedActions: [{ type: 'captureImage', target: 'current_surroundings' }],
      commands: [{ id: 'current-capture' }],
    },
  }
  const completedInput = {
    taskDecision: {
      objective: 'Inspect the work area.',
      outcome: 'complete',
      reason: 'The current visual evidence establishes the saved objective.',
      objectiveComplete: true,
      requiredCompletionBasis: 'visual_observation',
      observationSummary: 'The work area is visible in the current camera frame.',
    },
    terminalFeedback: {
      type: 'completed',
      actionId: 'current-capture',
      message: 'done',
    },
    actionContext: {
      actionId: 'current-capture',
      requested: { type: 'captureImage', target: 'current_surroundings' },
    },
  }
  const { outputs: [initial, result] } = await statusGraph(username,
    [{ inputs: initialInput }, { inputs: completedInput }])

  assert.equal(result.task.objective, 'Inspect the work area.')
  assert.equal(result.task.decision.objectiveComplete, true)
  assert.equal(result.task.source, 'user')
  assert.equal(result.status.situation.currentGoal, '')
  assert.equal(result.lastAction.actionId, 'current-capture')
  assert.equal(result.task.objectiveId, initial.task.objectiveId)
})

test('Environment selector receives the decision-bearing Robot Status fields', async () => {
  const username = 'robot-status-environment-owner'
  await statusGraph(username, [
    { inputs: { taskDecision: { objective: situation.currentGoal, outcome: 'act', objectiveComplete: false,
      reason: 'Inspect the work area.', requiredCompletionBasis: 'visual_observation' } } },
    { type: 'robot_status_writer', inputs: { response: JSON.stringify(situation), sourceFacts: sources } },
  ])
  const read = await robotStatusNode.execute!({}, { username }, { historyLimit: 3 })
  const envelope = JSON.parse(buildEnvironmentSelectorEnvelope({
    instruction: 'Continue the current goal.',
    observation: {
      sessionId: 'robot-1',
      environmentId: 'ainekio',
      timestamp: '2026-08-27T18:05:00.000Z',
      state: {},
      capabilities: {
        actions: ['requestMotion'],
        motionClasses: ['body_local'],
        navigation: false,
        visual: true,
        movement: true,
      },
    },
    robotStatus: { ...read.context, agency: { activeDesires: Array.from({ length: 5 }, (_, index) => ({
      ...read.context.agency.activeDesires[0], id: `desire-${index}`,
    })) } },
  } as any))

  assert.equal(envelope.robotStatus.body.battery.voltage, 7.4)
  assert.equal(envelope.robotStatus.body.motion.available, true)
  assert.equal(envelope.robotStatus.lastAction.description, 'Wave.')
  assert.equal(envelope.robotStatus.situation.currentGoal, '')
  assert.equal(envelope.robotStatus.task, null)
  assert.equal(envelope.robotStatus.agency.activeDesires[0].title, 'Find the cat')
  assert.equal(envelope.robotStatus.agency.activeDesires[0].nextAction, 'desire-agent')
  assert.equal('reason' in envelope.robotStatus.agency.activeDesires[0], false)
  assert.equal(envelope.robotStatus.agency.activeDesires.length, 5)
  assert.ok(envelope.robotStatus.agency.activeDesires.every((desire: any) => desire.nextAction === 'desire-agent'))
  assert.match(envelope.robotStatus.agency.purpose, /Pending work for Desire Agent/)
})

test('Robot Status has one editable refresh graph and is read and written by action executors', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
  const graphPath = path.join(repositoryRoot, 'etc/cognitive-graphs/robot-status-mode.json')
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  const nodeTypes = graph.nodes.map((node: any) => node.data?.nodeType)
  assert.equal(nodeTypes.filter((type: string) => type === 'model_router').length, 1)
  assert.equal(nodeTypes.filter((type: string) => type === 'robot_status_writer').length, 1)
  assert.equal(nodeTypes.filter((type: string) => type === 'system_buffer').length, 1)
  assert.equal(nodeTypes.includes('active_desires'), true)
  assert.equal(nodeTypes.includes('environment_send_action'), false)
  assert.equal(nodeTypes.includes('robot_buffer'), false)

  for (const workflow of ['environment']) {
    const consumer = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, `etc/cognitive-graphs/${workflow}-mode.json`),
      'utf8',
    ))
    assert.equal(consumer.nodes.filter((node: any) => node.data?.nodeType === 'robot_status').length, 1)
    assert.equal(consumer.nodes.filter((node: any) => node.data?.nodeType === 'robot_status_out').length, 2)
    assert.equal(consumer.edges.some((edge: any) => edge.targetHandle === 'robotStatus'), true)
    assert.equal(consumer.edges.some((edge: any) => edge.source === 'active-task' && edge.targetHandle === 'taskDecision'
      && consumer.nodes.find((node: any) => node.id === edge.target)?.data?.nodeType === 'robot_status_out'), true)
    for (const retired of [
      'environment_task_input',
      'environment_task_preparation',
      'environment_task_reducer',
    ]) {
      assert.equal(consumer.nodes.some((node: any) => node.data?.nodeType === retired), false)
    }
  }

  for (const planner of ['boredom-observer', 'boredom-movement', 'boredom-reflection']) {
    const graph = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, `etc/cognitive-graphs/${planner}-mode.json`),
      'utf8',
    ))
    const statusNodes = graph.nodes.filter((node: any) => node.data?.nodeType === 'robot_status')
    assert.equal(statusNodes.length, 1)
    assert.equal(graph.edges.some((edge: any) => (
      edge.source === statusNodes[0].id
      && edge.sourceHandle === 'context'
      && edge.targetHandle === 'robotStatus'
    )), true)
  }
})

test('Robot task programs use the sole active executor and retain task-level cognitive review', async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
  const readGraph = (name: string) => JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, `etc/cognitive-graphs/${name}-mode.json`), 'utf8'))
  for (const name of ['environment']) {
    const graph = readGraph(name)
    const active = graph.nodes.filter((node: any) => node.data?.nodeType === 'environment_active_task')
    assert.equal(active.length, 1)
    assert.equal(graph.nodes.some((node: any) => node.data?.nodeType === 'environment_send_action'), false)
    assert.equal(graph.nodes.some((node: any) => node.data?.properties?.graph === 'robot-action-result'), false)
    const planner = graph.nodes.find((node: any) => node.data?.nodeType === 'environment_task_planner')
    assert.ok(planner, 'The task planner owns parsing and optional planning delegation')
    assert.ok(graph.edges.some((edge: any) => edge.source === planner.id && edge.sourceHandle === 'program'
      && edge.target === active[0].id && edge.targetHandle === 'program'))
  }
  const activeGraph = readGraph('robot-active-task')
  assert.deepEqual(activeGraph.nodes.map((node: any) => node.data.nodeType).sort(),
    ['environment_active_task_step', 'environment_active_task_wait'])
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'etc/cognitive-graphs/robot-action-result-mode.json')), false)
  const reviewGraph = readGraph('robot-goal-review')
  const reviewTypes = reviewGraph.nodes.map((node: any) => node.data?.nodeType)
  assert.equal(reviewTypes.filter((type: string) => type === 'model_router').length, 1)
  assert.equal(reviewTypes.filter((type: string) => type === 'robot_status_out').length, 1)
  assert.equal(reviewTypes.includes('robot_autonomy_task_catalog'), false)
  assert.equal(reviewTypes.filter((type: string) => type === 'robot_operator_environment_dispatch').length, 0)
  assert.equal(reviewTypes.filter((type: string) => type === 'environment_image_input').length, 1)
  assert.equal(reviewTypes.includes('environment_send_action'), false)
  assert.equal(reviewTypes.includes('conditional_branch'), false)
  assert.deepEqual(
    reviewGraph.nodes
      .filter((node: any) => node.data?.nodeType === 'conversation_history')
      .map((node: any) => node.data?.properties?.mode)
      .sort(),
    ['conversation', 'inner', 'robot'],
  )
  assert.equal(
    reviewGraph.nodes.find((node: any) => node.data?.nodeType === 'model_router')?.data?.properties?.role,
    'persona',
  )
  assert.equal(reviewTypes.includes('workflow_call'), false)
  assert.equal(reviewGraph.edges.some((edge: any) => (
    edge.source === 'parser'
    && edge.sourceHandle === 'executorDecision'
    && edge.target === 'prompt-out'
    && edge.targetHandle === 'decision'
  )), false)

  const reviewed = await robotGoalReviewParserNode.execute({
    response: JSON.stringify({
      outcome: 'wait',
      objective: 'Find the cat near the doorway.',
      completionCriteria: 'Identify the cat in current visual evidence.',
      reason: 'Another viewpoint may reveal the target.',
      requiredCompletionBasis: 'visual_observation',
      observationSummary: 'The last view did not contain the cat.',
      completionEvidence: '',
    }),
    execution: { task: { objective: 'Find the cat.' } },
  }, {}, {})
  assert.equal('invocation' in reviewed, false)
  assert.equal(reviewed.taskDecision.objective, 'Find the cat near the doorway.')
  assert.equal(reviewed.taskDecision.objectiveComplete, false)
})

test('speech and camera projections preserve the last body action as historical evidence', async () => {
  const { buildRobotStatusProjection } = await import('./robot-status.js')
  const bodyAction = { actionId: 'stand-result', type: 'requestMotion', description: 'Stand up.',
    status: 'completed', message: 'done', completedAt: '2026-10-07T21:00:00Z',
    sessionId: 'robot-1', robotId: 'selected-body', observedAt: '2026-10-07T21:00:00Z' }
  const first = buildRobotStatusProjection(null, { currentTask: null, parkedGoals: [] }, situation, { ...sources, lastAction: bodyAction })
  const speech = buildRobotStatusProjection(first, { currentTask: null, parkedGoals: [] }, situation, { ...sources,
    lastAction: { ...bodyAction, actionId: 'speech-result', type: 'speak', completedAt: '2026-10-07T21:01:00Z' } })
  assert.equal(speech.lastAction?.type, 'speak')
  assert.deepEqual(speech.lastBodyAction, bodyAction)
  const envelope = JSON.parse(buildEnvironmentSelectorEnvelope({ instruction: 'Please stand up', robotStatus: speech }))
  assert.equal(envelope.robotStatus.lastBodyAction.robotId, 'selected-body')
  assert.equal(envelope.robotStatus.lastBodyAction.completedAt, '2026-10-07T21:00:00Z')
  assert.equal(envelope.robotStatus.body.motion.posture, undefined, 'A completed command is not fabricated present posture')
})

test('reading a legacy snapshot removes stale current intent without deleting its historical evidence', () => {
  const username = 'robot-status-legacy-intent'
  saveRobotStatus(username, situation, sources)
  const filename = robotStatusPath(username)
  const legacy = JSON.parse(fs.readFileSync(filename, 'utf8'))
  legacy.situation.currentIntent = 'An earlier action was rejected.'
  fs.writeFileSync(filename, JSON.stringify(legacy))
  const before = fs.readFileSync(filename, 'utf8')
  const current = loadRobotStatus(username)!
  assert.equal(current.situation.currentIntent, '')
  assert.equal(current.situation.currentGoal, '')
  assert.equal(fs.readFileSync(filename, 'utf8'), before, 'Reads do not rewrite recorded evidence')
  const next = saveRobotStatus(username, situation, sources)
  assert.equal(next.situation.currentIntent, '')
  assert.ok(next.history.some(entry => entry.updatedAt === legacy.updatedAt
    && entry.currentIntent === legacy.situation.currentIntent))
})

test('saved Robot Status graph delivers the delegated JPEG and matching recognition to its model', async () => {
  const { nodeRegistry, nodeExecutors } = await import('./nodes/index.js')
  const graph = JSON.parse(fs.readFileSync(new URL('../../../etc/cognitive-graphs/robot-status-mode.json', import.meta.url), 'utf8'))
  const originalPrompt = graph.nodes.find((node: any) => node.id === 'instructions').data.properties.message
  const at = '2026-10-24T01:46:41.000Z'
  const identities = [
    { trackId: 'p1', state: 'face_match', name: 'Greg', personId: 'greg', faceAgeMs: 0, similarity: 0.82 },
    { trackId: 'p1', state: 'tracked', name: 'Greg', personId: 'greg', faceAgeMs: 500 },
    { trackId: 'p1', state: 'unknown' },
  ]
  let expected: any
  let modelCalls = 0
  const replacements: Record<string, any> = {
    environment_bridge_status: async () => ({ summary: { sessions: [
      { sessionId: 'another-body', status: 'connected', lastSeenAt: '2099-01-01T00:00:00Z' },
      { sessionId: 'selected-body', environmentId: 'ainekio', status: 'connected', latestObservation: {
        timestamp: at, state: { body: { robotId: 'p4' } }, capabilities: {} } },
    ] }, robotTelemetry: [] }),
    conversation_history: async () => ({ history: [] }),
    active_desires: async () => ({ desires: [] }),
    robot_status: async () => ({ historyContext: null }),
    model_router: async (inputs: any) => {
      modelCalls++
      assert.equal(inputs.messages[0].content, originalPrompt)
      const parts = inputs.messages[1].content
      assert.equal(parts[1].image_url.url, expected.dataUrl)
      const data = JSON.parse(parts[0].text)
      assert.equal(data.sourceFacts.body.sessionId, 'selected-body')
      assert.deepEqual(data.sourceFacts.visualFrames[0].recognition, expected.metadata.recognition)
      assert.equal(data.sourceFacts.visualFrames[0].timestamp, at)
      assert.equal(data.plannerDecision.instruction, 'Update the situation from this frame.')
      assert.ok(!parts[0].text.includes('base64'))
      return { response: JSON.stringify(situation) }
    },
  }
  const originals = new Map<string, any>()
  for (const [id, fn] of Object.entries(replacements)) {
    originals.set(id, nodeRegistry.get(id)!.execute)
    nodeRegistry.get(id)!.execute = fn
    nodeExecutors.set(id, fn)
  }
  try {
    for (const identity of identities) {
      expected = { id: 'frame-43', timestamp: at, mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/2gAA/9k=',
        metadata: { robotId: 'p4', gatewayInstance: 'gateway-1', epoch: 1, counter: 43,
          recognition: { robotId: 'p4', gatewayInstance: 'gateway-1', epoch: 1, frameCounter: 43,
            observedAt: at, timeBasis: 'gateway_receipt', backend: 'ultralytics+sface',
            objects: [{ label: 'person', score: 0.9, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, identity }] } } }
      const username = `status-camera-${identity.state}`
      const result = await runDurableGraph({ graph: validateSvelteFlowGraph(graph), context: {
        username, userId: username, requestId: randomUUID(), environment: 'server',
        robotOperatorContext: { sessionId: 'selected-body', frames: [expected], currentVisualEvidence: true,
          plannerDecision: { observed: 'Frame 43 selected', instruction: 'Update the situation from this frame.', reason: 'New camera evidence', decidedAt: at } },
      } })
      assert.equal(result.status, 'completed', result.error?.stack)
      assert.deepEqual(loadRobotStatus(username)?.visualFrames?.[0].recognition, expected.metadata.recognition)
      const envelope = JSON.parse(buildEnvironmentSelectorEnvelope({ observation: { sessionId: 'selected-body', capabilities: { actions: [] } }, visualFrames: [expected] } as any))
      assert.ok(JSON.stringify(envelope).includes(JSON.stringify(expected.metadata.recognition)))
    }
    assert.equal(modelCalls, identities.length)
  } finally {
    for (const [id, fn] of originals) { nodeRegistry.get(id)!.execute = fn; nodeExecutors.set(id, fn) }
  }
})

test('retained prose keeps per-field evidence dates across receipt updates and persistence', async () => {
  const { projectRobotStatusContext } = await import('./robot-status.js')
  const username = 'prose-evidence-receipts'
  const recordedAt = '2026-08-27T18:00:00.000Z'
  const evidence = { recordedAt, sourceUpdatedAt: sources.sourceUpdatedAt, visualFrames: [] }
  saveRobotStatus(username, situation, { ...sources, generatedAt: recordedAt,
    situationEvidence: { userContext: evidence, uncertainties: evidence } })
  const { outputs } = await statusGraph(username, [{ inputs: { terminalFeedback: {
    id: 'new-speech', type: 'completed', message: 'speech_played', actionId: 'speech-1',
    timestamp: '2026-08-27T20:00:00.000Z',
  } } }])
  const saved = loadRobotStatus(username)!
  assert.deepEqual(saved.situationEvidence?.userContext, evidence)
  assert.deepEqual(saved.situationEvidence?.uncertainties, evidence)
  const projected = projectRobotStatusContext(saved) as any
  assert.deepEqual(projected.recordedSituation.evidence.userContext, evidence)
  assert.equal(projected.recordedSituation.updatedAt, undefined, 'A status-save time is not the prose acquisition time')
  assert.deepEqual(outputs[0].status.situationEvidence?.userContext, evidence)
})

test('legacy prose without recorded evidence remains unknown after a new status save', async () => {
  const { projectRobotStatusContext } = await import('./robot-status.js')
  const saved = saveRobotStatus('legacy-prose-evidence', situation, { ...sources, generatedAt: '2026-08-27T20:00:00.000Z' })
  const projected = projectRobotStatusContext(saved) as any
  assert.equal(projected.recordedSituation.evidence.userContext, null)
  assert.equal(projected.recordedSituation.updatedAt, undefined)
  assert.equal(projected.recordedSituation.userContext, situation.userContext)
})

test('a new semantic review records fresh provenance even when its text is unchanged', async () => {
  const { outputs } = await statusGraph('review-prose-evidence', [{ type: 'robot_status_writer', inputs: {
    response: JSON.stringify(situation), sourceFacts: sources,
  } }])
  const saved = loadRobotStatus('review-prose-evidence')!
  for (const field of ['situationalSummary', 'environmentDescription', 'userContext', 'uncertainties'] as const) {
    assert.equal(saved.situationEvidence?.[field]?.recordedAt, outputs[0].status.updatedAt)
    assert.deepEqual(saved.situationEvidence?.[field]?.sourceUpdatedAt, sources.sourceUpdatedAt)
  }
})

test('receipt-only updates without new prose preserve every recorded field date', async () => {
  const username = 'prose-evidence-empty-receipts'
  const evidence = { recordedAt: '2026-08-27T18:00:00.000Z', sourceUpdatedAt: sources.sourceUpdatedAt,
    visualFrames: [{ id: 'earlier-frame', timestamp: '2026-08-27T17:59:00.000Z', source: 'camera', description: '' }] }
  const situationEvidence = Object.fromEntries(
    ['situationalSummary', 'environmentDescription', 'userContext', 'uncertainties'].map(field => [field, evidence]))
  saveRobotStatus(username, situation, { ...sources, situationEvidence })
  await statusGraph(username, [0, 1].map(index => ({ inputs: { terminalFeedback: {
    id: `empty-receipt-${index}`, type: 'completed', actionId: `speech-${index}`,
  } } })))
  const saved = loadRobotStatus(username)!
  assert.deepEqual(saved.situationEvidence, situationEvidence)
})

test('changed prose with no attributed producer does not inherit previous evidence', () => {
  const username = 'prose-evidence-changed-without-source'
  const evidence = { recordedAt: '2026-08-27T18:00:00.000Z', sourceUpdatedAt: sources.sourceUpdatedAt }
  saveRobotStatus(username, situation, { ...sources, situationEvidence: { userContext: evidence } })
  const saved = saveRobotStatus(username, { ...situation, userContext: 'A different recorded request' }, sources)
  assert.equal(saved.situationEvidence?.userContext, undefined)
})
