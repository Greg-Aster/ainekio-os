import fs from 'node:fs';
import path from 'node:path';
import { timestamp } from './paths.js';
import { systemPaths } from './path-builder.js';
import { getUserContext } from './context.js';
import { eventBus } from './infrastructure/event-bus/index.js';
import { readLoggingConfig, updateLoggingConfig } from './logger.js';

const LOG_PREFIX = '[audit]';

/** Durable structured activity history. The event bus transports live copies. */
// Existing isolated owner tests can disable their own process without changing installation settings.
let enabledOverride: boolean | undefined;
export function setAuditEnabled(enabled: boolean): void { enabledOverride = enabled; }
export function isAuditEnabled(): boolean { return enabledOverride ?? getAuditSettings().enabled; }
export function getAuditSettings() { return readLoggingConfig().audit; }
export function configureAudit(settings: Partial<ReturnType<typeof getAuditSettings>>): void {
  updateLoggingConfig({ audit: { ...getAuditSettings(), ...settings } });
  enabledOverride = undefined;
}

/**
 * Purge audit logs older than retention period
 */
export function purgeOldAuditLogs(dryRun = false): { removed: number; spaceReclaimed: number } {
  const auditDir = path.join(systemPaths.logs, 'audit');
  const result = { removed: 0, spaceReclaimed: 0 };
  if (!fs.existsSync(auditDir)) return result;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - getAuditSettings().retentionDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  for (const file of fs.readdirSync(auditDir)) {
    const dated = /^(\d{4}-\d{2}-\d{2})\.ndjson(?:\.gz)?$/.exec(file);
    if (!dated || dated[1] >= cutoffDate) continue;
    const filename = path.join(auditDir, file);
    const size = fs.statSync(filename).size;
    if (!dryRun) fs.unlinkSync(filename);
    result.removed++;
    result.spaceReclaimed += size;
  }
  return result;
}

export interface AuditEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'critical' | 'debug';
  category: 'system' | 'decision' | 'action' | 'security' | 'data' | 'agent' | 'data_change';
  event?: string; // Event type/name (optional - can use message or action instead)
  details?: any;
  actor?: string; // 'human' | 'system' | 'agent' or specific agent/service name or username
  userId?: string; // Track which user performed the action
  action?: string; // Action being performed (for detailed audit trails)
  message?: string; // Human-readable message
  metadata?: Record<string, any>; // Additional metadata
}

/**
 * Write an audit entry to the audit log
 *
 * Automatically includes userId from current context if available.
 * One installation log retains the attributed records from every process.
 */
export function audit(entry: Omit<AuditEntry, 'timestamp'>): void {
  try {
    if (!isAuditEnabled()) return;
    // Get current user context (if any)
    const ctx = getUserContext();

    const fullEntry: AuditEntry = {
      timestamp: timestamp(),
      ...entry,
      // Auto-include userId if not explicitly provided and context exists
      userId: entry.userId ?? ctx?.userId,
    };

    const date = new Date().toISOString().slice(0, 10);
    // Use system-level audit logs for comprehensive tracking
    const logFile = path.join(systemPaths.logs, 'audit', `${date}.ndjson`);

    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(fullEntry) + '\n');

    // Publish to event bus for unified debugging
    eventBus.emit('audit', `audit.${entry.category}`, {
      ...fullEntry,
    }, {
      level: fullEntry.level === 'critical' ? 'error' : fullEntry.level,
      userId: fullEntry.userId,
      sessionId: ctx?.activeProfile,
    });
  } catch (error) {
    // Log to console but don't throw - audit failures shouldn't break operations
    // Console capture can itself call audit; report write failure directly without recursing.
    process.stderr.write(`${LOG_PREFIX} Failed to write audit entry: ${String(error)}\n`);
  }
}

