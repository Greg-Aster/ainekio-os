<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';

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

  interface AstroServer {
    port: number;
    pid: number;
    command: string;
    isCurrentServer: boolean;
  }

  interface LLMBackendInfo {
    llamaCpp: { configured: boolean; running: boolean; model?: string; endpoint: string; error?: string };
    activeBackend: 'llama-cpp' | 'auto' | 'ollama' | 'remote';
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

  let servers: ServerInfo[] = [];
  let astroServers: AstroServer[] = [];
  let llmBackend: LLMBackendInfo | null = null;
  let bigBrother: BigBrotherInfo | null = null;
  let eventBus: EventBusInfo | null = null;
  let loading = true;
  let actionInProgress: string | null = null;
  let voiceActions: Record<string, boolean> = {};
  let mounted = false;
  let isPageVisible = true;
  let statusFetchInProgress = false;
  let statusErrors: Record<string, string> = {};

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
    loading = servers.length === 0 && astroServers.length === 0;
    const newServers: ServerInfo[] = [];
    const errors: Record<string, string> = {};

    try {
      try {
        const llmResponse = await fetchStatusEndpoint('/api/llm-backend/status');
        if (llmResponse.ok) {
          const data = await llmResponse.json();
          llmBackend = {
            activeBackend: data.config.activeBackend,
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

      newServers.push(...await Promise.all(serverConfigs.map(fetchVoiceServiceStatus)));
      servers = newServers;

      try {
        const astroResponse = await fetchStatusEndpoint('/api/astro-servers');
        if (astroResponse.ok) {
          const astroData = await astroResponse.json();
          astroServers = astroData.servers || [];
        } else throw new Error((await astroResponse.json()).error || `Status request failed (${astroResponse.status})`);
      } catch (error) {
        errors['Astro servers'] = reportStatusFetchFailure('Astro servers', error);
        astroServers = [];
      }
    } finally {
      statusErrors = errors;
      if (newServers.length > 0 || servers.length === 0) {
        servers = newServers;
      }
      loading = false;
      statusFetchInProgress = false;
    }
  }

  function openBackendSettings() {
    window.dispatchEvent(new CustomEvent('mh-open-system-tab', { detail: { tab: 'backend' } }));
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

  async function stopAstroServer(port: number, isCurrentServer: boolean) {
    if (isCurrentServer) {
      const confirmed = confirm(
        `⚠️ Warning: This will stop the current web server.\n\n` +
        `The UI will disconnect and you'll need to restart the server manually.\n\n` +
        `Continue?`
      );
      if (!confirmed) return;
    }
    actionInProgress = `astro-${port}`;
    try {
      const response = await apiFetch('/api/astro-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', port }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        alert(`Failed to stop Astro server: ${data.error || 'Unknown error'}`);
      } else {
        if (isCurrentServer) {
          alert('Server stopped. You will need to restart it manually.');
        } else {
          await fetchServerStatus();
        }
      }
    } catch (error) {
      alert(`Error stopping Astro server: ${(error as Error).message}`);
    } finally {
      actionInProgress = null;
    }
  }

  $: if (mounted && isPageVisible) void fetchServerStatus();

  function handleVisibilityChange() {
    isPageVisible = !document.hidden;
  }

  onMount(() => {
    isPageVisible = !document.hidden;
    mounted = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('backend-changed', fetchServerStatus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('backend-changed', fetchServerStatus);
    };
  });
</script>

<div class="flex flex-col h-full p-4 gap-4">
  <div class="flex justify-between items-center">
    <h3 class="text-base font-semibold text-gray-900 dark:text-gray-100 m-0">Server Status</h3>
    <button
      class="bg-transparent border border-black/10 dark:border-white/20 rounded-md px-2 py-1 cursor-pointer text-base transition-all hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
      on:click={fetchServerStatus}
      disabled={loading}
    >
      {loading ? '⏳' : '🔄'}
    </button>
  </div>

  {#if Object.keys(statusErrors).length}
    <div class="banner banner-error">
      {#each Object.values(statusErrors) as error}<p>{error}</p>{/each}
    </div>
  {/if}

  {#if loading && servers.length === 0 && astroServers.length === 0}
    <div class="text-center py-8 text-gray-500 dark:text-gray-400 text-sm">Loading server status...</div>
  {:else}
    <div class="flex flex-col gap-3 overflow-y-auto">
      <!-- LLM Backend Section -->
      {#if llmBackend}
        <div class="flex items-center gap-2 py-2 mt-2 font-semibold text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <span class="text-base">🧠</span>
          <span class="flex-1">LLM Backend</span>
          {#if statusErrors['LLM backend']}
            <span class="normal-case font-normal">Last known status · refresh unavailable</span>
          {/if}
        </div>

        {#if llmBackend.llamaCpp.configured}
          <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 {llmBackend.activeBackend === 'llama-cpp' ? 'border-emerald-500' : 'border-gray-300 dark:border-gray-700'}">
            <div class="flex items-center justify-between"><strong>llama.cpp</strong><span>{llmBackend.llamaCpp.running ? 'Running' : 'Offline'}</span></div>
            <div class="text-sm mt-2">{llmBackend.llamaCpp.model}</div>
            <div class="text-xs text-gray-500 mt-1">{llmBackend.llamaCpp.endpoint}</div>
            {#if llmBackend.llamaCpp.error}<p class="text-xs text-red-500">{llmBackend.llamaCpp.error}</p>{/if}
            <button class="text-sm mt-2 underline" on:click={openBackendSettings}>Configure backend</button>
          </div>
        {/if}

        <!-- Ollama -->
        <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 transition-all hover:shadow-md dark:hover:shadow-black/30 {llmBackend.activeBackend === 'ollama' ? 'border-2 border-emerald-500/40 dark:border-emerald-400/40 bg-emerald-500/[0.02] dark:bg-emerald-400/[0.03]' : 'border-blue-500/20 dark:border-blue-400/20'}">
          <div class="mb-3">
            <div class="flex items-start gap-3">
              <span class="text-xl leading-none">
                {#if !llmBackend.ollama.installed}⚠️
                {:else if llmBackend.ollama.running}🟢
                {:else}🔴{/if}
              </span>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-1">
                  Ollama
                  {#if llmBackend.activeBackend === 'ollama'}
                    <span class="inline-block px-1.5 py-0.5 ml-2 bg-emerald-500/15 dark:bg-emerald-400/20 text-emerald-600 dark:text-emerald-400 rounded text-[0.65rem] font-bold tracking-wide">ACTIVE</span>
                  {/if}
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">
                  {llmBackend.ollama.endpoint}
                  {#if llmBackend.ollama.running && llmBackend.ollama.model}
                    • {llmBackend.ollama.model}
                  {/if}
                </div>
              </div>
            </div>
          </div>
          {#if llmBackend.ollama.installed}
            <button class="w-full py-1.5 px-3 border border-blue-500/30 dark:border-blue-400/30 rounded-md text-xs font-semibold cursor-pointer transition-all bg-blue-500/10 dark:bg-blue-400/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/15 dark:hover:bg-blue-400/15" on:click={openBackendSettings}>
              Configure in Backend
            </button>
          {:else}
            <div class="text-xs text-gray-500 dark:text-gray-400 italic p-2 text-center bg-black/5 dark:bg-white/5 rounded-md">Not installed</div>
          {/if}
        </div>


      {/if}

        <!-- Big Brother shared terminal session -->
        <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 transition-all hover:shadow-md dark:hover:shadow-black/30 {bigBrother?.sessionOpen ? 'border-2 border-purple-500/40 dark:border-purple-400/40 bg-purple-500/[0.02] dark:bg-purple-400/[0.03]' : 'border-purple-500/20 dark:border-purple-400/20'}">
          <div class="mb-3">
            <div class="flex items-start gap-3">
              <span class="text-xl leading-none">
                {#if !bigBrother}⚪
                {:else if bigBrother.running && bigBrother.healthy}🟢
                {:else if bigBrother?.sessionOpen}🟡
                {:else}🔴{/if}
              </span>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-1">
                  Big Brother
                  {#if bigBrother?.provider}
                    <span class="inline-block px-1.5 py-0.5 ml-2 bg-purple-500/15 dark:bg-purple-400/20 text-purple-600 dark:text-purple-400 rounded text-[0.6rem] font-bold tracking-tight">{bigBrother.provider === 'codex' ? 'Codex' : 'Claude Code'}</span>
                  {/if}
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400">
                  Managed by the Terminal agent
                </div>
              </div>
            </div>
          </div>
          <div class="flex gap-2">
            {#if bigBrother?.sessionOpen}
              <button class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => controlBigBrother('stop')} disabled={actionInProgress !== null}>
                {actionInProgress === 'bigbrother-stop' ? '...' : 'Stop'}
              </button>
            {:else if bigBrother}
              <div class="text-xs text-gray-500 dark:text-gray-400 italic p-2 text-center bg-black/5 dark:bg-white/5 rounded-md">Starts when Terminal or an escalation requests it</div>
            {:else}
              <div class="text-xs text-gray-500 dark:text-gray-400">Status unavailable</div>
            {/if}
          </div>
          {#if bigBrother?.sessionOpen}
            <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              <span class="inline-block px-2 py-1 bg-purple-500/10 dark:bg-purple-400/15 text-purple-600 dark:text-purple-400 rounded text-[0.7rem] font-medium">{bigBrother.phase}</span>
            </div>
          {/if}
        </div>

        <!-- Event Bus (Telemetry) -->
        <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 transition-all hover:shadow-md dark:hover:shadow-black/30 {eventBus?.running ? 'border-2 border-cyan-500/40 dark:border-cyan-400/40 bg-cyan-500/[0.02] dark:bg-cyan-400/[0.03]' : 'border-cyan-500/20 dark:border-cyan-400/20'}">
          <div class="mb-3">
            <div class="flex items-start gap-3">
              <span class="text-xl leading-none">
                {#if !eventBus}⚪
                {:else if eventBus.running && eventBus.healthy}🟢
                {:else if eventBus?.running}🟡
                {:else}🔴{/if}
              </span>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-1">
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
            <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              <span class="inline-block px-2 py-1 bg-cyan-500/10 dark:bg-cyan-400/15 text-cyan-600 dark:text-cyan-400 rounded text-[0.7rem] font-medium">📡 {eventBus.subscribers} subscriber{eventBus.subscribers !== 1 ? 's' : ''}</span>
            </div>
          {/if}
        </div>
      <!-- Node/Astro processes -->
      {#if astroServers.length > 0}
        <div class="flex items-center gap-2 py-2 mt-2 font-semibold text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <span class="text-base">🚀</span>
          <span class="flex-1">Node/Astro Processes</span>
        </div>
        {#each astroServers as astro (astro.port)}
          <div class="border rounded-lg p-3 bg-white dark:bg-gray-800 transition-all hover:shadow-md dark:hover:shadow-black/30 {astro.isCurrentServer ? 'border-2 border-violet-500/40 dark:border-violet-400/40 bg-violet-500/[0.02] dark:bg-violet-400/[0.03]' : 'border-violet-500/20 dark:border-violet-400/20'}">
            <div class="mb-3">
              <div class="flex items-start gap-3">
                <span class="text-xl leading-none">🟢</span>
                <div class="flex-1 min-w-0">
                  <div class="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-1">
                    Node/Astro Process
                    {#if astro.isCurrentServer}
                      <span class="inline-block px-1.5 py-0.5 ml-2 bg-violet-500/15 dark:bg-violet-400/20 text-violet-600 dark:text-violet-400 rounded text-[0.65rem] font-bold tracking-wide">CURRENT</span>
                    {/if}
                  </div>
                  <div class="text-xs text-gray-500 dark:text-gray-400">
                    Port: {astro.port} • PID: {astro.pid}
                  </div>
                  <div class="text-[0.65rem] text-gray-400 dark:text-gray-500 mt-1 font-mono">{astro.command}</div>
                </div>
              </div>
            </div>
            <div class="flex gap-2">
              <button
                class="flex-1 py-1.5 px-3 border-none rounded-md text-xs font-semibold cursor-pointer transition-all text-white disabled:opacity-50 disabled:cursor-not-allowed {astro.isCurrentServer ? 'bg-red-700 hover:bg-red-800' : 'bg-red-500 hover:bg-red-600'}"
                on:click={() => stopAstroServer(astro.port, astro.isCurrentServer)}
                disabled={actionInProgress !== null}
              >
                {actionInProgress === `astro-${astro.port}` ? '...' : 'Stop'}
              </button>
            </div>
          </div>
        {/each}
      {/if}

      <!-- Voice/Backend Servers Section -->
      {#if servers.length > 0}
        <div class="flex items-center gap-2 py-2 mt-2 font-semibold text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <span class="text-base">🔧</span>
          <span class="flex-1">Backend Services</span>
        </div>
      {/if}
      {#each servers as server (server.name)}
        <div class="border border-black/10 dark:border-white/10 rounded-lg p-3 bg-white dark:bg-gray-800 transition-all hover:shadow-md dark:hover:shadow-black/30">
          <div class="mb-3">
            <div class="flex items-start gap-3">
              <span class="text-xl leading-none">{getStatusIcon(server)}</span>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-1">{server.displayName}</div>
                <div class="text-xs text-gray-500 dark:text-gray-400">
                  {getStatusText(server)}
                </div>
                {#if server.details?.url}
                  <div class="text-xs text-gray-500 dark:text-gray-400 break-all">{server.details.url}</div>
                {/if}
                {#if server.status === 'running' && server.details?.pid}
                  <div class="text-xs text-gray-500 dark:text-gray-400">PID: {server.details.pid}</div>
                {/if}
              </div>
            </div>
          </div>

          {#if server.installed}
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
            <div class="text-xs text-gray-500 dark:text-gray-400 italic p-2 text-center bg-black/5 dark:bg-white/5 rounded-md">Not installed or configured</div>
          {/if}

          {#if server.details?.error || (server.details?.readiness === 'error' && server.details.health?.message)}
            <div class="banner banner-error mt-3">{server.details.error || server.details.health.message}</div>
          {/if}

          {#if server.details && server.status === 'running'}
            <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              {#if server.details.health?.model}
                <span class="inline-block px-2 py-1 bg-violet-500/10 dark:bg-violet-400/15 text-violet-600 dark:text-violet-400 rounded text-[0.7rem] font-medium">Model: {server.details.health.model}</span>
              {/if}
              {#if server.details.health?.device}
                <span class="inline-block px-2 py-1 bg-violet-500/10 dark:bg-violet-400/15 text-violet-600 dark:text-violet-400 rounded text-[0.7rem] font-medium">Device: {server.details.health.device}</span>
              {/if}
              {#if server.details.health?.defaults?.voice}
                <span class="inline-block px-2 py-1 bg-violet-500/10 dark:bg-violet-400/15 text-violet-600 dark:text-violet-400 rounded text-[0.7rem] font-medium">Voice: {server.details.health.defaults.voice}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
