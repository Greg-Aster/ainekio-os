import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import { readLoggingConfig, updateLoggingConfig } from '../../logger.js';

export async function handleGetLoggingConfig(_req: UnifiedRequest): Promise<UnifiedResponse> {
  try { return successResponse(readLoggingConfig()); }
  catch (error) {
    console.error('[logging-config] GET error:', error);
    return { status: 500, error: 'Failed to read logging config' };
  }
}

export async function handleSetLoggingConfig(req: UnifiedRequest): Promise<UnifiedResponse> {
  try { return successResponse({ success: true, config: updateLoggingConfig(req.body || {}) }); }
  catch (error) {
    console.error('[logging-config] POST error:', error);
    return { status: 500, error: 'Failed to save logging config' };
  }
}
