<script lang="ts">
  import { onMount } from 'svelte';
  import { derived, get } from 'svelte/store';
  import { apiFetch } from '../lib/client/api-config';
  import { isOwner } from '../stores/security-policy';
  import { currentUserStore } from '../stores/navigation';
  import { coordinatorSnapshot, coordinatorConnection, coordinatorError, useWorkCoordinator } from '../lib/stores/work-coordinator';

  interface PendingDesire {
    id: string;
    title: string;
    description: string;
    reason?: string;
    source: string;
    status: string;
    risk?: string;
    strength: number;
    createdAt: string;
    reinforcements?: number;
    metrics?: { cycleCount?: number };
    plan?: { estimatedRisk?: string; steps: { action: string; risk?: string }[] };
  }
  type Decision = 'approve' | 'reject';

  let pendingDesires: PendingDesire[] = [];
  let processingId: string | null = null;
  let loadError = '';
  let actionError = '';
  let expanded = false;
  let expandedDesireId: string | null = null;
  let observation = new AbortController();
  let listRead: AbortController | null = null;
  $: error = actionError || loadError || $coordinatorError
    || ($coordinatorConnection === 'reconnecting' ? 'Desire approval updates disconnected. Reconnecting…' : '');

  const SOURCE_LABELS: Record<string, string> = {
    persona_goal: '🎯 Persona Goal', urgent_task: '🔥 Urgent Task', task: '📋 Task',
    memory_pattern: '🧠 Memory Pattern', curiosity: '❓ Curiosity', reflection: '💭 Reflection',
    dream: '🌙 Dream', tool_suggestion: '🔧 Tool Suggestion',
  };

  function getRiskColor(risk?: string): string {
    if (risk === 'none' || risk === 'low') return 'bg-green-500/20 text-green-400';
    if (risk === 'medium') return 'bg-yellow-500/20 text-yellow-300';
    if (risk === 'high' || risk === 'critical') return 'bg-red-500/20 text-red-400';
    return 'bg-white/10 text-slate-400';
  }

  function formatStrength(strength: number): string {
    return `${Math.round(strength * 100)}%`;
  }

  function formatDate(iso: string): string {
    const date = new Date(iso);
    const diffMins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    return diffHours < 24 ? `${diffHours}h ago` : date.toLocaleDateString();
  }

  function toggleDesireExpand(id: string) {
    expandedDesireId = expandedDesireId === id ? null : id;
  }

  async function loadPendingDesires(signal: AbortSignal) {
    if (signal.aborted) return;
    listRead?.abort();
    const read = new AbortController();
    listRead = read;
    const abort = () => read.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await apiFetch('/api/agency/desires?status=awaiting_approval', { signal: read.signal });
      const data = await response.json();
      if (read.signal.aborted) return;
      if (!response.ok || !Array.isArray(data.desires)) throw new Error(data.error || `Unable to load Desire approvals (${response.status})`);
      pendingDesires = data.desires.filter((desire: PendingDesire) => desire.status === 'awaiting_approval');
      if (!pendingDesires.some(desire => desire.id === expandedDesireId)) expandedDesireId = null;
      loadError = '';
    } catch (error) {
      if (!read.signal.aborted) loadError = (error as Error).message;
    } finally {
      signal.removeEventListener('abort', abort);
      if (listRead === read) listRead = null;
    }
  }

  async function decideDesire(id: string, decision: Decision) {
    const response = await apiFetch(`/api/agency/desires/${encodeURIComponent(id)}/${decision}`, {
      method: 'POST',
      ...(decision === 'reject' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'User rejected' }) } : {}),
    });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.error || `Failed to ${decision} desire`);
  }

  async function handleDecision(id: string, decision: Decision, event?: Event) {
    event?.stopPropagation();
    if (!$isOwner || processingId || observation.signal.aborted) return;
    const signal = observation.signal;
    processingId = id;
    actionError = '';
    try {
      await decideDesire(id, decision);
    } catch (error) {
      if (!signal.aborted) actionError = (error as Error).message;
    } finally {
      if (!signal.aborted) processingId = null;
    }
  }

  async function handleApproveAll() {
    if (!$isOwner || processingId || observation.signal.aborted) return;
    const signal = observation.signal;
    const username = get(currentUserStore)?.username;
    processingId = 'all';
    actionError = '';
    const failures: string[] = [];
    try {
      for (const desire of [...pendingDesires]) {
        if (get(currentUserStore)?.username !== username || !get(isOwner)) return;
        try { await decideDesire(desire.id, 'approve'); }
        catch (error) { if (!signal.aborted) failures.push(`${desire.title}: ${(error as Error).message}`); }
      }
      if (!signal.aborted) actionError = failures.join('\n');
    } finally {
      if (!signal.aborted) processingId = null;
    }
  }

  onMount(() => {
    let release: (() => void) | undefined;
    const unsubscribeProfile = derived([isOwner, currentUserStore], ([$owner, $user]) =>
      $owner ? $user?.username ?? null : null).subscribe(username => {
      release?.();
      release = undefined;
      observation.abort();
      listRead?.abort();
      observation = new AbortController();
      pendingDesires = [];
      processingId = null;
      loadError = '';
      actionError = '';
      expanded = false;
      expandedDesireId = null;
      if (!username) { observation.abort(); return; }
      const signal = observation.signal;
      let revision = get(coordinatorSnapshot)?.agencyChange?.revision;
      let reconnecting = false;
      const unsubscribeSnapshot = coordinatorSnapshot.subscribe(snapshot => {
        const change = snapshot?.agencyChange;
        if (change && change.revision !== revision) {
          revision = change.revision;
          void loadPendingDesires(signal);
        }
      });
      const unsubscribeConnection = coordinatorConnection.subscribe(state => {
        if (state === 'reconnecting') reconnecting = true;
        else if (state === 'live' && reconnecting) { reconnecting = false; void loadPendingDesires(signal); }
      });
      const releaseCoordinator = useWorkCoordinator();
      release = () => { unsubscribeSnapshot(); unsubscribeConnection(); releaseCoordinator(); };
      void loadPendingDesires(signal);
    });
    return () => {
      unsubscribeProfile();
      release?.();
      observation.abort();
      listRead?.abort();
    };
  });
