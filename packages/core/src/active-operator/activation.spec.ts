import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { selectActivatedOperations, type ActivationUpdate } from './activation.js'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-'))
process.env.METAHUMAN_ROOT = root
const { eventBus } = await import('../infrastructure/event-bus/client.js')
eventBus.disconnect()
const { robotAutonomyControllerParserNode: parser, parseRobotAutonomyChoice, buildRobotAutonomyControllerJsonSchema } = await import('../nodes/robot-operator/autonomy-controller-parser.node.js')
const update = (operationId: string, activation: number): ActivationUpdate => ({operationId, activation, reason: 'Recorded context', instruction: 'Full unchanged intention'})
const operations = [{id:'reflector'}, {id:'daydreamer'}, {id:'boredom-observer'}]
function connection(online: boolean, sessionId = 'fixture-body') {
  const now = new Date().toISOString()
  fs.mkdirSync(path.join(root, 'logs/run'), { recursive: true })
  fs.writeFileSync(path.join(root, 'logs/run/environment-bridge-state.json'), JSON.stringify({ enabled: true,
    updatedAt: now, feedback: [], sessions: { [sessionId]: { sessionId, environmentId: 'fixture', adapter: 'ainekio',
      status: 'connected', firstSeenAt: now, lastSeenAt: now,
      latestObservation: { sessionId, timestamp: now, state: { adapterConnected: true,
        body: { authenticated: online, robotId: 'p4' }, gateway: { robots: { p4: { connection_state: online ? 'online' : 'offline' } } } } } } } }))
}
connection(true)

