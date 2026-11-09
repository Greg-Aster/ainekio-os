/**
 * Audit API Handlers
 *
 * Unified handlers for reading audit logs.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import { queryAuditLog, securityCheck } from '../../audit.js';

/**
 * GET /api/audit - Read audit log for a date or run security check
 */
export async function handleGetAudit(req: UnifiedRequest): Promise<UnifiedResponse> {
  const query = req.query ?? {};

  try {
    const date = query.date || new Date().toISOString().slice(0, 10);
    const checkSecurity = query.security === 'true';

    if (checkSecurity) {
      const { issues, warnings } = securityCheck();
      return successResponse({ issues, warnings });
    }

    const limit = Number(query.limit ?? 100);
    const before = query.before === undefined ? undefined : Number(query.before);
    if (!Number.isSafeInteger(limit) || limit < 1 || before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
      return { status: 400, error: 'limit must be a positive integer and before a nonnegative byte cursor' };
    }
    return successResponse(queryAuditLog({ date, limit, before,
      category: query.category || undefined, level: query.level || undefined,
      summary: before === undefined, signal: req.signal }));
  } catch (error) {
    console.error('[audit] GET error:', error);
    return { status: 500, error: (error as Error).message };
  }
}
