<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';

  type ChatSettings = {
    conversationBufferLimit: number;
    innerBufferLimit: number;
    systemBufferLimit: number;
    robotBufferLimit: number;
    unifiedConsciousness: boolean;
  };

  let settings: ChatSettings | null = null;
  let scope: { scope: 'user' | 'global'; hasUserOverride: boolean } | null = null;
  let loading = true;
  let saving = false;
  let presetEdits: Set<keyof ChatSettings> | null = null;
  let error = '';

  onMount(async () => {
    await loadSettings();
  });

  async function loadSettings() {
    try {
      loading = true;
      error = '';
      const res = await apiFetch('/api/chat-settings');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load chat settings');
      settings = data.settings;
      scope = data.scope;
    } catch (cause) {
      console.error('Failed to load chat settings:', cause);
      error = (cause as Error).message;
    } finally {
      loading = false;
    }
  }

  async function saveSettings(key: keyof ChatSettings) {
    presetEdits?.add(key);
    try {
      saving = true;
      error = '';
      const res = await apiFetch('/api/chat-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { [key]: settings![key] } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save settings');
      scope = data.scope;
    } catch (cause) {
      console.error('Failed to save settings:', cause);
      error = (cause as Error).message;
    } finally {
      saving = false;
    }
  }

  async function applyPreset(presetName: string) {
    const edits = new Set<keyof ChatSettings>();
    try {
      presetEdits = edits;
      error = '';
      const res = await apiFetch('/api/chat-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: presetName }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to apply preset');
      settings = {
        ...data.settings,
        ...Object.fromEntries([...edits].map(key => [key, settings![key]])),
      };
      scope = data.scope;
    } catch (cause) {
      console.error('Failed to apply preset:', cause);
      error = (cause as Error).message;
    } finally {
      presetEdits = null;
    }
  }
</script>

