<script lang="ts">
  import { onMount } from 'svelte';
  import {
    checkForUpdates,
    formatFileSize,
    formatRelativeTime,
    initUpdateChecker,
    performUpdate,
    restartServer,
    updateState,
  } from '../lib/client/app-updater';

  let restartError: string | null = null;
  let restarting = false;
  let restartRequested = false;

  onMount(async () => {
    try {
      await initUpdateChecker();
    } catch {
      // initUpdateChecker records the actionable error in the shared update state.
    }
  });

  async function handleCheckForUpdates() {
    try {
      await checkForUpdates();
    } catch {
      // checkForUpdates records the actionable error in the shared update state.
    }
  }

  async function handleUpdate() {
    try {
      await performUpdate();
    } catch {
      // performUpdate records the actionable error in the shared update state.
    }
  }

  async function handleRestart() {
    restarting = true;
    restartError = null;
    try {
      await restartServer();
      restartRequested = true;
    } catch (error) {
      restartError = error instanceof Error ? error.message : 'Server restart failed';
    } finally {
      restarting = false;
    }
  }
</script>

<div class="p-4">
  <div class="flex justify-between items-center gap-3 mb-4">
    <h3 class="m-0 text-base font-semibold text-gray-700 dark:text-gray-200">
      {$updateState.platform === 'mobile' ? 'App Updates' : 'Server Updates'}
    </h3>
    <button
      class="px-3 py-1.5 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 rounded-md text-xs cursor-pointer text-gray-700 dark:text-gray-200 hover:enabled:bg-gray-100 dark:hover:enabled:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
      on:click={handleCheckForUpdates}
      disabled={$updateState.checking || $updateState.updating || restarting}
    >
      {$updateState.checking ? 'Checking…' : 'Check for Updates'}
    </button>
  </div>

  {#if $updateState.error || restartError}
    <div class="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-600 rounded-md mb-4 text-sm text-red-800 dark:text-red-200">
      {$updateState.error || restartError}
    </div>
  {/if}

  {#if $updateState.lastChecked}
    <p class="mt-0 mb-3 text-xs text-gray-500">Last checked {formatRelativeTime($updateState.lastChecked)}</p>
  {/if}

  {#if $updateState.platform === 'mobile'}
    <div class="mb-4 text-sm text-gray-600 dark:text-gray-300">
      Installed version {$updateState.currentVersion} (build {$updateState.currentVersionCode})
    </div>

    {#if $updateState.latestMobileVersion}
      <div class="p-4 rounded-lg border {$updateState.updateAvailable ? 'bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-700' : 'bg-green-50 dark:bg-green-950 border-green-300 dark:border-green-700'}">
        <strong>{$updateState.updateAvailable ? 'Update available' : 'App is up to date'}</strong>
        <p class="my-2 text-sm text-gray-600 dark:text-gray-300">
          Version {$updateState.latestMobileVersion.version} · {formatFileSize($updateState.latestMobileVersion.fileSize)}
        </p>
        {#if $updateState.latestMobileVersion.releaseNotes}
          <p class="my-2 text-xs text-gray-500 whitespace-pre-wrap">{$updateState.latestMobileVersion.releaseNotes}</p>
        {/if}
        {#if $updateState.updateAvailable}
          <button
            class="w-full mt-3 py-2.5 border-none bg-blue-500 text-white rounded-md text-sm font-medium cursor-pointer hover:enabled:bg-blue-600 disabled:opacity-50"
            on:click={handleUpdate}
            disabled={$updateState.updating}
          >
            {$updateState.updating ? `Opening download… ${$updateState.updateProgress}%` : 'Download Signed APK'}
          </button>
        {/if}
      </div>
    {:else if !$updateState.checking}
      <p class="text-sm text-gray-500">Check the connected server for a signed mobile release.</p>
    {/if}
  {:else if $updateState.platform === 'server'}
    {#if $updateState.serverUpdateInfo}
      <div class="p-4 rounded-lg border {$updateState.updateAvailable ? 'bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-700' : 'bg-green-50 dark:bg-green-950 border-green-300 dark:border-green-700'}">
        <strong>{$updateState.updateAvailable ? `${$updateState.serverUpdateInfo.commitsBehind} update commit${$updateState.serverUpdateInfo.commitsBehind === 1 ? '' : 's'} available` : 'Server is up to date'}</strong>
        <p class="my-2 text-sm text-gray-600 dark:text-gray-300">Current {$updateState.serverUpdateInfo.currentVersion}</p>
        {#if $updateState.serverUpdateInfo.changesSummary.length > 0}
          <ul class="my-3 pl-5 text-xs text-gray-500">
            {#each $updateState.serverUpdateInfo.changesSummary as change}
              <li>{change}</li>
            {/each}
          </ul>
        {/if}
        {#if $updateState.serverUpdateInfo.reason && !$updateState.serverUpdateInfo.canUpdate}
          <p class="my-2 text-sm text-amber-700 dark:text-amber-300">{$updateState.serverUpdateInfo.reason}</p>
        {/if}
        {#if $updateState.serverUpdateInfo.canUpdate}
          <button
            class="w-full mt-3 py-2.5 border-none bg-blue-500 text-white rounded-md text-sm font-medium cursor-pointer hover:enabled:bg-blue-600 disabled:opacity-50"
            on:click={handleUpdate}
            disabled={$updateState.updating}
          >
            {$updateState.updating ? `Validating update… ${$updateState.updateProgress}%` : 'Install and Build Update'}
          </button>
        {/if}
      </div>
    {:else if !$updateState.checking}
      <p class="text-sm text-gray-500">Check the configured Git upstream for a fast-forward server update.</p>
    {/if}

    {#if $updateState.restartRequired}
      <div class="mt-4 p-4 bg-blue-50 dark:bg-blue-950 border border-blue-300 dark:border-blue-700 rounded-lg">
        <p class="mt-0 mb-3 text-sm text-blue-800 dark:text-blue-200">The update passed verification and its production build. Restart to activate it.</p>
        <button
          class="w-full py-2.5 border-none bg-blue-600 text-white rounded-md text-sm font-medium cursor-pointer disabled:opacity-50"
          on:click={handleRestart}
          disabled={restarting || restartRequested}
        >
          {restartRequested ? 'Restart requested — reload when available' : restarting ? 'Requesting restart…' : 'Restart Server'}
        </button>
      </div>
    {/if}
  {/if}
</div>
