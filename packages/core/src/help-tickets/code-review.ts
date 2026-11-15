import fs from 'node:fs';
import path from 'node:path';
import { getProfilePaths } from '../paths.js';
import type { TrustLevel } from '../skills.js';
import { loadBufferForUser, type CanonicalBufferMode } from '../conversation-buffer.js';
import {
  buildSystemErrorTicketId,
  getPendingTechnicalTickets,
  getTicket,
  recordSystemError,
  type HelpTicket,
  type SystemErrorEvidence,
  type TicketPriority,
} from './index.js';

interface CachedBufferErrors {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  candidates: SystemErrorEvidence[];
}

const bufferErrorCache = new Map<string, CachedBufferErrors>();

const PRIORITY_ORDER: Record<TicketPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function readBufferErrorCandidates(username: string, mode: CanonicalBufferMode): SystemErrorEvidence[] {
  const bufferFile = path.join(getProfilePaths(username).state, `conversation-buffer-${mode}.json`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(bufferFile);
  } catch {
    bufferErrorCache.delete(bufferFile);
    return [];
  }
  const cached = bufferErrorCache.get(bufferFile);
  if (
    cached
    && cached.mtimeMs === stat.mtimeMs
    && cached.ctimeMs === stat.ctimeMs
    && cached.size === stat.size
    && cached.ino === stat.ino
  ) {
    return cached.candidates;
  }
  const candidates: SystemErrorEvidence[] = [];
  for (const entry of loadBufferForUser(username, mode).messages) {
    const meta = entry.meta ?? {};
    if (typeof meta.ticketId === 'string') continue;
    if (entry.role === 'user' && meta.severity !== 'error' && meta.type !== 'work_failure') continue;
    if (meta.severity !== 'error' && meta.type !== 'work_failure' && meta.success !== false) continue;
    const message = typeof meta.error === 'string' && meta.error ? meta.error : entry.content;
    if (!message) continue;
    candidates.push({
      source: String(meta.source || mode),
      eventId: String(meta.submissionId || meta.idempotencyKey || meta.taskId || `${mode}:${entry.timestamp}:${entry.content}`),
      message,
      occurredAt: new Date(entry.timestamp ?? Date.now()).toISOString(),
      executionId: typeof meta.relatedExecutionId === 'string' ? meta.relatedExecutionId : meta.executionId,
      taskId: meta.taskId,
      requestId: meta.requestId,
      sessionId: meta.sessionId,
      nodeId: meta.nodeId,
    });
  }
  bufferErrorCache.set(bufferFile, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    ino: stat.ino,
    candidates,
  });
  return candidates;
}

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

export function collectSystemReviewIssues(username: string, options?: { persist?: boolean }): HelpTicket[] {
  const persist = options?.persist !== false;
  const allCandidates: SystemErrorEvidence[] = [];
  for (const mode of ['system', 'conversation', 'terminal'] as const) {
    allCandidates.push(...readBufferErrorCandidates(username, mode));
  }
  if (persist) {
    for (const evidence of allCandidates) {
      recordSystemError(username, evidence);
    }
    return getPendingTechnicalTickets(username);
  }
  const pending = getPendingTechnicalTickets(username);
  const seenIds = new Set(pending.map(ticket => ticket.id));
  for (const evidence of allCandidates) {
    if (!evidence.source?.trim() || !evidence.eventId?.trim() || !evidence.message?.trim()
      || !Number.isFinite(Date.parse(evidence.occurredAt))) {
      continue;
    }
    const id = buildSystemErrorTicketId(evidence);
    if (seenIds.has(id) || getTicket(username, id)) continue;
    seenIds.add(id);
    pending.push({
      id,
      origin: 'system',
      createdAt: evidence.occurredAt,
      updatedAt: evidence.occurredAt,
      status: 'new',
      feedbackTargetType: evidence.taskId ? 'task' : 'conversation',
      feedbackTargetId: evidence.taskId || evidence.requestId || evidence.eventId,
      category: 'system_error',
      priority: 'medium',
      errorEvidence: { ...evidence },
      history: [{ timestamp: evidence.occurredAt, action: 'system_error_recorded', actor: 'system', details: { evidence } }],
    });
  }
  return pending.sort((a, b) => {
    const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
