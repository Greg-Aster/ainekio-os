import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import type { TaskInput } from '../../queue/types.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-activity-retention-'))
process.env.METAHUMAN_ROOT = root
fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
fs.copyFileSync(new URL('../../../../../etc/agents.json', import.meta.url), path.join(root, 'etc/agents.json'))
const { eventBus } = await import('../../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { ExecutionStore } = await import('../../durable-execution/store.js')
const { ExecutionCheckpointer } = await import('../../durable-execution/checkpointer.js')
const { executionWorkInput } = await import('../../durable-execution/coordinator-outbox.js')
const { deliverDurableWorkReceipt } = await import('../../durable-execution/work-results.js')
const { buildDesireAgentTaskInput } = await import('../../queue/work-submission.js')
const queue = await import('../../queue/unified-queue-manager.js')
let filename = path.join(root, 'executions.sqlite')
const storage = await import('../../durable-execution/storage.js')
mock.module('../../durable-execution/storage.js', { namedExports: { ...storage,
  openExecutionStore: () => new ExecutionStore(filename) } })
const { robotAutonomyTaskCatalogNode } = await import('./task-catalog.node.js')
const { robotAutonomyActivityHistoryNode, readRobotAutonomyActivity } = await import('./autonomy-activity-history.node.js')

const parentDefinition = { graphId: 'Editable Active Operator', graphHash: 'parent', runtimeVersion: 'fixture',
  checkpointSchemaVersion: 1, nodeVersions: { active_operator_dispatch: 'fixture', robot_autonomy_controller_parser: 'fixture' } }
const childDefinition = { ...parentDefinition, graphId: 'Environment', graphHash: 'child', nodeVersions: { environment_active_task: 'fixture' } }
let manager = new queue.UnifiedQueueManager({ historyLimit: 2 })
mock.method(queue.getQueueManager(), 'getAllTasks', () => manager.getAllTasks())
mock.method(queue.getQueueManager(), 'getHistory', () => manager.getHistory())

test.beforeEach(() => {
  filename = path.join(root, `${randomUUID()}.sqlite`)
  manager = new queue.UnifiedQueueManager({ historyLimit: 2 })
})

async function admitActivity(status: 'completed' | 'failed' | 'idle', label: string,
  submission?: (instruction: string, reason: string) => TaskInput) {
  const store = new ExecutionStore(filename)
  try {
    const parent = store.enter('fixture', parentDefinition, randomUUID(), { context: { robotOperatorContext: { robotObserver: {
      triggerSource: 'autonomy', requestedBy: 'robot-autonomy-controller', graph: 'robot-autonomy-controller',
    } } } })
    const lease = store.claim(parent.executionId, parentDefinition)
    const instruction = `${label}\n` + 'Preserve this complete intention and attribution. '.repeat(45)
    const reason = `${label}: selected from recorded evidence.`
    const taskInput: TaskInput = submission?.(instruction, reason) ?? {
      type: 'environment_observation', handler: 'environment.observation', source: 'autonomy', username: 'fixture',
      executionScope: 'independent', input: { agentId: 'robot-autonomy-executor', triggeredBy: 'robot-autonomy-controller',
        plannerDecision: { instruction, reason, observed: 'Recorded observation.' } },
      metadata: { producer: 'robot-autonomy-controller', selectedAgent: 'robot-autonomy-executor', decisionInstruction: instruction, decisionReason: reason },
    }
    const update = { operationId: String(taskInput.metadata?.selectedAgent), activation: 100, instruction, reason }
    const assessment = { executionId: parent.executionId, mode: 'full', assessedAt: new Date().toISOString(),
      updates: [update], selected: [update], levels: { [update.operationId]: { ...update, assessedAt: new Date().toISOString() } } }
    const effectId = randomUUID()
    await new ExecutionCheckpointer(store, lease).put({ configurable: { thread_id: parent.executionId } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_versions: {}, versions_seen: {}, channel_values: {
        nodeEntries: [['editable-parser', { status: 'completed', definition: { type: 'robot_autonomy_controller_parser' }, outputs: { assessment } }]],
        executionTransition: { transitionId: randomUUID(), dispatches: [{ effectId, kind: 'coordinator_work', payload: taskInput }] },
      },
    }, { source: 'loop', step: 0, parents: {} })
    const work = manager.enqueue(executionWorkInput(store, store.dispatch(effectId)))
    store.acknowledgeAdmission(effectId, work.id)
    assert.ok(manager.claim(work.id))
    const child = store.enter('fixture', childDefinition, `${work.id}:graph:0`, { graph: { scheduler: { eventInputNodeId: 'existing-input' } }, context: { userMessage: '',
      robotOperatorContext: { plannerDecision: { instruction, reason }, robotObserver: { requestedBy: 'robot-autonomy-controller', triggerSource: 'autonomy' } } } })
    manager.attachExecution(work.id, child.executionId)()
    const childLease = store.claim(child.executionId, childDefinition)
    const objective = { objectiveId: randomUUID(), executionId: child.executionId, instruction, source: 'autonomy',
      objective: label, completionCriteria: 'Supported observations establish the requested outcome.',
      decision: { outcome: status === 'completed' ? 'complete' : 'wait', objectiveComplete: status === 'completed', reason },
      selectedAction: { type: 'captureImage' }, actionId: 'camera-action', actionStatus: 'completed', feedback: null,
      baselineFrame: null, updatedAt: new Date().toISOString() }
    store.db.transaction(() => store.commitTransition(child.executionId, 'child-checkpoint', { transitionId: randomUUID(), task: objective }))()
    store.appendEvent(child.executionId, { eventId: 'actual-receipt', kind: 'physical_result', actionId: 'camera-action', payload: {
      feedback: { type: 'completed', message: 'Image acquired; goal success is not established by this receipt.', timestamp: new Date().toISOString() },
    } })
    store.settle(childLease, status === 'idle' ? 'waiting' : status, status === 'idle' ? 'user_or_autonomy' : undefined)
    store.release(childLease)
    store.settle(lease, 'completed')
    store.release(lease)
    manager.complete(work.id, true, { executionId: child.executionId, executionStatus: status })
    await deliverDurableWorkReceipt(manager.getTask(work.id)!, manager, store)
    return { workId: work.id, childId: child.executionId, parentId: parent.executionId, instruction, reason, objective }
  } finally { store.close() }
}

function evictWork() {
  for (let index = 0; index < 3; index++) {
    const unrelated = manager.enqueue({ type: 'generic', handler: 'fixture.unrelated', username: 'fixture', input: {} })
    assert.ok(manager.claim(unrelated.id))
    manager.complete(unrelated.id, true, {})
  }
}

test('catalog retains exact selected activity and outcomes after delivery, eviction and store reopening', async () => {
  const activity = await admitActivity('completed', 'Inspect the selected target')
  const before = await robotAutonomyTaskCatalogNode.execute({}, { username: 'fixture' }, { taskIds: ['robot-autonomy-executor'], limit: 10 })
  const beforeReceipt = before.activationState.operations[0].recordedActivity.find((item: any) => item.taskId === activity.workId)
  assert.equal(beforeReceipt.correlationId, activity.parentId)
  evictWork()
  assert.equal(manager.getTask(activity.workId), null, 'Acknowledged temporary queue payload is released normally')
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await robotAutonomyTaskCatalogNode.execute({}, { username: 'fixture' }, { taskIds: ['robot-autonomy-executor'], limit: 10 })
    const saved = result.activationState.operations[0].recordedActivity.find((item: any) => item.taskId === activity.workId)
    assert.ok(saved, 'The catalog must read the durable selected-work record after queue eviction')
    assert.equal(saved.instruction, activity.instruction)
    assert.equal(saved.reason, activity.reason)
    assert.equal(saved.correlationId, beforeReceipt.correlationId, 'Eviction cannot replace the actual admission correlation with a source cycle')
    assert.deepEqual(saved.executionIds, [activity.childId], 'A completed assessment is not its independently executing child')
    assert.equal(saved.result.executions[0].objective.objectiveId, activity.objective.objectiveId)
    assert.match(saved.result.executions[0].results[0].feedback.message, /goal success is not established/)
    assert.equal(saved.result.executions[0].status, 'completed')
  }
})

