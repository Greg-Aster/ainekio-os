import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Socket } from 'node:net'
import test, { mock } from 'node:test'
import type { QueuedTask, RobotOperatorRuntimeState } from '@metahuman/core'
const realSetTimeout = globalThis.setTimeout
const realNow = Date.now
const sleep = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metahuman-full-admission-'))
process.env.METAHUMAN_ROOT = root
globalThis.fetch = async () => { throw new Error('No network in admission tests') }
mock.method(Socket.prototype, 'connect', function (this: Socket) {
  queueMicrotask(() => this.destroy(Object.assign(new Error('Test transport disabled'), { code: 'ECONNREFUSED' })))
  return this
})
const core = await import('@metahuman/core')
core.setAuditEnabled(false)
const graphs = path.join(root, 'etc/cognitive-graphs')
fs.mkdirSync(graphs, { recursive: true })
fs.mkdirSync(path.join(root, 'logs/run'), { recursive: true })
const valid = fs.readFileSync(new URL('../../../etc/cognitive-graphs/robot-autonomy-controller-mode.json', import.meta.url), 'utf8')
fs.writeFileSync(path.join(graphs, 'controller-mode.json'), valid)
let mode: 'reactive' | 'semi' | 'full' = 'reactive'
let items: QueuedTask[] = []
let runtime: RobotOperatorRuntimeState | undefined
let executions: ReturnType<typeof core.activeRobotExecutions> = []
let admitted = 0
let semiAssessmentMinutes = 5
let bodyConnected = true
const configuration = { ...core.loadRobotOperatorConfig(), enabled: true }
const coreMock = mock.module('@metahuman/core', { namedExports: {
  ...core, acquireLock: () => ({ release() {} }), initGlobalLogger: () => {},
  getOperatorMode: () => mode,
  readRobotOperatorBodyConnection: () => ({ connected: bodyConnected, sessionId: 'fixture-body', robotId: 'p4',
    reason: bodyConnected ? null : 'Selected robot body is disconnected or unavailable' }),
  loadActiveOperatorConfig: () => ({ autonomyMode: mode, semiAssessmentMinutes }),
  getCurrentlyActiveUser: () => ({ username: 'fixture-owner', role: 'owner' }),
  isRobotOperatorChildEnabled: () => true, isSleepRuntimeActive: () => false,
  loadRobotOperatorConfig: () => ({ ...configuration, robotAutonomyControllerGraph: 'controller' }),
  readActiveQueueItems: () => items, activeRobotExecutions: () => executions,
  onAuthenticatedSessionChange: () => () => {},
  writeRobotOperatorRuntimeState: (value: RobotOperatorRuntimeState) => { runtime = value },
} })
const queueMock = mock.module('@metahuman/core/queue', { namedExports: {
  submitCoordinatorWork: async (input: any) => {
    const task = { ...input, id: `fixture-work-${++admitted}`, state: 'queued', createdAt: new Date().toISOString(), attempt: 0 }
    items.push(task)
    return task
  },
} })
const { run } = await import('./index.js')
async function until(predicate: () => boolean) {
  const deadline = realNow() + 3_000
  while (!predicate()) { assert.ok(realNow() < deadline, `Active Operator did not reach expected state: ${runtime?.reason}`); await sleep(10) }
}
function wakeQueue() { core.persistQueueState({ items, history: [], lastUpdated: new Date().toISOString() }) }
function setMode(value: typeof mode) {
  mode = value
  fs.writeFileSync(path.join(root, 'etc/active-operator.json'), JSON.stringify({ autonomyMode: mode, semiAssessmentMinutes }))
}
async function start() {
  const previous = process.listeners('SIGTERM')
  const running = run()
  return async () => {
    for (const handler of process.listeners('SIGTERM')) if (!previous.includes(handler)) handler.call(process, 'SIGTERM')
    await running
  }
}

