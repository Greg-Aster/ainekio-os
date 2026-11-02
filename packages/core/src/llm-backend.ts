/**
 * LLM Backend Manager
 *
 * Manages backend selection and status. Externally managed llama.cpp servers keep their own process lifecycle.
 * This is separate from cloud providers (RunPod, HuggingFace), which are
 * managed by the Core provider layer.
 *
 * Local backends: Run on the user's machine, toggled in Settings UI
 * Server providers: Cloud services for deployment, controlled by etc/deployment.json
 */

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ROOT } from './path-builder.js';
import type { ModelRole } from './model-roles.js';
import { audit } from './audit.js';
import { DEFAULT_LLAMA_CPP_CONFIG, getLlamaCppStatus, validateLlamaCppConfig, type LlamaCppConfig } from './providers/llama-cpp.js';
import { ollama, isRunning as isOllamaRunning, startOllamaService } from './ollama.js';
import { isLocalModelServiceRunning, getLocalModelStatus } from './providers/local-models.js';
import {
  listLocalModelArtifacts,
  resolveLocalModelArtifact,
  type LocalModelArtifact,
} from './model-artifacts.js';
import { DEFAULT_OLLAMA_CHAT_MODEL, } from './model-defaults.js';
import { getCurrentlyActiveUser, onAuthenticatedSessionChange } from './sessions.js';

const LOG_PREFIX = '[llm-backend]';

// ============================================================================
// Types
// ============================================================================

/**
 * Backend types:
 * - 'ollama': Managed local LLM backends
 * - 'llama-cpp': An externally managed llama-server
 * - 'local-models': Bundled node-llama-cpp embedding/text service
 * - 'remote': Cloud provider (RunPod, Claude, OpenRouter, OpenAI)
 * - 'auto': Intelligent selection - prefer local if available, fallback to remote
 */
export type BackendType = 'llama-cpp' | 'ollama' | 'local-models' | 'remote' | 'auto';

/** Local backend type (for when using 'auto' or 'remote' with local fallback) */
export type LocalBackendType = 'llama-cpp' | 'ollama' | 'local-models';

/** Remote provider types supported */
export type RemoteProviderType = 'claude' | 'runpod' | 'openrouter' | 'openai' | 'server';

export interface OllamaBackendConfig {
  endpoint: string;
  autoStart: boolean;
  defaultModel: string;
  /** Default context window used when a model/graph does not override it. */
  contextWindow: number;
  /** Default maximum generated tokens used when a model/graph does not override it. */
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  /** Null keeps Ollama's normal non-deterministic seed behavior. */
  seed: number | null;
  /** How long Ollama should keep model weights loaded after a request. */
  keepAlive: string;
  /** Enable provider-native reasoning when a model/graph does not override it. */
  enableThinking: boolean;
}

export interface RemoteBackendConfig {
  /** Active remote provider */
  provider: RemoteProviderType;
  /** Remote server URL (for 'server' provider - e.g., Cloudflare tunnel to desktop) */
  serverUrl?: string;
  /** Default model for remote provider */
  model?: string;
  /** Saved credentials for remote server authentication (session-based, secure) */
  credentials?: {
    username?: string;
    /** Session ID from remote server login (mh_session cookie value) */
    sessionId?: string;
  };
}

export interface LocalModelsBackendConfig {
  /** Whether local-models backend is enabled */
  enabled: boolean;
  /** Service endpoint URL */
  endpoint: string;
  /** Auto-start the service on boot */
  autoStart: boolean;
  /** Only download models when connected to WiFi */
  downloadOnWifiOnly: boolean;
  /** Embedding model configuration */
  embeddings: {
    model: string;
  };
  /** Small LLM model configuration */
  llm: {
    model: string;
  };
}

export interface BackendConfig {
  activeBackend: BackendType;
  llamaCpp: LlamaCppConfig;
  /** Preferred local backend when using 'auto' mode */
  preferredLocalBackend?: LocalBackendType;
  ollama: OllamaBackendConfig;
  /** Remote/cloud provider configuration */
  remote?: RemoteBackendConfig;
  /** Bundled local-model service configuration */
  localModels?: LocalModelsBackendConfig;
}

