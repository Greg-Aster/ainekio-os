import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionEvent } from '../../durable-execution/types.js'
import { executionContextNode, executionEventContext } from './execution-context.node.js'
import { executionEventWaitNode } from './execution-event-wait.node.js'
import { environmentImageInputNode } from '../environment/image-input.node.js'
import { environmentContextBuilderNode } from '../environment/context-builder.node.js'

const frame = {
  id: 'camera-gateway-body-3-51', timestamp: '2026-10-11T02:30:00.000Z',
  mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/2gAA/9k=',
  source: 'robot-camera', width: 640, height: 480,
  metadata: { robotId: 'selected-body', gatewayInstance: 'gateway', epoch: 3, counter: 51 },
}

test('input drain does not invent a workflow and preserves newly received human input', async () => {
  const pending: any[] = []
  const graphExecution = { pendingEvents: () => pending, waitForEvent: () => pending.shift() }
  const context = { graphExecution, _graphExecutorIteration: 1 } as any
  const properties = { drain: true, userGraph: 'environment', autonomyGraph: 'robot-autonomy-controller' }
  assert.deepEqual(await executionEventWaitNode.execute({}, context, properties), { invocation: null })
  assert.deepEqual(await executionEventWaitNode.execute({}, { ...context, _graphExecutorIteration: 2 }, properties), { invocation: null })
  const received = { userMessage: 'Actually, leave it there.', timestamp: 1234, speechGeneration: 9 }
  pending.push({ kind: 'user_steering', payload: received })
  const next = await executionEventWaitNode.execute({}, context, properties)
  assert.equal(next.invocation.graph, 'environment')
  assert.equal(next.invocation.context.userMessage, received.userMessage)
  assert.equal(next.invocation.context.timestamp, 1234)
  assert.equal(next.invocation.context.speechGeneration, 9)
  assert.equal(next.invocation.context.environmentTaskEvidence, undefined)
})

test('finite body-event input drain ends without parking and preserves admitted human takeover', async () => {
  const pending: any[] = []
  const waits: string[] = []
  const graphExecution = { pendingEvents: () => pending, waitForEvent: (reason: string) => {
    waits.push(reason)
    if (!pending.length) throw new Error('waiting for ' + reason)
    return pending.shift()
  } }
  const context = { graphExecution, _graphExecutorIteration: 1, userMessage: '',
    bodyEventDecision: { instruction: 'Assess the body event.', sourceObservationAt: '2026-10-19T19:37:00Z' } } as any
  const properties = { drain: false, userGraph: 'environment', autonomyGraph: 'robot-autonomy-controller' }
  assert.deepEqual(await executionEventWaitNode.execute({}, context, properties), { invocation: null })
  assert.deepEqual(waits, [], 'An unresolved objective does not park a finite event invocation')
  const received = { userMessage: 'Wait for my next instruction.', userMessageEntry: {
    role: 'user', content: 'Wait for my next instruction.', timestamp: 1234,
    meta: { idempotencyKey: 'actual-human-input' },
  } }
  pending.push({ kind: 'user_steering', payload: received })
  const next = await executionEventWaitNode.execute({}, context, properties)
  assert.equal(next.invocation.graph, 'environment')
  assert.deepEqual(next.invocation.context.userMessageEntry, received.userMessageEntry)
  assert.equal(next.invocation.context.userMessage, received.userMessage)
  assert.deepEqual(waits, ['pending_input'])
  await assert.rejects(executionEventWaitNode.execute({}, { ...context, ...received }, properties),
    /waiting for user_or_autonomy/, 'A genuine human turn retains the conversational wait')
  await assert.rejects(executionEventWaitNode.execute({}, { ...context, userMessageEntry: received.userMessageEntry }, properties),
    /waiting for user_or_autonomy/, 'Recorded human admission remains authoritative across an internal handoff')
})

