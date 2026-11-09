<script lang="ts">
  import { isMobileApp } from '../lib/client/api-config';
  import { activeView, statusStore, systemSection } from '../stores/navigation';

  const isMobile = isMobileApp();
  let dismissed = false;

  function openNetworkSettings() {
    systemSection.set('network');
    activeView.set('system');
    dismissed = true;
  }
</script>

{#if !isMobile && !dismissed && $statusStore?.data?.runtime?.headless}
  <div class="fixed top-20 left-1/2 -translate-x-1/2 z-[1000] max-w-[600px] w-[90%] bg-gradient-to-br from-amber-400 to-amber-500 text-amber-900 p-6 rounded-xl shadow-2xl animate-slide-down sm:top-[60px] sm:w-[95%] sm:p-4">
    <div class="flex items-start gap-4 sm:flex-col">
      <div class="text-3xl shrink-0">🖥️</div>
      <div class="flex-1">
        <h3 class="m-0 mb-2 text-lg font-bold text-amber-900">Headless Mode Active</h3>
        <p class="m-0 text-sm leading-relaxed text-amber-800">
          Boot-managed agents are skipped when the system starts in headless mode.
          Changing this setting does not stop or resume running agents.
        </p>
      </div>
      <div class="flex flex-col gap-2 shrink-0 sm:w-full">
        <button
          class="px-4 py-2 rounded-md border-0 font-semibold text-sm cursor-pointer transition-all whitespace-nowrap bg-amber-900 text-amber-100 hover:bg-amber-800 disabled:opacity-60 disabled:cursor-not-allowed sm:w-full"
          on:click={openNetworkSettings}
        >
          Open Network Settings
        </button>
        <button
          class="px-4 py-2 rounded-md font-semibold text-sm cursor-pointer transition-all whitespace-nowrap bg-transparent text-amber-900 border border-amber-800 hover:bg-amber-800/10 disabled:opacity-60 disabled:cursor-not-allowed sm:w-full"
          on:click={() => dismissed = true}
        >
          Dismiss
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .animate-slide-down {
    animation: slide-down 0.3s ease-out;
  }

  @keyframes slide-down {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-20px);
    }

    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
</style>
