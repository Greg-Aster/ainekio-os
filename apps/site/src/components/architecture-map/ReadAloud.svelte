<script lang="ts">
  import { onDestroy } from 'svelte'
  import { useTTS } from '../../lib/client/composables/useTTS'

  let { text }: { text: string } = $props()
  const tts = useTTS()
  let requestId = $state<string | null>(null)
  let error = $state('')

  function stop() {
    if (requestId) tts.interruptPlaybackRequest(requestId)
    requestId = null
  }

  async function read() {
    if (requestId) { stop(); return }
    const id = `architecture-${crypto.randomUUID()}`
    requestId = id
    error = ''
    try {
      const unlocked = await tts.ensureAudioUnlocked()
      if (requestId !== id) return
      if (!unlocked) throw new Error('Browser audio could not start. Click Read aloud to try again.')
      const outcome = await tts.speak(text, { requestId: id, source: 'architecture-map' })
      if (requestId === id && outcome === 'failed') error = 'Speech could not be played. Check the configured voice service.'
    } catch (cause) {
      if (requestId === id) error = cause instanceof Error ? cause.message : 'Speech could not be played.'
    } finally {
      if (requestId === id) requestId = null
    }
  }

  onDestroy(stop)
</script>

<button class="read-aloud" onclick={read} aria-label={requestId ? 'Stop reading' : 'Read aloud'} title={requestId ? 'Stop reading' : 'Read this information aloud'}>
  {#if requestId}
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>
    Stop
  {:else}
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4 6 8H3v8h3l5 4Z" /><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></svg>
    Read aloud
  {/if}
</button>
{#if error}<p class="speech-error" role="alert">{error}</p>{/if}

<style>
  .read-aloud { display: inline-flex; align-items: center; gap: 7px; padding: 6px 9px; margin: 0 0 10px; border: 1px solid #4b607d; border-radius: 5px; background: #263b53; color: #d5e4f8; font: inherit; font-size: 12px; cursor: pointer; }
  .read-aloud:hover { background: #304b69; }
  svg { width: 17px; height: 17px; }
  .speech-error { color: #e9bd81; font-size: 12px; line-height: 1.5; }
</style>