interface AuditSummary {
  total: number;
  byLevel: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface AuditQuery {
  date: string;
  limit?: number;
  before?: number;
  category?: string;
  level?: string;
  match?: (entry: AuditEntry) => boolean;
  summary?: boolean;
  signal?: AbortSignal;
}

/** Reverse byte traversal keeps complete records and stable page cursors across appends. */
function* auditRecords(date: string, before?: number): Generator<{ entry: AuditEntry; offset: number }> {
  const filename = path.join(systemPaths.logs, 'audit', `${date}.ndjson`);
  let fd: number;
  try { fd = fs.openSync(filename, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    let position = Math.min(before ?? Infinity, fs.fstatSync(fd).size);
    let remainder: Buffer = Buffer.alloc(0);
    while (position > 0) {
      const start = Math.max(0, position - 64 * 1024);
      const chunk = Buffer.allocUnsafe(position - start);
      const read = fs.readSync(fd, chunk, 0, chunk.length, start);
      if (read !== chunk.length) throw new Error('Audit file changed while reading');
      const data = Buffer.concat([chunk, remainder]);
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        if (i + 1 < end) yield { entry: JSON.parse(data.subarray(i + 1, end).toString('utf8')), offset: start + i + 1 };
        end = i;
      }
      remainder = Buffer.from(data.subarray(0, end));
      position = start;
    }
    if (remainder.length) yield { entry: JSON.parse(remainder.toString('utf8')), offset: 0 };
  } finally { fs.closeSync(fd); }
}

/** One reader for viewer, agent diagnostics, training events and security summaries. */
export function queryAuditLog(query: AuditQuery) {
  query.signal?.throwIfAborted();
  const entries: AuditEntry[] = [];
  const summary: AuditSummary = { total: 0, byLevel: {}, byCategory: {} };
  let matched = 0;
  let nextCursor: number | null = null;
  let lastOffset = 0;
  for (const { entry, offset } of auditRecords(query.date, query.before)) {
    query.signal?.throwIfAborted();
    summary.total++;
    summary.byLevel[entry.level] = (summary.byLevel[entry.level] || 0) + 1;
    summary.byCategory[entry.category] = (summary.byCategory[entry.category] || 0) + 1;
    if (query.category && entry.category !== query.category || query.level && entry.level !== query.level
      || query.match && !query.match(entry)) continue;
    matched++;
    if (query.limit === undefined || entries.length < query.limit) {
      entries.push(entry);
      lastOffset = offset;
    } else {
      nextCursor = lastOffset;
      if (!query.summary) break;
    }
  }
  return { date: query.date, entries, nextCursor, ...(query.summary ? { summary, matched } : {}) };
}

/** Explicit diagnostic query; ordinary audit reads do not run security analysis. */
export function securityCheck(): { issues: AuditEntry[]; warnings: string[] } {
  const { entries: issues, summary } = queryAuditLog({ date: new Date().toISOString().slice(0, 10), summary: true,
    match: entry => entry.level === 'critical' || entry.level === 'error' || entry.category === 'security' });
  const warnings: string[] = [];
  const actionCount = summary!.byCategory.action || 0;
  if (actionCount > 100) warnings.push(`High action count: ${actionCount} actions today`);
  const errors = summary!.byLevel.error || 0;
  if (errors > 10) warnings.push(`High error rate: ${errors} errors today`);
  return { issues: issues.reverse(), warnings };
}

/**
 * Helper: Log a decision with full context
 */
export function auditDecision(decision: {
  situation: string;
  chosen: string;
  reasoning: string;
  confidence: number;
  maker: 'human' | 'system';
}): void {
  audit({
    level: 'info',
    category: 'decision',
    event: 'decision_made',
    details: decision,
    actor: decision.maker,
  });
}

/**
 * Helper: Log an action execution
 */
export function auditAction(action: {
  skill: string;
  inputs: any;
  success: boolean;
  output?: any;
  error?: string;
}): void {
  audit({
    level: action.success ? 'info' : 'warn',
    category: 'action',
    event: 'skill_executed',
    details: action,
    actor: 'system',
  });
}

/**
 * Helper: Log a security event
 */
export function auditSecurity(event: {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  details?: any;
}): void {
  const levelMap = {
    low: 'info' as const,
    medium: 'warn' as const,
    high: 'error' as const,
    critical: 'critical' as const,
  };

  audit({
    level: levelMap[event.severity],
    category: 'security',
    event: event.type,
    details: { description: event.description, ...event.details },
    actor: 'system',
  });
}

/**
 * Helper: Log data changes
 */
export function auditDataChange(change: {
  type: 'create' | 'update' | 'delete';
  resource: string;
  path: string;
  actor: string; // 'human' | 'system' | 'agent' or specific agent/service name
  details?: any;
}): void {
  audit({
    level: 'info',
    category: 'data',
    event: `data_${change.type}`,
    details: {
      resource: change.resource,
      path: change.path,
      ...change.details,
    },
    actor: change.actor,
  });
}
