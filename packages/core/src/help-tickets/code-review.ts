import { getApprovalRequirement, getUserTrustLevel } from '../active-operator/operator-proposals.js';
import { loadBufferForUser } from '../conversation-buffer.js';
import { getPendingTechnicalTickets, recordSystemError } from './index.js';

/** The status widget's YOLO step retains adaptive_auto as its server trust level. */
export function systemCodeReviewAuthorization(username: string) {
  const trustLevel = getUserTrustLevel(username);
  const approval = getApprovalRequirement(username, 'custom');
  return { trustLevel, approval, canRepair: approval === 'auto_approve',
    access: approval === 'auto_approve' ? 'repair' as const : 'read-only' as const };
}

export function collectSystemReviewIssues(username: string) {
  for (const mode of ['system', 'conversation', 'terminal'] as const) {
    for (const entry of loadBufferForUser(username, mode).messages) {
      const meta = entry.meta ?? {};
      if (typeof meta.ticketId === 'string') continue;
      if (entry.role === 'user' && meta.severity !== 'error' && meta.type !== 'work_failure') continue;
      if (meta.severity !== 'error' && meta.type !== 'work_failure' && meta.success !== false) continue;
      const message = typeof meta.error === 'string' && meta.error ? meta.error : entry.content;
      if (!message) continue;
      recordSystemError(username, { source: String(meta.source || mode),
        eventId: String(meta.submissionId || meta.idempotencyKey || meta.taskId || `${mode}:${entry.timestamp}:${entry.content}`),
        message, occurredAt: new Date(entry.timestamp ?? Date.now()).toISOString(),
        executionId: typeof meta.relatedExecutionId === 'string' ? meta.relatedExecutionId : meta.executionId,
        taskId: meta.taskId, requestId: meta.requestId, sessionId: meta.sessionId, nodeId: meta.nodeId });
    }
  }
  return getPendingTechnicalTickets(username);
}
