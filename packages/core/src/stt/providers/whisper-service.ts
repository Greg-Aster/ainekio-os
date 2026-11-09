/**
 * Whisper STT Service Provider
 * Implements speech-to-text using faster-whisper with server support
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../path-builder.js';
import { audit } from '../../audit.js';
import { eventBus, EventTypes, generateRequestId } from '../../infrastructure/event-bus/index.js';
import {
  ensureVoiceServiceRunning,
  getVoiceServiceUrl,
  stopVoiceService,
} from '../../voice-service-manager.js';

interface WhisperServerConfig {
  useServer: boolean;
  url: string;
  autoStart: boolean;
  port: number;
}

export interface WhisperConfig {
  model: string;
  device: 'cpu' | 'cuda';
  computeType: 'int8' | 'float16' | 'float32';
  language: string;
  server: WhisperServerConfig;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  language_probability: number;
  duration?: number;
}

export class WhisperService {
  constructor(private config: WhisperConfig) {}

  /**
   * Transcribe audio buffer to text
   */
  async transcribe(audioBuffer: Buffer, audioFormat: 'wav' | 'webm' | 'mp3' = 'wav', hotwords?: string): Promise<string> {
    const requestId = generateRequestId();
    const startTime = Date.now();

    // Publish transcribe started event
    eventBus.emit('whisper', EventTypes.WHISPER_TRANSCRIBE_STARTED, {
      audioSize: audioBuffer.length,
      audioFormat,
      model: this.config.model,
      device: this.config.device,
      mode: this.config.server.useServer ? 'server' : 'cli',
    }, { requestId });

    try {
      let result: TranscriptionResult;

      // Use server mode if configured and enabled
      if (this.config.server.useServer) {
        result = await this.transcribeViaServer(audioBuffer, audioFormat, hotwords);
      } else {
        result = await this.transcribeViaCLI(audioBuffer, audioFormat, hotwords);
      }

      const duration = Date.now() - startTime;

      audit({
        level: 'info',
        category: 'action',
        event: 'stt_transcribed',
        details: {
          provider: 'whisper',
          audioSize: audioBuffer.length,
          audioFormat,
          textLength: result.text.length,
          language: result.language,
          languageProbability: result.language_probability,
          durationMs: duration,
          mode: this.config.server.useServer ? 'server' : 'cli',
          device: this.config.device,
          model: this.config.model,
        },
        actor: 'system',
      });

      // Publish transcribe completed event
      eventBus.emit('whisper', EventTypes.WHISPER_TRANSCRIBE_COMPLETED, {
        textLength: result.text.length,
        language: result.language,
        languageProbability: result.language_probability,
        model: this.config.model,
      }, { requestId, durationMs: duration });

      return result.text;
    } catch (error) {
      audit({
        level: 'error',
        category: 'action',
        event: 'stt_failed',
        details: {
          provider: 'whisper',
          error: (error as Error).message,
          mode: this.config.server.useServer ? 'server' : 'cli',
        },
        actor: 'system',
      });

      // Publish transcribe failed event
      eventBus.emit('whisper', EventTypes.WHISPER_TRANSCRIBE_FAILED, {
        error: (error as Error).message,
        model: this.config.model,
      }, { requestId, level: 'error', durationMs: Date.now() - startTime });

      throw error;
    }
  }

  /**
   * Transcribe via FastAPI server (preferred method)
   */
  private async transcribeViaServer(audioBuffer: Buffer, audioFormat: string, hotwords?: string): Promise<TranscriptionResult> {
    const serverUrl = getVoiceServiceUrl('whisper');

    // Ensure server is ready (auto-start if needed)
    const serverReady = await this._ensureServerReady();
    if (!serverReady) {
      // Check if server is loading
      try {
        const healthResponse = await fetch(`${serverUrl}/health`);
        if (healthResponse.ok) {
          const health = await healthResponse.json();
          if (health.status === 'loading') {
            throw new Error('WHISPER_LOADING: Model is still loading, please wait...');
          }
        }
      } catch (e) {
        if ((e as Error).message.startsWith('WHISPER_LOADING:')) {
          throw e;
        }
      }
      throw new Error(`Whisper server could not be started at ${serverUrl}`);
    }

    // Create form data with audio file using Node.js native File API
    const formData = new FormData();

    // Create a File object for the audio (required for FastAPI UploadFile)
    // Use Blob first to avoid Node.js/browser type incompatibility
    const blob = new Blob([audioBuffer as unknown as BlobPart], { type: `audio/${audioFormat}` });
    const file = new File([blob], `audio.${audioFormat}`, {
      type: `audio/${audioFormat}`
    });
    formData.append('file', file);
    if (hotwords) formData.append('hotwords', hotwords);

    // Make HTTP request to server with timeout
    const TRANSCRIBE_TIMEOUT_MS = 25000; // 25 seconds server-side timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${serverUrl}/transcribe?language=${this.config.language}`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`Whisper server timeout after ${TRANSCRIBE_TIMEOUT_MS}ms - server may be overloaded`);
      }
      throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      // Check if it's a "still loading" error from the server
      if (response.status === 503 && errorText.includes('still loading')) {
        throw new Error('WHISPER_LOADING: Model is still loading, please wait...');
      }
      throw new Error(`Whisper server error (${response.status}): ${errorText}`);
    }

    const result = await response.json() as TranscriptionResult;
    return result;
  }

  /**
   * Transcribe via direct Python CLI (fallback method)
   */
  private async transcribeViaCLI(audioBuffer: Buffer, audioFormat: string, hotwords?: string): Promise<TranscriptionResult> {
    const venvPython = path.join(ROOT, 'venv', 'bin', 'python3');
    if (!fs.existsSync(venvPython)) {
      throw new Error('Python venv not found. Cannot use CLI mode.');
    }

    // Save audio buffer to temp file
    const cacheDir = path.join(ROOT, 'out', 'voice-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const tempAudioFile = path.join(cacheDir, `stt_${randomUUID()}.${audioFormat}`);
    try {
      fs.writeFileSync(tempAudioFile, audioBuffer);
      // Adjust compute type for GPU
      let computeType = this.config.computeType;
      if (this.config.device === 'cuda' && computeType === 'int8') {
        computeType = 'float16';
      }

      // Call Python script to run Whisper transcription
      const pythonScript = `
from faster_whisper import WhisperModel
import sys
import json

model_name, device, compute_type, audio_file, language, hotwords = sys.argv[1:]
model = WhisperModel(model_name, device=device, compute_type=compute_type)
segments, info = model.transcribe(audio_file, language=language, hotwords=hotwords or None)

result = {
  'text': ' '.join([segment.text.strip() for segment in segments]),
  'language': info.language,
  'language_probability': info.language_probability
}

print(json.dumps(result))
`;

      const result = await new Promise<string>((resolve, reject) => {
        const proc = spawn(venvPython, ['-c', pythonScript, this.config.model, this.config.device, computeType,
          tempAudioFile, this.config.language, hotwords ?? ''], {
          cwd: ROOT,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', (data) => {
          stdout += data;
        });

        proc.stderr.on('data', (data) => {
          stderr += data;
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Whisper process exited with code ${code}: ${stderr}`));
          } else {
            resolve(stdout.trim());
          }
        });

        proc.on('error', (err) => {
          reject(err);
        });
      });

      return JSON.parse(result) as TranscriptionResult;
    } finally {
      try {
        fs.unlinkSync(tempAudioFile);
      } catch {}
    }
  }

  /**
   * Check if Whisper server is healthy
   */
  private async checkServerHealth(serverUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`${serverUrl}/health`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        return false;
      }

      // The probe includes reading the body, not just receiving headers.
      const health = await response.json();
      return health.status === 'ready';
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get service status
   */
  async getStatus(): Promise<{
    provider: string;
    available: boolean;
    model: string;
    device: string;
    computeType: string;
    serverUrl?: string;
    serverAvailable?: boolean;
    error?: string;
  }> {
    const pythonBin = path.join(ROOT, 'venv', 'bin', 'python3');
    const installed = fs.existsSync(pythonBin);

    let serverAvailable = false;
    if (this.config.server.useServer) {
      serverAvailable = await this.checkServerHealth(getVoiceServiceUrl('whisper'));
    }

    return {
      provider: 'whisper',
      available: installed && (serverAvailable || !this.config.server.useServer),
      model: this.config.model,
      device: this.config.device,
      computeType: this.config.computeType,
      serverUrl: this.config.server.useServer ? getVoiceServiceUrl('whisper') : undefined,
      serverAvailable,
      error: !installed ? 'Python venv not found. Run: pnpm install' : undefined,
    };
  }

  /**
   * Ensure Whisper server is ready, auto-starting if necessary
   */
  private async _ensureServerReady(): Promise<boolean> {
    const serverUrl = getVoiceServiceUrl('whisper');
    const available = await this.checkServerHealth(serverUrl);
    if (available) return true;

    if (this.config.server.autoStart === false) {
      return false;
    }

    try {
      const status = await ensureVoiceServiceRunning('whisper');
      return status.healthy;
    } catch (error) {
      console.error('[WhisperService] Auto-start server failed:', error);
      return false;
    }
  }

  /**
   * Stop the Whisper server
   */
  async stopServer(): Promise<void> {
    try {
      const result = await stopVoiceService('whisper');

      eventBus.emit('whisper', EventTypes.WHISPER_SERVER_STOPPED, { message: result.message });
    } catch (error) {
      console.error('[WhisperService] Failed to stop server:', error);
    }
  }
}