test('unfinished program handoffs do not start Goal Review before task results return', async () => {
  const graphExecution = { executionId: 'execution', task: () => ({
    objective: 'Inspect the target', decision: { outcome: 'continue', requiredCompletionBasis: 'visual_observation' },
  }), events: () => [], activeExecutions: () => [] }
  for (const done of [false, true]) {
    const result = await executionContextNode.execute({ taskResult: { done }, routingAnalysis: { needsGoalReview: true } }, { graphExecution } as any, {})
    assert.equal(result.needsGoalReview, done)
  }
})

test('Goal Review receives the current Intent routes without treating a selected reply as delivered', async () => {
  const graphExecution = { executionId: 'execution', task: () => ({
    objective: 'Inspect the target', decision: { outcome: 'continue', requiredCompletionBasis: 'visual_observation' },
  }), events: () => [], activeExecutions: () => [] }
  for (const needsResponse of [false, true]) {
    const routingAnalysis = { needsGoalReview: true, needsResponse, needsAction: true, taskContext: ['environment'], conversationContext: [] }
    const parent = await executionContextNode.execute({ routingAnalysis }, { graphExecution } as any, {})
    const child = await executionContextNode.execute({}, { ...parent.reviewContext, graphExecution } as any, {})
    assert.deepEqual(child.context.routingAnalysis, routingAnalysis)
    assert.equal(child.context.responseEntry, undefined)
    assert.equal(child.needsGoalReview, true, 'Reply selection does not decide goal completion')
    const nextTurn = { ...routingAnalysis, needsResponse: !needsResponse }
    const replaced = await executionContextNode.execute({ routingAnalysis: nextTurn }, { ...parent.reviewContext, graphExecution } as any, {})
    assert.deepEqual(replaced.context.routingAnalysis, nextTurn, 'A new turn replaces the inherited routing decision')
  }
  const withoutRoute = await executionContextNode.execute({}, { graphExecution } as any, {})
  assert.equal(withoutRoute.context.routingAnalysis, undefined, 'Standalone review does not invent a route')
})

test('final context carries assessment and returned evidence', async () => {
  const receipt = { actionId: 'capture', type: 'completed', timestamp: '2026-10-15T12:00:00Z' }
  const assessment = { outcome: 'request_user', reason: 'Two candidate objects are visible.',
    requiredCompletionBasis: 'user_input', observationSummary: 'The intended object is uncertain.', completionEvidence: '' }
  const inputs = { routingAnalysis: { needsResponse: true, taskContext: [], conversationContext: [] },
    goalAssessment: assessment, taskResult: { done: true, evidence: [receipt] },
    execution: { executionId: 'execution', events: [receipt] }, userInstruction: 'Find it.' }
  const result = await environmentContextBuilderNode.execute(inputs, {}, { purpose: 'conversation' })
  assert.deepEqual(JSON.parse(result.message).goalAssessment, assessment)
  assert.deepEqual(JSON.parse(result.message).taskResult.evidence, { $ref: '#/execution/events' })
  assert.deepEqual(JSON.parse(result.message).execution, inputs.execution)
})

test('later display and delivery events do not evict action receipts or user corrections from continuation evidence', async () => {
  const events: ExecutionEvent[] = [
    { eventId: 'stretch-rejected', executionId: 'execution', sequence: 1, createdAt: 1,
      kind: 'physical_result', actionId: 'stretch', payload: { feedback: {
        actionId: 'stretch', type: 'rejected', message: 'Motion mapping failed', timestamp: '2026-10-15T03:51:42Z',
      }, action: { type: 'requestMotion', description: 'stretch' } } },
    { eventId: 'correction', executionId: 'execution', sequence: 2, createdAt: 2,
      kind: 'user_input', payload: { userMessage: 'Only speak; I am holding you.', speaker: 'user' } },
    ...Array.from({ length: 24 }, (_, index): ExecutionEvent => ({
      eventId: `display-${index}`, executionId: 'execution', sequence: index + 3, createdAt: index + 3,
      kind: 'physical_result', actionId: `face-${index}`, payload: {
        action: { type: 'faceExpression', expression: 'thinking' },
        feedback: { actionId: `face-${index}`, type: 'completed' },
      },
    })),
  ]
  const original = structuredClone(events)
  const responseEntry = { role: 'assistant', content: 'The stretch was rejected.', timestamp: 27 }
  const task = { objective: 'React to the event', decision: { outcome: 'continue' } }
  const graphExecution = { executionId: 'execution', task: () => task, events: () => events, activeExecutions: () => [] }
  const result = await executionContextNode.execute({ responseEntry }, { graphExecution } as any, executionContextNode.properties)
  assert.deepEqual(result.context.events, events)
  assert.equal(result.context.latestEventSequence, 26)
  assert.deepEqual(result.context.responseEntry, responseEntry)
  assert.deepEqual(events, original)
})
function receipt(visual: typeof frame | null): ExecutionEvent {
  return { eventId: 'read-result', executionId: 'execution', sequence: 7, createdAt: 1,
    kind: 'work_result', workItemId: 'read-work', payload: {
      effectId: 'read-effect', result: { state: 'completed', result: { visual } },
    } }
}

