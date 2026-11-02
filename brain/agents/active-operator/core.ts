import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  activeRobotExecutions, acquireLock, getOperatorMode, getCurrentlyActiveUser,
  getQueueStateDir, initGlobalLogger, isRobotOperatorChildEnabled, isSleepRuntimeActive,
  readActiveQueueItems, loadRobotOperatorConfig, onAuthenticatedSessionChange, robotOperatorChildGraph,
  loadGraphForMode, SLEEP_RUNTIME_FILE, systemPaths, writeRobotOperatorRuntimeState,
  loadActiveOperatorConfig, readRobotOperatorBodyConnection,
  type RobotOperatorChildRuntimeState, type RobotOperatorStimulusAgent,
} from '@metahuman/core'
import { submitCoordinatorWork } from '@metahuman/core/queue'

const SERVICE_ID = 'robot-operator'
const CONTROLLER = 'robot-autonomy-controller'
const CHILDREN: RobotOperatorStimulusAgent[] = [CONTROLLER, 'robot-status', 'robot-goal-review',
  'boredom-observer', 'boredom-movement', 'boredom-reflection']

export async function run(): Promise<void> {
  const lock = acquireLock('agent-robot-operator', { exitOnSignal: false })
  initGlobalLogger(SERVICE_ID)
  let stopped = false
  let checking = false
  let pending = false
  let lastTaskId: string | undefined
  let lastAdmittedAt: string | undefined
  let semiAssessmentSince = Date.now()
  let previousMode: ReturnType<typeof getOperatorMode> | undefined
  let assessmentWasActive = false
  let assessmentTimer: ReturnType<typeof setTimeout> | undefined
  const clearAssessmentTimer = () => {
    if (assessmentTimer) clearTimeout(assessmentTimer)
    assessmentTimer = undefined
  }
  const publish = (lifecycle: 'armed' | 'dormant' | 'admitting' | 'failed' | 'stopped', reason: string) => {
    const config = loadRobotOperatorConfig()
    const children = Object.fromEntries(CHILDREN.map(id => [id, {
      id, enabled: config.enabled && isRobotOperatorChildEnabled(id), handler: `workflow.${id}`,
      graph: robotOperatorChildGraph(config, id),
      ...(id === CONTROLLER ? { lastTaskId, lastAdmittedAt, lastOutcome: reason } : {}),
    }])) as Record<RobotOperatorStimulusAgent, RobotOperatorChildRuntimeState>
    writeRobotOperatorRuntimeState({ mode: getOperatorMode(), lifecycle, reason, children })
  }
  const waitForSemiAssessment = () => {
    const mode = getOperatorMode()
    if (mode !== 'semi') return false
    const minutes = loadActiveOperatorConfig().semiAssessmentMinutes
    const due = semiAssessmentSince + minutes * 60_000
    const remaining = due - Date.now()
    if (remaining <= 0) return false
    clearAssessmentTimer()
    assessmentTimer = setTimeout(() => { assessmentTimer = undefined; void assess() }, Math.min(remaining, 2_147_483_647))
    publish('armed', `Periodic Semi assessment every ${minutes} minutes; next assessment at ${new Date(due).toISOString()}`)
    return true
  }
  async function assess(): Promise<void> {
    if (stopped) return
    if (checking) { pending = true; return }
    checking = true
    clearAssessmentTimer()
    try {
      const config = loadRobotOperatorConfig()
      const mode = getOperatorMode()
      if (mode !== previousMode) {
        previousMode = mode
        semiAssessmentSince = Date.now()
      }
      if (!config.enabled || mode === 'reactive' || isSleepRuntimeActive() || !isRobotOperatorChildEnabled(CONTROLLER)) {
        semiAssessmentSince = Date.now()
        previousMode = mode
        publish('dormant', mode === 'reactive' ? 'Reactive mode' : 'Active Operator is inactive')
        return
      }
      const user = getCurrentlyActiveUser()
      if (!user || user.role !== 'owner') { semiAssessmentSince = Date.now(); publish('dormant', 'No active installation owner'); return }
      const connection = readRobotOperatorBodyConnection(config.sessionId)
      const queue = readActiveQueueItems()
      const evaluating = queue.some(task => task.username === user.username && task.handler === `workflow.${CONTROLLER}`
        && ['queued', 'leased', 'waiting'].includes(task.state))
        || activeRobotExecutions(user.username).some(execution => execution.stimulusAgent === CONTROLLER)
      if (evaluating) { assessmentWasActive = true; publish('armed', 'Assessing operation activation'); return }
      if (assessmentWasActive) { assessmentWasActive = false; semiAssessmentSince = Date.now() }
      if (waitForSemiAssessment()) return
      await loadGraphForMode(config.robotAutonomyControllerGraph, user.username)
      // Re-read mode after asynchronous graph loading; Mode Controller owns admission.
      if (stopped || getOperatorMode() === 'reactive') return
      const currentConnection = readRobotOperatorBodyConnection(connection.sessionId ?? undefined)
      if (waitForSemiAssessment()) return
      const cycleId = randomUUID()
      publish('admitting', 'Activation assessment')
      const task = await submitCoordinatorWork({ type: 'generic', handler: `workflow.${CONTROLLER}`,
        resource: 'local-llm', source: 'autonomy', priority: 'background', username: user.username,
        cognitiveMode: 'environment', input: { agentId: CONTROLLER, triggeredBy: SERVICE_ID, cycleId,
          sessionId: currentConnection.sessionId ?? undefined }, correlationId: cycleId,
        idempotencyKey: `${SERVICE_ID}:assessment:${user.username}:${cycleId}`, maxAttempts: 1,
        metadata: { producer: SERVICE_ID, childAgent: CONTROLLER, admission: 'activation-assessment' } })
      lastTaskId = task.id
      lastAdmittedAt = new Date().toISOString()
      assessmentWasActive = true
      publish('armed', 'Assessing operation activation')
    } catch (error) {
      console.error(`[${SERVICE_ID}] Activation assessment admission failed:`, error)
      publish('failed', (error as Error).message)
    } finally {
      checking = false
      if (pending) { pending = false; void assess() }
    }
  }
  const configurationVersions = new Map<string, string | null>()
  const readConfiguration = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  const configurationChanged = (file: string) => {
    const current = readConfiguration(file)
    if (configurationVersions.has(file) && configurationVersions.get(file) === current) return
    configurationVersions.set(file, current)
    void assess()
  }
  const watchFile = (file: string) => {
    configurationVersions.set(file, readConfiguration(file))
    return fs.watch(path.dirname(file), (_event, name) => {
      if (name?.toString() === path.basename(file)) configurationChanged(file)
    })
  }
  const watchers = [
    fs.watch(systemPaths.run, { recursive: true }, (_event, name) => {
      const file = name?.toString()
      if (file === 'environment-bridge-state.json' || file?.startsWith('buffer-notifications/')) void assess()
    }),
    watchFile(SLEEP_RUNTIME_FILE),
    ...['active-operator.json', 'services.json', 'agents.json'].map(file => watchFile(path.join(systemPaths.etc, file))),
    fs.watch(getQueueStateDir(), () => void assess()),
    fs.watch(path.join(systemPaths.etc, 'cognitive-graphs'), { recursive: true }, (_event, name) => {
      if (name && path.basename(name.toString()) === `${loadRobotOperatorConfig().robotAutonomyControllerGraph}-mode.json`) {
        configurationChanged(path.join(systemPaths.etc, 'cognitive-graphs', name.toString()))
      }
    }),
  ]
  const unsubscribe = onAuthenticatedSessionChange(() => { void assess() })
  let finish!: () => void
  const ended = new Promise<void>(resolve => { finish = resolve })
  const shutdown = () => { stopped = true; clearAssessmentTimer(); publish('stopped', 'Shutdown'); finish() }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  void assess()
  try { await ended } finally {
    unsubscribe()
    watchers.forEach(watcher => watcher.close())
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
    lock.release()
  }
}
export default run