<div class="p-4 text-gray-200">
  <h3 class="m-0 mb-4 text-xl text-white">Chat Settings</h3>

  {#if error}
    <p class="text-red-400 text-sm" role="alert">{error}</p>
    {#if !settings && !loading}
      <button class="preset-btn" on:click={loadSettings}>Retry</button>
    {/if}
  {/if}

  {#if loading}
    <p class="text-gray-500 text-sm italic">Loading settings...</p>
  {:else if settings}
    <div class="bg-white/5 rounded-md p-3 mb-4">
      <p class="my-1 text-sm">
        <strong>Scope:</strong> {scope?.scope === 'user' ? 'User-specific' : 'Global'}
        {#if scope?.hasUserOverride}
          <span class="bg-purple-500 text-white py-0.5 px-2 rounded-full text-xs ml-2">Custom</span>
        {/if}
      </p>
      <p class="text-gray-500 text-sm my-1">
        {scope?.scope === 'user'
          ? 'Your personal chat settings (overrides global defaults)'
          : 'Global settings (applies to all users without custom settings)'}
      </p>
    </div>

    <!-- Presets -->
    <div class="mb-6">
      <h4 class="mt-6 mb-3 text-base text-gray-300">Quick Presets</h4>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
        <button
          class="preset-btn"
          on:click={() => applyPreset('focused')}
          disabled={presetEdits !== null}
        >
          🎯 Focused
        </button>
        <button
          class="preset-btn"
          on:click={() => applyPreset('balanced')}
          disabled={presetEdits !== null}
        >
          ⚖️ Balanced
        </button>
        <button
          class="preset-btn"
          on:click={() => applyPreset('immersive')}
          disabled={presetEdits !== null}
        >
          🌊 Immersive
        </button>
        <button
          class="preset-btn"
          on:click={() => applyPreset('minimal')}
          disabled={presetEdits !== null}
        >
          ✨ Minimal
        </button>
      </div>
    </div>

    <!-- Custom Settings -->
    <div>
      <h4 class="mt-6 mb-3 text-base text-gray-300">Buffer Retention</h4>

      <!-- Conversation Buffer Limit -->
      <div class="setting-group">
        <label for="conversation-buffer-limit" class="block mb-2 text-sm font-medium">
          Conversation Buffer Messages: {settings.conversationBufferLimit}
          <span class="block text-xs text-gray-500 font-normal mt-0.5">Maximum spoken conversation messages to retain</span>
        </label>
        <input id="conversation-buffer-limit" type="range" min="5" max="500" step="5" bind:value={settings.conversationBufferLimit} on:input={() => presetEdits?.add('conversationBufferLimit')} on:change={() => saveSettings('conversationBufferLimit')} class="range-slider" />
      </div>

      <!-- Inner Buffer Limit -->
      <div class="setting-group">
        <label for="inner-buffer-limit" class="block mb-2 text-sm font-medium">
          Inner Buffer Messages: {settings.innerBufferLimit}
          <span class="block text-xs text-gray-500 font-normal mt-0.5">Maximum unvoiced thoughts and generated inner dialogue to retain</span>
        </label>
        <input id="inner-buffer-limit" type="range" min="20" max="500" step="10" bind:value={settings.innerBufferLimit} on:input={() => presetEdits?.add('innerBufferLimit')} on:change={() => saveSettings('innerBufferLimit')} class="range-slider" />
      </div>

      <!-- System Buffer Limit -->
      <div class="setting-group">
        <label for="system-buffer-limit" class="block mb-2 text-sm font-medium">
          System Buffer Messages: {settings.systemBufferLimit}
          <span class="block text-xs text-gray-500 font-normal mt-0.5">Maximum durable system events to retain</span>
        </label>
        <input id="system-buffer-limit" type="range" min="20" max="500" step="10" bind:value={settings.systemBufferLimit} on:input={() => presetEdits?.add('systemBufferLimit')} on:change={() => saveSettings('systemBufferLimit')} class="range-slider" />
      </div>

      <!-- Robot Buffer Limit -->
      <div class="setting-group">
        <label for="robot-buffer-limit" class="block mb-2 text-sm font-medium">
          Robot Buffer Messages: {settings.robotBufferLimit}
          <span class="block text-xs text-gray-500 font-normal mt-0.5">Maximum outbound robot bridge records to retain</span>
        </label>
        <input id="robot-buffer-limit" type="range" min="20" max="500" step="10" bind:value={settings.robotBufferLimit} on:input={() => presetEdits?.add('robotBufferLimit')} on:change={() => saveSettings('robotBufferLimit')} class="range-slider" />
      </div>

      <!-- Consciousness Settings -->
      <h4 class="mt-6 mb-3 text-base text-gray-300">🧠 Consciousness Integration</h4>

      <!-- Unified Consciousness -->
      <div class="setting-group">
        <label class="consciousness-toggle">
          <input type="checkbox" bind:checked={settings.unifiedConsciousness} on:change={() => saveSettings('unifiedConsciousness')} class="absolute left-4 top-4 w-[18px] h-[18px] cursor-pointer" />
          <span class="flex items-center gap-2 font-semibold pl-7">
            Unified Consciousness
            {#if settings.unifiedConsciousness}
              <span class="text-[0.7rem] py-0.5 px-2 rounded-full bg-green-500/20 text-green-500">Active</span>
            {:else}
              <span class="text-[0.7rem] py-0.5 px-2 rounded-full bg-white/10 text-gray-500">Off</span>
            {/if}
          </span>
          <span class="block text-xs text-gray-500 font-normal pl-7 mt-2 leading-relaxed">
            When enabled, inner thoughts (reflections, dreams) influence conversation responses.
            Creates more integrated consciousness but may cause inner thoughts to "bleed" into conversation.
          </span>
        </label>
      </div>

      {#if saving}
        <p class="text-gray-500 text-sm italic">Saving...</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Preset button */
  .preset-btn {
    @apply bg-white/[0.08] border border-white/15 text-gray-200 p-3 rounded-md cursor-pointer flex flex-col items-start gap-1 transition-all text-sm;
  }
  .preset-btn:hover:not(:disabled) {
    @apply bg-white/[0.12] border-white/30;
  }
  .preset-btn:disabled {
    @apply opacity-50 cursor-not-allowed;
  }

  /* Setting group spacing */
  .setting-group {
    @apply mb-5;
  }

  /* Range slider styling */
  .range-slider {
    @apply w-full h-1.5 rounded-sm outline-none;
    background: rgba(255, 255, 255, 0.1);
    -webkit-appearance: none;
  }
  .range-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    @apply w-4 h-4 bg-purple-500 rounded-full cursor-pointer;
  }
  .range-slider::-moz-range-thumb {
    @apply w-4 h-4 bg-purple-500 rounded-full cursor-pointer border-0;
  }

  /* Consciousness toggle special card */
  .consciousness-toggle {
    @apply relative flex flex-col items-start bg-purple-500/10 border border-purple-500/30 rounded-lg p-4 cursor-pointer;
  }
</style>