test('camera work receipts expose frame references in execution text while retaining original image bytes', () => {
  const events = [receipt(frame)]
  const original = structuredClone(events)
  const projected = executionEventContext(events)
  const payload = projected[0].payload as any
  const { dataUrl: _dataUrl, ...reference } = frame
  assert.deepEqual(payload.result.result.visual, reference)
  assert.equal(projected[0].eventId, 'read-result')
  assert.equal(payload.result.state, 'completed')
  assert.deepEqual(events, original)
  assert.equal((events[0].payload as any).result.result.visual.dataUrl, frame.dataUrl)
  assert.equal(JSON.stringify(projected).includes(frame.dataUrl), false)
  assert.equal((executionEventContext([receipt(null)])[0].payload as any).result.result.visual, null)
})

test('nested specialist graph returns preserve frame provenance and all non-image evidence', () => {
  const event = receipt(frame)
  event.payload = { effectId: 'specialist', result: { state: 'completed',
    graphResults: [{ outputs: { observations: [{ visual: frame }], explanation: 'Observed evidence' } }],
    result: { stdout: 'Worker log', stderr: '', reasoning: { source: 'model', confidence: 'uncertain',
      timestamp: '2026-10-11T02:30:01.000Z', text: 'The frame alone does not establish completion.' },
      action: { type: 'requestMotion', description: 'bow' },
      details: Array.from({ length: 30 }, (_, n) => ({ n, detail: 'Keep this evidence'.repeat(100) })) },
  } }
  const original = structuredClone(event)
  const payload = executionEventContext([event])[0].payload as any
  assert.equal(payload.result.graphResults[0].outputs.observations[0].visual.id, frame.id)
  assert.deepEqual(payload.result.graphResults[0].outputs.observations[0].visual.metadata, frame.metadata)
  assert.equal(payload.result.graphResults[0].outputs.observations[0].visual.dataUrl, undefined)
  assert.deepEqual(payload.result.result.details, (event.payload as any).result.result.details)
  assert.deepEqual(payload.result.result.action, { type: 'requestMotion', description: 'bow' })
  assert.deepEqual(payload.result.result.reasoning, (event.payload as any).result.result.reasoning)
  assert.deepEqual(event, original)
})

test('execution context never embeds image bytes in text and selected vision still attaches the original image', async () => {
  const context = { events: executionEventContext([receipt(frame)]) }
  const selected = await environmentImageInputNode.execute({ visual: frame }, {}, {})
  for (const visionSelected of [false, true]) {
    const result = await environmentContextBuilderNode.execute({
      instruction: 'Describe the current situation.', userInstruction: 'Describe the current situation.',
      routingAnalysis: { needsResponse: true, taskContext: [], conversationContext: ['executionContext', ...(visionSelected ? ['vision'] : [])] },
      sourceExecution: context, images: selected.images, frames: selected.frames,
    }, { currentTime: '2026-10-11T02:30:01.000Z' }, { purpose: 'conversation', systemPrompt: 'Existing fixture contract' })
    assert.equal(result.message.includes(frame.dataUrl), false)
    assert.equal(result.message.includes(frame.id), true)
    const content = result.messages[1].content
    if (visionSelected) {
      assert.ok(Array.isArray(content))
      assert.deepEqual(content.filter((item: any) => item.type === 'image_url'), selected.images)
      assert.equal(content.find((item: any) => item.type === 'text').text.includes(frame.dataUrl), false)
    } else assert.equal(typeof content, 'string')
  }
})


