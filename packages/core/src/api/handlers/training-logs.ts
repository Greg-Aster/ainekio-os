/**
 * Training Logs API Handler
 *
 * GET recent audit logs for training events.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import { queryAuditLog, type AuditEntry } from '../../audit.js';

/**
 * GET /api/training/logs - Get recent training audit logs
 */
export async function handleGetTrainingLogs(req: UnifiedRequest): Promise<UnifiedResponse> {
  if (!req.user.isAuthenticated) return { status: 401, error: 'Authentication required' };
  try {
    const { query } = req;
    const maxLines = Number(query?.maxLines ?? 100);
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 5000) return { status: 400, error: 'maxLines must be from 1 to 5000' };

    const logs: AuditEntry[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (const date of [today, yesterday]) {
      if (logs.length === maxLines) break;
      logs.push(...queryAuditLog({ date, limit: maxLines - logs.length, signal: req.signal, match: entry =>
        (entry.details?.username === req.user.username || entry.actor === req.user.username)
        && /^(full_cycle_|adapter_|curator_|builder_|training_)|^(dataset_prepared|samples_collected)$/.test(entry.event || '')
      }).entries);
    }
    logs.reverse();

    return successResponse({
      success: true,
      logs,
      count: logs.length,
    });
  } catch (error) {
    console.error('[training-logs] GET failed:', error);
    return {
      status: 500,
      error: (error as Error)?.message || 'Failed to load training logs',
    };
  }
}
