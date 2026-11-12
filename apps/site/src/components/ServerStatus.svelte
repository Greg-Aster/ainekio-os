<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch, getApiBaseUrl, isHostedUi, setBackendUrl } from '../lib/client/api-config';
  import {
    activeView,
    systemSection,
    statusStore,
    statusRefreshTrigger,
    graphEditorHref,
  } from '../stores/navigation';
  import { currentMode, isOwner } from '../stores/security-policy';
  import { MODEL_ROLE_OPTIONS } from '@metahuman/core/model-roles';
  import {
    buildModelRoleSections,
    buildBaseModelChoices,
    modelChoiceForAssignment,
    adapterChoiceForAssignment,
    modelAdapterLabel,
    type BaseModelChoice,
    type ModelInventoryEntry as AvailableModel,
    type ModelRolePresentation,
    type WorkflowModelSummary,
  } from '../lib/client/model-role-presentation';
  import {
    getRemoteSyncConfig,
    runProfileSyncAgent,
    type RemoteSyncConfig,
    type RemoteSyncProgress,
  } from '../lib/client/profile-sync';

  interface ServerInfo {
    name: string;
    displayName: string;
    endpoint: string;
    status: 'running' | 'stopped' | 'unknown';
    healthy: boolean;
    installed: boolean;
    details?: any;
  }

  function normalizeServerState(data: any): Pick<ServerInfo, 'status' | 'healthy'> {
    const readiness = typeof data?.readiness === 'string' ? data.readiness : '';
    const healthy = data?.healthy === true || readiness === 'ready';
    const running = data?.running === true || healthy || readiness === 'loading';

    return {
      status: running ? 'running' : 'stopped',
      healthy,
    };
  }

  interface LLMBackendInfo {
    llamaCpp: { configured: boolean; running: boolean; model?: string; endpoint: string; error?: string };
    activeBackend: 'llama-cpp' | 'auto' | 'ollama' | 'remote';
    resolvedBackend?: string;
    remote?: {
      provider?: string;
      serverUrl?: string;
      model?: string;
    };
    ollama: {
      installed: boolean;
      running: boolean;
      model?: string;
      endpoint: string;
    };
  }

  interface BigBrotherInfo {
    running: boolean;
    sessionOpen: boolean;
    healthy: boolean;
    provider?: string;
    phase: string;
  }

  interface EventBusInfo {
    running: boolean;
    healthy: boolean;
    endpoint: string;
    eventCount?: number;
    subscribers?: number;
  }

  interface ProfileStorageSummary {
    currentPath: string;
    defaultPath: string;
    usingCustomPath: boolean;
    usingFallback: boolean;
    storageType: string;
    isEncrypted?: boolean;
    encryptionType?: string;
  }

  interface StorageDeviceOption {
    id: string;
    path: string;
    type: string;
    label: string;
    mounted: boolean;
    writable: boolean;
    freeSpaceFormatted: string;
    suggestedPath: string;
  }

  type ModelRoleInfo = {
    modelId?: string;
    provider?: string;
    model?: string;
    capabilities?: string[];
    adapters?: string[];
    baseModel?: string | null;
    temperature?: number;
    error?: string;
    needsConfig?: boolean;
    unavailableReason?: string;
  };

  interface ModelCategories {
    local: AvailableModel[];
    remote: AvailableModel[];
    bigBrother: AvailableModel[];
  }

  type ModelConfigurationMode = 'dual' | 'agent' | 'emulation' | 'environment';

  const MODEL_CONFIGURATION_MODES: Array<{
    id: ModelConfigurationMode;
    label: string;
  }> = [
    { id: 'dual', label: 'Dual' },
    { id: 'agent', label: 'Agent work' },
    { id: 'emulation', label: 'Emulation' },
    { id: 'environment', label: 'Environment' },
  ];

  const CONFIGURABLE_MODEL_ROLES = MODEL_ROLE_OPTIONS.map(option => option.value);

  interface BackendAvailability {
    llamaCpp: { available: boolean; running: boolean; active: boolean; model?: string };
    ollama: { available: boolean; running: boolean; active: boolean; model?: string };
    runpod: { available: boolean; configured: boolean; active: boolean };
    bigBrother: { available: boolean; enabled: boolean; provider?: string };
    remoteServer: { available: boolean; configured: boolean; serverUrl?: string; connected?: boolean };
  }

  let servers: ServerInfo[] = [];
  let llmBackend: LLMBackendInfo | null = null;
  let bigBrother: BigBrotherInfo | null = null;
  let eventBus: EventBusInfo | null = null;
  let loading = true;
  let actionInProgress: string | null = null;
  let voiceActions: Record<string, boolean> = {};
  let voiceRemoteUrlInputs: Record<string, string> = {};
  let voiceOutputTarget: 'browser' | 'robot' | 'off' = 'browser';
  let voiceTtsProvider: 'kokoro' | 'piper' = 'kokoro';
  let voicePrefsLoaded = false;
  let savingVoicePref = false;
  let mounted = false;
  let closed = false;
  let isPageVisible = true;
  let statusFetchInProgress = false;
  let statusErrors: Record<string, string> = {};
  let actionNotice = '';
  let actionError = '';

  // Model registry & role routing state
  let registryRead: AbortController | undefined;
  let remoteRead: AbortController | undefined;
  let storageRead: AbortController | undefined;
  let voicePrefRead: AbortController | undefined;
  let syncAbort: AbortController | undefined;
  let remoteHealthLoading = false;
  let remoteHealthError = '';
  let modelRoles: Record<string, ModelRoleInfo> = {};
  let resolvedRoleModels: Record<string, ModelRoleInfo> = {};
  let workflowModels: WorkflowModelSummary[] = [];
  let hasModelRegistry = false;
  let availableModels: AvailableModel[] = [];
  let roleAssignments: Record<string, string> = {};
  let loraEnabled: Record<string, boolean> = {};
  let loadingModelRegistry = false;
  let modelConfigurationMode: ModelConfigurationMode = 'dual';
  let modelConfigurationError = '';
  let modelConfigurationNotice = '';
  let savingModelRole: string | null = null;
  let modelCategories: ModelCategories = {
    local: [],
    remote: [],
    bigBrother: [],
  };
  let backendAvailability: BackendAvailability = {
    llamaCpp: { available: false, running: false, active: false },
    ollama: { available: false, running: false, active: false },
    runpod: { available: false, configured: false, active: false },
    bigBrother: { available: false, enabled: false },
    remoteServer: { available: false, configured: false, connected: false },
  };

  // Profile storage & remote sync state
  let profileStorage: ProfileStorageSummary | null = null;
  let storageDevices: StorageDeviceOption[] = [];
  let syncConfig: RemoteSyncConfig | null = null;
  let switchingStorage = false;
  let syncingProfile = false;
  let syncProgressMessage = '';
  let storageNotice = '';
  let storageError = '';

  // Node & Remote Server configuration state
  let guiBrainNodeUrl = '';
  let showRemoteNodeConfig = false;
  let remoteNodeUrlInput = '';
  let remoteNodeUsername = '';
  let remoteNodePassword = '';
  let remoteNodeSaveSession = true;
  let remoteNodeBusy: 'test' | 'connect' | 'disconnect' | null = null;
  let remoteNodeNotice = '';
  let remoteNodeError = '';
  let remoteNodeLatencyMs: number | null = null;

  const STATUS_FETCH_TIMEOUT_MS = 15000;

  const serverConfigs = [
    { name: 'whisper', displayName: 'Whisper STT', endpoint: '/api/whisper-server' },
    { name: 'kokoro', displayName: 'Kokoro TTS', endpoint: '/api/kokoro-server' },
  ];

  async function fetchStatusEndpoint(endpoint: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(
      new DOMException(`Status request exceeded ${STATUS_FETCH_TIMEOUT_MS}ms`, 'TimeoutError')
    ), STATUS_FETCH_TIMEOUT_MS);

    try {
      return await apiFetch(endpoint, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  function reportStatusFetchFailure(label: string, error: unknown) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      console.debug(`[ServerStatus] ${label} status request timed out`);
    } else {
      console.error(`Failed to fetch ${label} status:`, error);
    }
    return `${label}: ${error instanceof Error ? error.message : String(error)}`;
  }

  async function fetchVoiceServiceStatus({ name, displayName, endpoint }: Pick<ServerInfo, 'name' | 'displayName' | 'endpoint'>): Promise<ServerInfo> {
    try {
      const response = await fetchStatusEndpoint(endpoint);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Status request failed (${response.status})`);
      if (typeof data.remoteUrl === 'string' && voiceRemoteUrlInputs[name] === undefined) {
        voiceRemoteUrlInputs = { ...voiceRemoteUrlInputs, [name]: data.remoteUrl };
      }
      return { name, displayName, endpoint, ...normalizeServerState(data), installed: data.installed, details: data };
    } catch (error) {
      reportStatusFetchFailure(displayName, error);
      return { name, displayName, endpoint, status: 'unknown', healthy: false, installed: false,
        details: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async function fetchServerStatus() {
    if (statusFetchInProgress) {
      console.log('[ServerStatus] Skipping refresh; previous refresh still running');
      return;
    }

    statusFetchInProgress = true;
    loading = servers.length === 0;
    const newServers: ServerInfo[] = [];
    const errors: Record<string, string> = {};

    try {
      const [, , , voiceResults] = await Promise.all([
        (async () => {
          try {
            const llmResponse = await fetchStatusEndpoint('/api/llm-backend/status');
            if (llmResponse.ok) {
              const data = await llmResponse.json();
              llmBackend = {
                activeBackend: data.config.activeBackend,
                resolvedBackend: data.active?.resolvedBackend,
                remote: data.config.remote,
                llamaCpp: { ...data.available.llamaCpp, endpoint: data.config.llamaCpp.endpoint },
                ollama: {
                  installed: data.available.ollama.installed,
                  running: data.available.ollama.running,
                  model: data.available.ollama.model,
                  endpoint: data.config.ollama.endpoint,
                },
              };
            } else throw new Error((await llmResponse.json()).error || `Status request failed (${llmResponse.status})`);
          } catch (error) {
            errors['LLM backend'] = reportStatusFetchFailure('LLM backend', error);
          }
        })(),
        (async () => {
          try {
            const bigBrotherResponse = await fetchStatusEndpoint('/api/big-brother-status');
            if (bigBrotherResponse.ok) {
              const data = await bigBrotherResponse.json();
              bigBrother = {
                running: data.running,
                sessionOpen: data.sessionOpen,
                healthy: data.healthy,
                provider: data.provider,
                phase: data.phase,
              };
            } else throw new Error((await bigBrotherResponse.json()).error || `Status request failed (${bigBrotherResponse.status})`);
          } catch (error) {
            errors['Big Brother'] = reportStatusFetchFailure('Big Brother', error);
            bigBrother = null;
          }
        })(),
        (async () => {
          try {
            const eventBusResponse = await fetchStatusEndpoint('/api/event-bus-status');
            if (eventBusResponse.ok) {
              const data = await eventBusResponse.json();
              eventBus = {
                running: data.running,
                healthy: data.healthy,
                endpoint: data.endpoint,
                eventCount: data.eventCount,
                subscribers: data.subscribers,
              };
            } else throw new Error((await eventBusResponse.json()).error || `Status request failed (${eventBusResponse.status})`);
          } catch (error) {
            errors['Event Bus'] = reportStatusFetchFailure('Event Bus', error);
            eventBus = null;
          }
        })(),
        Promise.all(serverConfigs.map(fetchVoiceServiceStatus)),
      ]);

      newServers.push(...voiceResults);
      servers = newServers;
    } finally {
      statusErrors = errors;
      if (newServers.length > 0 || servers.length === 0) {
        servers = newServers;
      }
      loading = false;
      statusFetchInProgress = false;
    }
  }

  function subscribeStatus() {
    return statusStore.subscribe((snapshot) => {
      const data = snapshot?.data;
      if (data?.systemHealth?.backendAvailability) {
        remoteRead?.abort();
        remoteHealthLoading = false;
        remoteHealthError = '';
        const wasConnected = backendAvailability.remoteServer?.serverUrl === data.systemHealth.backendAvailability.remoteServer?.serverUrl
          && backendAvailability.remoteServer?.connected || false;
        backendAvailability = {
          ...data.systemHealth.backendAvailability,
          remoteServer: {
            ...data.systemHealth.backendAvailability.remoteServer,
            connected: wasConnected,
          },
        };

        if (backendAvailability.remoteServer.configured && backendAvailability.remoteServer.serverUrl) {
          if (!remoteNodeUrlInput) {
            remoteNodeUrlInput = backendAvailability.remoteServer.serverUrl;
          }
          void checkRemoteServerConnection();
        }
      }
    });
  }

  async function testRemoteNode() {
    const serverUrl = remoteNodeUrlInput.trim() || backendAvailability.remoteServer.serverUrl || llmBackend?.remote?.serverUrl || '';
    if (!serverUrl || remoteNodeBusy) return;
    remoteNodeBusy = 'test';
    remoteNodeError = '';
    remoteNodeNotice = '';
    try {
      const payload: Record<string, any> = { serverUrl };
      if (remoteNodeUsername && remoteNodePassword) {
        payload.username = remoteNodeUsername;
        payload.password = remoteNodePassword;
      }
      const res = await apiFetch('/api/remote-server/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.authError || data.error || 'Remote node test failed');
      }
      remoteNodeLatencyMs = typeof data.latencyMs === 'number' ? data.latencyMs : null;
      const modelCount = Array.isArray(data.models) ? data.models.length : 0;
      remoteNodeNotice = `Reachable (${remoteNodeLatencyMs ?? 0}ms)${modelCount ? ` · ${modelCount} model(s)` : ''}${data.needsAuth ? ' · Auth required to connect' : ''}`;
    } catch (error) {
      remoteNodeError = (error as Error).message;
    } finally {
      remoteNodeBusy = null;
    }
  }

  async function connectRemoteNode() {
    const serverUrl = remoteNodeUrlInput.trim();
    if (!serverUrl || remoteNodeBusy) return;
    remoteNodeBusy = 'connect';
    remoteNodeError = '';
    remoteNodeNotice = '';
    try {
      const payload: Record<string, any> = {
        serverUrl,
        saveCredentials: remoteNodeSaveSession,
      };
      if (remoteNodeUsername && remoteNodePassword) {
        payload.username = remoteNodeUsername;
        payload.password = remoteNodePassword;
      }
      const res = await apiFetch('/api/remote-server/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to connect to remote node');
      }
      backendAvailability.remoteServer = {
        available: true,
        configured: true,
        serverUrl: data.serverUrl || serverUrl,
        connected: true,
      };
      remoteNodeLatencyMs = typeof data.latencyMs === 'number' ? data.latencyMs : null;
      remoteNodePassword = '';
      showRemoteNodeConfig = false;
      remoteNodeNotice = `Connected to ${data.serverUrl || serverUrl}.`;
      statusRefreshTrigger.update(n => n + 1);
      await Promise.all([fetchServerStatus(), loadModelRegistry()]);
    } catch (error) {
      remoteNodeError = (error as Error).message;
    } finally {
      remoteNodeBusy = null;
    }
  }

  async function disconnectRemoteNode() {
    if (remoteNodeBusy) return;
    remoteNodeBusy = 'disconnect';
    remoteNodeError = '';
    remoteNodeNotice = '';
    try {
      const res = await apiFetch('/api/remote-server/disconnect', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to disconnect remote node');
      }
      backendAvailability.remoteServer = {
        available: false,
        configured: false,
        serverUrl: undefined,
        connected: false,
      };
      remoteNodeNotice = 'Remote compute node disconnected.';
      statusRefreshTrigger.update(n => n + 1);
      await Promise.all([fetchServerStatus(), loadModelRegistry()]);
    } catch (error) {
      remoteNodeError = (error as Error).message;
    } finally {
      remoteNodeBusy = null;
    }
  }

  function applyGuiBrainNodeUrl() {
    try {
      setBackendUrl(guiBrainNodeUrl);
      actionNotice = guiBrainNodeUrl.trim()
        ? `GUI connected to Brain Node ${guiBrainNodeUrl.trim()}. Refreshing...`
        : 'GUI reset to same-origin Brain Node.';
      actionError = '';
      statusRefreshTrigger.update(n => n + 1);
      refreshAll();
    } catch (error) {
      actionError = (error as Error).message;
    }
  }

  async function checkRemoteServerConnection() {
    const serverUrl = backendAvailability.remoteServer.serverUrl;
    if (!serverUrl) return;

    remoteRead?.abort();
    if (closed) return;
    const current = remoteRead = new AbortController();
    remoteHealthLoading = true;
    remoteHealthError = '';
    try {
      const res = await apiFetch(`/api/remote-server/health?serverUrl=${encodeURIComponent(serverUrl)}`, { signal: current.signal });
      const data = await res.json();
      if (current.signal.aborted || backendAvailability.remoteServer.serverUrl !== serverUrl) return;
      backendAvailability.remoteServer.connected = res.ok && data.healthy;
      if (!backendAvailability.remoteServer.connected) remoteHealthError = data.error || 'Remote server health check failed';
    } catch (error) {
      if (current.signal.aborted) return;
      backendAvailability.remoteServer.connected = false;
      remoteHealthError = (error as Error).message;
    } finally {
      if (!current.signal.aborted) remoteHealthLoading = false;
    }
  }

  function getOllamaTooltip(ba: BackendAvailability['ollama']): string {
    if (!ba.available) return 'Ollama: Not installed';
    if (ba.running) return `Ollama: Running${ba.model ? ` (${ba.model})` : ''}${ba.active ? ' [ACTIVE]' : ''}`;
    return 'Ollama: Installed but not running';
  }
  function getRunPodTooltip(ba: BackendAvailability['runpod']): string {
    if (!ba.available) return 'RunPod: Not configured';
    return `RunPod: Configured${ba.active ? ' [ACTIVE]' : ''}`;
  }
  function getBigBrotherTooltip(ba: BackendAvailability['bigBrother']): string {
    if (!ba.available) return 'Big Brother: Not available';
    if (ba.enabled) return `Big Brother: Enabled (${ba.provider || 'claude-code'})`;
    return 'Big Brother: Disabled';
  }
  function getRemoteServerTooltip(ba: BackendAvailability['remoteServer'], pending: boolean, error: string, models: AvailableModel[]): string {
    if (!ba.configured) return 'Remote Server: Not configured - Configure in Settings → Backend';
    if (ba.connected) {
      const remoteModels = models.filter(m => m.provider === 'remote-server');
      const modelInfo = remoteModels.length > 0
        ? ` (${remoteModels.map(m => m.model).join(', ')})`
        : '';
      return `Remote Server: Connected${modelInfo}\n${ba.serverUrl}`;
    }
    return pending
      ? `Remote Server: Testing connection\n${ba.serverUrl}`
      : `Remote Server: Unreachable${error ? ` (${error})` : ''}\n${ba.serverUrl}`;
  }

  $: modelRoleSections = buildModelRoleSections(workflowModels, modelConfigurationMode);

  function isModelConfigurationMode(value: string): value is ModelConfigurationMode {
    return MODEL_CONFIGURATION_MODES.some(mode => mode.id === value);
  }

  function modelRolePresentation(role: string): ModelRolePresentation | undefined {
    return modelRoleSections
      .flatMap(section => section.roles)
      .find(presentation => presentation.role === role);
  }

  function modelRoleLabel(role: string): string {
    return modelRolePresentation(role)?.label || role;
  }

  function modelRoleDescription(role: string): string {
    return modelRolePresentation(role)?.description || role;
  }

  function modelRoleTooltip(role: string, info: ModelRoleInfo): string {
    return [modelRoleDescription(role), info.unavailableReason || info.error,
      `Assignment: ${info.modelId || 'unassigned'}`].filter(Boolean).join('\n');
  }

  function findAssignedModel(modelId: string): AvailableModel | undefined {
    return availableModels.find(model => (
      model.id === modelId || model.aliases?.includes(modelId)
    )) || discoveredModels.find(model => model.id === modelId);
  }

  function syncModelRoleDisplay(assignments: Record<string, string>) {
    const next: Record<string, ModelRoleInfo> = {};
    for (const role of CONFIGURABLE_MODEL_ROLES) {
      const modelId = assignments[role];
      if (resolvedRoleModels[role]) {
        next[role] = { ...resolvedRoleModels[role], modelId };
        continue;
      }
      if (!modelId) {
        next[role] = {
          needsConfig: true,
          unavailableReason: `No ${modelConfigurationMode}-mode model is assigned to ${role}`,
        };
        continue;
      }
      const selectedModel = findAssignedModel(modelId);
      if (!selectedModel) {
        next[role] = {
          modelId,
          model: modelId,
          needsConfig: true,
          unavailableReason: `Configured model ${modelId} is not present in this profile registry`,
        };
        continue;
      }
      next[role] = {
        modelId,
        provider: selectedModel.provider,
        model: selectedModel.model,
        capabilities: selectedModel.capabilities ?? [],
        adapters: selectedModel.adapters ?? [],
        baseModel: selectedModel.baseModel ?? undefined,
        temperature: Number(selectedModel.options?.temperature) || undefined,
      };
    }
    modelRoles = next;
    hasModelRegistry = Object.keys(next).length > 0;
  }

  async function selectBaseModel(role: string, key: string) {
    const choice = baseModelChoices.find(model => model.key === key);
    if (!choice) return;
    await assignModelToRole(role, choice.base.id, undefined,
      !choice.registeredBase && choice.provider === 'llama-cpp' ? choice.base : undefined);
  }

  async function toggleRoleLora(role: string, checked: boolean, choice: BaseModelChoice) {
    loraEnabled = { ...loraEnabled, [role]: checked };
    if (!checked) await selectBaseModel(role, choice.key);
  }

  async function loadModelRegistry(mode: ModelConfigurationMode = modelConfigurationMode) {
    registryRead?.abort();
    if (closed) return;
    const current = registryRead = new AbortController();
    loadingModelRegistry = true;
    modelConfigurationError = '';
    workflowModels = [];
    modelRoles = {};

    try {
      const queryParams = `?cognitiveMode=${encodeURIComponent(mode)}&_t=${Date.now()}`;
      const response = await apiFetch(`/api/model-registry${queryParams}`, { cache: 'no-store', signal: current.signal });
      const data = await response.json();

      if (current.signal.aborted || mode !== modelConfigurationMode) return;

      if (response.ok && data.success) {
        availableModels = data.availableModels || [];
        resolvedRoleModels = data.resolvedRoles || {};
        workflowModels = data.workflowModels || [];
        roleAssignments = { ...(data.roleAssignments || {}) };

        if (data.modelCategories) {
          modelCategories = {
            local: data.modelCategories.local || [],
            remote: data.modelCategories.remote || [],
            bigBrother: data.modelCategories.bigBrother || [],
          };
        }

        syncModelRoleDisplay(roleAssignments);
      } else {
        throw new Error(data.error || `Failed to load ${mode}-mode model assignments`);
      }
    } catch (error) {
      if (current.signal.aborted) return;
      console.error('Error loading model registry:', error);
      modelConfigurationError = (error as Error).message;
    } finally {
      if (!current.signal.aborted) loadingModelRegistry = false;
    }
  }

  function selectModelConfigurationMode(event: Event) {
    const mode = (event.currentTarget as HTMLSelectElement).value;
    if (!isModelConfigurationMode(mode)) return;
    modelConfigurationMode = mode;
    modelConfigurationNotice = '';
    loraEnabled = {};
    void loadModelRegistry(mode);
  }

  function isEmbedderOnlyModel(model: AvailableModel): boolean {
    return model.id === 'default.embedder'
      || model.model.toLowerCase().includes('embedding')
      || (Array.isArray(model.roles) && model.roles.length > 0 && model.roles.every(r => r === 'embedder'));
  }

  function resolveLocalPresetModelId(role: string): string | undefined {
    if (role === 'embedder') {
      return availableModels.find(m => m.id === 'default.embedder')?.id;
    }
    if (modelConfigurationMode === 'environment') {
      if (role === 'orchestrator') {
        const intentLoras = availableModels.filter(
          m => m.provider === 'llama-cpp'
            && m.model === 'environment-0.8b-base'
            && (m.metadata?.specialist === 'intent' || m.metadata?.specialist === 'intent_router')
        );
        const preferredIntent = intentLoras.find(m => m.id === 'llama-cpp-lora.86fc14e504119252') ?? intentLoras.at(-1);
        if (preferredIntent) return preferredIntent.id;
      }
      if (role === 'environmentActionSelector') {
        const actionLoras = availableModels.filter(
          m => m.provider === 'llama-cpp'
            && m.model === 'environment-0.8b-base'
            && (m.metadata?.specialist === 'task' || m.metadata?.specialist === 'task_action')
        );
        const preferredAction = actionLoras.find(m => m.id === 'llama-cpp-lora.701a50434e0383db') ?? actionLoras.at(-1);
        if (preferredAction) return preferredAction.id;
      }
    }
    const qwen9b = modelCategories.local.find(
      m => m.provider === 'llama-cpp'
        && !isEmbedderOnlyModel(m)
        && !(m.adapters?.length || m.options?.lora?.length)
        && m.model === 'qwen3.5:9b'
    );
    if (qwen9b) return qwen9b.id;
    const primaryLlama = modelCategories.local.find(
      m => m.provider === 'llama-cpp'
        && !isEmbedderOnlyModel(m)
        && !(m.adapters?.length || m.options?.lora?.length)
    );
    if (primaryLlama) return primaryLlama.id;
    const defaultRoleModel = availableModels.find(
      m => m.id === `default.${role}` && m.provider !== 'big-brother' && !isEmbedderOnlyModel(m)
    );
    if (defaultRoleModel) return defaultRoleModel.id;
    return modelCategories.local.find(m => !isEmbedderOnlyModel(m))?.id;
  }

  function resolveRemotePresetModelId(): string | undefined {
    const remoteCandidate = [...discoveredModels, ...modelCategories.remote].find(
      m => m.provider === 'remote-server' || m.provider === 'runpod_serverless'
    );
    if (remoteCandidate) return remoteCandidate.id;
    return 'big-brother.gemini';
  }

  async function applyModelPreset(preset: 'local' | 'hybrid' | 'bb-codex' | 'bb-gemini') {
    if (savingModelRole || loadingModelRegistry) return;
    const mode = modelConfigurationMode;
    savingModelRole = `preset:${preset}`;
    modelConfigurationError = '';
    modelConfigurationNotice = '';
    try {
      const hybridRemoteTarget = preset === 'hybrid' ? resolveRemotePresetModelId() : undefined;
      if (preset === 'bb-codex' || preset === 'bb-gemini' || hybridRemoteTarget === 'big-brother.gemini') {
        const bbPayload = preset === 'bb-codex'
          ? { enabled: true, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' }
          : { enabled: true, provider: 'gemini', model: 'gemini-3.8-flash-low', reasoningEffort: 'low' };
        const bbRes = await apiFetch('/api/big-brother-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bbPayload),
        });
        const bbData = await bbRes.json();
        if (!bbRes.ok || !bbData.success) {
          throw new Error(bbData.error || 'Failed to update Big Brother provider configuration');
        }
      }

      const allSectionRoles = modelRoleSections.flatMap(section => section.roles.map(r => r.role));
      const targetRoles = Array.from(new Set([
        ...allSectionRoles,
        'persona',
        'orchestrator',
        'autonomy',
        'lightweight',
        ...(mode === 'environment' ? ['environmentActionSelector', 'environmentVision'] : []),
      ])).filter(role => role !== 'embedder');

      const fastEdgeRoles = new Set(['orchestrator', 'environmentActionSelector']);

      for (const role of targetRoles) {
        let targetModelId: string | undefined;
        if (preset === 'local') {
          targetModelId = resolveLocalPresetModelId(role);
        } else if (preset === 'hybrid') {
          targetModelId = fastEdgeRoles.has(role)
            ? resolveLocalPresetModelId(role)
            : (hybridRemoteTarget || resolveLocalPresetModelId(role));
        } else if (preset === 'bb-codex') {
          targetModelId = 'big-brother.codex';
        } else {
          targetModelId = 'big-brother.gemini';
        }
        if (!targetModelId || roleAssignments[role] === targetModelId) continue;
        const response = await apiFetch('/api/model-registry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, modelId: targetModelId, cognitiveMode: mode }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || `Failed to assign ${role}`);
        }
      }

      loraEnabled = {};
      const presetLabel = preset === 'local'
        ? 'Local'
        : preset === 'hybrid'
          ? 'Hybrid (0.8B Edge + BB-Gemini ACP)'
          : preset === 'bb-codex'
            ? 'BB-Codex'
            : 'BB-Gemini';
      modelConfigurationNotice = `${presetLabel} preset loaded for ${MODEL_CONFIGURATION_MODES.find(item => item.id === mode)?.label || mode}.`;
      statusRefreshTrigger.update(n => n + 1);
      await loadModelRegistry(mode);
    } catch (error) {
      console.error('Error applying model preset:', error);
      modelConfigurationError = (error as Error).message;
    } finally {
      savingModelRole = null;
      loraEnabled = {};
    }
  }

  async function assignModelToRole(role: string, modelId: string, cognitiveModeOverride?: string, baseDefinition?: AvailableModel) {
    if (savingModelRole) return;
    const modeCandidate = cognitiveModeOverride || modelConfigurationMode;
    if (!isModelConfigurationMode(modeCandidate)) {
      modelConfigurationError = `Unsupported model configuration mode: ${modeCandidate}`;
      return;
    }
    const mode = modeCandidate;
    savingModelRole = role;
    modelConfigurationError = '';
    modelConfigurationNotice = '';
    try {
      if (baseDefinition) {
        const registration = await apiFetch('/api/model-registry', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: 'register', model: baseDefinition }),
        });
        const registered = await registration.json();
        if (!registration.ok || !registered.success) throw new Error(registered.error || 'Failed to register base model');
        modelId = registered.modelId;
      }
      const payload: Record<string, any> = { role, modelId, cognitiveMode: mode };

      const response = await apiFetch('/api/model-registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        loraEnabled = {};
        modelConfigurationNotice = `${modelRoleLabel(role)} saved for ${MODEL_CONFIGURATION_MODES.find(item => item.id === mode)?.label || mode}.`;
        statusRefreshTrigger.update(n => n + 1);
        await loadModelRegistry();
      } else {
        throw new Error(result.error || 'Failed to save model assignment');
      }
    } catch (error) {
      console.error('Error assigning model:', error);
      modelConfigurationError = (error as Error).message;
    } finally {
      if (savingModelRole === role) savingModelRole = null;
      loraEnabled = {};
    }
  }

  async function switchDefaultBackend(target: 'llama-cpp' | 'ollama' | 'auto' | 'remote') {
    if (actionInProgress) return;
    actionInProgress = `backend-${target}`;
    actionError = '';
    actionNotice = '';
    try {
      const updates: Record<string, any> = { activeBackend: target };
      if (target === 'llama-cpp') {
        updates.preferredLocalBackend = 'llama-cpp';
      } else if (target === 'ollama') {
        updates.preferredLocalBackend = 'ollama';
        updates.ollama = { autoStart: true };
      } else if (target === 'remote') {
        updates.remote = { provider: 'server' };
      }
      const response = await apiFetch('/api/llm-backend/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to switch default backend');
      }
      actionNotice = `Default backend switched to ${target === 'llama-cpp' ? 'llama.cpp' : target === 'remote' ? 'Remote Server' : target}.`;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('backend-changed', { detail: { backend: target } }));
      }
      statusRefreshTrigger.update(n => n + 1);
      await fetchServerStatus();
    } catch (error) {
      actionError = (error as Error).message;
    } finally {
      actionInProgress = null;
    }
  }

  function openBackendSettings() {
    systemSection.set('backend');
    activeView.set('system');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mh-open-system-tab', { detail: { tab: 'backend' } }));
    }
  }

  function openVoiceSettings() {
    activeView.set('voice');
  }

  function openStorageSettings() {
    systemSection.set('storage');
    activeView.set('system');
  }

  async function controlBigBrother(action: 'stop') {
    actionInProgress = `bigbrother-${action}`;
    try {
      const response = await apiFetch('/api/big-brother-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        alert(`Failed to ${action} Big Brother: ${data.error || 'Unknown error'}`);
      } else {
        await fetchServerStatus();
      }
    } catch (error) {
      alert(`Error ${action}ing Big Brother: ${(error as Error).message}`);
    } finally {
      actionInProgress = null;
    }
  }

  async function switchBigBrotherProvider(provider: 'codex' | 'claude-code' | 'gemini') {
    if (actionInProgress) return;
    actionInProgress = `bb-provider-${provider}`;
    actionError = '';
    actionNotice = '';
    try {
      const response = await apiFetch('/api/big-brother-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, provider }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to update Big Brother provider');
      }
      actionNotice = `Big Brother provider set to ${provider}.`;
      statusRefreshTrigger.update(n => n + 1);
      await fetchServerStatus();
    } catch (error) {
      actionError = (error as Error).message;
    } finally {
      actionInProgress = null;
    }
  }

  async function controlEventBus(action: 'start' | 'stop' | 'restart') {
    actionInProgress = `eventbus-${action}`;
    try {
      const response = await apiFetch('/api/event-bus-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        alert(`Failed to ${action} Event Bus: ${data.error || 'Unknown error'}`);
      } else {
        await fetchServerStatus();
      }
    } catch (error) {
      alert(`Error ${action}ing Event Bus: ${(error as Error).message}`);
    } finally {
      actionInProgress = null;
    }
  }

  async function controlServer(server: ServerInfo, action: 'start' | 'stop') {
    const pending = `${server.name}-${action}`;
    voiceActions[pending] = true;
    try {
      const response = await apiFetch(server.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        alert(`Failed to ${action} ${server.displayName}: ${data.error || data.message || 'Unknown error'}`);
      } else {
        const updated = await fetchVoiceServiceStatus(server);
        servers = servers.map(current => current.name === server.name ? updated : current);
      }
    } catch (error) {
      alert(`Error ${action}ing ${server.displayName}: ${(error as Error).message}`);
    } finally {
      const updated = { ...voiceActions };
      delete updated[pending];
      voiceActions = updated;
    }
  }

  async function setVoiceServiceTarget(server: ServerInfo, target: 'local' | 'remote', customRemoteUrl?: string) {
    const pending = `${server.name}-target`;
    voiceActions = { ...voiceActions, [pending]: true };
    try {
      const remoteUrl = customRemoteUrl !== undefined ? customRemoteUrl : voiceRemoteUrlInputs[server.name];
      const response = await apiFetch(server.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-target', target, remoteUrl }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        alert(`Failed to switch ${server.displayName} target: ${data.error || data.message || 'Unknown error'}`);
      } else {
        const updated = await fetchVoiceServiceStatus(server);
        servers = servers.map(current => current.name === server.name ? updated : current);
      }
    } catch (error) {
      alert(`Error switching ${server.displayName} target: ${(error as Error).message}`);
    } finally {
      const updated = { ...voiceActions };
      delete updated[pending];
      voiceActions = updated;
    }
  }

  async function loadVoicePreferences() {
    voicePrefRead?.abort();
    if (closed) return;
    const current = voicePrefRead = new AbortController();
    try {
      const response = await apiFetch('/api/voice-settings', { signal: current.signal });
      if (!response.ok) return;
      const data = await response.json();
      if (current.signal.aborted) return;
      if (data.tts?.outputTarget) voiceOutputTarget = data.tts.outputTarget;
      if (data.tts?.provider) voiceTtsProvider = data.tts.provider;
      voicePrefsLoaded = true;
    } catch {
      // Non-fatal in sidebar widget
    }
  }

  async function saveVoiceQuickPref(patch: { outputTarget?: 'browser' | 'robot' | 'off'; provider?: 'kokoro' | 'piper' }) {
    if (savingVoicePref) return;
    savingVoicePref = true;
    try {
      const response = await apiFetch('/api/voice-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (response.ok) {
        if (patch.outputTarget) voiceOutputTarget = patch.outputTarget;
        if (patch.provider) voiceTtsProvider = patch.provider;
      }
    } catch (error) {
      console.error('Failed to update voice preference:', error);
    } finally {
      savingVoicePref = false;
    }
  }

  async function loadProfileStorage() {
    storageRead?.abort();
    if (closed) return;
    const current = storageRead = new AbortController();
    storageError = '';
    try {
      const [pathRes, devRes, syncRes] = await Promise.allSettled([
        apiFetch('/api/profile-path', { signal: current.signal }),
        apiFetch('/api/profile-path/devices', { signal: current.signal }),
        getRemoteSyncConfig({ signal: current.signal }),
      ]);
      if (current.signal.aborted) return;
      if (pathRes.status === 'fulfilled' && pathRes.value.ok) {
        profileStorage = await pathRes.value.json();
      }
      if (devRes.status === 'fulfilled' && devRes.value.ok) {
        const devData = await devRes.value.json();
        storageDevices = devData.devices || [];
      }
      if (syncRes.status === 'fulfilled') {
        syncConfig = syncRes.value;
      }
    } catch (error) {
      if (!current.signal.aborted) {
        storageError = (error as Error).message;
      }
    }
  }

  async function switchProfileLocation(targetPath: string) {
    if (switchingStorage) return;
    switchingStorage = true;
    storageError = '';
    storageNotice = '';
    try {
      if (targetPath === '__default__') {
        const response = await apiFetch('/api/profile-path', { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Failed to reset to default profile path');
        storageNotice = 'Switched to default local profile storage.';
      } else {
        const response = await apiFetch('/api/profile-path', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: targetPath, type: 'external' }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Failed to switch profile storage location');
        storageNotice = `Switched profile storage to ${targetPath}.`;
      }
      statusRefreshTrigger.update(n => n + 1);
      await loadProfileStorage();
    } catch (error) {
      storageError = (error as Error).message;
    } finally {
      switchingStorage = false;
    }
  }

  async function triggerProfileSync() {
    if (syncingProfile) return;
    syncAbort?.abort();
    const current = syncAbort = new AbortController();
    syncingProfile = true;
    storageError = '';
    storageNotice = '';
    syncProgressMessage = 'Starting Profile Sync...';
    try {
      const result = await runProfileSyncAgent(
        [],
        (progress: RemoteSyncProgress) => {
          syncProgressMessage = progress.message;
        },
        { signal: current.signal },
      );
      if (current.signal.aborted) return;
      if (!result.success) {
        throw new Error(result.error || 'Profile Sync failed');
      }
      storageNotice = 'Memories & Persona synced with remote server.';
      statusRefreshTrigger.update(n => n + 1);
      await loadProfileStorage();
    } catch (error) {
      if (!current.signal.aborted) {
        storageError = (error as Error).message;
      }
    } finally {
      if (syncAbort === current) {
        syncingProfile = false;
        syncProgressMessage = '';
      }
    }
  }

  function getStatusIcon(server: ServerInfo): string {
    if (server.status === 'unknown') return '⚪';
    if (!server.installed) return '⚠️';
    if (server.status === 'running' && server.healthy) return '🟢';
    if (server.status === 'running' && !server.healthy) return '🟡';
    if (server.status === 'stopped') return '🔴';
    return '⚪';
  }

  function getStatusText(server: ServerInfo): string {
    if (server.status === 'unknown') return 'Unknown';
    if (!server.installed) return 'Not Installed';
    if (server.details?.readiness === 'loading') return 'Starting...';
    if (server.details?.readiness === 'error') return 'Error';
    if (server.status === 'running' && server.healthy) return 'Running';
    if (server.status === 'running' && !server.healthy) return 'Unhealthy';
    if (server.status === 'stopped') return 'Stopped';
    return 'Unknown';
  }

  function refreshAll() {
    void fetchServerStatus();
    void loadModelRegistry();
    void loadProfileStorage();
    void loadVoicePreferences();
  }

  $: if (mounted && isPageVisible) void fetchServerStatus();

  function handleVisibilityChange() {
    isPageVisible = !document.hidden;
    if (!document.hidden && mounted) {
      void loadModelRegistry();
    }
  }

  onMount(() => {
    closed = false;
    isPageVisible = !document.hidden;
    mounted = true;
    const unsubscribeStatus = subscribeStatus();
    void loadProfileStorage();
    void loadVoicePreferences();

    let lastActiveMode: string | undefined;
    const modeUnsubscribe = currentMode.subscribe(activeMode => {
      if (!isModelConfigurationMode(activeMode) || activeMode === lastActiveMode) return;
      lastActiveMode = activeMode;
      modelConfigurationMode = activeMode;
      modelConfigurationNotice = '';
      loraEnabled = {};
      void loadModelRegistry(activeMode);
    });

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (typeof getApiBaseUrl === 'function') {
      guiBrainNodeUrl = getApiBaseUrl();
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('backend-changed', fetchServerStatus);
    }
    return () => {
      closed = true;
      mounted = false;
      registryRead?.abort();
      remoteRead?.abort();
      storageRead?.abort();
      voicePrefRead?.abort();
      syncAbort?.abort();
      modeUnsubscribe();
      unsubscribeStatus();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (typeof window !== 'undefined') {
        window.removeEventListener('backend-changed', fetchServerStatus);
      }
    };
  });

  $: discoveredModels = ($statusStore?.data?.systemHealth?.cloudModels || []) as AvailableModel[];
  $: bigBrotherDropdownModels = modelCategories.bigBrother.filter(
    model => model.id !== 'big-brother.configured'
      || Object.values(roleAssignments).includes('big-brother.configured')
  );
  $: baseModelChoices = buildBaseModelChoices([
    ...discoveredModels,
    ...modelCategories.local,
    ...modelCategories.remote,
    ...bigBrotherDropdownModels,
    ...Object.values(roleAssignments).flatMap(id => {
      const model = findAssignedModel(id);
      return model ? [model] : [];
    }),
  ]);
  $: activePreset = (() => {
    const checkRoles = [
      'persona',
      'orchestrator',
      ...(modelConfigurationMode === 'environment' ? ['environmentActionSelector'] : []),
    ].filter(role => Boolean(roleAssignments[role]));
    if (checkRoles.length === 0) return 'custom';
    const assigned = checkRoles.map(role => roleAssignments[role]);
    if (assigned.every(id => id === 'big-brother.codex' || (id === 'big-brother.configured' && backendAvailability.bigBrother.provider === 'codex'))) {
      return 'bb-codex';
    }
    if (assigned.every(id => id === 'big-brother.gemini' || (id === 'big-brother.configured' && backendAvailability.bigBrother.provider === 'gemini'))) {
      return 'bb-gemini';
    }
    if (assigned.every(id => id.startsWith('gemini.'))) {
      return 'gemini-api';
    }
    const isLocalModel = (id: string) => {
      const m = findAssignedModel(id);
      return m
        ? (!isEmbedderOnlyModel(m) && (m.provider === 'llama-cpp' || m.provider === 'ollama' || m.provider === 'local'))
        : !id.startsWith('big-brother.') && !id.startsWith('remote-server:') && !id.startsWith('gemini.');
    };
    if (assigned.every(isLocalModel)) {
      return 'local';
    }
    if (roleAssignments.orchestrator && isLocalModel(roleAssignments.orchestrator) && roleAssignments.persona && !isLocalModel(roleAssignments.persona)) {
      return 'hybrid';
    }
    return 'custom';
  })();
</script>

<div class="flex flex-col h-full p-4 gap-3 overflow-hidden">
  <div class="flex justify-between items-center">
    <div>
      <h3 class="text-base font-semibold text-gray-900 dark:text-gray-100 m-0">Servers & Placement</h3>
      <p class="text-[0.6875rem] text-gray-500 dark:text-gray-400 m-0">Local Q6A, Remote Host & Cloud Routing</p>
    </div>
    <button
      class="bg-transparent border border-black/10 dark:border-white/20 rounded-md px-2 py-1 cursor-pointer text-base transition-all hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
      on:click={refreshAll}
      disabled={loading}
      title="Refresh server statuses and routing"
    >
      {loading ? '⏳' : '🔄'}
    </button>
  </div>

  {#if Object.keys(statusErrors).length}
    <div class="banner banner-error">
      {#each Object.values(statusErrors) as error}<p>{error}</p>{/each}
    </div>
  {/if}
  {#if actionError}
    <div class="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-300" role="alert">
      {actionError}
    </div>
  {:else if actionNotice}
    <div class="rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-300" role="status">
      {actionNotice}
    </div>
  {/if}

  {#if loading && servers.length === 0 && !llmBackend && !bigBrother && !eventBus}
    <div class="text-center py-8 text-gray-500 dark:text-gray-400 text-sm">Loading server status...</div>
  {:else}
    <div class="flex flex-col gap-3 overflow-y-auto pr-0.5">
      <!-- 1. Compute Host & Default LLM Backend -->
      {#if llmBackend}
        <div class="flex items-center gap-2 pt-1 font-semibold text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <span class="text-base">🧠</span>
          <span class="flex-1">LLM Backend & Host</span>
          {#if statusErrors['LLM backend']}
            <span class="normal-case font-normal">Last known status · refresh unavailable</span>
          {/if}
        </div>

        <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 border-black/10 dark:border-white/10">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-gray-700 dark:text-gray-300">Default Backend</span>
            <button class="text-[0.6875rem] text-violet-600 dark:text-violet-400 underline bg-transparent border-0 p-0 cursor-pointer" on:click={openBackendSettings}>
              Configure backend
            </button>
          </div>
          <div class="grid grid-cols-3 gap-1 p-1 rounded-lg bg-black/5 dark:bg-white/5 mb-2.5" role="group" aria-label="Default LLM Backend">
            {#each [
              { id: 'llama-cpp', label: 'llama.cpp' },
              { id: 'remote', label: 'Remote' },
              { id: 'auto', label: 'Auto' },
            ] as option (option.id)}
              <button
                type="button"
                class="py-1 px-1.5 rounded text-[0.68rem] font-semibold transition-all cursor-pointer border-0 {llmBackend.activeBackend === option.id ? 'bg-violet-600 text-white shadow-sm' : 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5'}"
                disabled={actionInProgress !== null || !$isOwner}
                on:click={() => switchDefaultBackend(option.id as 'llama-cpp' | 'remote' | 'auto')}
              >
                {option.label}
              </button>
            {/each}
          </div>

          {#if llmBackend.llamaCpp.configured}
            <div class="rounded-md p-2 mb-2 bg-black/[0.02] dark:bg-white/[0.03] border {llmBackend.activeBackend === 'llama-cpp' ? 'border-emerald-500/50' : 'border-gray-200 dark:border-gray-700'}">
              <div class="flex items-center justify-between text-xs">
                <strong>llama.cpp</strong>
                <span class={llmBackend.llamaCpp.running ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-gray-500'}>
                  {llmBackend.llamaCpp.running ? 'Running' : 'Offline'}
                </span>
              </div>
              <div class="text-xs font-mono mt-1 text-gray-800 dark:text-gray-200">{llmBackend.llamaCpp.model || 'No default model'}</div>
              <div class="text-[0.6875rem] text-gray-500 mt-0.5">{llmBackend.llamaCpp.endpoint}</div>
              {#if llmBackend.llamaCpp.error}<p class="text-xs text-red-500 mt-1 mb-0">{llmBackend.llamaCpp.error}</p>{/if}
            </div>
          {/if}

          <div class="rounded-md p-2 mt-2 bg-black/[0.02] dark:bg-white/[0.03] border {backendAvailability.remoteServer.connected ? 'border-cyan-500/50' : 'border-gray-200 dark:border-gray-700'}">
            <div class="flex items-center justify-between text-xs gap-1">
              <span class="font-semibold text-gray-900 dark:text-gray-100">🌐 Remote Compute Node</span>
              <div class="flex items-center gap-2">
                {#if backendAvailability.remoteServer.configured || llmBackend.remote?.serverUrl}
                  <button
                    type="button"
                    class="text-[0.6875rem] text-cyan-600 dark:text-cyan-400 underline bg-transparent border-0 p-0 cursor-pointer"
                    on:click={checkRemoteServerConnection}
                    disabled={remoteHealthLoading}
                    title={getRemoteServerTooltip(backendAvailability.remoteServer, remoteHealthLoading, remoteHealthError, discoveredModels)}
                  >
                    {remoteHealthLoading ? 'Checking…' : backendAvailability.remoteServer.connected ? '🟢 Connected' : '🔴 Check host'}
                  </button>
                {/if}
                <button
                  type="button"
                  class="text-[0.65rem] text-gray-600 dark:text-gray-300 underline bg-transparent border-0 p-0 cursor-pointer"
                  on:click={() => {
                    showRemoteNodeConfig = !showRemoteNodeConfig;
                    if (!remoteNodeUrlInput) {
                      remoteNodeUrlInput = backendAvailability.remoteServer.serverUrl || llmBackend?.remote?.serverUrl || '';
                    }
                  }}
                >
                  {showRemoteNodeConfig ? 'Close' : (backendAvailability.remoteServer.configured || llmBackend.remote?.serverUrl) ? 'Edit Node' : '+ Connect Node'}
                </button>
              </div>
            </div>
            {#if backendAvailability.remoteServer.serverUrl || llmBackend.remote?.serverUrl}
              <div class="text-[0.6875rem] text-gray-500 dark:text-gray-400 mt-0.5 break-all">
                {backendAvailability.remoteServer.serverUrl || llmBackend.remote?.serverUrl}
              </div>
            {:else if !showRemoteNodeConfig}
              <div class="text-[0.6875rem] text-gray-500 dark:text-gray-400 mt-0.5">
                No remote compute node configured (e.g. dndiy or cloud host)
              </div>
            {/if}
            {#if remoteHealthError && !backendAvailability.remoteServer.connected}
              <div class="text-[0.6875rem] text-red-500 mt-0.5">{remoteHealthError}</div>
            {/if}
            {#if remoteNodeError}
              <div class="text-[0.6875rem] text-red-500 mt-1">{remoteNodeError}</div>
            {:else if remoteNodeNotice}
              <div class="text-[0.6875rem] text-emerald-600 dark:text-emerald-400 mt-1">{remoteNodeNotice}</div>
            {/if}

            {#if showRemoteNodeConfig}
              <div class="mt-2 pt-2 border-t border-black/10 dark:border-white/10 flex flex-col gap-1.5">
                <input
                  type="url"
                  class="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-[0.7rem] text-gray-900 dark:text-gray-100"
                  placeholder="https://dndiy.ainek.io or http://192.168.1.x:4321"
                  bind:value={remoteNodeUrlInput}
                  disabled={remoteNodeBusy !== null || !$isOwner}
                />
                <div class="grid grid-cols-2 gap-1">
                  <input
                    type="text"
                    class="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-[0.68rem] text-gray-900 dark:text-gray-100"
                    placeholder="Username (if auth)"
                    bind:value={remoteNodeUsername}
                    disabled={remoteNodeBusy !== null || !$isOwner}
                  />
                  <input
                    type="password"
                    class="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-[0.68rem] text-gray-900 dark:text-gray-100"
                    placeholder="Password"
                    bind:value={remoteNodePassword}
                    disabled={remoteNodeBusy !== null || !$isOwner}
                  />
                </div>
                <div class="flex gap-1.5">
                  <button
                    type="button"
                    class="flex-1 py-1 px-2 rounded text-[0.68rem] font-semibold bg-gray-600 text-white hover:bg-gray-700 border-0 cursor-pointer disabled:opacity-50"
                    disabled={remoteNodeBusy !== null || !remoteNodeUrlInput.trim() || !$isOwner}
                    on:click={testRemoteNode}
                  >
                    {remoteNodeBusy === 'test' ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    type="button"
                    class="flex-1 py-1 px-2 rounded text-[0.68rem] font-semibold bg-cyan-600 text-white hover:bg-cyan-700 border-0 cursor-pointer disabled:opacity-50"
                    disabled={remoteNodeBusy !== null || !remoteNodeUrlInput.trim() || !$isOwner}
                    on:click={connectRemoteNode}
                  >
                    {remoteNodeBusy === 'connect' ? 'Connecting…' : 'Connect'}
                  </button>
                  {#if backendAvailability.remoteServer.configured}
                    <button
                      type="button"
                      class="py-1 px-2 rounded text-[0.68rem] font-semibold bg-red-500/80 text-white hover:bg-red-600 border-0 cursor-pointer disabled:opacity-50"
                      disabled={remoteNodeBusy !== null || !$isOwner}
                      on:click={disconnectRemoteNode}
                    >
                      {remoteNodeBusy === 'disconnect' ? '…' : 'Disconnect'}
                    </button>
                  {/if}
                </div>
              </div>
            {/if}
          </div>

          {#if (typeof isHostedUi === 'function' && isHostedUi()) || guiBrainNodeUrl}
            <div class="rounded-md p-2 mt-2 bg-black/[0.02] dark:bg-white/[0.03] border border-violet-500/30">
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="font-semibold text-gray-900 dark:text-gray-100">🖥️ GUI Brain Node Target</span>
                <span class="text-[0.65rem] text-violet-600 dark:text-violet-400">{guiBrainNodeUrl ? 'Remote API' : 'Same-Origin'}</span>
              </div>
              <div class="flex gap-1">
                <input
                  type="url"
                  class="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-[0.68rem] text-gray-900 dark:text-gray-100"
                  placeholder="https://q6a.ainek.io"
                  bind:value={guiBrainNodeUrl}
                />
                <button
                  type="button"
                  class="px-2 py-1 rounded text-[0.68rem] font-semibold bg-violet-600 text-white hover:bg-violet-700 border-0 cursor-pointer"
                  on:click={applyGuiBrainNodeUrl}
                >
                  Use Node
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Big Brother shared terminal session -->
      <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 transition-all {bigBrother?.sessionOpen ? 'border-2 border-purple-500/40 dark:border-purple-400/40 bg-purple-500/[0.02] dark:bg-purple-400/[0.03]' : 'border-purple-500/20 dark:border-purple-400/20'}">
        <div class="mb-2">
          <div class="flex items-start gap-2.5">
            <span class="text-lg leading-none">
              {#if !bigBrother}⚪
              {:else if bigBrother.running && bigBrother.healthy}🟢
              {:else if bigBrother?.sessionOpen}🟡
              {:else}🔴{/if}
            </span>
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm text-gray-900 dark:text-gray-100 flex items-center justify-between gap-1">
                <span>Big Brother</span>
                {#if bigBrother?.provider}
                  <span class="inline-block px-1.5 py-0.5 bg-purple-500/15 dark:bg-purple-400/20 text-purple-600 dark:text-purple-400 rounded text-[0.6rem] font-bold tracking-tight">
                    {bigBrother.provider === 'codex' ? 'Codex' : bigBrother.provider === 'gemini' ? 'Gemini' : 'Claude Code'}
                  </span>
                {/if}
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400">
                CLI / Subscription Escalation Host
              </div>
            </div>
          </div>
        </div>
        {#if bigBrother}
          <div class="grid grid-cols-3 gap-1 p-1 rounded bg-black/5 dark:bg-white/5 mb-2" role="group" aria-label="Big Brother CLI Provider">
            {#each [
              { id: 'codex', label: 'Codex' },
              { id: 'claude-code', label: 'Claude' },
              { id: 'gemini', label: 'Gemini' },
            ] as cli (cli.id)}
              <button
                type="button"
                class="py-0.5 px-1 rounded text-[0.65rem] font-semibold cursor-pointer border-0 transition-all {bigBrother.provider === cli.id ? 'bg-purple-600 text-white' : 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5'}"
                disabled={actionInProgress !== null || !$isOwner}
                on:click={() => switchBigBrotherProvider(cli.id as 'codex' | 'claude-code' | 'gemini')}
              >
                {cli.label}
              </button>
            {/each}
          </div>
        {/if}
        <div class="flex gap-2">
          {#if bigBrother?.sessionOpen}
            <button class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => controlBigBrother('stop')} disabled={actionInProgress !== null}>
              {actionInProgress === 'bigbrother-stop' ? '...' : 'Stop'}
            </button>
          {:else if bigBrother}
            <div class="w-full text-xs text-gray-500 dark:text-gray-400 italic p-1.5 text-center bg-black/5 dark:bg-white/5 rounded-md">Starts on demand when a role or Terminal requests it</div>
          {:else}
            <div class="text-xs text-gray-500 dark:text-gray-400">Status unavailable</div>
          {/if}
        </div>
        {#if bigBrother?.sessionOpen}
          <div class="flex flex-wrap gap-2 mt-2 pt-2 border-t border-black/10 dark:border-white/10">
            <span class="inline-block px-2 py-0.5 bg-purple-500/10 dark:bg-purple-400/15 text-purple-600 dark:text-purple-400 rounded text-[0.7rem] font-medium">{bigBrother.phase}</span>
          </div>
        {/if}
      </div>

      <!-- 2. Cognitive Role & Model Routing (Hybrid Local Q6A + Remote/Cloud) -->
      {#if hasModelRegistry || loadingModelRegistry || modelConfigurationError}
        <div class="flex items-center gap-2 pt-1 font-semibold text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <span class="text-base">🧭</span>
          <span class="flex-1">Cognitive Role Routing</span>
        </div>

        <div class="border border-black/10 dark:border-white/10 rounded-lg p-3 bg-white dark:bg-gray-800 flex flex-col gap-2">
          <!-- Fast Placement Presets -->
          <div class="grid grid-cols-4 gap-1 p-1 rounded-lg bg-black/5 dark:bg-white/5" role="group" aria-label="Backend model presets">
            <button
              type="button"
              class="py-1 px-1 rounded text-[0.65rem] font-semibold transition-all cursor-pointer border-0 truncate {activePreset === 'local' ? 'bg-violet-600 text-white shadow-sm' : 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5'}"
              disabled={loadingModelRegistry || Boolean(savingModelRole)}
              on:click={() => applyModelPreset('local')}
              title="Run all roles on local llama.cpp (0.8B LoRA specialists + 9B local base)"
            >
              Local
            </button>
            <button
              type="button"
              class="py-1 px-1 rounded text-[0.65rem] font-semibold transition-all cursor-pointer border-0 truncate {activePreset === 'hybrid' ? 'bg-violet-600 text-white shadow-sm' : 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5'}"
              disabled={loadingModelRegistry || Boolean(savingModelRole)}
              on:click={() => applyModelPreset('hybrid')}
              title="Hybrid: Fast 0.8B local LoRAs for Intent/Task + warm BB-Gemini ACP (paid Google subscription) for Persona & Vision"
            >
              Hybrid
            </button>
            <button
              type="button"
              class="py-1 px-1 rounded text-[0.65rem] font-semibold transition-all cursor-pointer border-0 truncate {activePreset === 'bb-codex' ? 'bg-violet-600 text-white shadow-sm' : 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5'}"
              disabled={loadingModelRegistry || Boolean(savingModelRole)}
              on:click={() => applyModelPreset('bb-codex')}
              title="Route roles to Big Brother Codex (gpt-6.1-sol)"
            >
              BB-Codex
            </button>
            <button
              type="button"
              class="py-1 px-1 rounded text-[0.65rem] font-semibold transition-all cursor-pointer border-0 truncate {activePreset === 'bb-gemini' ? 'bg-violet-600 text-white shadow-sm' : 'bg-transparent text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5'}"
              disabled={loadingModelRegistry || Boolean(savingModelRole)}
              on:click={() => applyModelPreset('bb-gemini')}
              title="Route all roles to warm BB-Gemini ACP server on your paid Google subscription (gemini-3.8-flash-low)"
            >
              BB-Gemini
            </button>
          </div>

          <div class="rounded-md border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] px-2 py-1.5">
            <label
              for="model-configuration-mode"
              class="flex items-center justify-between gap-2 text-[0.6875rem] text-gray-500 dark:text-gray-400"
              title="View configured workflow nodes and edit their role defaults."
            >
              <span class="font-medium shrink-0">Routing profile</span>
              <select
                id="model-configuration-mode"
                class="min-w-0 flex-1 rounded border border-gray-300 dark:border-white/15 bg-white dark:bg-gray-900 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-800 dark:text-gray-100"
                value={modelConfigurationMode}
                on:change={selectModelConfigurationMode}
                disabled={loadingModelRegistry || Boolean(savingModelRole)}
              >
                {#each MODEL_CONFIGURATION_MODES as mode}
                  <option value={mode.id}>{mode.label}</option>
                {/each}
              </select>
            </label>
          </div>

          {#if loadingModelRegistry}
            <div class="px-1 py-0.5 text-[0.6875rem] text-gray-400">Loading mappings…</div>
          {/if}
          {#if modelConfigurationError}
            <div class="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[0.6875rem] text-red-600 dark:text-red-300" role="alert">
              {modelConfigurationError}
            </div>
          {:else if modelConfigurationNotice}
            <div class="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[0.6875rem] text-emerald-700 dark:text-emerald-300" role="status">
              {modelConfigurationNotice}
            </div>
          {/if}

          {#each modelRoleSections as section}
            <div class="flex flex-col gap-1">
              {#if section.label}
                <div class="flex items-center gap-1 px-1 pt-1 text-[0.68rem] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400" title={section.description}>
                  <span>{section.label}</span>
                </div>
              {/if}
              {#each section.roles as presentation}
                {@const role = presentation.role}
                {@const info = modelRoles[role]}
                {#if info}
                  {@const choice = modelChoiceForAssignment(baseModelChoices, roleAssignments[role])}
                  {@const adapter = choice && adapterChoiceForAssignment(choice, roleAssignments[role])}
                  {@const useLora = loraEnabled[role] ?? Boolean(adapter)}
                  <div class="flex flex-col items-stretch min-w-0 gap-1 py-1 px-1 rounded-md">
                    <div class="flex items-center justify-between gap-1.5 min-w-0">
                      <span class="text-gray-600 dark:text-gray-300 text-xs font-medium" title={presentation.description}>{presentation.label}</span>
                      {#if info.provider}
                        <span class="text-[0.6rem] px-1.5 py-0.2 rounded bg-black/5 dark:bg-white/10 text-gray-500 dark:text-gray-400 font-mono">
                          {info.provider}
                        </span>
                      {/if}
                    </div>
                    <div class="flex min-w-0 items-center gap-2">
                      <select
                        class="text-gray-900 dark:text-gray-100 font-mono text-[0.7rem] font-medium bg-transparent border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 cursor-pointer flex-1 min-w-0"
                        aria-label={`Model for ${presentation.label}`}
                        title={modelRoleTooltip(role, info)}
                        value={choice?.key || ''}
                        disabled={loadingModelRegistry || Boolean(savingModelRole)}
                        on:change={async event => {
                          const input = event.currentTarget;
                          await selectBaseModel(role, input.value);
                          input.value = modelChoiceForAssignment(baseModelChoices, roleAssignments[role])?.key || '';
                        }}
                      >
                        <option value="" disabled>Select model…</option>
                        {#each baseModelChoices as model (model.key)}
                          <option value={model.key}>
                            {model.label}{model.provider === 'big-brother' ? '' : ` · ${model.provider === 'llama-cpp' ? 'llama.cpp' : model.provider}`}
                            {baseModelChoices.some(other => other.key !== model.key && other.model === model.model && other.provider === model.provider) ? ` · ${model.endpoint}` : ''}
                          </option>
                        {/each}
                      </select>
                      <label class="flex shrink-0 items-center gap-1 text-[0.6875rem] text-gray-600 dark:text-gray-300">
                        <input
                          type="checkbox"
                          aria-label={`Use LoRA for ${presentation.label}`}
                          checked={useLora}
                          disabled={!choice?.adapters.length || loadingModelRegistry || Boolean(savingModelRole)}
                          on:change={async event => {
                            const input = event.currentTarget;
                            if (choice) await toggleRoleLora(role, input.checked, choice);
                            const savedChoice = modelChoiceForAssignment(baseModelChoices, roleAssignments[role]);
                            input.checked = loraEnabled[role] ?? Boolean(savedChoice && adapterChoiceForAssignment(savedChoice, roleAssignments[role]));
                          }}
                        />
                        LoRA
                      </label>
                    </div>
                    {#if useLora && choice}
                      <select
                        class="text-gray-900 dark:text-gray-100 font-mono text-[0.7rem] font-medium bg-transparent border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 cursor-pointer w-full"
                        aria-label={`LoRA for ${presentation.label}`}
                        value={adapter?.id || ''}
                        disabled={loadingModelRegistry || Boolean(savingModelRole)}
                        on:change={async event => {
                          const input = event.currentTarget;
                          await assignModelToRole(role, input.value);
                          const savedChoice = modelChoiceForAssignment(baseModelChoices, roleAssignments[role]);
                          input.value = savedChoice && adapterChoiceForAssignment(savedChoice, roleAssignments[role])?.id || '';
                        }}
                      >
                        <option value="" disabled>Select LoRA…</option>
                        {#each choice.adapters as option (option.id)}
                          <option value={option.id}>{modelAdapterLabel(option)}</option>
                        {/each}
                      </select>
                    {/if}
                    {#if info.needsConfig || info.error}
                      <span class="text-[0.6875rem] text-red-500" role="alert">{info.unavailableReason || info.error}</span>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/each}

          <div class="flex items-center justify-between pt-1 border-t border-black/5 dark:border-white/10 text-[0.6875rem] text-gray-400">
            <a href={graphEditorHref()} target="_blank" rel="noopener noreferrer" class="underline">Inspect workflow roles</a>
            <button type="button" class="underline bg-transparent border-0 p-0 cursor-pointer text-gray-400" on:click={() => loadModelRegistry()} disabled={loadingModelRegistry}>Refresh</button>
          </div>
          {#each workflowModels as workflow (workflow.key)}
            {#if workflow.error}
              <div class="px-2 py-1 text-[0.6875rem] text-red-300" role="alert">{workflow.name}: {workflow.error}</div>
            {/if}
            {#each workflow.models.filter(binding => binding.error || binding.selection === 'runtime-role') as binding (binding.nodeId)}
              <div class="px-2 py-1 text-[0.6875rem] text-gray-400" class:text-red-300={Boolean(binding.error)}>
                {workflow.name} · {binding.label}: {binding.error || 'role supplied at runtime'}
              </div>
            {/each}
          {/each}
        </div>
      {/if}

      <!-- 3. Voice Services (Whisper STT & Kokoro/Piper TTS) -->
      {#if servers.length > 0}
        <div class="flex items-center gap-2 pt-1 font-semibold text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <span class="text-base">🎤</span>
          <span class="flex-1">Voice Services (STT & TTS)</span>
          <button type="button" class="normal-case font-normal text-[0.6875rem] text-violet-600 dark:text-violet-400 underline bg-transparent border-0 p-0 cursor-pointer" on:click={openVoiceSettings}>
            Voice settings
          </button>
        </div>

        {#if voicePrefsLoaded}
          <div class="border border-black/10 dark:border-white/10 rounded-lg p-2.5 bg-white dark:bg-gray-800 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="text-gray-600 dark:text-gray-300 font-medium">Speech Output</span>
              <div class="flex gap-1 bg-black/5 dark:bg-white/5 p-0.5 rounded">
                {#each [
                  { id: 'browser', label: 'Browser' },
                  { id: 'robot', label: 'Body (Q6A)' },
                  { id: 'off', label: 'Off' },
                ] as dest (dest.id)}
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded text-[0.65rem] font-semibold border-0 cursor-pointer {voiceOutputTarget === dest.id ? 'bg-violet-600 text-white' : 'bg-transparent text-gray-600 dark:text-gray-300'}"
                    disabled={savingVoicePref}
                    on:click={() => saveVoiceQuickPref({ outputTarget: dest.id as 'browser' | 'robot' | 'off' })}
                  >
                    {dest.label}
                  </button>
                {/each}
              </div>
            </div>
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="text-gray-600 dark:text-gray-300 font-medium">TTS Engine</span>
              <div class="flex gap-1 bg-black/5 dark:bg-white/5 p-0.5 rounded">
                {#each [
                  { id: 'kokoro', label: 'Kokoro' },
                  { id: 'piper', label: 'Piper' },
                ] as eng (eng.id)}
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded text-[0.65rem] font-semibold border-0 cursor-pointer {voiceTtsProvider === eng.id ? 'bg-violet-600 text-white' : 'bg-transparent text-gray-600 dark:text-gray-300'}"
                    disabled={savingVoicePref}
                    on:click={() => saveVoiceQuickPref({ provider: eng.id as 'kokoro' | 'piper' })}
                  >
                    {eng.label}
                  </button>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      {/if}

      {#each servers as server (server.name)}
        {@const currentTarget = server.details?.target === 'remote' ? 'remote' : 'local'}
        <div class="border border-black/10 dark:border-white/10 rounded-lg p-3 bg-white dark:bg-gray-800 transition-all">
          <div class="mb-2">
            <div class="flex items-start gap-2.5">
              <span class="text-lg leading-none">{getStatusIcon(server)}</span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <div class="font-semibold text-sm text-gray-900 dark:text-gray-100">{server.displayName}</div>
                  <div class="flex gap-1 bg-black/5 dark:bg-white/5 p-0.5 rounded" role="group" aria-label={`${server.displayName} host target`}>
                    <button
                      type="button"
                      class="px-1.5 py-0.5 rounded text-[0.65rem] font-semibold border-0 cursor-pointer {currentTarget === 'local' ? 'bg-violet-600 text-white' : 'bg-transparent text-gray-600 dark:text-gray-300'}"
                      disabled={voiceActions[`${server.name}-target`] || !$isOwner}
                      on:click={() => setVoiceServiceTarget(server, 'local')}
                      title="Run on this host (127.0.0.1)"
                    >
                      Local
                    </button>
                    <button
                      type="button"
                      class="px-1.5 py-0.5 rounded text-[0.65rem] font-semibold border-0 cursor-pointer {currentTarget === 'remote' ? 'bg-cyan-600 text-white' : 'bg-transparent text-gray-600 dark:text-gray-300'}"
                      disabled={voiceActions[`${server.name}-target`] || !$isOwner}
                      on:click={() => setVoiceServiceTarget(server, 'remote')}
                      title="Route to Remote Server (dndiy) or custom URL"
                    >
                      Remote
                    </button>
                  </div>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {getStatusText(server)}
                  {#if server.status === 'running' && server.details?.pid}
                    • PID: {server.details.pid}
                  {/if}
                </div>
                {#if server.details?.url}
                  <div class="text-[0.6875rem] text-gray-500 dark:text-gray-400 break-all font-mono">{server.details.url}</div>
                {/if}
              </div>
            </div>
          </div>

          {#if currentTarget === 'remote'}
            <div class="flex gap-1.5 mt-2">
              <input
                type="text"
                class="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-700 bg-transparent px-2 py-1 text-[0.6875rem] font-mono text-gray-800 dark:text-gray-200"
                placeholder="Default remote host URL (or http://dndiy:port)"
                value={voiceRemoteUrlInputs[server.name] ?? server.details?.remoteUrl ?? ''}
                on:input={event => {
                  voiceRemoteUrlInputs = { ...voiceRemoteUrlInputs, [server.name]: event.currentTarget.value };
                }}
              />
              <button
                type="button"
                class="px-2 py-1 rounded bg-cyan-600 text-white text-[0.6875rem] font-semibold border-0 cursor-pointer disabled:opacity-50"
                disabled={voiceActions[`${server.name}-target`] || !$isOwner}
                on:click={() => setVoiceServiceTarget(server, 'remote', voiceRemoteUrlInputs[server.name] ?? '')}
              >
                Save URL
              </button>
            </div>
          {:else if server.installed}
            <div class="flex gap-2">
              {#if server.status === 'running'}
                <button class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => controlServer(server, 'stop')} disabled={voiceActions[`${server.name}-stop`]}>
                  {voiceActions[`${server.name}-stop`] ? '...' : 'Stop'}
                </button>
              {:else}
                <button class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => controlServer(server, 'start')} disabled={voiceActions[`${server.name}-start`]}>
                  {voiceActions[`${server.name}-start`] ? '...' : 'Start'}
                </button>
              {/if}
            </div>
          {:else if server.status !== 'unknown'}
            <div class="text-xs text-gray-500 dark:text-gray-400 italic p-2 text-center bg-black/5 dark:bg-white/5 rounded-md">Not installed locally (switch to Remote to use remote host)</div>
          {/if}

          {#if server.details?.error || (server.details?.readiness === 'error' && server.details.health?.message)}
            <div class="banner banner-error mt-2">{server.details.error || server.details.health.message}</div>
          {/if}

          {#if server.details && server.status === 'running'}
            <div class="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-black/10 dark:border-white/10">
              {#if server.details.health?.model}
                <span class="inline-block px-2 py-0.5 bg-violet-500/10 dark:bg-violet-400/15 text-violet-600 dark:text-violet-400 rounded text-[0.68rem] font-medium">Model: {server.details.health.model}</span>
              {/if}
              {#if server.details.health?.device}
                <span class="inline-block px-2 py-0.5 bg-violet-500/10 dark:bg-violet-400/15 text-violet-600 dark:text-violet-400 rounded text-[0.68rem] font-medium">Device: {server.details.health.device}</span>
              {/if}
              {#if server.details.health?.defaults?.voice}
                <span class="inline-block px-2 py-0.5 bg-violet-500/10 dark:bg-violet-400/15 text-violet-600 dark:text-violet-400 rounded text-[0.68rem] font-medium">Voice: {server.details.health.defaults.voice}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      <!-- 4. Memories & Persona Location (Storage & Remote Sync) -->
      {#if profileStorage || syncConfig}
        <div class="flex items-center gap-2 pt-1 font-semibold text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <span class="text-base">💾</span>
          <span class="flex-1">Memories & Persona Location</span>
          <button type="button" class="normal-case font-normal text-[0.6875rem] text-violet-600 dark:text-violet-400 underline bg-transparent border-0 p-0 cursor-pointer" on:click={openStorageSettings}>
            Manage storage
          </button>
        </div>

        <div class="border border-black/10 dark:border-white/10 rounded-lg p-3 bg-white dark:bg-gray-800 flex flex-col gap-2">
          {#if storageError}
            <div class="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[0.6875rem] text-red-600 dark:text-red-300" role="alert">
              {storageError}
            </div>
          {:else if storageNotice}
            <div class="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[0.6875rem] text-emerald-700 dark:text-emerald-300" role="status">
              {storageNotice}
            </div>
          {/if}

          {#if profileStorage}
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-gray-700 dark:text-gray-300">Active Profile Path</span>
              <span class="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600 dark:text-violet-400 text-[0.65rem] font-bold uppercase">
                {profileStorage.isEncrypted ? '🔒 Encrypted' : profileStorage.storageType || 'internal'}
              </span>
            </div>
            <div class="text-[0.6875rem] font-mono text-gray-600 dark:text-gray-400 break-all bg-black/[0.03] dark:bg-white/[0.03] px-2 py-1 rounded">
              {profileStorage.currentPath}
            </div>

            {#if storageDevices.filter(d => d.mounted && d.writable).length > 0 || profileStorage.usingCustomPath}
              <label class="flex items-center justify-between gap-2 text-[0.6875rem] text-gray-500 dark:text-gray-400">
                <span class="shrink-0">Switch Location:</span>
                <select
                  class="min-w-0 flex-1 rounded border border-gray-300 dark:border-white/15 bg-white dark:bg-gray-900 px-1.5 py-0.5 text-[0.6875rem] font-medium text-gray-800 dark:text-gray-100"
                  value={profileStorage.usingCustomPath ? profileStorage.currentPath : '__default__'}
                  disabled={switchingStorage}
                  on:change={event => switchProfileLocation(event.currentTarget.value)}
                >
                  <option value="__default__">Local Default ({profileStorage.defaultPath})</option>
                  {#each storageDevices.filter(d => d.mounted && d.writable) as dev (dev.id)}
                    <option value={dev.suggestedPath}>{dev.label} ({dev.type} • {dev.freeSpaceFormatted} free)</option>
                  {/each}
                </select>
              </label>
            {/if}
          {/if}

          {#if syncConfig}
            <div class="pt-2 border-t border-black/10 dark:border-white/10 flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium text-gray-700 dark:text-gray-300">Remote Profile Sync</span>
                {#if syncConfig.configured}
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded bg-cyan-600 hover:bg-cyan-700 text-white text-[0.68rem] font-semibold border-0 cursor-pointer disabled:opacity-50"
                    disabled={syncingProfile}
                    on:click={triggerProfileSync}
                  >
                    {syncingProfile ? '↻ Syncing…' : '↻ Sync Now'}
                  </button>
                {/if}
              </div>
              {#if syncConfig.configured}
                <div class="text-[0.6875rem] text-gray-500 dark:text-gray-400 break-all">
                  Host: {syncConfig.serverUrl}
                  {#if syncConfig.lastSyncAt}
                    • Last: {new Date(syncConfig.lastSyncAt).toLocaleTimeString()}
                  {/if}
                </div>
                {#if syncProgressMessage}
                  <div class="text-[0.6875rem] text-cyan-600 dark:text-cyan-400">{syncProgressMessage}</div>
                {/if}
              {:else}
                <div class="text-[0.6875rem] text-gray-500 dark:text-gray-400">
                  Not configured — use Sync icon in Left Sidebar or Storage settings to connect remote host.
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- 5. Event Bus (Telemetry) -->
      <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 transition-all {eventBus?.running ? 'border-2 border-cyan-500/40 dark:border-cyan-400/40 bg-cyan-500/[0.02] dark:bg-cyan-400/[0.03]' : 'border-cyan-500/20 dark:border-cyan-400/20'}">
        <div class="mb-2">
          <div class="flex items-start gap-2.5">
            <span class="text-lg leading-none">
              {#if !eventBus}⚪
              {:else if eventBus.running && eventBus.healthy}🟢
              {:else if eventBus?.running}🟡
              {:else}🔴{/if}
            </span>
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-0.5">
                Event Bus
                <span class="inline-block px-1.5 py-0.5 ml-2 bg-cyan-500/15 dark:bg-cyan-400/20 text-cyan-600 dark:text-cyan-400 rounded text-[0.6rem] font-bold tracking-tight">Telemetry</span>
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400">
                {eventBus ? eventBus.running ? eventBus.healthy ? 'Running' : 'Unhealthy' : 'Stopped' : 'Status unavailable'}
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400">
                {eventBus?.endpoint}
                {#if eventBus?.running && eventBus?.eventCount !== undefined}
                  • {eventBus.eventCount} events
                {/if}
              </div>
            </div>
          </div>
        </div>
        <div class="flex gap-2">
          {#if eventBus?.running}
            <button class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => controlEventBus('stop')} disabled={actionInProgress !== null}>
              {actionInProgress === 'eventbus-stop' ? '...' : 'Stop'}
            </button>
            <button class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => controlEventBus('restart')} disabled={actionInProgress !== null}>
              {actionInProgress === 'eventbus-restart' ? '...' : 'Restart'}
            </button>
          {:else}
            <button class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => controlEventBus('start')} disabled={actionInProgress !== null}>
              {actionInProgress === 'eventbus-start' ? '...' : 'Start'}
            </button>
          {/if}
        </div>
        {#if eventBus?.running && eventBus.subscribers !== undefined}
          <div class="flex flex-wrap gap-2 mt-2 pt-2 border-t border-black/10 dark:border-white/10">
            <span class="inline-block px-2 py-0.5 bg-cyan-500/10 dark:bg-cyan-400/15 text-cyan-600 dark:text-cyan-400 rounded text-[0.7rem] font-medium">📡 {eventBus.subscribers} subscriber{eventBus.subscribers !== 1 ? 's' : ''}</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
