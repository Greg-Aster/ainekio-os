import { defineNode } from '../types.js'
import { getQueueManager } from '../../queue/unified-queue-manager.js'
import type { QueuedTask, TaskInput } from '../../queue/types.js'
import { openExecutionStore } from '../../durable-execution/storage.js'
import type { ExecutionStore } from '../../durable-execution/store.js'
import { ExecutionCheckpointer } from '../../durable-execution/checkpointer.js'
import type { DispatchRecord, ExecutionRecord } from '../../durable-execution/types.js'
import { executionEventContext } from '../utility/execution-context.node.js'
import { readActivationAssessment } from '../../active-operator/activation-history.js'

export interface RobotAutonomyActivityRecord {
  taskId?: string
  capabilityId: string
  handler: string
  state: QueuedTask['state'] | DispatchRecord['status'] | ExecutionRecord['status']
  createdAt: string
  completedAt?: string
  correlationId?: string
  instruction?: string
  reason?: string
  observationSummary?: string
  result?: Record<string, unknown>
  executionIds?: string[]
  error?: { code: string; message: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const autonomyActivityLimitSchema = {
  type: 'slider' as const, default: 10, label: 'Task Receipt Limit',
  description: 'Maximum prior Controller-selected task receipts supplied to this decision',
  min: 1, max: 20, step: 1,
}

export function autonomyActivityHistoryLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(20, Math.trunc(parsed))) : 10
}

function selectedWork(value: unknown): value is TaskInput {
  if (!isRecord(value) || value.source !== 'autonomy') return false
  return isRecord(value.metadata) && (value.metadata.producer === 'robot-autonomy-controller'
      || value.metadata.requestedBy === 'robot-autonomy-controller')
    || isRecord(value.input) && value.input.triggeredBy === 'robot-autonomy-controller'
}

function workActivity(task: Pick<QueuedTask, 'id' | 'input' | 'metadata' | 'handler' | 'state' | 'createdAt' | 'completedAt' | 'correlationId' | 'result' | 'error'>,
  executionIds: string[], receipt?: Record<string, unknown>): RobotAutonomyActivityRecord {
  const context = isRecord(task.input.robotOperatorContext) ? task.input.robotOperatorContext : null
  const decision = task.input.plannerDecision ?? context?.controllerDecision ?? context?.plannerDecision
  const planner = isRecord(decision) ? decision : null
  const instruction = task.metadata?.decisionInstruction ?? planner?.instruction
  const reason = task.metadata?.decisionReason ?? planner?.reason
  const observed = task.metadata?.observationSummary ?? planner?.observed
  return {
    ...(task.id ? { taskId: task.id } : {}),
    capabilityId: String(task.metadata?.selectedAgent ?? task.input.agentId ?? task.handler),
    handler: task.handler, state: task.state, createdAt: task.createdAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.correlationId ? { correlationId: task.correlationId } : {}),
    ...(typeof instruction === 'string' ? { instruction } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof observed === 'string' ? { observationSummary: observed } : {}),
    executionIds,
    ...(receipt || task.result !== undefined || task.error ? { result: { workReceipt: receipt ?? {
      state: task.state, result: task.result, ...(task.error ? { error: task.error } : {}),
    } } } : {}),
    ...(task.error ? { error: task.error } : {}),
  }
}

