<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';
  import { readServerEvents } from '../lib/client/sse';

  interface Addon {
    name: string;
    description: string;
    category: string;
    installed: boolean;
    size: string;
    requirements: Record<string, string>;
    note?: string;
  }

  interface AddonCategory {
    name: string;
    description: string;
  }

  interface InstallLog {
    level: string;
    message: string;
    timestamp: Date;
  }

  interface AddonOperation {
    controller: AbortController | null;
    logs: InstallLog[];
  }

  let addons: Record<string, Addon> = {};
  let categories: Record<string, AddonCategory> = {};
  let loading = true;
  let error: string | null = null;
  let operations: Record<string, AddonOperation> = {};
  let currentInstallAddon: string | null = null;
  const catalogController = new AbortController();
  $: installation = currentInstallAddon ? operations[currentInstallAddon] : undefined;

  onMount(() => { void loadAddons(); });
  onDestroy(() => {
    catalogController.abort();
    closeInstallModal();
  });

  async function loadAddons() {
    try {
      const response = await apiFetch('/api/addons', { signal: catalogController.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      addons = data.addons;
      categories = data.categories;
      error = null;
    } catch (cause) {
      if (!catalogController.signal.aborted) error = String(cause);
    } finally {
      loading = false;
    }
  }

  function appendLog(addonId: string, level: string, message: string) {
    operations[addonId].logs = [...operations[addonId].logs, { level, message, timestamp: new Date() }];
  }

  async function installAddon(addonId: string) {
    if (!confirm(`Install ${addons[addonId].name}?\n\nThis will download and configure the addon. Installation may take several minutes.`)) return;

    closeInstallModal();
    const controller = new AbortController();
    operations[addonId] = { controller, logs: [] };
    currentInstallAddon = addonId;
    error = null;
    try {
      const response = await apiFetch('/api/addons/install-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addonId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error);
      }

      let completed = false;
      for await (const frame of readServerEvents(response, controller.signal)) {
        if (frame.event === 'start' || frame.event === 'log') {
          const data = JSON.parse(frame.data) as { level: string; message: string };
          appendLog(addonId, frame.event === 'start' ? 'info' : data.level, data.message);
        } else if (frame.event === 'complete') {
          const data = JSON.parse(frame.data) as { success: true; message: string } | { success: false; error: string };
          if (!data.success) throw new Error(data.error);
          appendLog(addonId, 'info', data.message);
          addons[addonId].installed = true;
          completed = true;
          break;
        } else if (frame.event === 'error') {
          const data = JSON.parse(frame.data) as { message: string };
          throw new Error(data.message);
        }
      }
      if (!completed) throw new Error('Installation stream ended without a completion result.');
    } catch (cause) {
      if (!controller.signal.aborted) {
        error = `Installation failed: ${String(cause)}`;
        appendLog(addonId, 'error', error);
      }
    } finally {
      operations[addonId].controller = null;
      if (currentInstallAddon !== addonId) delete operations[addonId];
    }
  }

  function closeInstallModal() {
    const addonId = currentInstallAddon;
    currentInstallAddon = null;
    if (addonId && !operations[addonId].controller) delete operations[addonId];
  }

  async function uninstallAddon(addonId: string) {
    if (!confirm(`Uninstall ${addons[addonId].name}?\n\nThis will remove the addon and its data.`)) return;

    const controller = new AbortController();
    operations[addonId] = { controller, logs: [] };
    error = null;
    try {
      const response = await apiFetch('/api/addons/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addonId }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      addons[addonId].installed = false;
    } catch (cause) {
      if (!controller.signal.aborted) error = `Uninstallation failed: ${String(cause)}`;
    } finally {
      operations[addonId].controller = null;
      if (currentInstallAddon !== addonId) delete operations[addonId];
    }
  }

  function scrollLogs(node: HTMLDivElement, _count: number) {
    function update() { node.scrollTop = node.scrollHeight; }
    update();
    return { update };
  }
</script>


<div class="p-6 max-w-[1200px] mx-auto">
  <div class="mb-8">
    <h2 class="m-0 mb-2 text-[1.75rem] text-gray-800 dark:text-gray-100">Addons</h2>
    <p class="m-0 text-gray-500 dark:text-gray-400 text-[0.95rem]">Extend Ainekio OS with optional features. Install only what you need to keep the system lightweight.</p>
  </div>

  {#if error}
    <div class="p-4 bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 rounded-md mb-6">{error}</div>
  {/if}

  {#if loading}
    <div class="text-center py-12 text-gray-500 dark:text-gray-400">Loading addons...</div>
  {:else}
    <div class="grid grid-cols-[repeat(auto-fill,minmax(350px,1fr))] gap-6">
      {#each Object.entries(addons) as [addonId, addon]}
        <div class="border-2 rounded-xl p-6 bg-white dark:bg-gray-800 transition-all hover:border-violet-600 hover:shadow-lg hover:shadow-violet-500/10 {addon.installed ? 'border-emerald-500 dark:border-emerald-600' : 'border-gray-200 dark:border-gray-700'}">
          <div class="flex justify-between items-start mb-4">
            <div>
              <h3 class="m-0 mb-1 text-xl text-gray-800 dark:text-gray-100">{addon.name}</h3>
              <span class="text-xs text-violet-600 font-semibold uppercase tracking-wide">{categories[addon.category]?.name || addon.category}</span>
            </div>
            <div class="flex gap-2 flex-wrap">
              {#if addon.installed}
                <span class="px-3 py-1 rounded-md text-xs font-semibold bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300">Installed</span>
              {:else}
                <span class="px-3 py-1 rounded-md text-xs font-semibold bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">Not Installed</span>
              {/if}
            </div>
          </div>

          <p class="m-0 mb-4 text-gray-600 dark:text-gray-300 text-[0.95rem] leading-relaxed">{addon.description}</p>

          {#if addon.note}
            <div class="p-3 bg-amber-100 dark:bg-amber-950 rounded-md text-amber-800 dark:text-amber-200 text-sm mb-4">ℹ️ {addon.note}</div>
          {/if}

          <div class="flex flex-wrap gap-4 mb-4 p-3 bg-gray-50 dark:bg-gray-900 rounded-md">
            <div class="flex gap-2 text-sm">
              <span class="text-gray-500 dark:text-gray-400 font-semibold">Size:</span>
              <span class="text-gray-800 dark:text-gray-100">{addon.size}</span>
            </div>
            {#if addon.requirements.python}
              <div class="flex gap-2 text-sm">
                <span class="text-gray-500 dark:text-gray-400 font-semibold">Python:</span>
                <span class="text-gray-800 dark:text-gray-100">{addon.requirements.python}</span>
              </div>
            {/if}
            {#if addon.requirements.gpu}
              <div class="flex gap-2 text-sm">
                <span class="text-gray-500 dark:text-gray-400 font-semibold">GPU:</span>
                <span class="text-gray-800 dark:text-gray-100">{addon.requirements.gpu}</span>
              </div>
            {/if}
            {#if addon.requirements.vram}
              <div class="flex gap-2 text-sm">
                <span class="text-gray-500 dark:text-gray-400 font-semibold">VRAM:</span>
                <span class="text-gray-800 dark:text-gray-100">{addon.requirements.vram}</span>
              </div>
            {/if}
          </div>

          <div class="flex gap-3">
            {#if addon.installed}
              <button
                class="flex-1 py-2.5 px-4 border-none rounded-md font-semibold cursor-pointer transition-all bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                on:click={() => uninstallAddon(addonId)}
                disabled={Boolean(operations[addonId]?.controller)}
              >
                {operations[addonId]?.controller ? 'Uninstalling...' : 'Uninstall'}
              </button>
            {:else}
              <button
                class="flex-1 py-2.5 px-4 border-none rounded-md font-semibold cursor-pointer transition-all bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                on:click={() => installAddon(addonId)}
                disabled={Boolean(operations[addonId]?.controller)}
              >
                {operations[addonId]?.controller ? 'Installing...' : 'Install'}
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if !error && Object.keys(addons).length === 0}
      <div class="text-center py-12 text-gray-500 dark:text-gray-400">
        <p>No addons are available.</p>
      </div>
    {/if}
  {/if}

  <!-- Installation Progress Modal -->
  {#if currentInstallAddon && installation}
    <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000]">
      <div class="bg-white dark:bg-gray-800 rounded-xl w-[90%] max-w-[800px] max-h-[80vh] flex flex-col shadow-2xl" role="dialog" aria-modal="true" tabindex="-1">
        <div class="p-6 border-b-2 border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <h3 class="m-0 text-xl text-gray-800 dark:text-gray-100">Installation: {addons[currentInstallAddon].name}</h3>
          <button class="bg-transparent border-none text-3xl leading-none text-gray-500 cursor-pointer w-8 h-8 flex items-center justify-center hover:text-gray-800 dark:hover:text-gray-100" on:click={closeInstallModal}>×</button>
        </div>

        <div use:scrollLogs={installation.logs.length} class="install-logs flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-gray-900 font-mono text-sm max-h-[500px]">
          {#each installation.logs as log}
            <div class="p-2 mb-1 rounded flex gap-3 {log.level === 'error' ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200' : 'bg-blue-50 dark:bg-blue-900 text-blue-800 dark:text-blue-200'}">
              <span class="shrink-0 opacity-70 font-semibold">{log.timestamp.toLocaleTimeString()}</span>
              <span class="flex-1 break-words">{log.message}</span>
            </div>
          {/each}
          {#if installation.logs.length === 0}
            <div class="text-center py-12 text-gray-500 dark:text-gray-400 italic">Waiting for installation to start...</div>
          {/if}
        </div>

        <div class="p-6 border-t-2 border-gray-200 dark:border-gray-700 flex justify-center">
          {#if installation.controller}
            <div class="text-violet-600 font-semibold flex items-center gap-2">
              <span class="animate-spin">⏳</span> Installation in progress...
            </div>
          {:else}
            <button class="btn-primary" on:click={closeInstallModal}>Close</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
