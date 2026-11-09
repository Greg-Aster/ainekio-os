import fs from 'node:fs';
import path from 'node:path';
import { getProfilePaths } from '../paths.js';
import type { TrustLevel } from '../skills.js';
import { loadBufferForUser } from '../conversation-buffer.js';
import { getPendingTechnicalTickets, recordSystemError } from './index.js';

/** The status widget's YOLO step retains adaptive_auto as its server trust level. */
export function systemCodeReviewAuthorization(username: string) {
  let trustLevel: TrustLevel = 'suggest';
  try {
    const rulesPath = path.join(getProfilePaths(username).persona, 'decision-rules.json');
    if (fs.existsSync(rulesPath)) {
      trustLevel = JSON.parse(fs.readFileSync(rulesPath, 'utf-8')).trustLevel as TrustLevel;
    }
  } catch {
    // Preserve the existing policy when the profile rules cannot be read.
  }
  const approval = trustLevel === 'observe' ? 'observe_only'
    : trustLevel === 'adaptive_auto' ? 'auto_approve' : 'require_approval';
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