/** Current execution facts replace initial admission claims, preserving attributed work receipts. */
function projectAutonomyActivityOutcomes(history: RobotAutonomyActivityRecord[], store: ExecutionStore) {
  const records = new Map([...new Set(history.flatMap(activity => activity.executionIds ?? []))]
    .map(executionId => [executionId, store.find(executionId)] as const))
  return history.map(activity => {
    const executions = (activity.executionIds ?? []).flatMap(executionId => {
      const record = records.get(executionId)
      if (!record) return [] // The retained receipt does not recreate a pruned execution.
      const task = store.task(executionId)
      const results = executionEventContext(store.activityResults(executionId, task?.actionId)).map(event => {
        const payload = isRecord(event.payload) ? event.payload : null
        const feedback = isRecord(payload?.feedback) ? payload.feedback : null
        return { eventId: event.eventId, executionId: event.executionId, sequence: event.sequence,
          kind: event.kind, actionId: event.actionId, workItemId: event.workItemId,
          parentEventId: event.parentEventId, receivedAt: new Date(event.createdAt).toISOString(),
          timestamp: feedback?.timestamp ?? null,
          requested: payload?.action ?? null,
          ...(feedback ? { feedback } : { result: payload?.result }) }
      })
      return [{ executionId, status: record.status, waitingReason: record.waitingReason,
        objective: task ? { objectiveId: task.objectiveId, instruction: task.instruction, source: task.source,
          updatedAt: task.updatedAt,
          objective: task.objective, completionCriteria: task.completionCriteria, decision: task.decision,
          selectedAction: task.selectedAction, actionId: task.actionId, actionStatus: task.actionStatus } : null,
        results }]
    })
    return executions.length ? { ...activity, result: {
      ...(activity.result?.decision ? { decision: activity.result.decision } : {}),
      ...(activity.result?.assessment ? { assessment: activity.result.assessment } : {}),
      ...(activity.result?.handoff ? { handoff: activity.result.handoff } : {}),
      ...(activity.result?.workReceipt ? { workReceipt: activity.result.workReceipt } : {}),
      executions,
    } } : activity
  })
}

