<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import {
    activeView,
    statusStore,
    statusRefreshTrigger,
    yoloModeStore,
    navigationItems,
    rightSidebarOpen,
    rightSidebarTab,
  } from '../stores/navigation';
  import { currentMode, isOwner } from '../stores/security-policy';
  import { apiFetch } from '../lib/client/api-config';
  import SyncStatus from './SyncStatus.svelte';

  function selectView(viewId: string) {
    activeView.set(viewId);
  }

  function openServerStatus() {
    rightSidebarTab.set('servers');
    rightSidebarOpen.set(true);
  }

  // Status data
  let identity: any = null;
  let loading = true;
  let statusError = '';
  let closed = false;
  let facetRead: AbortController | undefined;
  $: yoloMode = $yoloModeStore;

  // Persona facet state
  let activeFacet: string | null = null;
  let facets: Record<string, any> = {};
  let personaFacetTooltip = '';
  let personaFacetError: string | null = null;
  let personaFacetWriteError = '';

  $: personaFacetTooltip = (() => {
    if (personaFacetError) {
      return `Persona configuration error\n\n${personaFacetError}\n\nOpen Persona settings to repair facets.json.`;
    }
    const info = activeFacet ? facets?.[activeFacet] : undefined;
    const currentLabel =
      activeFacet === 'inactive'
        ? 'Persona disabled'
        : info?.name || activeFacet || 'default';

    const lines = [
      'Click to cycle persona facet',
      '',
      `Current: ${currentLabel}`,
    ];

    if (activeFacet === 'inactive') {
      lines.push('Persona context disabled - responses use the base model without identity scaffolding.');
    } else if (info?.description) {
      lines.push(info.description);
    }

    if (info?.resolvedPath) {
      lines.push('');
      lines.push(`Persona file: ${info.resolvedPath}`);
    } else if (activeFacet === 'inactive') {
      lines.push('');
      lines.push('Persona file: (none)');
    }

    lines.push('');
    const progression = Object.keys(facets).filter(key => facets[key]?.enabled !== false);
    if (progression.length) {
      lines.push(`Progression: ${[...progression, progression[0]].join(' → ')}`);
    }
    return lines.join('\n');
  })();

  function subscribeStatus() {
    return statusStore.subscribe((snapshot) => {
      const data = snapshot?.data;
      statusError = snapshot?.error || '';
      loading = !data && !statusError;
      if (data) {
        identity = data.identity;
      }
    });
  }

  async function loadTrustOptions() {
    if (!$isOwner) {
      return;
    }
    try {
      const res = await apiFetch('/api/trust');
      const data = await res.json();
      if (res.ok) {
        if (data.level !== 'adaptive_auto') {
          yoloModeStore.set(false);
          saveChatPrefs();
        }
      }
    } catch (e) {
      console.error('Failed to load trust options:', e);
    }
  }

  async function setTrust(level: string) {
    if (!$isOwner) return;
    try {
      const res = await apiFetch('/api/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to set trust level');
      statusRefreshTrigger.update(n => n + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function cycleTrustLevel() {
    if ($currentMode === 'emulation') {
      alert('Trust level is locked to "observe" in emulation mode for safety.');
      return;
    }

    const trustProgression = ['observe', 'suggest', 'supervised_auto', 'bounded_auto', 'adaptive_auto'];
    const currentTrust = identity?.trustLevel || 'observe';
    const currentYolo = yoloMode;

    if (currentYolo) {
      yoloModeStore.set(false);
      await setTrust('observe');
      saveChatPrefs();
      return;
    }

    const currentIndex = trustProgression.indexOf(currentTrust);

    if (currentIndex === trustProgression.length - 1) {
      try {
        if (!localStorage.getItem('yoloWarned')) {
          alert('YOLO mode relaxes ALL safety checks and allows maximum operator autonomy. Use with extreme caution.');
          localStorage.setItem('yoloWarned', '1');
        }
      } catch {}

      yoloModeStore.set(true);
      saveChatPrefs();
      return;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < trustProgression.length) {
      await setTrust(trustProgression[nextIndex]);
    }
  }

  function saveChatPrefs() {
    try {
      const prefs = localStorage.getItem('chatPrefs');
      const parsed = prefs ? JSON.parse(prefs) : {};
      parsed.yoloMode = get(yoloModeStore);
      localStorage.setItem('chatPrefs', JSON.stringify(parsed));
    } catch {}
  }

  async function loadFacets() {
    facetRead?.abort();
    if (closed) return;
    const current = facetRead = new AbortController();
    try {
      const response = await apiFetch('/api/persona-facet', { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load persona facets (HTTP ${response.status})`);
      }
      if (typeof data.activeFacet !== 'string' || !data.facets || typeof data.facets !== 'object') {
        throw new Error('Persona facet response is incomplete');
      }
      activeFacet = data.activeFacet;
      facets = data.facets;
      personaFacetError = null;
    } catch (error) {
      if (current.signal.aborted) return;
      console.error('Error loading facets:', error);
      activeFacet = null;
      facets = {};
      personaFacetError = (error as Error).message;
    }
  }

  async function cyclePersonaFacet() {
    if (personaFacetError || !activeFacet) return;
    const availableFacets = Object.keys(facets).filter(
      key => facets[key]?.enabled !== false
    );

    if (availableFacets.length === 0) {
      console.warn('No enabled facets available');
      return;
    }

    const currentIndex = availableFacets.indexOf(activeFacet);
    const nextIndex = (currentIndex + 1) % availableFacets.length;
    const nextFacet = availableFacets[nextIndex];
    personaFacetWriteError = '';
    try {
      const response = await apiFetch('/api/persona-facet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facet: nextFacet }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to switch facet');
      activeFacet = result.activeFacet;
      statusRefreshTrigger.update(n => n + 1);
    } catch (error) {
      personaFacetWriteError = (error as Error).message;
    }
  }

  onMount(() => {
    closed = false;
    const unsubscribeStatus = subscribeStatus();
    loadFacets();
    loadTrustOptions();

    return () => {
      closed = true;
      facetRead?.abort();
      unsubscribeStatus();
    };
  });
</script>

<div class="flex flex-col h-full p-4 gap-4">
  <!-- Menu Items -->
  <nav class="menu">
    {#each navigationItems.filter(item => item.id !== 'terminal' || $isOwner) as item}
      <button
        class="menu-item"
        class:active={$activeView === item.id}
        on:click={() => selectView(item.id)}
        title={item.description}
      >
        <span class="menu-icon">{item.icon}</span>
        <div class="menu-text">
          <div class="menu-label">
            {item.label}
          </div>
          {#if item.description}
            <div class="menu-description">{item.description}</div>
          {/if}
        </div>
      </button>
    {/each}
  </nav>

  <!-- Status Widget -->
  <div class="status-widget">
    <div class="widget-header flex items-center justify-between">
      <span>Status</span>
      <SyncStatus compact={true} />
    </div>
    {#if statusError}
      <div class="text-sm text-red-600 dark:text-red-300" role="alert">{statusError}</div>
      <button class="text-sm underline" on:click={() => statusRefreshTrigger.update(value => value + 1)}>Retry status</button>
    {/if}
    {#if loading}
      <div class="text-sm text-gray-500 dark:text-gray-400 text-center py-4">Loading...</div>
    {:else if identity}
      <div class="flex flex-col gap-2">
        <div class="status-row">
          <span class="status-label">Trust:</span>
          <span class="status-value">
            <button
              class="trust-badge clickable trust-level-{yoloMode ? 'yolo' : (identity.trustLevel || 'observe')}"
              title="Click to cycle trust level: {identity.trustLevel || 'observe'}{yoloMode ? ' + YOLO' : ''}\nProgression: observe → suggest → supervised_auto → bounded_auto → adaptive_auto → YOLO"
              on:click={cycleTrustLevel}
            >
              {#if yoloMode}
                <span class="yolo-indicator">YOLO</span>
              {:else}
                {identity.trustLevel || 'observe'}
              {/if}
            </button>
          </span>
        </div>
        <div class="status-row">
          <span class="status-label">Persona:</span>
          <span class="status-value">
            <button
              class="persona-badge persona-facet-{activeFacet || 'error'} clickable"
              title={personaFacetTooltip}
              on:click={cyclePersonaFacet}
              disabled={Boolean(personaFacetError) || !activeFacet}
            >
              {personaFacetError
                ? '⚠ error'
                : activeFacet === 'inactive'
                  ? 'inactive'
                  : (facets[activeFacet || '']?.name || activeFacet || 'loading')}
            </button>
            {#if personaFacetWriteError}
              <span class="block text-xs text-red-600 dark:text-red-300" role="alert">{personaFacetWriteError}</span>
            {/if}
          </span>
        </div>
        <div class="status-row pt-1 border-t border-black/5 dark:border-white/10">
          <span class="status-label">Servers:</span>
          <span class="status-value">
            <button
              type="button"
              class="text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline cursor-pointer bg-transparent border-0 p-0"
              on:click={openServerStatus}
              title="Open Server Status & Placement Controls in Right Sidebar"
            >
              Placement & Routing →
            </button>
          </span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="sidebar-footer">
    <div class="footer-text">
      Ainekio OS
    </div>
  </div>
</div>

<style>
  .menu {
    @apply flex flex-col gap-1;
  }

  .menu-item {
    @apply flex items-center gap-3 px-3 py-3 border-0 bg-transparent rounded-lg cursor-pointer transition-all
           text-left w-full;
  }

  .menu-item:hover {
    @apply bg-black/5;
  }

  :global(.dark) .menu-item:hover {
    @apply bg-white/5;
  }

  .menu-item.active {
    @apply bg-violet-600 text-white;
  }

  :global(.dark) .menu-item.active {
    @apply bg-violet-400 text-gray-900;
  }

  .menu-icon {
    @apply text-xl flex-shrink-0;
  }

  .menu-text {
    @apply flex flex-col gap-0.5 min-w-0;
  }

  .menu-label {
    @apply font-medium text-sm text-gray-900;
  }

  :global(.dark) .menu-label {
    @apply text-gray-100;
  }

  .menu-item.active .menu-label {
    @apply text-white;
  }

  :global(.dark) .menu-item.active .menu-label {
    @apply text-gray-900;
  }

  .menu-description {
    @apply text-xs text-gray-500 whitespace-nowrap overflow-hidden text-ellipsis;
  }

  :global(.dark) .menu-description {
    @apply text-gray-400;
  }

  .menu-item.active .menu-description {
    @apply text-white/80;
  }

  :global(.dark) .menu-item.active .menu-description {
    @apply text-gray-900/70;
  }

  .status-widget {
    @apply mt-auto p-4 rounded-lg border border-black/10 bg-white/50;
  }

  :global(.dark) .status-widget {
    @apply border-white/10 bg-white/5;
  }

  .widget-header {
    @apply font-semibold text-xs uppercase tracking-wide text-gray-500 mb-3;
  }

  :global(.dark) .widget-header {
    @apply text-gray-400;
  }

  .status-row {
    @apply flex items-center justify-between text-sm gap-2;
  }

  .status-label {
    @apply text-gray-500 font-medium;
  }

  :global(.dark) .status-label {
    @apply text-gray-400;
  }

  .status-value {
    @apply text-gray-900 font-semibold flex items-center gap-1.5 text-right;
  }

  :global(.dark) .status-value {
    @apply text-gray-100;
  }

  .trust-badge {
    @apply py-0.5 px-2 rounded-full text-[0.65rem] font-semibold lowercase border border-transparent
           cursor-default transition-all;
  }

  .trust-badge.clickable {
    @apply cursor-pointer hover:scale-105;
  }

  .trust-badge.trust-level-observe {
    @apply bg-cyan-500/15 text-cyan-700;
  }

  :global(.dark) .trust-badge.trust-level-observe {
    @apply bg-cyan-400/20 text-cyan-300;
  }

  .trust-badge.trust-level-observe:hover {
    @apply bg-cyan-500/25;
  }

  :global(.dark) .trust-badge.trust-level-observe:hover {
    @apply bg-cyan-400/30;
  }

  .trust-badge.trust-level-suggest {
    @apply bg-green-500/15 text-green-700;
  }

  :global(.dark) .trust-badge.trust-level-suggest {
    @apply bg-green-400/20 text-green-300;
  }

  .trust-badge.trust-level-suggest:hover {
    @apply bg-green-500/25;
  }

  :global(.dark) .trust-badge.trust-level-suggest:hover {
    @apply bg-green-400/30;
  }

  .trust-badge.trust-level-supervised_auto {
    @apply bg-lime-500/15 text-lime-700;
  }

  :global(.dark) .trust-badge.trust-level-supervised_auto {
    @apply bg-lime-400/20 text-lime-300;
  }

  .trust-badge.trust-level-supervised_auto:hover {
    @apply bg-lime-500/25;
  }

  :global(.dark) .trust-badge.trust-level-supervised_auto:hover {
    @apply bg-lime-400/30;
  }

  .trust-badge.trust-level-bounded_auto {
    @apply bg-orange-500/15 text-orange-700;
  }

  :global(.dark) .trust-badge.trust-level-bounded_auto {
    @apply bg-orange-400/20 text-orange-300;
  }

  .trust-badge.trust-level-bounded_auto:hover {
    @apply bg-orange-500/25;
  }

  :global(.dark) .trust-badge.trust-level-bounded_auto:hover {
    @apply bg-orange-400/30;
  }

  .trust-badge.trust-level-adaptive_auto {
    @apply bg-red-500/15 text-red-700;
  }

  :global(.dark) .trust-badge.trust-level-adaptive_auto {
    @apply bg-red-400/20 text-red-300;
  }

  .trust-badge.trust-level-adaptive_auto:hover {
    @apply bg-red-500/25;
  }

  :global(.dark) .trust-badge.trust-level-adaptive_auto:hover {
    @apply bg-red-400/30;
  }

  .trust-badge.trust-level-yolo {
    @apply bg-yellow-500/25 text-yellow-700 border-yellow-500;
    box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.2);
  }

  :global(.dark) .trust-badge.trust-level-yolo {
    @apply bg-yellow-400/30 text-yellow-300 border-yellow-400;
  }

  .trust-badge.trust-level-yolo:hover {
    @apply bg-yellow-500/35;
  }

  :global(.dark) .trust-badge.trust-level-yolo:hover {
    @apply bg-yellow-400/40;
  }

  .yolo-indicator {
    @apply uppercase font-bold tracking-wider;
  }

  .persona-badge {
    @apply py-0.5 px-2 rounded-full text-[0.65rem] font-semibold lowercase border border-transparent
           transition-all;
  }

  .persona-badge.clickable {
    @apply cursor-pointer;
  }

  .persona-badge.persona-facet-inactive {
    @apply bg-gray-500/15 text-gray-600;
  }

  :global(.dark) .persona-badge.persona-facet-inactive {
    @apply bg-gray-400/20 text-gray-400;
  }

  .persona-badge.persona-facet-error {
    @apply text-red-700 border-red-500/40;
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.22), rgba(248, 113, 113, 0.16));
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.2);
    cursor: not-allowed;
  }

  :global(.dark) .persona-badge.persona-facet-error {
    @apply text-red-300 border-red-400/50;
  }

  .persona-badge.persona-facet-default {
    @apply text-violet-700 border-violet-500/30;
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(168, 85, 247, 0.15));
    box-shadow: 0 0 8px rgba(139, 92, 246, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-default {
    @apply text-violet-300 border-violet-400/40;
  }

  .persona-badge.persona-facet-poet {
    @apply text-indigo-700 border-indigo-500/30;
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(129, 140, 248, 0.15));
    box-shadow: 0 0 8px rgba(99, 102, 241, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-poet {
    @apply text-indigo-300 border-indigo-400/40;
  }

  .persona-badge.persona-facet-thinker {
    @apply text-blue-700 border-blue-500/30;
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(96, 165, 250, 0.15));
    box-shadow: 0 0 8px rgba(59, 130, 246, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-thinker {
    @apply text-blue-300 border-blue-400/40;
  }

  .persona-badge.persona-facet-friend {
    @apply text-green-700 border-green-500/30;
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(74, 222, 128, 0.15));
    box-shadow: 0 0 8px rgba(34, 197, 94, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-friend {
    @apply text-green-300 border-green-400/40;
  }

  .persona-badge.persona-facet-antagonist {
    @apply text-red-700 border-red-500/30;
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(248, 113, 113, 0.15));
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.15);
  }

  :global(.dark) .persona-badge.persona-facet-antagonist {
    @apply text-red-300 border-red-400/40;
  }

  .sidebar-footer {
    @apply py-3 border-t border-black/10 mt-auto;
  }

  :global(.dark) .sidebar-footer {
    @apply border-white/10;
  }

  .footer-text {
    @apply text-xs text-gray-500 text-center flex flex-col gap-1;
  }

  :global(.dark) .footer-text {
    @apply text-gray-400;
  }
</style>
