<script lang="ts">
  /**
   * CuriosityCard Component
   *
   * Displays curiosity questions asked by the system.
   *
   * Interaction Pattern:
   * 1. User clicks/selects this card
   * 2. User types response in the main chat input
   * 3. Response is routed through the response pipeline (cardType: 'curiosity_response')
   *
   * The "Skip" action dismisses the question without requiring a response.
   */
  import BaseMessageCard from './BaseMessageCard.svelte';
  import type { ChatMessage } from '../../../lib/client/composables/useMessages';
  import { apiFetch } from '../../../lib/client/api-config';

  export let message: ChatMessage;
  export let index: number;
  export let isSelected: boolean = false;

  let skippedQuestionId: string | undefined;
  let isSkipping = false;
  let skipError: { questionId: string | undefined; message: string } | null = null;

  $: questionId = message.meta?.questionId || message.meta?.curiosityQuestionId;
  $: wasSkipped = Boolean(message.meta?.skipped || (questionId && skippedQuestionId === questionId));
  $: hasResponded = Boolean(message.meta?.answered || wasSkipped);

  /**
   * Skip this curiosity question without responding
   * Resolves the canonical pending question as skipped.
   */
  async function handleSkip() {
    if (isSkipping || hasResponded) return;

    const requestedQuestionId = questionId;
    isSkipping = true;
    skipError = null;

    try {
      const response = await apiFetch('/api/curiosity/questions/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: requestedQuestionId,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `Could not skip curiosity question (${response.status})`);
      }
      skippedQuestionId = requestedQuestionId;
    } catch (error) {
      skipError = { questionId: requestedQuestionId, message: error instanceof Error ? error.message : 'Could not skip this question' };
    } finally {
      isSkipping = false;
    }
  }
</script>

<BaseMessageCard
  {message}
  {index}
  {isSelected}
  roleLabel="I'm curious:"
  roleIcon="💭"
  accentColor={message.meta?.displayColor || '#8b5cf6'}
  on:messageClick
  on:deleteMessage
  on:validateMessage
  on:speakMessage
>
  <svelte:fragment slot="content">
    <!-- Question text -->
    <p class="curiosity-text">{message.content}</p>

    <!-- Response status or interaction hint -->
    {#if hasResponded}
      <div class="status-container">
        {#if wasSkipped}
          <span class="status-badge status-skipped">
            <span class="status-icon">⏭</span>
            Skipped
          </span>
        {:else}
          <span class="status-badge status-responded">
            <span class="status-icon">✓</span>
            Responded
          </span>
        {/if}
      </div>
    {:else}
      <!-- Interaction hint and skip button -->
      <div class="interaction-area">
        {#if isSelected}
          <div class="selection-active">
            <span class="pulse-dot"></span>
            <span class="hint-text">Selected — type your response below</span>
          </div>
        {:else}
          <div class="selection-hint">
            <span class="hint-text">Click to reply</span>
          </div>
        {/if}

        <button
          class="skip-btn"
          on:click|stopPropagation={handleSkip}
          disabled={isSkipping}
          title="Skip this question"
        >
          {#if isSkipping}
            <span class="spinner"></span>
          {:else}
            Skip
          {/if}
        </button>
      </div>
      {#if skipError?.questionId === questionId && skipError}
        <p class="skip-error" role="alert">{skipError.message}</p>
      {/if}
    {/if}
  </svelte:fragment>
</BaseMessageCard>

<style>
  /* Question text */
  .curiosity-text {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.6;
  }

  /* Status container for responded/skipped states */
  .status-container {
    margin-top: 0.75rem;
    display: flex;
    align-items: center;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .status-icon {
    font-size: 0.75rem;
  }

  .status-responded {
    background: rgba(34, 197, 94, 0.1);
    color: #16a34a;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status-skipped {
    background: rgba(107, 114, 128, 0.1);
    color: #6b7280;
    border: 1px solid rgba(107, 114, 128, 0.3);
  }

  /* Interaction area with hint and skip */
  .interaction-area {
    margin-top: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .skip-error {
    margin: 0.5rem 0 0;
    color: #dc2626;
    font-size: 0.75rem;
  }

  /* Selection hint (not selected) */
  .selection-hint {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .selection-hint .hint-text {
    font-size: 0.8125rem;
    color: var(--text-muted);
    opacity: 0.8;
  }

  /* Selection active indicator */
  .selection-active {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    background: rgba(139, 92, 246, 0.1);
    border: 1px solid rgba(139, 92, 246, 0.3);
    border-radius: 9999px;
  }

  .selection-active .hint-text {
    font-size: 0.8125rem;
    color: #7c3aed;
    font-weight: 500;
  }

  /* Pulsing dot for active selection */
  .pulse-dot {
    width: 8px;
    height: 8px;
    background: #8b5cf6;
    border-radius: 50%;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(0.8);
    }
  }

  /* Skip button */
  .skip-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 60px;
    padding: 0.375rem 0.75rem;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid rgba(139, 92, 246, 0.25);
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .skip-btn:hover:not(:disabled) {
    background: rgba(139, 92, 246, 0.1);
    border-color: rgba(139, 92, 246, 0.4);
    color: var(--text-primary);
  }

  .skip-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Spinner for skip button */
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(139, 92, 246, 0.3);
    border-top-color: #8b5cf6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  :global(.dark) .skip-error {
    color: #fca5a5;
  }

  :global(.dark) .status-responded {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
  }

  :global(.dark) .status-skipped {
    background: rgba(107, 114, 128, 0.15);
    color: #9ca3af;
  }

  :global(.dark) .selection-active {
    background: rgba(139, 92, 246, 0.15);
  }

  :global(.dark) .selection-active .hint-text {
    color: #a78bfa;
  }
</style>
