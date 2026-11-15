/**
 * Help Ticket System
 *
 * Manages help tickets created from negative user feedback.
 * Integrates with Lizard Brain for periodic review.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getProfilePaths } from '../path-builder.js';
import { generateId } from '../paths.js';
import { audit } from '../audit.js';
import type {
  HelpTicket,
  TicketStatus,
  TicketCategory,
  TicketPriority,
  TicketSummary,
  TicketHistoryEntry,
  HelpTicketTriggerResult,
  SystemErrorEvidence,
} from './types.js';

export * from './types.js';

const TICKETS_DIR = 'help-tickets';

interface CachedTicketFile {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  ticket: HelpTicket | null;
}

interface CachedTicketDir {
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  filenames: string[];
  files: Map<string, CachedTicketFile>;
}

const ticketDirCache = new Map<string, CachedTicketDir>();

function getOrCreateDirCache(dir: string): CachedTicketDir {
  let entry = ticketDirCache.get(dir);
  if (!entry) {
    entry = { mtimeMs: -1, ctimeMs: -1, ino: -1, filenames: [], files: new Map() };
    ticketDirCache.set(dir, entry);
  }
  return entry;
}

function cacheWrittenTicket(dir: string, filename: string, ticketPath: string, ticket: HelpTicket): void {
  try {
    const fileStat = fs.statSync(ticketPath);
    const entry = getOrCreateDirCache(dir);
    entry.files.set(filename, {
      mtimeMs: fileStat.mtimeMs,
      ctimeMs: fileStat.ctimeMs,
      size: fileStat.size,
      ino: fileStat.ino,
      ticket: structuredClone(ticket),
    });
    if (!entry.filenames.includes(filename)) {
      entry.mtimeMs = -1;
    }
  } catch {
    ticketDirCache.delete(dir);
  }
}

function readCachedTicketFile(dir: string, filename: string, entry: CachedTicketDir): HelpTicket | null {
  const filePath = path.join(dir, filename);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    entry.files.delete(filename);
    return null;
  }
  const cached = entry.files.get(filename);
  if (
    cached
    && cached.mtimeMs === stat.mtimeMs
    && cached.ctimeMs === stat.ctimeMs
    && cached.size === stat.size
    && cached.ino === stat.ino
  ) {
    return cached.ticket;
  }
  let parsed: HelpTicket | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HelpTicket;
  } catch {
    parsed = null;
  }
  entry.files.set(filename, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    ino: stat.ino,
    ticket: parsed,
  });
  return parsed;
}

export function buildSystemErrorTicketId(evidence: Pick<SystemErrorEvidence, 'source' | 'eventId'>): string {
  return `ticket-${createHash('sha256').update(JSON.stringify([evidence.source, evidence.eventId])).digest('hex')}`;
}

/**
 * Get the directory path for help tickets
 */
function getTicketsDir(username: string): string {
  const profilePaths = getProfilePaths(username);
  return path.join(profilePaths.state, TICKETS_DIR);
}

/**
 * Ensure the tickets directory exists
 */
function ensureTicketsDir(username: string): string {
  const dir = getTicketsDir(username);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Create a new help ticket from negative feedback
 */
export function createHelpTicket(
  username: string,
  feedbackComment: string | undefined,
  feedbackTargetType: 'conversation' | 'task' | 'memory',
  feedbackTargetId?: string,
): HelpTicket {
  const dir = ensureTicketsDir(username);
  const id = generateId('ticket');
  const now = new Date().toISOString();

  const ticket: HelpTicket = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'new',
    origin: 'feedback',
    feedbackRating: -1,
    feedbackComment,
    feedbackTargetType,
    feedbackTargetId,
    priority: 'medium',  // Default, may be updated during analysis
    history: [{
      timestamp: now,
      action: 'created',
      actor: 'user',
      details: {
        comment: feedbackComment,
        targetType: feedbackTargetType,
        targetId: feedbackTargetId,
      },
    }],
  };

  const filename = `${id}.json`;
  const ticketPath = path.join(dir, filename);
  fs.writeFileSync(ticketPath, JSON.stringify(ticket, null, 2));
  cacheWrittenTicket(dir, filename, ticketPath, ticket);

  audit({
    category: 'action',
    level: 'info',
    event: 'help_ticket_created',
    actor: username,
    details: {
      ticketId: id,
      targetType: feedbackTargetType,
      hasComment: !!feedbackComment,
    },
  });

  return ticket;
}