const levels = [update('reflector', 99.9), update('daydreamer',100), update('boredom-observer',100)]
test('mode rules cover Semi boundary, all qualifying operations, Full ties, empty choices and Reactive', () => {
  assert.deepEqual(selectActivatedOperations(levels,'semi'),levels.slice(1))
  assert.deepEqual(selectActivatedOperations(levels,'full'),[levels[1]])
  assert.deepEqual(selectActivatedOperations([update('reflector',0),update('daydreamer',0)],'full'),[])
  assert.deepEqual(selectActivatedOperations([update('reflector',24),update('daydreamer',41)],'full'),[update('daydreamer',41)])
  assert.deepEqual(selectActivatedOperations(levels,'reactive'),[])
  assert.deepEqual(selectActivatedOperations([],'full'),[])
})
test('two assessments preserve omitted levels but request only this assessment updates', async () => {
  const historical = { ...levels[2], assessedAt: '2026-10-14T12:00:00Z' }
  const first = await parser.execute({ response: JSON.stringify({updates:levels.slice(0, 2)}), availableTasks:operations,
    activationState:{mode:'semi',previous:{ levels: { 'boredom-observer': historical } },assessedAt:'2026-10-15T12:00:00Z'} },{graphExecution:{executionId:'first'} as any},{})
  const second = await parser.execute({ response:JSON.stringify({updates:[{...update('reflector',55),target:null}],assessmentReason:'The present assessment selects reflection.',memoryRequest:null}), availableTasks:operations,
    activationState:{mode:'full',previous:first.assessment,assessedAt:'2026-10-15T12:01:00Z'} },{graphExecution:{executionId:'second'} as any},{})
  assert.equal(second.assessment.levels.daydreamer.activation,100)
  assert.equal(second.assessment.levels.daydreamer.assessedAt,first.assessment.assessedAt)
  assert.equal(second.assessment.levels.daydreamer.mode, 'semi')
  assert.equal(second.assessment.levels.reflector.mode, 'full')
  assert.deepEqual(second.assessment.levels['boredom-observer'], historical, 'Old unattributed levels stay unknown')
  assert.equal('assessmentReason' in first.assessment, false, 'Semi does not acquire a reason it did not return')
  assert.deepEqual(second.assessment.selected,[{...update('reflector',55),target:null}])
  assert.throws(()=>parseRobotAutonomyChoice(JSON.stringify({updates:[update('unknown',100)]}),operations))
  assert.throws(()=>parseRobotAutonomyChoice(JSON.stringify({updates:[update('reflector',101)]}),operations))
})
test('assessment survives process reopening and unrelated queue-history eviction', async () => {
  const { ExecutionStore } = await import('../durable-execution/store.js')
  const { ExecutionCheckpointer } = await import('../durable-execution/checkpointer.js')
  const filename = path.join(root,'execution.sqlite')
  const store = new ExecutionStore(filename)
  const definition={graphId:'operator',graphHash:'fixture',runtimeVersion:'fixture',checkpointSchemaVersion:1,nodeVersions:{active_operator_dispatch:'1'}}
  const record=store.enter('fixture',definition,'assessment', {graph:{name:'Active Operator'},context:{username:'fixture',
    robotOperatorContext:{robotObserver:{requestedBy:'robot-autonomy-controller'}}}})
  const lease=store.claim(record.executionId,definition)
  const assessment={executionId:record.executionId,mode:'full',assessmentReason:'Preserve the selected intention and its basis.',memoryRequest:{memoryQuery:'Prior selected topic'},assessedAt:'2026-10-15T12:00:00Z',updates:levels,
    levels:{reflector:{...levels[0],assessedAt:'2026-10-15T12:00:00Z',mode:'full'},
      daydreamer:{...levels[1],assessedAt:'2026-10-14T12:00:00Z'}},selected:levels.slice(1)}
  await new ExecutionCheckpointer(store,lease).put({configurable:{thread_id:record.executionId}}, {
    v:4,id:randomUUID(),ts:new Date().toISOString(),channel_versions:{},versions_seen:{},channel_values:{nodeEntries:[['editable-id',{
      status:'completed',definition:{type:'robot_autonomy_controller_parser'},outputs:{assessment}}]]}}, {source:'loop',step:0,parents:{}})
  store.settle(lease,'completed');store.release(lease)
  const failed = store.enter('fixture', definition, 'later-failed-assessment', { graph: { name: 'Active Operator' },
    context: { username: 'fixture',
      robotOperatorContext: { robotObserver: { requestedBy: 'robot-autonomy-controller' } } } })
  const failedLease = store.claim(failed.executionId, definition)
  store.settle(failedLease, 'failed'); store.release(failedLease); store.close()
  const storage=await import('../durable-execution/storage.js')
  const mocked=mock.module('../durable-execution/storage.js',{namedExports:{...storage,openExecutionStore:()=>new ExecutionStore(filename)}})
  try {
    const {readActivationAssessments}=await import('./activation-history.js')
    assert.deepEqual(await readActivationAssessments('fixture',1),[assessment])
    fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
    fs.copyFileSync(new URL('../../../../etc/agents.json', import.meta.url), path.join(root, 'etc/agents.json'))
    const { robotAutonomyTaskCatalogNode } = await import('../nodes/robot-operator/task-catalog.node.js')
    for (const mode of ['full', 'semi']) {
      fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
      fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: mode }))
      const catalog = await robotAutonomyTaskCatalogNode.execute({}, { username: 'fixture' }, { taskIds: [] })
      assert.deepEqual(catalog.memoryHints, mode === 'full'
        ? { needsMemory: true, memoryQuery: 'Prior selected topic' } : { needsMemory: false })
    }
  } finally {mocked.restore()}
})
test.after(()=>fs.rmSync(root,{recursive:true,force:true}))

test('Robot Status operation carries the selected image and recognition through admission', async () => {
  const { activeOperatorDispatchNode } = await import('../nodes/robot-operator/activation-dispatch.node.js')
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  fs.copyFileSync(new URL('../../../../etc/agents.json', import.meta.url), path.join(root, 'etc/agents.json'))
  fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: 'full' }))
  const frame = { id: 'frame-43', timestamp: '2026-10-24T01:46:41Z', dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    metadata: { counter: 43, recognition: { objects: [{ label: 'person', identity: { state: 'face_match', name: 'Greg', similarity: 0.82 } }] } } }
  const calls: any[] = []
  const result = await activeOperatorDispatchNode.execute({
    assessment: { executionId: 'selected-frame', assessedAt: '2026-10-24T01:46:42Z', updates: [update('robot-status', 80)] },
    availableTasks: [{ id: 'robot-status', name: 'Robot Status', kind: 'agent', handler: 'workflow.robot-status', taskType: 'generic', priority: 'low' }],
    frames: [frame], currentVisualEvidence: true, observation: { sessionId: 'fixture-body' },
  }, { username: 'fixture', graphExecution: { dispatch: (effect: any) => calls.push(effect) } } as any, {})
  const input = calls[0].payload.input
  assert.deepEqual(input.robotOperatorContext.frames, [frame])
  assert.equal(input.robotOperatorContext.sessionId, 'fixture-body')
  assert.deepEqual(input.robotOperatorContext.plannerDecision, result.requests[0].input.plannerDecision)
})

