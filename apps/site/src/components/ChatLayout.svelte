<script lang="ts">
  import { onMount } from 'svelte';
  import { graphEditorHref, statusStore, statusRefreshTrigger, nodeEditorMode, rightSidebarOpen as rightSidebarStore, currentUserStore, userDisplayNameStore } from '../stores/navigation';
  import { clearSecurityPolicy, fetchSecurityPolicy, policyStore, isOwner } from '../stores/security-policy';
  import { apiFetch, apiUrl } from '../lib/client/api-config';
  import HeadlessClaimBanner from './HeadlessClaimBanner.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import LeftSidebar from './LeftSidebar.svelte';
  import CenterContent from './CenterContent.svelte';
  import RightSidebar from './RightSidebar.svelte';
  // FlowEditorLayout is loaded dynamically to avoid bundling @xyflow/svelte in client
  type FlowEditorLayoutComponentType = typeof import('./flow-editor/FlowEditorLayout.svelte').default;
  let FlowEditorLayoutComponent: FlowEditorLayoutComponentType | null = null;
  let flowEditorLoading = false;
  let flowEditorError = '';

  // Sidebar visibility state - mobile-first defaults
  let leftSidebarOpen = false;
  // rightSidebarOpen is now from the store (rightSidebarStore)
  // Use reactive statement to get current value
  $: rightSidebarOpen = $rightSidebarStore;
  let isMobile = true;

  // Right sidebar resize state
  let rightSidebarWidth = 280; // Default width in pixels
  let isResizingRightSidebar = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  let resizeUserSelect = '';
  let resizeCursor = '';

  interface ModeDefinition {
    id: 'dual' | 'agent' | 'emulation' | 'environment';
    label: string;
    description: string;
    guidance: string[];
  }

  let cognitiveModes: ModeDefinition[] = [];
  $: cognitiveMode = $policyStore ? cognitiveModes.find(mode => mode.id === $policyStore.mode) ?? null : null;
  let modeMenuOpen = false;
  let modeLoading = false;
  let modeSaving = false;
  let modeError = '';
  let modeMenuAnchor: HTMLDivElement | null = null;

  // System status and allowed modes
  let systemStatus: any = null;
  let allowedModes: string[] = [];
  let systemStatusError = '';

  // AuthGate owns session restoration; the layout consumes its result.
  $: currentUser = $currentUserStore;
  $: displayUsername = $userDisplayNameStore;
  let userMenuOpen = false;
  let logoutError = '';
  let userMenuAnchor: HTMLElement | null = null;

  // Persona name and icon state
  $: personaName = $statusStore?.data?.identity?.name || 'Ainekio OS';
  $: personaIcon = $statusStore?.data?.identity?.icon || null;
  let personaIconError = false;
  $: if (personaIcon) personaIconError = false;

  type ModeVisual = {
    icon: string;
    color: string;
    glow: string;
  };

  const defaultVisual: ModeVisual = {
    icon: '💭',
    color: '#7c3aed',
    glow: 'rgba(124, 58, 237, 0.55)',
  };

  function getModeVisual(mode: ModeDefinition | null): ModeVisual {
    if (!mode) return defaultVisual;
    switch (mode.id) {
      case 'dual':
        return {
          icon: '💭',
          color: '#a855f7',
          glow: 'rgba(168, 85, 247, 0.65)',
        };
      case 'agent':
        return {
          icon: '🛠️',
          color: '#38bdf8',
          glow: 'rgba(56, 189, 248, 0.6)',
        };
      case 'emulation':
        return {
          icon: '🪄',
          color: '#fbbf24',
          glow: 'rgba(251, 191, 36, 0.55)',
        };
      case 'environment':
        return {
          icon: '🌐',
          color: '#2dd4bf',
          glow: 'rgba(45, 212, 191, 0.55)',
        };
      default:
        return defaultVisual;
    }
  }

  $: modeVisual = getModeVisual(cognitiveMode);

  // Detect screen size
  function updateScreenSize() {
    if (typeof window !== 'undefined') {
      isMobile = window.innerWidth < 768;
      if (isMobile) stopRightSidebarResize();
    }
  }

  let statusRead: AbortController | undefined;
  let modeRead: AbortController | undefined;
  let systemRead: AbortController | undefined;
  let closed = false;

  async function loadStatus() {
    statusRead?.abort();
    const controller = statusRead = new AbortController();
    try {
      const res = await apiFetch('/api/status', { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error(`Failed to load portal status (status ${res.status})`);
      const data = await res.json();
      if (!controller.signal.aborted) statusStore.set({ data, error: null, receivedAt: Date.now() });
    } catch (error) {
      if (!controller.signal.aborted) statusStore.update(current => ({ ...current, data: current?.data ?? null, error: (error as Error).message }));
    }
  }

  async function loadCognitiveModeState() {
    modeRead?.abort();
    if (closed) return;
    const current = modeRead = new AbortController();
    modeLoading = true;
    try {
      const res = await apiFetch('/api/cognitive-mode', { cache: 'no-store', signal: current.signal });
      if (!res.ok) throw new Error(`Failed to load cognitive mode (status ${res.status})`);
      const data = await res.json();
      if (current.signal.aborted) return;
      cognitiveModes = Array.isArray(data?.modes) ? data.modes : [];
      modeError = '';
    } catch (error) {
      if (!current.signal.aborted) modeError = (error as Error).message;
    } finally {
      if (modeRead === current) {
        modeRead = undefined;
        modeLoading = modeSaving;
      }
    }
  }

  async function changeCognitiveMode(nextMode: ModeDefinition['id']) {
    if (modeLoading) return;
    modeSaving = true;
    modeLoading = true;
    try {
      const res = await apiFetch('/api/cognitive-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode, actor: 'web_ui' }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to update cognitive mode (status ${res.status})`);
      }

      if (closed) return;
      await loadCognitiveModeState();
      if (closed) return;

      // Refresh security policy to update UI controls (operator/yolo toggles, etc.)
      await fetchSecurityPolicy();
      if (closed) return;

      // Trigger status refresh (trust level may have auto-adjusted if coupled)
      statusRefreshTrigger.update(n => n + 1);

      modeMenuOpen = false;
    } catch (error) {
      modeError = (error as Error).message;
    } finally {
      modeSaving = false;
      modeLoading = Boolean(modeRead && !modeRead.signal.aborted);
    }
  }

  async function fetchSystemStatus() {
    systemRead?.abort();
    if (closed) return;
    const current = systemRead = new AbortController();
    try {
      const res = await apiFetch('/api/system-status', { signal: current.signal });
      const data = await res.json();
      if (current.signal.aborted) return;
      if (!res.ok || !data.success) throw new Error(data.error || `Failed to load system status (status ${res.status})`);
      systemStatus = data;
      allowedModes = data.allowedModes || [];
      systemStatusError = '';
    } catch (error) {
      if (!current.signal.aborted) systemStatusError = (error as Error).message;
    }
  }

  async function handleLogout() {
    logoutError = '';
    try {
      const response = await apiFetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Logout failed (status ${response.status})`);
      }
      clearSecurityPolicy();
      currentUserStore.set(null);
      statusStore.set(null);
      window.location.href = '/';
    } catch (err) {
      logoutError = (err as Error).message;
    }
  }

  function toggleUserMenu() {
    userMenuOpen = !userMenuOpen;
  }

  const handleGlobalClick = (event: MouseEvent) => {
    // Close mode menu if clicked outside
    if (modeMenuOpen && modeMenuAnchor && !modeMenuAnchor.contains(event.target as Node)) {
      modeMenuOpen = false;
    }

    // Close user menu if clicked outside
    if (userMenuOpen && userMenuAnchor && !userMenuAnchor.contains(event.target as Node)) {
      userMenuOpen = false;
    }
  };

  // Restore layout preferences and load the authenticated portal state
  onMount(() => {
    closed = false;
    updateScreenSize();

    // On desktop, default to open; on mobile, default to closed
    const defaultLeft = !isMobile;

    const savedLeft = localStorage.getItem('leftSidebarOpen');
    leftSidebarOpen = savedLeft !== null ? savedLeft === 'true' : defaultLeft;

    // Right sidebar: if no saved preference exists, default to open on desktop
    // Store handles persistence; we just set the initial default
    const savedRight = localStorage.getItem('rightSidebarOpen');
    if (savedRight === null && !isMobile) {
      rightSidebarStore.set(true);
    }

    // Load saved right sidebar width
    try {
      const savedWidth = localStorage.getItem('mh-right-sidebar-width');
      if (savedWidth) {
        rightSidebarWidth = Math.max(200, Math.min(600, parseInt(savedWidth, 10) || 280));
      }
    } catch {}

    // Listen for window resize
    window.addEventListener('resize', updateScreenSize);

    // Dynamic viewport height for mobile (fix 100vh issues on iOS/Android)
    const setVH = () => {
      try {
        const vh = window.innerHeight;
        document.documentElement.style.setProperty('--app-vh', `${vh}px`);
      } catch {}
    };
    setVH();
    window.addEventListener('resize', setVH);
    window.addEventListener('orientationchange', setVH);

    const unsubscribeStatus = statusRefreshTrigger.subscribe(() => {
      void loadStatus();
      void loadCognitiveModeState();
    });
    void fetchSystemStatus();
    document.addEventListener('click', handleGlobalClick, true);


    const handleVisibility = () => {
      if (!document.hidden) {
        void loadStatus();
        void fetchSecurityPolicy();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);

    return () => {
      unsubscribeStatus();
      statusRead?.abort();
      modeRead?.abort();
      systemRead?.abort();
      closed = true;
      window.removeEventListener('resize', updateScreenSize);
      window.removeEventListener('resize', setVH);
      window.removeEventListener('orientationchange', setVH);
      document.removeEventListener('click', handleGlobalClick, true);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
      stopRightSidebarResize();
    };
  });

  // Dynamically load FlowEditorLayout when node editor mode is activated
  // This prevents @xyflow/svelte from being bundled into the main client bundle
  $: if ($nodeEditorMode && !FlowEditorLayoutComponent && !flowEditorLoading && !flowEditorError) {
    void loadFlowEditor();
  }

  async function loadFlowEditor() {
    flowEditorLoading = true;
    flowEditorError = '';
    try {
      const module = await import('./flow-editor/FlowEditorLayout.svelte');
      FlowEditorLayoutComponent = module.default;
    } catch (error) {
      flowEditorError = (error as Error).message;
    } finally {
      flowEditorLoading = false;
    }
  }

  // Toggle functions with persistence
  function toggleLeftSidebar() {
    leftSidebarOpen = !leftSidebarOpen;
    localStorage.setItem('leftSidebarOpen', String(leftSidebarOpen));
  }

  function toggleRightSidebar() {
    stopRightSidebarResize();
    rightSidebarStore.update(v => !v);
    // localStorage persistence handled by store subscription in navigation.ts
  }

  // Right sidebar resize handlers
  function startRightSidebarResize(e: MouseEvent | TouchEvent) {
    if (isMobile) return; // Disable resize on mobile
    stopRightSidebarResize();
    resizeUserSelect = document.body.style.userSelect;
    resizeCursor = document.body.style.cursor;
    isResizingRightSidebar = true;
    resizeStartX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    resizeStartWidth = rightSidebarWidth;

    // Prevent text selection during resize
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    // Add global listeners
    document.addEventListener('mousemove', handleRightSidebarResize);
    document.addEventListener('mouseup', stopRightSidebarResize);
    document.addEventListener('touchmove', handleRightSidebarResize);
    document.addEventListener('touchend', stopRightSidebarResize);
    document.addEventListener('touchcancel', stopRightSidebarResize);
    window.addEventListener('blur', stopRightSidebarResize);
  }

  function handleRightSidebarResize(e: MouseEvent | TouchEvent) {
    if (!isResizingRightSidebar) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    // Moving left increases width (negative delta = more width)
    const delta = resizeStartX - clientX;
    const newWidth = Math.max(200, Math.min(600, resizeStartWidth + delta));
    rightSidebarWidth = newWidth;
  }

  function stopRightSidebarResize() {
    if (!isResizingRightSidebar) return;
    isResizingRightSidebar = false;
    document.body.style.userSelect = resizeUserSelect;
    document.body.style.cursor = resizeCursor;

    // Remove global listeners
    document.removeEventListener('mousemove', handleRightSidebarResize);
    document.removeEventListener('mouseup', stopRightSidebarResize);
    document.removeEventListener('touchmove', handleRightSidebarResize);
    document.removeEventListener('touchend', stopRightSidebarResize);
    document.removeEventListener('touchcancel', stopRightSidebarResize);
    window.removeEventListener('blur', stopRightSidebarResize);
    saveRightSidebarWidth();
  }

  function resizeRightSidebarWithKeyboard(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    rightSidebarWidth = Math.max(200, Math.min(600, rightSidebarWidth + (e.key === 'ArrowLeft' ? 20 : -20)));
    saveRightSidebarWidth();
  }

  function saveRightSidebarWidth() {
    // Save preference to localStorage
    try {
      localStorage.setItem('mh-right-sidebar-width', String(rightSidebarWidth));
    } catch {}
  }
</script>

{#if $nodeEditorMode}
  {#if flowEditorLoading}
    <div class="flex items-center justify-center h-screen bg-white dark:bg-slate-950">
      <div class="text-center">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500 mx-auto mb-4"></div>
        <p class="text-gray-600 dark:text-gray-400">Loading Flow Editor...</p>
      </div>
    </div>
  {:else if FlowEditorLayoutComponent}
    <svelte:component this={FlowEditorLayoutComponent} cognitiveMode={cognitiveMode?.id} />
  {:else if flowEditorError}
    <div class="p-6 bg-white dark:bg-slate-950 text-gray-900 dark:text-gray-100 h-screen">
      <p role="alert">Unable to load the Flow Editor: {flowEditorError}</p>
      <button class="underline" on:click={() => window.location.reload()}>Reload page</button>
      <button class="underline ml-4" on:click={() => nodeEditorMode.set(false)}>Return to site</button>
    </div>
  {/if}
{:else}
<div class="flex flex-col app-root w-screen overflow-hidden bg-white dark:bg-slate-950">
  <!-- Header Bar -->
  <header class="flex justify-between items-center px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-xl z-10 flex-shrink-0">
    <div class="flex items-center gap-3">
      <button
        on:click={toggleLeftSidebar}
        class="flex items-center justify-center p-2 border-0 bg-transparent text-gray-500 dark:text-gray-400 cursor-pointer rounded-md transition-all hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-gray-100"
        aria-label="Toggle left sidebar"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
        </svg>
      </button>
      <div class="relative" bind:this={userMenuAnchor}>
        <button
          on:click={toggleUserMenu}
          class="flex items-center gap-2 sm:gap-3 text-lg font-semibold text-gray-900 dark:text-gray-100 m-0 border-0 bg-transparent cursor-pointer p-2 rounded-md transition-all hover:bg-gray-100 dark:hover:bg-white/10"
          aria-label="User menu"
        >
          {#if personaIcon && !personaIconError}
            <img
              src={apiUrl('/api/persona-icon')}
              alt="Persona icon"
              class="persona-icon"
              on:error={() => { personaIconError = true; }}
            />
          {:else}
            <span class="persona-icon-fallback">🤖</span>
          {/if}
          <span class="brand-name hidden sm:inline">{personaName}</span>
          {#if currentUser}
            <span class="text-xs text-gray-500 dark:text-gray-400 font-normal">
              <span class="hidden sm:inline">(</span>{displayUsername}<span class="hidden sm:inline">)</span>
            </span>
          {/if}
        </button>

        {#if userMenuOpen}
          <div class="absolute left-0 mt-2 w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg z-50">
            {#if currentUser}
              <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-semibold">
                    {(currentUser.metadata?.sourceProfile || currentUser.username).charAt(0).toUpperCase()}
                  </div>
                  <div class="flex-1">
                    <div class="font-semibold text-gray-900 dark:text-gray-100">
                      {displayUsername}
                    </div>
                    {#if currentUser.role === 'anonymous' && currentUser.metadata?.sourceProfile}
                      <div class="text-xs text-gray-500">Viewing public profile</div>
                    {/if}
                  </div>
                </div>
              </div>

              <button
                on:click={handleLogout}
                class="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors border-0 bg-transparent cursor-pointer text-left"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                </svg>
                Logout
              </button>
              {#if logoutError}
                <p class="px-4 text-sm text-red-700 dark:text-red-300" role="alert">{logoutError}</p>
              {/if}
            {:else}
              <a
                href="/"
                class="block px-4 py-3 text-sm text-center text-white bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 transition-all font-semibold no-underline"
              >
                Login
              </a>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <div class="flex items-center gap-2 sm:gap-3">
      <div class="relative" bind:this={modeMenuAnchor}>
        <button
          class={`mode-menu-trigger ${modeMenuOpen ? 'active' : ''}`}
          style={`--mode-accent:${modeVisual.color}; --mode-glow:${modeVisual.glow}`}
          on:click={() => { modeMenuOpen = !modeMenuOpen; }}
          aria-haspopup="listbox"
          aria-expanded={modeMenuOpen}
          title={cognitiveMode?.label ?? 'Mode'}
        >
          <span class="mode-dot" style={`background:${modeVisual.color}`}></span>
          <span class="mode-text hidden sm:inline">{modeLoading ? 'Loading…' : cognitiveMode?.label ?? 'Mode unavailable'}</span>
          <svg class="w-4 h-4 text-gray-400 hidden sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
        {#if modeMenuOpen}
          <div class="absolute right-0 mt-2 w-72 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg z-40">
            <div class="py-2">
              {#if cognitiveModes.length === 0}
                <div class="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                  {modeLoading ? 'Loading modes…' : 'No modes available'}
                </div>
              {:else}
                {#each cognitiveModes as mode (mode.id)}
                  {@const isDisabled = allowedModes.length > 0 && !allowedModes.includes(mode.id)}
                  {@const disabledReason = isDisabled ?
                    (systemStatus?.status === 'high_security' ? 'High security mode: Only emulation allowed' :
                     systemStatus?.status === 'wetware_deceased' && mode.id === 'dual' ? 'Wetware deceased: Dual consciousness unavailable' :
                     'This mode is disabled') : null}

                  <button
                    class="w-full text-left px-3 py-2 text-sm transition
                           {cognitiveMode?.id === mode.id ? 'bg-brand/5 border-l-4 border-brand pl-2' : ''}
                           {isDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-brand/10 dark:hover:bg-brand/20'}"
                    on:click={() => !isDisabled && changeCognitiveMode(mode.id)}
                    disabled={modeLoading || isDisabled}
                    title={disabledReason || ''}
                  >
                    <div class="flex items-center gap-2">
                      <span class="h-2 w-2 rounded-full {mode.id === 'dual' ? 'bg-purple-500' : mode.id === 'agent' ? 'bg-blue-500' : 'bg-amber-500'}"></span>
                      <span class="font-medium">{mode.label}</span>
                      {#if isDisabled}
                        <svg class="w-3 h-3 text-gray-400 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                        </svg>
                      {/if}
                    </div>
                    <p class="mt-1 text-xs text-gray-500 dark:text-gray-400 leading-snug">
                      {mode.description}
                      {#if isDisabled}
                        <br><span class="text-amber-600 dark:text-amber-400">{disabledReason}</span>
                      {/if}
                    </p>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {/if}
      </div>
      <a
        href={graphEditorHref()}
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center justify-center p-2 border-0 bg-transparent cursor-pointer rounded-md transition-all text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10"
        aria-label="Open Graph Editor in a new tab"
        title="Open Graph Editor in a new tab"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
        </svg>
      </a>
      <button
        on:click={toggleRightSidebar}
        class="flex items-center justify-center p-2 border-0 bg-transparent text-purple-600 dark:text-purple-400 cursor-pointer rounded-md transition-all hover:bg-gray-100 dark:hover:bg-white/10"
        aria-label="Toggle developer tools"
        title="Developer Tools"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
        </svg>
      </button>
      <ThemeToggle />
    </div>
  </header>

  <!-- Headless Mode Claim Banner -->
  {#if $isOwner}
    <HeadlessClaimBanner />
  {/if}

  {#if modeError}
    <div class="px-4 py-2 text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900/60">
      Cognitive mode error: {modeError}
      <button class="underline ml-2" on:click={loadCognitiveModeState}>Retry cognitive modes</button>
    </div>
  {/if}

  {#if systemStatusError}
    <div class="px-4 py-2 text-sm text-red-700 dark:text-red-300" role="alert">
      {systemStatusError}
      <button class="underline ml-2" on:click={fetchSystemStatus}>Retry system status</button>
    </div>
  {/if}

  {#if systemStatus?.status === 'high_security'}
    <div class="px-4 py-2 text-sm text-red-800 dark:text-red-200 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900/60 flex items-center gap-2">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
      </svg>
      <span>
        <strong>High Security Mode Active:</strong> Only emulation mode is allowed. All write operations are disabled.
      </span>
    </div>
  {:else if systemStatus?.status === 'wetware_deceased'}
    <div class="px-4 py-2 text-sm text-indigo-800 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-950/40 border-b border-indigo-200 dark:border-indigo-900/60 flex items-center gap-2">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <span>
        <strong>Wetware Deceased:</strong> Operating as independent digital consciousness. Dual consciousness mode unavailable.
      </span>
    </div>
  {/if}

  <!-- Main Content Area -->
  <div class="flex flex-1 overflow-hidden relative">
    <!-- Left Sidebar -->
    <aside
      inert={!leftSidebarOpen}
      aria-hidden={!leftSidebarOpen}
      class="flex flex-col border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 overflow-hidden transition-all duration-300 ease-in-out {leftSidebarOpen ? 'w-[280px]' : 'w-0 border-0'} max-md:fixed max-md:left-0 max-md:top-[57px] max-md:bottom-0 max-md:z-30 max-md:shadow-lg"
    >
      <div class="flex flex-col w-[280px] h-full overflow-y-auto overflow-x-hidden">
        <LeftSidebar />
      </div>
    </aside>

    <!-- Backdrop for mobile -->
    {#if leftSidebarOpen && isMobile}
      <button
        type="button"
        class="fixed inset-0 bg-black/50 z-20"
        on:click={toggleLeftSidebar}
        on:keydown={(e) => e.key === 'Escape' && toggleLeftSidebar()}
        aria-label="Close sidebar"
      ></button>
    {/if}

    <!-- Center Chat Area -->
    <main class="flex flex-col flex-1 overflow-hidden bg-white dark:bg-slate-950 relative">
      <CenterContent />
    </main>

    <!-- Right Sidebar (Developer Tools) -->
    {#if rightSidebarOpen && !isMobile}
      <!-- Resize handle -->
      <div
        class="sidebar-resize-handle"
        class:resizing={isResizingRightSidebar}
        on:mousedown={startRightSidebarResize}
        on:touchstart={startRightSidebarResize}
        role="slider"
        aria-orientation="horizontal"
        aria-label="Sidebar width"
        aria-valuemin="200"
        aria-valuemax="600"
        aria-valuenow={rightSidebarWidth}
        tabindex="0"
        on:keydown={resizeRightSidebarWithKeyboard}
      ></div>
    {/if}
    <aside
      inert={!rightSidebarOpen}
      aria-hidden={!rightSidebarOpen}
      class="flex flex-col border-l border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 overflow-hidden transition-all duration-300 ease-in-out max-md:fixed max-md:right-0 max-md:top-[57px] max-md:bottom-0 max-md:z-30 max-md:shadow-lg {rightSidebarOpen ? '' : 'w-0 border-0'}"
      style={rightSidebarOpen && !isMobile ? `width: ${rightSidebarWidth}px` : rightSidebarOpen ? 'width: 280px' : ''}
    >
      <div class="flex flex-col h-full overflow-y-auto overflow-x-hidden" style={!isMobile ? `width: ${rightSidebarWidth}px` : 'width: 280px'}>
        <RightSidebar />
      </div>
    </aside>

    <!-- Backdrop for mobile (right sidebar) -->
    {#if rightSidebarOpen && isMobile}
      <button
        type="button"
        class="fixed inset-0 bg-black/50 z-20"
        on:click={toggleRightSidebar}
        on:keydown={(e) => e.key === 'Escape' && toggleRightSidebar()}
        aria-label="Close sidebar"
      ></button>
    {/if}
  </div>
</div>
{/if}

<style>
  .brand-name {
    @apply font-bold;
    letter-spacing: 0.04em;
  }

  .persona-icon {
    @apply w-7 h-7 rounded-full flex-shrink-0;
  }

  .persona-icon-fallback {
    @apply w-7 h-7 flex items-center justify-center flex-shrink-0;
    font-size: 20px;
  }

  .mode-menu-trigger {
    @apply flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md transition-all cursor-pointer
           bg-transparent;
    color: var(--mode-accent, inherit);
    box-shadow: 0 0 12px rgba(148, 163, 184, 0.15);
  }

  :global(.dark) .mode-menu-trigger {
    @apply border-gray-600;
  }

  .mode-menu-trigger:hover {
    box-shadow: 0 0 20px var(--mode-glow, rgba(124, 58, 237, 0.25));
    border-color: var(--mode-accent, rgba(124, 58, 237, 0.45));
  }

  .mode-menu-trigger.active {
    box-shadow: 0 0 24px var(--mode-glow, rgba(124, 58, 237, 0.35));
    border-color: var(--mode-accent, rgba(124, 58, 237, 0.55));
  }

  .mode-dot {
    @apply inline-flex rounded-full;
    height: 8px;
    width: 8px;
    box-shadow: 0 0 10px var(--mode-accent, rgba(124, 58, 237, 0.5));
  }

  .mode-text {
    @apply font-semibold;
  }

  @media (max-width: 640px) {
    .brand-name {
      display: none;
    }

    .mode-text {
      display: none;
    }

    .mode-menu-trigger {
      @apply px-2 py-2;
    }
  }

  .app-root {
    height: var(--app-vh, 100vh);
    min-height: var(--app-vh, 100vh);
  }

  /* Sidebar scrollbars - custom pseudo-elements that can't be done with Tailwind */

  aside > div::-webkit-scrollbar {
    width: 6px;
  }

  aside > div::-webkit-scrollbar-track {
    background: transparent;
  }

  aside > div::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
  }

  :global(.dark) aside > div::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
  }

  aside > div::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.3);
  }

  :global(.dark) aside > div::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  /* Right sidebar resize handle */

  .sidebar-resize-handle {
    width: 6px;
    cursor: col-resize;
    background: transparent;
    transition: background-color 0.15s ease;
    flex-shrink: 0;
    position: relative;
    z-index: 10;
  }

  .sidebar-resize-handle:hover,
  .sidebar-resize-handle.resizing {
    background: rgb(96 165 250);
    /* blue-400 */
  }

  :global(.dark) .sidebar-resize-handle:hover,
  :global(.dark) .sidebar-resize-handle.resizing {
    background: rgb(59 130 246);
    /* blue-500 */
  }

  .sidebar-resize-handle:focus {
    outline: none;
    background: rgb(96 165 250);
  }

  .sidebar-resize-handle::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 3px;
    height: 40px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  :global(.dark) .sidebar-resize-handle::after {
    background: rgba(255, 255, 255, 0.3);
  }

  .sidebar-resize-handle:hover::after,
  .sidebar-resize-handle.resizing::after {
    opacity: 1;
    background: white;
  }

  :global(.dark) .sidebar-resize-handle:hover::after,
  :global(.dark) .sidebar-resize-handle.resizing::after {
    background: rgba(255, 255, 255, 0.8);
  }
</style>