export interface BackendStatus {
  /** Configured backend type */
  backend: BackendType;
  /** Actual active backend (resolved from 'auto') */
  resolvedBackend: 'llama-cpp' | 'ollama' | 'local-models' | 'remote' | 'offline';
  /** Remote provider if using remote */
  remoteProvider?: RemoteProviderType;
  running: boolean;
  model?: string;
  artifact?: LocalModelArtifact;
  artifactError?: string;
  endpoint?: string;
  health: 'healthy' | 'starting' | 'degraded' | 'offline';
  /** Why this backend was selected (for 'auto' mode) */
  reason?: string;
}

export interface AvailableBackends {
  llamaCpp: { configured: boolean; running: boolean; model?: string; error?: string };
  ollama: { installed: boolean; running: boolean; model?: string };
  localModels: { installed: boolean; running: boolean; embeddingModel?: string; llmModel?: string };
  remote: { configured: boolean; provider?: RemoteProviderType; hasCredentials: boolean };
  sharedArtifacts?: LocalModelArtifact[];
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_PATH = path.join(ROOT, 'etc', 'llm-backend.json');

let cachedConfig: BackendConfig | null = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Load backend configuration
 */
export function loadBackendConfig(forceFresh = false): BackendConfig {
  const now = Date.now();

  if (!forceFresh && cachedConfig && now - cacheTime < CACHE_TTL) {
    return cachedConfig;
  }

  const defaultConfig: BackendConfig = {
    activeBackend: 'ollama',
    llamaCpp: { ...DEFAULT_LLAMA_CPP_CONFIG },
    ollama: {
      endpoint: 'http://localhost:11434',
      autoStart: false,
      defaultModel: DEFAULT_OLLAMA_CHAT_MODEL,
      contextWindow: 8192,
      maxTokens: 2048,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0,
      repeatPenalty: 1.1,
      seed: null,
      keepAlive: '5m',
      enableThinking: false,
    },
    localModels: {
      enabled: true,
      endpoint: 'http://127.0.0.1:4324',
      autoStart: false,
      downloadOnWifiOnly: true,
      embeddings: {
        model: 'qwen3-embedding-0.6b',
      },
      llm: {
        model: 'qwen3-1.7b',
      },
    },
  };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      // Deep merge to ensure all default fields are present
      cachedConfig = {
        ...defaultConfig,
        ...parsed,
        llamaCpp: { ...defaultConfig.llamaCpp, ...parsed.llamaCpp },
        ollama: { ...defaultConfig.ollama, ...parsed.ollama },
        localModels: { ...defaultConfig.localModels, ...parsed.localModels },
      };
    } else {
      cachedConfig = defaultConfig;
    }
  } catch (error) {
    console.error('[llm-backend] Error loading config:', error);
    cachedConfig = defaultConfig;
  }

  cacheTime = now;
  return cachedConfig!;
}

/**
 * Save backend configuration
 */