test('Semi admits multiple selected jobs independently; mode changes are applied at dispatch', async () => {
  fs.mkdirSync(path.join(root,'etc'),{recursive:true})
  fs.copyFileSync(new URL('../../../../etc/agents.json',import.meta.url),path.join(root,'etc/agents.json'))
  const {activeOperatorDispatchNode}=await import('../nodes/robot-operator/activation-dispatch.node.js')
  const tasks=operations.map(operation=>({...operation,name:operation.id,kind:'agent',handler:`agent.${operation.id}`,taskType:'generic',priority:'low',tags:[]}))
  const calls:any[]=[]
  const context={username:'fixture',graphExecution:{executionId:'assessment',dispatch:(effect:any)=>{calls.push(effect);return {effectId:`effect-${calls.length}`}}}} as any
  const assessment={executionId:'assessment',assessedAt:'2026-10-15T12:00:00Z',mode:'full',updates:levels,levels:{},selected:[levels[1]]}
  fs.writeFileSync(path.join(root,'etc/active-operator.json'),JSON.stringify({autonomyMode:'semi'}))
  const result=await activeOperatorDispatchNode.execute({assessment,availableTasks:tasks},context,{})
  assert.deepEqual(calls.map(effect=>effect.payload.input.agentId),['daydreamer','boredom-observer'])
  assert.ok(calls.every(effect=>effect.payload.executionScope==='independent'))
  assert.equal(result.innerEntries.length,2)
  assert.ok(result.innerEntries.every((entry:any)=>entry.meta.source==='autonomy'))
  assert.equal(result.requests[0].input.graphContext.taskBrief,JSON.stringify(result.requests[0].input.plannerDecision))
  fs.writeFileSync(path.join(root,'etc/active-operator.json'),JSON.stringify({autonomyMode:'reactive'}))
  const dormant=await activeOperatorDispatchNode.execute({assessment,availableTasks:tasks},context,{})
  assert.equal(dormant.requests.length,0)
  assert.equal(calls.length,2)
})

test('a disconnected body remains reported while model-selected nonphysical activity proceeds', async () => {
  const { readRobotOperatorBodyConnection } = await import('../robot-operator.js')
  const { activeOperatorDispatchNode } = await import('../nodes/robot-operator/activation-dispatch.node.js')
  const { robotAutonomyTaskCatalogNode } = await import('../nodes/robot-operator/task-catalog.node.js')
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  fs.copyFileSync(new URL('../../../../etc/agents.json', import.meta.url), path.join(root, 'etc/agents.json'))
  fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: 'full' }))
  connection(false)
  assert.equal(readRobotOperatorBodyConnection('fixture-body').connected, false, 'A connected gateway is insufficient')
  const catalog = await robotAutonomyTaskCatalogNode.execute({},
    { username: 'fixture', robotOperatorContext: { sessionId: 'fixture-body' } } as any, { taskIds: [], includeActivityHistory: false })
  const { robotAutonomyControllerContextNode } = await import('../nodes/robot-operator/context-builder.node.js')
  const graph = JSON.parse(fs.readFileSync(new URL('../../../../etc/cognitive-graphs/robot-autonomy-controller-mode.json', import.meta.url), 'utf8'))
  const assessmentContext = await robotAutonomyControllerContextNode.execute({ activationState: catalog.activationState,
    availableTasks: catalog.tasks, instruction: graph.nodes.find((node: any) => node.id === 'policy').data.properties.message,
    fullInstruction: graph.nodes.find((node: any) => node.id === 'full-policy').data.properties.message }, {}, {})
  assert.deepEqual(JSON.parse(assessmentContext.messages[1].content).activeOperator.bodyConnection, catalog.activationState.bodyConnection)
  const selectionContext = await robotAutonomyControllerContextNode.execute({ activationState: catalog.activationState }, {}, { contextPurpose: 'selection' })
  assert.deepEqual(JSON.parse(selectionContext.request).bodyConnection, catalog.activationState.bodyConnection)
  const choice = { ...update('reflector', 80), target: null }
  const result = await parser.execute({ response: JSON.stringify({ updates: [choice],
    assessmentReason: 'Reflection can use the supplied experience without a physical body.', memoryRequest: null }), availableTasks: operations,
    activationState: { mode: 'full', previous: { levels: { reflector: levels[0] } } } },
    { robotOperatorContext: { sessionId: 'fixture-body' }, graphExecution: { executionId: 'late' } } as any, {})
  assert.deepEqual(result.assessment.selected, [choice])
  const tasks = [{ id: 'reflector', name: 'Reflection', kind: 'agent', handler: 'agent.reflector',
    taskType: 'reflection', priority: 'low', tags: [] }]
  const effects: any[] = []
  const dispatch = await activeOperatorDispatchNode.execute({ assessment: result.assessment,
    availableTasks: tasks, observation: { sessionId: 'fixture-body' } },
    { username: 'fixture', graphExecution: { dispatch(effect: any) { effects.push(effect) } } } as any, {})
  assert.equal(dispatch.requests.length, 1)
  assert.equal(effects[0].payload.input.agentId, 'reflector')
  assert.equal(catalog.activationState.bodyConnection.connected, false)
  connection(true, 'different-body')
  assert.equal(readRobotOperatorBodyConnection('fixture-body').connected, false)
  connection(true)
  assert.equal(readRobotOperatorBodyConnection('fixture-body').connected, true)
})

