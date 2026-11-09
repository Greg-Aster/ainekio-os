<script lang="ts">
  import { onMount } from 'svelte';
  import { apiEventSource, apiFetch } from '../lib/client/api-config';
  import { get } from 'svelte/store';
  import { isOwner } from '../stores/security-policy';
  import { rightSidebarSection } from '../stores/navigation';
  import BodyConnectionSelector from './BodyConnectionSelector.svelte';
  import EnvironmentBridgeDiagnostics from './EnvironmentBridgeDiagnostics.svelte';
  import type { EnvironmentBridgeDiagnosticsSnapshot } from '../lib/client/environment-bridge-diagnostics-types';

  type AgentKind = 'service' | 'scheduled' | 'manual' | 'connection' | 'one-shot';
  type AgentStatus = 'running' | 'stopped' | 'error';
  type AgentVariableType = 'text' | 'number' | 'port' | 'url' | 'select' | 'multiselect' | 'toggle' | 'secretRef' | 'readonly';
  type AgentVariableApplyMode = 'live' | 'restart' | 'nextBoot' | 'readonly';

  interface AgentError {
    timestamp: string;
    agent: string;
    message: string;
    source?: string;
    pid?: number;
    exitCode?: number | null;
    stderr?: string;
    stdout?: string;
  }

  interface AgentVariable {
    key: string;
    label: string;
    type: AgentVariableType;
    value: string | number | boolean | string[] | null;
    applyMode: AgentVariableApplyMode;
    writable: boolean;
    description?: string;
    options?: string[];
  }

  interface AgentDescriptor {
    id: string;
    name: string;
    description: string;
    kind: AgentKind;
    startable: boolean;
    bootEligible: boolean;
    variables: AgentVariable[];
  }

  interface AgentCard {
    name: string;
    displayName: string;
    description: string;
    kind: AgentKind;
    status: AgentStatus;
    pid?: number;
    uptime?: number;
    startedAt?: string;
    lastActivity?: string;
    errors: string[];
  }

  interface AgentDataPanel {
    agentId: string;
    displayName: string;
    description: string;
    kind: AgentKind;
    lifecycle: AgentStatus;
    pid?: number;
    uptime?: number;
    readiness: 'ready' | 'not-ready' | 'failed' | 'unknown';
    dependencyHealth: 'ok' | 'configured' | 'connecting' | 'missing' | 'unavailable' | 'failed' | 'unknown';
    latestTask?: string;
    variables: AgentVariable[];
    errors: AgentError[];
    diagnostics?: EnvironmentBridgeDiagnosticsSnapshot;
  }

  let connected = false;
  let streamError = '';
  let snapshotRead: AbortController | undefined;
  let hasSnapshot = false;
  let runningAgents: AgentCard[] = [];
  let recentFailures: AgentCard[] = [];
  let startableAgents: AgentDescriptor[] = [];
  let agentData: Record<string, AgentDataPanel> = {};
  let registeredServices = new Set<string>();
  let selectedAgentName = '';
  let selectedStartAgent = '';
  let startingAgent = '';
  let controllingAgent = '';
  let refreshing = false;
  let savingFields = new Set<string>();
  let connectingBody = false;
  let fieldDrafts: Record<string, string | number | boolean | string[] | null> = {};
  let restartingBootAgents = false;
  let feedback: { type: 'success' | 'error' | 'info'; text: string } | null = null;

  $: selectedAgent = selectedAgentName ? agentData[selectedAgentName] : undefined;
  $: selectedAgentStartable = Boolean(selectedAgent && startableAgents.some(agent => agent.id === selectedAgent.agentId));
  $: if (!selectedAgentName) {
    selectedAgentName = runningAgents[0]?.name || recentFailures[0]?.name || startableAgents[0]?.id || '';
  }
  $: if (!selectedStartAgent || !startableAgents.some(agent => agent.id === selectedStartAgent)) {
    selectedStartAgent = startableAgents[0]?.id || '';
  }

  function showFeedback(type: 'success' | 'error' | 'info', text: string) {
    feedback = { type, text };
  }

  function formatUptime(seconds?: number): string {
    if (!seconds) return '0m';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function fieldKey(agentId: string, key: string): string {
    return `${agentId}.${key}`;
  }

  function draftValue(agentId: string, variable: AgentVariable) {
    const key = fieldKey(agentId, variable.key);
    return fieldDrafts[key] ?? variable.value ?? '';
  }

  function setDraftValue(agentId: string, variable: AgentVariable, value: string | number | boolean | string[] | null) {
    fieldDrafts = {
      ...fieldDrafts,
      [fieldKey(agentId, variable.key)]: value,
    };
  }

  function applyModeLabel(mode: AgentVariableApplyMode): string {
    if (mode === 'live') return 'Live';
    if (mode === 'restart') return 'Restart';
    if (mode === 'nextBoot') return 'Next boot';
    return 'Read only';
  }

  function feedbackClass(): string {
    if (!feedback) return '';
    if (feedback.type === 'success') return 'bg-green-600 text-white border-green-600';
    if (feedback.type === 'error') return 'bg-red-600 text-white border-red-600';
    return 'bg-blue-600 text-white border-blue-600';
  }

  function lifecycleClass(lifecycle: AgentStatus): string {
    if (lifecycle === 'running') return 'bg-green-600 text-white';
    if (lifecycle === 'error') return 'bg-red-600 text-white';
    return 'bg-gray-200 dark:bg-gray-800';
  }

  function readinessClass(readiness: AgentDataPanel['readiness']): string {
    if (readiness === 'ready') return 'bg-green-600 text-white';
    if (readiness === 'failed') return 'bg-red-600 text-white';
    if (readiness === 'not-ready') return 'bg-amber-500 text-gray-950';
    return 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-200';
  }

  function readinessDot(readiness?: AgentDataPanel['readiness']): string {
    if (readiness === 'ready') return 'bg-green-500';
    if (readiness === 'failed') return 'bg-red-500';
    if (readiness === 'not-ready') return 'bg-amber-500';
    return 'bg-gray-400';
  }
  function applyPayload(data: {
    runningAgents: AgentCard[];
    recentFailures: AgentCard[];
    startableAgents: AgentDescriptor[];
    agentData: Record<string, AgentDataPanel>;
    catalog: { agents: Array<{ id: string; serviceRegistered: boolean }> };
  }) {
    runningAgents = data.runningAgents;
    recentFailures = data.recentFailures;
    startableAgents = data.startableAgents;
    agentData = data.agentData;
    registeredServices = new Set(data.catalog.agents.filter(agent => agent.serviceRegistered).map(agent => agent.id));
    hasSnapshot = true;
  }

  async function refreshNow() {
    snapshotRead?.abort();
    const current = new AbortController();
    snapshotRead = current;
    refreshing = true;
    try {
      const response = await apiFetch('/api/monitor', { signal: current.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to refresh Agent Monitor');
      if (!current.signal.aborted) applyPayload(data);
    } catch (err) {
      if (!current.signal.aborted) showFeedback('error', err instanceof Error ? err.message : 'Monitor refresh failed');
    } finally {
      if (snapshotRead === current) { snapshotRead = undefined; refreshing = false; }
    }
  }

  async function runAgent(agentName = selectedStartAgent) {
    if (!agentName) return;
    startingAgent = agentName;
    showFeedback('info', `Starting ${agentName}...`);
    try {
      const res = await apiFetch('/api/agents/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentName }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || data.message || 'Failed to run agent');
      }
      selectedAgentName = agentName;
      showFeedback('success', data.taskId
        ? `${agentName} queued as ${data.taskId}`
        : data.pid
          ? `${agentName} started with PID ${data.pid}`
          : `${agentName} start requested`);
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Agent start failed');
    } finally {
      startingAgent = '';
    }
  }

  async function controlAgent(action: 'stop' | 'restart' | 'clear-failure', agentName: string) {
    controllingAgent = agentName;
    feedback = null;
    try {
      const res = await apiFetch('/api/agents/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, agent: agentName }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || `Failed to ${action} ${agentName}`);
      }
      showFeedback('success', data.message || `${agentName} ${action} complete`);
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : `Failed to ${action} agent`);
    } finally {
      controllingAgent = '';
    }
  }

  async function connectBody(agent: string, settings: Record<string, string | number | boolean>) {
    connectingBody = true;
    feedback = null;
    try {
      for (const [key, value] of Object.entries(settings)) {
        const res = await apiFetch('/api/monitor/agent-variable', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent, key, value }),
        });
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || `Could not save ${key}`);
      }
      selectedAgentName = agent;
      if (runningAgents.some(item => item.name === agent)) {
        await controlAgent('restart', agent);
      } else {
        await runAgent(agent);
      }
    } catch (err) {
      showFeedback('error', `Connection settings were not fully saved; no connection switch requested. ${err instanceof Error ? err.message : err}`);
    } finally {
      connectingBody = false;
    }
  }

  async function saveVariable(panel: AgentDataPanel, variable: AgentVariable) {
    if (!variable.writable) return;
    const key = fieldKey(panel.agentId, variable.key);
    savingFields = new Set(savingFields).add(key);
    const value = draftValue(panel.agentId, variable);
    feedback = null;

    try {
      const res = await apiFetch('/api/monitor/agent-variable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: panel.agentId,
          key: variable.key,
          value,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Failed to save variable');
      }
      if (data.agentData && agentData[panel.agentId] === panel) {
        agentData = {
          ...agentData,
          [panel.agentId]: data.agentData,
        };
      }
      if (JSON.stringify(fieldDrafts[key]) === JSON.stringify(value)) {
        const { [key]: committed, ...remaining } = fieldDrafts;
        fieldDrafts = remaining;
      }
      showFeedback('success', `${variable.label} saved (${applyModeLabel(variable.applyMode)})`);
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Variable save failed');
    } finally {
      const remaining = new Set(savingFields);
      remaining.delete(key);
      savingFields = remaining;
    }
  }

  async function restartBootAgents() {
    restartingBootAgents = true;
    feedback = null;

    try {
      const res = await apiFetch('/api/agents/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart-core' }),
      });
      const result = await res.json();
      if (!res.ok || result.success === false) throw new Error(result.message || 'Bulk action failed');
      showFeedback('success', result.message || 'Boot agent restart requested');
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Action failed');
    } finally {
      restartingBootAgents = false;
    }
  }

  onMount(() => {
    if (!get(isOwner)) return;
    const source = apiEventSource('/api/monitor/stream');
    source.onopen = () => { connected = true; };
    source.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'error') {
          streamError = data.error;
        } else if (data.type === 'snapshot') {
          snapshotRead?.abort();
          applyPayload(data);
          streamError = '';
        }
      } catch (err) {
        streamError = err instanceof Error ? err.message : 'Monitor update could not be read';
      }
    };
    source.onerror = () => {
      connected = false;
      streamError = 'Agent Monitor connection interrupted. Reconnecting…';
    };
    return () => {
      snapshotRead?.abort();
      source.onopen = source.onmessage = source.onerror = null;
      source.close();
    };
  });