/** One read projection over existing decisions, outbox admissions and actual results. */
export async function readRobotAutonomyActivity(store: ExecutionStore, username: string, work: QueuedTask[],
  limit: number, capabilityIds?: string[]): Promise<RobotAutonomyActivityRecord[]> {
  const supplied = new Map(work.filter(task => task.username === username).map(task => [task.id, task]))
  const activeIds = new Set(store.active(username).map(record => record.executionId))
  const activities = new Map<string, RobotAutonomyActivityRecord>()
  const reader = new ExecutionCheckpointer(store, { executionId: '', generation: 0, owner: 'read-only' })
  const accepted = (activity: RobotAutonomyActivityRecord) => !capabilityIds || capabilityIds.includes(activity.capabilityId)
  const add = (key: string, activity: RobotAutonomyActivityRecord) => { if (accepted(activity)) activities.set(key, activity) }
  const isActive = (activity: RobotAutonomyActivityRecord) => ['queued', 'leased', 'waiting', 'pending', 'admitted', 'accepted', 'outcome_unknown'].includes(activity.state)
    || activity.executionIds?.some(id => activeIds.has(id))
  const readDispatch = (dispatch: DispatchRecord, parent: ExecutionRecord) => {
    if (dispatch.kind !== 'coordinator_work' || !selectedWork(dispatch.payload)) return
    const input = dispatch.payload
    const live = dispatch.workItemId ? supplied.get(dispatch.workItemId) : undefined
    const roots = dispatch.workItemId ? store.workExecutions(username, dispatch.workItemId) : []
    const executionIds = [...new Set([
      ...(live?.graphExecutions ?? []), ...roots.map(record => record.executionId),
      ...(input.executionScope !== 'independent' ? [dispatch.executionId] : []),
    ])]
    const event = dispatch.workItemId ? store.findEvent(dispatch.executionId, `work:${dispatch.workItemId}:terminal`)
      ?? store.findEvent(dispatch.executionId, `work:${dispatch.workItemId}:undispatched`) : null
    const payload = event ? executionEventContext([event])[0].payload : null
    const receipt = isRecord(payload) && isRecord(payload.result) ? payload.result : null
    const activity = workActivity({
      id: dispatch.workItemId ?? '', input: input.input, metadata: input.metadata, handler: input.handler!,
      state: live?.state ?? receipt?.state as QueuedTask['state'] ?? dispatch.status as QueuedTask['state'],
      createdAt: live?.createdAt ?? new Date(parent.createdAt).toISOString(),
      completedAt: live?.completedAt ?? (event ? new Date(event.createdAt).toISOString() : undefined),
      correlationId: live?.correlationId ?? dispatch.executionId,
      result: live?.result ?? (receipt?.result as QueuedTask['result']),
      error: live?.error ?? receipt?.error as QueuedTask['error'],
    }, executionIds, receipt ?? undefined)
    add(dispatch.workItemId ?? dispatch.effectId, activity)
  }

  // Current work cannot be hidden by a terminal-history setting. Roots retain
  // their real parent dispatch even after their finite admission job is released.
  for (const executionId of activeIds) {
    const dispatch = store.executionWork(executionId)
    if (dispatch) readDispatch(dispatch, store.get(dispatch.executionId))
  }
  for (const task of supplied.values()) {
    if (activities.has(task.id)) continue
    if (capabilityIds ? !capabilityIds.includes(String(task.metadata?.selectedAgent ?? task.input.agentId ?? task.handler))
      : !selectedWork(task)) continue
    const executionIds = task.graphExecutions ?? (task.durable && task.durable.scope !== 'independent' ? [task.durable.executionId] : [])
    add(task.id, workActivity(task, executionIds))
  }

  for (const parent of store.iterateNodeExecutions(username, 'active_operator_dispatch', true,
    capabilityIds ? { originatingAgent: 'robot-autonomy-controller', includeExecutionEvents: true } : undefined)) {
    const entry = store.entryOrNull(parent.executionId)
    const observer = entry?.context?.robotOperatorContext?.robotObserver
    if (observer?.requestedBy !== 'robot-autonomy-controller' || observer.triggerSource !== 'autonomy') continue
    const dispatches = store.dispatches(parent.executionId)
    for (const dispatch of dispatches) readDispatch(dispatch, parent)
    const continuations = dispatches.filter(dispatch => dispatch.kind === 'execution_event'
      && isRecord(dispatch.payload) && dispatch.payload.kind === 'autonomy_trigger')
    const assessment = !capabilityIds || continuations.length ? await readActivationAssessment(reader, parent.executionId) : null
    for (const dispatch of continuations) {
      const payload = dispatch.payload as { executionId: string; kind: string }
      const update = assessment?.selected.find(item => item.target?.kind === 'execution' && item.target.executionId === payload.executionId)
      if (!update) continue
      add(dispatch.effectId, {
        capabilityId: update.operationId, handler: 'execution_event', state: dispatch.status,
        createdAt: new Date(parent.createdAt).toISOString(), instruction: update.instruction, reason: update.reason,
        executionIds: [payload.executionId], result: { handoff: {
          effectId: dispatch.effectId, sourceExecutionId: parent.executionId,
          targetExecutionId: payload.executionId, kind: payload.kind, status: dispatch.status,
        } },
      })
    }
    if (!capabilityIds && assessment) {
      add(`assessment:${parent.executionId}`, {
        capabilityId: 'workflow.robot-autonomy-controller', handler: 'workflow.robot-autonomy-controller',
        state: parent.status,
        createdAt: new Date(parent.createdAt).toISOString(),
        ...(['completed', 'failed', 'cancelled'].includes(parent.status) ? { completedAt: new Date(parent.updatedAt).toISOString() } : {}),
        executionIds: [parent.executionId], result: { assessment },
      })
    }
    const terminal = [...activities.values()].filter(activity => !isActive(activity))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (terminal.length >= limit && terminal[limit - 1].createdAt >= new Date(parent.createdAt).toISOString()) break
  }
  const ordered = [...activities.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const selected = [...ordered.filter(isActive), ...ordered.filter(activity => !isActive(activity)).slice(0, limit)]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return projectAutonomyActivityOutcomes(selected, store)
}

export const robotAutonomyActivityHistoryNode = defineNode({
  id: 'robot_autonomy_activity_history', name: 'Recent Autonomy Activity', category: 'operator', inputs: [{ name: 'availableTasks', type: 'array', optional: true, description: 'Catalog-backed operations available to Active Operator' }],
  outputs: [
    { name: 'history', type: 'array', description: 'Recent terminal tasks selected by the Full-autonomy Controller' },
    { name: 'count', type: 'number', description: 'Number of task receipts supplied' },
  ],
  properties: { limit: 10 }, propertySchemas: { limit: autonomyActivityLimitSchema },
  description: 'Reads recorded Full-autonomy decisions and selected-task outcomes from canonical execution and Work Coordinator history. It does not choose a task or schedule work.',
  async execute(inputs, context, properties) {
    const username = context.username
    if (!username) return { history: [], count: 0 }
    const store = openExecutionStore(username)
    try {
      const manager = getQueueManager()
      const history = await readRobotAutonomyActivity(store, username, [...manager.getAllTasks(), ...manager.getHistory()], autonomyActivityHistoryLimit(properties?.limit), inputs.availableTasks?.map((task: any) => task.id))
      return { history, count: history.length }
    } finally { store.close() }
  },
})