test('Full preserves target and temporal recall while Semi keeps its contract', async () => {
  connection(true)
  const tasks = [{ id: 'robot-autonomy-executor' }, { id: 'desire-agent' }]
  const choice = { ...update(tasks[0].id, 80), target: { kind: 'execution', executionId: 'existing-goal' } }
  for (const memoryRequest of [null, { memoryOrder: 'newest' }, { memorySleepCycle: 'latest' },
    { memoryQuery: 'Original query\nwith all context', memoryTimeRange: { from: '2026-10-25T00:00:00Z' } }]) {
    const result = await parser.execute({ response: JSON.stringify({ updates: [choice], assessmentReason: 'Continue the selected pursuit.', memoryRequest }),
      availableTasks: tasks, activationState: { mode: 'full', previous: null } },
      { graphExecution: { executionId: 'assessment' } } as any, {})
    assert.deepEqual(result.assessment.selected, [choice])
    assert.deepEqual(result.assessment.memoryRequest, memoryRequest)
  }
  assert.throws(() => parseRobotAutonomyChoice(JSON.stringify({ updates: [choice] }), tasks, 'full'))
  assert.throws(() => parseRobotAutonomyChoice(JSON.stringify({ updates: [choice], assessmentReason: 'Continue the selected pursuit.', memoryRequest: null,
    reconsider: { on: ['queue'], at: null, now: false, environment: [] } }), tasks, 'full'))
  assert.throws(() => parseRobotAutonomyChoice(JSON.stringify({ updates: [{ ...choice, operationId: 'desire-agent' }],
    assessmentReason: 'Continue the selected pursuit.', memoryRequest: null }), tasks, 'full'))
  assert.deepEqual(parseRobotAutonomyChoice(JSON.stringify({ updates: [update(tasks[0].id, 100)] }), tasks, 'semi'),
    [update(tasks[0].id, 100)])
})

test('Full does not advertise or accept a suspension policy', () => {
  const schema = buildRobotAutonomyControllerJsonSchema(operations, 'full')
  assert.equal('reconsider' in schema.properties, false)
  assert.throws(() => parseRobotAutonomyChoice(JSON.stringify({ updates: [], assessmentReason: 'No operation selected.', memoryRequest: null,
    reconsider: { on: ['input'], at: null, now: false, environment: [] } }), operations, 'full'), /mode contract/)
})

