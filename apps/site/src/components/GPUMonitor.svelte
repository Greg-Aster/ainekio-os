<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';

  interface GPUMemory {
    total: number;
    used: number;
    free: number;
    usedPercent: number;
    freePercent: number;
  }

  interface GPU {
    index: number;
    name: string;
    memory: GPUMemory;
    utilization: {
      gpu: number;
      memory: number;
    };
  }

  interface Process {
    pid: number;
    name: string;
    memory: number;
  }

  interface GPUStatus {
    available: boolean;
    error?: string;
    gpus?: GPU[];
    processes?: Process[];
  }

  let status: GPUStatus | null = null;
  let loading = true;
  let error: string | null = null;
  let statusRead: AbortController | null = null;

  onMount(() => { void loadGPUStatus(); });
  onDestroy(() => { statusRead?.abort(); });

  async function loadGPUStatus() {
    statusRead?.abort();
    const controller = new AbortController();
    statusRead = controller;
    loading = true;
    error = null;
    try {
      const res = await apiFetch('/api/gpu-status', { signal: controller.signal });
      const data: GPUStatus = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      controller.signal.throwIfAborted();
      status = data;
    } catch (cause) {
      if (!controller.signal.aborted) error = String(cause);
    } finally {
      if (statusRead === controller) loading = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <div><button class="btn-secondary btn-sm" on:click={loadGPUStatus} disabled={loading}>{loading ? 'Reading…' : 'Refresh GPU status'}</button></div>
  {#if loading}
    <div class="p-4 rounded-lg flex items-center gap-3 bg-violet-500/5 dark:bg-violet-400/10 text-gray-600 dark:text-gray-400">
      Loading GPU status...
    </div>
  {:else if error}
    <div class="p-4 rounded-lg flex items-center gap-3 bg-red-500/10 dark:bg-red-500/15 text-red-600 dark:text-red-400">
      <span class="text-xl">⚠</span>
      <span>Error loading GPU status: {error}</span>
    </div>
  {:else if status && status.available && status.gpus}
    {#each status.gpus as gpu}
      <div class="panel">
        <div class="flex items-center gap-3 mb-4">
          <span class="text-2xl">🎮</span>
          <h4 class="m-0 text-base font-semibold text-gray-900 dark:text-gray-100">GPU {gpu.index}: {gpu.name}</h4>
        </div>

        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="flex flex-col gap-1">
              <span class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Total VRAM</span>
              <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">{gpu.memory.total} MB</span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Used</span>
              <span class="text-sm font-semibold text-amber-500 dark:text-amber-400">{gpu.memory.used} MB ({gpu.memory.usedPercent}%)</span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Free</span>
              <span class="text-sm font-semibold text-green-500 dark:text-green-400">{gpu.memory.free} MB ({gpu.memory.freePercent}%)</span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">GPU Usage</span>
              <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">{gpu.utilization.gpu}%</span>
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <div class="h-6 bg-gray-200 dark:bg-gray-700 rounded-md overflow-hidden">
              <div class="h-full bg-gradient-to-r from-amber-500 to-red-500 transition-all duration-300" style="width: {gpu.memory.usedPercent}%"></div>
            </div>
            <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>0%</span>
              <span>100%</span>
            </div>
          </div>
        </div>
      </div>
    {/each}

    <!-- GPU Processes -->
    {#if status.processes && status.processes.length > 0}
      <div class="panel">
        <h5 class="m-0 mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide">GPU Processes</h5>
        <div class="flex flex-col gap-2">
          {#each status.processes as process}
            <div class="flex justify-between items-center p-2 bg-violet-500/5 dark:bg-violet-400/10 rounded-md">
              <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">{process.name}</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">PID: {process.pid} • {process.memory} MB</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
