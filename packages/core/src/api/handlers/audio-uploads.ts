import type { UnifiedHandler } from '../types.js';
import {
  saveVoiceSample,
} from '../../voice-training.js';

interface UploadedFile {
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
}

function uploadedFile(value: unknown): UploadedFile | null {
  if (
    value &&
    typeof value === 'object' &&
    'name' in value &&
    'size' in value &&
    'buffer' in value &&
    Buffer.isBuffer((value as { buffer?: unknown }).buffer)
  ) {
    return value as UploadedFile;
  }

  return null;
}

export const handleVoiceProfileUpload: UnifiedHandler = async (req) => {
  try {
    const audioFile = uploadedFile(req.body?.audio);
    const transcript = String(req.body?.transcript || '');
    const duration = parseFloat(String(req.body?.duration));
    const quality = parseFloat(String(req.body?.quality)) || 1.0;

    if (!audioFile) {
      return { status: 400, data: { success: false, error: 'No audio file provided' } };
    }

    if (!transcript || transcript.trim().length < 10) {
      return {
        status: 400,
        data: { success: false, error: 'Transcript required (at least 10 characters)' },
      };
    }

    const format = audioFile.name.endsWith('.wav') ? 'wav' : 'webm';
    const sample = saveVoiceSample(audioFile.buffer, transcript, duration, quality, format);

    if (!sample) {
      return {
        status: 500,
        data: {
          success: false,
          error: 'Failed to save voice sample (possibly too short, low quality, or training disabled)',
        },
      };
    }


    return {
      status: 200,
      data: {
        success: true,
        sampleId: sample.id,
        audioPath: sample.audioPath,
        duration: sample.duration,
        quality: sample.quality,
        message: 'Voice sample saved successfully',
      },
    };
  } catch (error) {
    console.error('[api/voice-profile-upload] Error:', error);
    return {
      status: 500,
      data: {
        success: false,
        error: (error as Error).message,
      },
    };
  }
};