test('Full requires a positive activity selection while Semi preserves non-triggering updates', async () => {
  connection(true)
  const assessmentReason = '  The recorded outcomes support this selected activity.\nContinue with the complete intention.  '
  const zero = { ...update('reflector', 0), target: null }
  const positive = { ...update('daydreamer', 0.000001), target: null }
  for (const updates of [[], [zero], [zero, { ...zero, operationId: 'daydreamer' }]]) {
    const response = JSON.stringify({ updates, assessmentReason, memoryRequest: null })
    assert.throws(() => parseRobotAutonomyChoice(response, operations, 'full'), /positive activity/)
    await assert.rejects(parser.execute({ response, availableTasks: operations,
      activationState: { mode: 'full', previous: { levels: { daydreamer: { ...positive, activation: 100 } } } } },
      { graphExecution: { executionId: 'invalid-full-selection' } } as any, {}), /positive activity/,
    'An omitted historical selection must not substitute for a new Full decision')
  }
  const body = { updates: [zero, positive], memoryRequest: null }
  const result = await parser.execute({ response: JSON.stringify({ ...body, assessmentReason }),
    availableTasks: operations, activationState: { mode: 'full', previous: null } },
    { graphExecution: { executionId: 'selected-full-activity' } } as any, {})
  assert.equal(result.assessment.assessmentReason, assessmentReason, 'The complete model-authored reason is preserved')
  assert.deepEqual(result.assessment.updates, [zero, positive], 'Deactivation updates remain valid alongside a positive selection')
  assert.deepEqual(result.assessment.selected, [positive], 'Any positive activation remains eligible without another threshold')
  for (const invalid of [undefined, null, '', ' \n ', 7, {}, []]) {
    assert.throws(() => parseRobotAutonomyChoice(JSON.stringify({ ...body, assessmentReason: invalid }), operations, 'full'),
      invalid === undefined ? /mode contract/ : /assessment reason/)
  }
  assert.deepEqual(parseRobotAutonomyChoice(JSON.stringify({ updates: [] }), operations, 'semi'), [])
  const semiZero = update('reflector', 0)
  assert.deepEqual(parseRobotAutonomyChoice(JSON.stringify({ updates: [semiZero] }), operations, 'semi'), [semiZero])
  assert.throws(() => parseRobotAutonomyChoice(JSON.stringify({ updates: [], assessmentReason }), operations, 'semi'),
    /mode contract/, 'Semi retains its existing exact field contract')
})

