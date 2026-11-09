<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import {
    configureRemoteSyncServer,
    getRemoteSyncConfig,
    clearRemoteSyncConfig,
    runProfileSyncAgent,
    type RemoteSyncResult,
  } from '../lib/client/profile-sync';
  import {
    getSyncSettings,
    updateSyncSettings,
    type SyncSettings,
  } from '../lib/client/sync-settings';

  const dispatch = createEventDispatcher();

  export let isOpen = false;
  let isSyncing = false;

  let serverUrl = '';
  let serverUsername = '';
  let serverPassword = '';
  let isServerConfigured = false;
  let connectionTestResult: { success: boolean; message: string } | null = null;
  let isSavingConfig = false;
  let showServerConfig = false;
  let lastSyncAt: string | null = null;
  let configError = '';
  let settingsError = '';
  let observation: AbortController | undefined;
  let syncWait: AbortController | undefined;

  let remoteSyncMessage = '';

  let syncSettingsData: SyncSettings | null = null;
  let showSyncSettings = false;
  let isSavingSettings = false;


  let showSyncComplete = false;
  let syncResult: RemoteSyncResult | null = null;

  interface DateRangeOption {
    value: number;
    label: string;
    description: string;
  }

  const dateRangeOptions: DateRangeOption[] = [
    { value: 7, label: 'Last 7 days', description: 'Recent memories only' },
    { value: 30, label: 'Last 30 days', description: 'About a month' },
    { value: 90, label: 'Last 90 days', description: 'About 3 months' },
    { value: 365, label: 'Last year', description: 'Warning: may be large' },
    { value: 0, label: 'All memories', description: 'Warning: may be very large!' },
  ];

  let memoryDays = 7;

  interface SyncOption {
    id: string;
    label: string;
    description: string;
    enabled: boolean;
  }

  let syncOptions: SyncOption[] = [
    { id: 'persona', label: 'Persona Files', description: 'Core identity, personality traits, relationships, and decision rules', enabled: false },
    { id: 'config', label: 'Configuration', description: 'Settings, preferences, model registry, and runtime config', enabled: false },
    { id: 'memories', label: 'Memories', description: 'Episodic memories, conversations, and inner dialogue', enabled: true },
  ];

  onMount(() => {
    const current = new AbortController();
    observation = current;
    void loadServerConfig();
    void loadSyncSettings();
    return () => { current.abort(); syncWait?.abort(); };
  });

  async function loadSyncSettings() {
    settingsError = '';
    try {
      const settings = await getSyncSettings();
      if (!observation?.signal.aborted) syncSettingsData = settings;
    } catch (err) {
      if (!observation?.signal.aborted) settingsError = (err as Error).message;
    }
  }

  async function handleSaveSyncSettings() {
    if (!syncSettingsData) return;
    isSavingSettings = true;
    settingsError = '';
    try {
      syncSettingsData = await updateSyncSettings(syncSettingsData);
      showSyncSettings = false;
    } catch (err) {
      settingsError = (err as Error).message;
    } finally {
      isSavingSettings = false;
    }
  }

  async function loadServerConfig() {
    configError = '';
    try {
      const config = await getRemoteSyncConfig({ signal: observation?.signal });
      if (observation?.signal.aborted) return;
      isServerConfigured = config.configured;
      serverUrl = config.serverUrl || '';
      serverUsername = config.username || '';
      lastSyncAt = config.lastSyncAt || null;
      serverPassword = '';
    } catch (err) {
      if (!observation?.signal.aborted) configError = (err as Error).message;
    }
  }

  async function handleSaveConfig() {
    if (!serverUrl || !serverUsername || !serverPassword) {
      connectionTestResult = { success: false, message: 'Please fill in all fields' };
      return;
    }
    isSavingConfig = true;
    connectionTestResult = null;
    try {
      const result = await configureRemoteSyncServer(serverUrl, serverUsername, serverPassword);
      if (result.success) {
        isServerConfigured = true;
        showServerConfig = false;
        connectionTestResult = { success: true, message: 'Server saved. Use Sync Now to connect and import data.' };
        await loadServerConfig();
      } else {
        connectionTestResult = { success: false, message: result.error || 'Failed to save configuration' };
      }
    } catch (err) {
      connectionTestResult = { success: false, message: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` };
    } finally {
      isSavingConfig = false;
    }
  }

  async function handleClearConfig() {
    isSavingConfig = true;
    configError = '';
    try {
      await clearRemoteSyncConfig();
      serverUrl = '';
      serverUsername = '';
      serverPassword = '';
      isServerConfigured = false;
      lastSyncAt = null;
      connectionTestResult = null;
    } catch (err) {
      configError = (err as Error).message;
    } finally {
      isSavingConfig = false;
    }
  }

  async function handleRemoteSync() {
    const current = new AbortController();
    syncWait = current;
    isSyncing = true;
    remoteSyncMessage = 'Starting sync via profile-sync agent...';
    syncResult = null;

    const wantPersona = syncOptions.find(o => o.id === 'persona')?.enabled ?? false;
    const wantConfig = syncOptions.find(o => o.id === 'config')?.enabled ?? false;
    const wantMemories = syncOptions.find(o => o.id === 'memories')?.enabled ?? false;

    try {
      if (!wantPersona && !wantConfig && !wantMemories) {
        throw new Error('Select at least one sync option');
      }

      const agentArgs: string[] = [];
      if (wantMemories && !wantPersona && !wantConfig) {
        agentArgs.push('--memories-only');
      } else if ((wantPersona || wantConfig) && !wantMemories) {
        agentArgs.push('--profile-only');
      }
      if (!wantPersona) agentArgs.push('--skip-persona');
      if (!wantConfig) agentArgs.push('--skip-config');
      if (memoryDays > 0) agentArgs.push(`--days=${memoryDays}`);

      remoteSyncMessage = 'Triggering profile-sync agent...';

      const agentResult = await runProfileSyncAgent(agentArgs, progress => {
        remoteSyncMessage = progress.message;
      }, { signal: current.signal });

      if (agentResult.success) {
        remoteSyncMessage = `Profile Sync completed as ${agentResult.taskId}.`;
        syncResult = agentResult;
      } else {
        remoteSyncMessage = agentResult.error || 'Profile Sync failed';
        syncResult = agentResult;
      }

      await loadServerConfig();
    } catch (err) {
      remoteSyncMessage = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
      syncResult = { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    } finally {
      showSyncComplete = syncResult !== null;
      isSyncing = false;
      if (syncWait === current) syncWait = undefined;
    }
  }

  function handleCloseSyncComplete() {
    showSyncComplete = false;
    syncResult = null;
  }

  function toggleOption(id: string) {
    syncOptions = syncOptions.map(opt => opt.id === id ? { ...opt, enabled: !opt.enabled } : opt);
  }

  function selectAll() {
    syncOptions = syncOptions.map(opt => ({ ...opt, enabled: true }));
  }

  function selectNone() {
    syncOptions = syncOptions.map(opt => ({ ...opt, enabled: false }));
  }

  function handleClose() {
    if (!isSyncing) {
      dispatch('close');
    }
  }


</script>

{#if isOpen}
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] backdrop-blur-sm">
    <div class="bg-gradient-to-b from-[#1a1a2e] to-[#16213e] border border-emerald-500/20 rounded-2xl w-[90%] max-w-[450px] max-h-[85vh] overflow-hidden flex flex-col shadow-[0_0_40px_rgba(0,255,136,0.1),0_20px_60px_rgba(0,0,0,0.5)]" role="dialog" aria-modal="true" tabindex="-1">
      <!-- Header -->
      <div class="flex justify-between items-start p-5 border-b border-emerald-500/15 bg-emerald-500/[0.03]">
        <div class="flex flex-col gap-1">
          <h3 class="m-0 text-lg font-semibold text-emerald-400 drop-shadow-[0_0_10px_rgba(0,255,136,0.3)]">Sync Manager</h3>
          <span class="text-xs text-white/50">Configure your synchronization</span>
        </div>
        {#if !isSyncing}
          <button class="bg-transparent border-0 text-2xl text-white/50 cursor-pointer p-1 leading-none hover:text-red-400 transition-colors" on:click={handleClose}>×</button>
        {/if}
      </div>

      {#if configError}
        <div class="p-3 text-sm text-red-400">{configError} <button class="underline" on:click={loadServerConfig}>Retry loading server configuration</button></div>
      {/if}
      {#if settingsError}
        <div class="p-3 text-sm text-red-400">{settingsError}{#if !syncSettingsData} <button class="underline" on:click={loadSyncSettings}>Retry loading sync preferences</button>{/if}</div>
      {/if}
      {#if connectionTestResult}
        <div class="p-3 text-sm {connectionTestResult.success ? 'text-emerald-400' : 'text-red-400'}">{connectionTestResult.message}</div>
      {/if}

      {#if isSyncing}
        <!-- Syncing State -->
        <div class="p-8 flex flex-col items-center gap-6">
          <div class="relative w-20 h-20 flex items-center justify-center">
            <div class="absolute inset-0 border-2 border-emerald-500/30 rounded-full animate-pulse-ring"></div>
            <div class="absolute inset-0 border-2 border-emerald-500/30 rounded-full animate-pulse-ring delay-500"></div>
            <div class="absolute inset-0 border-2 border-emerald-500/30 rounded-full animate-pulse-ring delay-1000"></div>
            <span class="text-3xl text-emerald-400 animate-spin drop-shadow-[0_0_20px_rgba(0,255,136,0.5)]">⟳</span>
          </div>

          <div class="flex items-center gap-1 font-mono text-sm text-emerald-400 drop-shadow-[0_0_10px_rgba(0,255,136,0.3)]">
            <span>{remoteSyncMessage || 'Syncing...'}</span>
            <span class="animate-blink">_</span>
          </div>

          <div class="w-full h-1 bg-white/10 rounded overflow-hidden">
            <div class="w-[30%] h-full bg-gradient-to-r from-emerald-500 to-emerald-600 rounded animate-indeterminate shadow-[0_0_10px_rgba(0,255,136,0.3)]"></div>
          </div>

          <p class="text-xs text-white/50 text-center">Profile Sync runs in the Work Coordinator.</p>
        </div>
      {:else}
        <!-- Options State -->
        <div class="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <!-- Server Configuration Section -->
          <div class="border-b border-emerald-500/15">
            <button class="w-full flex justify-between items-center p-4 cursor-pointer transition-colors hover:bg-emerald-500/5" on:click={() => showServerConfig = !showServerConfig}>
              <div class="flex items-start gap-3">
                <span class="text-xl mt-0.5">{isServerConfigured ? '🔗' : '⚙️'}</span>
                <div class="flex flex-col gap-0.5">
                  <span class="text-sm font-medium text-white">{isServerConfigured ? 'Sync Server Configured' : 'Configure Sync Server'}</span>
                  {#if isServerConfigured}
                    <span class="text-xs text-emerald-400 font-mono">{serverUrl}</span>
                    {#if lastSyncAt}
                      <span class="text-[11px] text-white/40">Last sync: {new Date(lastSyncAt).toLocaleString()}</span>
                    {/if}
                  {:else}
                    <span class="text-xs text-white/50">Set up server to sync your profile</span>
                  {/if}
                </div>
              </div>
              <span class="text-xs text-white/40">{showServerConfig ? '▼' : '▶'}</span>
            </button>

            {#if showServerConfig}
              <div class="px-5 pb-4 flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <label class="text-xs font-medium text-white/70" for="serverUrl">Server URL</label>
                  <input type="url" id="serverUrl" class="px-3 py-2.5 bg-black/30 border border-white/10 rounded-md text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="https://mh.example.com" bind:value={serverUrl} disabled={isSavingConfig} />
                </div>

                <div class="flex flex-col gap-1.5">
                  <label class="text-xs font-medium text-white/70" for="serverUsername">Username</label>
                  <input type="text" id="serverUsername" class="px-3 py-2.5 bg-black/30 border border-white/10 rounded-md text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="your-username" bind:value={serverUsername} disabled={isSavingConfig} />
                </div>

                <div class="flex flex-col gap-1.5">
                  <label class="text-xs font-medium text-white/70" for="serverPassword">Password</label>
                  <input type="password" id="serverPassword" class="px-3 py-2.5 bg-black/30 border border-white/10 rounded-md text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed" placeholder={isServerConfigured ? '••••••••' : 'your-password'} bind:value={serverPassword} disabled={isSavingConfig} />
                </div>

                <div class="flex gap-2 mt-1">
                  <button class="flex-1 px-3 py-2.5 rounded-md text-[13px] font-medium cursor-pointer transition-all bg-gradient-to-br from-emerald-500 to-emerald-600 border-0 text-[#1a1a2e] hover:shadow-[0_0_15px_rgba(0,255,136,0.3)] disabled:opacity-50 disabled:cursor-not-allowed" on:click={handleSaveConfig} disabled={!serverUrl || !serverUsername || !serverPassword || isSavingConfig}>
                    {isSavingConfig ? 'Saving...' : 'Save Server'}
                  </button>
                  {#if isServerConfigured}
                    <button class="flex-[0.5] px-3 py-2.5 rounded-md text-[13px] font-medium cursor-pointer transition-all bg-red-400/10 border border-red-400/30 text-red-400 hover:bg-red-400/20" disabled={isSavingConfig} on:click={handleClearConfig}>
                      Disconnect
                    </button>
                  {/if}
                </div>
              </div>
            {/if}
          </div>

          <!-- Sync Settings Section -->
          <div class="border-b border-emerald-500/15">
            <button class="w-full flex justify-between items-center p-4 cursor-pointer transition-colors hover:bg-emerald-500/5" on:click={() => showSyncSettings = !showSyncSettings}>
              <div class="flex items-start gap-3">
                <span class="text-xl mt-0.5">⚙️</span>
                <div class="flex flex-col gap-0.5">
                  <span class="text-sm font-medium text-white">Sync Behavior Settings</span>
                  <span class="text-xs text-white/50">Auto-sync, WiFi-only, and defaults</span>
                </div>
              </div>
              <span class="text-xs text-white/40">{showSyncSettings ? '▼' : '▶'}</span>
            </button>

            {#if showSyncSettings && syncSettingsData}
              <div class="px-5 pb-4 flex flex-col gap-4">
                <div class="flex flex-col gap-2">
                  <h4 class="text-xs font-semibold text-emerald-400 uppercase tracking-wide m-0 pb-1.5 border-b border-emerald-500/20">Automatic Sync</h4>

                  <label class="flex items-start gap-3 py-2 cursor-pointer">
                    <input type="checkbox" class="mt-1 accent-emerald-500 w-4 h-4 cursor-pointer" bind:checked={syncSettingsData.syncOnLogin} disabled={isSavingSettings} />
                    <span class="flex flex-col gap-0.5">
                      <strong class="text-[13px] font-medium text-white/90">Sync on login</strong>
                      <small class="text-[11px] text-white/50">Pull latest memories when logging in</small>
                    </span>
                  </label>

                  <label class="flex items-start gap-3 py-2 cursor-pointer">
                    <input type="checkbox" class="mt-1 accent-emerald-500 w-4 h-4 cursor-pointer" bind:checked={syncSettingsData.syncOnWifiOnly} disabled={isSavingSettings} />
                    <span class="flex flex-col gap-0.5">
                      <strong class="text-[13px] font-medium text-white/90">WiFi only</strong>
                      <small class="text-[11px] text-white/50">Don't sync on cellular data</small>
                    </span>
                  </label>

                  <label class="flex items-start gap-3 py-2 cursor-pointer">
                    <input type="checkbox" class="mt-1 accent-emerald-500 w-4 h-4 cursor-pointer" bind:checked={syncSettingsData.manualSyncOnly} disabled={isSavingSettings} />
                    <span class="flex flex-col gap-0.5">
                      <strong class="text-[13px] font-medium text-white/90">Manual sync only</strong>
                      <small class="text-[11px] text-white/50">Disable all automatic syncing</small>
                    </span>
                  </label>
                </div>

                <div class="flex gap-2 pt-2">
                  <button class="flex-1 px-3 py-2.5 rounded-md text-[13px] font-medium cursor-pointer transition-all bg-gradient-to-br from-emerald-500 to-emerald-600 border-0 text-[#1a1a2e] hover:shadow-[0_0_15px_rgba(0,255,136,0.3)] disabled:opacity-50 disabled:cursor-not-allowed" on:click={handleSaveSyncSettings} disabled={isSavingSettings}>
                    {isSavingSettings ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>
              </div>
            {/if}
          </div>

          {#if isServerConfigured}
            <!-- Remote Sync Section -->
            <div class="p-4 border-b border-emerald-500/15 flex flex-col gap-3">
              <!-- Date Range Selector -->
              <div class="flex flex-col gap-1.5 p-3 bg-black/20 border border-white/10 rounded-lg">
                <label for="memory-sync-range" class="text-xs font-medium text-white/70">Memory sync range:</label>
                <select id="memory-sync-range" class="px-3 py-2 bg-black/30 border border-white/15 rounded-md text-sm text-white cursor-pointer focus:outline-none focus:border-emerald-500/50" bind:value={memoryDays}>
                  {#each dateRangeOptions as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
                <span class="text-[11px] text-white/40 italic">{dateRangeOptions.find(o => o.value === memoryDays)?.description || ''}</span>
              </div>

              <span class="text-[11px] text-white/40 text-center">Download profile, memories, and credentials from your server</span>
            </div>
          {/if}

          <!-- WiFi Warning -->
          <div class="flex items-start gap-3 px-5 py-4 bg-yellow-500/10 border-b border-yellow-500/20">
            <span class="text-xl">📶</span>
            <div class="flex flex-col gap-1">
              <span class="text-[13px] font-semibold text-yellow-500">WiFi Recommended</span>
              <span class="text-xs text-white/60 leading-relaxed">Sync operations can transfer significant amounts of data. We recommend using a WiFi connection to avoid mobile data charges.</span>
            </div>
          </div>

          <!-- Options Section -->
          <div class="p-4">
            <div class="flex justify-between items-center mb-3">
              <span class="text-[13px] font-medium text-white/70">Select data to sync:</span>
              <div class="flex gap-2">
                <button class="px-2 py-1 bg-white/5 border border-white/10 rounded text-[11px] text-white/60 cursor-pointer transition-all hover:bg-emerald-500/10 hover:border-emerald-500/30 hover:text-emerald-400" on:click={selectAll}>All</button>
                <button class="px-2 py-1 bg-white/5 border border-white/10 rounded text-[11px] text-white/60 cursor-pointer transition-all hover:bg-emerald-500/10 hover:border-emerald-500/30 hover:text-emerald-400" on:click={selectNone}>None</button>
              </div>
            </div>

            <div class="flex flex-col gap-2">
              {#each syncOptions as option}
                <label class="flex items-start gap-3 p-3 bg-white/[0.02] border border-white/5 rounded-lg cursor-pointer transition-all hover:bg-emerald-500/5 hover:border-emerald-500/20">
                  <input type="checkbox" class="mt-0.5 w-4 h-4 accent-emerald-500 cursor-pointer" checked={option.enabled} on:change={() => toggleOption(option.id)} />
                  <div class="flex flex-col gap-1 flex-1">
                    <div class="flex justify-between items-center">
                      <span class="text-sm font-medium text-white">{option.label}</span>
                    </div>
                    <span class="text-xs text-white/50 leading-relaxed">{option.description}</span>
                  </div>
                </label>
              {/each}
            </div>
          </div>
        </div>

        <!-- Action Section -->
        <div class="flex flex-col gap-2 p-5 border-t border-emerald-500/15">
          <button class="flex items-center justify-center gap-2 px-4 py-3.5 rounded-lg text-[15px] font-semibold cursor-pointer transition-all bg-gradient-to-br from-emerald-500 to-emerald-600 border-0 text-[#1a1a2e] hover:from-emerald-400 hover:to-emerald-500 hover:shadow-[0_0_20px_rgba(0,255,136,0.3)] disabled:opacity-50 disabled:cursor-not-allowed" on:click={handleRemoteSync} disabled={!syncOptions.some(opt => opt.enabled) || !isServerConfigured}>
            <span>⟳</span>
            {isServerConfigured ? 'Start Sync' : 'Configure Server First'}
          </button>
          <button class="flex items-center justify-center gap-2 px-4 py-3.5 rounded-lg text-[15px] font-semibold cursor-pointer transition-all bg-transparent border border-white/20 text-white/70 hover:bg-white/5 hover:border-white/30" on:click={handleClose}>
            Cancel
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Sync Complete Dialog -->
{#if showSyncComplete && syncResult}
  <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] backdrop-blur-sm">
    <div class="bg-gradient-to-b from-[#1a1a2e] to-[#16213e] border border-emerald-500/30 rounded-2xl w-[90%] max-w-[360px] p-8 text-center shadow-[0_0_60px_rgba(0,255,136,0.2),0_20px_60px_rgba(0,0,0,0.5)]" role="dialog" aria-modal="true" tabindex="-1">
      <div class="mb-6">
        {#if syncResult.success}
          <span class="inline-flex items-center justify-center w-16 h-16 rounded-full text-3xl font-bold bg-gradient-to-br from-emerald-500/20 to-emerald-600/20 border-2 border-emerald-400 text-emerald-400 shadow-[0_0_30px_rgba(0,255,136,0.3)]">✓</span>
        {:else}
          <span class="inline-flex items-center justify-center w-16 h-16 rounded-full text-3xl font-bold bg-gradient-to-br from-red-400/20 to-red-500/20 border-2 border-red-400 text-red-400 shadow-[0_0_30px_rgba(255,107,107,0.3)]">✗</span>
        {/if}
      </div>

      <h3 class="m-0 mb-6 text-xl font-semibold text-white">{syncResult.success ? 'Profile Sync complete' : 'Profile Sync report'}</h3>

      {#if syncResult.success}
        <p class="text-sm text-white/70">Selected Profile Sync work completed.</p>
        {#if syncResult.taskId}<p class="break-all font-mono text-xs text-emerald-400">Task {syncResult.taskId}</p>{/if}
      {:else}
        <div class="p-3 bg-red-400/10 border border-red-400/30 rounded-md mb-4">
          <span class="text-[13px] text-red-400">{syncResult.error || 'An unknown error occurred'}</span>
        </div>
      {/if}

      <button class="w-full px-4 py-3.5 bg-gradient-to-br from-emerald-500 to-emerald-600 border-0 rounded-lg text-[15px] font-semibold text-[#1a1a2e] cursor-pointer transition-all hover:shadow-[0_0_20px_rgba(0,255,136,0.3)]" on:click={handleCloseSyncComplete}>
        {syncResult.success ? 'Done' : 'Close'}
      </button>
    </div>
  </div>
{/if}

<style>
  /* Keyframe animations only */
  @keyframes pulse-ring {
    0% { transform: scale(0.5); opacity: 1; }
    100% { transform: scale(1.5); opacity: 0; }
  }

  .animate-pulse-ring {
    animation: pulse-ring 2s ease-out infinite;
  }

  .delay-500 {
    animation-delay: 0.5s;
  }

  .delay-1000 {
    animation-delay: 1s;
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }

  .animate-blink {
    animation: blink 1s step-end infinite;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }

  .animate-indeterminate {
    animation: indeterminate 1.5s ease-in-out infinite;
  }

</style>