test('Agency status retains activity when the assessment graph reads history in a separate branch', async () => {
  const activity = await admitActivity('idle', 'Observe the selected target')
  evictWork()
  const graph = JSON.parse(fs.readFileSync(new URL('../../../../../etc/cognitive-graphs/robot-autonomy-controller-mode.json', import.meta.url), 'utf8'))
  const catalog = graph.nodes.find((node: any) => node.data.nodeType === 'robot_autonomy_task_catalog')
  catalog.data.properties = { ...catalog.data.properties, taskIds: ['robot-autonomy-executor'], includeActivityHistory: false }
  const directory = path.join(root, 'etc/cognitive-graphs')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'robot-autonomy-controller-mode.json'), JSON.stringify(graph))

  const inferenceCatalog = await robotAutonomyTaskCatalogNode.execute({}, { username: 'fixture' }, catalog.data.properties)
  assert.deepEqual(inferenceCatalog.activationState.operations[0].recordedActivity, [])

  const { handleGetActiveOperatorStatus } = await import('../../api/handlers/active-operator.js')
  const response = await handleGetActiveOperatorStatus({ path: '/api/active-operator/status', method: 'GET',
    user: { isAuthenticated: true, userId: 'fixture', username: 'fixture', role: 'owner' } })
  assert.equal(response.status, 200, response.error)
  const records = response.data.operations[0].recordedActivity
  const retained = records.find((item: any) => item.taskId === activity.workId)
  assert.ok(retained, 'Agency shows the real activity after its queue admission has been evicted')
  assert.equal(retained.result.executions[0].executionId, activity.childId)
  assert.equal(retained.result.executions[0].status, 'idle', 'Completed admission does not hide an ongoing objective')
  assert.equal(retained.instruction, activity.instruction)
})

