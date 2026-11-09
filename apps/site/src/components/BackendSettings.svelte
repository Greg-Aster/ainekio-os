<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';
  import { DEFAULT_OLLAMA_CHAT_MODEL } from '../lib/client/model-defaults';
  import { statusRefreshTrigger } from '../stores/navigation';

  type DefaultBackend = 'auto' | 'ollama' | 'llama-cpp';
  type ResolvedBackend = 'llama-cpp' | 'ollama' | 'remote' | 'offline';
  type BigBrotherProvider = 'claude-code' | 'codex' | 'gemini';

  interface BackendAvailability {
    llamaCpp: { configured: boolean; running: boolean; model?: string; error?: string };
    ollama: { installed: boolean; running: boolean; model?: string };
  }

  interface LocalModelArtifact {
    id: string;
    displayName: string;
    source: 'ollama-store' | 'huggingface-cache';
    compatibleProviders: string[];
    format: string;
    architecture?: string;
    modelType?: string;
    quantization?: string;
    sizeBytes: number;
    path: string;
    installed: boolean;
    error?: string;
  }

  interface SourceLoraAdapter {
    name: string;
    path: string;
    createdAt: string;
    valid: boolean;
    baseModel?: string;
    loraRank?: number;
    sizeBytes?: number;
    compatibleWithTarget?: boolean;
  }

  interface OllamaLoraAdapter extends SourceLoraAdapter {
    compatibleWithTarget: boolean;
    supportedByOllama: boolean;
    unavailableReason?: string;
  }

  interface BigBrotherConfig {
    provider: string;
    model?: string;
    reasoningEffort?: string;
  }

  const defaultBackendOptions: Array<{ value: DefaultBackend; label: string; description: string }> = [
    { value: 'auto', label: 'Auto', description: 'Use the best running local backend, then configured remote fallback.' },
    { value: 'ollama', label: 'Ollama', description: 'Use the local Ollama service for normal chat.' },
    { value: 'llama-cpp', label: 'llama.cpp', description: 'Use a llama-server for local text responses and image understanding.' },
  ];

  const bigBrotherProviderOptions: { value: BigBrotherProvider; label: string; description: string }[] = [
    { value: 'claude-code', label: 'Claude Code', description: 'Runs in the visible Big Brother terminal' },
    { value: 'codex', label: 'Codex', description: 'Runs in the visible Big Brother terminal' },
    { value: 'gemini', label: 'Gemini (Antigravity)', description: 'Runs Gemini Flash in the visible Big Brother terminal' },
  ];

  let mounted = true;
  let configLoaded = false;
  let configError: string | null = null;
  let configRead: AbortController | null = null;
  let statusRead: AbortController | null = null;
  let loraRead: AbortController | null = null;
  let bigBrotherRead: AbortController | null = null;
  let loraError: string | null = null;
  let bigBrotherError: string | null = null;
  let connectedRemoteUrl = '';
  let loading = true;
  let error: string | null = null;
  let savedNotice: string | null = null;

  let activeBackend: DefaultBackend = 'auto';
  let configuredActiveBackend = 'auto';
  let preferredLocalBackend: 'ollama' | 'llama-cpp' = 'ollama';
  let resolvedBackend: ResolvedBackend | null = null;
  let available: BackendAvailability | null = null;
  let sharedArtifacts: LocalModelArtifact[] = [];
  let statusLoading = false;
  let statusWarning: string | null = null;

  let llamaEndpoint = 'http://127.0.0.1:8080';
  let llamaModel = '';
  let llamaContextWindow = 4096;
  let llamaMaxTokens = -1;
  let llamaTemperature = 0.7;
  let llamaTopP = 0.9;
  let llamaImages = false;
  let llamaThinking = false;
  let savingLlama = false;

  let ollamaEndpoint = 'http://localhost:11434';
  let ollamaModel = DEFAULT_OLLAMA_CHAT_MODEL;
  let ollamaModelSelection = '__custom__';
  let ollamaArtifacts: LocalModelArtifact[] = [];
  let selectedOllamaArtifact: LocalModelArtifact | null = null;
  let ollamaContextWindow = 8192;
  let ollamaMaxTokens = 2048;
  let ollamaTemperature = 0.7;
  let ollamaTopP = 0.9;
  let ollamaTopK = 40;
  let ollamaMinP = 0;
  let ollamaRepeatPenalty = 1.1;
  let ollamaSeed: number | undefined = undefined;
  let ollamaKeepAlive = '5m';
  let ollamaEnableThinking = false;
  let showOllamaAdvanced = false;
  let showOllamaLoras = false;
  let ollamaLoraAdapters: OllamaLoraAdapter[] = [];
  let loadingOllamaLoras = false;
  let buildingOllamaLora: string | null = null;
  $: ollamaArtifacts = sharedArtifacts.filter(artifact =>
    artifact.installed &&
    artifact.source === 'ollama-store' &&
    artifact.compatibleProviders.includes('ollama')
  );
  $: selectedOllamaArtifact = ollamaArtifacts.find(artifact => artifact.id === ollamaModelSelection) || null;

  let savingDefault = false;
  let savingOllamaConfig = false;
  let actionInProgress: string | null = null;

  let remoteServerUrl = '';
  let remoteServerUsername = '';
  let remoteServerPassword = '';
  let remoteServerSaveCredentials = true;
  let savingRemoteConfig = false;
  let testingRemoteServer = false;
  let remoteServerTestResult: {
    success: boolean;
    latencyMs?: number;
    serverVersion?: string;
    models?: Array<{ id: string; model: string; provider: string }>;
    error?: string;
    needsAuth?: boolean;
  } | null = null;

  let bigBrotherConfig: BigBrotherConfig | null = null;
  let bigBrotherModel = '';
  let bigBrotherReasoningEffort = '';
  let bigBrotherProvider: string = 'claude-code';
  let savingBigBrother = false;

  onMount(() => {
    void loadBackendSettings();
    void loadStatus();
    loadBigBrotherConfig();
  });

  onDestroy(() => {
    mounted = false;
    configRead?.abort(); statusRead?.abort(); loraRead?.abort(); bigBrotherRead?.abort();
  });

  function isDefaultBackend(value: string): value is DefaultBackend {
    return value === 'auto' || value === 'ollama' || value === 'llama-cpp';
  }

  function restartNotice(label = 'Backend configuration saved'): string {
    return `${label}. Restart Ainekio OS for this setting to take effect cleanly.`;
  }

  function clearMessages() {
    error = null;
    savedNotice = null;
  }

  function formatArtifactSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
    const gib = bytes / 1024 / 1024 / 1024;
    return gib >= 1 ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 / 1024)} MB`;
  }

  function syncOllamaModelSelection() {
    const artifact = sharedArtifacts.find(candidate =>
      candidate.installed &&
      candidate.source === 'ollama-store' &&
      candidate.compatibleProviders.includes('ollama') &&
      (candidate.id === ollamaModel || candidate.displayName === ollamaModel)
    );
    ollamaModelSelection = artifact?.id || '__custom__';
  }

  function selectOllamaModel() {
    const artifact = ollamaArtifacts.find(candidate => candidate.id === ollamaModelSelection);
    if (!artifact) {
      ollamaModel = '';
      void loadOllamaLoras('');
      return;
    }
    ollamaModel = artifact.displayName;
    void loadOllamaLoras(ollamaModel);
  }

  function applyBackendConfig(config: any) {
    configuredActiveBackend = config.activeBackend || 'auto';
    activeBackend = isDefaultBackend(configuredActiveBackend) ? configuredActiveBackend : 'auto';
    preferredLocalBackend = config.preferredLocalBackend === 'llama-cpp' ? 'llama-cpp' : 'ollama';
    llamaEndpoint = config.llamaCpp?.endpoint ?? 'http://127.0.0.1:8080';
    llamaModel = config.llamaCpp?.model ?? '';
    llamaContextWindow = config.llamaCpp?.contextWindow ?? 4096;
    llamaMaxTokens = config.llamaCpp?.maxTokens ?? -1;
    llamaTemperature = config.llamaCpp?.temperature ?? 0.7;
    llamaTopP = config.llamaCpp?.topP ?? 0.9;
    llamaImages = config.llamaCpp?.capabilities?.includes('image') ?? false;
    llamaThinking = config.llamaCpp?.enableThinking ?? false;

    ollamaEndpoint = config.ollama?.endpoint || 'http://localhost:11434';
    ollamaModel = config.ollama?.defaultModel || DEFAULT_OLLAMA_CHAT_MODEL;
    ollamaContextWindow = config.ollama?.contextWindow ?? 8192;
    ollamaMaxTokens = config.ollama?.maxTokens ?? 2048;
    ollamaTemperature = config.ollama?.temperature ?? 0.7;
    ollamaTopP = config.ollama?.topP ?? 0.9;
    ollamaTopK = config.ollama?.topK ?? 40;
    ollamaMinP = config.ollama?.minP ?? 0;
    ollamaRepeatPenalty = config.ollama?.repeatPenalty ?? 1.1;
    ollamaSeed = config.ollama?.seed === null || config.ollama?.seed === undefined
      ? undefined
      : Number(config.ollama.seed);
    ollamaKeepAlive = config.ollama?.keepAlive || '5m';
    ollamaEnableThinking = config.ollama?.enableThinking ?? false;

    remoteServerUrl = config.remote?.serverUrl || '';
    connectedRemoteUrl = remoteServerUrl;

    syncOllamaModelSelection();
  }

  async function loadOllamaLoras(targetModel = ollamaModel) {
    if (!mounted) return;
    loraRead?.abort();
    const controller = new AbortController();
    loraRead = controller;
    loraError = null;
    if (!targetModel.trim()) {
      ollamaLoraAdapters = [];
      loadingOllamaLoras = false;
      return;
    }
    loadingOllamaLoras = true;
    try {
      const res = await apiFetch(`/api/ollama/loras?model=${encodeURIComponent(targetModel.trim())}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Ollama LoRA settings returned ${res.status}`);
      }
      controller.signal.throwIfAborted();
      ollamaLoraAdapters = data.available;
    } catch (err) {
      if (!controller.signal.aborted) loraError = err instanceof Error ? err.message : String(err);
    } finally {
      if (loraRead === controller) loadingOllamaLoras = false;
    }
  }

  async function buildOllamaLora(adapter: OllamaLoraAdapter) {
    if (adapter.unavailableReason || !ollamaModel.trim()) return;
    const baseModel = ollamaModel.trim();
    buildingOllamaLora = adapter.name;
    clearMessages();
    try {
      const res = await apiFetch('/api/ollama/loras', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapterName: adapter.name,
          baseModel,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        error = data.error || 'Failed to create Ollama model from the selected LoRA';
        return;
      }
      if (!mounted) return;
      if (ollamaModel.trim() === baseModel) ollamaModel = data.modelName;
      savedNotice = `${data.modelName} was created and saved as the Ollama default.`;
      await loadStatus();
      await loadOllamaLoras(ollamaModel);
      statusRefreshTrigger.update(n => n + 1);
    } catch {
      error = 'Failed to create Ollama model from the selected LoRA';
    } finally {
      buildingOllamaLora = null;
    }
  }

  async function loadBackendSettings() {
    if (!mounted) return;
    configRead?.abort();
    const controller = new AbortController();
    configRead = controller;
    configError = null;
    loading = true;

    try {
      const res = await apiFetch('/api/llm-backend/config', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!res.ok) {
        throw new Error(`Backend configuration returned ${res.status}`);
      }
      const config = await res.json();
      controller.signal.throwIfAborted();
      applyBackendConfig(config);
      configLoaded = true;
      void loadOllamaLoras();
    } catch (err) {
      if (!controller.signal.aborted) configError = 'Failed to load saved backend configuration';
    } finally {
      if (configRead === controller) loading = false;
    }
  }

  async function loadStatus(): Promise<boolean> {
    if (!mounted) return false;
    statusRead?.abort();
    const controller = new AbortController();
    statusRead = controller;
    statusLoading = true;
    statusWarning = null;
    try {
      const res = await apiFetch('/api/llm-backend/status', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      });
      if (!res.ok) {
        throw new Error(`Backend status returned ${res.status}`);
      }

      const data = await res.json();
      controller.signal.throwIfAborted();
      available = data.available;
      resolvedBackend = data.active?.resolvedBackend || null;
      sharedArtifacts = data.sharedArtifacts || data.available?.sharedArtifacts || [];
      syncOllamaModelSelection();
      return true;
    } catch (err) {
      if (!controller.signal.aborted) statusWarning = 'Live service status is unavailable. Saved settings are still editable.';
      return false;
    } finally {
      if (statusRead === controller) statusLoading = false;
    }
  }

  async function saveDefaultBackend(to: DefaultBackend) {
    if (savingDefault || to === configuredActiveBackend) return;
    savingDefault = true;
    clearMessages();

    const updates: Record<string, any> = { activeBackend: to };
    if (to === 'llama-cpp') {
      updates.preferredLocalBackend = 'llama-cpp';
    } else if (to === 'ollama') {
      updates.preferredLocalBackend = 'ollama';
      updates.ollama = { autoStart: true };
    } else {
      updates.preferredLocalBackend = preferredLocalBackend;
    }

    try {
      const res = await apiFetch('/api/llm-backend/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        error = data.error || 'Failed to save default backend';
        return;
      }

      configuredActiveBackend = to;
      activeBackend = to;
      savedNotice = to === 'llama-cpp' ? 'Default chat backend saved as llama.cpp.' : restartNotice(`Default chat backend saved as ${getBackendLabel(to)}`);
      await loadStatus();
      window.dispatchEvent(new CustomEvent('backend-changed', { detail: { backend: to, requiresRestart: to !== 'llama-cpp' } }));
      statusRefreshTrigger.update(n => n + 1);
    } catch (err) {
      error = 'Failed to save default backend';
    } finally {
      savingDefault = false;
    }
  }

  async function saveLlamaConfig() {
    savingLlama = true;
    clearMessages();
    try {
      const response = await apiFetch('/api/llm-backend/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeBackend: 'llama-cpp', preferredLocalBackend: 'llama-cpp', llamaCpp: {
          endpoint: llamaEndpoint.trim(), model: llamaModel.trim(), contextWindow: llamaContextWindow,
          maxTokens: llamaMaxTokens, temperature: llamaTemperature, topP: llamaTopP,
          enableThinking: llamaThinking, capabilities: llamaImages ? ['text', 'image'] : ['text'],
        } }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not save llama.cpp settings');
      configuredActiveBackend = 'llama-cpp';
      activeBackend = 'llama-cpp';
      preferredLocalBackend = 'llama-cpp';
      await loadStatus();
      savedNotice = 'llama.cpp settings saved and selected.';
      window.dispatchEvent(new CustomEvent('backend-changed', { detail: { backend: 'llama-cpp', requiresRestart: false } }));
      statusRefreshTrigger.update(n => n + 1);
    } catch (err) { error = err instanceof Error ? err.message : 'Could not save llama.cpp settings'; }
    finally { savingLlama = false; }
  }

  async function saveOllamaConfig() {
    if (!ollamaModel.trim()) {
      error = 'Choose an installed Ollama model or enter a custom model name.';
      return;
    }
    savingOllamaConfig = true;
    clearMessages();

    try {
      const res = await apiFetch('/api/llm-backend/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ollama: {
            endpoint: ollamaEndpoint,
            defaultModel: ollamaModel.trim(),
            contextWindow: ollamaContextWindow,
            maxTokens: ollamaMaxTokens,
            temperature: ollamaTemperature,
            topP: ollamaTopP,
            topK: ollamaTopK,
            minP: ollamaMinP,
            repeatPenalty: ollamaRepeatPenalty,
            seed: Number.isInteger(ollamaSeed) ? ollamaSeed : null,
            keepAlive: ollamaKeepAlive.trim(),
            enableThinking: ollamaEnableThinking,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        error = data.error || 'Failed to save Ollama config';
        return;
      }

      savedNotice = 'Ollama configuration saved. New requests will use these backend defaults unless a model or graph overrides them.';
      await loadStatus();
      await loadOllamaLoras(ollamaModel);
      statusRefreshTrigger.update(n => n + 1);
    } catch (err) {
      error = 'Failed to save Ollama config';
    } finally {
      savingOllamaConfig = false;
    }
  }

  async function controlLLMBackend(backend: 'ollama', action: 'start' | 'stop' | 'restart') {
    actionInProgress = `${backend}-${action}`;
    clearMessages();

    try {
      const endpoint = '/api/llm-backend/ollama';
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        error = data.error || `Failed to ${action} ${getBackendLabel(backend)}`;
        return;
      }
      await loadStatus();
    } catch (err) {
      error = `Failed to ${action} ${getBackendLabel(backend)}`;
    } finally {
      actionInProgress = null;
    }
  }

  async function loadBigBrotherConfig() {
    if (!mounted) return;
    bigBrotherRead?.abort();
    const controller = new AbortController();
    bigBrotherRead = controller;
    const draft = JSON.stringify([bigBrotherProvider, bigBrotherModel, bigBrotherReasoningEffort]);
    bigBrotherError = null;
    try {
      const res = await apiFetch('/api/big-brother-config', { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Big Brother configuration');
      controller.signal.throwIfAborted();
      bigBrotherConfig = data.config;
      if (JSON.stringify([bigBrotherProvider, bigBrotherModel, bigBrotherReasoningEffort]) === draft) {
        bigBrotherModel = data.config?.model || '';
        bigBrotherReasoningEffort = data.config?.reasoningEffort || '';
        bigBrotherProvider = data.config?.provider || 'claude-code';
      }
    } catch (err) {
      if (!controller.signal.aborted) bigBrotherError = err instanceof Error ? err.message : String(err);
    }
  }

  async function saveBigBrotherConfig() {
    const submitted = { model: bigBrotherModel, reasoningEffort: bigBrotherReasoningEffort, provider: bigBrotherProvider };
    const stillSubmitted = () => bigBrotherModel === submitted.model && bigBrotherReasoningEffort === submitted.reasoningEffort && bigBrotherProvider === submitted.provider;
    savingBigBrother = true;
    clearMessages();

    try {
      const res = await apiFetch('/api/big-brother-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitted),
      });

      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save Big Brother settings');
      if (!mounted) return;
      bigBrotherConfig = data.config;
      if (stillSubmitted()) {
        bigBrotherProvider = data.config.provider;
        bigBrotherModel = data.config.model || '';
        bigBrotherReasoningEffort = data.config.reasoningEffort || '';
      }
      statusRefreshTrigger.update(n => n + 1);
    } catch (cause) {
      if (!mounted) return;
      error = cause instanceof Error ? cause.message : String(cause);
      if (bigBrotherConfig && stillSubmitted()) {
        bigBrotherProvider = bigBrotherConfig.provider;
        bigBrotherModel = bigBrotherConfig.model || '';
        bigBrotherReasoningEffort = bigBrotherConfig.reasoningEffort || '';
      }
    } finally {
      savingBigBrother = false;
    }
  }

  async function testRemoteServerConnection() {
    if (!remoteServerUrl) {
      remoteServerTestResult = { success: false, error: 'Please enter a server URL' };
      return;
    }

    testingRemoteServer = true;
    remoteServerTestResult = null;
    clearMessages();

    try {
      const payload: Record<string, any> = { serverUrl: remoteServerUrl };
      if (remoteServerUsername && remoteServerPassword) {
        payload.username = remoteServerUsername;
        payload.password = remoteServerPassword;
      }

      const res = await apiFetch('/api/remote-server/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      remoteServerTestResult = res.ok ? data : { success: false, error: data.error || 'Test failed' };
    } catch (err) {
      remoteServerTestResult = { success: false, error: 'Failed to test connection' };
    } finally {
      testingRemoteServer = false;
    }
  }

  async function connectToRemoteServer() {
    if (!remoteServerUrl) {
      error = 'Please enter a server URL';
      return;
    }

    savingRemoteConfig = true;
    clearMessages();

    try {
      const payload: Record<string, any> = { serverUrl: remoteServerUrl };
      if (remoteServerUsername && remoteServerPassword) {
        payload.username = remoteServerUsername;
        payload.password = remoteServerPassword;
        payload.saveCredentials = remoteServerSaveCredentials;
      }

      const res = await apiFetch('/api/remote-server/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        if (!mounted) return;
        connectedRemoteUrl = data.sessionSaved ? data.serverUrl : connectedRemoteUrl;
        remoteServerTestResult = {
          success: true,
          latencyMs: data.latencyMs,
          serverVersion: data.serverVersion,
          models: data.models,
        };
        await loadStatus();
        statusRefreshTrigger.update(n => n + 1);
      } else {
        remoteServerTestResult = { success: false, error: data.error || 'Connection failed' };
      }
    } catch (err) {
      error = 'Failed to connect to server';
    } finally {
      savingRemoteConfig = false;
    }
  }

  async function disconnectRemoteServer() {
    savingRemoteConfig = true;
    clearMessages();

    try {
      const res = await apiFetch('/api/remote-server/disconnect', { method: 'DELETE' });
      if (res.ok) {
        remoteServerUrl = '';
        connectedRemoteUrl = '';
        remoteServerTestResult = null;
        await loadStatus();
        statusRefreshTrigger.update(n => n + 1);
      } else {
        const data = await res.json();
        error = data.error || 'Failed to disconnect';
      }
    } catch (err) {
      error = 'Failed to disconnect';
    } finally {
      savingRemoteConfig = false;
    }
  }

  function getBackendIcon(backend: string): string {
    switch (backend) {
      case 'llama-cpp': return '🦙';
      case 'ollama': return '🦙';
      case 'auto': return '🔄';
      case 'remote': return '🌐';
      default: return '❓';
    }
  }

  function getBackendLabel(backend: string): string {
    switch (backend) {
      case 'llama-cpp': return 'llama.cpp';
      case 'ollama': return 'Ollama';
      case 'auto': return 'Auto';
      case 'remote': return 'Remote';
      case 'offline': return 'Offline';
      default: return 'Unknown';
    }
  }

  function getBigBrotherProviderLabel(provider: string): string {
    const opt = bigBrotherProviderOptions.find(o => o.value === provider);
    return opt?.label || provider;
  }
</script>

<div>
  <h3 class="text-lg font-semibold mb-2 text-gray-900 dark:text-gray-100">Backend Configuration</h3>
  <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">
    Set the default chat route, manage local services, and keep utility models available for indexing and routed tasks.
  </p>

  {#if error || configError}
    <div class="banner banner-error mb-4">{error || configError}</div>
  {/if}

  {#if savedNotice}
    <div class="banner banner-warning mb-4">{savedNotice}</div>
  {/if}

  {#if statusWarning}
    <div class="banner banner-warning mb-4 flex items-center justify-between gap-3">
      <span>{statusWarning}</span>
      <button class="btn-secondary btn-sm shrink-0" on:click={loadStatus} disabled={statusLoading}>
        {statusLoading ? 'Checking...' : 'Retry status'}
      </button>
    </div>
  {/if}

  {#if loading}
    <div class="text-center py-8 text-gray-500">Loading backend settings...</div>
  {:else if !configLoaded}
    <div class="banner banner-error">Saved backend configuration is unavailable. <button class="btn-secondary" on:click={loadBackendSettings}>Reload configuration</button></div>
  {:else}
    <section class="panel p-4 mb-6 bg-gray-50 dark:bg-gray-900/50">
      <div class="flex items-start justify-between gap-4 mb-4">
        <div>
          <h4 class="text-base font-semibold mb-1 text-gray-800 dark:text-gray-100">Default Chat Backend</h4>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            This controls the normal chat route. It does not stop other services or prevent task-specific routing.
          </p>
        </div>
        <div class="text-right text-sm">
          <div class="text-gray-500 dark:text-gray-400">Resolved now</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100">
            {resolvedBackend ? `${getBackendIcon(resolvedBackend)} ${getBackendLabel(resolvedBackend)}` : 'Unavailable'}
          </div>
        </div>
      </div>

      {#if !isDefaultBackend(configuredActiveBackend)}
        <div class="banner banner-warning mb-4">
          Current config uses {getBackendLabel(configuredActiveBackend)}. Choose a backend below to make local chat routing explicit.
        </div>
      {/if}

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        {#each defaultBackendOptions as option}
          <button
            class="text-left rounded-lg border-2 p-4 transition-all bg-white dark:bg-gray-800 hover:border-violet-400 disabled:opacity-60 {activeBackend === option.value ? 'border-violet-500 dark:border-violet-400 shadow-sm shadow-violet-500/10' : 'border-gray-200 dark:border-gray-700'}"
            on:click={() => saveDefaultBackend(option.value)}
            disabled={savingDefault}
          >
            <div class="flex items-center gap-2 mb-2">
              <span class="text-xl">{getBackendIcon(option.value)}</span>
              <span class="font-semibold text-gray-900 dark:text-gray-100">{option.label}</span>
              {#if activeBackend === option.value}
                <span class="ml-auto text-xs px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">Selected</span>
              {/if}
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400">{option.description}</div>
          </button>
        {/each}
      </div>
    </section>

    <section class="mb-6">
      <h4 class="text-base font-semibold mb-3 text-gray-800 dark:text-gray-100">Local Service Control</h4>
      <div class="panel p-4 mb-4 {configuredActiveBackend === 'llama-cpp' ? 'border-2 border-violet-500 dark:border-violet-400' : ''}">
        <div class="flex items-center gap-2 mb-3">
          <h5 class="m-0 text-lg font-semibold text-gray-900 dark:text-gray-100">llama.cpp</h5>
          <span class="ml-auto text-sm">{available ? (available.llamaCpp?.running ? 'Running' : 'Offline') : 'Unavailable'}</span>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400">Connect to your existing llama-server. Start and stop it using its installed service. Context size must match the server; image input requires a vision model and projector.</p>
        {#if available?.llamaCpp?.error && llamaModel}
          <p class="text-sm text-red-600 dark:text-red-400">{available.llamaCpp.error}</p>
        {/if}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <label class="block text-sm"><span class="block mb-1">Server URL</span><input class="input-field font-mono" bind:value={llamaEndpoint} placeholder="http://127.0.0.1:8080" /></label>
          <label class="block text-sm"><span class="block mb-1">Served model name</span><input class="input-field font-mono" bind:value={llamaModel} placeholder="Model alias reported by the server" /></label>
          <label class="block text-sm"><span class="block mb-1">Context tokens</span><input class="input-field" type="number" min="256" max="1048576" bind:value={llamaContextWindow} /></label>
          <label class="block text-sm"><span class="block mb-1">Max output tokens (-1 = unlimited)</span><input class="input-field" type="number" min="-1" max={llamaContextWindow - 1} bind:value={llamaMaxTokens} /></label>
          <label class="block text-sm"><span class="block mb-1">Temperature</span><input class="input-field" type="number" min="0" max="5" step="0.1" bind:value={llamaTemperature} /></label>
          <label class="block text-sm"><span class="block mb-1">Top P</span><input class="input-field" type="number" min="0" max="1" step="0.05" bind:value={llamaTopP} /></label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={llamaImages} />Model supports image input</label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={llamaThinking} />Enable thinking</label>
        </div>
        <button class="btn-primary" on:click={saveLlamaConfig} disabled={savingLlama}>{savingLlama ? 'Saving…' : 'Save and use llama.cpp'}</button>
      </div>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div class="panel p-4 {configuredActiveBackend === 'ollama' ? 'border-2 border-violet-500 dark:border-violet-400' : ''}">
          <div class="flex items-center gap-2 mb-3">
            <span class="text-2xl">🦙</span>
            <div>
              <h5 class="m-0 text-lg font-semibold text-gray-900 dark:text-gray-100">Ollama</h5>
              <p class="m-0 text-xs text-gray-500 dark:text-gray-400">Local GGUF/chat service</p>
            </div>
            <span class="ml-auto w-2.5 h-2.5 rounded-full {available?.ollama.running ? 'bg-green-500' : available?.ollama.installed ? 'bg-red-500' : 'bg-gray-400'}"></span>
          </div>

          <div class="grid grid-cols-1 gap-3 mb-4">
            <label class="block text-sm">
              <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Default model</span>
              <select class="select-field w-full" bind:value={ollamaModelSelection} on:change={selectOllamaModel}>
                {#each ollamaArtifacts as artifact}
                  <option value={artifact.id}>
                    {artifact.displayName} · {artifact.modelType || artifact.architecture || artifact.format.toUpperCase()} · {formatArtifactSize(artifact.sizeBytes)}
                  </option>
                {/each}
                <option value="__custom__">
                  {ollamaModelSelection === '__custom__' && ollamaModel ? `Current custom model — ${ollamaModel}` : 'Custom Ollama model name…'}
                </option>
              </select>
              <span class="block mt-1 text-xs text-gray-500 dark:text-gray-400">
                Installed models are discovered from the same Ollama store used by the service.
              </span>
            </label>

            {#if selectedOllamaArtifact}
              <div class="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-900/10 p-3 text-sm">
                <div class="font-medium text-green-800 dark:text-green-200">Installed and available to Ollama</div>
                <div class="mt-1 text-xs text-green-700 dark:text-green-300">
                  {selectedOllamaArtifact.architecture || 'Architecture not reported'}{selectedOllamaArtifact.quantization ? ` · ${selectedOllamaArtifact.quantization}` : ''} · {formatArtifactSize(selectedOllamaArtifact.sizeBytes)}
                </div>
              </div>
            {:else}
              <label class="block text-sm">
                <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Custom model name</span>
                <input class="input-field font-mono" bind:value={ollamaModel} on:input={() => { loraRead?.abort(); ollamaLoraAdapters = []; }} on:change={() => loadOllamaLoras()} placeholder="model:tag" />
                <span class="block mt-1 text-xs text-gray-500 dark:text-gray-400">The model must already exist in the configured Ollama service.</span>
              </label>
            {/if}

            <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
              <div class="font-medium text-sm text-gray-800 dark:text-gray-200">Context and generation</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label class="block text-sm">
                  <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Context tokens</span>
                  <input class="input-field" type="number" min="256" max="1048576" step="1024" bind:value={ollamaContextWindow} />
                </label>
                <label class="block text-sm">
                  <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Max output tokens</span>
                  <input class="input-field" type="number" min="1" max="131072" step="256" bind:value={ollamaMaxTokens} />
                </label>
              </div>
              <p class="m-0 text-xs text-gray-500 dark:text-gray-400">
                Larger context uses more memory. Model and cognitive-graph settings can deliberately override these backend defaults.
              </p>
            </div>

            <button
              type="button"
              class="text-left text-sm font-medium text-violet-700 dark:text-violet-300 hover:underline"
              on:click={() => showOllamaAdvanced = !showOllamaAdvanced}
            >
              {showOllamaAdvanced ? 'Hide advanced configuration' : 'Advanced configuration'}
            </button>

            {#if showOllamaAdvanced}
              <div class="grid grid-cols-1 gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-black/[0.02] dark:bg-white/[0.02] p-3">
                <label class="block text-sm">
                  <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Endpoint</span>
                  <input class="input-field font-mono" bind:value={ollamaEndpoint} />
                </label>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label class="block text-sm">
                    <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Temperature</span>
                    <input class="input-field" type="number" min="0" max="5" step="0.05" bind:value={ollamaTemperature} />
                  </label>
                  <label class="block text-sm">
                    <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Top P</span>
                    <input class="input-field" type="number" min="0" max="1" step="0.01" bind:value={ollamaTopP} />
                  </label>
                  <label class="block text-sm">
                    <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Top K</span>
                    <input class="input-field" type="number" min="0" max="10000" step="1" bind:value={ollamaTopK} />
                  </label>
                  <label class="block text-sm">
                    <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Min P</span>
                    <input class="input-field" type="number" min="0" max="1" step="0.01" bind:value={ollamaMinP} />
                  </label>
                  <label class="block text-sm">
                    <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Repeat penalty</span>
                    <input class="input-field" type="number" min="0.1" max="5" step="0.05" bind:value={ollamaRepeatPenalty} />
                  </label>
                  <label class="block text-sm">
                    <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Seed</span>
                    <input class="input-field" type="number" min="0" step="1" bind:value={ollamaSeed} placeholder="Random" />
                  </label>
                </div>
                <label class="block text-sm">
                  <span class="block font-medium text-gray-700 dark:text-gray-300 mb-1">Keep model loaded</span>
                  <input class="input-field font-mono" bind:value={ollamaKeepAlive} placeholder="5m" />
                  <span class="block mt-1 text-xs text-gray-500 dark:text-gray-400">Examples: 5m, 1h, or 0 to unload after the request.</span>
                </label>
                <label class="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" bind:checked={ollamaEnableThinking} class="w-4 h-4 accent-violet-600" />
                  <span>Enable model-native thinking by default</span>
                </label>
              </div>
            {/if}

            <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <button
                type="button"
                class="w-full flex items-center justify-between text-left text-sm font-medium text-gray-800 dark:text-gray-200"
                on:click={() => showOllamaLoras = !showOllamaLoras}
              >
                <span>LoRA and fine-tuned models</span>
                <span aria-hidden="true">{showOllamaLoras ? '−' : '+'}</span>
              </button>

              {#if showOllamaLoras}
                <div class="mt-3 space-y-3">
                  <p class="m-0 text-xs text-gray-500 dark:text-gray-400">
                    Ollama packages a compatible LoRA with its exact base as a derived model. Already merged or previously created models appear in the main model dropdown above.
                  </p>
                  {#if loadingOllamaLoras}
                    <div class="text-xs text-gray-500">Loading profile adapters…</div>
                  {:else if loraError}
                    <div class="banner banner-error">{loraError}<button class="btn-secondary btn-sm" on:click={() => loadOllamaLoras()}>Reload adapters</button></div>
                  {:else if ollamaLoraAdapters.length === 0}
                    <div class="rounded-md bg-gray-50 dark:bg-gray-800 p-2 text-xs text-gray-500 dark:text-gray-400">
                      No profile LoRA directories containing adapter_model.safetensors and adapter_config.json were found.
                    </div>
                  {:else}
                    <div class="space-y-2">
                      {#each ollamaLoraAdapters as adapter}
                        <div class="rounded-md border border-gray-200 dark:border-gray-700 p-2 text-sm">
                          <div class="flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <div class="font-medium text-gray-800 dark:text-gray-200">
                                {adapter.name}
                                {#if adapter.compatibleWithTarget && adapter.supportedByOllama}
                                  <span class="ml-1 text-xs text-green-600 dark:text-green-400">Compatible</span>
                                {:else if adapter.compatibleWithTarget === false}
                                  <span class="ml-1 text-xs text-amber-600 dark:text-amber-400">Different base model</span>
                                {:else}
                                  <span class="ml-1 text-xs text-amber-600 dark:text-amber-400">Unavailable for Ollama</span>
                                {/if}
                              </div>
                              <div class="mt-1 text-xs text-gray-500 dark:text-gray-400 break-all">
                                {adapter.baseModel || 'Unknown base model'}{adapter.loraRank ? ` · rank ${adapter.loraRank}` : ''}{adapter.sizeBytes ? ` · ${formatArtifactSize(adapter.sizeBytes)}` : ''}
                              </div>
                              {#if adapter.unavailableReason}
                                <div class="mt-1 text-xs text-amber-700 dark:text-amber-300">{adapter.unavailableReason}</div>
                              {/if}
                            </div>
                            <button
                              type="button"
                              class="btn-secondary btn-sm shrink-0"
                              on:click={() => buildOllamaLora(adapter)}
                              disabled={Boolean(adapter.unavailableReason) || buildingOllamaLora !== null}
                            >
                              {buildingOllamaLora === adapter.name ? 'Building…' : 'Build & use'}
                            </button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>

            <p class="m-0 text-xs text-gray-500 dark:text-gray-400">
              Starts automatically with Ainekio OS when selected as the default backend.
            </p>
          </div>

          <div class="flex items-center gap-2 text-sm mb-4">
            <span class="text-gray-500 dark:text-gray-400">Status:</span>
            <span class="font-semibold {available?.ollama.running ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
              {!available ? 'Unavailable' : available.ollama.running ? 'Running' : available.ollama.installed ? 'Stopped' : 'Not installed'}
            </span>
            {#if available?.ollama.model}
              <span class="font-mono text-xs text-gray-500 dark:text-gray-400">• {available.ollama.model}</span>
            {/if}
          </div>

          <div class="flex gap-2 flex-wrap">
            <button class="btn-primary" on:click={saveOllamaConfig} disabled={savingOllamaConfig}>
              {savingOllamaConfig ? 'Saving...' : 'Save Ollama Config'}
            </button>
            {#if available?.ollama.running}
              <button class="btn-danger" on:click={() => controlLLMBackend('ollama', 'stop')} disabled={actionInProgress !== null}>
                {actionInProgress === 'ollama-stop' ? 'Stopping...' : 'Stop'}
              </button>
            {:else}
              <button class="btn-success" on:click={() => controlLLMBackend('ollama', 'start')} disabled={actionInProgress !== null || !available?.ollama.installed}>
                {actionInProgress === 'ollama-start' ? 'Starting...' : 'Start'}
              </button>
            {/if}
          </div>
        </div>


      </div>
    </section>

    <section class="panel p-4 mb-6 bg-blue-50/50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800">
      <h4 class="text-base font-semibold mb-2 text-blue-800 dark:text-blue-300">Remote Server</h4>
      <p class="text-sm text-blue-700 dark:text-blue-400 mb-3">
        Remote servers can stay available alongside local services for routed tasks and fallback model access.
      </p>

      {#if connectedRemoteUrl}<p class="text-sm">Saved remote connection: {connectedRemoteUrl}</p>{/if}
      <label for="remote-server" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Server URL</label>
      <input
        on:input={() => remoteServerTestResult = null}
        id="remote-server"
        type="text"
        bind:value={remoteServerUrl}
        placeholder="https://your-tunnel.trycloudflare.com"
        disabled={savingRemoteConfig || testingRemoteServer}
        class="input-field font-mono mb-3"
      />

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label class="block text-sm">
          <span class="block text-gray-600 dark:text-gray-400 mb-1">Username</span>
          <input type="text" bind:value={remoteServerUsername} on:input={() => remoteServerTestResult = null} placeholder="Your Ainekio OS username" disabled={savingRemoteConfig || testingRemoteServer} class="input-field" />
        </label>
        <label class="block text-sm">
          <span class="block text-gray-600 dark:text-gray-400 mb-1">Password</span>
          <input type="password" bind:value={remoteServerPassword} on:input={() => remoteServerTestResult = null} placeholder="Your password" disabled={savingRemoteConfig || testingRemoteServer} class="input-field" />
        </label>
      </div>

      <label class="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer mb-3">
        <input type="checkbox" bind:checked={remoteServerSaveCredentials} class="w-4 h-4 accent-violet-600" />
        <span>Save credentials for auto-connect</span>
      </label>

      <div class="flex gap-3 flex-wrap">
        <button class="btn-primary" on:click={testRemoteServerConnection} disabled={savingRemoteConfig || testingRemoteServer || !remoteServerUrl}>
          {testingRemoteServer ? 'Testing...' : 'Test Connection'}
        </button>
        <button class="btn-success" on:click={connectToRemoteServer} disabled={savingRemoteConfig || testingRemoteServer || !remoteServerUrl}>
          {savingRemoteConfig ? 'Connecting...' : 'Connect & Save'}
        </button>
        {#if connectedRemoteUrl}
          <button class="btn-danger" on:click={disconnectRemoteServer} disabled={savingRemoteConfig}>
            Disconnect
          </button>
        {/if}
      </div>

      {#if remoteServerTestResult}
        <div class="mt-4 p-3 rounded-lg text-sm {remoteServerTestResult.success ? 'bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700' : 'bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700'}">
          {#if remoteServerTestResult.success}
            <div class="font-medium text-green-700 dark:text-green-300">
              Server responded successfully{remoteServerTestResult.latencyMs ? ` (${remoteServerTestResult.latencyMs}ms)` : ''}
            </div>
            {#if remoteServerTestResult.models && remoteServerTestResult.models.length > 0}
              <div class="flex flex-wrap gap-1.5 mt-2">
                {#each remoteServerTestResult.models as model}
                  <span class="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded text-xs font-mono">{model.model}</span>
                {/each}
              </div>
            {/if}
          {:else}
            <div class="font-medium text-red-700 dark:text-red-300">Connection failed</div>
            <div class="mt-1 text-red-600 dark:text-red-400">{remoteServerTestResult.error || 'Unknown error'}</div>
          {/if}
        </div>
      {/if}
    </section>

    <section class="panel p-4 mb-6 bg-blue-50/50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800">
      <h4 class="text-base font-semibold mb-2 text-blue-800 dark:text-blue-300">Big Brother</h4>
      <p class="text-sm text-blue-700 dark:text-blue-400 mb-3">
        Choose Big Brother separately for each model role in the left Status widget. These settings select its CLI provider, model, and reasoning effort. Claude Code and Codex display their work in the terminal.
      </p>


      {#if bigBrotherError}<div class="banner banner-error">{bigBrotherError}<button class="btn-secondary" on:click={loadBigBrotherConfig}>Reload Big Brother settings</button></div>{/if}
      {#if bigBrotherConfig}
      <label for="big-brother-provider" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
      <select id="big-brother-provider" bind:value={bigBrotherProvider} on:change={() => { bigBrotherModel = ''; saveBigBrotherConfig(); }} disabled={savingBigBrother} class="select-field w-full mb-3">
        {#if !bigBrotherProviderOptions.some(option => option.value === bigBrotherProvider)}
          <option value={bigBrotherProvider} disabled>Unavailable provider — choose a replacement</option>
        {/if}
        {#each bigBrotherProviderOptions as opt}
          <option value={opt.value}>{opt.label} - {opt.description}</option>
        {/each}
      </select>

      {#if bigBrotherProvider === 'codex' || bigBrotherProvider === 'claude-code' || bigBrotherProvider === 'gemini'}
        <label for="big-brother-model" class="block text-sm font-medium mb-1">Model</label>
        <input id="big-brother-model" class="input-field w-full mb-3" bind:value={bigBrotherModel} on:change={saveBigBrotherConfig} disabled={savingBigBrother} placeholder="CLI default" />
      {/if}
      {#if bigBrotherProvider === 'codex' || bigBrotherProvider === 'gemini'}
        <label for="big-brother-reasoning" class="block text-sm font-medium mb-1">Reasoning effort</label>
        <select id="big-brother-reasoning" class="select-field w-full mb-3" bind:value={bigBrotherReasoningEffort} on:change={saveBigBrotherConfig} disabled={savingBigBrother}>
          <option value="">CLI backend setting</option>
          {#each (bigBrotherProvider === 'gemini' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'low', 'medium', 'high', 'xhigh', 'max']) as effort}
            <option value={effort}>{effort}</option>
          {/each}
        </select>
      {/if}

      <div class="bg-black/5 dark:bg-white/5 rounded-lg p-3 text-sm">
        <div class="flex justify-between py-1">
          <span class="text-gray-500 dark:text-gray-400">Provider:</span>
          <span class="font-medium text-gray-700 dark:text-gray-300">{getBigBrotherProviderLabel(bigBrotherProvider)}</span>
        </div>
      </div>

      {/if}
    </section>

  {/if}
</div>
