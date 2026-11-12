/**
 * Provider Bridge (Core)
 *
 * Unified entry point for ALL LLM providers.
 * - Local providers (ollama, mock) are handled here
 * - Cloud providers (RunPod, HuggingFace) are owned by the Core provider layer
 *
 * model-router.ts calls this ONE function - it knows nothing about specific providers.
 *
 * Explicit assignments retain their provider; only the generic local slot uses backend selection.
 * AUTO-START: Automatically starts the configured backend if not running
 *
 * Web and mobile use the same provider implementations.
 */

import {
  ollama,
  isRunning as isOllamaRunning,
  buildOllamaChatMessages,
  normalizeOllamaChatResponse,
  resolveOllamaThinkingMode,
} from '../ollama.js';
import { callLlamaCpp, getLlamaCppStatus } from './llama-cpp.js';
import { loadBackendConfig, getBackendStatus } from '../llm-backend.js';
import { loadDeploymentConfig } from '../deployment.js';
import { callCloudProvider, isCloudProviderAvailable } from './cloud.js';
import {
  callRemoteProvider as callDirectRemoteProvider,
  type RemoteProviderCredentials,
  type RemoteProviderName,
} from './remote.js';
import { getUserContext } from '../context.js';
import { resolveCredentials } from '../llm-config.js';
import { loadFreshOperatorConfig } from '../config.js';

// Track if we've already logged the active backend
let backendLoggedOnce = false;
import {
  type ProviderMessage,
  type ProviderOptions,
  type ProviderResponse,
  type ProviderProgressCallback,
  type ProviderConfig,
  type ProviderType,
  ProviderInputError,
  inspectProviderMessages,
  providerImagePolicyFromOptions,
  isCloudProvider,
  isRemoteServerProvider,
} from './types.js';

