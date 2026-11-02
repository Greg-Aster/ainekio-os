<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';
  import { AUTONOMY_MODES, type AutonomyMode } from '../lib/client/active-operator-modes';

  let autonomyMode: AutonomyMode = 'reactive';
  let semiAssessmentMinutes = 5;
  let loading = false;
  let saving = false;
  let error = '';

  const modes = AUTONOMY_MODES;

  onMount(loadConfig);

  async function loadConfig() {
    loading = true;
    error = '';
    try {
      const response = await apiFetch('/api/active-operator/config');
      const config = await response.json();
      if (!response.ok) throw new Error(config.error || 'Failed to load Active Operator configuration');
      autonomyMode = config.autonomyMode || 'reactive';
      semiAssessmentMinutes = config.semiAssessmentMinutes;
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      loading = false;
    }
  }

  async function saveAssessmentInterval() {
    saving = true;
    error = '';
    try {
      const response = await apiFetch('/api/active-operator/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ semiAssessmentMinutes }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to save assessment interval');
      semiAssessmentMinutes = result.semiAssessmentMinutes;
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      saving = false;
    }
  }

  async function setMode(mode: AutonomyMode) {
    saving = true;
    error = '';
    try {
      const response = await apiFetch('/api/active-operator/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-mode', mode }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to change autonomy mode');
      autonomyMode = result.mode;
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      saving = false;
    }
  }

  async function emergencyStop() {
    if (!confirm('Cancel active autonomous work and return to reactive mode?')) return;
    saving = true;
    try {
      const response = await apiFetch('/api/active-operator/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'emergency-stop' }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Emergency stop failed');
      autonomyMode = 'reactive';
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      saving = false;
    }
  }
</script>

<div class="card mb-4 p-4">
  <div class="mb-2 flex items-center justify-between">
    <span class="text-base font-semibold text-white">Active Operator</span>
    <span class="rounded bg-white/10 px-2 py-1 text-xs font-semibold uppercase text-white">{autonomyMode}</span>
  </div>
  <p class="mb-4 text-sm text-gray-500">Select how the Active Operator agent coordinates robot activity. Reactive keeps it dormant; Semi triggers operations at 100%; Full develops intentions and selects the highest positive returned activation.</p>

  {#if error}<div class="banner banner-error mb-4">{error}</div>{/if}

  <div class="grid gap-2">
    {#each modes as mode}
      <button
        class="rounded border p-3 text-left {autonomyMode === mode.id ? 'border-blue-500 bg-blue-500/10' : 'border-white/10'}"
        disabled={loading || saving}
        on:click={() => setMode(mode.id)}
      >
        <div class="text-sm font-medium text-white">{mode.label}</div>
        <div class="mt-1 text-xs text-gray-500">{mode.description}</div>
      </button>
    {/each}
  </div>

  <form class="mt-4" on:submit|preventDefault={saveAssessmentInterval}>
    <label class="block text-sm text-white" for="semi-assessment-minutes">Semi Auto assessment interval (minutes)</label>
    <div class="mt-2 flex items-center gap-2">
      <input id="semi-assessment-minutes" type="number" min="0" step="any" required
        class="min-w-0 flex-1 rounded border border-white/10 bg-transparent p-2 text-white"
        bind:value={semiAssessmentMinutes} disabled={loading || saving} />
      <button type="submit" class="rounded border border-white/10 px-3 py-2 text-white"
        disabled={loading || saving || !(semiAssessmentMinutes > 0)}>Save</button>
    </div>
    <p class="mt-2 text-xs text-gray-500">Default: 5 minutes between assessments. Conversation does not restart the interval. Selected tasks run independently. Full Auto does not use this interval.</p>
  </form>

  {#if autonomyMode === 'full'}
    <button class="danger-button mt-4" disabled={saving} on:click={emergencyStop}>Emergency stop autonomy</button>
  {/if}
</div>