test('an autonomous continuation keeps its execution goal, authorship and real outcome through durable delivery', async () => {
  const { activeOperatorDispatchNode } = await import('../nodes/robot-operator/activation-dispatch.node.js')
  const { executionEventWaitNode } = await import('../nodes/utility/execution-event-wait.node.js')
  const { ExecutionStore } = await import('../durable-execution/store.js')
  const { executionContextNode } = await import('../nodes/utility/execution-context.node.js')
  connection(true)
  fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: 'full' }))
  const filename = path.join(root, 'continuation.sqlite')
  let store = new ExecutionStore(filename)
  const definition = { graphId: 'fixture', graphHash: 'fixture', runtimeVersion: 'fixture', checkpointSchemaVersion: 1,
    nodeVersions: { execution_event_wait: 'fixture' } }
  const receiver = store.enter('fixture', definition, 'existing-work', {
    graph: { scheduler: { eventInputNodeId: 'receive' } }, context: { userMessage: null } })
  const sender = store.create('fixture', definition)
  const objective = { objectiveId: 'same-visual-goal', executionId: receiver.executionId, instruction: 'Inspect the reflective object and obtain a clearer view.', source: 'autonomy',
    objective: 'A clearer view of the reflective object', completionCriteria: 'A returned image shows the object clearly.',
    decision: { outcome: 'continue', requiredCompletionBasis: 'visual_observation' }, updatedAt: '2026-10-25T20:00:00Z' }
  store.db.transaction(() => store.commitTransition(receiver.executionId, 'original-task', { transitionId: 'original', task: objective as any }))()
  const calls: any[] = []
  const intention = 'Continue the same objective; the accepted camera command alone did not establish a clear view.'
  const result = await activeOperatorDispatchNode.execute({
    assessment: { executionId: sender.executionId, assessedAt: '2026-10-25T20:00:01Z', updates: [{ ...update('robot-autonomy-executor', 90),
      instruction: intention, target: { kind: 'execution', executionId: receiver.executionId } }] },
    availableTasks: [{ id: 'robot-autonomy-executor', name: 'Robot Autonomy Executor', kind: 'environment-executor',
      handler: 'environment.observation', taskType: 'environment_observation', priority: 'low' }],
    observation: { sessionId: 'fixture-body', timestamp: '2026-10-25T20:00:00Z', adapter: 'fixture', environmentId: 'fixture', capabilities: { actions: ['captureImage'] } },
  }, { username: 'fixture', graphExecution: { dispatch: (effect: any) => calls.push(effect) } } as any, {})
  assert.deepEqual(result.requests, [], 'Continuation creates no competing independent objective')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'execution_event')
  assert.equal(calls[0].payload.kind, 'autonomy_trigger')
  const effect = { ...calls[0], effectId: 'continuation' }
  store.db.transaction(() => store.commitTransition(sender.executionId, 'selected', { transitionId: 'selected', dispatches: [effect] }))()
  store.deliverExecutionInput(effect.effectId)
  store.close()
  store = new ExecutionStore(filename)
  try {
    store.deliverExecutionInput(effect.effectId)
    const events = store.events(receiver.executionId)
    assert.equal(events.length, 1, 'Delivery retry does not replay the instruction')
    const passed = await executionEventWaitNode.execute({}, { graphExecution: { waitForEvent: () => events[0] } } as any,
      { autonomyGraph: 'environment', userGraph: 'environment' })
    assert.equal(passed.invocation.graph, 'environment')
    assert.equal(passed.invocation.context.userMessage, null)
    assert.equal(passed.invocation.context.userMessageEntry, null)
    assert.equal(passed.invocation.context.robotOperatorContext.plannerDecision.instruction, intention)
    assert.equal(passed.invocation.context.robotOperatorContext.robotObserver.triggerSource, 'autonomy')
    assert.deepEqual(store.task(receiver.executionId), objective, 'Admission does not replace or complete the objective')
    store.appendEvent(receiver.executionId, { eventId: 'camera-accepted', kind: 'physical_result', actionId: 'camera',
      payload: { feedback: { actionId: 'camera', type: 'completed', message: 'Capture command completed' } } })
    const next = await executionContextNode.execute({}, { graphExecution: { executionId: receiver.executionId,
      task: () => store.task(receiver.executionId), events: () => store.events(receiver.executionId), activeExecutions: () => [] } } as any, {})
    assert.equal(next.context.task.instruction, objective.instruction)
    assert.equal(next.context.task.decision.outcome, 'continue')
    assert.equal(next.context.events.at(-1).payload.feedback.message, 'Capture command completed')
    assert.equal(next.context.task.decision.requiredCompletionBasis, 'visual_observation')
  } finally { store.close() }
})

test('a Desire target delegates its existing lifecycle operation without manufacturing robot work', async () => {
  connection(true)
  fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: 'full' }))
  const { activeOperatorDispatchNode } = await import('../nodes/robot-operator/activation-dispatch.node.js')
  for (const operation of ['plan', 'execute', 'review', 'checkin']) {
    const effects: any[] = []
    await activeOperatorDispatchNode.execute({ assessment: { executionId: `selection-${operation}`, assessedAt: '2026-10-25T20:00:00Z',
      updates: [{ ...update('desire-agent', 80), target: { kind: 'desire', desireId: 'desire-existing', operation } }] },
      availableTasks: [{ id: 'desire-agent', name: 'Desire Agent', kind: 'agent' }] },
      { username: 'fixture', graphExecution: { dispatch: (effect: any) => effects.push(effect) } } as any, {})
    assert.equal(effects.length, 1)
    assert.equal(effects[0].kind, 'coordinator_work')
    assert.equal(effects[0].payload.executionScope, 'independent')
    assert.equal(effects[0].payload.metadata.desireAgentOperation, operation)
    assert.equal(effects[0].payload.metadata.producer, 'desire-agent')
    assert.equal(effects[0].payload.source, 'autonomy')
    assert.equal(effects[0].payload.handler.startsWith('environment.'), false)
  }
})

