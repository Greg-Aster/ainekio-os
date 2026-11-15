import fs from 'node:fs'
import path from 'node:path'
import { getAgentCatalogSnapshot } from '../../agent-catalog.js'
import { agentTaskType } from '../../queue/agent-work-catalog.js'
import { openExecutionStore } from '../../durable-execution/storage.js'
import { autonomyActivityLimitSchema, autonomyActivityHistoryLimit, readRobotAutonomyActivity, type RobotAutonomyActivityRecord } from './autonomy-activity-history.node.js'
import { readActivationAssessmentsFromStore } from '../../active-operator/activation-history.js'
import type { ActivationAssessment } from '../../active-operator/activation.js'
import { getOperatorMode } from '../../active-operator/mode-controller.js'
import { loadConfig as loadActiveOperatorConfig } from '../../active-operator/state-persister.js'
import { DEFAULT_BOREDOM_INACTIVITY_MINUTES } from '../../active-operator/types.js'
import { loadBufferForUser } from '../../conversation-buffer.js'
import { getLatestEnvironmentObservation } from '../../environment-interface/store.js'
import type { EnvironmentObservation } from '../../environment-interface/types.js'
import { systemPaths } from '../../path-builder.js'
import { loadRobotOperatorConfig, readRobotOperatorBodyConnection } from '../../robot-operator.js'
import type { QueuedTask } from '../../queue/types.js'
import { getQueueManager } from '../../queue/unified-queue-manager.js'
import { collectSystemReviewIssues } from '../../help-tickets/code-review.js'
import { defineNode } from '../types.js'
import {
  BOREDOM_ENRICHMENT_TASK_IDS,
  DEFAULT_ROBOT_AUTONOMY_TASK_IDS,
  ROBOT_AUTONOMY_EXECUTOR_TASK_ID,
  ROBOT_AUTONOMY_LIFECYCLE_TASK_IDS,
  ROBOT_AUTONOMY_TASK_OPTIONS,
  type RobotAutonomyTaskDescriptor,
} from './autonomy-task-options.js'

type CachedCatalogGraphEntry = {
  source: string
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
} & ({ properties: Record<string, unknown> | undefined } | { error: Error })

const controllerCatalogGraphCache = new Map<string, CachedCatalogGraphEntry>()

function configuredTaskIds(value: unknown): string[] {
  const source = Array.isArray(value) ? value : DEFAULT_ROBOT_AUTONOMY_TASK_IDS
  return [...new Set(source
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean))]
}

function resolveAvailableAutonomyTasks(taskIdsValue: unknown): {
  tasks: RobotAutonomyTaskDescriptor[]
  unavailableTaskIds: string[]
} {
  const selectedIds = configuredTaskIds(taskIdsValue)
  const catalog = getAgentCatalogSnapshot()
  const catalogById = new Map(catalog.agents.map(agent => [agent.id, agent]))
  const tasks: RobotAutonomyTaskDescriptor[] = []
  const unavailableTaskIds: string[] = []

  for (const id of selectedIds) {
    if (id === ROBOT_AUTONOMY_EXECUTOR_TASK_ID) {
      tasks.push({
        id,
        name: 'Robot Autonomy Executor',
        description: 'Executes an already-chosen intention through the Environment workflow, including conversation, delegated computer tool use, physical actions, sensing and ongoing visual tracking. It can acquire a target from an image, configure object search, select or release a visual target, and observe tracking updates while stationary. It may also use an advertised action or generate an off-script movement. Results return through the existing task workflow; it does not decide which autonomy agent is needed.',
        kind: 'environment-executor',
        handler: 'environment.observation',
        taskType: 'environment_observation',
        priority: 'low',
        tags: ['robot', 'environment', 'embodied-action'],
      })
      continue
    }

    const agent = catalogById.get(id)
    if (!agent || agent.lifecycle === 'service' || !agent.canRun || ROBOT_AUTONOMY_LIFECYCLE_TASK_IDS.has(id)) {
      unavailableTaskIds.push(id)
      continue
    }
    tasks.push({
      id: agent.id,
      name: agent.displayName,
      description: agent.description,
      kind: 'agent',
      handler: agent.handler,
      taskType: agentTaskType(agent.id),
      priority: agent.priority,
      tags: agent.tags,
    })
  }

  return { tasks, unavailableTaskIds }
}