</script>

<div class="flex h-full min-h-0 flex-col gap-3 text-gray-900 dark:text-gray-100">
    <div class="shrink-0 border-b border-gray-200 pb-3 dark:border-gray-800">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm font-semibold">Services & Agents</div>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-[0.7rem] text-gray-500 dark:text-gray-400">
            <span class="inline-flex items-center gap-1.5">
              <span class={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`}></span>
              {connected ? 'Live stream' : 'Connecting'}
            </span>
            {#if hasSnapshot}<span>{runningAgents.length} active</span>{/if}
            {#if recentFailures.length > 0}
              <span class="text-red-600 dark:text-red-300">{recentFailures.length} failed</span>
            {/if}
          </div>
        </div>
        <div class="flex shrink-0 gap-1.5">
          <button
            class="rounded border border-gray-300 px-2 py-1 text-[0.68rem] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
            disabled={refreshing}
            on:click={refreshNow}
            title="Refresh service, connection, and agent state now"
          >
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
          <button
            class="rounded border border-gray-300 px-2 py-1 text-[0.68rem] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
            disabled={restartingBootAgents}
            on:click={restartBootAgents}
            title="Restart configured startup agents"
          >
            {restartingBootAgents ? 'Restarting' : 'Restart Boot Agents'}
          </button>
        </div>
      </div>

      <div class="mt-3">
        <div class="mb-1 text-[0.68rem] font-semibold uppercase text-gray-500 dark:text-gray-400">Start Agent</div>
        <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select
          bind:value={selectedStartAgent}
          class="min-w-0 rounded border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
          disabled={startableAgents.length === 0}
          aria-label="Startable agent"
        >
          {#if startableAgents.length === 0}
            <option value="">No agents available</option>
          {:else}
            {#each startableAgents as agent}
              <option value={agent.id}>{agent.name}</option>
            {/each}
          {/if}
        </select>
        <button
          class="rounded bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-950"
          disabled={!selectedStartAgent || Boolean(startingAgent)}
          on:click={() => runAgent()}
        >
          {startingAgent ? 'Starting' : 'Start'}
        </button>
        </div>
      </div>

      {#if streamError}<div class="mt-2 rounded border border-red-500 p-2 text-xs text-red-600 dark:text-red-300">{streamError}</div>{/if}
      {#if feedback}
        <div class={`mt-2 rounded border px-2 py-1.5 text-xs ${feedbackClass()}`}>
          {feedback.text}
        </div>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto pr-1">
      <BodyConnectionSelector
        reveal={$rightSidebarSection === 'body-connection'}
        agents={Object.values(agentData).map(panel => ({ id: panel.agentId, variables: panel.variables }))}
        connections={agentData['environment-bridge']?.diagnostics?.connections || []}
        busy={connectingBody || Boolean(startingAgent) || Boolean(controllingAgent) || savingFields.size > 0}
        onConnect={connectBody}
      />

      <section class="space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="m-0 text-[0.68rem] font-semibold uppercase text-gray-500 dark:text-gray-400">Active Services & Agents</h3>
          <span class="text-[0.68rem] text-gray-500 dark:text-gray-400">{runningAgents.length}</span>
        </div>

        {#if !hasSnapshot}
          <p class="text-sm text-gray-500">{streamError ? 'Agent state is unavailable.' : 'Loading agent state…'}</p>
        {:else if runningAgents.length === 0}
          <button
            class="w-full rounded border border-dashed border-gray-300 px-3 py-4 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
            on:click={() => selectedAgentName = selectedStartAgent}
          >
            No agents are running. Use Start to launch an available agent.
          </button>
        {:else}
          <div class="space-y-1.5">
            {#each runningAgents as agent}
              {@const readiness = agentData[agent.name]?.readiness}
              <button
                class={`w-full rounded border px-2.5 py-2 text-left transition ${selectedAgentName === agent.name ? 'border-gray-900 bg-gray-100 dark:border-gray-100 dark:bg-gray-900' : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-900'}`}
                on:click={() => selectedAgentName = agent.name}
              >
                <div class="flex items-center gap-2">
                  <span class={`h-2.5 w-2.5 rounded-full ${readinessDot(readiness)}`}></span>
                  <span class="min-w-0 flex-1 truncate text-sm font-medium">{agent.displayName}</span>
                  <span class="shrink-0 font-mono text-[0.68rem] text-gray-500 dark:text-gray-400">{agent.pid ?? (agent.kind === 'connection' ? 'connection' : 'integrated')}</span>
                </div>
                <div class="mt-1 flex items-center justify-between gap-2 text-[0.68rem] text-gray-500 dark:text-gray-400">
                  <span class="truncate">{agent.kind}</span>
                  <span>{agent.pid ? formatUptime(agent.uptime) : readiness ?? 'unknown'}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </section>

      {#if recentFailures.length > 0}
        <section class="mt-4 space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="m-0 text-[0.68rem] font-semibold uppercase text-red-700 dark:text-red-300">Failures</h3>
            <span class="text-[0.68rem] text-red-700 dark:text-red-300">{recentFailures.length}</span>
          </div>
          <div class="space-y-1.5">
            {#each recentFailures as agent}
              <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
                <button
                  class={`min-w-0 rounded border px-2.5 py-2 text-left transition ${selectedAgentName === agent.name ? 'border-red-500 bg-red-50 dark:bg-red-950/30' : 'border-red-200 bg-red-50/60 hover:bg-red-50 dark:border-red-900/60 dark:bg-red-950/20'}`}
                  on:click={() => selectedAgentName = agent.name}
                >
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 rounded-full bg-red-500"></span>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium">{agent.displayName}</span>
                    <span class="shrink-0 text-[0.68rem] font-semibold uppercase text-red-700 dark:text-red-300">error</span>
                  </div>
                  <div class="mt-1 truncate text-[0.68rem] text-red-700 dark:text-red-300">{agent.errors[0] || 'Start failed'}</div>
                </button>
                <button
                  class="rounded border border-red-300 px-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-950/30"
                  disabled={Boolean(startingAgent) || controllingAgent === agent.name}
                  on:click={() => runAgent(agent.name)}
                  title={`Retry ${agent.displayName}`}
                >
                  {startingAgent === agent.name ? 'Starting' : 'Retry'}
                </button>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <section class="mt-4 space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="m-0 text-[0.68rem] font-semibold uppercase text-gray-500 dark:text-gray-400">Agent Data</h3>
          {#if selectedAgent}
            <span class={`rounded px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase ${selectedAgent.kind === 'connection' ? readinessClass(selectedAgent.readiness) : lifecycleClass(selectedAgent.lifecycle)}`}>{selectedAgent.kind === 'connection' ? selectedAgent.readiness : selectedAgent.lifecycle}</span>
          {/if}
        </div>

        {#if !selectedAgent}
          <div class="rounded border border-gray-200 px-3 py-4 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
            Select a running, failed, or startable agent to inspect variables and output.
          </div>
        {:else}
          <div class="space-y-3 rounded border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
            <div>
              <div class="truncate text-sm font-semibold">{selectedAgent.displayName}</div>
              <div class="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{selectedAgent.description}</div>
            </div>

            <div class="flex flex-wrap gap-2">
              {#if selectedAgent.lifecycle === 'running' && registeredServices.has(selectedAgent.agentId)}
                <button
                  class="rounded border border-gray-300 px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700"
                  disabled={Boolean(controllingAgent) || Boolean(startingAgent)}
                  on:click={() => controlAgent('stop', selectedAgent.agentId)}
                >
                  {controllingAgent === selectedAgent.agentId ? 'Stopping' : 'Stop'}
                </button>
                <button
                  class="rounded bg-gray-900 px-2 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-950"
                  disabled={Boolean(controllingAgent) || Boolean(startingAgent)}
                  on:click={() => controlAgent('restart', selectedAgent.agentId)}
                >
                  {controllingAgent === selectedAgent.agentId ? 'Restarting' : 'Restart'}
                </button>
              {:else if selectedAgentStartable}
                <button
                  class="rounded bg-gray-900 px-2 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-950"
                  disabled={Boolean(startingAgent) || Boolean(controllingAgent)}
                  on:click={() => runAgent(selectedAgent.agentId)}
                >
                  {startingAgent === selectedAgent.agentId ? 'Starting' : selectedAgent.lifecycle === 'error' ? 'Retry' : 'Start'}
                </button>
              {/if}
              {#if selectedAgent.lifecycle === 'error'}
                <button
                  class="rounded border border-gray-300 px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700"
                  disabled={Boolean(controllingAgent) || Boolean(startingAgent)}
                  on:click={() => controlAgent('clear-failure', selectedAgent.agentId)}
                >
                  Dismiss Failure
                </button>
              {/if}
            </div>

            <div class="grid grid-cols-3 gap-2 text-xs">
              <div class="rounded bg-gray-50 p-2 dark:bg-gray-900">
                <div class="text-[0.62rem] uppercase text-gray-500 dark:text-gray-400">Runtime</div>
                <div class="mt-0.5 font-mono">{selectedAgent.pid ?? (selectedAgent.kind === 'connection' ? 'server' : 'none')}</div>
              </div>
              <div class="rounded bg-gray-50 p-2 dark:bg-gray-900">
                <div class="text-[0.62rem] uppercase text-gray-500 dark:text-gray-400">Ready</div>
                <div class="mt-0.5">{selectedAgent.readiness}</div>
              </div>
              <div class="rounded bg-gray-50 p-2 dark:bg-gray-900">
                <div class="text-[0.62rem] uppercase text-gray-500 dark:text-gray-400">Dependency</div>
                <div class="mt-0.5">{selectedAgent.dependencyHealth}</div>
              </div>
            </div>

            {#if selectedAgent.latestTask}
              <div class="rounded bg-gray-50 px-2 py-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                {selectedAgent.latestTask}
              </div>
            {/if}

            {#if selectedAgent.agentId === 'environment-bridge' && selectedAgent.diagnostics}
              <EnvironmentBridgeDiagnostics diagnostics={selectedAgent.diagnostics} />
            {/if}

            {#if selectedAgent.variables.length > 0}
              <div class="space-y-2">
                <div class="text-[0.68rem] font-semibold uppercase text-gray-500 dark:text-gray-400">Variables</div>
                {#each selectedAgent.variables as variable}
                  {@const key = fieldKey(selectedAgent.agentId, variable.key)}
                  {#if variable.writable}
                    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                      <label class="min-w-0">
                        <span class="block truncate text-[0.7rem] font-medium text-gray-600 dark:text-gray-300">{variable.label}</span>
                        {#if variable.type === 'toggle'}
                          <input
                            type="checkbox"
                            checked={Boolean(draftValue(selectedAgent.agentId, variable))}
                            on:change={(event) => setDraftValue(selectedAgent.agentId, variable, event.currentTarget.checked)}
                            class="mt-1 h-4 w-4 accent-gray-900 dark:accent-gray-100"
                          />
                        {:else if variable.type === 'select'}
                          <select value={String(draftValue(selectedAgent.agentId, variable))}
                            on:change={(event) => setDraftValue(selectedAgent.agentId, variable, event.currentTarget.value)}
                            class="mt-1 w-full rounded border bg-transparent p-2 text-xs">
                            {#each variable.options ?? [] as option}<option value={option}>{option}</option>{/each}
                          </select>
                        {:else}
                          <input
                            type={variable.type === 'number' || variable.type === 'port' ? 'number' : variable.type === 'url' ? 'url' : 'text'}
                            value={String(draftValue(selectedAgent.agentId, variable) ?? '')}
                            on:input={(event) => setDraftValue(selectedAgent.agentId, variable, variable.type === 'number' || variable.type === 'port' ? Number(event.currentTarget.value) : event.currentTarget.value)}
                            class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                          />
                        {/if}
                        <span class="mt-1 block text-[0.62rem] text-gray-500 dark:text-gray-500">{applyModeLabel(variable.applyMode)}</span>
                      </label>
                      <button
                        class="rounded border border-gray-300 px-2 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700"
                        disabled={savingFields.has(key)}
                        on:click={() => selectedAgent && saveVariable(selectedAgent, variable)}
                      >
                        {savingFields.has(key) ? 'Saving' : 'Save'}
                      </button>
                    </div>
                  {:else}
                    <div class="min-w-0">
                      <span class="block truncate text-[0.7rem] font-medium text-gray-600 dark:text-gray-300">{variable.label}</span>
                      <span class="mt-1 block min-h-8 break-words rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">{String(variable.value ?? '')}</span>
                      <span class="mt-1 block text-[0.62rem] text-gray-500 dark:text-gray-500">{applyModeLabel(variable.applyMode)}</span>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}

            {#if selectedAgent.errors.length > 0}
              <div class="rounded border border-red-200 bg-red-50 p-2 dark:border-red-900/60 dark:bg-red-950/20">
                <div class="text-[0.68rem] font-semibold uppercase text-red-700 dark:text-red-300">Latest Error</div>
                {#each selectedAgent.errors.slice(-1) as latestError}
                  <div class="mt-1 text-xs font-medium text-red-800 dark:text-red-200">{latestError.message}</div>
                  {#if latestError.stderr}
                    <pre class="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/70 p-2 font-mono text-[0.65rem] text-red-700 dark:bg-black/20 dark:text-red-200">{latestError.stderr}</pre>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </section>
    </div>
</div>