test('selected movement receipt and later speech retain their own identities after reopening', async () => {
  const activity = await admitActivity('idle', 'Wave then speak')
  const store = new ExecutionStore(filename)
  try {
    store.db.transaction(() => store.commitTransition(activity.childId, 'action-checkpoint', {
      transitionId: 'separate-actions', task: { ...activity.objective,
        selectedAction: { type: 'requestMotion', description: 'Wave' }, actionId: 'wave-action', actionStatus: 'rejected',
      }, dispatches: [
        { effectId: 'wave-dispatch', kind: 'coordinator_work', actionId: 'wave-action',
          payload: { type: 'environment_command', input: { id: 'wave-action', type: 'requestMotion', description: 'Wave' } } },
        { effectId: 'speech-dispatch', kind: 'coordinator_work', actionId: 'speech-action',
          payload: { type: 'environment_command', input: { id: 'speech-action', type: 'speak', text: 'Hello' } } },
      ],
    }))()
    store.appendEvent(activity.childId, { eventId: 'motion-rejected', kind: 'physical_result', actionId: 'wave-action',
      payload: { action: { id: 'wave-action', type: 'requestMotion', description: 'Wave' },
        feedback: { actionId: 'wave-action', type: 'rejected', timestamp: '2026-10-28T02:15:00.000Z',
        message: 'Motion rejected', data: { command: 'requestMotion' } } } })
    store.appendEvent(activity.childId, { eventId: 'speech-played', kind: 'physical_result', actionId: 'speech-action',
      payload: { action: { id: 'speech-action', type: 'speak', text: 'Hello' },
        feedback: { actionId: 'speech-action', type: 'completed', timestamp: '2026-10-28T02:15:01.000Z',
        message: 'speech_played', data: { command: 'speak' } } } })
  } finally { store.close() }
  evictWork()
  for (let repeat = 0; repeat < 2; repeat++) {
    const reopened = new ExecutionStore(filename)
    try {
      const records = await readRobotAutonomyActivity(reopened, 'fixture', [], 1, ['robot-autonomy-executor'])
      const result = (records.find(item => item.taskId === activity.workId)!.result!.executions as any[])[0]
      assert.equal(result.lastResult, undefined)
      assert.deepEqual(result.results.map((entry: any) => [entry.actionId, entry.feedback.type]), [
        ['wave-action', 'rejected'], ['speech-action', 'completed'],
      ])
      assert.equal(result.objective.actionId, 'wave-action')
      assert.equal(result.results[0].timestamp, '2026-10-28T02:15:00.000Z')
      assert.equal(result.results[1].feedback.data.command, 'speak')
      assert.equal(result.results[0].requested.type, 'requestMotion')
      assert.equal(result.results[1].requested.type, 'speak')
      assert.ok(reopened.events(activity.childId).some(event => event.actionId === 'camera-action'),
        'Earlier action history remains available through execution context')
      assert.equal(result.objective.decision.objectiveComplete, false)
    } finally { reopened.close() }
  }
})