/** A source event is one issue occurrence; delivery replay preserves its identity. */
export function recordSystemError(username: string, evidence: SystemErrorEvidence): HelpTicket {
  if (!evidence.source?.trim() || !evidence.eventId?.trim() || !evidence.message?.trim()
    || !Number.isFinite(Date.parse(evidence.occurredAt))) {
    throw new Error('System error evidence requires a source, event identity, message and timestamp');
  }
  const id = buildSystemErrorTicketId(evidence);
  const previous = getTicket(username, id);
  if (previous) return previous;
  const now = new Date().toISOString();
  const ticket: HelpTicket = {
    id, origin: 'system', createdAt: now, updatedAt: now, status: 'new',
    feedbackTargetType: evidence.taskId ? 'task' : 'conversation',
    feedbackTargetId: evidence.taskId || evidence.requestId || evidence.eventId,
    category: 'system_error', priority: 'medium', errorEvidence: { ...evidence },
    history: [{ timestamp: now, action: 'system_error_recorded', actor: 'system', details: { evidence } }],
  };
  const dir = ensureTicketsDir(username);
  const filename = `${id}.json`;
  const ticketPath = path.join(dir, filename);
  fs.writeFileSync(ticketPath, JSON.stringify(ticket, null, 2));
  cacheWrittenTicket(dir, filename, ticketPath, ticket);
  return ticket;
}

export function getPendingTechnicalTickets(username: string): HelpTicket[] {
  return getPendingTickets(username).filter(ticket => ticket.category === 'system_error'
    || ticket.category === 'task_failure' || ticket.category === 'performance');
}

/**
 * Load a specific ticket
 */
export function getTicket(username: string, ticketId: string): HelpTicket | null {
  const dir = getTicketsDir(username);
  const filename = `${ticketId}.json`;
  const entry = getOrCreateDirCache(dir);
  const cached = readCachedTicketFile(dir, filename, entry);
  return cached ? structuredClone(cached) : null;
}

/**
 * Update a ticket
 */
export function updateTicket(
  username: string,
  ticketId: string,
  updates: Partial<HelpTicket>,
  actor: TicketHistoryEntry['actor'] = 'system',
  actionDescription?: string,
): HelpTicket | null {
  const ticket = getTicket(username, ticketId);
  if (!ticket) return null;

  const now = new Date().toISOString();

  // Apply updates
  const updated: HelpTicket = {
    ...ticket,
    ...updates,
    id: ticket.id,  // Never change ID
    createdAt: ticket.createdAt,  // Never change created date
    updatedAt: now,
    history: [
      ...ticket.history,
      {
        timestamp: now,
        action: actionDescription || `updated: ${Object.keys(updates).join(', ')}`,
        actor,
        details: updates,
      },
    ],
  };

  const dir = getTicketsDir(username);
  const filename = `${ticketId}.json`;
  const ticketPath = path.join(dir, filename);
  fs.writeFileSync(ticketPath, JSON.stringify(updated, null, 2));
  cacheWrittenTicket(dir, filename, ticketPath, updated);

  return updated;
}

/**
 * List all tickets for a user
 */
export function listTickets(
  username: string,
  filter?: {
    status?: TicketStatus | TicketStatus[];
    category?: TicketCategory;
    priority?: TicketPriority;
  },
): HelpTicket[] {
  const dir = getTicketsDir(username);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    ticketDirCache.delete(dir);
    return [];
  }

  const entry = getOrCreateDirCache(dir);
  if (
    entry.mtimeMs !== dirStat.mtimeMs
    || entry.ctimeMs !== dirStat.ctimeMs
    || entry.ino !== dirStat.ino
  ) {
    const filenames = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const present = new Set(filenames);
    for (const existing of entry.files.keys()) {
      if (!present.has(existing)) entry.files.delete(existing);
    }
    entry.filenames = filenames;
    entry.mtimeMs = dirStat.mtimeMs;
    entry.ctimeMs = dirStat.ctimeMs;
    entry.ino = dirStat.ino;
  }

  const statuses = filter?.status
    ? (Array.isArray(filter.status) ? filter.status : [filter.status])
    : null;
  const tickets: HelpTicket[] = [];

  for (const file of entry.filenames) {
    const ticket = readCachedTicketFile(dir, file, entry);
    if (!ticket) continue;
    if (statuses && !statuses.includes(ticket.status)) continue;
    if (filter?.category && ticket.category !== filter.category) continue;
    if (filter?.priority && ticket.priority !== filter.priority) continue;
    tickets.push(structuredClone(ticket));
  }

  // Sort by priority (critical > high > medium > low) then by date
  const priorityOrder: Record<TicketPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return tickets.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/**
 * Get tickets that need attention (for Lizard Brain trigger)
 */
