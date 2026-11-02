/**
 * LLM Backend Status API Handlers
 *
 * GET LLM backend status and available backends.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 *
 * NOTE: Cloud models are now provided by the unified /api/status endpoint.
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';

// Dynamic imports
let getBackendStatus: any;
let detectAvailableBackends: any;
let loadBackendConfig: any;

async function ensureBackendFunctions(): Promise<boolean> {
  try {
    const core = await import('../../index.js');
    getBackendStatus = core.getBackendStatus;
    detectAvailableBackends = core.detectAvailableBackends;
    loadBackendConfig = core.loadBackendConfig;
    return !!(getBackendStatus && detectAvailableBackends && loadBackendConfig);
  } catch {
    return false;
  }
}

/**
 * GET /api/llm-backend/status - Get LLM backend status
 */
export async function handleGetLlmBackendStatus(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    const available = await ensureBackendFunctions();
    if (!available) {
      return { status: 501, error: 'Backend functions not available' };
    }

    const [status, availableBackends, config] = await Promise.all([
      getBackendStatus(),
      detectAvailableBackends(),
      Promise.resolve(loadBackendConfig()),
    ]);

    return successResponse({
      active: status,
      available: availableBackends,
      config: {
        activeBackend: config.activeBackend,
        llamaCpp: config.llamaCpp,
        preferredLocalBackend: config.preferredLocalBackend || 'ollama',
        ollama: {
          endpoint: config.ollama.endpoint,
          autoStart: config.ollama.autoStart,
          defaultModel: config.ollama.defaultModel,
          contextWindow: config.ollama.contextWindow,
          maxTokens: config.ollama.maxTokens,
          temperature: config.ollama.temperature,
          topP: config.ollama.topP,
          topK: config.ollama.topK,
          minP: config.ollama.minP,
          repeatPenalty: config.ollama.repeatPenalty,
          seed: config.ollama.seed,
          keepAlive: config.ollama.keepAlive,
          enableThinking: config.ollama.enableThinking,
        },
        remote: config.remote ? {
          provider: config.remote.provider,
          serverUrl: config.remote.serverUrl,
          model: config.remote.model,
        } : null,
      },
      sharedArtifacts: availableBackends.sharedArtifacts || [],
    });
  } catch (error) {
    console.error('[llm-backend-status] GET failed:', error);
    return { status: 500, error: (error as Error).message };
  }
}
