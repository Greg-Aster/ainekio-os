<script lang="ts">
  import { onMount } from 'svelte';
  import GPUMonitor from './GPUMonitor.svelte';
  import ActiveOperatorSettings from './ActiveOperatorSettings.svelte';
  import ModelRegistrySettings from './ModelRegistrySettings.svelte';
  import { apiFetch } from '../lib/client/api-config';

  // Model info
  let modelInfo: any = null;
  let modelInfoError = '';

  // Logging config
  let logLevel = '';
  let savingLogging = false;
  let loggingMessage = '';


  // Audit logging control
  let auditLoggingEnabled: boolean | null = null;
  let auditLoggingLoading = false;
  let auditError = '';
  let auditLoggingSaving = false;

  // Storage status
  let storageStatus: {
    authenticated: boolean;
    username?: string;
    status?: {
      configured: boolean;
      available: boolean;
      path?: string;
      type?: 'internal' | 'external' | 'network';
      error?: string;
    };
    paths?: Record<string, { path?: string; available: boolean }>;
  } | null = null;
  let storageLoading = false;
  let storageError = '';

  // Reflector content mode
  type ContentMode = 'all' | 'user' | 'agent';
  let reflectorContentMode: ContentMode | '' = '';
  let reflectorContentModeLoading = false;
  let reflectorError = '';
  let reflectorContentModeSaving = false;
  const contentModeOptions: Record<ContentMode, string> = {
    all: 'User and AI history - generated dreams, reflections, and inner dialogue are excluded',
    user: 'User only - reflects on user inputs, excluding verbose AI responses (recommended)',
    agent: 'Agent only - reflects on AI responses and system outputs; generated inner content is excluded'
  };

  // Index content mode (what gets embedded for semantic search)
  let indexContentMode: ContentMode | '' = '';
  let indexContentModeLoading = false;
  let indexError = '';
  let indexContentModeSaving = false;
  const indexContentModeOptions: Record<ContentMode, string> = {
    user: 'User only - indexes only user inputs (recommended, prevents LLM hallucinations in search)',
    all: 'All content - indexes both user messages and AI responses',
    agent: 'Agent only - indexes AI responses, dreams, and system outputs'
  };

  type BootAgentKind = 'service' | 'scheduled' | 'manual' | 'connection' | 'one-shot';

  interface BootAgent {
    agentId: string;
    displayName: string;
    description: string;
    kind: BootAgentKind;
    enabled: boolean;
    startOnSystemBoot: boolean;
    autoRestart: boolean;
    maxRetries: number;
    dependencyNotes: string[];
  }

  let bootAgents: BootAgent[] = [];
  let bootManagerLoading = false;
  let bootManagerSaving = '';
  let bootManagerFeedback: { type: 'success' | 'error'; text: string } | null = null;

  onMount(() => {
    loadModelInfo();
    loadLoggingConfig();
    loadAuditLoggingState();
    loadStorageStatus();
    loadReflectorContentMode();
    loadIndexContentMode();
    loadBootManager();
  });

  function bootManagerSaveKey(agentId: string, key: string): string {
    return `${agentId}.${key}`;
  }

  function bootKindLabel(kind: BootAgentKind): string {
    if (kind === 'service') return 'Service';
    if (kind === 'scheduled') return 'Scheduled';
    if (kind === 'connection') return 'Connection';
    if (kind === 'one-shot') return 'One-shot';
    return 'Manual';
  }

  function bootKindClass(kind: BootAgentKind): string {
    if (kind === 'service') return 'bg-blue-500/10 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300';
    if (kind === 'connection') return 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300';
    if (kind === 'scheduled') return 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300';
    return 'bg-gray-500/10 text-gray-700 dark:bg-gray-400/15 dark:text-gray-300';
  }

  async function loadBootManager() {
    bootManagerLoading = true;
    bootManagerFeedback = null;
    try {
      const res = await apiFetch('/api/monitor');
      if (!res.ok) {
        throw new Error('Failed to load boot manager');
      }
      const data = await res.json();
      bootAgents = Array.isArray(data.bootAgents) ? data.bootAgents : [];
      return true;
    } catch (err) {
      console.error('[SystemSettings] Error loading boot manager:', err);
      bootManagerFeedback = { type: 'error', text: (err as Error).message };
      return false;
    } finally {
      bootManagerLoading = false;
    }
  }

  async function saveBootAgentVariable(agent: BootAgent, key: 'enabled' | 'startOnSystemBoot' | 'autoRestart' | 'maxRetries', value: boolean | number, event?: Event) {
    const target = event?.currentTarget as HTMLInputElement | null;
    const saveKey = bootManagerSaveKey(agent.agentId, key);
    if (bootManagerSaving) return;
    bootManagerSaving = saveKey;
    bootManagerFeedback = null;

    try {
      const res = await apiFetch('/api/monitor/agent-variable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agent.agentId,
          key,
          value,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Failed to save boot setting');
      }
      if (await loadBootManager()) {
        bootManagerFeedback = { type: 'success', text: `${agent.displayName} boot setting saved` };
      }
    } catch (err) {
      console.error('[SystemSettings] Error saving boot manager setting:', err);
      await loadBootManager();
      bootManagerFeedback = { type: 'error', text: (err as Error).message };
    } finally {
      const current = bootAgents.find(item => item.agentId === agent.agentId) || agent;
      if (target) {
        if (key === 'maxRetries') target.value = String(current[key]);
        else target.checked = current[key];
      }
      bootManagerSaving = '';
    }
  }

  let auditRetentionDays: number | null = null;

  async function loadAuditLoggingState() {
    auditLoggingLoading = true;
    auditError = '';
    try {
      const res = await apiFetch('/api/audit-control');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load audit logging state');
      auditLoggingEnabled = !!data.enabled;
      auditRetentionDays = data.retentionDays;
    } catch (err) {
      auditError = (err as Error).message;
    } finally {
      auditLoggingLoading = false;
    }
  }

  async function handleAuditLoggingToggle(event: Event) {
    if (auditLoggingSaving) {
      event?.preventDefault();
      return;
    }
    const target = event.currentTarget as HTMLInputElement | null;
    const desired = target?.checked ?? !auditLoggingEnabled;
    auditLoggingSaving = true;
    try {
      const res = await apiFetch('/api/audit-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: desired })
      });
      if (!res.ok) {
        throw new Error('Failed to update audit logging state');
      }
      const data = await res.json();
      auditLoggingEnabled = !!data.enabled;
    } catch (err) {
      console.error('[SystemSettings] Error updating audit logging state:', err);
      if (target) target.checked = auditLoggingEnabled === true;
      alert(`Failed to update audit logging: ${(err as Error).message}`);
    } finally {
      auditLoggingSaving = false;
    }
  }

  async function purgeOldAuditLogs() {
    if (!confirm(auditRetentionDays === null
      ? 'Purge audit logs using the server retention setting? This cannot be undone.'
      : `Purge audit logs older than ${auditRetentionDays} days? This cannot be undone.`)) {
      return;
    }
    try {
      const res = await apiFetch('/api/audit-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purgeOld: true })
      });
      if (!res.ok) {
        throw new Error('Failed to purge old logs');
      }
      alert('Old audit logs have been purged successfully');
    } catch (err) {
      console.error('[SystemSettings] Error purging logs:', err);
      alert(`Failed to purge logs: ${(err as Error).message}`);
    }
  }

  async function loadModelInfo() {
    modelInfoError = '';
    try {
      const res = await apiFetch('/api/model-info');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load model information');
      modelInfo = data;
    } catch (err) {
      modelInfoError = (err as Error).message;
    }
  }

  async function loadLoggingConfig() {
    loggingMessage = '';
    try {
      const response = await apiFetch('/api/logging-config');
      const config = await response.json();
      if (!response.ok) throw new Error(config.error || 'Failed to load logging config');
      logLevel = config.level;
    } catch (err) { loggingMessage = (err as Error).message; }
  }

  async function saveLoggingConfig() {
    if (savingLogging) return;
    savingLogging = true;
    loggingMessage = '';
    try {
      const response = await apiFetch('/api/logging-config', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: logLevel }) });
      if (!response.ok) throw new Error('Failed to save logging config');
      loggingMessage = 'Logging configuration saved.';
    } catch (err) { loggingMessage = (err as Error).message; }
    finally { savingLogging = false; }
  }

  async function loadStorageStatus() {
    storageLoading = true;
    storageError = '';
    try {
      const res = await apiFetch('/api/storage-status');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load storage status');
      storageStatus = data;
    } catch (err) {
      storageError = (err as Error).message;
    } finally {
      storageLoading = false;
    }
  }

  async function loadReflectorContentMode() {
    reflectorContentModeLoading = true;
    reflectorError = '';
    try {
      const res = await apiFetch('/api/trigger-manager');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load memory content mode');
      const mode = data.snapshot?.globalSettings?.memoryContentMode;
      if (mode && ['all', 'user', 'agent'].includes(mode)) reflectorContentMode = mode as ContentMode;
    } catch (err) {
      reflectorError = (err as Error).message;
    } finally {
      reflectorContentModeLoading = false;
    }
  }

  async function handleReflectorContentModeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const newMode = target.value as ContentMode;

    if (reflectorContentModeSaving) return;
    reflectorContentModeSaving = true;

    try {
      const res = await apiFetch('/api/trigger-manager/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          globalSettings: {
            memoryContentMode: newMode
          }
        })
      });

      if (!res.ok) {
        throw new Error('Failed to update memory content mode');
      }

      reflectorContentMode = newMode;
    } catch (err) {
      console.error('[SystemSettings] Error updating memory content mode:', err);
      target.value = reflectorContentMode;
      alert(`Failed to update memory content mode: ${(err as Error).message}`);
    } finally {
      reflectorContentModeSaving = false;
    }
  }

  async function loadIndexContentMode() {
    indexContentModeLoading = true;
    indexError = '';
    try {
      const res = await apiFetch('/api/embeddings');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load index content mode');
      const mode = data.indexContentMode;
      if (mode && ['all', 'user', 'agent'].includes(mode)) indexContentMode = mode as ContentMode;
    } catch (err) {
      indexError = (err as Error).message;
    } finally {
      indexContentModeLoading = false;
    }
  }

  async function handleIndexContentModeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const newMode = target.value as ContentMode;

    if (indexContentModeSaving) return;
    indexContentModeSaving = true;

    try {
      const res = await apiFetch('/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          indexContentMode: newMode
        })
      });

      if (!res.ok) {
        throw new Error('Failed to update index content mode');
      }

      indexContentMode = newMode;
    } catch (err) {
      console.error('[SystemSettings] Error updating index content mode:', err);
      target.value = indexContentMode;
      alert(`Failed to update index content mode: ${(err as Error).message}`);
    } finally {
      indexContentModeSaving = false;
    }
  }