export function getPendingTickets(username: string): HelpTicket[] {
  return listTickets(username, {
    status: ['new', 'reviewing', 'needs_fix', 'investigating'],
  });
}

/**
 * Get summary statistics for tickets
 */
export function getTicketSummary(username: string): TicketSummary {
  const tickets = listTickets(username);

  const byStatus: Record<TicketStatus, number> = {
    new: 0,
    reviewing: 0,
    needs_fix: 0,
    needs_training: 0,
    investigating: 0,
    resolved: 0,
    wont_fix: 0,
    duplicate: 0,
  };

  const byCategory: Record<TicketCategory, number> = {
    response_quality: 0,
    memory_issue: 0,
    personality_drift: 0,
    task_failure: 0,
    system_error: 0,
    performance: 0,
    other: 0,
  };

  const byPriority: Record<TicketPriority, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const ticket of tickets) {
    byStatus[ticket.status]++;
    byPriority[ticket.priority]++;
    if (ticket.category) {
      byCategory[ticket.category]++;
    }
  }

  const needsAttention = byStatus.new + byStatus.reviewing + byStatus.needs_fix + byStatus.investigating;

  return {
    total: tickets.length,
    byStatus,
    byCategory,
    byPriority,
    newCount: byStatus.new,
    needsAttention,
  };
}

/**
 * Check if help ticket review should run (for Lizard Brain trigger)
 */
export function shouldReviewTickets(username: string): HelpTicketTriggerResult {
  const pending = getPendingTickets(username);
  const newTickets = pending.filter(t => t.status === 'new');
  const urgentTickets = pending.filter(t =>
    t.priority === 'critical' || t.priority === 'high'
  );

  // Run if:
  // 1. Any urgent tickets exist
  // 2. More than 3 new tickets
  // 3. Any tickets older than 24 hours in 'new' status
  const oldTickets = newTickets.filter(t => {
    const age = Date.now() - new Date(t.createdAt).getTime();
    return age > 24 * 60 * 60 * 1000;  // 24 hours
  });

  const shouldRun = urgentTickets.length > 0 ||
                    newTickets.length > 3 ||
                    oldTickets.length > 0;

  let reason = 'No urgent tickets';
  if (urgentTickets.length > 0) {
    reason = `${urgentTickets.length} urgent ticket(s) need attention`;
  } else if (newTickets.length > 3) {
    reason = `${newTickets.length} new tickets accumulated`;
  } else if (oldTickets.length > 0) {
    reason = `${oldTickets.length} ticket(s) older than 24 hours`;
  }

  return {
    shouldRun,
    reason,
    ticketCount: pending.length,
    urgentCount: urgentTickets.length,
  };
}

/**
 * Mark a ticket as being reviewed
 */
export function startTicketReview(username: string, ticketId: string): HelpTicket | null {
  return updateTicket(
    username,
    ticketId,
    { status: 'reviewing' },
    'lizard_brain',
    'started review'
  );
}

/**
 * Save LLM analysis results to a ticket
 */
export function saveTicketAnalysis(
  username: string,
  ticketId: string,
  analysis: HelpTicket['llmAnalysis'],
): HelpTicket | null {
  const updates: Partial<HelpTicket> = {
    llmAnalysis: analysis,
    category: analysis?.suggestedCategory,
    priority: analysis?.suggestedPriority || 'medium',
    status: analysis?.requiresCodeChange ? 'needs_fix' :
            analysis?.requiresTrainingChange ? 'needs_training' : 'investigating',
  };

  return updateTicket(
    username,
    ticketId,
    updates,
    'lizard_brain',
    'completed analysis'
  );
}

/**
 * Resolve a ticket
 */
export function resolveTicket(
  username: string,
  ticketId: string,
  resolution: HelpTicket['resolution'],
): HelpTicket | null {
  return updateTicket(
    username,
    ticketId,
    {
      status: 'resolved',
      resolution,
    },
    'system',
    'resolved'
  );
}

/**
 * Mark a ticket as won't fix
 */
export function wontFixTicket(
  username: string,
  ticketId: string,
  reason: string,
): HelpTicket | null {
  return updateTicket(
    username,
    ticketId,
    {
      status: 'wont_fix',
      resolution: {
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'wont_fix',
        summary: reason,
      },
    },
    'lizard_brain',
    `marked as won't fix: ${reason}`
  );
}
