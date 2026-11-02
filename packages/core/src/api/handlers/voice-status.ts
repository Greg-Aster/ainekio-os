/**
 * Voice Status API Handlers
 *
 * Unified handlers for voice system status.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';
import { getTTSStatus } from '../../tts.js';
import { getProfilePaths } from '../../paths.js';
import fs from 'node:fs';
import path from 'node:path';

interface TrainingMetrics {
  totalSamples: number;
  totalDuration: number;
  recentSamples: Array<{
    filename: string;
    size: number;
    created: string;
    transcript: string;
  }>;
  providers: {
    rvc: { samples: number; hasTrained: boolean };
  };
}

/**
 * GET /api/voice-status - Get voice system status including TTS and training metrics
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

    // Get voice training metrics
    let trainingMetrics: TrainingMetrics = {
      totalSamples: 0,
      totalDuration: 0,
      recentSamples: [],
      providers: {
        rvc: { samples: 0, hasTrained: false },
      },
    };

    if (user.isAuthenticated) {
      const profilePaths = getProfilePaths(username);

      // Check RVC samples
      const rvcSamplesDir = path.join(profilePaths.root, 'out/voices/rvc-samples/default');
      const rvcModelsDir = path.join(profilePaths.root, 'out/voices/rvc-models/default');

      if (fs.existsSync(rvcSamplesDir)) {
        const files = fs.readdirSync(rvcSamplesDir).filter(f => f.endsWith('.wav'));
        trainingMetrics.providers.rvc.samples = files.length;
        trainingMetrics.totalSamples += files.length;
      }

      if (fs.existsSync(rvcModelsDir)) {
        const modelFiles = fs.readdirSync(rvcModelsDir).filter(f => f.endsWith('.pth'));
        trainingMetrics.providers.rvc.hasTrained = modelFiles.length > 0;
      }
    }

    return successResponse({
      tts: ttsStatus,
      training: trainingMetrics,
      username,
    });
  } catch (error) {
    console.error('[voice-status] GET error:', error);
    return { status: 500, error: (error as Error).message };
  }
}
