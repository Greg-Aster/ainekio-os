<script lang="ts">
  import { onMount } from 'svelte';
  import { getRemoteSyncConfig, type RemoteSyncConfig } from '../lib/client/profile-sync';
  import SyncManager from './SyncManager.svelte';

  export let compact = false;

  let showSyncManager = false;
  let config: RemoteSyncConfig | null = null;
  let error = '';
  let read: AbortController | undefined;

  onMount(() => {
    if (!compact) void loadRemoteConfig();
    return () => read?.abort();
  });

  async function loadRemoteConfig() {
    read?.abort();
    const current = new AbortController();
    read = current;
    error = '';
    try {
      const received = await getRemoteSyncConfig({ signal: current.signal });
      if (!current.signal.aborted) config = received;
    } catch (cause) {
      if (!current.signal.aborted) error = (cause as Error).message;
    } finally {
      if (read === current) read = undefined;
    }
  }

  function closeSyncManager() {
    showSyncManager = false;
    if (!compact) void loadRemoteConfig();
  }
</script>

{#if compact}
  <button class="inline-flex items-center gap-1 rounded px-2 py-1 text-base" on:click={() => showSyncManager = true} title="Open Profile Sync" aria-label="Open Profile Sync">↻</button>
{:else}
  <div class="rounded-lg bg-black/[0.02] p-4 dark:bg-white/[0.03]">
    <div class="mb-3 flex items-center justify-between">
      <h4 class="m-0 text-sm font-semibold text-gray-700 dark:text-gray-200">Profile Sync</h4>
      <button class="rounded-md border border-gray-300 px-2 py-1 text-xs dark:border-gray-600" on:click={() => showSyncManager = true}>Open Sync Manager</button>
    </div>
    {#if error}
      <div class="text-xs text-red-500">{error} <button class="underline" on:click={loadRemoteConfig}>Retry loading sync configuration</button></div>
    {/if}
    {#if config}
      {#if config.configured}
        <div class="break-all text-xs text-gray-700 dark:text-gray-300">Configured server: {config.serverUrl}</div>
        <div class="mt-2 text-xs text-gray-500">Last completed sync: {config.lastSyncAt ? new Date(config.lastSyncAt).toLocaleString() : 'Never'}</div>
      {:else}
        <p class="m-0 text-xs text-gray-500">No sync server is configured. Configure one in Sync Manager.</p>
      {/if}
    {:else if !error}
      <div class="text-xs text-gray-500">Loading sync configuration…</div>
    {/if}
  </div>
{/if}

{#if showSyncManager}
  <SyncManager isOpen={true} on:close={closeSyncManager} />
{/if}
