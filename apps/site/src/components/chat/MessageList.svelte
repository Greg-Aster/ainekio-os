<script lang="ts">
  /**
   * MessageList.svelte
   * Orchestrates message card rendering using the card component system.
   * Each message type has its own self-contained card component.
   */
  import Thinking from '../Thinking.svelte';
  import type { ChatMessage, ReasoningStage } from '../../lib/client/composables/useMessages';
  import { getCardComponent, isVisibleInMode, formatReasoningLabel } from './message-discriminator';
  import { cardComponents } from './cards/index';

  // Props
  export let messages: ChatMessage[] = [];
  export let mode: 'conversation' | 'inner' | 'combined' = 'conversation';
  export let showSystemMessages: boolean = false;
  export let selectedMessageIndex: number | null = null;
  export let reasoningStages: ReasoningStage[] = [];
  export let showThinkingIndicator: boolean = false;
  export let thinkingSteps: string = '';
  export let thinkingStatusLabel: string = '';

  // Filter visible messages based on mode
  $: visibleMessages = messages
    .map((msg, originalIndex) => ({ msg, originalIndex }))
    .filter(({ msg }) => isVisibleInMode(msg, mode, showSystemMessages));
</script>

<div class="messages-list">
  {#each visibleMessages as { msg, originalIndex } (msg.timestamp + '-' + originalIndex)}
    {@const cardType = getCardComponent(msg)}
    <svelte:component
      this={cardComponents[cardType]}
      message={msg}
      index={originalIndex}
      isSelected={selectedMessageIndex === originalIndex}
      on:messageClick
      on:deleteMessage
      on:validateMessage
      on:speakMessage
    />
  {/each}

  {#if reasoningStages.length > 0}
    {#each reasoningStages as stage, index (stage.timestamp + '-' + index)}
      <Thinking
        steps={stage.content}
        label={formatReasoningLabel(stage)}
        initiallyOpen={true}
      />
    {/each}
  {/if}

  {#if showThinkingIndicator}
    <Thinking
      steps={thinkingSteps}
      label={thinkingStatusLabel}
      initiallyOpen={true}
    />
  {/if}
</div>

<style>
  .messages-list {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
  }
</style>
