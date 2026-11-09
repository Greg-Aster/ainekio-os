<script lang="ts">
  import { getApiBaseUrl } from '../lib/client/api-config';
  import { healthStatus } from '../lib/client/server-health';

  const current = getApiBaseUrl();
</script>

{#if current}
  <!-- Navigating disposes the old machine's views and subscriptions together.
       Work already admitted there remains owned by its Coordinator. -->
  <a href="/?login"
    class="fixed bottom-3 left-3 z-[10010] max-w-[75vw] truncate rounded-full border border-slate-500 bg-slate-900 px-4 py-2 text-xs text-slate-100 shadow-lg"
    title={$healthStatus.error || 'Change backend machine'}>Machine: {current} · {$healthStatus.connected ? 'Reachable' : $healthStatus.error ? 'Unavailable' : 'Connecting'} · Change</a>
{/if}
