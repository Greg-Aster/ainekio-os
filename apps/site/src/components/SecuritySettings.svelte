<script lang="ts">
  import { onMount } from 'svelte';
  import { activeView, rightSidebarOpen, statusRefreshTrigger, currentUserStore, systemSection } from '../stores/navigation';
  import ProfileDangerZone from './ProfileDangerZone.svelte';
  import ProfileCreation from './ProfileCreation.svelte';
  import { apiFetch } from '../lib/client/api-config';

  interface User {
    id: string;
    username: string;
    role: 'owner' | 'standard' | 'guest' | 'anonymous';
    metadata?: {
      displayName?: string;
      email?: string;
    };
  }

  let currentUser: User | null = null;
  let error = '';
  let success = '';

  // Change username state
  let showChangeUsername = false;
  let newUsername = '';
  let usernamePassword = '';
  let usernameChanging = false;

  // Change password state
  let showChangePassword = false;
  let currentPassword = '';
  let newPassword = '';
  let confirmPassword = '';
  let passwordChanging = false;

  // Change display name/email state
  let showChangeProfile = false;
  let newDisplayName = '';
  let newEmail = '';
  let profileChanging = false;

  // Profile visibility state
  let profileVisibility: 'private' | 'public' | null = null;
  let visibilityLoading = true;
  let visibilityError = '';
  let savingVisibility = false;

  // Recovery codes state
  let recoveryCodes: string[] | null = null;
  let recoveryError = '';
  let recoveryCodesLoading = true;
  let showRecoveryCodes = false;
  let regeneratingCodes = false;
  let showRegenerateConfirm = false;

  // Profile memory reset state
  let resettingFactory = false;
  let resetUsername = '';
  let resetError = '';
  let resetComplete = false;

  $: currentUser = $currentUserStore;

  onMount(() => { void loadSettings(); });

  async function loadSettings() {
    if (currentUser) {
      await Promise.all([
        fetchVisibility(), loadRecoveryCodes(),
        ...(currentUser.role === 'owner' ? [loadTrustLevel(), loadAgentConfig(), loadTrustCoupling()] : []),
      ]);
    }
  }

  async function handleChangeUsername() {
    if (!newUsername || newUsername.trim() === '') {
      error = 'Username cannot be empty';
      return;
    }

    const account = currentUser!;
    usernameChanging = true;
    error = '';
    success = '';

    try {
      const response = await apiFetch('/api/auth/change-username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newUsername, password: usernamePassword }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        success = 'Username changed successfully!';
        showChangeUsername = false;
        newUsername = '';
        usernamePassword = '';
        account.username = data.username;
        currentUserStore.update(user => user);
      } else {
        error = data.error || 'Failed to change username';
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      usernameChanging = false;
    }
  }

  async function handleChangePassword() {
    if (!currentPassword || !newPassword || !confirmPassword) {
      error = 'All password fields are required';
      return;
    }

    if (newPassword !== confirmPassword) {
      error = 'New passwords do not match';
      return;
    }

    if (newPassword.length < 6) {
      error = 'Password must be at least 6 characters';
      return;
    }

    passwordChanging = true;
    error = '';
    success = '';

    try {
      const response = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        success = 'Password changed successfully!';
        showChangePassword = false;
        currentPassword = '';
        newPassword = '';
        confirmPassword = '';
      } else {
        error = data.error || 'Failed to change password';
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      passwordChanging = false;
    }
  }

  async function handleChangeProfile() {
    const account = currentUser!;
    profileChanging = true;
    error = '';
    success = '';

    try {
      const response = await apiFetch('/api/auth/update-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: newDisplayName,
          email: newEmail,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        success = 'Profile updated successfully!';
        showChangeProfile = false;
        account.metadata = data.user.metadata;
        currentUserStore.update(user => user);
      } else {
        error = data.error || 'Failed to update profile';
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      profileChanging = false;
    }
  }

  function cancelChangeUsername() {
    showChangeUsername = false;
    newUsername = '';
    usernamePassword = '';
    error = '';
  }

  function cancelChangePassword() {
    showChangePassword = false;
    currentPassword = '';
    newPassword = '';
    confirmPassword = '';
    error = '';
  }

  function openProfileForm() {
    newDisplayName = currentUser?.metadata?.displayName || '';
    newEmail = currentUser?.metadata?.email || '';
    showChangeProfile = true;
  }

  function cancelChangeProfile() {
    showChangeProfile = false;
    newDisplayName = '';
    newEmail = '';
    error = '';
  }

  // Profile visibility functions
  async function fetchVisibility() {
    visibilityLoading = true;
    visibilityError = '';
    try {
      const res = await apiFetch('/api/profiles/visibility');
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load visibility');
      profileVisibility = data.visibility;
    } catch (err) {
      visibilityError = (err as Error).message;
    } finally {
      visibilityLoading = false;
    }
  }

  async function saveVisibility(event: Event) {
    const target = event.target as HTMLSelectElement;
    savingVisibility = true;
    error = '';
    success = '';
    try {
      const res = await apiFetch('/api/profiles/visibility', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: target.value }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update visibility');
      profileVisibility = data.visibility;
      success = 'Profile visibility updated successfully';
    } catch (err) {
      error = (err as Error).message;
      target.value = profileVisibility!;
    } finally {
      savingVisibility = false;
    }
  }

  // Trust Level state
  let trustLevel: string | null = null;
  let trustError = '';
  let trustOptions: string[] = [];
  let trustLoading = true;
  let trustSaving = false;

  // Persona Summary state
  let includePersonaSummary: boolean | null = null;
  let personaSummaryError = '';
  let personaSummaryLoading = true;
  let personaSummarySaving = false;

  // Trust Coupling state
  let trustCoupled: boolean | null = null;
  let couplingMappings: Record<string, string> = {};
  let couplingDescriptions: Record<string, string> = {};
  let couplingError = '';
  let couplingLoading = true;
  let couplingSaving = false;

  async function loadTrustLevel() {
    trustLoading = true;
    trustError = '';
    try {
      const response = await apiFetch('/api/trust');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load trust level');
      trustLevel = data.level;
      trustOptions = data.available;
    } catch (err) {
      trustError = (err as Error).message;
    } finally {
      trustLoading = false;
    }
  }

  async function handleTrustLevelChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    const newLevel = target.value;

    trustSaving = true;
    error = '';
    success = '';

    try {
      const response = await apiFetch('/api/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: newLevel }),
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        trustLevel = data.level;
        success = `Trust level changed to: ${newLevel}`;
        // Trigger status refresh
        statusRefreshTrigger.update(n => n + 1);
      } else {
        error = data.error || 'Failed to change trust level';
        // Revert the select
        target.value = trustLevel!;
      }
    } catch (err) {
      error = (err as Error).message;
      // Revert the select
      target.value = trustLevel!;
    } finally {
      trustSaving = false;
    }
  }

  async function loadAgentConfig() {
    personaSummaryLoading = true;
    personaSummaryError = '';
    try {
      const response = await apiFetch('/api/agent-config');
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load persona summary setting');
      includePersonaSummary = data.config.includePersonaSummary;
    } catch (err) {
      personaSummaryError = (err as Error).message;
    } finally {
      personaSummaryLoading = false;
    }
  }

  async function handlePersonaSummaryToggle(event: Event) {
    const target = event.target as HTMLInputElement;
    personaSummarySaving = true;
    error = '';
    success = '';

    try {
      const response = await apiFetch('/api/agent-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includePersonaSummary: target.checked }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        includePersonaSummary = data.config.includePersonaSummary;
        statusRefreshTrigger.update(n => n + 1);
        success = `Persona summary ${includePersonaSummary ? 'enabled' : 'disabled'}`;
      } else {
        error = data.error || 'Failed to update persona summary setting';
        target.checked = includePersonaSummary === true;
      }
    } catch (err) {
      error = (err as Error).message;
      target.checked = includePersonaSummary === true;
    } finally {
      personaSummarySaving = false;
    }
  }

  async function loadTrustCoupling() {
    couplingLoading = true;
    couplingError = '';
    try {
      const response = await apiFetch('/api/trust-coupling');
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load trust coupling');
      trustCoupled = data.coupled;
      couplingMappings = data.mappings;
      couplingDescriptions = data.descriptions;
    } catch (err) {
      couplingError = (err as Error).message;
    } finally {
      couplingLoading = false;
    }
  }

  async function handleCouplingToggle(event: Event) {
    const target = event.target as HTMLInputElement;
    couplingSaving = true;
    error = '';
    success = '';

    try {
      const response = await apiFetch('/api/trust-coupling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coupled: target.checked }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        trustCoupled = data.coupled;
        couplingMappings = data.mappings;
        success = `Trust level ${trustCoupled ? 'coupled to' : 'decoupled from'} cognitive mode`;
        // Trigger status refresh
        statusRefreshTrigger.update(n => n + 1);
      } else {
        error = data.error || 'Failed to toggle coupling';
        target.checked = trustCoupled === true;
      }
    } catch (err) {
      error = (err as Error).message;
      target.checked = trustCoupled === true;
    } finally {
      couplingSaving = false;
    }
  }

  // Recovery codes functions
  async function loadRecoveryCodes() {
    recoveryCodesLoading = true;
    recoveryError = '';
    try {
      const response = await apiFetch('/api/recovery-codes');
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load recovery codes');
      recoveryCodes = data.codes;
    } catch (err) {
      recoveryError = (err as Error).message;
    } finally {
      recoveryCodesLoading = false;
    }
  }

  async function handleRegenerateCodes() {
    regeneratingCodes = true;
    error = '';
    success = '';

    try {
      const response = await apiFetch('/api/recovery-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (response.ok && data.success) {
        recoveryCodes = data.codes;
        recoveryError = '';
        showRecoveryCodes = true;
        showRegenerateConfirm = false;
        success = 'Recovery codes regenerated successfully! Save them in a secure place.';
      } else {
        error = data.error || 'Failed to regenerate recovery codes';
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      regeneratingCodes = false;
    }
  }

  async function copyAllCodesToClipboard(codes: string[]) {
    error = '';
    success = '';
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      success = 'Recovery codes copied to clipboard!';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to copy to clipboard';
    }
  }

  async function resetFactorySettings() {
    if (resettingFactory || !currentUser || resetUsername !== currentUser.username) return;
    resettingFactory = true;
    resetError = '';
    resetComplete = false;
    try {
      const res = await apiFetch('/api/reset-factory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmToken: 'CONFIRM_FACTORY_RESET', confirmUsername: resetUsername }),
      });
      const data = await res.json();
      if (!res.ok || data.success !== true) throw new Error(data.error || 'Memory reset failed');
      resetComplete = true;
      resetUsername = '';
    } catch (err) {
      resetError = err instanceof Error ? err.message : 'Memory reset failed';
    } finally {
      resettingFactory = false;
    }
  }