function buildAutonomyOperations(
  tasks: RobotAutonomyTaskDescriptor[],
  previous: ActivationAssessment | null,
  activity: RobotAutonomyActivityRecord[],
) {
  return tasks.map(task => ({
    id: task.id,
    name: task.name,
    description: task.description,
    kind: task.kind,
    activation: previous?.levels[task.id]?.activation ?? 0,
    activationThreshold: 100,
    lastAssessment: previous?.levels[task.id] ?? null,
    recordedActivity: activity.filter(item => item.capabilityId === task.id),
  }))
}

function readControllerCatalogProperties(graphKey: string): Record<string, unknown> | undefined {
  const normalizedKey = graphKey.trim().toLowerCase()
  if (!normalizedKey) {
    throw new Error('[graph-streaming] Invalid workflow cognitive-graphs: A workflow name is required')
  }
  const baseName = `${normalizedKey}-mode.json`
  const customPath = path.join(systemPaths.etc, 'cognitive-graphs', 'custom', baseName)
  const defaultPath = path.join(systemPaths.etc, 'cognitive-graphs', baseName)
  const filePath = fs.existsSync(customPath)
    ? customPath
    : fs.existsSync(defaultPath)
      ? defaultPath
      : null
  if (!filePath) {
    throw new Error(`[graph-streaming] Invalid workflow ${customPath} or ${defaultPath}: Workflow not found: ${graphKey}`)
  }
  const stat = fs.statSync(filePath)
  const cached = controllerCatalogGraphCache.get(normalizedKey)
  if (
    cached
    && cached.source === filePath
    && cached.mtimeMs === stat.mtimeMs
    && cached.ctimeMs === stat.ctimeMs
    && cached.size === stat.size
    && cached.ino === stat.ino
  ) {
    if ('error' in cached) throw cached.error
    return cached.properties ? { ...cached.properties } : undefined
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { nodes?: Array<{ data?: { nodeType?: unknown; properties?: unknown } }> }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) {
      throw new Error(`Invalid workflow graph structure in ${filePath}`)
    }
    const catalogNode = parsed.nodes.find(node => node?.data?.nodeType === 'robot_autonomy_task_catalog')
    const rawProps = catalogNode?.data?.properties
    const properties = rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps)
      ? { ...(rawProps as Record<string, unknown>) }
      : undefined
    controllerCatalogGraphCache.set(normalizedKey, {
      source: filePath,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
      ino: stat.ino,
      properties,
    })
    return properties ? { ...properties } : undefined
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    controllerCatalogGraphCache.set(normalizedKey, {
      source: filePath,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
      ino: stat.ino,
      error: failure,
    })
    throw failure
  }
}

export async function readActiveOperatorCatalogStatus(
  username: string,
  allWork: QueuedTask[],
  assessmentLimit = 12,
) {
  const properties = readControllerCatalogProperties(loadRobotOperatorConfig().robotAutonomyControllerGraph)
  const { tasks } = resolveAvailableAutonomyTasks(properties?.taskIds)
  const taskIds = new Set(tasks.map(task => task.id))
  const work = allWork.filter(item => item.username === username
    && (taskIds.has(String(item.input?.agentId ?? '')) || taskIds.has(String(item.metadata?.selectedAgent ?? ''))))
  const store = openExecutionStore(username)
  try {
    const assessments = await readActivationAssessmentsFromStore(store, username, assessmentLimit)
    const previous = assessments[0] ?? null
    const activity = await readRobotAutonomyActivity(
      store,
      username,
      work,
      autonomyActivityHistoryLimit(properties?.limit),
      tasks.map(task => task.id),
    )
    return {
      operations: buildAutonomyOperations(tasks, previous, activity),
      assessments,
    }
  } finally {
    store.close()
  }
}