test('Full continuously assesses after empty, failed and cancelled assessments while independent work proceeds; Semi retains its interval', async () => {
  let stop = await start()
  try {
    await until(() => runtime?.lifecycle === 'dormant')
    setMode('full')
    await until(() => admitted === 1)
    const first = items[0]
    assert.equal(first.handler, 'workflow.robot-autonomy-controller')
    assert.equal(first.source, 'autonomy')
    assert.equal(first.metadata?.producer, 'robot-operator')
    for (let i = 0; i < 3; i++) { wakeQueue(); await sleep(20) }
    assert.equal(admitted, 1, 'Notifications do not duplicate an in-flight assessment')
    items = []
    wakeQueue()
    await until(() => admitted === 2)
    assert.notEqual(items[0].idempotencyKey, first.idempotencyKey, 'A fresh assessment is new work, not a replay of its predecessor')
    const independent = { ...items[0], id: 'independent-motion', handler: 'environment.command', input: { agentId: 'boredom-movement' } }
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      const before = admitted
      items = [{ ...items.at(-1)!, state }, independent]
      wakeQueue()
      await until(() => admitted === before + 1)
      assert.ok(items.includes(independent), 'Selected tasks remain independent and are not cancelled or replayed')
    }
    const beforeRestart = admitted
    await stop()
    stop = await start()
    await until(() => runtime?.reason === 'Assessing operation activation')
    assert.equal(admitted, beforeRestart, 'Restart observes an already-admitted assessment')
    items = [independent]
    executions = [{ stimulusAgent: 'robot-autonomy-controller' }] as any
    wakeQueue(); await sleep(40)
    assert.equal(admitted, beforeRestart, 'A durable assessment still running has the same owner')
    executions = []
    wakeQueue(); await until(() => admitted === beforeRestart + 1)
    const offlineCount = admitted
    bodyConnected = false
    items = [independent]
    fs.writeFileSync(path.join(root, 'logs/run/environment-bridge-state.json'), '{}')
    await until(() => admitted === offlineCount + 1)
    assert.equal(runtime?.lifecycle, 'armed', 'A disconnected body does not suspend cognitive assessment')
    wakeQueue(); await sleep(30)
    assert.equal(admitted, offlineCount + 1, 'The offline assessment retains the same admission owner')
    bodyConnected = true
    fs.writeFileSync(path.join(root, 'logs/run/environment-bridge-state.json'), '{}')
    await sleep(30)
    assert.equal(admitted, offlineCount + 1, 'Reconnect does not duplicate the in-flight assessment')
    setMode('reactive'); await until(() => runtime?.lifecycle === 'dormant')
    items = []; wakeQueue(); await sleep(30)
    const semiBaseline = admitted
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: realNow() })
    setMode('semi')
    await until(() => runtime?.reason.startsWith('Periodic Semi assessment every 5 minutes') === true)
    mock.timers.tick(299_999); wakeQueue(); await sleep(30)
    assert.equal(admitted, semiBaseline)
    mock.timers.tick(1); await until(() => admitted === semiBaseline + 1)
    items = []; wakeQueue()
    await until(() => runtime?.reason.startsWith('Periodic Semi assessment every 5 minutes') === true)
    mock.timers.tick(299_999); await sleep(30)
    assert.equal(admitted, semiBaseline + 1)
    mock.timers.tick(1); await until(() => admitted === semiBaseline + 2)
    items = []; wakeQueue()
    await until(() => runtime?.reason.startsWith('Periodic Semi assessment every 5 minutes') === true)
    semiAssessmentMinutes = 1; setMode('semi')
    await until(() => runtime?.reason.startsWith('Periodic Semi assessment every 1 minutes') === true)
    mock.timers.tick(60_000); await until(() => admitted === semiBaseline + 3)
    setMode('reactive'); await until(() => runtime?.lifecycle === 'dormant')
    mock.timers.tick(600_000); await sleep(30)
    assert.equal(admitted, semiBaseline + 3)
    mock.timers.reset()
    items = []
    fs.writeFileSync(path.join(graphs, 'controller-mode.json'), '{invalid json')
    setMode('full'); await until(() => runtime?.lifecycle === 'failed')
    assert.equal(admitted, semiBaseline + 3, 'Invalid graph reports failure without admitting work')
    fs.writeFileSync(path.join(graphs, 'controller-mode.json'), valid)
    await until(() => admitted === semiBaseline + 4)
  } finally {
    await stop(); mock.timers.reset(); coreMock.restore(); queueMock.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
