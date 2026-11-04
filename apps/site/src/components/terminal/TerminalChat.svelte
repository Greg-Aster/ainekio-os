<script lang="ts">
  import { onMount } from 'svelte';
  import type { TerminalEvent, TerminalSession } from '@metahuman/core/terminal/types';
  import { TerminalController } from './controller';

  let controller: TerminalController;
  let session: TerminalSession | undefined;
  let transcript = '';
  let error = '';
  let busy = false;
  let mounted = false;
  export let running = false;
  $: running = session?.phase === 'running';

  function receive(event: TerminalEvent) {
    if (event.type === 'error') error = event.error;
    else if (event.type === 'state') session = event.state.sessions.find(item => item.id === controller.selected);
    else if (event.id === controller.selected && event.text !== undefined) {
      transcript = event.text;
      error = '';
    }
  }
  async function action(work: () => Promise<void>) {
    busy = true; error = '';
    try { await work(); }
    catch (cause) { if (mounted && (cause as Error).name !== 'AbortError') error = (cause as Error).message; throw cause; }
    finally { busy = false; }
  }
  export async function send(message: string): Promise<void> {
    if (!controller) throw new Error('Terminal chat is still loading.');
    await action(() => controller.send(message));
  }
  export async function close(): Promise<void> {
    await action(() => controller.close());
  }
  onMount(() => {
    mounted = true;
    controller = new TerminalController(receive, message => { error = message; });
    void action(() => controller.refresh()).catch(() => {});
    return () => { mounted = false; controller.dispose(); };
  });
</script>

<section aria-label="Terminal conversation" class="terminal-chat">
  <div class="terminal-actions">
    <span>Codex · {session ? `${session.phase === 'completed' ? 'ready' : session.phase} · ${session.diagnostic?.pending || 0} queued` : 'starts with your first message'}</span>
    <button disabled={busy} on:click={() => action(() => controller.refresh()).catch(() => {})}>Reconnect</button>
    {#if session}<button disabled={busy} on:click={() => close().catch(() => {})}>Close session</button>{/if}
  </div>
  {#if error || session?.error}<p role="alert">{error || session?.error}</p>{/if}
  {#if transcript}<details><summary>Terminal activity</summary><pre aria-label="Terminal transcript">{transcript}</pre></details>
  {:else}<p>Select “Send as Terminal” and send a message to start Codex. Later messages continue the same session.</p>{/if}
</section>

<style>
  .terminal-chat { padding: 1rem; }
  .terminal-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; font-size: .8rem; color: var(--text-muted, #9ca3af); }
  button { border: 1px solid var(--border-color, #374151); border-radius: .4rem; padding: .25rem .6rem; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 1rem; font-size: .85rem; }
  p { margin-top: .75rem; }
  [role="alert"] { color: #f87171; }
</style>