test('terminal history selection never hides older idle linked objectives or turns a failure into success', async () => {
  const idle = await admitActivity('idle', 'Observe the unresolved target')
  await admitActivity('completed', 'A newer completed activity')
  const failed = await admitActivity('failed', 'A later failed activity')
  evictWork()
  const result = await robotAutonomyTaskCatalogNode.execute({}, { username: 'fixture' }, { taskIds: ['robot-autonomy-executor'], limit: 1 })
  const records = result.activationState.operations[0].recordedActivity
  assert.ok(records.some((item: any) => item.executionIds.includes(idle.childId)), 'Idle goals remain accessible beyond the terminal selection window')
  assert.ok(records.some((item: any) => item.executionIds.includes(failed.childId) && item.result.executions[0].status === 'failed'))
  assert.equal(records.filter((item: any) => item.result.executions.every((execution: any) => ['completed', 'failed', 'cancelled'].includes(execution.status))).length, 1)
})

test('a stale admission snapshot cannot replace the durable linkage of an older active goal', async () => {
  const active = await admitActivity('idle', 'Keep following the selected target')
  const stale = { ...manager.getTask(active.workId)!, graphExecutions: undefined }
  await admitActivity('completed', 'A newer finite activity')
  evictWork()
  const store = new ExecutionStore(filename)
  try {
    const records = await readRobotAutonomyActivity(store, 'fixture', [stale], 1, ['robot-autonomy-executor'])
    assert.deepEqual(records.find(item => item.taskId === active.workId)?.executionIds, [active.childId])
    const executions = records.find(item => item.taskId === active.workId)?.result?.executions
    assert.ok(Array.isArray(executions))
    assert.equal(executions[0].status, 'idle')
  } finally { store.close() }
})

async function admitAssessment(username = 'fixture', observer: unknown = {
  requestedBy: 'robot-autonomy-controller', triggerSource: 'autonomy',
}, reason = 'No operation currently selected.') {
  const store = new ExecutionStore(filename)
  try {
    const record = store.enter(username, parentDefinition, randomUUID(), { context: { robotOperatorContext: { robotObserver: observer } } })
    const lease = store.claim(record.executionId, parentDefinition)
    const assessment = { executionId: record.executionId, mode: 'full', assessedAt: new Date().toISOString(),
      updates: [], selected: [], levels: {}, reason }
    await new ExecutionCheckpointer(store, lease).put({ configurable: { thread_id: record.executionId } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_versions: {}, versions_seen: {}, channel_values: {
        nodeEntries: [['editable-parser-name', { definition: { type: 'robot_autonomy_controller_parser' }, status: 'completed', outputs: { assessment } }]],
      },
    }, { source: 'loop', step: 0, parents: {} })
    store.settle(lease, 'completed'); store.release(lease)
    return { record, assessment }
  } finally { store.close() }
}

test('current assessments and selected child outcomes remain separately attributed after reopening', async () => {
  const activity = await admitActivity('completed', 'Inspect the selected target')
  evictWork()
  const result = await robotAutonomyActivityHistoryNode.execute({}, { username: 'fixture' }, { limit: 10 })
  assert.equal(result.count, 2)
  const assessment = result.history.find((item: any) => item.result.assessment)
  assert.deepEqual(assessment.executionIds, [activity.parentId])
  assert.equal(assessment.taskId, undefined, 'A missing queue task ID must remain unknown')
  assert.equal(assessment.result.assessment.updates[0].instruction, activity.instruction)
  const selected = result.history.find((item: any) => item.taskId === activity.workId)
  assert.deepEqual(selected.executionIds, [activity.childId])
  assert.equal(selected.result.executions[0].objective.objectiveId, activity.objective.objectiveId)
})

test('Desire lifecycle admissions preserve controller selection through the actual owner metadata rewrite', async () => {
  const expected = []
  for (const operation of ['plan', 'execute', 'review', 'checkin'] as const) expected.push(await admitActivity('completed', `Selected Desire ${operation}`,
    (instruction, reason) => ({ ...buildDesireAgentTaskInput({ username: 'fixture', desireId: 'desire-recorded',
      source: 'autonomy', operation, metadata: { producer: 'robot-autonomy-controller', selectedAgent: 'desire-agent',
        decisionInstruction: instruction, decisionReason: reason },
    }), executionScope: 'independent' })))
  evictWork()
  const store = new ExecutionStore(filename)
  try {
    const records = await readRobotAutonomyActivity(store, 'fixture', [], 10, ['desire-agent'])
    assert.equal(records.length, expected.length)
    for (const activity of expected) {
      const saved = records.find(item => item.taskId === activity.workId)!
      assert.ok(saved)
      assert.equal(saved.capabilityId, 'desire-agent')
      assert.equal(saved.instruction, activity.instruction)
      assert.deepEqual(saved.executionIds, [activity.childId])
    }
  } finally { store.close() }
})