test('Intent alone selects review eligibility; replies and actions do not select it', async () => {
  let task: any = { objective: 'Find the wallet', decision: { outcome: 'act', requiredCompletionBasis: 'visual_observation' } }
  const graphExecution = { executionId: 'intent-goal', task: () => task, events: () => [], activeExecutions: () => [] }
  for (const needsGoalReview of [undefined, false, true]) {
    const routingAnalysis = { needsResponse: true, needsAction: true, needsGoalReview }
    const result = await executionContextNode.execute({ routingAnalysis, taskResult: { done: true } }, { graphExecution } as any, {})
    assert.equal(result.needsGoalReview, needsGoalReview === true)
    assert.equal(result.hasActiveTask, true)
  }
  task = null
  const absent = await executionContextNode.execute({ routingAnalysis: { needsGoalReview: true } }, { graphExecution } as any, {})
  assert.equal(absent.needsGoalReview, false, 'Selecting review does not invent a goal')

  task = { objective: 'Answer a question', decision: { outcome: 'report', continuationPolicy: 'none', requiredCompletionBasis: 'user_input', objectiveComplete: false } }
  const reportOnly = await executionContextNode.execute({ routingAnalysis: { needsResponse: true, needsGoalReview: false } }, { graphExecution } as any, {})
  assert.equal(reportOnly.hasActiveTask, false, 'A completed one-off report does not remain an active goal')
  assert.equal(reportOnly.awaitContext, false, 'A completed one-off report does not park waiting for user input')
})

test('executionEventContext strips raw telemetry grids and diffs repeated perception measurements without dropping events', () => {
  const makeMeasurement = (xMetres: number, degrees: number) => ({
    position: {
      available: true, source: 'camera_optical_flow_depth', scaleSource: 'calibration',
      xMetres, yMetres: 0, zMetres: 0, path_length_m: xMetres, headingDegrees: degrees,
      depth: { available: true, minMetres: 0.4, centerMetres: 1.2 },
      depthSpatial: { rows: 8, cols: 8, values: Array.from({ length: 64 }, (_, i) => i * 0.1) },
      attitude: { orientation_wxyz: [1, 0, 0, 0], bracket_us: [1, 2], bracket_quality: ['good'] },
      intrinsics: { fx: 500, fy: 500 }, calibrationId: 'cal-1', modelId: 'model-1',
      distanceDefinition: 'integrated', motionClock: { tick: 1 }, receivedAtMonotonic: 12345, inferenceMs: 12.4,
      observedAt: '2026-11-12T00:00:01Z',
    },
    yaw: {
      available: true, degrees, uncertaintyDegrees: 1.5, observedAt: '2026-11-12T00:00:01Z',
      bootId: 99, timestampUs: 99999, imu: { joint_feedback: Array.from({ length: 12 }, (_, i) => ({ id: i, raw_adc: 512 })) },
    },
    camera: { available: true, frameId: 'frame-1', observedAt: '2026-11-12T00:00:01Z', receivedAtMonotonic: 12340 },
  })
  const events: any[] = [
    {
      eventId: 'ev-obs', executionId: 'exec-1', sequence: 1, createdAt: 1, kind: 'observation_received',
      payload: { environmentObservation: { state: { body: { voltage: 7.4 }, locomotionMeasurement: makeMeasurement(0, 0) } } },
    },
    {
      eventId: 'ev-work', executionId: 'exec-1', sequence: 2, createdAt: 2, kind: 'work_result',
      payload: { result: { result: { vision: { operation: 'depthDemand', locomotionMeasurement: makeMeasurement(0.1, 1) } } } },
    },
    {
      eventId: 'ev-p1', executionId: 'exec-1', sequence: 3, createdAt: 3, kind: 'perception_received',
      payload: { sessionId: 'robot-1', locomotionMeasurement: makeMeasurement(0.2, 2) },
    },
    {
      eventId: 'ev-p2', executionId: 'exec-1', sequence: 4, createdAt: 4, kind: 'perception_received',
      payload: { sessionId: 'robot-1', locomotionMeasurement: makeMeasurement(0.5, 4) },
    },
  ]
  const original = structuredClone(events)
  const projected = executionEventContext(events)
  const text = JSON.stringify(projected)

  assert.equal(projected.length, 4)
  for (const field of ['depthSpatial', 'joint_feedback', 'bracket_us', 'calibrationId', 'intrinsics', 'receivedAtMonotonic', 'timestampUs']) {
    assert.equal(text.includes(field), false, `raw telemetry ${field} should be stripped`)
  }
  assert.equal((projected[0].payload as any).environmentObservation.state.locomotionMeasurement.position.xMetres, 0)
  assert.equal((projected[1].payload as any).result.result.vision.locomotionMeasurement.position.xMetres, 0.1)
  assert.equal((projected[2].payload as any).locomotionMeasurement.position.xMetres, 0.2)
  assert.equal((projected[3].payload as any).locomotionMeasurement, undefined)
  assert.ok((projected[3].payload as any).observationChanges.some((change: any) =>
    change.path.join('.') === 'position.xMetres' && change.value === 0.5))
  assert.deepEqual(events, original, 'durable input events are not mutated')
})

