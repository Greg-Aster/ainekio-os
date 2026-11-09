/**
 * Speech-to-Text (STT) API Handler
 *
 * POST /api/stt - Transcribe audio
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse } from '../types.js';
import { successResponse } from '../types.js';

// Dynamic imports
type AudioFormat = 'webm' | 'wav' | 'mp3';

let transcribeAudio: ((buf: Buffer, format: AudioFormat) => Promise<string>) | null = null;

async function ensureImports(): Promise<boolean> {
  if (transcribeAudio !== null) return true;

  try {
    const sttModule = await import('../../stt.js');
    transcribeAudio = sttModule.transcribeAudio;
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/stt
 * Body: raw binary audio (e.g., audio/webm or audio/wav)
 * Query: ?format=webm|wav|mp3 (default: webm)
 * Returns: { transcript }
 */
export async function handleStt(req: UnifiedRequest): Promise<UnifiedResponse> {
  try {
    if (!await ensureImports()) {
      return { status: 500, error: 'STT module not available' };
    }

    const format = (req.query?.format as AudioFormat) || 'webm';

    // Body should be raw binary buffer
    const buf = req.rawBody;

    if (!buf || buf.length === 0) {
      return { status: 400, error: 'Empty audio body' };
    }

    const transcript = await transcribeAudio!(buf, format);

    return successResponse({ transcript });
  } catch (error) {
    console.error('[stt] Error:', error);
    return { status: 500, error: (error as Error).message };
  }
}
