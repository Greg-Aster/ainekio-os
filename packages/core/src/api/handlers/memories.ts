/**
 * Memory Handlers
 *
 * Unified handlers for memory capture and retrieval.
 * Uses withUserContext + existing core functions.
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse, badRequestResponse } from '../types.js';
import { withUserContext } from '../../context.js';
import { captureEvent } from '../../memory.js';
import { loadCognitiveMode } from '../../cognitive-mode.js';

/**
 * POST /api/capture - Capture a new memory
 */
export async function handleCapture(req: UnifiedRequest): Promise<UnifiedResponse> {
  const { content, type = 'observation', tags = [], entities = [] } = req.body || {};

  if (!content || typeof content !== 'string') {
    return badRequestResponse('Content is required');
  }

  // Determine source from request metadata or environment
  const source = req.metadata?.source || (process.env.METAHUMAN_MOBILE ? 'mobile' : 'web');

  const eventId = await withUserContext(
    { userId: req.user.userId, username: req.user.username, role: req.user.role },
    () => {
      // Get cognitive mode within user context
      const modeConfig = loadCognitiveMode();
      const cognitiveMode = modeConfig.currentMode;

      return captureEvent(content, {
        type: type as any,
        tags,
        entities,
        metadata: { source, cognitiveMode },
      });
    }
  );

  return successResponse({ success: true, eventId });
}
