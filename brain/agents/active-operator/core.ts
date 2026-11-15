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
  let lastPublishedKey: string | undefined
  let lastBodyConnectionKey: string | undefined
  const clearAssessmentTimer = () => {
    if (assessmentTimer) clearTimeout(assessmentTimer)
    assessmentTimer = undefined
  }
  const publish = (lifecycle: 'armed' | 'dormant' | 'admitting' | 'failed' | 'stopped', reason: string) => {
    const config = loadRobotOperatorConfig()
    const mode = getOperatorMode()
    const children = Object.fromEntries(CHILDREN.map(id => [id, {
      id, enabled: config.enabled && isRobotOperatorChildEnabled(id), handler: `workflow.${id}`,
      graph: robotOperatorChildGraph(config, id),
      ...(id === CONTROLLER ? { lastTaskId, lastAdmittedAt, lastOutcome: reason } : {}),
    }])) as Record<RobotOperatorStimulusAgent, RobotOperatorChildRuntimeState>
    const key = JSON.stringify({ mode, lifecycle, reason, children })
    if (key === lastPublishedKey) return
    lastPublishedKey = key
    writeRobotOperatorRuntimeState({ mode, lifecycle, reason, children })
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
      lastBodyConnectionKey = JSON.stringify(connection)
      const queue = readActiveQueueItems()
      const evaluating = queue.some(task => task.username === user.username && task.handler === `workflow.${CONTROLLER}`
        && ['queued', 'leased', 'waiting'].includes(task.state))
        || activeRobotExecutions(user.username).some(
          execution => execution.stimulusAgent === CONTROLLER
            && (execution.waitingReason !== 'user_or_autonomy' || execution.resumePending)
        )
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
      if (stopped) return
      const config = loadRobotOperatorConfig()
      const mode = getOperatorMode()
      if (!config.enabled || mode === 'reactive' || isSleepRuntimeActive() || !isRobotOperatorChildEnabled(CONTROLLER)) {
        publish('dormant', mode === 'reactive' ? 'Reactive mode' : 'Active Operator is inactive')
        return
      }
      publish('failed', (error as Error).message)
    } finally {
      checking = false
      if (pending) { pending = false; void assess() }
    }
  }
  const watchers: fs.FSWatcher[] = []
  const watchDirectory = (dir: string, listener: fs.WatchListener<string>) => {
    fs.mkdirSync(dir, { recursive: true })
    const watcher = fs.watch(dir, listener)
    watcher.on('error', error => {
      console.error(`[${SERVICE_ID}] File watcher error for ${dir}:`, error)
    })
    watchers.push(watcher)
    return watcher
  }
  const configurationVersions = new Map<string, string | null>()
  const readConfiguration = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  const configurationChanged = (file: string) => {
    const current = readConfiguration(file)
    if (configurationVersions.has(file) && configurationVersions.get(file) === current) return
    configurationVersions.set(file, current)
    void assess()
  }
  const watchFilesInDir = (dir: string, filenames: string[]) => {
    const targets = new Map(filenames.map(name => [name, path.join(dir, name)]))
    for (const file of targets.values()) configurationVersions.set(file, readConfiguration(file))
    watchDirectory(dir, (_event, name) => {
      const target = name ? targets.get(name.toString()) : undefined
      if (target) configurationChanged(target)
    })
  }
  const bufferNotificationsDir = path.join(systemPaths.run, 'buffer-notifications')
  const cognitiveGraphsDir = path.join(systemPaths.etc, 'cognitive-graphs')
  const customGraphsDir = path.join(cognitiveGraphsDir, 'custom')
  const handleGraphChange = (dir: string): fs.WatchListener<string> => (_event, name) => {
    const filename = name?.toString()
    if (filename === `${loadRobotOperatorConfig().robotAutonomyControllerGraph}-mode.json`) {
      configurationChanged(path.join(dir, filename))
    }
  }
  watchDirectory(systemPaths.run, (_event, name) => {
    if (name?.toString() !== 'environment-bridge-state.json') return
    const config = loadRobotOperatorConfig()
    if (!config.enabled || getOperatorMode() === 'reactive' || isSleepRuntimeActive() || !isRobotOperatorChildEnabled(CONTROLLER)) return
    const currentKey = JSON.stringify(readRobotOperatorBodyConnection(config.sessionId))
    if (currentKey === lastBodyConnectionKey) return
    lastBodyConnectionKey = currentKey
    void assess()
  })
  watchDirectory(bufferNotificationsDir, () => void assess())
  watchFilesInDir(path.dirname(SLEEP_RUNTIME_FILE), [path.basename(SLEEP_RUNTIME_FILE)])
  watchFilesInDir(systemPaths.etc, ['active-operator.json', 'services.json', 'agents.json'])
  watchDirectory(getQueueStateDir(), () => void assess())
  let customGraphsWatcher: fs.FSWatcher | undefined
  if (fs.existsSync(customGraphsDir)) {
    customGraphsWatcher = watchDirectory(customGraphsDir, handleGraphChange(customGraphsDir))
  }
  watchDirectory(cognitiveGraphsDir, (event, name) => {
    if (name?.toString() === 'custom' && !customGraphsWatcher && fs.existsSync(customGraphsDir)) {
      customGraphsWatcher = watchDirectory(customGraphsDir, handleGraphChange(customGraphsDir))
    }
    handleGraphChange(cognitiveGraphsDir)(event, name)
  })
  const unsubscribe = onAuthenticatedSessionChange(() => { void assess() })
  let finish!: () => void
  const ended = new Promise<void>(resolve => { finish = resolve })
  const shutdown = () => { stopped = true; clearAssessmentTimer(); publish('stopped', 'Shutdown'); finish() }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  void assess()
  try { await ended } finally {
    unsubscribe()
    for (const watcher of watchers) {
      watcher.removeAllListeners()
      try { watcher.close() } catch {}
    }
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
    lock.release()
  }
}
export default run
