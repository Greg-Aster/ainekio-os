import { submitSystemEvent } from '../buffer-admission.js'
import type { QueuedTask } from './types.js'
import type { UnifiedQueueManager } from './unified-queue-manager.js'
import { recordSystemError } from '../help-tickets/index.js'

/** Coordinator terminal receipts own notice delivery; the System Buffer owns persistence. */
export async function deliverWorkFailureNotice(task: QueuedTask, manager: UnifiedQueueManager): Promise<void> {
  if (!task.failureNoticePending) return
  const title = task.handler === 'environment.conversation' ? 'Conversation response failed' : `Work failed: ${task.handler}`
  if (task.username) recordSystemError(task.username, { source: 'work-coordinator', eventId: `work-failure:${task.id}`,
    message: task.error?.message || 'The worker reported failure without an error description.',
    occurredAt: task.completedAt || new Date().toISOString(), taskId: task.id,
    executionId: task.durable?.executionId ?? task.correlationId });
  await submitSystemEvent(task.username, `${title}\n${task.error?.message || 'The worker reported failure without an error description.'}`, {
    type: 'work_failure', source: 'work-coordinator', severity: 'error',
    taskId: task.id, handler: task.handler, resource: task.resource,
    failedAt: task.completedAt, errorCode: task.error?.code,
    relatedExecutionId: task.durable?.executionId ?? task.correlationId,
    idempotencyKey: `work-failure:${task.id}`,
  })
  manager.acknowledgeFailureNotice(task.id)
}