function messageText(message: ProviderMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

export function assertAdapterPreservesImageInput(provider: string, imageCount: number): void {
  if (imageCount > 0) {
    throw new ProviderInputError(`${provider} does not preserve image content in its current MetaHuman adapter.`)
  }
}

// Re-export types for convenience
export * from './types.js';

/**
 * Call an LLM provider
 *
 * This is the ONLY function model-router needs to call.
 * Routes to local or cloud provider based on provider type.
 *
 * For local providers (ollama), automatically routes to the active backend
 * (Ollama or llama.cpp) based on etc/llm-backend.json configuration.
 */
export async function callProvider(
  providerName: ProviderType,
  messages: ProviderMessage[],
  options: ProviderOptions,
  onProgress?: ProviderProgressCallback
): Promise<ProviderResponse> {
  const imagePolicy = providerImagePolicyFromOptions(options)
  const contentInspection = inspectProviderMessages(messages, imagePolicy)
  const hasImages = contentInspection.imageCount > 0
  const declaredCapabilities = options.modelCapabilities || []
  // Explicit placement replaces a local role with the configured remote model.
  // Its image capability is checked by that server/provider, not the local role.
  const configuredRemote = options.executionTarget === 'remote'
    && !isRemoteServerProvider(providerName) && !isCloudProvider(providerName)
  if (hasImages && !configuredRemote && declaredCapabilities.length > 0
    && !declaredCapabilities.some(capability => capability === 'image' || capability === 'vision')) {
    throw new ProviderInputError(`The selected model ${options.model || 'unknown'} is not configured for image input.`)
  }

  // Get config
  const deploymentConfig = loadDeploymentConfig();

  // Get credentials from user profile (same pattern as model-router.ts)
  const ctx = getUserContext();
  const username = ctx?.username;
  const userCreds = username ? resolveCredentials(username, 'runpod') : null;

  // Build config with user credentials taking priority over deployment config
  const config: ProviderConfig = {
    ollama: {
      endpoint: deploymentConfig.local.ollamaEndpoint,
    },
    // User profile credentials override deployment config
    runpod: userCreds?.provider === 'runpod' && userCreds.apiKey
      ? {
          apiKey: userCreds.apiKey,
          endpoints: { default: userCreds.endpoint || '' },
        }
      : deploymentConfig.server?.runpod,
    huggingface: deploymentConfig.server?.huggingface,
  };

  // Explicit remote placement and remote role assignments must not probe,
  // start, or depend on a local model (including local Big Brother execution).
  if (isRemoteServerProvider(providerName)) {
    return callRemoteServerProvider(messages, options, onProgress);
  }
  if (providerName === 'gemini' || providerName === 'openai' || providerName === 'openrouter' || providerName === 'claude') {
    if (providerName !== 'gemini') {
      assertAdapterPreservesImageInput(providerName, contentInspection.imageCount);
    }
    const resolved = username ? resolveCredentials(username, providerName) : null;
    const envKey = providerName === 'gemini'
      ? (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '')
      : providerName === 'claude'
        ? (process.env.ANTHROPIC_API_KEY || '')
        : (process.env[`${providerName.toUpperCase()}_API_KEY`] || '');
    const apiKey = resolved?.apiKey || envKey;
    if (!apiKey) {
      throw new Error(`No API key found for ${providerName}. Configure credentials in profiles/${username || '<user>'}/etc/llm-credentials.json or environment.`);
    }
    onProgress?.({ phase: 'running', message: `Calling ${providerName} (${options.model || 'default'})...` });
    const response = await callDirectRemoteProvider(
      { provider: providerName, apiKey, endpoint: resolved?.endpoint || options.endpoint, model: options.model },
      messages,
      options,
    );
    onProgress?.({ phase: 'completed', message: `${providerName} response received` });
    return response;
  }
  if (options.executionTarget === 'remote') {
    if (isCloudProvider(providerName)) {
      assertAdapterPreservesImageInput(providerName, contentInspection.imageCount)
      return callCloudProvider(providerName, messages, options, config, onProgress);
    }
    const backend = loadBackendConfig();
    return callRemoteProvider(messages, { ...options, model: backend.remote?.model || 'default' }, backend, onProgress);
  }

  // =========================================================================
  // BACKEND AVAILABILITY CHECK: Fail fast if no LLM backend is available
  // NO FALLBACKS - if the configured backend isn't working, STOP and notify user
  // =========================================================================
  const operatorConfig = username ? loadFreshOperatorConfig(username) : null;
  const shouldUseBigBrother = providerName === 'big-brother' || options.useBigBrother === true;

  if (shouldUseBigBrother) {
    // Use the provider-agnostic escalation system
    const {
      ensureBackendsInitialized,
      escalate,
      getActiveBackend,
      getBackend,
    } = await import('../escalation-backend.js');

    // Get configured backend from operator.json or explicit role metadata
    const preferredBackend = options.cliProvider || operatorConfig?.bigBrotherMode?.provider;
    await ensureBackendsInitialized();
    const backend = preferredBackend
      ? getBackend(preferredBackend)
      : getActiveBackend(username);
    const backendName = preferredBackend || backend?.name || 'Big Brother';
    const resolvedBackendId = backend?.id || preferredBackend
    const preservesImages = resolvedBackendId === 'codex' || resolvedBackendId === 'gemini'
    if (!preservesImages) {
      assertAdapterPreservesImageInput(backendName, contentInspection.imageCount)
    }

    console.log('[provider-bridge] Big Brother routing enabled', {
      preferredBackend,
      resolvedBackend: backend?.id || backend?.name || 'unknown',
    });

    onProgress?.({ phase: 'loading', message: `${backendName}: Starting...` });

    // CLI providers receive their response contract as instructions. Their native
    // strict-schema modes cannot represent all workflow schemas (optional fields
    // and open objects); the calling workflow retains response validation.
    let responseInstructions: string | undefined;
    if (options.jsonSchema || options.format === 'json') {
      responseInstructions = 'Return only the final JSON value, without Markdown fences or surrounding commentary.';
      if (options.jsonSchema) {
        responseInstructions += `\nThe final response must conform to this JSON Schema:\n${JSON.stringify(options.jsonSchema)}`;
      }
    }
    const nativeMessages = resolvedBackendId === 'codex' || resolvedBackendId === 'gemini';
    if (options.toolAccess === 'read-only' && !nativeMessages) {
      throw new Error('This model backend does not provide the requested read-only terminal tool access');
    }
    const prompt = nativeMessages ? '' : messages.map(m =>
      `[${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}]: ${messageText(m)}`
    ).join('\n\n') + (responseInstructions ? `\n\n[System]: ${responseInstructions}` : '');

    onProgress?.({ phase: 'running', message: `${backendName}: Processing...` });

    // Execute through the configured backend (provider-agnostic)
    const result = await escalate(prompt, {
      signal: options.signal,
      enableThinking: options.enableThinking,
      toolAccess: options.toolAccess,
      username,
      preferredBackend,
      ...(options.cliProvider && options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(nativeMessages ? { modelRequest: { messages, ...(responseInstructions ? { responseInstructions } : {}),
        ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}) } } : {}),
    });

    // NO FALLBACK - if Big Brother fails, throw and stop
    if (!result.success) {
      const errorMsg = `Big Brother (${backendName}) failed: ${result.error || 'Unknown error'}. Check Big Brother terminal status.`;
      console.error(`[provider-bridge] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    onProgress?.({ phase: 'completed', message: `${backendName}: Response received` });

    return {
      content: result.output,
      model: (options.cliProvider && options.model) || operatorConfig?.bigBrotherMode?.model || preferredBackend || 'big-brother',
      provider: 'big-brother',
    };
  }

  // A registered llama.cpp role retains its serving endpoint and request adapters.
  // Role assignment retains its selected provider.
  if (providerName === 'llama-cpp') {
    return callLlamaCppProvider(messages, options, onProgress);
  }
  if (isCloudProvider(providerName)) {
    assertAdapterPreservesImageInput(providerName, contentInspection.imageCount);
    return callCloudProvider(providerName, messages, options, config, onProgress);
  }

  switch (providerName) {
    case 'ollama':
      return callOllamaProvider(messages, options, onProgress);
    case 'local': {
      // Only the explicitly selected generic local slot follows deployment settings.
      const backend = loadBackendConfig();
      const status = await getBackendStatus();
      switch (status.resolvedBackend) {
        case 'llama-cpp': return callLlamaCppProvider(messages, options, onProgress);
        case 'ollama': return callOllamaProvider(messages, options, onProgress);
        case 'remote': return callRemoteProvider(messages, options, backend, onProgress);
        default: throw new Error(`No local backend available: ${status.reason || status.health}`);
      }
    }

    case 'mock':
      assertAdapterPreservesImageInput('Mock provider', contentInspection.imageCount)
      return callMockProvider(messages, options);

    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

/**
 * Call a remote provider (Claude, RunPod, OpenRouter, OpenAI)
 */
async function callRemoteProvider(
  messages: ProviderMessage[],
  options: ProviderOptions,
  backendConfig: any,
  onProgress?: ProviderProgressCallback
): Promise<ProviderResponse> {
  if (backendConfig.remote?.provider === 'server') {
    return callRemoteServerProvider(messages, options, onProgress);
  }
  const remoteConfig = backendConfig.remote;
  if (!remoteConfig?.provider) {
    throw new Error('No remote provider configured');
  }
  if (remoteConfig.provider !== 'gemini') {
    const inspection = inspectProviderMessages(messages, providerImagePolicyFromOptions(options))
    assertAdapterPreservesImageInput('Remote provider', inspection.imageCount)
  }

  onProgress?.({ phase: 'running', message: `Using remote provider: ${remoteConfig.provider}` });

  // Get credentials from user profile (same pattern as model-router.ts)
  const ctx = getUserContext();
  const username = ctx?.username;

  // Resolve credentials: user profile → system config → env vars
  const resolved = username ? resolveCredentials(username, remoteConfig.provider) : null;

  const supportedProviders: RemoteProviderName[] = ['runpod', 'claude', 'openrouter', 'openai', 'gemini']
  if (!supportedProviders.includes(remoteConfig.provider as RemoteProviderName)) {
    throw new Error(`Unsupported remote provider: ${remoteConfig.provider}`)
  }

  const fallbackEnvKey = remoteConfig.provider === 'gemini'
    ? (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '')
    : (process.env[`${remoteConfig.provider.toUpperCase()}_API_KEY`] || '')

  const credentials: RemoteProviderCredentials = {
    provider: remoteConfig.provider as RemoteProviderName,
    apiKey: resolved?.apiKey || fallbackEnvKey,
    endpoint: resolved?.endpoint || remoteConfig.serverUrl,
    model: remoteConfig.model || options.model,
  };

  if (!credentials.apiKey) {
    throw new Error(`No API key found for ${remoteConfig.provider}. Configure credentials in Settings or set ${remoteConfig.provider.toUpperCase()}_API_KEY environment variable.`);
  }

  const response = await callDirectRemoteProvider(credentials, messages, {
    ...options,
    model: options.model || remoteConfig.model,
  });

  onProgress?.({ phase: 'completed', message: 'Remote response received' });

  return response;
}

/**
 * Call a remote MetaHuman server provider
 * Proxies LLM requests to a connected remote server (e.g., desktop via Cloudflare tunnel)
 */
async function callRemoteServerProvider(
  messages: ProviderMessage[],
  options: ProviderOptions,
  onProgress?: ProviderProgressCallback
): Promise<ProviderResponse> {
  const username = getUserContext()?.username;
  const credentials = username ? resolveCredentials(username, 'server') : null;
  if (!credentials?.endpoint || !credentials.apiKey) throw new Error('Remote server login is unavailable. Connect in Settings → Backend → Remote Server.');
  const serverUrl = credentials.endpoint.replace(/\/$/, '');
  const model = options.model || 'default';

  onProgress?.({ phase: 'loading', message: `Connecting to remote server...` });

  // Build headers with session cookie for authentication
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Use session cookie - obtained via /api/auth/login on connect
  headers['Cookie'] = `mh_session=${credentials.apiKey}`;

  onProgress?.({ phase: 'running', message: `Generating with remote server (${model})...` });

  try {
    // Proxy to the remote server's LLM chat endpoint
    // This routes to whatever backend is active on the remote server (Ollama or llama.cpp)
    const llmUrl = `${serverUrl}/api/llm/chat`;

    const response = await fetch(llmUrl, {
      signal: options.signal,
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
          top_p: options.topP,
          top_k: options.topK,
          min_p: options.minP,
          repeat_penalty: options.repeatPenalty,
          lora: options.lora,
          format: options.jsonSchema || options.format,
          num_ctx: options.contextWindow,
          think: options.enableThinking,
          maxImages: options.maxImages,
          maxImageBytes: options.maxImageBytes,
          allowedImageMimeTypes: options.allowedImageMimeTypes,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Remote server error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    onProgress?.({ phase: 'completed', message: `Remote server response received` });

    // Handle response from /api/llm/chat endpoint
    // Format: { message: { role, content }, model, done, provider, usage }
    const content = data.message?.content || data.choices?.[0]?.message?.content || data.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Remote server returned no model content');

    return {
      content,
      model: data.model || model,
      provider: 'remote-server',
      usage: data.usage ? {
        promptTokens: data.usage.promptTokens || data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completionTokens || data.usage.completion_tokens || 0,
        totalTokens: data.usage.totalTokens || data.usage.total_tokens || 0,
      } : undefined,
    };
  } catch (error) {
    onProgress?.({ phase: 'failed', message: `Remote server failed: ${(error as Error).message}` });
    throw error;
  }
}

// Models that can coexist in VRAM with chat models (small utility models)
const COEXIST_MODELS = ['nomic-embed-text', 'all-minilm', 'mxbai-embed', 'snowflake-arctic-embed'];
const EXCLUSIVE_MODELS = ['qwen3-coder:30b', 'qwen3:30b', 'llama3:70b', 'mixtral', 'deepseek-coder:33b'];

function canCoexistWithChatModel(modelName: string): boolean {
  const lowerName = modelName.toLowerCase();
  return COEXIST_MODELS.some(m => lowerName.includes(m));
}

function requiresExclusiveGPU(modelName: string): boolean {
  const lowerName = modelName.toLowerCase();
  return EXCLUSIVE_MODELS.some(m => lowerName.includes(m)) ||
    lowerName.includes(':30b') || lowerName.includes(':33b') ||
    lowerName.includes(':70b') || lowerName.includes(':72b');
}

async function callLlamaCppProvider(messages: ProviderMessage[], options: ProviderOptions, onProgress?: ProviderProgressCallback): Promise<ProviderResponse> {
  const backend = loadBackendConfig();
  const config = { ...backend.llamaCpp,
    endpoint: options.endpoint ?? backend.llamaCpp.endpoint,
    model: options.model ?? backend.llamaCpp.model,
    contextWindow: options.contextWindow ?? backend.llamaCpp.contextWindow,
    capabilities: (options.modelCapabilities?.length ? options.modelCapabilities : backend.llamaCpp.capabilities) as Array<'text' | 'image'>,
  };
  const { assertTrainingModelApproved } = await import('../adapters.js');
  await assertTrainingModelApproved(getUserContext()?.username, 'llama-cpp', config.model, { ...options, endpoint: config.endpoint });
  return callLlamaCpp(config, messages, options, onProgress);
}

/** Ollama provider implementation with GPU contention handling. */
async function callOllamaProvider(
  messages: ProviderMessage[],
  options: ProviderOptions,
  onProgress?: ProviderProgressCallback
): Promise<ProviderResponse> {
  const backendConfig = loadBackendConfig();
  const ollamaConfig = backendConfig.ollama;
  const model = options.model || ollamaConfig.defaultModel;
  const username = getUserContext()?.username;
  const { assertTrainingModelApproved } = await import('../adapters.js');
  await assertTrainingModelApproved(username, 'ollama', model);
  ollama.setEndpoint(ollamaConfig.endpoint);
  const imagePolicy = providerImagePolicyFromOptions(options)
  const contentInspection = inspectProviderMessages(messages, imagePolicy)

  // Log active backend once
  if (!backendLoggedOnce) {
    console.log(`[provider-bridge] Active backend: Ollama (${model})`);
    backendLoggedOnce = true;
  }

  // Check if Ollama is running
  const running = await isOllamaRunning();
  if (!running) {
    onProgress?.({
      phase: 'failed',
      message: 'Ollama is not running. Start it with: ollama serve',
    });
    throw new Error('Ollama is not running. Start it with: ollama serve');
  }

  if (contentInspection.imageCount > 0) {
    let details: { capabilities?: string[] }
    try {
      details = await ollama.showModel(model) as { capabilities?: string[] }
    } catch {
      throw new ProviderInputError(`The selected Ollama model ${model} is not installed or could not be inspected.`)
    }
    const capabilities = Array.isArray(details.capabilities)
      ? details.capabilities.map(capability => capability.toLowerCase())
      : []
    if (capabilities.length > 0 && !capabilities.includes('vision') && !capabilities.includes('image')) {
      throw new ProviderInputError(`The selected Ollama model ${model} does not support image input.`)
    }
  }

  // Check if model is already loaded or if we need to wait
  const isLoaded = await ollama.isModelLoaded(model);

  if (!isLoaded) {
    // Check what other models are currently loaded
    const runningModels = await ollama.getRunningModels().catch(() => ({ models: [] }));

    if (runningModels.models.length > 0) {
      const currentModel = runningModels.models[0]?.name || 'unknown';

      // Only wait if the currently loaded model requires exclusive GPU access
      const needsToWait = !canCoexistWithChatModel(currentModel) &&
        (requiresExclusiveGPU(currentModel) || requiresExclusiveGPU(model));

      if (needsToWait) {
        onProgress?.({
          phase: 'queued',
          message: `Waiting for GPU... (${currentModel} is loaded)`,
        });

        // Wait for model availability (up to 60 seconds)
        const waitResult = await ollama.waitForModelAvailability(model, {
          timeoutMs: 60000,
          pollIntervalMs: 2000,
          onWaiting: (loadedModel: string, elapsed: number) => {
            onProgress?.({
              phase: 'queued',
              message: `Waiting for GPU (${Math.round(elapsed / 1000)}s)... ${loadedModel} still loaded`,
              elapsedMs: elapsed,
            });
          },
        });

        if (!waitResult.ready) {
          throw new Error(
            `GPU busy: ${waitResult.currentModel || 'another model'} is using the GPU. ` +
            `Waited ${Math.round((waitResult.waitedMs || 0) / 1000)}s.`
          );
        }
      }
    }

    onProgress?.({
      phase: 'loading',
      message: `Loading ${model}...`,
    });
  }

  // Build Ollama options
  const ollamaOptions = {
    temperature: options.temperature ?? ollamaConfig.temperature,
    top_p: options.topP ?? ollamaConfig.topP,
    top_k: options.topK ?? ollamaConfig.topK,
    min_p: options.minP ?? ollamaConfig.minP,
    repeat_penalty: options.repeatPenalty ?? ollamaConfig.repeatPenalty,
    seed: options.seed ?? ollamaConfig.seed ?? undefined,
    num_predict: options.maxTokens ?? ollamaConfig.maxTokens,
  };

  onProgress?.({
    phase: 'running',
    message: `Generating with ${model}...`,
  });

  // Call Ollama with OOM error detection
  let response;
  try {
    const ollamaMessages = buildOllamaChatMessages(messages, imagePolicy)
    response = await ollama.chat(model, ollamaMessages, {
      signal: options.signal,
      ...ollamaOptions,
      num_ctx: options.contextWindow ?? ollamaConfig.contextWindow,
      think: resolveOllamaThinkingMode(options.enableThinking ?? ollamaConfig.enableThinking),
      format: options.jsonSchema ?? (options.format === 'json' ? 'json' : undefined),
      keep_alive: options.keepAlive ?? ollamaConfig.keepAlive,
    });
  } catch (error) {
    const errorMsg = (error as Error).message || '';
    const isOOMError = errorMsg.includes('EOF') || errorMsg.includes('ECONNREFUSED') ||
      errorMsg.includes('CUDA out of memory') || errorMsg.includes('out of memory') ||
      errorMsg.includes('failed to load model') || errorMsg.includes('GGML_ASSERT');

    if (isOOMError) {
      onProgress?.({
        phase: 'failed',
        message: `Model ${model} failed to load - GPU memory may be full`,
      });
      throw new Error(`GPU memory exhausted: Unable to load ${model}. Please wait and try again.`);
    }
    throw error;
  }

  onProgress?.({
    phase: 'completed',
    message: `${model} ready`,
  });

  const normalizedResponse = normalizeOllamaChatResponse(response)

  return {
    content: normalizedResponse.content,
    thinking: normalizedResponse.thinking,
    model,
    provider: 'ollama',
    usage: response.prompt_eval_count || response.eval_count ? {
      promptTokens: response.prompt_eval_count || 0,
      completionTokens: response.eval_count || 0,
      totalTokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
    } : undefined,
  };
}

/**
 * Mock provider for testing
 */
async function callMockProvider(
  messages: ProviderMessage[],
  options: ProviderOptions
): Promise<ProviderResponse> {
  const lastMessage = messages[messages.length - 1];
  return {
    content: `[MOCK] Echoing: ${lastMessage?.content || 'empty'}`,
    model: options.model || 'mock',
    provider: 'mock',
  };
}

/**
 * Check if a provider is available
 */
export async function isProviderAvailable(providerName: ProviderType): Promise<boolean> {
  switch (providerName) {
    case 'big-brother': {
      const { ensureBackendsInitialized, getBackend } = await import('../escalation-backend.js');
      await ensureBackendsInitialized();
      const username = getUserContext()?.username;
      const provider = (username ? loadFreshOperatorConfig(username).bigBrotherMode?.provider : undefined) || 'claude-code';
      return await getBackend(provider)?.isAvailable() ?? false;
    }
    case 'llama-cpp':
      return (await getLlamaCppStatus(loadBackendConfig().llamaCpp)).running;
    case 'ollama':
      return ollama.isRunning();

    case 'mock':
      return true;

    case 'runpod_serverless':
    case 'huggingface':
      const deploymentConfig = loadDeploymentConfig();
      return isCloudProviderAvailable(providerName, {
        runpod: deploymentConfig.server?.runpod,
        huggingface: deploymentConfig.server?.huggingface,
      });

    default:
      return false;
  }
}
