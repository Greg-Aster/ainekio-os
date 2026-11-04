/**
 * Embeddings Module
 *
 * Unified embedding system routed through the Model Router.
 * Uses the shared native llama.cpp service as the default backend.
 *
 * Architecture:
 * - Model Router resolves 'embedder' role from user profile's models.json
 * - Default provider is 'llama-cpp'; its model preset owns CPU/GPU placement
 * - Can run in parallel with GPU backends (llama.cpp, Ollama)
 * - Works on both desktop and mobile (React Native)
 *
 * Configuration comes from user profiles:
 * - profiles/{username}/etc/models.json → embedder model config
 * - Selected model endpoint or llm-backend.json → llamaCpp.endpoint for host location
 *
 * NOTE: This module does NOT use global etc/embeddings.json.
 * All configuration must come from user profile or be passed explicitly.
 */

import { embedWithLlamaCpp } from './providers/llama-cpp.js'
import { callEmbeddings, isEmbeddingServiceAvailable as checkEmbeddingAvailable } from './model-router.js'
import { getUserContext } from './context.js'
import { loadBackendConfig } from './llm-backend.js'
import { getTargetUser } from './sessions.js'

/**
 * Error thrown when embedding service is unavailable
 */
export class EmbeddingServiceError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'EmbeddingServiceError';
  }
}

const DEFAULT_EMBEDDING_MODEL = 'qwen3-embedding-0.6b';

/**
 * Check if embedding service is available
 * Re-exported from model-router for convenience
 */
export async function isEmbeddingServiceAvailable(userId?: string): Promise<boolean> {
  return checkEmbeddingAvailable(userId);
}

/**
 * Generate embedding vector for text
 *
 * Routes through the Model Router when user context is available.
 * System operations without profile context use the same native provider.
 *
 * @param text - Text to generate embedding for
 * @param opts - Options including userId for profile-based model resolution
 * @throws EmbeddingServiceError if embedding service is unavailable
 */
export async function embedText(
  text: string,
  opts: { model?: string; userId?: string } = {}
): Promise<number[]> {
  // Ensure text is a string
  const originalText = typeof text === 'string' ? text : JSON.stringify(text);

  // Try to get user context for profile-based model resolution
  const ctx = getUserContext();
  let username = ctx?.username || opts.userId;

  // If no user context, try to get target user (API trigger or most recently active)
  if (!username) {
    const activeUser = getTargetUser();
    if (activeUser) {
      username = activeUser.username;
    }
  }

  try {
    if (username) {
      const response = await callEmbeddings({ text: originalText, userId: username });
      return response.embeddings;
    }
    return await embedWithLlamaCpp(originalText, {
      model: opts.model || DEFAULT_EMBEDDING_MODEL,
      endpoint: loadBackendConfig().llamaCpp.endpoint,
    });
  } catch (error) {
    throw new EmbeddingServiceError(`Embedding request failed: ${(error as Error).message}`, error as Error);
  }
}

/**
 * Calculate cosine similarity between two embedding vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}