</script>

{#if $isOwner && error}
  <div role="alert" class="mx-3 my-2 rounded border border-red-500/30 bg-red-500/20 px-3 py-2 text-xs text-red-300 whitespace-pre-line">{error}</div>
{/if}

{#if $isOwner && pendingDesires.length > 0}
  <div class="bg-gradient-to-r from-blue-500/15 to-blue-500/5 border border-blue-500/30 rounded-lg mx-3 my-2 overflow-hidden">
    <!-- Compact Header -->
    <div class="flex items-center gap-1.5 px-3 py-2 text-[13px]">
      <span class="animate-pulse">⚡</span>
      <span class="font-bold text-blue-400">{pendingDesires.length}</span>
      <span class="text-slate-400 flex-1">approval{pendingDesires.length !== 1 ? 's' : ''} needed</span>

      <div class="flex gap-1">
        <button
          class="px-2 py-1 rounded text-xs cursor-pointer transition-all bg-green-500 text-white hover:bg-green-600"
          disabled={processingId !== null}
          on:click={handleApproveAll}
          title="Approve all"
        >
          ✓ All
        </button>
        <button
          class="px-2 py-1 rounded text-xs cursor-pointer transition-all bg-white/10 text-slate-400 hover:bg-white/20"
          aria-label="Review pending Desire approvals"
          aria-expanded={expanded}
          on:click={() => expanded = !expanded}
        >
          {expanded ? '▼' : '▲'}
        </button>
      </div>
    </div>

    <!-- Expanded List -->
    {#if expanded}
      <div class="border-t border-white/10 max-h-[350px] overflow-y-auto">
        {#each pendingDesires as desire (desire.id)}
          {@const risk = desire.plan?.estimatedRisk ?? desire.risk}
          <div class="border-b border-white/5 last:border-b-0">
            <!-- Collapsed Row -->
            <div
              class="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors {expandedDesireId === desire.id ? 'bg-blue-500/10' : 'hover:bg-white/5'}"
              on:click={() => toggleDesireExpand(desire.id)}
              on:keydown={(e) => e.key === 'Enter' && toggleDesireExpand(desire.id)}
              role="button"
              tabindex="0"
              aria-expanded={expandedDesireId === desire.id}
            >
              <span class="text-[10px] text-slate-500 w-3">{expandedDesireId === desire.id ? '▼' : '▶'}</span>
              <span class="flex-1 text-xs text-slate-200 whitespace-nowrap overflow-hidden text-ellipsis">{desire.title}</span>
              <span class="text-[10px] text-slate-500 whitespace-nowrap">{SOURCE_LABELS[desire.source] || desire.source}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded font-medium {getRiskColor(risk)}">
                {risk ?? 'Unknown'}
              </span>
              <button
                class="w-6 h-6 rounded border-none cursor-pointer text-xs transition-all bg-green-500/20 text-green-400 hover:bg-green-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={processingId !== null}
                aria-label={`Approve ${desire.title}`}
                on:click={(e) => handleDecision(desire.id, 'approve', e)}
              >✓</button>
              <button
                class="w-6 h-6 rounded border-none cursor-pointer text-xs transition-all bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={processingId !== null}
                aria-label={`Reject ${desire.title}`}
                on:click={(e) => handleDecision(desire.id, 'reject', e)}
              >✗</button>
            </div>

            <!-- Expanded Details -->
            {#if expandedDesireId === desire.id}
              <div class="px-4 py-3 bg-black/20 border-t border-blue-500/20">
                <!-- Description -->
                <div class="mb-3">
                  <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">What</div>
                  <div class="text-[13px] text-slate-200 leading-relaxed">{desire.description}</div>
                </div>

                <!-- Reason -->
                {#if desire.reason}
                  <div class="mb-3">
                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Why</div>
                    <div class="text-[13px] text-slate-200 leading-relaxed">{desire.reason}</div>
                  </div>
                {/if}

                <!-- Metrics Row -->
                <div class="flex gap-4 mb-3 flex-wrap">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-[10px] text-slate-500">Strength</span>
                    <span class="text-[13px] font-semibold text-blue-400">{formatStrength(desire.strength)}</span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    <span class="text-[10px] text-slate-500">Created</span>
                    <span class="text-[13px] font-semibold text-slate-200">{formatDate(desire.createdAt)}</span>
                  </div>
                  <div class="flex flex-col gap-0.5">
                    <span class="text-[10px] text-slate-500">Reinforced</span>
                    <span class="text-[13px] font-semibold text-slate-200">{desire.reinforcements || 0}x</span>
                  </div>
                  {#if desire.metrics?.cycleCount && desire.metrics.cycleCount > 0}
                    <div class="flex flex-col gap-0.5">
                      <span class="text-[10px] text-slate-500">Cycles</span>
                      <span class="text-[13px] font-semibold text-slate-200">{desire.metrics.cycleCount}</span>
                    </div>
                  {/if}
                </div>

                <!-- Plan Steps -->
                {#if desire.plan && desire.plan.steps.length > 0}
                  <div class="mb-3">
                    <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Plan ({desire.plan.steps.length} steps)</div>
                    <div class="flex flex-col gap-1">
                      {#each desire.plan.steps as step, i}
                        <div class="flex items-center gap-2 px-2 py-1 bg-white/[0.03] rounded text-xs">
                          <span class="w-[18px] h-[18px] flex items-center justify-center bg-blue-500/20 text-blue-400 rounded-full text-[10px] font-semibold">{i + 1}</span>
                          <span class="flex-1 text-slate-300">{step.action}</span>
                          {#if step.risk && step.risk !== 'none'}
                            <span class="text-[9px] px-1 py-0.5 rounded {getRiskColor(step.risk)}">{step.risk}</span>
                          {/if}
                        </div>
                      {/each}

                    </div>
                  </div>
                {/if}

                <!-- Action Buttons -->
                <div class="flex gap-2">
                  <button
                    class="flex-1 px-4 py-2.5 rounded-md border-none text-[13px] font-medium cursor-pointer transition-all bg-green-500 text-white hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={processingId !== null}
                    on:click={(e) => handleDecision(desire.id, 'approve', e)}
                  >
                    {processingId === desire.id ? 'Processing…' : '✓ Approve & Execute'}
                  </button>
                  <button
                    class="flex-1 px-4 py-2.5 rounded-md text-[13px] font-medium cursor-pointer transition-all bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={processingId !== null}
                    on:click={(e) => handleDecision(desire.id, 'reject', e)}
                  >
                    {processingId === desire.id ? 'Processing…' : '✗ Reject'}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

  </div>
{/if}