test('an explicit continuation retains its existing goal and reports handoff separately from the target outcome', async () => {
  const target = await admitActivity('idle', 'Observe the selected object')
  const store = new ExecutionStore(filename)
  let parentId: string
  try {
    const parent = store.enter('fixture', parentDefinition, 'continue-assessment', { context: { robotOperatorContext: { robotObserver: {
      requestedBy: 'robot-autonomy-controller', triggerSource: 'autonomy',
    } } } })
    parentId = parent.executionId
    const lease = store.claim(parentId, parentDefinition)
    const update = { operationId: 'robot-autonomy-executor', activation: 100, instruction: 'Continue observing that same object.',
      reason: 'The objective remains unresolved.', target: { kind: 'execution', executionId: target.childId } }
    const assessment = { executionId: parentId, mode: 'full', assessedAt: new Date().toISOString(), updates: [update], selected: [update], levels: {} }
    await new ExecutionCheckpointer(store, lease).put({ configurable: { thread_id: parentId } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_versions: {}, versions_seen: {}, channel_values: {
        nodeEntries: [['parser', { definition: { type: 'robot_autonomy_controller_parser' }, status: 'completed', outputs: { assessment } }]],
        executionTransition: { transitionId: 'continuation', dispatches: [{ effectId: 'continue-existing', kind: 'execution_event', payload: {
          executionId: target.childId, kind: 'autonomy_trigger', context: { robotOperatorContext: { plannerDecision: {
            instruction: update.instruction, reason: update.reason,
          } } },
        } }] },
      },
    }, { source: 'loop', step: 0, parents: {} })
    store.deliverExecutionInput('continue-existing')
    store.settle(lease, 'completed'); store.release(lease)
    const continued = store.claim(target.childId, childDefinition)
    store.settle(continued, 'failed'); store.release(continued)
  } finally { store.close() }
  evictWork()
  const result = await robotAutonomyTaskCatalogNode.execute({}, { username: 'fixture' }, { taskIds: ['robot-autonomy-executor'], limit: 1 })
  const activity = result.activationState.operations[0].recordedActivity[0]
  assert.equal(activity.taskId, undefined)
  assert.equal(activity.instruction, 'Continue observing that same object.')
  assert.deepEqual(activity.executionIds, [target.childId])
  assert.deepEqual(activity.result.handoff, { effectId: 'continue-existing', sourceExecutionId: parentId,
    targetExecutionId: target.childId, kind: 'autonomy_trigger', status: 'completed' })
  assert.equal(activity.result.executions[0].objective.objectiveId, target.objective.objectiveId)
  assert.equal(activity.result.executions[0].objective.instruction, target.instruction)
  assert.equal(activity.result.executions[0].status, 'failed', 'Delivered continuation is not goal success')
})

test('durable selection excludes other profiles and non-autonomy provenance before applying the history setting', async () => {
  const own = await admitAssessment()
  await admitAssessment('other-profile')
  await admitAssessment('fixture', { requestedBy: 'robot-autonomy-controller', triggerSource: 'user' })
  await admitAssessment('fixture', null)
  await admitAssessment('fixture', { requestedBy: 'diagnostic-copy', triggerSource: 'autonomy' })
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await robotAutonomyActivityHistoryNode.execute({}, { username: 'fixture' }, { limit: 1 })
    assert.equal(result.count, 1)
    assert.deepEqual(result.history[0].executionIds, [own.record.executionId])
    assert.deepEqual(result.history[0].result.assessment, own.assessment)
  }
})

