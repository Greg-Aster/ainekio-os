<script lang="ts">
  import AgentMonitor from './AgentMonitor.svelte';
  import QueuePanel from './QueuePanel.svelte';
  import ServerStatus from './ServerStatus.svelte';
  import { rightSidebarOpen, rightSidebarTab, rightSidebarSection } from '../stores/navigation';
  import type { RightSidebarTab } from '../stores/navigation';
  import { isOwner } from '../stores/security-policy';

  $: if (!$isOwner && $rightSidebarTab === 'monitor') {
    rightSidebarSection.set(null);
    rightSidebarTab.set('queue');
  }

  interface Tab {
    id: RightSidebarTab;
    label: string;
    icon: string;
  }

  $: tabs = [
    { id: 'queue', label: 'Queue', icon: '☷' },
    ...($isOwner ? [{ id: 'monitor', label: 'Agent Monitor', icon: '🤖' }] : []),
    { id: 'servers', label: 'Server Status', icon: '🖥️' },
  ] as Tab[];
</script>

<div class="flex flex-col h-full overflow-hidden">
  <!-- Tab Navigation -->
  <div class="flex border-b border-black/10 dark:border-white/10 shrink-0">
    {#each tabs as tab}
      <button
        class="flex-1 flex flex-col items-center gap-1 py-3 px-2 border-0 bg-transparent cursor-pointer transition-all border-b-2 border-transparent hover:bg-black/5 dark:hover:bg-white/5
               {$rightSidebarTab === tab.id ? 'border-b-violet-600 dark:border-b-violet-400 bg-violet-600/5 dark:bg-violet-400/5' : ''}"
        on:click={() => { rightSidebarSection.set(null); rightSidebarTab.set(tab.id); }}
      >
        <span class="text-xl">{tab.icon}</span>
        <span class="text-[0.7rem] font-medium {$rightSidebarTab === tab.id ? 'text-violet-600 dark:text-violet-400' : 'text-gray-500 dark:text-gray-400'}">{tab.label}</span>
      </button>
    {/each}
  </div>

  <!-- Tab Content -->
  <div class="flex-1 overflow-y-auto overflow-x-hidden">
    {#if $rightSidebarOpen}
      {#if $rightSidebarTab === 'monitor'}
        <div class="p-3 h-full overflow-hidden flex flex-col gap-4">
          <AgentMonitor />
        </div>
      {:else if $rightSidebarTab === 'queue'}
        <div class="h-full overflow-hidden">
          <QueuePanel />
        </div>
      {:else if $rightSidebarTab === 'servers'}
        <div class="h-full overflow-hidden">
          <ServerStatus />
        </div>
      {/if}
    {/if}
  </div>
</div>
