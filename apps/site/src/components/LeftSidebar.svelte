<script lang="ts">
  import { onMount } from 'svelte';
  import { activeView, statusStore, statusRefreshTrigger, yoloModeStore, graphEditorHref, navigationItems } from '../stores/navigation';
  import { currentMode, isOwner } from '../stores/security-policy';
  import { pendingCount, loadApprovals } from '../stores/approvals';
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
  let trustMenuOpen = false;
  let trustOptions: string[] = [];
  $: yoloMode = $yoloModeStore;

  type AdapterInfo = {
    status?: string;
    modelName?: string;
    activatedAt?: string;
    source?: string;
  } | null;

  type ModelStatus = {
    current?: string | null;
    base?: string | null;
    useAdapter?: boolean;
    adapterMode?: string;
    personaSummary?: string;
    adapter?: AdapterInfo;
  } | null;

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

  let modelInfo: ModelStatus = null;
  let modelRoles: Record<string, ModelRoleInfo> = {};
  let resolvedRoleModels: Record<string, ModelRoleInfo> = {};
  let workflowModels: WorkflowModelSummary[] = [];
  let hasModelRegistry = false;
  let taskTotals = { active: 0, inProgress: 0 };

  // Persona facet state
  let activeFacet: string | null = null;
  let facets: Record<string, any> = {};
  let personaFacetTooltip = '';
  let personaFacetError: string | null = null;

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
    lines.push('Progression: inactive → default → poet → thinker → friend → antagonist → inactive');
    return lines.join('\n');
  })();

  // Subscribe to the shared status store
  let statusSubscription: (() => void) | null = null;

  // Load status from shared store instead of making API call directly
  async function loadStatus() {
    statusSubscription = statusStore.subscribe((data) => {
      if (data) {
        identity = data.identity;
        taskTotals = {
          active: data?.tasks?.active ?? 0,
          inProgress: data?.tasks?.byStatus?.in_progress ?? 0,
        };
        modelInfo = data?.model || null;
        loading = false;

        // Populate cloud models from unified status endpoint (works on mobile too)
        if (data.systemHealth?.cloudModels && data.systemHealth.cloudModels.length > 0) {
          modelCategories.remote = data.systemHealth.cloudModels.map((m: { id: string; model: string; provider: string }) => ({
            id: m.id,
            model: m.model,
            provider: m.provider,
            locked: false
          }));
        } else {
          modelCategories.remote = [];
        }

        // Update backend info from status
        if (data.systemHealth) {
          activeBackend = data.systemHealth.activeBackend || 'auto';

          // Extract backend availability for multi-icon display
          if (data.systemHealth.backendAvailability) {
            const wasConnected = backendAvailability.remoteServer?.connected || false;
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

    try {
      const res = await apiFetch('/api/remote-server/health');
      const data = await res.json();

      if (res.ok && data.healthy) {
        backendAvailability.remoteServer.connected = true;
      } else {
        backendAvailability.remoteServer.connected = false;
      }
    } catch (e) {
      backendAvailability.remoteServer.connected = false;
    }
  }


  async function loadTrustOptions() {
    if (!$isOwner) {
      trustOptions = [];
      return;
    }
    try {
      const res = await apiFetch('/api/trust');
      const data = await res.json();
      if (res.ok) {
        trustOptions = Array.isArray(data.available) ? data.available : [];
        if (identity) identity.trustLevel = data.level;

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
      if (identity) identity.trustLevel = data.level;
      trustMenuOpen = false;
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
      parsed.yoloMode = yoloMode;
      localStorage.setItem('chatPrefs', JSON.stringify(parsed));
    } catch {}
  }

  async function togglePersonaMode() {
    if ($currentMode === 'emulation') {
      alert('Persona context is locked to "active" in emulation mode for stable personality.');
      return;
    }

    const currentlyEnabled = modelInfo?.personaSummary === 'enabled';
    const newState = !currentlyEnabled;

    if (!newState && !modelInfo?.useAdapter) {
      const proceed = confirm(
        'Disabling persona context removes personality, values, and memory grounding.\n\n' +
        'You have no active LoRA adapters or specialized models loaded.\n\n' +
        'Without persona context, the LLM will use default behavior without your personality scaffold.\n\n' +
        'Recommended: Keep persona context ENABLED until you have trained adapters.\n\n' +
        'Disable anyway?'
      );
      if (!proceed) return;
    }

    try {
      const response = await apiFetch('/api/persona-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newState }),
      });

      const result = await response.json();

      if (result.success) {
        alert(result.message || (newState ? 'Persona context enabled' : 'Persona context disabled'));
        setTimeout(() => {
          statusRefreshTrigger.update(n => n + 1);
        }, 100);
      } else if (result.locked) {
        alert(result.error);
      } else {
        alert('Failed to toggle persona context: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error toggling persona context:', error);
      alert('Failed to toggle persona context: ' + (error as Error).message);
    }
  }

  async function loadFacets() {
    try {
      const response = await apiFetch('/api/persona-facet');
      const data = await response.json();
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

    try {
      const response = await apiFetch('/api/persona-facet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facet: nextFacet }),
      });

      const result = await response.json();

      if (result.success) {
        activeFacet = nextFacet;
        setTimeout(() => statusRefreshTrigger.update(n => n + 1), 100);
      } else {
        console.error('Failed to switch facet:', result.error);
      }
    } catch (error) {
      console.error('Error cycling facet:', error);
    }
  }


  interface ModelCategories {
    local: AvailableModel[];
    remote: AvailableModel[];
    bigBrother: AvailableModel[];
  }

  type BackendType = 'llama-cpp' | 'ollama' | 'remote' | 'auto';
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
  let modelRegistryRequestId = 0;
  let modelConfigurationMode: ModelConfigurationMode = 'dual';
  let modelConfigurationError = '';
  let modelConfigurationNotice = '';
  let savingModelRole: string | null = null;
  let statusRefreshInFlight = false;


  let activeBackend: BackendType = 'ollama';

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
    localModels: { available: boolean; running: boolean; embeddingModel?: string | null; llmModel?: string | null };
  }
  let backendAvailability: BackendAvailability = {
    llamaCpp: { available: false, running: false, active: false },
    ollama: { available: false, running: false, active: false },
    runpod: { available: false, configured: false, active: false },
    bigBrother: { available: false, enabled: false },
    remoteServer: { available: false, configured: false, connected: false },
    localModels: { available: false, running: false, embeddingModel: null, llmModel: null }
  };


  function getOllamaTooltip(): string {
    const ba = backendAvailability.ollama;
    if (!ba.available) return 'Ollama: Not installed';
    if (ba.running) return `Ollama: Running${ba.model ? ` (${ba.model})` : ''}${ba.active ? ' [ACTIVE]' : ''}`;
    return 'Ollama: Installed but not running';
  }
  function getRunPodTooltip(): string {
    const ba = backendAvailability.runpod;
    if (!ba.available) return 'RunPod: Not configured';
    return `RunPod: Configured${ba.active ? ' [ACTIVE]' : ''}`;
  }
  function getBigBrotherTooltip(): string {
    const ba = backendAvailability.bigBrother;
    if (!ba.available) return 'Big Brother: Not available';
    if (ba.enabled) return `Big Brother: Enabled (${ba.provider || 'claude-code'})`;
    return 'Big Brother: Disabled';
  }
  function getRemoteServerTooltip(): string {
    const ba = backendAvailability.remoteServer;
    if (!ba.configured) return 'Remote Server: Not configured - Configure in Settings → Backend';
    if (ba.connected) {
      const remoteModels = modelCategories.remote.filter(m => m.provider === 'remote-server');
      const modelInfo = remoteModels.length > 0
        ? ` (${remoteModels.map(m => m.model).join(', ')})`
        : '';
      return `Remote Server: Connected${modelInfo}\n${ba.serverUrl}`;
    }
    return `Remote Server: Configured (testing connection...)\n${ba.serverUrl}`;
  }
  function getLocalModelsTooltip(): string {
    const ba = backendAvailability.localModels;
    if (!ba.available) return 'Semantic Search: Not configured';
    if (ba.running) {
      const parts = ['Semantic Search: Running'];
      if (ba.embeddingModel) parts.push(`Embeddings: ${ba.embeddingModel}`);
      if (ba.llmModel) parts.push(`LLM: ${ba.llmModel}`);
      return parts.join('\n');
    }
    return `Semantic Search: Configured but not running${ba.embeddingModel ? `\nModel: ${ba.embeddingModel}` : ''}`;
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

  function toggleRoleLora(role: string, checked: boolean, choice: BaseModelChoice) {
    loraEnabled = { ...loraEnabled, [role]: checked };
    if (!checked) void selectBaseModel(role, choice.key);
  }

  async function loadModelRegistry(mode: ModelConfigurationMode = modelConfigurationMode) {
    const requestId = ++modelRegistryRequestId;
    loadingModelRegistry = true;
    modelConfigurationError = '';
    workflowModels = [];
    modelRoles = {};

    try {
      const queryParams = `?cognitiveMode=${encodeURIComponent(mode)}&_t=${Date.now()}`;
      const response = await apiFetch(`/api/model-registry${queryParams}`, { cache: 'no-store' });
      const data = await response.json();

      if (requestId !== modelRegistryRequestId || mode !== modelConfigurationMode) return;

      if (response.ok && data.success) {
        availableModels = data.availableModels || [];
        resolvedRoleModels = data.resolvedRoles || {};
        workflowModels = data.workflowModels || [];
        roleAssignments = { ...(data.roleAssignments || {}) };
        activeBackend = data.activeBackend || activeBackend;

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
      console.error('Error loading model registry:', error);
      if (requestId === modelRegistryRequestId) {
        modelConfigurationError = (error as Error).message;
      }
    } finally {
      if (requestId === modelRegistryRequestId) loadingModelRegistry = false;
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

  async function refreshStatus(reason = 'manual') {
    if (statusRefreshInFlight) return;
    statusRefreshInFlight = true;
    try {
      const cacheBust = `_t=${Date.now()}`;
      const res = await apiFetch(`/api/status?${cacheBust}`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Failed to refresh status (${res.status})`);
      }
      const data = await res.json();
      statusStore.set(data);
    } catch (error) {
      console.warn(`[LeftSidebar] Failed to refresh status after ${reason}:`, error);
    } finally {
      statusRefreshInFlight = false;
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
        void refreshStatus('model assignment');
        await loadModelRegistry();

        setTimeout(() => {
          statusRefreshTrigger.update(n => n + 1);
        }, 200);
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
    loadStatus();
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
    loadApprovals();

    const ownerUnsubscribe = isOwner.subscribe(() => {
      loadApprovals();
    });


    const handleVisibilityChange = () => {
      if (!document.hidden) {
        loadApprovals();
        void loadModelRegistry();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      modeUnsubscribe();
      ownerUnsubscribe();
      if (statusSubscription) {
        statusSubscription();
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  $: taskCount = taskTotals.active;
  $: inProgressCount = taskTotals.inProgress;
  $: baseModelChoices = buildBaseModelChoices([
    ...modelCategories.local, ...modelCategories.remote, ...modelCategories.bigBrother,
    ...Object.values(roleAssignments).flatMap(id => {
      const model = findAssignedModel(id);
      return model ? [model] : [];
    }),
  ]);
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
            {#if item.id === 'dashboard' && $pendingCount > 0}
              <span class="approval-badge">{$pendingCount}</span>
            {/if}
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
    {#if loading}
      <div class="text-sm text-gray-500 dark:text-gray-400 text-center py-4">Loading...</div>
    {:else if identity}
      <div class="flex flex-col gap-2">

        <!-- Backend Status Icons -->
        <div class="backend-icons">
          {#if backendAvailability.llamaCpp?.available}
            <span class="backend-icon" class:running={backendAvailability.llamaCpp.running} class:active={backendAvailability.llamaCpp.active}
              title={`llama.cpp: ${backendAvailability.llamaCpp.running ? 'Running' : 'Offline'} (${backendAvailability.llamaCpp.model || ''})`}>🦙</span>
          {/if}
          {#if backendAvailability.ollama.available}
            <span
              class="backend-icon"
              class:running={backendAvailability.ollama.running}
              class:active={backendAvailability.ollama.active}
              class:available={backendAvailability.ollama.available && !backendAvailability.ollama.running}
              title={getOllamaTooltip()}
            >🦙</span>
          {/if}



          {#if backendAvailability.runpod.available}
            <span
              class="backend-icon cloud"
              class:configured={backendAvailability.runpod.configured}
              class:active={backendAvailability.runpod.active}
              title={getRunPodTooltip()}
            >☁️</span>
          {/if}

          {#if backendAvailability.bigBrother.available}
            <span
              class="backend-icon bigbrother"
              class:enabled={backendAvailability.bigBrother.enabled}
              class:disabled={!backendAvailability.bigBrother.enabled}
              title={getBigBrotherTooltip()}
            >🤖</span>
          {/if}

          {#if backendAvailability.remoteServer.configured}
            <span
              class="backend-icon remote-server"
              class:configured={backendAvailability.remoteServer.configured}
              class:connected={backendAvailability.remoteServer.connected}
              title={getRemoteServerTooltip()}
            >🌐</span>
          {/if}

          {#if backendAvailability.localModels.available}
            <span
              class="backend-icon local-models"
              class:running={backendAvailability.localModels.running}
              class:available={backendAvailability.localModels.available && !backendAvailability.localModels.running}
              title={getLocalModelsTooltip()}
            >🔍</span>
          {/if}

          {#if !backendAvailability.llamaCpp?.available && !backendAvailability.ollama.available && !backendAvailability.runpod.available}
            <span class="backend-icon offline" title="No backends configured">❌</span>
          {/if}
        </div>

        {#if hasModelRegistry || loadingModelRegistry || modelConfigurationError}
          <div class="mt-1 rounded border border-white/10 bg-black/20 px-2 py-2">
            <label
              for="model-configuration-mode"
              class="flex flex-col gap-1 text-[0.6875rem] text-gray-400"
              title="View configured workflow nodes and edit their role defaults."
            >
              <span>LLM routing profile</span>
              <select
                id="model-configuration-mode"
                class="min-w-0 rounded border border-white/15 bg-gray-900 px-1.5 py-1 text-[0.6875rem] font-medium text-gray-100"
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
            <div class="px-2 py-1 text-[0.6875rem] text-gray-400">Loading mappings…</div>
          {/if}
          {#if modelConfigurationError}
            <div class="mt-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[0.6875rem] text-red-300" role="alert">
              {modelConfigurationError}
            </div>
          {:else if modelConfigurationNotice}
            <div class="mt-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[0.6875rem] text-emerald-300" role="status">
              {modelConfigurationNotice}
            </div>
          {/if}
          {#if backendAvailability.bigBrother.enabled}
            <div class="px-2 py-1 text-[0.6875rem] text-gray-400">Big Brother is available for model-role assignments and delegated tools.</div>
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
                        on:change={event => selectBaseModel(role, event.currentTarget.value)}
                      >
                        <option value="" disabled>Select model…</option>
                        {#each baseModelChoices as model (model.key)}
                          <option value={model.key}>
                            {model.label} · {model.provider === 'llama-cpp' ? 'llama.cpp' : model.provider}
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
                          on:change={event => choice && toggleRoleLora(role, event.currentTarget.checked, choice)}
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
                        on:change={event => assignModelToRole(role, event.currentTarget.value)}
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
          </span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="sidebar-footer">
    <div class="footer-text">
      MetaHuman OS
      <span class="footer-version">Version 1.13</span>
    </div>
  </div>
</div>
