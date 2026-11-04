import { getAgentCatalogSnapshot } from '../../agent-catalog.js'
import { agentTaskType } from '../../queue/agent-work-catalog.js'
import { openExecutionStore } from '../../durable-execution/storage.js'
import { autonomyActivityLimitSchema, autonomyActivityHistoryLimit, readRobotAutonomyActivity } from './autonomy-activity-history.node.js'
import { readActivationAssessments } from '../../active-operator/activation-history.js'
import { getOperatorMode } from '../../active-operator/mode-controller.js'
import { readRobotOperatorBodyConnection } from '../../robot-operator.js'
import { getQueueManager } from '../../queue/unified-queue-manager.js'
import { collectSystemReviewIssues } from '../../help-tickets/code-review.js'
import { defineNode } from '../types.js'
import {
  DEFAULT_ROBOT_AUTONOMY_TASK_IDS,
  ROBOT_AUTONOMY_EXECUTOR_TASK_ID,
  ROBOT_AUTONOMY_LIFECYCLE_TASK_IDS,
  ROBOT_AUTONOMY_TASK_OPTIONS,
  type RobotAutonomyTaskDescriptor,
} from './autonomy-task-options.js'

function configuredTaskIds(value: unknown): string[] {
  const source = Array.isArray(value) ? value : DEFAULT_ROBOT_AUTONOMY_TASK_IDS
  return [...new Set(source
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean))]
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
    const selectedIds = configuredTaskIds(properties?.taskIds)
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

    const previous = context.username ? (await readActivationAssessments(context.username, 1))[0] ?? null : null
    let activity: Awaited<ReturnType<typeof readRobotAutonomyActivity>> = []
    if (properties?.includeActivityHistory !== false && context.username) {
      const manager = getQueueManager()
      const work = [...manager.getAllTasks(), ...manager.getHistory()].filter(item => item.username === context.username
        && tasks.some(task => item.input.agentId === task.id || item.metadata?.selectedAgent === task.id))
      const store = openExecutionStore(context.username)
      try {
        activity = await readRobotAutonomyActivity(store, context.username, work,
          autonomyActivityHistoryLimit(properties?.limit), tasks.map(task => task.id))
      } finally { store.close() }
    }
    const mode = getOperatorMode()
    const activationState = {
      mode, assessedAt: new Date().toISOString(), previous,
      bodyConnection: readRobotOperatorBodyConnection(context.robotOperatorContext?.sessionId),
      localTime: new Date().toString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      systemIssues: context.username && tasks.some(task => task.id === 'system-code-review')
        ? collectSystemReviewIssues(context.username) : [],
      operations: tasks.map(task => ({
        id: task.id, name: task.name, description: task.description, kind: task.kind, activation: previous?.levels[task.id]?.activation ?? 0, activationThreshold: 100,
        lastAssessment: previous?.levels[task.id] ?? null,
        recordedActivity: activity.filter(item => item.capabilityId === task.id),
      })),
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
