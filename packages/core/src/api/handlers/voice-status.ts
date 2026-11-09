/**
 * Voice Status API Handlers
 *
 * Unified handlers for voice system status.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import { getTTSStatus } from '../../tts.js';

/**
 * GET /api/voice-status - Get voice system status including TTS availability
 */
export async function handleGetVoiceStatus(req: UnifiedRequest): Promise<UnifiedResponse> {
  const { user } = req;

  try {
    const username = user.isAuthenticated ? user.username : 'anonymous';

    // Get TTS status (provider, server availability)
    const ttsStatus = await getTTSStatus();
    // Only log when unavailable to reduce noise
    if (!ttsStatus.available) {
      console.log('[voice-status] TTS unavailable:', ttsStatus.error || 'server not responding');
    }

    return successResponse({
      tts: ttsStatus,
      username,
    });
  } catch (error) {
    console.error('[voice-status] GET error:', error);
    return { status: 500, error: (error as Error).message };
  }
}
