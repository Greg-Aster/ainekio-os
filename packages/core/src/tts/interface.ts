/**
 * TTS Provider Interface
 * Common interface for all text-to-speech providers
 */

import type { SpeechChunkPolicy } from './speech-chunks.js';

export interface TTSSynthesizeOptions {
  /** AbortSignal for cancellation */
  signal?: globalThis.AbortSignal;
  /** Speaking rate multiplier (0.5 - 2.0) */
  speakingRate?: number;
  /** Custom voice/model identifier */
  voice?: string;
  /** Provider language code */
  langCode?: string;
  /** Correlation id retained across synthesis and playback telemetry */
  requestId?: string;
  /** Pitch shift in semitones (-12 to +12) */
  pitchShift?: number;
  /** Optional phrase chunking policy for streaming synthesis */
  chunkPolicy?: SpeechChunkPolicy;
  /** Additional provider-specific options */
  [key: string]: any;
}

export interface TTSStatus {
  provider: string;
  available: boolean;
  modelPath?: string;
  serverUrl?: string;
  cacheEnabled: boolean;
  cacheSize: number;
  cacheFiles: number;
  error?: string;
}

export interface ITextToSpeechService {
  /**
   * Synthesize text to speech
   * @param text - The text to convert to speech
   * @param options - Optional synthesis parameters
   * @returns Audio buffer (WAV format)
   */
  synthesize(text: string, options?: TTSSynthesizeOptions): Promise<Buffer>;

  /**
   * Get provider status and configuration
   */
  getStatus(): TTSStatus | Promise<TTSStatus>;

  /**
   * Clear provider cache (if applicable)
   */
  clearCache?(): void;

  /**
   * Shutdown provider and cleanup resources (if applicable)
   * For server-based providers, this stops the background server process
   */
  shutdown?(): Promise<void>;
}

export interface PiperConfig {
  binary: string;
  model: string;
  config: string;
  speakingRate: number;
  outputFormat: 'wav';
}

export interface KokoroConfig {
  langCode: string;           // Language code (e.g., 'a' for auto, 'en', 'ja', 'zh')
  voice: string;              // Built-in voice name (e.g., 'af_heart', 'af_bella')
  speed: number;              // Speaking speed multiplier (0.5-2.0, default: 1.0)
  useCustomVoicepack: boolean; // Use custom trained voicepack instead of built-in voice
  customVoicepackPath: string; // Path to custom .pt voicepack file
  normalizeCustomVoicepacks?: boolean; // Auto-normalize custom voicepack volume to -3dB peak (default: true)
  autoFallbackToPiper: boolean; // Fallback to Piper if Kokoro fails
  outputFormat: 'wav';
}

export interface TTSConfig {
  provider: 'piper' | 'kokoro';
  piper: PiperConfig;
  kokoro?: KokoroConfig;
}

export interface CacheConfig {
  enabled: boolean;
  directory: string;
  maxSizeMB: number;
}
