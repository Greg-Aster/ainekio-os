<script lang="ts">
  import { onMount } from 'svelte';
  import { apiEventSource } from '../lib/client/api-config';
  import type { EnvironmentBridgeDiagnosticsSnapshot } from '../lib/client/environment-bridge-diagnostics-types';

  let diagnostics: EnvironmentBridgeDiagnosticsSnapshot | undefined;
  let readiness = '';
  let detail = '';
  let error = '';
  let enabled = true;
  let received = false;
  $: active = diagnostics?.connections?.find(connection => connection.active);
  $: session = diagnostics?.sessions?.find(value => value.sessionId === active?.sessionId);
  $: audioFailure = session?.lastTranscriptionStatus === 'failed'
    ? session.recentEvents.slice().reverse().find(event => event.kind === 'audio.transcription' && event.status === 'failed')?.message
      || 'Robot speech could not be delivered.' : '';
  $: ready = readiness === 'ready' && active?.ready === true && !error;

  onMount(() => {
    const stream = apiEventSource('/api/monitor/stream');
    stream.onmessage = event => {
      try {
        const snapshot = JSON.parse(event.data);
        if (snapshot.type === 'error') { error = snapshot.error || 'Robot connection status is unavailable.'; return; }
        if (snapshot.type !== 'snapshot') return;
        received = true;
        const panel = snapshot.agentData?.['environment-bridge'];
        enabled = Boolean(panel?.variables?.some((variable: {key: string; value: unknown}) => variable.key === 'enabled' && variable.value));
        diagnostics = panel?.diagnostics;
        readiness = panel?.readiness || '';
        detail = panel?.latestTask || 'Environment Bridge is not configured.';
        error = '';
      } catch { error = 'Robot connection status could not be read.'; }
    };
    stream.onerror = () => { error = 'Robot connection status is unavailable; reconnecting to MetaHuman.'; };
    return () => stream.close();
  });
</script>

<div class="mx-3 my-2 rounded border px-3 py-2 text-xs {ready && !audioFailure ? 'border-gray-300 dark:border-gray-700' : 'border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100'}" role={ready && !audioFailure ? 'status' : 'alert'}>
  {#if error}
    <strong>{error}</strong>
  {:else if !received}
    <span>Checking robot connection…</span>
  {:else if !enabled}
    <span>Robot bridge disabled. {detail}</span>
  {:else if !ready}
    <strong>Robot voice is disconnected.</strong> {detail}
    {#each diagnostics?.connections || [] as connection}
      {#if connection.error}<div>{connection.endpoint}: {connection.error}</div>{/if}
    {/each}
  {:else}
    <span>Robot connected · {active?.robotId} · {active?.endpoint}</span>
    {#if audioFailure}<div><strong>Voice delivery failed:</strong> {audioFailure}</div>
    {:else if session?.lastTranscriptionStatus === 'transcribing'}<span> · Transcribing speech…</span>{/if}
  {/if}
</div>
