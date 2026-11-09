<script lang="ts">
  import { onMount } from 'svelte';
  import {
    agentCatalogError,
    agentCatalogSnapshot,
    useAgentCatalog,
    type AgentCatalogItem,
  } from '../lib/stores/agent-catalog';
  import { openAgentCatalogSettings } from '../stores/navigation';

  let search = '';
  onMount(useAgentCatalog);

  const summaries = [
    ['All agents', 'total'], ['Installed', 'installed'], ['Triggers', 'triggerRegistered'],
    ['Services', 'services'], ['Available', 'available'], ['Problems', 'missingSource'],
  ] as const;

  $: query = search.trim().toLowerCase();
  $: agents = ($agentCatalogSnapshot?.agents || []).filter(agent => !query
    || [agent.id, agent.displayName, agent.description, agent.owner, ...agent.tags]
      .some(value => value.toLowerCase().includes(query)));

  function statusClass(agent: AgentCatalogItem): string {
    if (agent.health === 'missing-source') return 'bg-red-500';
    if (agent.health === 'disabled') return 'bg-gray-400';
    if (agent.health === 'available') return 'bg-blue-500';
    return 'bg-emerald-500';
  }
</script>

<div class="h-full overflow-y-auto p-5">
  <header class="mb-5 flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 class="text-xl font-semibold">Agent Catalog</h2>
      <p class="mt-1 text-sm text-gray-500">Live inventory across installed source, Trigger Manager, workflow ownership, and persistent services.</p>
    </div>
    <button class="rounded border border-violet-500 px-3 py-2 text-sm text-violet-700 dark:text-violet-300" on:click={openAgentCatalogSettings}>Manage catalog</button>
  </header>

  {#if $agentCatalogError}<div class="mb-4 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{$agentCatalogError}</div>{/if}
  {#if !$agentCatalogSnapshot}
    {#if !$agentCatalogError}<div class="py-12 text-center text-gray-500">Loading Agent Catalog…</div>{/if}
  {:else}
    <section class="mb-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {#each summaries as [label, key]}
        <div class="rounded border p-3 dark:border-gray-800"><div class="text-xs text-gray-500">{label}</div><div class="text-xl font-semibold">{$agentCatalogSnapshot.counts[key]}</div></div>
      {/each}
    </section>

    <input class="form-input mb-4 w-full" placeholder="Filter the complete agent inventory" bind:value={search} />
    <section class="overflow-x-auto rounded border border-gray-200 dark:border-gray-800">
      <div class="grid min-w-[46rem] grid-cols-[minmax(13rem,1.2fr)_minmax(10rem,0.8fr)_minmax(11rem,1fr)_7rem] gap-3 border-b bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500 dark:border-gray-800 dark:bg-gray-900">
        <div>Agent</div><div>Owner</div><div>Implementation</div><div>State</div>
      </div>
      <div class="min-w-[46rem] divide-y divide-gray-200 dark:divide-gray-800">
        {#each agents as agent (agent.id)}
          <div class="grid grid-cols-[minmax(13rem,1.2fr)_minmax(10rem,0.8fr)_minmax(11rem,1fr)_7rem] gap-3 px-3 py-3 text-sm">
            <div class="min-w-0"><div class="font-medium">{agent.displayName}</div><div class="truncate text-xs text-gray-500">{agent.id} · {agent.description}</div></div>
            <div><div class="capitalize">{agent.owner.replace('-', ' ')}</div>{#if agent.parentIds.length}<div class="text-xs text-gray-500">via {agent.parentIds.join(', ')}</div>{/if}</div>
            <div class="min-w-0"><div class="truncate text-xs">{agent.sourcePath || agent.handler}</div><div class="text-xs text-gray-500">{agent.usesLLM ? 'uses LLM' : 'local'} · {agent.risk}</div></div>
            <div class="flex items-center gap-2 text-xs capitalize"><span class="h-2 w-2 rounded-full {statusClass(agent)}"></span>{agent.health}</div>
          </div>
        {:else}
          <div class="px-3 py-6 text-center text-sm text-gray-500">No agents match the current filter.</div>
        {/each}
      </div>
    </section>
  {/if}
</div>
