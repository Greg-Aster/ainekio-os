import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'body-event-admission-'))
process.env.METAHUMAN_ROOT = root
process.env.MH_ENVIRONMENT_BRIDGE_TOKEN = 'fixture-token'
globalThis.fetch = async () => { throw new Error('No network in event admission tests') }
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { handleEnvironmentBridgeObservation, environmentObservationNeedsCognition } = await import('./environment-bridge.js')
const { getQueueManager } = await import('../../queue/index.js')
const { readEnvironmentBridgeState } = await import('../../environment-interface/store.js')
after(() => { eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }) })

test('bridge admits a body event once into its separate workflow and leaves telemetry as state', async () => {
  const observation = { id: 'body-event-observation', sessionId: 'p4-session', environmentId: 'ainekio',
    adapter: 'ainekio-gateway', timestamp: new Date().toISOString(), capabilities: { actions: [] },
    metadata: { perceptionEvent: 'body_event' },
    state: { body: { robotId: 'p4', authenticated: true }, bodyEvent: { name: 'body_event',
      event_id: 'boot-7-1', robot_id: 'p4', epoch: 1, data: { kind: 'wake', reason: 'boot' } } } }
  const req: any = { path: '/api/environment-bridge/observation', method: 'POST', body: observation,
    user: { userId: 'fixture', username: 'fixture', role: 'owner', isAuthenticated: true },
    headers: { authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment' } }
  const first = await handleEnvironmentBridgeObservation(req, () => 'fixture')
  assert.equal(first.status, 200, JSON.stringify(first.data))
  const data: any = first.data
  assert.equal(data.graphQueued, true)
  assert.equal(getQueueManager().getTask(data.workId)?.input.graph, 'robot-wake-up')
  const replay = await handleEnvironmentBridgeObservation(req, () => 'fixture')
  assert.equal(replay.status, 200)
  assert.equal((replay.data as any).workId, data.workId)
  assert.equal(environmentObservationNeedsCognition({ ...observation, metadata: {}, state: { body: observation.state.body } }), false)
})

test('changing feedback health updates state without admitting conversational work', async () => {
  const queuedBefore = getQueueManager().getAllTasks().length
  for (let sample = 0; sample < 24; sample++) {
    const kind = sample === 23 ? 'servo_feedback_restored' : 'servo_feedback_fault'
    const feedback = { enabled: true, usable: kind === 'servo_feedback_restored',
      below_calibration_mask: kind === 'servo_feedback_restored' ? 0 : 4095,
      clipped_mask: sample % 2 ? 0 : 32, scan: sample }
    const observation = { id: `health-${sample}`, sessionId: 'health-session', environmentId: 'ainekio',
      adapter: 'ainekio-gateway', timestamp: new Date().toISOString(), capabilities: { actions: [] },
      metadata: { perceptionEvent: 'body_event' },
      state: { servoFeedback: feedback, bodyEvent: { name: 'body_event',
        event_id: `health-event-${sample}`, data: { kind, feedback } } } }
    const response = await handleEnvironmentBridgeObservation({ body: observation,
      headers: { authorization: 'Bearer fixture-token' } } as any, () => 'fixture')
    assert.equal(response.status, 200)
    assert.equal((response.data as any).graphQueued, false)
    assert.equal((response.data as any).reason, 'state_only_observation')
    const recorded = readEnvironmentBridgeState().sessions['health-session'].latestObservation
    assert.ok(recorded)
    assert.deepEqual(recorded.state?.bodyEvent, observation.state.bodyEvent)
    assert.deepEqual(recorded.state?.servoFeedback, feedback)
    assert.equal(getQueueManager().getAllTasks().length, queuedBefore)
    assert.equal(environmentObservationNeedsCognition({ ...observation,
      text: [{ source: 'player', text: 'Please stop.', timestamp: observation.timestamp }] } as any), true)
    assert.equal(environmentObservationNeedsCognition({ ...observation,
      feedback: [{ id: 'motion-result', type: 'completed', timestamp: observation.timestamp }] } as any), true)
  }
})

test('spoken Stop carrying an earlier body event reaches Environment Mode unchanged', async () => {
  const timestamp = new Date().toISOString()
  const body = { id: 'spoken-stop', sessionId: 'speech-session', environmentId: 'ainekio',
    adapter: 'ainekio-gateway', timestamp, capabilities: { actions: ['stop'] },
    metadata: { perceptionEvent: 'audio_utterance', audioUtteranceId: 'speech-1' },
    text: [{ id: 'speech-1', source: 'player', text: 'Please stop.', timestamp, channel: 'microphone' }],
    state: { bodyEvent: { name: 'body_event', event_id: 'earlier-movement', data: { kind: 'rapid_movement' } } } }
  const response = await handleEnvironmentBridgeObservation({ body, headers: {
    authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment',
  } } as any, () => 'fixture')
  assert.equal(response.status, 200)
  const work = getQueueManager().getTask((response.data as any).workId)
  assert.equal(work?.input.graph, 'environment')
  assert.deepEqual(work?.input.observation.text, body.text)
  assert.deepEqual(work?.input.observation.state.bodyEvent, body.state.bodyEvent)
  assert.equal(environmentObservationNeedsCognition({ ...body, text: [], metadata: {} } as any), false,
    'A retained event in a state snapshot is context, not another event invocation')
})

for (const kind of ['tipped', 'rapid_movement', 'servo_stall']) {
  test(`${kind} uses the fast body workflow without duplicate admission`, async () => {
    const timestamp = new Date().toISOString()
    const observation = { id: `${kind}-observation`, sessionId: `session-${kind}`, environmentId: 'ainekio',
      adapter: 'ainekio-gateway', timestamp, capabilities: { actions: [] },
      metadata: { perceptionEvent: 'body_event' },
      state: { bodyEvent: { name: 'body_event', event_id: `${kind}-event`, data: {
        kind, ...(kind === 'servo_stall' ? { joints: [{ id: 0, name: 'rear_left_shoulder' }],
          reason: 'no_position_progress', outputs_released: true } : { source: 'imu' }),
      } } } }
    const req: any = { body: observation, headers: { authorization: 'Bearer fixture-token' } }
    const response = await handleEnvironmentBridgeObservation(req, () => 'fixture')
    assert.equal(response.status, 200)
    const work = getQueueManager().getTask((response.data as any).workId)
    assert.equal(work?.input.graph, 'fast-body-event')
    assert.deepEqual(work?.input.observation.state.bodyEvent, observation.state.bodyEvent)
    const replay = await handleEnvironmentBridgeObservation(req, () => 'fixture')
    assert.equal((replay.data as any).workId, work?.id)
  })
}

test('duplicate wake event_id is suppressed across new observation envelopes and persisted ExecutionStore restarts while distinct boot event_ids admit normally', async () => {
  const { openExecutionStore } = await import('../../durable-execution/storage.js')

  const makeWakeObservation = (obsId: string, eventId: string, epoch: number) => ({
    id: obsId,
    sessionId: 'ainekio-01',
    environmentId: 'ainekio',
    adapter: 'ainekio-gateway',
    timestamp: new Date().toISOString(),
    capabilities: { actions: [] },
    metadata: { perceptionEvent: 'body_event' },
    state: {
      body: { robotId: 'ainekio-p4-e6ebe5', authenticated: true },
      bodyEvent: {
        name: 'body_event',
        event_id: eventId,
        robot_id: 'ainekio-p4-e6ebe5',
        epoch,
        data: { kind: 'wake', reason: 'boot', reset_reason: 'power_on' },
      },
    },
  })

  // 1. First wake admits into robot-wake-up
  const firstObs = makeWakeObservation('obs-wake-1a', '423271573:4916989', 1)
  const firstRes = await handleEnvironmentBridgeObservation({
    body: firstObs,
    headers: { authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment' },
  } as any, () => 'fixture')
  assert.equal(firstRes.status, 200)
  const firstWorkId = (firstRes.data as any).workId
  assert.ok(firstWorkId)
  assert.equal(getQueueManager().getTask(firstWorkId)?.input.graph, 'robot-wake-up')

  // 2. Re-enveloped duplicate with a DIFFERENT observation.id + timestamp but SAME event_id returns existing workId without a second task
  const tasksAfterFirst = getQueueManager().getAllTasks().length
  const rewrappedObs = makeWakeObservation('obs-wake-1b', '423271573:4916989', 1)
  const rewrappedRes = await handleEnvironmentBridgeObservation({
    body: rewrappedObs,
    headers: { authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment' },
  } as any, () => 'fixture')
  assert.equal(rewrappedRes.status, 200)
  assert.equal((rewrappedRes.data as any).graphQueued, true)
  assert.equal((rewrappedRes.data as any).workId, firstWorkId)
  assert.equal(getQueueManager().getAllTasks().length, tasksAfterFirst)

  // 3. Post-restart adapter replay: an earlier execution for event_id '999111222:5000000' is already persisted in ExecutionStore
  //    (with no in-memory QueueManager task from before the restart)
  const preRestartObs = makeWakeObservation('obs-before-restart', '999111222:5000000', 2)
  const store = openExecutionStore('fixture')
  let persistedExecutionId: string
  try {
    const record = store.enter(
      'fixture',
      {
        graphId: 'Robot Wake-Up',
        graphHash: 'fixture-wake-hash',
        runtimeVersion: 'langgraph-svelteflow-v1',
        checkpointSchemaVersion: 2,
        nodeVersions: { environment_bridge_input: '1.0.0' },
      },
      'pre-restart-work:graph:0',
      {
        graph: { version: '1.0', name: 'Robot Wake-Up', nodes: [], edges: [] },
        graphSource: 'system',
        context: {
          username: 'fixture',
          sessionId: 'ainekio-01',
          environmentObservation: preRestartObs,
        },
      },
    )
    persistedExecutionId = record.executionId
  } finally {
    store.close()
  }

  const tasksBeforeRestartReplay = getQueueManager().getAllTasks().length
  const postRestartReplayRes = await handleEnvironmentBridgeObservation({
    body: makeWakeObservation('obs-after-restart-replay', '999111222:5000000', 2),
    headers: { authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment' },
  } as any, () => 'fixture')
  assert.equal(postRestartReplayRes.status, 200)
  assert.equal((postRestartReplayRes.data as any).graphQueued, false)
  assert.equal((postRestartReplayRes.data as any).executionId, persistedExecutionId!)
  assert.equal((postRestartReplayRes.data as any).reason, 'duplicate_body_event')
  assert.equal(getQueueManager().getAllTasks().length, tasksBeforeRestartReplay, 'Post-restart replay of already-admitted wake event_id must not enqueue a second execution')

  // 4. Genuine new boot with a distinct event_id still admits normally into robot-wake-up
  const distinctBootRes = await handleEnvironmentBridgeObservation({
    body: makeWakeObservation('obs-real-boot-3', '3583508715:5016530', 3),
    headers: { authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment' },
  } as any, () => 'fixture')
  assert.equal(distinctBootRes.status, 200)
  assert.equal((distinctBootRes.data as any).graphQueued, true)
  const distinctWorkId = (distinctBootRes.data as any).workId
  assert.notEqual(distinctWorkId, firstWorkId)
  assert.equal(getQueueManager().getTask(distinctWorkId)?.input.graph, 'robot-wake-up')
})

test('unadmitted speech logs environment_observation_not_admitted while state-only observations do not', async () => {
  const { systemPaths } = await import('../../path-builder.js')
  const { setAuditEnabled } = await import('../../audit.js')
  setAuditEnabled(true)
  try {
    const auditLogFile = path.join(systemPaths.logs, 'audit', `${new Date().toISOString().slice(0, 10)}.ndjson`)
    const readNotAdmitted = () => fs.existsSync(auditLogFile)
      ? fs.readFileSync(auditLogFile, 'utf8').trim().split('\n').filter(Boolean)
          .map(line => JSON.parse(line))
          .filter(entry => entry.event === 'environment_observation_not_admitted')
      : []
    const before = readNotAdmitted().length
    const timestamp = new Date().toISOString()

    const stateOnly = await handleEnvironmentBridgeObservation({
      body: {
        id: 'state-only-no-owner',
        sessionId: 'ainekio-01',
        environmentId: 'ainekio',
        adapter: 'ainekio-gateway',
        timestamp,
        capabilities: { actions: ['requestMotion'] },
      },
      headers: { authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment' },
    } as any, () => null)
    assert.equal(stateOnly.status, 200)
    assert.equal((stateOnly.data as any).graphQueued, false)
    assert.equal((stateOnly.data as any).reason, 'no_active_authorized_user')
    assert.equal(readNotAdmitted().length, before)

    const spoken = await handleEnvironmentBridgeObservation({
      body: {
        id: 'speech-no-owner',
        sessionId: 'ainekio-01',
        environmentId: 'ainekio',
        adapter: 'ainekio-gateway',
        timestamp,
        capabilities: { actions: ['requestMotion'] },
        text: [{ id: 't1', source: 'player', text: 'Can you hear me?', timestamp, channel: 'microphone' }],
      },
      headers: { authorization: 'Bearer fixture-token', 'x-metahuman-environment-graph': 'environment' },
    } as any, () => null)
    assert.equal(spoken.status, 200)
    assert.equal((spoken.data as any).graphQueued, false)
    assert.equal((spoken.data as any).reason, 'no_active_authorized_user')
    const events = readNotAdmitted()
    assert.equal(events.length, before + 1)
    assert.equal(events.at(-1)?.level, 'warn')
    assert.equal(events.at(-1)?.details?.reason, 'no_active_authorized_user')
    assert.equal(events.at(-1)?.details?.sessionId, 'ainekio-01')
  } finally {
    setAuditEnabled(false)
  }
})
