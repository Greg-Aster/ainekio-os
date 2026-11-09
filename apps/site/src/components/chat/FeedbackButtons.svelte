<script lang="ts">
  /**
   * FeedbackButtons - Unified +/- feedback system
   *
   * Compact buttons that appear in the input area.
   * Default value is 0 (no feedback). + sets to 1, - sets to -1.
   * Clicking either button opens an optional comment input.
   */
  import { onDestroy } from 'svelte';
  import { apiFetch } from '../../lib/client/api-config';

  // State
  let currentRating: number = 0; // -1, 0, or 1
  let showInput = false;
  let comment = '';
  let submitting = false;
  let showSuccess = false;
  let error = '';
  let destroyed = false;
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  function handleRatingClick(rating: number) {
    error = '';
    showInput = currentRating === rating ? !showInput : true;
    currentRating = rating;
  }

  async function submitFeedback() {
    if (currentRating === 0) return;

    const submittedRating = currentRating;
    const submittedComment = comment;
    submitting = true;
    error = '';
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: submittedRating,
          comment: submittedComment.trim() || undefined,
          targetType: 'conversation',
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Could not submit feedback (${res.status})`);
      }
      if (destroyed) return;
      showSuccess = true;
      if (successTimeout) clearTimeout(successTimeout);
      successTimeout = setTimeout(() => {
        successTimeout = null;
        showSuccess = false;
        if (currentRating === submittedRating && comment === submittedComment) {
          showInput = false;
          comment = '';
          currentRating = 0;
        }
      }, 1500);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not submit feedback';
    } finally {
      submitting = false;
    }
  }

  function handleKeyPress(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFeedback();
    }
    if (e.key === 'Escape') {
      error = '';
      showInput = false;
      comment = '';
    }
  }

  function cancel() {
    error = '';
    showInput = false;
    comment = '';
    currentRating = 0;
  }

  onDestroy(() => {
    destroyed = true;
    if (successTimeout) clearTimeout(successTimeout);
  });
</script>

<div class="feedback-container" class:expanded={showInput}>
  {#if showSuccess}
    <div class="success-indicator">
      <span class="success-icon">✓</span>
    </div>
  {:else}
    <div class="feedback-buttons">
      <button
        class="fb-btn minus"
        class:active={currentRating === -1}
        on:click={() => handleRatingClick(-1)}
        disabled={submitting}
        title="Negative feedback"
      >−</button>
      <button
        class="fb-btn plus"
        class:active={currentRating === 1}
        on:click={() => handleRatingClick(1)}
        disabled={submitting}
        title="Positive feedback"
      >+</button>
    </div>

    {#if showInput}
      <div class="feedback-input-row">
        <input
          type="text"
          bind:value={comment}
          placeholder="Why? (optional)"
          class="feedback-input"
          on:keydown={handleKeyPress}
          disabled={submitting}
        />
        <button
          class="submit-btn"
          on:click={submitFeedback}
          disabled={submitting || currentRating === 0}
          title="Submit feedback"
        >
          {submitting ? '...' : '→'}
        </button>
        <button
          class="cancel-btn"
          on:click={cancel}
          disabled={submitting}
          title="Cancel"
        >×</button>
      </div>
    {/if}
  {/if}
  {#if error}
    <p class="feedback-error" role="alert">{error}</p>
  {/if}
</div>

<style>
  .feedback-error {
    flex-basis: 100%;
    overflow-wrap: anywhere;
    margin: 0;
    color: #dc2626;
    font-size: 0.75rem;
  }

  :global(.dark) .feedback-error {
    color: #fca5a5;
  }

  .feedback-container {
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    transition: all 0.2s ease;
  }

  .feedback-container.expanded {
    flex-wrap: wrap;
  }

  .feedback-buttons {
    display: flex;
    gap: 0.15rem;
  }

  .fb-btn {
    width: 24px;
    height: 24px;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 4px;
    background: transparent;
    color: rgba(128, 128, 128, 0.6);
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .fb-btn:hover:not(:disabled) {
    background: rgba(128, 128, 128, 0.1);
  }

  .fb-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .fb-btn.plus:hover:not(:disabled),
  .fb-btn.plus.active {
    color: #22c55e;
    border-color: #22c55e;
    background: rgba(34, 197, 94, 0.1);
  }

  .fb-btn.minus:hover:not(:disabled),
  .fb-btn.minus.active {
    color: #ef4444;
    border-color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
  }

  .feedback-input-row {
    display: flex;
    gap: 0.25rem;
    align-items: center;
    margin-left: 0.25rem;
  }

  .feedback-input {
    width: 140px;
    padding: 0.25rem 0.5rem;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: 0.75rem;
    outline: none;
  }

  .feedback-input:focus {
    border-color: var(--accent-color);
  }

  :global(.dark) .feedback-input {
    background: rgba(0, 0, 0, 0.2);
  }

  .submit-btn, .cancel-btn {
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .submit-btn {
    background: var(--accent-color);
    color: white;
  }

  .submit-btn:hover:not(:disabled) {
    background: #2563eb;
  }

  .submit-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .cancel-btn {
    background: transparent;
    color: rgba(128, 128, 128, 0.6);
    border: 1px solid rgba(128, 128, 128, 0.3);
  }

  .cancel-btn:hover:not(:disabled) {
    background: rgba(128, 128, 128, 0.1);
  }

  .success-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 52px; /* Same width as two buttons + gap */
    height: 24px;
  }

  .success-icon {
    color: #22c55e;
    font-size: 1rem;
    font-weight: 600;
  }
</style>
