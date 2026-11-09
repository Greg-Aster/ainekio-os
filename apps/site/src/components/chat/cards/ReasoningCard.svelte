<script lang="ts">
  import type { ChatMessage } from '../../../lib/client/composables/useMessages';
  import Thinking from '../../Thinking.svelte';
  import { formatReasoningLabel } from '../message-discriminator';

  export let message: ChatMessage;
  export let isSelected: boolean = false;

  // Get label from metadata or generate default
  $: label = message.meta?.label || formatReasoningLabel(message.meta?.stage);
</script>

<div class="card-wrapper">
  <div class="reasoning-card" class:selected={isSelected}>
    <Thinking steps={message.content} {label} initiallyOpen={true} />
  </div>
</div>

<style>
  .card-wrapper {
    display: flex;
    justify-content: flex-start;
    width: 100%;
  }

  .reasoning-card {
    max-width: 85%;
    border-radius: 0.75rem;
    transition: all 0.15s ease;
  }

  .reasoning-card.selected {
    box-shadow: 0 0 0 2px var(--accent-color);
  }
</style>
