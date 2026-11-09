<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { activeView, statusStore, statusRefreshTrigger, yoloModeStore, graphEditorHref, navigationItems } from '../stores/navigation';
  import { currentMode, isOwner } from '../stores/security-policy';
  import { apiFetch } from '../lib/client/api-config';
  import SyncStatus from './SyncStatus.svelte';
  import { MODEL_ROLE_OPTIONS } from '@metahuman/core/model-roles';
  import { buildModelRoleSections, buildBaseModelChoices, modelChoiceForAssignment, adapterChoiceForAssignment, modelAdapterLabel, type BaseModelChoice, type ModelInventoryEntry as AvailableModel, type ModelRolePresentation, type WorkflowModelSummary } from '../lib/client/model-role-presentation';

  function selectView(viewId: string) {
    activeView.set(viewId);
  }

  // Status data
  let identity: any = null;
  let loading = true;
  let statusError = '';
  let closed = false;
  let facetRead: AbortController | undefined;
  let registryRead: AbortController | undefined;
  let remoteRead: AbortController | undefined;
  let remoteHealthLoading = false;
  let remoteHealthError = '';
  $: yoloMode = $yoloModeStore;

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

  let modelRoles: Record<string, ModelRoleInfo> = {};
  let resolvedRoleModels: Record<string, ModelRoleInfo> = {};
  let workflowModels: WorkflowModelSummary[] = [];
  let hasModelRegistry = false;

  // Persona facet state
  let activeFacet: string | null = null;
  let facets: Record<string, any> = {};
  let personaFacetTooltip = '';
  let personaFacetError: string | null = null;
  let personaFacetWriteError = '';

  $: personaFacetTooltip = (() => {
    if (personaFacetError) {
      return `Persona configuration error\n\n${personaFacetError}\n\nOpen Persona settings to repair facets.json.`;
    }
    const info = activeFacet ? facets?.[activeFacet] : undefined;
    const currentLabel =
      activeFacet === 'inactive'
        ? 'Persona disabled'
        : info?.name || activeFacet || 'default';

    const lines = [
      'Click to cycle persona facet',
      '',
      `Current: ${currentLabel}`,
    ];

    if (activeFacet === 'inactive') {
      lines.push('Persona context disabled - responses use the base model without identity scaffolding.');
    } else if (info?.description) {
      lines.push(info.description);
    }

    if (info?.resolvedPath) {
      lines.push('');
      lines.push(`Persona file: ${info.resolvedPath}`);
    } else if (activeFacet === 'inactive') {
      lines.push('');
      lines.push('Persona file: (none)');
    }

    lines.push('');
    const progression = Object.keys(facets).filter(key => facets[key]?.enabled !== false);
    if (progression.length) {
      lines.push(`Progression: ${[...progression, progression[0]].join(' → ')}`);
    }
    return lines.join('\n');
  })();

  function subscribeStatus() {
    return statusStore.subscribe((snapshot) => {
      const data = snapshot?.data;
      statusError = snapshot?.error || '';
      loading = !data && !statusError;
      if (data) {
        identity = data.identity;

        // Update backend info from status
        if (data.systemHealth) {

          // Extract backend availability for multi-icon display
          if (data.systemHealth.backendAvailability) {
            remoteRead?.abort();
            remoteHealthLoading = false;
            remoteHealthError = '';
            const wasConnected = backendAvailability.remoteServer?.serverUrl === data.systemHealth.backendAvailability.remoteServer?.serverUrl
              && backendAvailability.remoteServer?.connected || false;
            backendAvailability = {
              ...data.systemHealth.backendAvailability,
              remoteServer: {
                ...data.systemHealth.backendAvailability.remoteServer,
                connected: wasConnected
              }
            };

            if (backendAvailability.remoteServer.configured && backendAvailability.remoteServer.serverUrl) {
              checkRemoteServerConnection();
            }
          }
        }
      }
    });
  }

  // Check remote server connection and fetch available models
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


  async function loadTrustOptions() {
    if (!$isOwner) {
      return;
    }
    try {
      const res = await apiFetch('/api/trust');
      const data = await res.json();
      if (res.ok) {

        if (data.level !== 'adaptive_auto') {
          yoloModeStore.set(false);
          saveChatPrefs();
        }
      }
    } catch (e) {
      console.error('Failed to load trust options:', e);
    }
  }

  async function setTrust(level: string) {
    if (!$isOwner) return;
    try {
      const res = await apiFetch('/api/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to set trust level');
      statusRefreshTrigger.update(n => n + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function cycleTrustLevel() {
    if ($currentMode === 'emulation') {
      alert('Trust level is locked to "observe" in emulation mode for safety.');
      return;
    }

    const trustProgression = ['observe', 'suggest', 'supervised_auto', 'bounded_auto', 'adaptive_auto'];
    const currentTrust = identity?.trustLevel || 'observe';
    const currentYolo = yoloMode;

    if (currentYolo) {
      yoloModeStore.set(false);
      await setTrust('observe');
      saveChatPrefs();
      return;
    }

    const currentIndex = trustProgression.indexOf(currentTrust);

    if (currentIndex === trustProgression.length - 1) {
      try {
        if (!localStorage.getItem('yoloWarned')) {
          alert('YOLO mode relaxes ALL safety checks and allows maximum operator autonomy. Use with extreme caution.');
          localStorage.setItem('yoloWarned', '1');
        }
      } catch {}

      yoloModeStore.set(true);
      saveChatPrefs();
      return;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < trustProgression.length) {
      await setTrust(trustProgression[nextIndex]);
    }
  }

  function saveChatPrefs() {
    try {
      const prefs = localStorage.getItem('chatPrefs');
      const parsed = prefs ? JSON.parse(prefs) : {};
      parsed.yoloMode = get(yoloModeStore);
      localStorage.setItem('chatPrefs', JSON.stringify(parsed));
    } catch {}
  }

  async function loadFacets() {
    facetRead?.abort();
    if (closed) return;
    const current = facetRead = new AbortController();
    try {
      const response = await apiFetch('/api/persona-facet', { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load persona facets (HTTP ${response.status})`);
      }
      if (typeof data.activeFacet !== 'string' || !data.facets || typeof data.facets !== 'object') {
        throw new Error('Persona facet response is incomplete');
      }
      activeFacet = data.activeFacet;
      facets = data.facets;
      personaFacetError = null;
    } catch (error) {
      if (current.signal.aborted) return;
      console.error('Error loading facets:', error);
      activeFacet = null;
      facets = {};
      personaFacetError = (error as Error).message;
    }
  }

  async function cyclePersonaFacet() {
    if (personaFacetError || !activeFacet) return;
    const availableFacets = Object.keys(facets).filter(
      key => facets[key]?.enabled !== false
    );

    if (availableFacets.length === 0) {
      console.warn('No enabled facets available');
      return;
    }

    const currentIndex = availableFacets.indexOf(activeFacet);
    const nextIndex = (currentIndex + 1) % availableFacets.length;
    const nextFacet = availableFacets[nextIndex];
    personaFacetWriteError = '';
    try {
      const response = await apiFetch('/api/persona-facet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facet: nextFacet }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to switch facet');
      activeFacet = result.activeFacet;
      statusRefreshTrigger.update(n => n + 1);
    } catch (error) {
      personaFacetWriteError = (error as Error).message;
    }
  }


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
    bigBrother: []
  };

  interface BackendAvailability {
    llamaCpp: { available: boolean; running: boolean; active: boolean; model?: string };
    ollama: { available: boolean; running: boolean; active: boolean; model?: string };
    runpod: { available: boolean; configured: boolean; active: boolean };
    bigBrother: { available: boolean; enabled: boolean; provider?: string };
    remoteServer: { available: boolean; configured: boolean; serverUrl?: string; connected?: boolean };
  }
  let backendAvailability: BackendAvailability = {
    llamaCpp: { available: false, running: false, active: false },
    ollama: { available: false, running: false, active: false },
    runpod: { available: false, configured: false, active: false },
    bigBrother: { available: false, enabled: false },
    remoteServer: { available: false, configured: false, connected: false },
  };


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
  function findAssignedModel(modelId: string): AvailableModel | undefined {
    return availableModels.find(model => (
      model.id === modelId || model.aliases?.includes(modelId)
    ));
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
            bigBrother: data.modelCategories.bigBrother || []
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

  async function applyModelPreset(preset: 'local' | 'bb-codex' | 'bb-gemini') {
    if (savingModelRole || loadingModelRegistry) return;
    const mode = modelConfigurationMode;
    savingModelRole = `preset:${preset}`;
    modelConfigurationError = '';
    modelConfigurationNotice = '';
    try {
      if (preset === 'bb-codex' || preset === 'bb-gemini') {
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

      const primarySection = modelRoleSections[0]?.roles.map(r => r.role) || ['persona', 'orchestrator'];
      const targetRoles = Array.from(new Set([
        ...primarySection,
        'persona',
        'orchestrator',
        ...(mode === 'environment' ? ['environmentActionSelector'] : []),
      ])).filter(role => role !== 'embedder');

      for (const role of targetRoles) {
        let targetModelId: string | undefined;
        if (preset === 'local') {
          targetModelId = resolveLocalPresetModelId(role);
        } else if (preset === 'bb-codex') {
          targetModelId = 'big-brother.codex';
        } else {
          // Keep vision roles on local vision model when switching to text-only BB-Gemini
          targetModelId = role === 'environmentVision'
            ? resolveLocalPresetModelId(role)
            : 'big-brother.gemini';
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
      const presetLabel = preset === 'local' ? 'Local' : preset === 'bb-codex' ? 'BB-Codex' : 'BB-Gemini';
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
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
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


  onMount(() => {
    closed = false;
    const unsubscribeStatus = subscribeStatus();
    loadFacets();
    loadTrustOptions();
    let lastActiveMode: string | undefined;
    const modeUnsubscribe = currentMode.subscribe(activeMode => {
      if (!isModelConfigurationMode(activeMode) || activeMode === lastActiveMode) return;
      lastActiveMode = activeMode;
      modelConfigurationMode = activeMode;
      modelConfigurationNotice = '';
      loraEnabled = {};
      void loadModelRegistry(activeMode);
    });

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void loadModelRegistry();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      closed = true;
      facetRead?.abort();
      registryRead?.abort();
      remoteRead?.abort();
      modeUnsubscribe();
      unsubscribeStatus();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  $: discoveredModels = ($statusStore?.data?.systemHealth?.cloudModels || []) as AvailableModel[];
  $: bigBrotherDropdownModels = modelCategories.bigBrother.filter(
    model => model.id !== 'big-brother.configured'
      || Object.values(roleAssignments).includes('big-brother.configured')
  );
  $: baseModelChoices = buildBaseModelChoices([
    ...discoveredModels,
    ...modelCategories.local, ...modelCategories.remote, ...bigBrotherDropdownModels,
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
    if (assigned.every(id => {
      const m = findAssignedModel(id);
      return m ? (!isEmbedderOnlyModel(m) && (m.provider === 'llama-cpp' || m.provider === 'ollama' || m.provider === 'local')) : !id.startsWith('big-brother.');
    })) {
      return 'local';
    }
    return 'custom';
  })();
</script>

<div class="flex flex-col h-full p-4 gap-4">
  <!-- Menu Items -->
  <nav class="menu">
    {#each navigationItems.filter(item => item.id !== 'terminal' || $isOwner) as item}
      <button
        class="menu-item"
        class:active={$activeView === item.id}
        on:click={() => selectView(item.id)}
        title={item.description}
      >
        <span class="menu-icon">{item.icon}</span>
        <div class="menu-text">
          <div class="menu-label">
            {item.label}
          </div>
          {#if item.description}
            <div class="menu-description">{item.description}</div>
          {/if}
        </div>
      </button>
    {/each}
  </nav>

  <!-- Status Widget -->
  <div class="status-widget">
    <div class="widget-header">
      <span>Status</span>
      <SyncStatus compact={true} />
    </div>
    {#if statusError}
      <div class="text-sm text-red-600 dark:text-red-300" role="alert">{statusError}</div>
      <button class="text-sm underline" on:click={() => statusRefreshTrigger.update(value => value + 1)}>Retry status</button>
    {/if}
    {#if loading}
      <div class="text-sm text-gray-500 dark:text-gray-400 text-center py-4">Loading...</div>
    {:else if identity}
      <div class="flex flex-col gap-2">
        <!-- Fast Backend Presets -->
        {#if hasModelRegistry || loadingModelRegistry}
          <div class="preset-bar" role="group" aria-label="Backend model presets">
            <button
              type="button"
              class="preset-btn"
              class:active={activePreset === 'local'}
              disabled={loadingModelRegistry || Boolean(savingModelRole)}
              on:click={() => applyModelPreset('local')}
              title="Load local llama.cpp base and specialist LoRA models"
            >
              Local
            </button>
            <button
              type="button"
              class="preset-btn"
              class:active={activePreset === 'bb-codex'}
              disabled={loadingModelRegistry || Boolean(savingModelRole)}
              on:click={() => applyModelPreset('bb-codex')}
              title="Load Big Brother Codex (gpt-6.1-sol, fast, reasoning off)"
            >
              BB-Codex
            </button>
            <button
              type="button"
              class="preset-btn"
              class:active={activePreset === 'bb-gemini'}
              disabled={loadingModelRegistry || Boolean(savingModelRole)}
              on:click={() => applyModelPreset('bb-gemini')}
              title="Load Big Brother Gemini (gemini-3.8-flash-low, low effort)"
            >
              BB-Gemini
            </button>
          </div>
        {/if}

        <!-- Backend Status Icons -->
        <div class="backend-icons">
          {#if backendAvailability.llamaCpp?.available}
            <span class="backend-icon" class:running={backendAvailability.llamaCpp.running} class:active={backendAvailability.llamaCpp.active}
              title={`llama.cpp: ${backendAvailability.llamaCpp.running ? 'Running' : 'Offline'} (${backendAvailability.llamaCpp.model || ''})`}>🦙</span>
          {/if}
          {#if backendAvailability.ollama.available && (!backendAvailability.llamaCpp?.available || backendAvailability.ollama.running || backendAvailability.ollama.active)}
            <span
              class="backend-icon"
              class:running={backendAvailability.ollama.running}
              class:active={backendAvailability.ollama.active}
              class:available={backendAvailability.ollama.available && !backendAvailability.ollama.running}
              title={getOllamaTooltip(backendAvailability.ollama)}
            >🦙</span>
          {/if}

          {#if backendAvailability.runpod.available}
            <span
              class="backend-icon cloud"
              class:configured={backendAvailability.runpod.configured}
              class:active={backendAvailability.runpod.active}
              title={getRunPodTooltip(backendAvailability.runpod)}
            >☁️</span>
          {/if}

          {#if backendAvailability.bigBrother.available}
            <span
              class="backend-icon bigbrother"
              class:enabled={backendAvailability.bigBrother.enabled}
              class:disabled={!backendAvailability.bigBrother.enabled}
              title={getBigBrotherTooltip(backendAvailability.bigBrother)}
            >🤖</span>
          {/if}

          {#if backendAvailability.remoteServer.configured}
            <span
              class="backend-icon remote-server"
              class:configured={backendAvailability.remoteServer.configured}
              class:connected={backendAvailability.remoteServer.connected}
              title={getRemoteServerTooltip(backendAvailability.remoteServer, remoteHealthLoading, remoteHealthError, discoveredModels)}
            >🌐</span>
          {/if}

          {#if !backendAvailability.llamaCpp?.available && !backendAvailability.ollama.available && !backendAvailability.runpod.available}
            <span class="backend-icon offline" title="No backends configured">❌</span>
          {/if}
        </div>

        {#if hasModelRegistry || loadingModelRegistry || modelConfigurationError}
          <div class="routing-profile-bar">
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
            <div class="model-role-section">
              {#if section.label}
                <div class="model-role-section-heading" title={section.description}>
                  <span>{section.label}</span>
                  <span class="model-role-help" aria-hidden="true">?</span>
                </div>
              {/if}
              {#each section.roles as presentation}
                {@const role = presentation.role}
                {@const info = modelRoles[role]}
                {#if info}
                  {@const choice = modelChoiceForAssignment(baseModelChoices, roleAssignments[role])}
                  {@const adapter = choice && adapterChoiceForAssignment(choice, roleAssignments[role])}
                  {@const useLora = loraEnabled[role] ?? Boolean(adapter)}
                  <div class="model-role-row">
                    <div class="model-role-label">
                      <span class="activity-indicator" aria-hidden="true">
                        <span class="activity-dot"></span>
                      </span>
                      <span class="role-name" title={presentation.description}>{presentation.label}</span>
                    </div>
                    <div class="flex min-w-0 items-center gap-2">
                      <select
                        class="role-model clickable flex-1"
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
                        class="role-model clickable"
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
          <div class="flex items-center justify-between px-2 py-1 text-[0.6875rem] text-gray-400">
            <a href={graphEditorHref()} target="_blank" rel="noopener noreferrer" class="underline">Inspect workflow roles</a>
            <button on:click={() => loadModelRegistry()} disabled={loadingModelRegistry}>Refresh</button>
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
        {/if}

        <!-- Trust Level -->
        <div class="h-px bg-black/5 dark:bg-white/10 my-1"></div>
        <div class="status-row">
          <span class="status-label">Trust:</span>
          <span class="status-value">
            <button
              class="trust-badge clickable trust-level-{yoloMode ? 'yolo' : (identity.trustLevel || 'observe')}"
              title="Click to cycle trust level: {identity.trustLevel || 'observe'}{yoloMode ? ' + YOLO' : ''}\nProgression: observe → suggest → supervised_auto → bounded_auto → adaptive_auto → YOLO"
              on:click={cycleTrustLevel}
            >
              {#if yoloMode}
                <span class="yolo-indicator">YOLO</span>
              {:else}
                {identity.trustLevel || 'observe'}
              {/if}
            </button>
          </span>
        </div>
        <div class="status-row">
          <span class="status-label">Persona:</span>
          <span class="status-value">
            <button
              class="persona-badge persona-facet-{activeFacet || 'error'} clickable"
              title={personaFacetTooltip}
              on:click={cyclePersonaFacet}
              disabled={Boolean(personaFacetError) || !activeFacet}
            >
              {personaFacetError
                ? '⚠ error'
                : activeFacet === 'inactive'
                  ? 'inactive'
                  : (facets[activeFacet || '']?.name || activeFacet || 'loading')}
            </button>
            {#if personaFacetWriteError}
              <span class="block text-xs text-red-600 dark:text-red-300" role="alert">{personaFacetWriteError}</span>
            {/if}
          </span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="sidebar-footer">
    <div class="footer-text">
      Ainekio OS
    </div>
  </div>
</div>

<style>
  .menu {
    @apply flex flex-col gap-1;
  }

  .menu-item {
    @apply flex items-center gap-3 px-3 py-3 border-0 bg-transparent rounded-lg cursor-pointer transition-all
           text-left w-full;
  }

  .menu-item:hover {
    @apply bg-black/5;
  }

  :global(.dark) .menu-item:hover {
    @apply bg-white/5;
  }

  .menu-item.active {
    @apply bg-violet-600 text-white;
  }

  :global(.dark) .menu-item.active {
    @apply bg-violet-400 text-gray-900;
  }

  .menu-icon {
    @apply text-xl flex-shrink-0;
  }

  .menu-text {
    @apply flex flex-col gap-0.5 min-w-0;
  }

  .menu-label {
    @apply font-medium text-sm text-gray-900;
  }

  :global(.dark) .menu-label {
    @apply text-gray-100;
  }

  .menu-item.active .menu-label {
    @apply text-white;
  }

  :global(.dark) .menu-item.active .menu-label {
    @apply text-gray-900;
  }

  .menu-description {
    @apply text-xs text-gray-500 whitespace-nowrap overflow-hidden text-ellipsis;
  }

  :global(.dark) .menu-description {
    @apply text-gray-400;
  }

  .menu-item.active .menu-description {
    @apply text-white/80;
  }

  :global(.dark) .menu-item.active .menu-description {
    @apply text-gray-900/70;
  }

  .status-widget {
    @apply mt-auto p-4 rounded-lg border border-black/10 bg-white/50;
  }

  :global(.dark) .status-widget {
    @apply border-white/10 bg-white/5;
  }

  .widget-header {
    @apply font-semibold text-xs uppercase tracking-wide text-gray-500 mb-3;
  }

  :global(.dark) .widget-header {
    @apply text-gray-400;
  }

  .status-row {
    @apply flex items-center justify-between text-sm gap-2;
  }

  .status-label {
    @apply text-gray-500 font-medium;
  }

  :global(.dark) .status-label {
    @apply text-gray-400;
  }

  .status-value {
    @apply text-gray-900 font-semibold flex items-center gap-1.5 text-right;
  }

  :global(.dark) .status-value {
    @apply text-gray-100;
  }

  .model-role-row {
    @apply flex flex-col items-stretch min-w-0 gap-1 py-1.5 px-1 rounded-md transition-all relative;
  }

  .model-role-label {
    @apply flex items-center gap-1.5 min-w-0;
  }

  .model-role-section {
    @apply mt-1 first:mt-0;
  }

  .model-role-section-heading {
    @apply flex items-center gap-1 px-1 pt-1 text-[0.68rem] font-semibold uppercase tracking-wide
           text-gray-500;
  }

  :global(.dark) .model-role-section-heading {
    @apply text-gray-400;
  }

  .model-role-help {
    @apply inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-gray-300
           text-[0.55rem] font-bold;
  }

  :global(.dark) .model-role-help {
    @apply border-gray-600;
  }

  .role-name {
    @apply text-gray-500 text-xs font-medium;
  }

  :global(.dark) .role-name {
    @apply text-gray-400;
  }

  .role-model {
    @apply text-gray-900 font-mono text-[0.7rem] font-medium flex items-center gap-2 w-full min-w-0 text-left;
  }

  :global(.dark) .role-model {
    @apply text-gray-100;
  }

  .role-model.clickable {
    @apply bg-transparent border border-gray-200 rounded-md px-2 py-1 cursor-pointer transition-all
           hover:bg-gray-100 hover:border-gray-300;
  }

  :global(.dark) .role-model.clickable {
    @apply border-gray-700 hover:bg-gray-800 hover:border-gray-600;
  }

  .preset-bar {
    @apply grid grid-cols-3 gap-1 p-1 rounded-lg bg-black/5 border border-black/5;
  }

  :global(.dark) .preset-bar {
    @apply bg-white/5 border-white/10;
  }

  .preset-btn {
    @apply py-1 px-1.5 rounded-md text-[0.68rem] font-semibold text-gray-600 transition-all
           hover:text-gray-900 hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed truncate;
  }

  :global(.dark) .preset-btn {
    @apply text-gray-400 hover:text-gray-100 hover:bg-white/5;
  }

  .preset-btn.active {
    @apply bg-violet-600 text-white shadow-sm;
  }

  :global(.dark) .preset-btn.active {
    @apply bg-violet-500 text-white;
  }

  .routing-profile-bar {
    @apply rounded-md border border-black/10 bg-black/[0.03] px-2 py-1.5;
  }

  :global(.dark) .routing-profile-bar {
    @apply border-white/10 bg-white/[0.03];
  }

  .backend-icons {
    @apply flex gap-1 items-center px-1.5 py-1 bg-black/5 rounded-lg;
  }

  :global(.dark) .backend-icons {
    @apply bg-white/5;
  }

  .backend-icon {
    @apply flex items-center justify-center w-[22px] h-[22px] rounded text-xs transition-all cursor-default
           border-2 border-transparent;
  }

  .backend-icon.running {
    @apply bg-green-500/15;
    box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);
  }

  :global(.dark) .backend-icon.running {
    @apply bg-green-400/20;
  }

  .backend-icon.active {
    @apply border-violet-500;
    box-shadow: 0 0 8px rgba(139, 92, 246, 0.5);
  }

  :global(.dark) .backend-icon.active {
    @apply border-violet-400;
  }

  .backend-icon.available:not(.running) {
    @apply opacity-50 grayscale-[30%];
  }

  .backend-icon.cloud.configured {
    @apply bg-purple-500/10;
  }

  :global(.dark) .backend-icon.cloud.configured {
    @apply bg-purple-400/15;
  }

  .backend-icon.bigbrother.enabled {
    @apply bg-blue-500/15;
    box-shadow: 0 0 6px rgba(59, 130, 246, 0.3);
  }

  :global(.dark) .backend-icon.bigbrother.enabled {
    @apply bg-blue-400/20;
  }

  .backend-icon.bigbrother.disabled {
    @apply opacity-40 grayscale-[50%];
  }

  .backend-icon.remote-server.configured {
    @apply bg-cyan-500/15 opacity-60;
  }

  :global(.dark) .backend-icon.remote-server.configured {
    @apply bg-cyan-400/20;
  }

  .backend-icon.remote-server.connected {
    @apply bg-cyan-500/25 opacity-100;
    box-shadow: 0 0 8px rgba(6, 182, 212, 0.5);
  }

  :global(.dark) .backend-icon.remote-server.connected {
    @apply bg-cyan-400/30;
  }

  .backend-icon.offline {
    @apply opacity-40 grayscale;
  }

  .backend-icon:hover {
    transform: scale(1.1);
  }

  .trust-badge {
    @apply py-0.5 px-2 rounded-full text-[0.65rem] font-semibold lowercase border border-transparent
           cursor-default transition-all;
  }

  .trust-badge.clickable {
    @apply cursor-pointer hover:scale-105;
  }

  .trust-badge.trust-level-observe {
    @apply bg-cyan-500/15 text-cyan-700;
  }

  :global(.dark) .trust-badge.trust-level-observe {
    @apply bg-cyan-400/20 text-cyan-300;
  }

  .trust-badge.trust-level-observe:hover {
    @apply bg-cyan-500/25;
  }

  :global(.dark) .trust-badge.trust-level-observe:hover {
    @apply bg-cyan-400/30;
  }

  .trust-badge.trust-level-suggest {
    @apply bg-green-500/15 text-green-700;
  }

  :global(.dark) .trust-badge.trust-level-suggest {
    @apply bg-green-400/20 text-green-300;
  }

  .trust-badge.trust-level-suggest:hover {
    @apply bg-green-500/25;
  }

  :global(.dark) .trust-badge.trust-level-suggest:hover {
    @apply bg-green-400/30;
  }

  .trust-badge.trust-level-supervised_auto {
    @apply bg-lime-500/15 text-lime-700;
  }

  :global(.dark) .trust-badge.trust-level-supervised_auto {
    @apply bg-lime-400/20 text-lime-300;
  }

  .trust-badge.trust-level-supervised_auto:hover {
    @apply bg-lime-500/25;
  }

  :global(.dark) .trust-badge.trust-level-supervised_auto:hover {
    @apply bg-lime-400/30;
  }

  .trust-badge.trust-level-bounded_auto {
    @apply bg-orange-500/15 text-orange-700;
  }

  :global(.dark) .trust-badge.trust-level-bounded_auto {
    @apply bg-orange-400/20 text-orange-300;
  }

  .trust-badge.trust-level-bounded_auto:hover {
    @apply bg-orange-500/25;
  }

  :global(.dark) .trust-badge.trust-level-bounded_auto:hover {
    @apply bg-orange-400/30;
  }

  .trust-badge.trust-level-adaptive_auto {
    @apply bg-red-500/15 text-red-700;
  }

  :global(.dark) .trust-badge.trust-level-adaptive_auto {
    @apply bg-red-400/20 text-red-300;
  }

  .trust-badge.trust-level-adaptive_auto:hover {
    @apply bg-red-500/25;
  }

  :global(.dark) .trust-badge.trust-level-adaptive_auto:hover {
    @apply bg-red-400/30;
  }

  .trust-badge.trust-level-yolo {
    @apply bg-yellow-500/25 text-yellow-700 border-yellow-500;
    box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.2);
  }

  :global(.dark) .trust-badge.trust-level-yolo {
    @apply bg-yellow-400/30 text-yellow-300 border-yellow-400;
  }

  .trust-badge.trust-level-yolo:hover {
    @apply bg-yellow-500/35;
  }

  :global(.dark) .trust-badge.trust-level-yolo:hover {
    @apply bg-yellow-400/40;
  }

  .yolo-indicator {
    @apply uppercase font-bold tracking-wider;
  }

  .persona-badge {
    @apply py-0.5 px-2 rounded-full text-[0.65rem] font-semibold lowercase border border-transparent
           transition-all;
  }

  .persona-badge.clickable {
    @apply cursor-pointer;
  }

  .persona-badge.persona-facet-inactive {
    @apply bg-gray-500/15 text-gray-600;
  }

  :global(.dark) .persona-badge.persona-facet-inactive {
    @apply bg-gray-400/20 text-gray-400;
  }

  .persona-badge.persona-facet-error {
    @apply text-red-700 border-red-500/40;
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.22), rgba(248, 113, 113, 0.16));
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.2);
    cursor: not-allowed;
  }

  :global(.dark) .persona-badge.persona-facet-error {
    @apply text-red-300 border-red-400/50;
  }

  .persona-badge.persona-facet-default {
    @apply text-violet-700 border-violet-500/30;
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(168, 85, 247, 0.15));
    box-shadow: 0 0 8px rgba(139, 92, 246, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-default {
    @apply text-violet-300 border-violet-400/40;
  }

  .persona-badge.persona-facet-poet {
    @apply text-indigo-700 border-indigo-500/30;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(129, 140, 248, 0.15));
    box-shadow: 0 0 8px rgba(99, 102, 241, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-poet {
    @apply text-indigo-300 border-indigo-400/40;
  }

  .persona-badge.persona-facet-thinker {
    @apply text-blue-700 border-blue-500/30;
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(96, 165, 250, 0.15));
    box-shadow: 0 0 8px rgba(59, 130, 246, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-thinker {
    @apply text-blue-300 border-blue-400/40;
  }

  .persona-badge.persona-facet-friend {
    @apply text-green-700 border-green-500/30;
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(74, 222, 128, 0.15));
    box-shadow: 0 0 8px rgba(34, 197, 94, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-friend {
    @apply text-green-300 border-green-400/40;
  }

  .persona-badge.persona-facet-antagonist {
    @apply text-red-700 border-red-500/30;
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(248, 113, 113, 0.15));
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-antagonist {
    @apply text-red-300 border-red-400/40;
  }

  .sidebar-footer {
    @apply py-3 border-t border-black/10 mt-auto;
  }

  :global(.dark) .sidebar-footer {
    @apply border-white/10;
  }

  .footer-text {
    @apply text-xs text-gray-500 text-center flex flex-col gap-1;
  }

  :global(.dark) .footer-text {
    @apply text-gray-400;
  }

</style>
