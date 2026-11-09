<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';

  interface AuditEntry {
    timestamp: string;
    level: string;
    category: string;
    event?: string;
    message?: string;
    actor?: string;
    details?: unknown;
  }
  interface AuditSummary { total: number; byLevel: Record<string, number>; byCategory: Record<string, number> }

  let date = new Date().toISOString().slice(0, 10);
  let selectedCategory = '';
  let selectedLevel = '';
  let entries: AuditEntry[] = [];
  let summary: AuditSummary | null = null;
  let matched = 0;
  let nextCursor: number | null = null;
  let loading = false;
  let error = '';
  let request: AbortController | undefined;

  async function loadAudit(more = false) {
    request?.abort();
    const current = new AbortController();
    request = current;
    loading = true;
    error = '';
    if (!more) { entries = []; summary = null; nextCursor = null; }
    const query = new URLSearchParams({ date, limit: '100' });
    if (selectedCategory) query.set('category', selectedCategory);
    if (selectedLevel) query.set('level', selectedLevel);
    if (more && nextCursor !== null) query.set('before', String(nextCursor));
    try {
      const response = await apiFetch(`/api/audit?${query}`, { signal: current.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load audit log');
      if (current.signal.aborted) return;
      date = data.date;
      entries = more ? [...entries, ...data.entries] : data.entries;
      nextCursor = data.nextCursor;
      if (data.summary) { summary = data.summary; matched = data.matched; }
    } catch (cause) {
      if (!current.signal.aborted) error = (cause as Error).message;
    } finally { if (request === current) { request = undefined; loading = false; } }
  }

  function getLevelColor(level: string) {
    switch (level) {
      case 'info': return 'text-blue-600 dark:text-blue-400';
      case 'warn': return 'text-yellow-600 dark:text-yellow-400';
      case 'error': return 'text-red-600 dark:text-red-400';
      case 'critical': return 'text-red-800 dark:text-red-200 font-bold';
      default: return 'text-gray-600 dark:text-gray-400';
    }
  }

  function getCategoryColor(category: string) {
    switch (category) {
      case 'system': return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'decision': return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200';
      case 'action': return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'security': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      case 'data': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
    }
  }

  onMount(() => {
    void loadAudit();
    return () => request?.abort();
  });
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold">Audit Log</h2>
    {#if summary}
      <div class="text-sm muted">
        {date} · {matched} matching entries · showing {entries.length}
      </div>
    {/if}
  </div>

  {#if error}
    <div class="card p-6 border-red-500"><p class="text-red-600 dark:text-red-400">{error}</p></div>
  {/if}
  {#if loading && !summary}
    <div class="card p-6 animate-pulse">Loading audit history…</div>
  {/if}
  {#if summary}
    <!-- Summary -->
    <div class="grid gap-3 sm:grid-cols-5 text-sm">
      <div class="card p-3">
        <div class="text-xs muted uppercase">Total</div>
        <div class="text-2xl font-bold mt-1">{summary.total}</div>
      </div>
      <div class="card p-3">
        <div class="text-xs muted uppercase">Info</div>
        <div class="text-2xl font-bold mt-1 text-blue-600">{summary.byLevel.info || 0}</div>
      </div>
      <div class="card p-3">
        <div class="text-xs muted uppercase">Warnings</div>
        <div class="text-2xl font-bold mt-1 text-yellow-600">{summary.byLevel.warn || 0}</div>
      </div>
      <div class="card p-3">
        <div class="text-xs muted uppercase">Errors</div>
        <div class="text-2xl font-bold mt-1 text-red-600">{summary.byLevel.error || 0}</div>
      </div>
      <div class="card p-3">
        <div class="text-xs muted uppercase">Critical</div>
        <div class="text-2xl font-bold mt-1 text-red-800">{summary.byLevel.critical || 0}</div>
      </div>
    </div>
  {/if}

  <!-- Filters -->
  <div class="flex gap-3 flex-wrap">
    <div><label for="audit-date" class="text-xs uppercase muted">Date</label>
      <input id="audit-date" type="date" bind:value={date} on:change={() => loadAudit()}
        class="block mt-1 px-3 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm" />
    </div>
    <div>
      <label for="audit-category" class="text-xs uppercase muted">Category</label>
      <select
        id="audit-category"
        bind:value={selectedCategory}
        on:change={() => loadAudit()}
        class="block mt-1 px-3 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
      >
        <option value="">All</option>
        <option value="system">System</option>
        <option value="decision">Decision</option>
        <option value="action">Action</option>
        <option value="security">Security</option>
        <option value="data">Data</option>
        <option value="agent">Agent</option>
        <option value="data_change">Data change</option>
      </select>
    </div>

    <div>
      <label for="audit-level" class="text-xs uppercase muted">Level</label>
      <select
        id="audit-level"
        bind:value={selectedLevel}
        on:change={() => loadAudit()}
        class="block mt-1 px-3 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
      >
        <option value="">All</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
        <option value="critical">Critical</option>
      </select>
    </div>
  </div>

  <!-- Entries -->
  <div class="space-y-2 max-h-[600px] overflow-y-auto">
    {#each entries as entry}
      <div class="card p-3 text-sm">
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs px-2 py-0.5 rounded-full font-semibold {getCategoryColor(entry.category)}">
                {entry.category}
              </span>
              <span class="text-xs font-mono {getLevelColor(entry.level)}">
                {entry.level.toUpperCase()}
              </span>
              {#if entry.actor}
                <span class="text-xs muted">by {entry.actor}</span>
              {/if}
            </div>
            <div class="font-semibold">{entry.event}</div>
            {#if entry.message}<p>{entry.message}</p>{/if}
            {#if entry.details}
              <details class="mt-2">
                <summary class="cursor-pointer text-xs muted hover:text-brand">Show details</summary>
                <pre class="mt-2 text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded overflow-x-auto">{JSON.stringify(entry.details, null, 2)}</pre>
              </details>
            {/if}
          </div>
          <div class="text-xs muted text-right whitespace-nowrap">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    {/each}
  </div>
  <div class="flex gap-3">
    <button class="btn" disabled={loading} on:click={() => loadAudit()}>Refresh</button>
    {#if nextCursor !== null}
      <button class="btn" disabled={loading} on:click={() => loadAudit(true)}>{loading ? 'Loading…' : 'Load older entries'}</button>
    {/if}
  </div>
</div>
