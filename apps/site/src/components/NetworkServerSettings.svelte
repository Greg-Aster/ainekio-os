<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch, getApiBaseUrl, isMobileApp } from '../lib/client/api-config';
  import { healthStatus, forceHealthCheck } from '../lib/client/server-health';
  import { statusRefreshTrigger, statusStore } from '../stores/navigation';
  import SyncStatus from './SyncStatus.svelte';
  import UpdateManager from './UpdateManager.svelte';

  let isMobile = false;
  let loading = true;
  let testing = false;
  let error: string | null = null;
  let successMessage: string | null = null;
  let currentServerUrl = '';
  let settingsRead: AbortController | undefined;
  let tunnelRead: AbortController | undefined;

  interface ServerInfo {
    hostname: string;
    port: number;
    platform: string;
    arch: string;
    primaryIP: string | null;
    interfaces: Array<{ name: string; address: string; internal: boolean; url: string }>;
  }

  interface TunnelStatus {
    installed: boolean;
    running: boolean;
    enabled: boolean;
    hostname: string;
    pid?: number;
    exposure?: { mode: 'local' | 'shared'; source: string | null };
  }

  interface RuntimeMode {
    headless: boolean;
    lastChangedBy: 'local' | 'remote';
    changedAt: string;
  }

  let localServerInfo: ServerInfo | null = null;
  let loadingServerInfo = false;
  let copiedUrl = '';
  let copyNotice: ReturnType<typeof setTimeout> | undefined;
  let tunnelStatus: TunnelStatus | null = null;
  let runtimeMode: RuntimeMode | undefined;
  $: runtimeMode = $statusStore?.data?.runtime;
  $: healthChecked = $healthStatus.connected || $healthStatus.consecutiveFailures > 0 || $healthStatus.error !== undefined;

  async function testCurrentConnection() {
    testing = true;
    try {
      await forceHealthCheck();
    } finally {
      testing = false;
    }
  }

  async function loadLocalServerInfo(signal: AbortSignal) {
    loadingServerInfo = true;
    try {
      const response = await apiFetch('/api/server-info', { signal });
      const data = await response.json();
      if (signal.aborted) return;
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load server info');
      localServerInfo = data.server;
    } catch (err) {
      if (!signal.aborted) error = err instanceof Error ? err.message : 'Failed to load server info';
    } finally {
      if (!signal.aborted) loadingServerInfo = false;
    }
  }

  async function copyToClipboard(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      if (settingsRead?.signal.aborted) return;
      copiedUrl = url;
      clearTimeout(copyNotice);
      copyNotice = setTimeout(() => { copiedUrl = ''; }, 2000);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to copy address';
    }
  }

  async function loadTunnelStatus(pageSignal: AbortSignal) {
    tunnelRead?.abort();
    tunnelRead = new AbortController();
    const signal = AbortSignal.any([pageSignal, tunnelRead.signal]);
    try {
      const response = await apiFetch('/api/cloudflare/status', { signal });
      const data = await response.json();
      if (signal.aborted) return;
      if (!response.ok) throw new Error(data.error || 'Failed to load tunnel status');
      tunnelStatus = data;
    } catch (err) {
      if (!signal.aborted) error = err instanceof Error ? err.message : 'Failed to load tunnel status';
    }
  }

  async function refreshSettings() {
    settingsRead?.abort();
    const current = new AbortController();
    settingsRead = current;
    loading = true;
    error = null;
    await Promise.all([
      loadTunnelStatus(current.signal),
      isMobile ? Promise.resolve() : loadLocalServerInfo(current.signal),
    ]);
    if (!current.signal.aborted) loading = false;
  }

  async function changeTunnel(action: 'toggle' | 'start' | 'stop', enabled?: boolean) {
    error = null;
    successMessage = null;
    loading = true;
    try {
      const response = await apiFetch(`/api/cloudflare/${action}`, {
        method: 'POST',
        ...(action === 'toggle' ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to change tunnel');
      successMessage = action === 'toggle'
        ? `Tunnel auto-start ${enabled ? 'enabled' : 'disabled'}.`
        : action === 'start' ? 'Tunnel start requested.' : 'Tunnel stopped.';
      if (settingsRead && !settingsRead.signal.aborted) await loadTunnelStatus(settingsRead.signal);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to change tunnel';
    } finally {
      loading = false;
    }
  }

  async function toggleHeadlessMode(headless: boolean) {
    error = null;
    successMessage = null;
    loading = true;
    try {
      const response = await apiFetch('/api/runtime/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headless }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to change headless mode');
      statusStore.update(snapshot => snapshot ? {
        ...snapshot, data: { ...snapshot.data, runtime: data.mode },
      } : snapshot);
      statusRefreshTrigger.update(value => value + 1);
      successMessage = data.mode.headless
        ? 'Headless mode saved. Boot-managed agents will be skipped at the next system start.'
        : 'Headless mode cleared. Boot-managed agents may start at the next system start.';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to change headless mode';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    isMobile = isMobileApp();
    currentServerUrl = getApiBaseUrl() || window.location.origin;
    void refreshSettings();
    window.addEventListener('focus', refreshSettings);
    return () => {
      window.removeEventListener('focus', refreshSettings);
      settingsRead?.abort();
      clearTimeout(copyNotice);
    };
  });
</script>


<div class="p-8 max-w-[900px] mx-auto h-full overflow-y-auto overflow-x-hidden">
  <div class="mb-8">
    <h1 class="text-2xl font-semibold mb-2 text-gray-800 dark:text-gray-50">🌐 Network & Server</h1>
    <p class="text-gray-500 dark:text-gray-400">Connection health, server addresses, and tunnel controls.</p>
    <button class="btn-secondary mt-3" on:click={refreshSettings} disabled={loading}>Refresh network settings</button>
  </div>

  {#if loading && !tunnelStatus && !localServerInfo}
    <div class="text-center py-8 text-gray-500">Loading settings...</div>
  {:else}
    <!-- ============ CONNECTION STATUS (Always Shown) ============ -->
    <div class="panel mb-6">
      <h2 class="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-50">📡 Connection Status</h2>

      <div class="rounded-md p-4 mb-4 border-2 {!healthChecked ? 'border-gray-300 dark:border-gray-600' : $healthStatus.connected ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/50' : 'border-red-500 bg-red-50 dark:bg-red-900/50'}">
        <div class="flex items-center gap-2 mb-3">
          <span class="w-3 h-3 rounded-full {!healthChecked ? 'bg-gray-400' : $healthStatus.connected ? 'bg-emerald-500 shadow-[0_0_8px_theme(colors.emerald.500)]' : 'bg-red-500'}"></span>
          <strong>{!healthChecked ? 'Not checked' : $healthStatus.connected ? '✅ Connected' : '❌ Disconnected'}</strong>
          {#if testing}
            <span class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded ml-2">Testing...</span>
          {/if}
        </div>

        <div class="mb-4">
          <div class="flex gap-2 mb-2 text-sm">
            <span class="text-gray-500 dark:text-gray-400 min-w-[80px]">Server:</span>
            <span class="text-gray-900 dark:text-gray-100 break-all">{currentServerUrl}</span>
          </div>
          {#if $healthStatus.connected}
            <div class="flex gap-2 mb-2 text-sm">
              <span class="text-gray-500 dark:text-gray-400 min-w-[80px]">Latency:</span>
              <span class="font-semibold {$healthStatus.latencyMs < 200 ? 'text-emerald-500' : $healthStatus.latencyMs < 500 ? 'text-amber-500' : 'text-red-500'}">
                {$healthStatus.latencyMs}ms
              </span>
            </div>
            {#if $healthStatus.serverVersion}
              <div class="flex gap-2 mb-2 text-sm">
                <span class="text-gray-500 dark:text-gray-400 min-w-[80px]">Version:</span>
                <span class="text-gray-900 dark:text-gray-100">{$healthStatus.serverVersion}</span>
              </div>
            {/if}
          {:else if $healthStatus.error}
            <div class="flex gap-2 mb-2 text-sm">
              <span class="text-gray-500 dark:text-gray-400 min-w-[80px]">Error:</span>
              <span class="text-red-600 dark:text-red-400">{$healthStatus.error}</span>
            </div>
          {/if}
        </div>

        <button class="btn-secondary" on:click={testCurrentConnection} disabled={testing}>
          {testing ? 'Testing...' : '🔄 Test Connection'}
        </button>
      </div>
    </div>

    <!-- ============ LOCAL SERVER INFO (Web Mode) ============ -->
    <div class="panel mb-6 {isMobile ? 'opacity-60 pointer-events-none' : ''}">
      <div class="flex items-center gap-4 flex-wrap mb-3">
        <h2 class="text-lg font-semibold m-0 text-gray-900 dark:text-gray-50">🖥️ Local Server</h2>
        {#if isMobile}
          <span class="text-xs px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-full font-medium">Desktop Only</span>
        {/if}
      </div>
      <p class="text-gray-500 dark:text-gray-400 mb-4 text-sm">
        {#if isMobile}
          This feature shows local network addresses for connecting from other devices. Available when running from desktop.
        {:else}
          These addresses belong to the connected Ainekio OS server. Other devices can use them when its bind address and network permit access.
        {/if}
      </p>

      {#if loadingServerInfo && !isMobile}
        <div class="py-4 text-gray-500 italic">Loading server info...</div>
      {:else if localServerInfo && !isMobile}
        <!-- Primary Connection URL -->
        {#if localServerInfo.primaryIP}
          <div class="bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-lg p-5 mb-4">
            <div class="text-sm text-white/90 mb-2">Connect from mobile devices:</div>
            <div class="flex items-center gap-3 flex-wrap">
              <code class="text-lg font-mono text-white bg-black/20 px-3 py-2 rounded-md flex-1 min-w-[200px]">http://{localServerInfo.primaryIP}:{localServerInfo.port}</code>
              <button
                class="px-4 py-2 bg-white/20 border border-white/30 text-white rounded-md text-sm hover:bg-white/30 transition-colors"
                on:click={() => copyToClipboard(`http://${localServerInfo?.primaryIP}:${localServerInfo?.port}`)}
                title="Copy to clipboard"
                disabled={isMobile}
              >
                {copiedUrl === `http://${localServerInfo.primaryIP}:${localServerInfo.port}` ? '✓ Copied!' : '📋 Copy'}
              </button>
            </div>
          </div>
        {/if}

        <!-- Server Details -->
        <div class="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-4 mb-4">
          <div class="flex justify-between py-1.5 border-b border-gray-200 dark:border-gray-700">
            <span class="text-gray-500 dark:text-gray-400">Hostname:</span>
            <span class="text-gray-900 dark:text-gray-100 font-medium">{localServerInfo.hostname}</span>
          </div>
          <div class="flex justify-between py-1.5 border-b border-gray-200 dark:border-gray-700">
            <span class="text-gray-500 dark:text-gray-400">Port:</span>
            <span class="text-gray-900 dark:text-gray-100 font-medium">{localServerInfo.port}</span>
          </div>
          <div class="flex justify-between py-1.5">
            <span class="text-gray-500 dark:text-gray-400">Platform:</span>
            <span class="text-gray-900 dark:text-gray-100 font-medium">{localServerInfo.platform} ({localServerInfo.arch})</span>
          </div>
        </div>

        <!-- All Network Interfaces -->
        <details class="mb-4">
          <summary class="cursor-pointer px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-md text-gray-600 dark:text-gray-300 text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-700">
            All Network Interfaces ({localServerInfo.interfaces.length})
          </summary>
          <div class="mt-2 border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
            {#each localServerInfo.interfaces as iface}
              <div class="flex items-center gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 last:border-b-0 {iface.internal ? 'opacity-60' : ''}">
                <div class="font-semibold text-xs text-gray-500 dark:text-gray-400 min-w-[80px]">{iface.name}</div>
                <div class="flex-1 flex items-center gap-2">
                  <code class="text-xs text-blue-500">{iface.url}</code>
                  <button
                    class="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                    on:click={() => copyToClipboard(iface.url)}
                    title="Copy to clipboard"
                    disabled={isMobile}
                  >
                    {copiedUrl === iface.url ? '✓' : '📋'}
                  </button>
                </div>
                {#if iface.internal}
                  <span class="text-[0.625rem] bg-gray-400 text-white px-1.5 py-0.5 rounded uppercase">localhost</span>
                {/if}
              </div>
            {/each}
          </div>
        </details>
      {:else}
        <p class="text-sm text-gray-500 dark:text-gray-400">
          {isMobile ? 'Open the desktop server interface to inspect its network addresses.' : 'Server addresses are unavailable.'}
        </p>
        {#if !isMobile}
          <button class="btn-secondary" on:click={refreshSettings} disabled={loading}>Retry server addresses</button>
        {/if}
      {/if}
    </div>

    <!-- ============ CLOUDFLARE TUNNEL (Both) ============ -->
    {#if tunnelStatus}
      <div class="panel mb-6">
        <div class="flex items-center gap-4 flex-wrap mb-3">
          <h2 class="text-lg font-semibold m-0 text-gray-900 dark:text-gray-50">🌐 Cloudflare Tunnel</h2>
          <a href="https://github.com/Greg-Aster/ainekio-os/blob/main/docs/user-guide/configuration-admin/deployment.md" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-500 text-white no-underline rounded-md font-medium text-xs hover:bg-blue-600 transition-colors">
            📖 Setup Guide
          </a>
        </div>
        <p class="text-gray-500 dark:text-gray-400 mb-4 text-sm">
          Secure remote access to your Ainekio OS server from anywhere without port forwarding.
        </p>

        {#if !tunnelStatus.installed}
          <div class="p-4 rounded-md mt-4 bg-amber-100 dark:bg-amber-900/50 border border-amber-300 dark:border-amber-600">
            <strong>⚠️ cloudflared not installed</strong>
            <p>Use the setup guide for current platform-specific installation and locally managed tunnel configuration.</p>
          </div>
        {:else}
          <div class="rounded-md p-4 mb-4 border-2 {tunnelStatus.running ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/50' : 'border-red-500 bg-red-50 dark:bg-red-900/50'}">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-3 h-3 rounded-full {tunnelStatus.running ? 'bg-emerald-500 shadow-[0_0_8px_theme(colors.emerald.500)]' : 'bg-red-500'}"></span>
              <strong>{tunnelStatus.running ? '✅ Running' : '⭕ Stopped'}</strong>
              <span class="text-gray-500 text-sm">
                Request mode: {tunnelStatus.exposure?.mode || 'local'}
              </span>
              {#if tunnelStatus.pid}
                <span class="text-gray-500 text-sm">(PID: {tunnelStatus.pid})</span>
              {/if}
            </div>

            {#if tunnelStatus.hostname}
              <div class="mb-4 p-3 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                <strong>Public URL:</strong>
                <a href="https://{tunnelStatus.hostname}" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline break-all">
                  https://{tunnelStatus.hostname}
                </a>
              </div>
            {/if}

            <div class="flex flex-col gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tunnelStatus.enabled}
                  on:change={async (event) => {
                    const input = event.currentTarget;
                    await changeTunnel('toggle', input.checked);
                    input.checked = tunnelStatus?.enabled ?? false;
                  }}
                  disabled={loading}
                />
                <span>Auto-start with Ainekio OS</span>
              </label>

              <div class="flex gap-2">
                <button
                  class="btn-primary"
                  on:click={() => changeTunnel('start')}
                  disabled={loading || tunnelStatus.running}
                >
                  Start Tunnel
                </button>
                <button
                  class="btn-danger"
                  on:click={() => changeTunnel('stop')}
                  disabled={loading || !tunnelStatus.running}
                >
                  Stop Tunnel
                </button>
              </div>
            </div>
          </div>

          <div class="p-4 rounded-md mt-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700">
            <h3 class="mb-2 text-gray-900 dark:text-gray-100">ℹ️ How It Works</h3>
            <ul class="mt-2 ml-6 list-disc">
              <li class="mb-2 text-blue-800 dark:text-blue-200 text-sm"><strong>Auto-start:</strong> When enabled, the tunnel starts automatically when Ainekio OS starts</li>
              <li class="mb-2 text-blue-800 dark:text-blue-200 text-sm"><strong>Automatic sharing:</strong> Starting the tunnel admits its configured HTTPS hostname while the server remains bound to localhost</li>
              <li class="mb-2 text-blue-800 dark:text-blue-200 text-sm"><strong>No port forwarding:</strong> Cloudflare tunnel creates a secure connection without opening router ports</li>
              <li class="mb-2 text-blue-800 dark:text-blue-200 text-sm"><strong>HTTPS included:</strong> Automatic SSL certificates from Cloudflare</li>
              <li class="mb-2 text-blue-800 dark:text-blue-200 text-sm"><strong>Access control:</strong> Configure email whitelisting in Cloudflare Zero Trust dashboard</li>
            </ul>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ============ HEADLESS MODE (Both) ============ -->
    {#if runtimeMode}
      <div class="panel mb-6">
        <h2 class="text-lg font-semibold mb-3 text-gray-900 dark:text-gray-50">🖥️ Headless Runtime Mode</h2>
        <p class="text-gray-500 dark:text-gray-400 mb-4 text-sm">
          Skip boot-managed agents at system startup. This setting does not stop or resume running agents.
        </p>

        <div class="rounded-md p-4 mb-4 border-2 {runtimeMode.headless ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/50' : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900'}">
          <div class="flex items-center gap-2 mb-3">
            <span class="w-3 h-3 rounded-full {runtimeMode.headless ? 'bg-amber-500 shadow-[0_0_8px_theme(colors.amber.500)]' : 'bg-emerald-500 shadow-[0_0_8px_theme(colors.emerald.500)]'}"></span>
            <strong>{runtimeMode.headless ? '🟡 Headless Mode Active' : '🟢 Normal Mode'}</strong>
          </div>

          {#if runtimeMode.headless}
            <div class="mb-4 p-3 bg-amber-100 dark:bg-amber-900/50 border border-amber-300 dark:border-amber-700 rounded">
              <p class="m-0 text-sm"><strong>ℹ️ Boot-managed agents will be skipped at startup.</strong></p>
              <p class="m-1 text-sm">Use Agent Monitor to inspect or change the state of running agents.</p>
            </div>
          {/if}

          <div class="flex flex-col gap-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={runtimeMode.headless}
                on:change={async (event) => {
                  const input = event.currentTarget;
                  await toggleHeadlessMode(input.checked);
                  input.checked = runtimeMode?.headless ?? false;
                }}
                disabled={loading}
              />
              <span>Enable Headless Mode</span>
            </label>

            <div class="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
              <small class="text-gray-500 dark:text-gray-400 text-xs">Last changed: {new Date(runtimeMode.changedAt).toLocaleString()} ({runtimeMode.lastChangedBy})</small>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Memory Sync -->
    <div class="panel mb-6 {!isMobile ? 'opacity-60 pointer-events-none' : ''}">
      <div class="flex items-center gap-4 flex-wrap mb-3">
        <h2 class="text-lg font-semibold m-0 text-gray-900 dark:text-gray-50">🔄 Profile Sync</h2>
        {#if !isMobile}
          <span class="text-xs px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-full font-medium">Mobile Only</span>
        {/if}
      </div>
      <p class="text-gray-500 dark:text-gray-400 mb-4 text-sm">
        Transfer an encrypted profile snapshot between this device and its configured remote installation. Open Profile Sync to configure or run a transfer.
      </p>
      {#if isMobile}
        <SyncStatus />
      {:else}
        <div class="opacity-50">
          <div class="rounded-md p-4 border-2 border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-3 h-3 rounded-full bg-red-500"></span>
              <strong>—</strong>
            </div>
            <p class="text-sm text-gray-500">Use the mobile app to transfer a profile snapshot</p>
          </div>
        </div>
      {/if}
    </div>

    <!-- App Updates -->
    <div class="panel mb-6">
      <div class="flex items-center gap-4 flex-wrap mb-3">
        <h2 class="text-lg font-semibold m-0 text-gray-900 dark:text-gray-50">⬇️ {isMobile ? 'App Updates' : 'Server Updates'}</h2>
      </div>
      <p class="text-gray-500 dark:text-gray-400 mb-4 text-sm">
        {isMobile
          ? 'Check for and download signed Ainekio OS app releases from your connected server.'
          : 'Check the configured Git upstream, validate a fast-forward update, and restart into the new build.'}
      </p>
      <UpdateManager />
    </div>

    <!-- ============ MESSAGES ============ -->
    {#if error}
      <div class="p-3 rounded-md mt-4 bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200 border border-red-300 dark:border-red-700">{error}</div>
    {/if}

    {#if successMessage}
      <div class="p-3 rounded-md mt-4 bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-200 border border-green-300 dark:border-green-700">{successMessage}</div>
    {/if}
  {/if}
</div>