</script>

<div class="p-8 max-w-3xl mx-auto h-full overflow-y-auto overflow-x-hidden">
  <div class="mb-8">
    <h1 class="text-3xl font-bold text-gray-900 dark:text-gray-100 m-0 mb-2">🔒 Security & Account Settings</h1>
    <p class="text-gray-500 dark:text-gray-400 m-0">Manage your authentication and profile information</p>
  </div>

    {#if error}
      <div role="alert" class="flex items-center gap-3 p-4 rounded-lg mb-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200">
        <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <span class="flex-1">{error}</span>
        <button on:click={() => error = ''} class="ml-auto bg-transparent border-none text-2xl cursor-pointer text-inherit opacity-60 hover:opacity-100">×</button>
      </div>
    {/if}

    {#if success}
      <div role="status" class="flex items-center gap-3 p-4 rounded-lg mb-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-200">
        <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <span class="flex-1">{success}</span>
        <button on:click={() => success = ''} class="ml-auto bg-transparent border-none text-2xl cursor-pointer text-inherit opacity-60 hover:opacity-100">×</button>
      </div>
    {/if}

  {#if !currentUser}
    <div class="flex flex-col items-center justify-center py-16 px-8 text-center">
      <svg class="w-16 h-16 text-gray-400 dark:text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
      </svg>
      <h2 class="text-2xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-2">Authentication Required</h2>
      <p class="text-gray-500 dark:text-gray-400 m-0 mb-6">Please login to access security settings</p>
      <a href="/" class="inline-block px-6 py-3 bg-gradient-to-r from-violet-500 to-pink-600 text-white no-underline rounded-lg font-semibold transition-transform hover:-translate-y-0.5">Go to Login</a>
    </div>
  {:else}
    <!-- Current User Info -->
    <div class="panel mb-6">
      <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">Account Information</h2>
      <div class="flex flex-col gap-3">
        <div class="flex justify-between items-center py-2 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
          <span class="font-medium text-gray-500 dark:text-gray-400">Username:</span>
          <span class="font-medium text-gray-900 dark:text-gray-100">{currentUser.username}</span>
        </div>
        <div class="flex justify-between items-center py-2 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
          <span class="font-medium text-gray-500 dark:text-gray-400">Role:</span>
          <span class="inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase {currentUser.role === 'owner' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'}">{currentUser.role}</span>
        </div>
        {#if currentUser.metadata?.displayName}
          <div class="flex justify-between items-center py-2 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
            <span class="font-medium text-gray-500 dark:text-gray-400">Display Name:</span>
            <span class="font-medium text-gray-900 dark:text-gray-100">{currentUser.metadata.displayName}</span>
          </div>
        {/if}
        {#if currentUser.metadata?.email}
          <div class="flex justify-between items-center py-2 border-b border-gray-100 dark:border-gray-800 last:border-b-0">
            <span class="font-medium text-gray-500 dark:text-gray-400">Email:</span>
            <span class="font-medium text-gray-900 dark:text-gray-100">{currentUser.metadata.email}</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Change Username -->
    <div class="panel mb-6">
      <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">Change Username</h2>
      {#if !showChangeUsername}
        <p class="text-gray-500 dark:text-gray-400 m-0 mb-4">Your current username is <strong class="text-gray-900 dark:text-gray-100">{currentUser.username}</strong></p>
        <button class="btn-primary" on:click={() => showChangeUsername = true}>
          Change Username
        </button>
      {:else}
        <form on:submit|preventDefault={handleChangeUsername}>
          <div class="mb-4">
            <label for="newUsername" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">New Username</label>
            <input
              id="newUsername"
              type="text"
              bind:value={newUsername}
              placeholder="Enter new username"
              disabled={usernameChanging}
              required
              class="input-field"
            />
            <small class="block mt-1 text-sm text-gray-500 dark:text-gray-400">Username must be 3-50 characters, alphanumeric with underscore/hyphen</small>
          </div>
          <div class="mb-4">
            <label for="usernamePassword" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">Current Password</label>
            <input id="usernamePassword" type="password" bind:value={usernamePassword} autocomplete="current-password"
              disabled={usernameChanging} required class="input-field" />
          </div>
          <div class="flex gap-3">
            <button type="submit" class="btn-primary" disabled={usernameChanging}>
              {usernameChanging ? 'Changing...' : 'Save Username'}
            </button>
            <button type="button" class="btn-secondary" on:click={cancelChangeUsername} disabled={usernameChanging}>
              Cancel
            </button>
          </div>
        </form>
      {/if}
    </div>

    <!-- Change Password -->
    <div class="panel mb-6">
      <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">Change Password</h2>
      {#if !showChangePassword}
        <p class="text-gray-500 dark:text-gray-400 m-0 mb-4">Update your password to keep your account secure</p>
        <button class="btn-primary" on:click={() => showChangePassword = true}>
          Change Password
        </button>
      {:else}
        <form on:submit|preventDefault={handleChangePassword}>
          <div class="mb-4">
            <label for="currentPassword" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">Current Password</label>
            <input
              id="currentPassword"
              type="password"
              bind:value={currentPassword}
              placeholder="Enter current password"
              disabled={passwordChanging}
              required
              class="input-field"
            />
          </div>
          <div class="mb-4">
            <label for="newPassword" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">New Password</label>
            <input
              id="newPassword"
              type="password"
              bind:value={newPassword}
              placeholder="Enter new password"
              disabled={passwordChanging}
              required
              class="input-field"
            />
          </div>
          <div class="mb-4">
            <label for="confirmPassword" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">Confirm New Password</label>
            <input
              id="confirmPassword"
              type="password"
              bind:value={confirmPassword}
              placeholder="Confirm new password"
              disabled={passwordChanging}
              required
              class="input-field"
            />
          </div>
          <div class="flex gap-3">
            <button type="submit" class="btn-primary" disabled={passwordChanging}>
              {passwordChanging ? 'Changing...' : 'Save Password'}
            </button>
            <button type="button" class="btn-secondary" on:click={cancelChangePassword} disabled={passwordChanging}>
              Cancel
            </button>
          </div>
        </form>
      {/if}
    </div>

    <!-- Recovery Codes -->
    <div class="panel mb-6">
      <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">🔑 Recovery Codes</h2>
      <p class="text-gray-500 dark:text-gray-400 m-0 mb-4">Use recovery codes to reset your password if you forget it. Each code can only be used once.</p>

      {#if recoveryCodesLoading}
        <p class="text-gray-500 dark:text-gray-400 italic">Loading recovery codes...</p>
      {:else if recoveryCodes === null}
        <p role="alert">{recoveryError}</p>
        <button class="btn-secondary" on:click={loadRecoveryCodes}>Retry loading recovery codes</button>
      {:else}
        <div class="mb-6">
          <div class="mb-4">
            <strong class="text-lg text-gray-900 dark:text-gray-100">{recoveryCodes.length} of 10 codes remaining</strong>
          </div>
          {#if recoveryCodes.length <= 3 && recoveryCodes.length > 0}
            <div class="flex gap-3 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded-lg mb-4">
              <svg class="flex-shrink-0 w-5 h-5 text-yellow-600 dark:text-yellow-400" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1L1 14h14L8 1z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <path d="M8 6v3M8 11v1" stroke="currentColor" stroke-width="2" />
              </svg>
              <div class="flex-1">
                <strong class="block text-yellow-800 dark:text-yellow-300 mb-1 text-sm">Low Recovery Codes</strong>
                <p class="m-0 text-sm text-yellow-700 dark:text-yellow-400">You have {recoveryCodes.length} code{recoveryCodes.length === 1 ? '' : 's'} remaining. Consider regenerating new codes soon.</p>
              </div>
            </div>
          {:else if recoveryCodes.length === 0}
            <div class="flex gap-3 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg mb-4">
              <svg class="flex-shrink-0 w-5 h-5 text-red-600 dark:text-red-400" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1L1 14h14L8 1z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <path d="M8 6v3M8 11v1" stroke="currentColor" stroke-width="2" />
              </svg>
              <div class="flex-1">
                <strong class="block text-red-800 dark:text-red-300 mb-1 text-sm">No Recovery Codes Available</strong>
                <p class="m-0 text-sm text-red-700 dark:text-red-400">You have no recovery codes left. Regenerate codes immediately to ensure you can recover your account.</p>
              </div>
            </div>
          {/if}
        </div>

      {/if}

      {#if !recoveryCodesLoading}
        <div class="flex flex-wrap gap-3 mb-4">
          {#if recoveryCodes && recoveryCodes.length > 0 && !showRecoveryCodes}
            <button class="btn-secondary" on:click={() => showRecoveryCodes = true}>
              View Remaining Codes
            </button>
          {/if}

          {#if !showRegenerateConfirm}
            <button
              class="btn-primary"
              on:click={() => showRegenerateConfirm = true}
              disabled={regeneratingCodes}
            >
              Regenerate All Codes
            </button>
          {:else}
            <div class="w-full p-4 bg-yellow-50 dark:bg-yellow-900/20 border-2 border-yellow-300 dark:border-yellow-700 rounded-lg">
              <p class="m-0 mb-2 text-yellow-800 dark:text-yellow-300"><strong>⚠️ Are you sure?</strong></p>
              <p class="m-0 mb-4 text-yellow-700 dark:text-yellow-400">This will invalidate all existing recovery codes and generate 10 new ones.</p>
              <div class="flex gap-3">
                <button
                  class="btn-primary"
                  on:click={handleRegenerateCodes}
                  disabled={regeneratingCodes}
                >
                  {regeneratingCodes ? 'Regenerating...' : 'Yes, Regenerate'}
                </button>
                <button
                  class="btn-secondary"
                  on:click={() => showRegenerateConfirm = false}
                  disabled={regeneratingCodes}
                >
                  Cancel
                </button>
              </div>
            </div>
          {/if}
        </div>

        {#if showRecoveryCodes && recoveryCodes && recoveryCodes.length > 0}
          <div class="mt-6 p-6 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
            <div class="flex justify-between items-center mb-4 pb-3 border-b border-gray-200 dark:border-gray-700">
              <h3 class="text-base font-semibold text-gray-900 dark:text-gray-100 m-0">Your Recovery Codes</h3>
              <button class="btn-sm" on:click={() => copyAllCodesToClipboard(recoveryCodes!)}>
                📋 Copy All
              </button>
            </div>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 mb-4">
              {#each recoveryCodes as code, index}
                <div class="flex items-center gap-2 p-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md">
                  <span class="text-xs font-semibold text-gray-500 dark:text-gray-400">{(index + 1).toString().padStart(2, '0')}.</span>
                  <code class="font-mono text-sm font-semibold text-violet-500 dark:text-violet-400 tracking-wider">{code}</code>
                </div>
              {/each}
            </div>
            <button class="btn-secondary" on:click={() => showRecoveryCodes = false}>
              Hide Codes
            </button>
          </div>
        {/if}
      {/if}
    </div>

    <!-- Update Profile -->
    <div class="panel mb-6">
      <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">Profile Information</h2>
      {#if !showChangeProfile}
        <p class="text-gray-500 dark:text-gray-400 m-0 mb-4">Update your display name and email</p>
        <button class="btn-primary" on:click={openProfileForm}>
          Update Profile
        </button>
      {:else}
        <form on:submit|preventDefault={handleChangeProfile}>
          <div class="mb-4">
            <label for="displayName" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">Display Name</label>
            <input
              id="displayName"
              type="text"
              bind:value={newDisplayName}
              placeholder="Your display name"
              disabled={profileChanging}
              class="input-field"
            />
          </div>
          <div class="mb-4">
            <label for="email" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">Email (optional)</label>
            <input
              id="email"
              type="email"
              bind:value={newEmail}
              placeholder="your@email.com"
              disabled={profileChanging}
              class="input-field"
            />
          </div>
          <div class="flex gap-3">
            <button type="submit" class="btn-primary" disabled={profileChanging}>
              {profileChanging ? 'Updating...' : 'Save Profile'}
            </button>
            <button type="button" class="btn-secondary" on:click={cancelChangeProfile} disabled={profileChanging}>
              Cancel
            </button>
          </div>
        </form>
      {/if}
    </div>

    {#if currentUser.role === 'owner'}
      <div class="panel mb-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">Remote Access</h2>
        <button class="btn-secondary" on:click={() => systemSection.set('network')}>Open Network settings</button>
      </div>
    {/if}

    <!-- Trust Coupling (Owner Only) -->
    {#if currentUser.role === 'owner'}
      <div class="panel mb-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">🔗 Trust & Cognitive Mode Coupling</h2>
        <p class="text-gray-500 dark:text-gray-400 m-0 mb-4">Link trust level to cognitive mode for automatic permission adjustment</p>
        {#if couplingLoading}
          <p class="text-gray-500 dark:text-gray-400 italic">Loading coupling state...</p>
        {:else if trustCoupled === null}
          <p role="alert">{couplingError}</p>
          <button class="btn-secondary" on:click={loadTrustCoupling}>Retry loading trust coupling</button>
        {:else}
          <div class="flex flex-col gap-3">
            <label class="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={trustCoupled}
                on:change={handleCouplingToggle}
                disabled={couplingSaving}
                class="hidden peer"
              />
              <span class="relative w-12 h-6 bg-gray-300 dark:bg-gray-600 rounded-full transition-colors peer-checked:bg-violet-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:bg-white after:rounded-full after:transition-transform peer-checked:after:translate-x-6 peer-disabled:opacity-50"></span>
              <span class="font-medium text-gray-900 dark:text-gray-100">
                {trustCoupled ? 'Coupled (automatic)' : 'Decoupled (manual)'}
              </span>
            </label>
            {#if couplingSaving}
              <span class="text-violet-500 text-sm italic">Saving...</span>
            {/if}
          </div>
          <div class="mt-2 p-3 bg-gray-100 dark:bg-gray-800 rounded-lg border-l-3 border-violet-500">
            {#if trustCoupled}
              <small class="block text-gray-600 dark:text-gray-400 leading-relaxed">
                Trust levels configured for cognitive modes:
                {#each Object.entries(couplingMappings) as [mode, level]}
                  <br><strong>{mode}</strong> → {level} — {couplingDescriptions[mode]}
                {/each}
              </small>
            {:else}
              <small class="block text-gray-600 dark:text-gray-400 leading-relaxed">
                ⚠️ Trust level must be manually adjusted. Cognitive mode changes won't affect permissions.
              </small>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Trust Level (Owner Only) -->
      <div class="panel mb-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">🔐 Trust Level (Progressive Autonomy)</h2>
        <p class="text-gray-500 dark:text-gray-400 m-0 mb-4">Controls what skills the operator can access and whether actions require approval</p>
        {#if trustLoading}
          <p class="text-gray-500 dark:text-gray-400 italic">Loading trust level...</p>
        {:else if trustLevel === null}
          <p role="alert">{trustError}</p>
          <button class="btn-secondary" on:click={loadTrustLevel}>Retry loading trust level</button>
        {:else}
          <div class="flex flex-col gap-4">
            <div class="mb-4">
              <label for="trustLevel" class="block font-medium text-gray-700 dark:text-gray-300 mb-2">Current Trust Level</label>
              <select
                id="trustLevel"
                value={trustLevel}
                on:change={handleTrustLevelChange}
                disabled={trustSaving}
                class="select-field"
              >
                {#each trustOptions as option}
                  <option value={option}>{option}</option>
                {/each}
              </select>
              <small class="block mt-1 text-sm text-gray-500 dark:text-gray-400">Core applies the configured trust and risk policy to actions.</small>
            </div>
            <div class="p-3 bg-gray-100 dark:bg-gray-800 border-l-3 border-violet-500 rounded text-sm text-gray-700 dark:text-gray-300">
              <strong>Configured levels:</strong> {trustOptions.join(' → ')}
            </div>
          </div>
        {/if}
      </div>

      <!-- Persona Summary Toggle -->
      <div class="panel mb-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">🧠 Persona Summary</h2>
        <p class="text-gray-500 dark:text-gray-400 m-0 mb-4">Include your persona identity, values, and goals in chat context</p>
        {#if personaSummaryLoading}
          <p class="text-gray-500 dark:text-gray-400 italic">Loading persona summary setting...</p>
        {:else if includePersonaSummary === null}
          <p role="alert">{personaSummaryError}</p>
          <button class="btn-secondary" on:click={loadAgentConfig}>Retry loading persona summary</button>
        {:else}
          <div class="flex flex-col gap-3">
            <label class="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={includePersonaSummary}
                on:change={handlePersonaSummaryToggle}
                disabled={personaSummarySaving}
                class="hidden peer"
              />
              <span class="relative w-12 h-6 bg-gray-300 dark:bg-gray-600 rounded-full transition-colors peer-checked:bg-violet-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:bg-white after:rounded-full after:transition-transform peer-checked:after:translate-x-6 peer-disabled:opacity-50"></span>
              <span class="font-medium text-gray-900 dark:text-gray-100">
                {includePersonaSummary ? 'Enabled' : 'Disabled'}
              </span>
            </label>
            <small class="text-gray-500 dark:text-gray-400">
              When enabled, the AI will have access to your persona's identity, values, goals, and personality traits.
              This helps the AI respond more consistently with your configured personality.
            </small>
          </div>
        {/if}
      </div>

    {/if}

    {#if currentUser.role === 'owner'}
      <div class="panel mb-6">
        <ProfileCreation />
      </div>
    {/if}

    <!-- Danger Zone -->
    <div class="bg-red-50 dark:bg-red-900/20 border-2 border-red-500 rounded-xl p-6 mb-6">
      <h2 class="text-xl font-semibold text-red-800 dark:text-red-200 m-0 mb-4">⚠️ Danger Zone</h2>
      <p class="text-sm text-red-700 dark:text-red-300 m-0 mb-4">
        Critical operations that can permanently affect your account, data, and system configuration. Proceed with caution.
      </p>

      <!-- Profile Visibility -->
      <div class="py-6 border-b border-red-500/30 first:pt-0 last:border-b-0 last:pb-0">
        <h3 class="text-lg font-semibold text-red-800 dark:text-red-200 m-0 mb-3">🌍 Profile Visibility</h3>
        <p class="text-sm text-red-700 dark:text-red-300 m-0 mb-4">Control who can view your profile as a guest user</p>

        <div class="mb-4">
          {#if visibilityLoading}
            <p role="status">Loading visibility...</p>
          {:else if profileVisibility === null}
            <p role="alert">{visibilityError}</p>
            <button class="btn-secondary" on:click={fetchVisibility}>Retry loading visibility</button>
          {:else}
          <select
            value={profileVisibility}
            on:change={saveVisibility}
            disabled={savingVisibility}
            class="select-field"
          >
            <option value="private">🔒 Private - Authorized account only</option>
            <option value="public">🌍 Public - Available in guest profile selection</option>
          </select>
          {/if}
        </div>

        {#if profileVisibility === 'public'}
          <div class="flex gap-3 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded-lg">
            <svg class="flex-shrink-0 w-5 h-5 text-yellow-600 dark:text-yellow-400" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1L1 14h14L8 1z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linejoin="round"
              />
              <path d="M8 6v3M8 11v1" stroke="currentColor" stroke-width="2" />
            </svg>
            <div class="flex-1">
              <strong class="block text-yellow-800 dark:text-yellow-300 mb-1 text-sm">Public Profile Warning</strong>
              <p class="m-0 text-sm text-yellow-700 dark:text-yellow-400">
                Guest users will be able to interact with your persona in read-only
                emulation mode. They cannot modify your data or access private information.
              </p>
            </div>
          </div>
        {/if}
      </div>

      <!-- Profile Deletion / Account Removal -->
      <div class="py-6 border-b border-red-500/30 first:pt-0 last:border-b-0 last:pb-0">
        {#if currentUser.role === 'owner' || currentUser.role === 'standard'}
          <ProfileDangerZone {currentUser} />
        {/if}
      </div>

      <!-- Profile Memory Reset (Owner Only) -->
      {#if currentUser.role === 'owner'}
        <div class="py-6 border-b border-red-500/30 first:pt-0 last:border-b-0 last:pb-0">
          <h3 class="text-lg font-semibold text-red-800 dark:text-red-200 m-0 mb-3">Reset profile memory</h3>
          <p class="text-sm text-red-700 dark:text-red-300 m-0 mb-4">
            Permanently clear memories, Agency desires and their plans, reviews and history,
            conversation and inner-dialogue history, queued speech, saved workflow history, and profile logs for <strong>{currentUser.username}</strong>.
          </p>
          <p class="text-sm m-0 mb-4">
            Your account, persona identity, tasks, projects, settings (including Agency settings), and previously generated training datasets and models remain.
            Shared security logs and other profiles remain. This does not change a trained model's learned behavior.
          </p>
          <p class="text-sm m-0 mb-4">
            Reset also ends inactive conversations and workflows waiting for input or authorization.
            Finish or cancel running work before resetting.
            <button class="underline" on:click={() => rightSidebarOpen.set(true)}>Open the right sidebar</button>
            and choose Queue. Stop training in <button class="underline" on:click={() => activeView.set('training')}>AI Training</button>.
          </p>
          <label class="block text-sm mb-2" for="memory-reset-username">Type {currentUser.username} to confirm</label>
          <input id="memory-reset-username" class="w-full p-2 mb-3 border rounded bg-white dark:bg-gray-800"
            bind:value={resetUsername} autocomplete="off" spellcheck={false} disabled={resettingFactory} />
          <button class="btn-danger" on:click={resetFactorySettings}
            disabled={resettingFactory || resetUsername !== currentUser.username}>
            {resettingFactory ? 'Resetting memory…' : 'Reset profile memory'}
          </button>
          {#if resetError}
            <p role="alert" class="text-red-700 dark:text-red-300 mt-3">{resetError}</p>
          {/if}
          {#if resetComplete}
            <p role="status" class="mt-3">Memory reset completed for {currentUser.username}.</p>
            <button class="underline" on:click={() => window.location.reload()}>Reload application</button>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Security Information -->
    <div class="panel mb-6">
      <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100 m-0 mb-4">Security Information</h2>
      <ul class="m-0 pl-6">
        <li class="text-gray-500 dark:text-gray-400 mb-2">Your password is hashed and never stored in plain text</li>
        <li class="text-gray-500 dark:text-gray-400 mb-2">Session cookies are HTTPOnly</li>
        <li class="text-gray-500 dark:text-gray-400 mb-2">Owner and standard sessions last 24 hours; guest sessions last 1 hour</li>
        <li class="text-gray-500 dark:text-gray-400 mb-2">Clearing this browser’s cookies signs out this browser</li>
        {#if currentUser.role === 'owner'}
          <li class="text-gray-500 dark:text-gray-400 mb-2">Trust level changes are audited and logged for security</li>
          <li class="text-gray-500 dark:text-gray-400 mb-2">Core applies the configured trust and risk policy to actions</li>
        {/if}
      </ul>
    </div>
  {/if}
</div>

<style>
  .border-l-3 {
    border-left-width: 3px;
  }
</style>