export function saveBackendConfig(updates: Partial<BackendConfig>): void {
  const config = loadBackendConfig(true);
  const newConfig = { ...config, ...updates };

  if (updates.llamaCpp) newConfig.llamaCpp = { ...config.llamaCpp, ...updates.llamaCpp };
  if (updates.llamaCpp || newConfig.activeBackend === 'llama-cpp') validateLlamaCppConfig(newConfig.llamaCpp);

  // Merge nested objects
  if (updates.ollama) {
    newConfig.ollama = { ...config.ollama, ...updates.ollama };
  }
  if (updates.remote) {
    newConfig.remote = { ...config.remote, ...updates.remote };
  }
  if (updates.localModels) {
    newConfig.localModels = { ...config.localModels, ...updates.localModels };
  }

  // Keep the manual backend auto-start preference aligned with selection.
  // Authenticated startup independently resolves the profile's assigned models.
  if (newConfig.activeBackend === 'ollama') {
    newConfig.ollama = { ...newConfig.ollama, autoStart: true };
  } else if (newConfig.activeBackend === 'remote' || newConfig.activeBackend === 'local-models' || newConfig.activeBackend === 'llama-cpp') {
    newConfig.ollama = { ...newConfig.ollama, autoStart: false };
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
  cachedConfig = newConfig;
  cacheTime = Date.now();
}

/**
 * Get the currently active backend type
 */
export function getActiveBackend(): BackendType {
  return loadBackendConfig().activeBackend;
}

// ============================================================================
// Status & Detection
// ============================================================================

/**
 * Get status of the active backend
 */
export async function getBackendStatus(): Promise<BackendStatus> {
  return configuredBackendStatus(loadBackendConfig());
}

async function configuredBackendStatus(config: BackendConfig): Promise<BackendStatus> {
  const backend = config.activeBackend;

  // Handle 'auto' mode - resolve to actual backend
  if (backend === 'auto') {
    return resolveAutoBackend(config);
  }

  if (backend === 'llama-cpp') return llamaCppBackendStatus(config);

  // Handle 'remote' mode
  if (backend === 'remote') {
    const remoteConfig = config.remote;
    return {
      backend: 'remote',
      resolvedBackend: 'remote',
      remoteProvider: remoteConfig?.provider,
      running: true, // Remote is always "running" if configured
      model: remoteConfig?.model,
      endpoint: remoteConfig?.serverUrl,
      health: remoteConfig?.provider ? 'healthy' : 'offline',
      reason: 'Configured for remote provider',
    };
  }

  if (backend === 'ollama') {
    ollama.setEndpoint(config.ollama.endpoint);
    const running = await isOllamaRunning();
    let model: string | undefined;
    const artifactResolution = resolveLocalModelArtifact(config.ollama.defaultModel, 'ollama');

    if (running) {
      try {
        const result = await ollama.getRunningModels();
        model = result.models[0]?.name;
      } catch { }
    }

    return {
      backend: 'ollama',
      // If not running, resolve to 'offline' so UI shows correct status
      resolvedBackend: running ? 'ollama' : 'offline',
      running,
      model: model || config.ollama.defaultModel,
      artifact: artifactResolution.artifact,
      artifactError: artifactResolution.error,
      endpoint: config.ollama.endpoint,
      health: running ? 'healthy' : 'offline',
      // Provide helpful reason when backend is unavailable
      reason: running ? undefined : 'Ollama server is not running. Configure a different LLM backend in Settings.',
    };
  }

  if (backend === 'local-models') {
    const localModelsConfig = config.localModels;
    const endpoint = localModelsConfig?.endpoint || 'http://127.0.0.1:4324';
    const running = await isLocalModelServiceRunning(endpoint);
    let model: string | undefined;

    if (running) {
      try {
        const status = await getLocalModelStatus(endpoint);
        // Report the LLM model if loaded, otherwise the embedding model
        model = status?.generator?.model || status?.embedder?.model || undefined;
      } catch { }
    }

    return {
      backend: 'local-models',
      resolvedBackend: running ? 'local-models' : 'offline',
      running,
      model,
      endpoint,
      health: running ? 'healthy' : 'offline',
      reason: running ? undefined : 'Local model service is not running. Enable auto-start in Settings.',
    };
  }

  return { backend, resolvedBackend: 'offline', running: false, health: 'offline',
    reason: `Unsupported backend: ${backend}` };
}

async function llamaCppBackendStatus(config: BackendConfig): Promise<BackendStatus> {
  const status = await getLlamaCppStatus(config.llamaCpp);
  return {
    backend: 'llama-cpp', resolvedBackend: status.running ? 'llama-cpp' : 'offline',
    running: status.running, model: config.llamaCpp.model, endpoint: config.llamaCpp.endpoint,
    health: status.running ? 'healthy' : 'offline', reason: status.error,
  };
}

/**
 * Resolve 'auto' backend to actual backend based on availability
 *
 * Priority:
 * 1. Preferred local backend if running
 * 2. Any local backend if running
 * 3. Remote provider if configured
 * 4. Offline
 */
async function resolveAutoBackend(config: BackendConfig): Promise<BackendStatus> {
  const preferredLocal = config.preferredLocalBackend || 'ollama';

  const candidates = [...new Set<LocalBackendType>([preferredLocal, 'ollama', 'llama-cpp'])];
  for (const candidate of candidates) {
    if (candidate === 'llama-cpp' && !config.llamaCpp.model) continue;
    const status = await configuredBackendStatus({ ...config, activeBackend: candidate });
    if (status.running) {
      return { ...status, backend: 'auto', reason: `${candidate} is running${candidate === preferredLocal ? ' (preferred local backend)' : ''}` };
    }
  }

  // No local backend available - check remote
  if (config.remote?.provider) {
    return {
      backend: 'auto',
      resolvedBackend: 'remote',
      remoteProvider: config.remote.provider,
      running: true,
      model: config.remote.model,
      endpoint: config.remote.serverUrl,
      health: 'healthy',
      reason: `No local LLM available, using remote (${config.remote.provider})`,
    };
  }

  // Nothing available
  return {
    backend: 'auto',
    resolvedBackend: 'offline',
    running: false,
    health: 'offline',
    reason: 'No local LLM running and no remote provider configured',
  };
}

/**
 * Detect which backends are available on this system
 */
export async function detectAvailableBackends(): Promise<AvailableBackends> {
  const config = loadBackendConfig();
  ollama.setEndpoint(config.ollama.endpoint);

  const localModelsEndpoint = config.localModels?.endpoint || 'http://127.0.0.1:4324';

  const [ollamaRunning, localModelsRunning, llamaCpp] = await Promise.all([
    isOllamaRunning(),
    isLocalModelServiceRunning(localModelsEndpoint),
    getLlamaCppStatus(config.llamaCpp),
  ]);

  // Check if Ollama is installed (by checking if it's running or if ollama command exists)
  let ollamaInstalled = ollamaRunning;
  if (!ollamaInstalled) {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('which', ['ollama'], { stdio: 'ignore', timeout: 2000 });
      ollamaInstalled = true;
    } catch {
      ollamaInstalled = false;
    }
  }

  // Local models is always "installed" (it's a Node.js service)
  const localModelsInstalled = true;

  // Get loaded models if running
  let ollamaModel: string | undefined;
  let localModelsEmbedding: string | undefined;
  let localModelsLLM: string | undefined;

  if (ollamaRunning) {
    try {
      const result = await ollama.getRunningModels();
      ollamaModel = result.models[0]?.name;
    } catch { }
  }

  if (localModelsRunning) {
    try {
      const status = await getLocalModelStatus(localModelsEndpoint);
      localModelsEmbedding = status?.embedder?.model || undefined;
      localModelsLLM = status?.generator?.model || undefined;
    } catch { }
  }

  // Check remote configuration
  const remoteConfigured = !!config.remote?.provider;
  // Note: Credentials checked during actual LLM call, not at backend switch time
  const hasCredentials = remoteConfigured; // For now, assume configured = has credentials

  return {
    llamaCpp: { configured: !!config.llamaCpp.model, ...llamaCpp, model: config.llamaCpp.model || undefined },
    ollama: { installed: ollamaInstalled, running: ollamaRunning, model: ollamaModel },
    localModels: { installed: localModelsInstalled, running: localModelsRunning, embeddingModel: localModelsEmbedding, llmModel: localModelsLLM },
    remote: { configured: remoteConfigured, provider: config.remote?.provider, hasCredentials },
    sharedArtifacts: listLocalModelArtifacts(),
  };
}

