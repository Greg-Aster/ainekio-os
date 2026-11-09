<script lang="ts">
  import AuthGate from './AuthGate.svelte';
  import BackendConnectionStatus from './BackendConnectionStatus.svelte';
</script>

<BackendConnectionStatus />
<AuthGate>
  {#await import('./ChatLayout.svelte') then { default: ChatLayout }}
    <ChatLayout />
  {/await}
</AuthGate>