test('one-shot autonomous invocations with continuationPolicy none drain without parking while bounded and human goals still wait', async () => {
  const pending: any[] = []
  let task: any = {
    source: 'autonomy',
    decision: { outcome: 'request_user', objectiveComplete: false, continuationPolicy: 'none', requiredCompletionBasis: 'action_result' },
  }
  const waits: string[] = []
  const graphExecution = {
    task: () => task,
    pendingEvents: () => pending,
    waitForEvent: (reason: string) => {
      waits.push(reason)
      if (!pending.length) throw new Error('waiting for ' + reason)
      return pending.shift()
    },
  }
  const properties = { drain: false, userGraph: 'environment', autonomyGraph: 'robot-autonomy-controller' }
  const autonomousCtx = { graphExecution, _graphExecutorIteration: 1, robotObserver: { triggerSource: 'autonomy' } } as any

  assert.deepEqual(await executionEventWaitNode.execute({}, autonomousCtx, properties), { invocation: null })
  assert.deepEqual(waits, [], 'One-shot autonomous step with continuationPolicy=none finishes instead of parking on user_or_autonomy')

  const takeover = { userMessage: 'Actually come here.', userMessageEntry: { role: 'user', content: 'Actually come here.', timestamp: 1 } }
  pending.push({ kind: 'user_steering', payload: takeover })
  const handedOff = await executionEventWaitNode.execute({}, autonomousCtx, properties)
  assert.equal(handedOff.invocation.graph, 'environment')
  assert.equal(handedOff.invocation.context.userMessage, 'Actually come here.')
  assert.deepEqual(waits, ['pending_input'])

  for (const continuationPolicy of ['bounded', undefined]) {
    waits.length = 0
    task = { source: 'autonomy', decision: { outcome: 'wait', objectiveComplete: false, continuationPolicy } }
    await assert.rejects(executionEventWaitNode.execute({}, autonomousCtx, properties), /waiting for user_or_autonomy/)
  }

  waits.length = 0
  task = { source: 'user', decision: { outcome: 'request_user', objectiveComplete: false, continuationPolicy: 'none', requiredCompletionBasis: 'user_input' } }
  await assert.rejects(executionEventWaitNode.execute({}, { ...autonomousCtx, userMessage: 'Keep talking with me.' }, properties),
    /waiting for user_or_autonomy/, 'Human conversational objectives with continuationPolicy=none still wait for user replies')
})