</script>

<div class="w-full">
  <!-- Resources Section -->
  <div class="setting-group">
    <div class="setting-label">Resources</div>
    <div class="flex flex-col gap-3">
      <a href="/user-guide" class="flex items-center gap-3 p-3.5 rounded-lg bg-violet-500/5 dark:bg-violet-400/10 border border-violet-500/15 dark:border-violet-400/20 no-underline text-inherit transition-all hover:bg-violet-500/10 dark:hover:bg-violet-400/15 hover:border-violet-500/30 dark:hover:border-violet-400/35 hover:translate-x-0.5">
        <span class="text-2xl shrink-0">📖</span>
        <div class="flex flex-col gap-0.5 flex-1">
          <span class="text-[0.9375rem] font-semibold text-gray-800 dark:text-gray-100">User Guide</span>
          <span class="text-xs text-gray-500 dark:text-gray-400">Complete documentation and manual</span>
        </div>
      </a>
      <a href="https://github.com/Greg-Aster/ainekio-os" target="_blank" rel="noopener noreferrer" class="flex items-center gap-3 p-3.5 rounded-lg bg-violet-500/5 dark:bg-violet-400/10 border border-violet-500/15 dark:border-violet-400/20 no-underline text-inherit transition-all hover:bg-violet-500/10 dark:hover:bg-violet-400/15 hover:border-violet-500/30 dark:hover:border-violet-400/35 hover:translate-x-0.5">
        <span class="text-2xl shrink-0">🔗</span>
        <div class="flex flex-col gap-0.5 flex-1">
          <span class="text-[0.9375rem] font-semibold text-gray-800 dark:text-gray-100">GitHub Repository</span>
          <span class="text-xs text-gray-500 dark:text-gray-400">Source code and development</span>
        </div>
      </a>
    </div>
  </div>

  <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-100 mt-8 mb-4">Model Settings</h3>
  <ModelRegistrySettings />

  <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-100 mt-8 mb-4">Agent Settings</h3>

  <!-- Agent Boot Manager -->
  <div class="setting-group">
    <div class="flex items-center justify-between gap-3 mb-3">
      <span class="setting-label m-0">Boot Manager</span>
      <button
        class="btn-secondary btn-sm"
        on:click={loadBootManager}
        disabled={bootManagerLoading || Boolean(bootManagerSaving)}
      >
        {bootManagerLoading ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>

    <p class="text-sm text-gray-500 dark:text-gray-400 m-0 mb-3">
      Controls persistent services and connections started with Ainekio OS. Finite scheduled and one-shot work is configured in Trigger Manager and runs through the Work Coordinator.
    </p>

    {#if bootManagerFeedback}
      <div
        class={`text-[0.8125rem] rounded-md border px-3 py-2 mb-3 ${bootManagerFeedback.type === 'success'
          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:bg-emerald-400/10 dark:border-emerald-400/25 dark:text-emerald-300'
          : 'bg-red-500/10 border-red-500/30 text-red-700 dark:bg-red-400/10 dark:border-red-400/25 dark:text-red-300'}`}
      >
        {bootManagerFeedback.text}
      </div>
    {/if}

    {#if bootManagerLoading && bootAgents.length === 0}
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0">Loading boot agents...</p>
    {:else if bootAgents.length === 0 && bootManagerFeedback?.type === 'error'}
      <p class="text-sm">Boot agent status is unavailable.</p>
    {:else if bootAgents.length === 0}
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0">No boot-eligible agents are currently registered.</p>
    {:else}
      <div class="flex flex-col gap-3">
        {#each bootAgents as agent}
          <div class="rounded-md border border-gray-200 dark:border-gray-800 p-3 bg-black/[0.02] dark:bg-white/[0.02]">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-semibold text-gray-800 dark:text-gray-100">{agent.displayName}</span>
                  <span class={`text-[0.68rem] font-semibold uppercase px-2 py-0.5 rounded ${bootKindClass(agent.kind)}`}>
                    {bootKindLabel(agent.kind)}
                  </span>
                </div>
                <p class="text-xs text-gray-500 dark:text-gray-400 m-0 mt-1">{agent.description}</p>
              </div>
              <label class="toggle-switch shrink-0" for={`boot-run-${agent.agentId}`} aria-label={`Run ${agent.displayName} on boot`}>
                <input
                  id={`boot-run-${agent.agentId}`}
                  type="checkbox"
                  checked={agent.startOnSystemBoot}
                  disabled={Boolean(bootManagerSaving)}
                  on:change={(event) => saveBootAgentVariable(agent, 'startOnSystemBoot', event.currentTarget.checked, event)}
                />
                <span class="toggle-slider"></span>
              </label>
            </div>

            {#if agent.dependencyNotes.length > 0}
              <div class="mt-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 dark:bg-amber-400/10 border border-amber-500/20 dark:border-amber-400/20 rounded px-2 py-1.5">
                {agent.dependencyNotes.join(' ')}
              </div>
            {/if}

            <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label class="flex items-center justify-between gap-3 text-sm text-gray-700 dark:text-gray-300">
                <span>Enabled</span>
                <input
                  type="checkbox"
                  checked={agent.enabled}
                  disabled={Boolean(bootManagerSaving)}
                  on:change={(event) => saveBootAgentVariable(agent, 'enabled', event.currentTarget.checked, event)}
                  class="cursor-pointer accent-violet-600 disabled:opacity-60"
                />
              </label>
              <label class="flex items-center justify-between gap-3 text-sm text-gray-700 dark:text-gray-300">
                <span>Auto restart</span>
                <input
                  type="checkbox"
                  checked={agent.autoRestart}
                  disabled={Boolean(bootManagerSaving)}
                  on:change={(event) => saveBootAgentVariable(agent, 'autoRestart', event.currentTarget.checked, event)}
                  class="cursor-pointer accent-violet-600 disabled:opacity-60"
                />
              </label>
              <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <span class="whitespace-nowrap">Retries</span>
                <input
                  type="number"
                  min="0"
                  max="20"
                  value={agent.maxRetries}
                  disabled={Boolean(bootManagerSaving)}
                  on:change={(event) => saveBootAgentVariable(agent, 'maxRetries', Number(event.currentTarget.value), event)}
                  class="input-field py-1 px-2 text-sm"
                />
              </label>
            </div>

            {#if bootManagerSaving.startsWith(`${agent.agentId}.`)}
              <p class="text-xs text-violet-600 dark:text-violet-400 m-0 mt-2 italic">Saving boot setting...</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Reflector Content Mode -->
  {#if reflectorError}<div class="setting-group text-red-600" role="alert">{reflectorError} <button class="btn-secondary btn-sm" on:click={loadReflectorContentMode}>Retry</button></div>{/if}
  <div class="setting-group">
    <div class="setting-label">Idle Thoughts Content</div>
    <div class="flex flex-col gap-2">
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0 mb-3">
        Controls what content agents (reflector, curiosity, etc.) reflect on when generating idle thoughts and inner dialogue.
      </p>
      <select
        class="select-field"
        value={reflectorContentMode}
        on:change={handleReflectorContentModeChange}
        disabled={reflectorContentModeLoading || reflectorContentModeSaving}
      >
        <option value="" disabled>Content mode unavailable</option>
        {#each Object.entries(contentModeOptions) as [mode, description]}
          <option value={mode}>{mode === 'user' ? '👤' : mode === 'agent' ? '🤖' : '📄'} {mode.charAt(0).toUpperCase() + mode.slice(1)}</option>
        {/each}
      </select>
      <p class="text-[0.8125rem] text-gray-500 dark:text-gray-400 m-0 mt-2 p-2 bg-violet-500/5 dark:bg-violet-400/10 rounded border-l-[3px] border-violet-600 dark:border-violet-400">
        {reflectorContentMode ? contentModeOptions[reflectorContentMode] : 'Current content mode is unavailable.'}
      </p>
      {#if reflectorContentModeSaving}
        <p class="text-xs text-violet-600 dark:text-violet-400 m-0 mt-2 italic">Saving...</p>
      {/if}
    </div>
  </div>

  <!-- Index Content Mode -->
  {#if indexError}<div class="setting-group text-red-600" role="alert">{indexError} <button class="btn-secondary btn-sm" on:click={loadIndexContentMode}>Retry</button></div>{/if}
  <div class="setting-group">
    <div class="setting-label">Memory Search Index</div>
    <div class="flex flex-col gap-2">
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0 mb-3">
        Controls what content is included in the semantic search index. Affects what memories can be found when searching.
      </p>
      <select
        class="select-field"
        value={indexContentMode}
        on:change={handleIndexContentModeChange}
        disabled={indexContentModeLoading || indexContentModeSaving}
      >
        <option value="" disabled>Index content mode unavailable</option>
        {#each Object.entries(indexContentModeOptions) as [mode, description]}
          <option value={mode}>{mode === 'user' ? '👤' : mode === 'agent' ? '🤖' : '📄'} {mode.charAt(0).toUpperCase() + mode.slice(1)}</option>
        {/each}
      </select>
      <p class="text-[0.8125rem] text-gray-500 dark:text-gray-400 m-0 mt-2 p-2 bg-violet-500/5 dark:bg-violet-400/10 rounded border-l-[3px] border-violet-600 dark:border-violet-400">
        {indexContentMode ? indexContentModeOptions[indexContentMode] : 'Current index content mode is unavailable.'}
      </p>
      {#if indexContentModeSaving}
        <p class="text-xs text-violet-600 dark:text-violet-400 m-0 mt-2 italic">Saving...</p>
      {/if}
      <p class="text-xs text-gray-400 dark:text-gray-500 m-0 mt-2 italic">
        Note: Changes require rebuilding the index to take effect.
      </p>
    </div>
  </div>

  <!-- Active Operator Settings -->
  <ActiveOperatorSettings />

  <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-100 mt-8 mb-4">Developer Settings</h3>

  <!-- Audit Logging Control -->
  {#if auditError}<div class="setting-group text-red-600" role="alert">{auditError} <button class="btn-secondary btn-sm" on:click={loadAuditLoggingState}>Retry</button></div>{/if}
  <div class="setting-group mt-6">
    <div class="setting-label">Audit Logging</div>
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="setting-label">Enable detailed activity logs</span>
        <label
          class="toggle-switch"
          for="audit-logging-toggle"
          aria-label="Toggle audit logging"
        >
          <input
            id="audit-logging-toggle"
            type="checkbox"
            checked={auditLoggingEnabled === true}
            disabled={auditLoggingLoading || auditLoggingSaving}
            on:change={handleAuditLoggingToggle}
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0">
        {#if auditLoggingEnabled === null}
          Audit recording status is unavailable.
        {:else if auditLoggingEnabled}
          Audit logging records security events, actions, training and failures. Settings apply across processes and restarts.
        {:else}
          Audit logging is off. New structured audit history is not recorded; existing history remains available.
        {/if}
      </p>
      <div class="mt-2">
        <button
          class="btn-secondary btn-sm"
          on:click={purgeOldAuditLogs}
          disabled={auditLoggingSaving}
        >
          🗑️ {auditRetentionDays === null ? 'Purge Old Audit Logs' : `Purge Logs Older Than ${auditRetentionDays} Days`}
        </button>
      </div>
    </div>
  </div>

  <!-- Active Model Info -->
  {#if modelInfoError}<div class="setting-group text-red-600" role="alert">{modelInfoError} <button class="btn-secondary btn-sm" on:click={loadModelInfo}>Retry</button></div>{/if}
  {#if modelInfo}
    <div class="setting-group">
      <div class="setting-label">Active Model Info</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-key">Persona model:</span>
          <span class="info-value font-mono">{modelInfo.activeModel}</span>
        </div>
        {#if modelInfo.adapter}
          <div class="info-item">
            <span class="info-key">Training candidate:</span>
            <span class="info-value text-violet-600 dark:text-violet-400 font-semibold">
              {modelInfo.adapter.runLabel ?? modelInfo.adapter.dataset}
            </span>
          </div>
        {:else}
          <div class="info-item">
            <span class="info-key">Training candidate:</span>
            <span class="info-value text-gray-400 dark:text-gray-500">None</span>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="setting-group">
      <div class="setting-label">Active Model Info</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-key">Status:</span>
          <span class="info-value text-gray-400 dark:text-gray-500">Unavailable</span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Logging Configuration -->
  <div class="setting-group">
    <div class="setting-label">Logging Configuration</div>
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <label for="log-level-select" class="text-sm font-medium text-gray-600 dark:text-gray-400">Log Level</label>
        <select id="log-level-select" bind:value={logLevel} class="select-field">
          <option value="" disabled>Log level unavailable</option>
          <option value="error">Error</option>
          <option value="warn">Warning</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
      </div>

      <p class="text-sm text-gray-500 dark:text-gray-400 m-0">Controls application module logs; module-specific overrides remain in machine logging.json. Audit history has its own recording setting above.</p>
      {#if loggingMessage}<p class="text-sm" role="status">{loggingMessage} <button class="btn-secondary btn-sm" on:click={loadLoggingConfig}>Retry read</button></p>{/if}
      <button class="btn-primary" on:click={saveLoggingConfig} disabled={savingLogging}>
        {savingLogging ? 'Saving...' : 'Save Logging Config'}
      </button>
    </div>
  </div>

  <!-- GPU Monitoring -->
  <div class="setting-group">
    <div class="setting-label">GPU Memory Status</div>
    <GPUMonitor />
  </div>

  <!-- File Path Manager -->
  <div class="setting-group mt-6">
    <div class="flex items-center justify-between mb-3">
      <div class="setting-label">File Path Manager</div>
      <button
        class="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 cursor-pointer text-base transition-all hover:bg-gray-100 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
        on:click={loadStorageStatus}
        disabled={storageLoading}
        title="Refresh storage status"
      >
        {storageLoading ? '...' : '↻'}
      </button>
    </div>

    {#if storageError}<p class="text-red-600" role="alert">{storageError} <button class="btn-secondary btn-sm" on:click={loadStorageStatus}>Retry</button></p>{/if}
    {#if storageLoading && !storageStatus}
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0">Loading storage status...</p>
    {:else if storageStatus && !storageStatus.authenticated}
      <div class="flex items-center gap-2 p-3 rounded-md mb-3 bg-amber-500/10 dark:bg-amber-400/10 border border-amber-500/30 dark:border-amber-400/25 text-amber-600 dark:text-amber-400">
        <span>⚠️</span>
        <span>Login required to view storage paths</span>
      </div>
    {:else if storageStatus}
      <!-- Storage Status Summary -->
      <div class="flex gap-2 flex-wrap mb-4">
        <div class="inline-flex items-center px-2 py-1 rounded text-xs font-medium {storageStatus.status?.available ? 'bg-emerald-500/10 dark:bg-emerald-400/15 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/10 dark:bg-red-400/15 text-red-600 dark:text-red-400'}">
          {storageStatus.status?.available ? '✓ Available' : '✗ Unavailable'}
        </div>
        <div class="inline-flex items-center px-2 py-1 rounded text-xs bg-violet-500/10 dark:bg-violet-400/15 text-violet-700 dark:text-violet-400">
          {#if storageStatus.status?.type === 'external'}
            💾 External
          {:else if storageStatus.status?.type === 'network'}
            🌐 Network
          {:else}
            📁 Internal
          {/if}
        </div>
        {#if storageStatus.status?.configured}
          <span class="inline-flex items-center px-2 py-1 rounded text-xs bg-blue-500/10 dark:bg-blue-400/15 text-blue-600 dark:text-blue-400">Custom</span>
        {:else}
          <span class="inline-flex items-center px-2 py-1 rounded text-xs bg-gray-500/10 dark:bg-gray-400/15 text-gray-600 dark:text-gray-400">Default</span>
        {/if}
      </div>

      {#if storageStatus.status?.error}
        <div class="flex items-center gap-2 p-3 rounded-md mb-3 bg-red-500/10 dark:bg-red-400/10 border border-red-500/30 dark:border-red-400/25 text-red-600 dark:text-red-400 text-sm">
          <span>⚠️</span>
          <span>{storageStatus.status.error}</span>
        </div>
      {/if}

      <!-- Profile Root -->
      <div class="flex flex-col gap-1 mb-4 p-3 bg-violet-500/5 dark:bg-violet-400/10 rounded-md border border-violet-500/15 dark:border-violet-400/20">
        <span class="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-400">Profile Root</span>
        <code class="font-mono text-[0.8125rem] text-gray-700 dark:text-gray-200 break-all">{storageStatus.status?.path || 'Not configured'}</code>
      </div>

      <!-- Storage Paths by Category -->
      {#if storageStatus.paths}
        <div class="grid grid-cols-[auto_1fr] gap-3 gap-x-4 mb-4">
          <div class="flex items-start gap-1.5 pt-1">
            <span class="text-base">🧠</span>
            <span class="text-[0.8125rem] font-semibold text-gray-700 dark:text-gray-300">Memory</span>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-gray-500 dark:text-gray-400">Episodic:</span>
              <code class="font-mono text-xs text-gray-600 dark:text-gray-300 break-all bg-black/5 dark:bg-white/5 px-1.5 py-1 rounded {!storageStatus.paths.episodic?.available ? 'text-gray-400 dark:text-gray-500 bg-red-500/5 dark:bg-red-400/5' : ''}">{storageStatus.paths.episodic?.path || 'N/A'}</code>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-gray-500 dark:text-gray-400">Procedural:</span>
              <code class="font-mono text-xs text-gray-600 dark:text-gray-300 break-all bg-black/5 dark:bg-white/5 px-1.5 py-1 rounded {!storageStatus.paths.procedural?.available ? 'text-gray-400 dark:text-gray-500 bg-red-500/5 dark:bg-red-400/5' : ''}">{storageStatus.paths.procedural?.path || 'N/A'}</code>
            </div>
          </div>

          <div class="flex items-start gap-1.5 pt-1">
            <span class="text-base">⚙️</span>
            <span class="text-[0.8125rem] font-semibold text-gray-700 dark:text-gray-300">Config</span>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-gray-500 dark:text-gray-400">Persona:</span>
              <code class="font-mono text-xs text-gray-600 dark:text-gray-300 break-all bg-black/5 dark:bg-white/5 px-1.5 py-1 rounded {!storageStatus.paths.persona?.available ? 'text-gray-400 dark:text-gray-500 bg-red-500/5 dark:bg-red-400/5' : ''}">{storageStatus.paths.persona?.path || 'N/A'}</code>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-gray-500 dark:text-gray-400">Settings:</span>
              <code class="font-mono text-xs text-gray-600 dark:text-gray-300 break-all bg-black/5 dark:bg-white/5 px-1.5 py-1 rounded {!storageStatus.paths.etc?.available ? 'text-gray-400 dark:text-gray-500 bg-red-500/5 dark:bg-red-400/5' : ''}">{storageStatus.paths.etc?.path || 'N/A'}</code>
            </div>
          </div>

          <div class="flex items-start gap-1.5 pt-1">
            <span class="text-base">🎤</span>
            <span class="text-[0.8125rem] font-semibold text-gray-700 dark:text-gray-300">Voice</span>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-gray-500 dark:text-gray-400">Training:</span>
              <code class="font-mono text-xs text-gray-600 dark:text-gray-300 break-all bg-black/5 dark:bg-white/5 px-1.5 py-1 rounded {!storageStatus.paths.voice?.available ? 'text-gray-400 dark:text-gray-500 bg-red-500/5 dark:bg-red-400/5' : ''}">{storageStatus.paths.voice?.path || 'N/A'}</code>
            </div>
          </div>

          <div class="flex items-start gap-1.5 pt-1">
            <span class="text-base">📊</span>
            <span class="text-[0.8125rem] font-semibold text-gray-700 dark:text-gray-300">Training</span>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-gray-500 dark:text-gray-400">Data:</span>
              <code class="font-mono text-xs text-gray-600 dark:text-gray-300 break-all bg-black/5 dark:bg-white/5 px-1.5 py-1 rounded {!storageStatus.paths.training?.available ? 'text-gray-400 dark:text-gray-500 bg-red-500/5 dark:bg-red-400/5' : ''}">{storageStatus.paths.training?.path || 'N/A'}</code>
            </div>
          </div>

          <div class="flex items-start gap-1.5 pt-1">
            <span class="text-base">📤</span>
            <span class="text-[0.8125rem] font-semibold text-gray-700 dark:text-gray-300">Output</span>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-xs text-gray-500 dark:text-gray-400">Artifacts:</span>
              <code class="font-mono text-xs text-gray-600 dark:text-gray-300 break-all bg-black/5 dark:bg-white/5 px-1.5 py-1 rounded {!storageStatus.paths.output?.available ? 'text-gray-400 dark:text-gray-500 bg-red-500/5 dark:bg-red-400/5' : ''}">{storageStatus.paths.output?.path || 'N/A'}</code>
            </div>
          </div>
        </div>
      {/if}

      <p class="text-[0.8125rem] text-gray-500 dark:text-gray-400 m-0">
        Configure custom storage locations in the <strong class="text-gray-600 dark:text-gray-300">Storage</strong> tab.
      </p>
    {:else}
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0">Unable to load storage status</p>
    {/if}
  </div>


</div>

<style>
  .info-grid {
    @apply flex flex-col gap-2 p-3 rounded-lg bg-black/5;
  }

  :global(.dark) .info-grid {
    @apply bg-white/5;
  }

  .info-item {
    @apply flex justify-between text-sm;
  }

  .info-key {
    @apply text-gray-500;
  }

  :global(.dark) .info-key {
    @apply text-gray-400;
  }

  .info-value {
    @apply font-semibold text-gray-900;
  }

  :global(.dark) .info-value {
    @apply text-gray-100;
  }

  .toggle-switch {
    @apply relative inline-block w-12 h-6 cursor-pointer;
  }

  .toggle-switch input {
    @apply opacity-0 w-0 h-0;
  }

  .toggle-slider {
    @apply absolute cursor-pointer top-0 left-0 right-0 bottom-0 bg-gray-300 transition-all rounded-full;
  }

  :global(.dark) .toggle-slider {
    @apply bg-gray-700;
  }

  .toggle-slider:before {
    content: "";
    @apply absolute bg-white transition-all rounded-full;
    height: 1.125rem;
    /* 18px, equivalent to h-4.5 */
    width: 1.125rem;
    /* 18px, equivalent to w-4.5 */
    left: 0.1875rem;
    /* 3px, equivalent to left-0.75 */
    bottom: 0.1875rem;
    /* 3px, equivalent to bottom-0.75 */
  }

  .toggle-switch input:checked + .toggle-slider {
    @apply bg-violet-600;
  }

  :global(.dark) .toggle-switch input:checked + .toggle-slider {
    @apply bg-violet-400;
  }

  .toggle-switch input:checked + .toggle-slider:before {
    transform: translateX(1.5rem);
  }

  .toggle-switch input:disabled + .toggle-slider {
    @apply opacity-50 cursor-not-allowed;
  }
</style>
