/**
 * Audit Control API Handlers
 *
 * Unified handlers for audit settings management.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import {
  isAuditEnabled,
  configureAudit,
  getAuditSettings,
  purgeOldAuditLogs,
} from '../../audit.js';

/**
 * GET /api/audit-control - Get audit settings (owner only)
 */
export async function handleGetAuditControl(req: UnifiedRequest): Promise<UnifiedResponse> {
  const { user } = req;

  if (!user.isAuthenticated) {
    return { status: 401, error: 'Authentication required' };
  }

  if (user.role !== 'owner') {
    return { status: 403, error: 'Owner role required' };
  }

  try {
    return successResponse({
      ...getAuditSettings(),
      enabled: isAuditEnabled(),
    });
  } catch (error) {
    console.error('[audit-control] GET error:', error);
    return { status: 500, error: (error as Error).message };
  }
}

/**
 * POST /api/audit-control - Update audit settings (owner only)
 */
export async function handleSetAuditControl(req: UnifiedRequest): Promise<UnifiedResponse> {
  const { user, body } = req;

  if (!user.isAuthenticated) {
    return { status: 401, error: 'Authentication required' };
  }

  if (user.role !== 'owner') {
    return { status: 403, error: 'Owner role required' };
  }

  try {
    const { enabled, retentionDays, purgeOld } = body || {};
    const settings: Parameters<typeof configureAudit>[0] = {};

    if (typeof enabled === 'boolean') {
      settings.enabled = enabled;
    }

    if (typeof retentionDays === 'number' && retentionDays > 0) {
      settings.retentionDays = retentionDays;
    }
    if (Object.keys(settings).length) configureAudit(settings);

    if (purgeOld === true) {
      purgeOldAuditLogs();
    }

    return successResponse({
      success: true,
      ...getAuditSettings(),
      enabled: isAuditEnabled(),
    });
  } catch (error) {
    console.error('[audit-control] POST error:', error);
    return { status: 500, error: (error as Error).message };
  }
}