// ============================================================================
// Backend Switching
// ============================================================================

/**
 * Switch to a different backend
 *
 * Updates backend selection. Serving processes retain their existing owners.
 */
export async function switchBackend(
  to: BackendType,
  options?: {
    actor?: string;
  }
): Promise<{ success: boolean; error?: string }> {
  const config = loadBackendConfig();
  const from = config.activeBackend;

  if (from === to) {
    return { success: true };
  }

  if (to === 'llama-cpp') {
    const status = await getLlamaCppStatus(config.llamaCpp);
    if (!status.running) return { success: false, error: status.error };
  }

  console.log(`[llm-backend] Switching from ${from} to ${to}`);

  try {
    // Update configuration
    saveBackendConfig({ activeBackend: to });

    // Audit the switch
    audit({
      level: 'info',
      category: 'system',
      event: 'backend_switch',
      actor: options?.actor || 'system',
      details: { from, to },
    });

    console.log(`[llm-backend] Successfully switched to ${to}`);
    return { success: true };

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[llm-backend] Switch failed:`, message);
    return { success: false, error: message };
  }
}

/**
 * Auto-select the best available backend
 */
export async function autoSelectBackend(): Promise<BackendType> {
  const available = await detectAvailableBackends();

  if (available.llamaCpp.running && loadBackendConfig().preferredLocalBackend === 'llama-cpp') return 'llama-cpp';

  // If Ollama is running, use it
  if (available.ollama.running) {
    return 'ollama';
  }

  if (available.llamaCpp.running) return 'llama-cpp';

  // Neither running - check what's installed, prefer Ollama (simpler)
  if (available.ollama.installed) {
    return 'ollama';
  }

  // Default to Ollama
  return 'ollama';
}

/**
 * Ensure the active backend is running
 */
export async function ensureBackendRunning(
  options: { forceStart?: boolean; } = {},
): Promise<{ running: boolean; error?: string }> {
  const config = loadBackendConfig();
  const backend = config.activeBackend;
  const forceStart = options.forceStart === true;

  if (backend === 'llama-cpp') return getLlamaCppStatus(config.llamaCpp);

  async function startConfiguredBackend(): Promise<{ running: boolean; error?: string }> {
    const result = await startOllamaService();
    return result.success ? { running: true } : { running: false, error: result.error };
  }

  if (backend === 'auto') {
    const status = await resolveAutoBackend(config);
    if (status.running) {
      return { running: true };
    }

    const preferred = config.preferredLocalBackend || 'ollama';
    if (preferred === 'ollama' && (forceStart || config.ollama.autoStart)) {
      return startConfiguredBackend();
    }
    if (preferred !== 'ollama' && config.ollama.autoStart) {
      return startConfiguredBackend();
    }

    return {
      running: false,
      error: status.reason || 'No local LLM running and no auto-start backend is enabled.',
    };
  }

  if (backend === 'remote') {
    return config.remote?.provider
      ? { running: true }
      : { running: false, error: 'Remote backend is not configured.' };
  }

  if (backend === 'local-models') {
    const endpoint = config.localModels?.endpoint || 'http://127.0.0.1:4324';
    const running = await isLocalModelServiceRunning(endpoint);
    return running
      ? { running: true }
      : { running: false, error: 'Local model service is not running.' };
  }

  if (backend === 'ollama') {
    const running = await isOllamaRunning();
    if (!running) {
      if (forceStart || config.ollama.autoStart) {
        return startConfiguredBackend();
      }

      return {
        running: false,
        error: 'Ollama is not running. Start it with: ollama serve',
      };
    }
    return { running: true };
  }

  return { running: false, error: `Unsupported backend: ${backend}` };
}

/** Start serving endpoints selected by the same profile/mode resolver as Status and inference. */
export async function startAssignedModelServices(username: string, roles?: ModelRole[]): Promise<void> {
  const { resolveAssignedModels } = await import('./model-resolver.js');
  const { readRecordedCognitiveMode } = await import('./cognitive-mode.js');
  const selected = resolveAssignedModels(username, readRecordedCognitiveMode(username), roles);
  const config = loadBackendConfig();
  const llamaModels = selected.filter(model => model.provider === 'llama-cpp').map(model => ({
    endpoint: model.options.endpoint ?? config.llamaCpp.endpoint, model: model.model,
  }));
  if (llamaModels.length) {
    await promisify(execFile)(path.join(ROOT, 'bin/llama-cpp-services'), ['start', JSON.stringify(llamaModels)]);
  }
  if (selected.some(model => model.provider === 'ollama') && !await isOllamaRunning()) {
    const result = await startOllamaService();
    if (!result.success) throw new Error(result.error || 'Selected Ollama service failed to start');
  }
}

/** Attach model startup to the existing storage-ready authentication lifecycle. */
export function startAuthenticatedModelServices(): () => void {
  const startSelected = () => {
    const user = getCurrentlyActiveUser();
    if (!user || user.role === 'guest') return;
    void startAssignedModelServices(user.username).catch(error => {
      console.error('[llm-backend] Assigned model services failed to start:', error);
    });
  };
  const unsubscribe = onAuthenticatedSessionChange(startSelected);
  startSelected();
  return unsubscribe;
}