test('Full instructions and selected recall are visibly wired without changing Semi instructions or schema', async () => {
  const { robotAutonomyControllerContextNode } = await import('../nodes/robot-operator/context-builder.node.js')
  const graph = JSON.parse(fs.readFileSync(new URL('../../../../etc/cognitive-graphs/robot-autonomy-controller-mode.json', import.meta.url), 'utf8'))
  const node = (id: string) => graph.nodes.find((item: any) => item.id === id)
  const base = node('policy').data.properties.message
  const full = node('full-policy').data.properties.message
  const memory = { id: 'previous-experience', role: 'assistant', source: 'environment', timestamp: '2026-10-24T12:00:00Z',
    content: 'Complete attributed memory.\n'.repeat(200) }
  const execution = { executionId: 'existing-goal', task: { instruction: 'Obtain a clear view.', objectiveId: 'visual',
    completionCriteria: 'A clear image', decision: { outcome: 'continue' } },
    events: [{ kind: 'physical_result', payload: { feedback: { type: 'completed', message: 'Command completed' } } }] }
  const previous = { executionId: 'recall-decision', mode: 'full', assessmentReason: 'Recorded reason retained unchanged.', assessedAt: '2026-10-25T20:00:00Z', updates: [],
    memoryRequest: { memoryQuery: 'Earlier visual experience' } }
  for (const mode of ['semi', 'full']) {
    const result = await robotAutonomyControllerContextNode.execute({ instruction: base, fullInstruction: full,
      activationState: { mode, operations: [], previous }, activeExecutions: [execution], selectedMemoryContext: [memory],
      availableTasks: [{ id: 'robot-autonomy-executor' }], memoryContext: [] }, {}, {})
    assert.equal(result.messages[0].content, mode === 'semi' ? base : full,
      'Full receives its complete activity-selection instruction; Semi keeps its exact existing instruction')
    assert.equal(result.fullMode, mode === 'full', 'Reasoning follows the admitted assessment mode')
    assert.equal(result.jsonSchema.required.includes('reconsider'), false)
    assert.equal(result.jsonSchema.required.includes('assessmentReason'), mode === 'full')
    assert.equal(result.messages[0].content.includes('assessmentReason records the basis for the activity selected or continued by this assessment.'), mode === 'full')
    if (mode === 'full') assert.equal(result.messages[0].content.includes('the updates list may be empty'), false,
      'Full must not also receive Semi\'s permissive empty-selection contract')
    const supplied = JSON.parse(result.messages[1].content)
    assert.deepEqual(supplied.activeExecutions, [execution])
    assert.deepEqual(supplied.activeOperator.previousDecision, mode === 'full' ? previous : undefined,
      'Memory-only decisions preserve their query and attribution without adding it to Semi')
    assert.equal(JSON.stringify(supplied).includes(JSON.stringify(memory.content).slice(1, -1)), mode === 'full',
      'Switching Full to Semi does not inherit additional selected recall')
  }
  const semiPrevious = { executionId: 'semi-assessment', mode: 'semi', assessedAt: '2026-10-25T19:00:00Z', updates: [] }
  const followingFull = await robotAutonomyControllerContextNode.execute({ instruction: base, fullInstruction: full,
    activationState: { mode: 'full', operations: [], previous: semiPrevious } }, {}, {})
  assert.deepEqual(JSON.parse(followingFull.messages[1].content).activeOperator.previousDecision, semiPrevious,
    'Full retains the actual prior Semi mode without inventing an assessment reason')
  assert.ok(graph.edges.some((edge: any) => edge.source === 'intent-orchestrator' && edge.sourceHandle === 'analysis'
    && edge.target === 'recent-memories' && edge.targetHandle === 'orchestratorHints'))
  assert.ok(graph.edges.some((edge: any) => edge.source === 'context' && edge.sourceHandle === 'fullMode'
    && edge.target === 'llm' && edge.targetHandle === 'enableThinking'))
  assert.equal(graph.nodes.filter((item: any) => item.data.nodeType === 'model_router').length, 1,
    'Reasoning selection keeps one decision model call')
  assert.ok(graph.edges.some((edge: any) => edge.source === 'recent-memories' && edge.targetHandle === 'memoryContext'))
  const environment = JSON.parse(fs.readFileSync(new URL('../../../../etc/cognitive-graphs/environment-mode.json', import.meta.url), 'utf8'))
  assert.ok(environment.nodes.filter((item: any) => item.data.nodeType === 'execution_event_wait')
    .every((item: any) => item.data.properties.autonomyGraph === 'environment'))
})