test('recent selection decodes selected assessments rather than all older checkpoint payloads', async () => {
  const expected = []
  for (let index = 0; index < 25; index++) expected.push(await admitAssessment('fixture', undefined,
    `${index}: ${'Complete retained evidence. '.repeat(80)}Final attributed detail.`))
  for (let index = 0; index < 3; index++) await admitAssessment('fixture', null)
  let checkpoints = 0
  const getTuple = ExecutionCheckpointer.prototype.getTuple
  const spy = mock.method(ExecutionCheckpointer.prototype, 'getTuple', function (this: InstanceType<typeof ExecutionCheckpointer>, ...args: Parameters<typeof getTuple>) {
    checkpoints++; return getTuple.apply(this, args)
  })
  try {
    const result = await robotAutonomyActivityHistoryNode.execute({}, { username: 'fixture' }, { limit: 10 })
    assert.deepEqual(new Set(result.history.map((item: any) => item.executionIds[0])), new Set(expected.slice(-10).map(item => item.record.executionId)))
    for (const item of result.history) assert.deepEqual(item.result.assessment, expected.find(row => row.record.executionId === item.executionIds[0])!.assessment)
    assert.equal(checkpoints, 10, 'Unselected old checkpoint channels must not be loaded')
  } finally { spy.mock.restore() }
})

test('catalog selection retains older work beyond a large set of no-operation controller admissions', async () => {
  const activity = await admitActivity('completed', 'An older actual selected objective')
  evictWork()
  const store = new ExecutionStore(filename)
  try {
    let finalParent: ReturnType<typeof store.enter> | undefined
    let finalLease: ReturnType<typeof store.claim> | undefined
    store.db.transaction(() => {
      for (let index = 0; index < 5_000; index++) {
        const parent = store.enter('fixture', parentDefinition, `no-operation-${index}`, { context: { robotOperatorContext: {
          robotObserver: { requestedBy: 'robot-autonomy-controller', triggerSource: 'autonomy' },
          evidence: 'Recorded scene evidence. '.repeat(100),
        } } })
        const lease = store.claim(parent.executionId, parentDefinition)
        store.commitTransition(parent.executionId, `checkpoint-${index}`, { transitionId: `no-selection-${index}`, dispatches: [{
          effectId: `internal-camera-${index}`, kind: 'coordinator_work', actionId: `internal-camera-action-${index}`, payload: { type: 'environment_command',
            source: 'autonomy', username: 'fixture', input: { type: 'captureImage' }, metadata: { producer: 'environment-bridge' } },
        }] })
        store.acknowledgeAdmission(`internal-camera-${index}`, `internal-work-${index}`)
        store.acceptAction(`internal-camera-${index}`)
        store.recordResult(parent.executionId, `internal-camera-action-${index}`, { eventId: `internal-receipt-${index}`,
          kind: 'physical_result', actionId: `internal-camera-action-${index}`, workItemId: `internal-work-${index}`,
          payload: { feedback: { type: 'completed', message: 'Recorded camera acquisition' } },
        })
        if (index < 4_999) { store.settle(lease, 'completed'); store.release(lease) }
        else { finalParent = parent; finalLease = lease }
      }
    })()
    const assessment = { executionId: finalParent!.executionId, mode: 'full', assessedAt: new Date().toISOString(),
      updates: [], selected: [], levels: {} }
    await new ExecutionCheckpointer(store, finalLease!).put({ configurable: { thread_id: finalParent!.executionId } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_versions: {}, versions_seen: {}, channel_values: {
        nodeEntries: [['parser', { definition: { type: 'robot_autonomy_controller_parser' }, status: 'completed', outputs: { assessment } }]],
      },
    }, { source: 'loop', step: 0, parents: {} })
    store.settle(finalLease!, 'completed'); store.release(finalLease!)
    assert.deepEqual(store.active('fixture'), [], 'The benchmark contains settled quiet assessments, not unfinished camera work')
  } finally { store.close() }
  let admissions = 0
  const entry = ExecutionStore.prototype.entryOrNull
  const reader = mock.method(ExecutionStore.prototype, 'entryOrNull', function (this: InstanceType<typeof ExecutionStore>, ...args: Parameters<typeof entry>) {
    admissions++; return entry.apply(this, args)
  })
  try {
    const started = performance.now()
    const result = await robotAutonomyTaskCatalogNode.execute({}, { username: 'fixture' }, { taskIds: ['robot-autonomy-executor'], limit: 10 })
    console.log(`Catalog across 5000 no-operation controllers: ${(performance.now() - started).toFixed(2)} ms; decoded admissions ${admissions}`)
    const records = result.activationState.operations[0].recordedActivity
    assert.deepEqual(records.map((item: any) => item.taskId), [activity.workId])
    assert.equal(admissions, 2, 'Only the latest assessment and the actual selected-work parent need admission decoding')
  } finally { reader.mock.restore() }
})

test.after(() => { mock.restoreAll(); eventBus.disconnect(); fs.rmSync(root, { recursive: true, force: true }) })