function resolveBoredomInactivityMinutes(configured?: number): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_BOREDOM_INACTIVITY_MINUTES
}

export function measureSecondsSinceHumanInteraction(
  username: string | undefined,
  observation: EnvironmentObservation | undefined,
  nowMs = Date.now(),
): number | null {
  const candidates: number[] = []
  const bodyHumanSec = observation?.state?.spatialCuriosity?.secondsSinceHumanActivity
  if (typeof bodyHumanSec === 'number' && Number.isFinite(bodyHumanSec) && bodyHumanSec >= 0) {
    candidates.push(bodyHumanSec)
  }
  const normalizedUsername = typeof username === 'string' ? username.trim() : ''
  if (normalizedUsername) {
    const messages = loadBufferForUser(normalizedUsername, 'conversation').messages
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      if (entry?.role !== 'user') continue
      const rawTs = entry.timestamp as unknown
      const parsedMs = typeof rawTs === 'number' && Number.isFinite(rawTs)
        ? rawTs
        : typeof rawTs === 'string' && rawTs.trim()
          ? (Number.isFinite(Number(rawTs)) ? Number(rawTs) : Date.parse(rawTs))
          : NaN
      if (Number.isFinite(parsedMs) && parsedMs > 0) {
        candidates.push(Math.max(0, (nowMs - parsedMs) / 1000))
        break
      }
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null
}

function gateBoredomEnrichmentTasks(options: {
  tasks: RobotAutonomyTaskDescriptor[]
  unavailableTaskIds: string[]
  mode: string
  bodyConnected: boolean
  boredomInactivityMinutes: number
  secondsSinceHumanInteraction: number | null
  secondsStationary: number | null
}): { tasks: RobotAutonomyTaskDescriptor[]; unavailableTaskIds: string[] } {
  const thresholdSec = options.boredomInactivityMinutes * 60
  const allowEnrichment = options.mode === 'full' && options.bodyConnected
    ? (options.secondsSinceHumanInteraction === null || options.secondsSinceHumanInteraction >= thresholdSec)
      && (options.secondsStationary ?? 0) >= thresholdSec
    : !(options.secondsSinceHumanInteraction !== null && options.secondsSinceHumanInteraction < thresholdSec)

  if (allowEnrichment) {
    return { tasks: options.tasks, unavailableTaskIds: options.unavailableTaskIds }
  }

  const gatedTasks: RobotAutonomyTaskDescriptor[] = []
  const unavailable = [...options.unavailableTaskIds]
  for (const task of options.tasks) {
    if (BOREDOM_ENRICHMENT_TASK_IDS.has(task.id)) {
      if (!unavailable.includes(task.id)) unavailable.push(task.id)
    } else {
      gatedTasks.push(task)
    }
  }
  return { tasks: gatedTasks, unavailableTaskIds: unavailable }
}

export const robotAutonomyTaskCatalogNode = defineNode({
  id: 'robot_autonomy_task_catalog',
  name: 'Available Autonomy Tasks',
  category: 'operator',
  inputs: [],
  outputs: [
    { name: 'activationState', type: 'object' },
    { name: 'memoryHints', type: 'object', description: 'Memory selection recorded by the previous assessment.' },
    { name: 'tasks', type: 'array', description: 'Configured tasks that are currently executable, with their Agent Catalog descriptions' },
    { name: 'taskIds', type: 'array', description: 'Identifiers of the currently available tasks' },
    { name: 'unavailableTaskIds', type: 'array', description: 'Configured tasks that are missing, disabled, or not executable' },
    { name: 'count', type: 'number', description: 'Number of tasks currently available to the controller' },
  ],
  properties: {
    taskIds: [...DEFAULT_ROBOT_AUTONOMY_TASK_IDS],
    limit: 10,
    includeActivityHistory: true,
  },
  propertySchemas: {
    limit: autonomyActivityLimitSchema,
    includeActivityHistory: { type: 'boolean', label: 'Include Activity History', default: true, description: 'Whether recorded autonomous activity was selected.' },
    taskIds: {
      type: 'multiselect',
      default: [...DEFAULT_ROBOT_AUTONOMY_TASK_IDS],
      label: 'Available Tasks',
      description: 'Operations the Active Operator may select in Semi or Full mode. Names, descriptions, handlers, and current availability come from the canonical Agent Catalog.',
      options: ROBOT_AUTONOMY_TASK_OPTIONS,
    },
  },
  description: 'Loads the configured Active Operator operations from the canonical Agent Catalog. It advertises capabilities to the LLM but does not choose or start a task.',
  async execute(_inputs, context, properties) {
    const resolved = resolveAvailableAutonomyTasks(properties?.taskIds)
    const boredomInactivityMinutes = resolveBoredomInactivityMinutes(loadActiveOperatorConfig().boredomInactivityMinutes)
    const mode = getOperatorMode()
    const bodyConnection = readRobotOperatorBodyConnection(context.robotOperatorContext?.sessionId)
    const observation = getLatestEnvironmentObservation(bodyConnection.sessionId ?? undefined)
    const secondsSinceHumanInteraction = measureSecondsSinceHumanInteraction(context.username, observation)
    const rawStationary = observation?.state?.spatialCuriosity?.secondsStationary
    const secondsStationary = typeof rawStationary === 'number' && Number.isFinite(rawStationary) && rawStationary >= 0
      ? rawStationary
      : null
    const { tasks, unavailableTaskIds } = gateBoredomEnrichmentTasks({
      tasks: resolved.tasks,
      unavailableTaskIds: resolved.unavailableTaskIds,
      mode,
      bodyConnected: bodyConnection.connected === true,
      boredomInactivityMinutes,
      secondsSinceHumanInteraction,
      secondsStationary,
    })
    let previous: ActivationAssessment | null = null
    let activity: Awaited<ReturnType<typeof readRobotAutonomyActivity>> = []
    if (context.username) {
      const store = openExecutionStore(context.username)
      try {
        previous = (await readActivationAssessmentsFromStore(store, context.username, 1))[0] ?? null
        if (properties?.includeActivityHistory !== false) {
          const manager = getQueueManager()
          const taskIdSet = new Set(tasks.map(task => task.id))
          const work = [...manager.getAllTasks(), ...manager.getHistory()].filter(item => item.username === context.username
            && (taskIdSet.has(String(item.input?.agentId ?? '')) || taskIdSet.has(String(item.metadata?.selectedAgent ?? ''))))
          activity = await readRobotAutonomyActivity(store, context.username, work,
            autonomyActivityHistoryLimit(properties?.limit), tasks.map(task => task.id))
        }
      } finally { store.close() }
    }
    const activationState = {
      mode, assessedAt: new Date().toISOString(), previous,
      bodyConnection,
      inactivity: {
        boredomInactivityMinutes,
        secondsSinceHumanInteraction,
        secondsStationary,
      },
      localTime: new Date().toString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      systemIssues: context.username && tasks.some(task => task.id === 'system-code-review')
        ? collectSystemReviewIssues(context.username, { persist: Boolean(context.graphExecution) }) : [],
      operations: buildAutonomyOperations(tasks, previous, activity),
    }
    return {
      activationState,
      memoryHints: mode === 'full' && previous?.memoryRequest ? { needsMemory: true, ...previous.memoryRequest } : { needsMemory: false },
      tasks,
      taskIds: tasks.map(task => task.id),
      unavailableTaskIds,
      count: tasks.length,
    }
  },
})
