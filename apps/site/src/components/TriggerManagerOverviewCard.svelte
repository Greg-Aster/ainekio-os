<script lang="ts">
  import { onMount } from 'svelte';
  import { openTriggerManagerDashboard } from '../stores/navigation';
  import { isOwner } from '../stores/security-policy';
  import { autonomyModeDefinition } from '../lib/client/active-operator-modes';
  import { triggerManagerSnapshot, triggerManagerConnection, triggerManagerError, useTriggerManager } from '../lib/stores/trigger-manager';

  // Core publishes triggers in nextRun order; do not maintain another schedule.
  $: next = $triggerManagerSnapshot?.triggers.find(trigger => trigger.enabled && trigger.nextRun);
  $: mode = $triggerManagerSnapshot ? autonomyModeDefinition($triggerManagerSnapshot.autonomyMode) : null;
  onMount(useTriggerManager);

  function absolute(timestamp: string, timezone: string): string {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  }
</script>

<button class="card w-full p-5 text-left" on:click={openTriggerManagerDashboard}>
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">⏱️ Trigger Manager</h3>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Trigger admission and scheduled work</p>
    </div>
    {#if $isOwner && mode}<span class="rounded bg-violet-500/10 px-2 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300">{mode.badge} · {mode.label}</span>{/if}
  </div>
  {#if !$isOwner}
    <p class="mt-4 text-sm text-gray-500 dark:text-gray-400">Owner access is required to view Trigger Manager state.</p>
  {:else}
    {#if $triggerManagerError}<p class="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">{$triggerManagerError}</p>{/if}
    {#if !$triggerManagerSnapshot}
      <p class="mt-4 text-sm text-gray-500 dark:text-gray-400">{$triggerManagerConnection === 'live' ? 'Trigger Manager snapshot unavailable.' : 'Waiting for Trigger Manager snapshot'} · {$triggerManagerConnection}</p>
    {:else}
      {#if $triggerManagerConnection !== 'live'}<p class="mt-4 text-xs text-gray-500 dark:text-gray-400">Last received snapshot · {$triggerManagerConnection}</p>{/if}
      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        <div><div class="text-xs text-gray-500">Lifecycle</div><div class="font-semibold capitalize">{$triggerManagerSnapshot.lifecycle}</div></div>
        <div><div class="text-xs text-gray-500">Admission</div><div class="font-semibold">{$triggerManagerSnapshot.admissionPaused ? 'Paused' : $triggerManagerSnapshot.admissionEnabled ? 'Enabled' : 'Suppressed'}</div></div>
        <div><div class="text-xs text-gray-500">Next due</div>
          {#if next?.nextRun}
            <div class="font-semibold">{next.displayName}</div><div class="text-xs text-gray-500">{absolute(next.nextRun, $triggerManagerSnapshot.timezone)}</div>
          {:else}
            <div class="font-semibold">No scheduled trigger</div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</button>
