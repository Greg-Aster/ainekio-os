<script lang="ts">
  import { afterUpdate, createEventDispatcher, onDestroy } from 'svelte';
  import type { ChatMessage } from '../../lib/client/composables/useMessages';
  import FeedbackButtons from './FeedbackButtons.svelte';

  export let input: string = '';
  export let loading: boolean = false;
  export let composeTarget: 'conversation' | 'inner' | 'terminal' | null = 'conversation';
  export let readOnly = false;

  // Auto-expanding textarea
  let textareaElement: HTMLTextAreaElement;
  const MIN_HEIGHT = 44; // ~1-2 lines
  const MAX_HEIGHT = 200; // ~8-10 lines

  function adjustTextareaHeight() {
    if (!textareaElement) return;
    // Reset to min to get accurate scrollHeight
    textareaElement.style.height = MIN_HEIGHT + 'px';
    // Expand to content, capped at max
    const newHeight = Math.min(Math.max(textareaElement.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    textareaElement.style.height = newHeight + 'px';
  }

  // Measure after Svelte applies both typed and programmatic input changes.
  afterUpdate(adjustTextareaHeight);

  export let selectedMessage: ChatMessage | null = null;
  export let isRecording: boolean = false;
  export let isContinuousMode: boolean = false;
  export let isConversationMode: boolean = false; // Conversation mode active (mobile long-press)
  export let ttsIsPlaying: boolean = false;
  export let interimTranscript: string = ''; // Real-time transcript preview

  const dispatch = createEventDispatcher<{
    send: void;
    stop: void;
    keypress: { event: KeyboardEvent };
    micClick: void;
    micLongPress: void;
    micContextMenu: void;
    ttsStop: void;
    ttsStopAndListen: void;
    clearSelection: void;
  }>();

  // Long-press detection for conversation mode
  const LONG_PRESS_DURATION = 500; // 500ms for long press
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function handleKeyPress(e: KeyboardEvent) {
    dispatch('keypress', { event: e });
  }

  function handleSend() {
    dispatch('send');
  }

  function handleStop() {
    dispatch('stop');
  }

  function handleMicClick() {
    // If TTS is playing, tap to interrupt and start listening (tap-to-interrupt feature)
    if (ttsIsPlaying) {
      dispatch('ttsStopAndListen');
      return;
    }

    dispatch('micClick');
  }

  function handleMicContextMenu(e: MouseEvent) {
    e.preventDefault();
    dispatch('micContextMenu');
  }

  // Touch event handlers for long-press detection (enter conversation mode)
  let touchStartX = 0;
  let touchStartY = 0;
  const TOUCH_MOVE_THRESHOLD = 10; // pixels - allow some finger movement

  function handleMicTouchStart(e: TouchEvent) {
    // Prevent browser's default long-press behavior (context menu, text selection, etc.)
    e.preventDefault();
    cancelMicTouch();
    // Store initial touch position for movement threshold
    if (e.touches.length > 0) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      // Vibrate on mobile if supported (haptic feedback)
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
      dispatch('micLongPress');
    }, LONG_PRESS_DURATION);
  }

  function handleMicTouchEnd(e: TouchEvent) {
    if (longPressTimer) {
      cancelMicTouch();
      handleMicClick();
    }
    // Always prevent since we're handling everything in touch events
    e.preventDefault();
  }

  function handleMicTouchMove(e: TouchEvent) {
    // Cancel long press only if user moves finger significantly
    if (longPressTimer && e.touches.length > 0) {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > TOUCH_MOVE_THRESHOLD || dy > TOUCH_MOVE_THRESHOLD) {
        cancelMicTouch();
      }
    }
  }

  function cancelMicTouch() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function handleTtsStop() {
    dispatch('ttsStop');
  }

  function handleClearSelection() {
    dispatch('clearSelection');
  }

  onDestroy(cancelMicTouch);
</script>

<div class="input-wrapper">
  <!-- Reply-to indicator -->
  {#if selectedMessage}
    {@const isCuriosity = selectedMessage.meta?.isCuriosityQuestion || selectedMessage.meta?.type === 'curiosity'}
    {@const isClarifying = selectedMessage.meta?.type === 'clarifying_questions'}
    <div class="reply-indicator
                {isCuriosity ? 'bg-purple-500/10 dark:bg-purple-500/20 curiosity-reply' : isClarifying ? 'bg-cyan-500/10 dark:bg-cyan-500/20' : 'bg-blue-500/10 dark:bg-blue-500/20'}">
      {#if isCuriosity}
        <span class="pulse-dot-curiosity"></span>
        <span class="text-purple-500 dark:text-purple-400 font-medium">💭 Responding to:</span>
        <span class="text-gray-600 dark:text-gray-400 flex-1 truncate">{selectedMessage.content.substring(0, 50)}{selectedMessage.content.length > 50 ? '...' : ''}</span>
      {:else if isClarifying}
        <span class="text-cyan-500 dark:text-cyan-400 font-medium">💭 Discussing:</span>
        <span class="text-gray-600 dark:text-gray-400 flex-1 truncate">{selectedMessage.meta?.desireTitle || 'Goal'}</span>
      {:else}
        <span class="text-blue-500 dark:text-blue-400 font-medium">↩ Replying to:</span>
        <span class="text-gray-600 dark:text-gray-400 flex-1 truncate">{selectedMessage.content.substring(0, 60)}{selectedMessage.content.length > 60 ? '...' : ''}</span>
      {/if}
      <button
        class="w-6 h-6 flex items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
        on:click={handleClearSelection}
        title="Cancel reply"
      >✕</button>
    </div>
  {/if}

  <!-- Interim transcript preview (shows words as you speak in native mode) -->
  {#if interimTranscript}
    <div class="interim-transcript flex items-center gap-2 px-3 py-2 bg-blue-500/10 dark:bg-blue-500/20 rounded-lg mb-2">
      <span class="interim-icon text-base">🎤</span>
      <span class="text-sm text-blue-500 dark:text-blue-400 italic">{interimTranscript}</span>
    </div>
  {/if}

  <div class="input-row">
    <!-- Feedback buttons - left side -->
    <div class="feedback-slot">
      <FeedbackButtons />
    </div>

    <textarea
      bind:this={textareaElement}
      bind:value={input}
      disabled={readOnly}
      on:keypress={handleKeyPress}
      placeholder={readOnly ? 'The selected view is read-only' : composeTarget === 'terminal' ? 'Message Codex in the same terminal session...' : composeTarget === 'inner' ? 'Add an unvoiced thought...' : 'Message your Ainekio OS...'}
      rows="1"
      class="chat-input {loading ? 'queuing' : ''}"
    ></textarea>
    <div class="input-actions">
      <!-- Stop thinking button - only visible when thinking -->
      {#if loading}
        <button
          class="input-stop-btn stop-thinking"
          title="Stop thinking"
          on:click={handleStop}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
          <span>Stop</span>
        </button>
      {/if}
      <!-- Stop button - only visible when audio is playing -->
      {#if ttsIsPlaying}
        <button
          class="input-stop-btn"
          title="Stop speaking"
          on:click={handleTtsStop}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </button>
      {/if}
      <button
        disabled={readOnly}
        class="mic-btn {isRecording ? 'recording' : ''} {isContinuousMode ? 'continuous' : ''} {isConversationMode ? 'conversation' : ''} {ttsIsPlaying ? 'interrupt-ready' : ''} {loading ? 'queuing' : ''}"
        title={loading ? 'Voice input will be queued' : ttsIsPlaying ? 'Tap to interrupt and speak' : isConversationMode ? (isRecording ? 'Listening…' : 'Conversation mode - just talk!') : isContinuousMode ? (isRecording ? 'Listening continuously…' : 'Continuous mode active') : (isRecording ? 'Listening… tap to stop' : 'Tap to speak, hold for conversation')}
        on:click={handleMicClick}
        on:contextmenu={handleMicContextMenu}
        on:touchstart={handleMicTouchStart}
        on:touchend={handleMicTouchEnd}
        on:touchmove={handleMicTouchMove}
        on:touchcancel={cancelMicTouch}
      >
        {#if isConversationMode && isRecording}
          <!-- Conversation mode recording: Waveform icon (green) -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" class="recording-icon">
            <rect x="2" y="8" width="2" height="8" rx="1"/>
            <rect x="6" y="4" width="2" height="16" rx="1"/>
            <rect x="10" y="10" width="2" height="4" rx="1"/>
            <rect x="14" y="6" width="2" height="12" rx="1"/>
            <rect x="18" y="9" width="2" height="6" rx="1"/>
          </svg>
        {:else if isConversationMode}
          <!-- Conversation mode waiting: Chat bubble icon -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" class="conversation-icon">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
          </svg>
        {:else if isContinuousMode && isRecording}
          <!-- Recording: Waveform icon -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" class="recording-icon">
            <rect x="2" y="8" width="2" height="8" rx="1"/>
            <rect x="6" y="4" width="2" height="16" rx="1"/>
            <rect x="10" y="10" width="2" height="4" rx="1"/>
            <rect x="14" y="6" width="2" height="12" rx="1"/>
            <rect x="18" y="9" width="2" height="6" rx="1"/>
          </svg>
        {:else if isContinuousMode}
          <!-- Waiting: Sound waves icon -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="waiting-icon">
            <path d="M9 9c-.5-.5-1.5-1-3-1M9 15c-.5.5-1.5 1-3 1M15 9c.5-.5 1.5-1 3-1M15 15c.5.5 1.5 1 3 1M12 12v.01"/>
          </svg>
        {:else}
          <!-- Normal: Microphone icon -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
          </svg>
        {/if}
      </button>
      <button
        class="send-btn"
        on:click={handleSend}
        disabled={readOnly || !input.trim()}
        title="Send message"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  .input-wrapper {
    @apply flex flex-col gap-3 max-w-3xl mx-auto;
  }

  .input-row {
    @apply flex items-end gap-3;
  }

  .feedback-slot {
    @apply flex items-center flex-shrink-0 mr-2;
  }

  .chat-input {
    @apply flex-1 px-4 py-3 border border-black/10 rounded-xl text-sm resize-none bg-white text-gray-900;
    min-height: 44px;
    max-height: 200px;
    overflow-y: auto;
    font-family: inherit;
    line-height: 1.5;
  }

  :global(.dark) .chat-input {
    @apply border-white/10 bg-gray-900 text-gray-100;
  }

  .chat-input:focus {
    @apply outline-none border-violet-600 ring-2 ring-violet-600/10;
  }

  :global(.dark) .chat-input:focus {
    @apply border-violet-400 ring-violet-400/10;
  }

  .chat-input:disabled {
    @apply opacity-50 cursor-not-allowed;
  }

  .chat-input.queuing {
    @apply border-amber-500/50;
  }

  :global(.dark) .chat-input.queuing {
    @apply border-amber-400/50;
  }

  .chat-input.queuing:focus {
    @apply border-amber-500 ring-amber-500/20;
  }

  :global(.dark) .chat-input.queuing:focus {
    @apply border-amber-400 ring-amber-400/20;
  }

  .send-btn {
    @apply flex items-center justify-center p-3 border-0 rounded-xl bg-violet-600 text-white cursor-pointer
           transition-all;
  }

  :global(.dark) .send-btn {
    @apply bg-violet-400 text-gray-900;
  }

  .send-btn:hover:not(:disabled) {
    @apply bg-violet-700;
    transform: translateY(-1px);
  }

  :global(.dark) .send-btn:hover:not(:disabled) {
    @apply bg-violet-300;
  }

  .send-btn:disabled {
    @apply opacity-50 cursor-not-allowed;
  }

  .mic-btn {
    @apply inline-flex items-center justify-center px-2.5 py-2.5 border border-black/10 rounded-xl bg-white
           text-gray-900 cursor-pointer;
    position: relative;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    touch-action: none;
  }

  .mic-btn:disabled {
    @apply opacity-60 cursor-not-allowed;
  }

  .mic-btn.queuing {
    @apply border-amber-500/50 text-amber-600;
  }

  :global(.dark) .mic-btn.queuing {
    @apply border-amber-400/50 text-amber-400;
  }

  .mic-btn.recording {
    @apply border-violet-400 ring-2 ring-violet-400/20 relative;
  }

  .mic-btn.recording::after {
    content: '';
    position: absolute;
    inset: -6px;
    border: 2px solid rgba(167, 139, 250, 0.8);
    border-radius: 0.75rem;
    animation: pulseMic 1.2s infinite ease-out;
    pointer-events: none;
  }

  @keyframes pulseMic {
    0% {
      transform: scale(0.9);
      opacity: 0.6;
    }

    80% {
      transform: scale(1.15);
      opacity: 0;
    }

    100% {
      transform: scale(1.2);
      opacity: 0;
    }
  }

  .mic-btn.continuous:not(.recording) {
    animation: breathe 2s ease-in-out infinite;
  }

  @keyframes breathe {
    0%, 100% {
      opacity: 0.6;
    }

    50% {
      opacity: 1;
    }
  }

  .recording-icon {
    color: #ef4444 !important;
    animation: recordingBounce 0.8s ease-in-out infinite;
  }

  @keyframes recordingBounce {
    0%, 100% {
      transform: scaleY(1);
    }

    25% {
      transform: scaleY(1.2);
    }

    50% {
      transform: scaleY(0.8);
    }

    75% {
      transform: scaleY(1.1);
    }
  }

  .waiting-icon {
    animation: soundWave 2s ease-in-out infinite;
  }

  @keyframes soundWave {
    0%, 100% {
      opacity: 0.4;
    }

    50% {
      opacity: 1;
    }
  }

  .input-stop-btn {
    justify-content: center;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(239, 68, 68, 0.1);
    color: rgba(239, 68, 68, 1);
    border: none;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 0.875rem;
    font-weight: 500;
  }

  :global(.dark) .input-stop-btn {
    @apply text-red-400;
  }

  .input-stop-btn:hover {
    background: rgba(239, 68, 68, 0.2);
    transform: scale(1.05);
  }

  .reply-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: rgba(167, 139, 250, 0.1);
    border-left: 3px solid rgba(167, 139, 250, 0.6);
    border-radius: 0.375rem;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
  }

  .mic-btn.continuous {
    background: rgba(59, 130, 246, 0.2) !important;
    border-color: rgba(59, 130, 246, 0.6) !important;
  }

  .input-actions {
    @apply flex items-center gap-2;
    position: relative;
  }

  @media (max-width: 640px) {
    .mic-btn {
      padding: 0.6rem;
    }

    .input-wrapper {
      gap: 0.5rem;
    }

    .chat-input {
      min-width: 0;
      font-size: 0.95rem;
      padding: 0.65rem 0.8rem;
    }

    .input-row {
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .feedback-slot {
      flex-basis: 100%;
      margin-right: 0;
    }

    .input-actions {
      gap: 0.35rem;
    }

    .input-stop-btn,
    .send-btn {
      padding: 0.6rem;
    }
  }

  /* Curiosity reply indicator with pulsing dot */

  .curiosity-reply {
    border-left: 3px solid #8b5cf6;
    animation: curiosity-glow 2s ease-in-out infinite;
  }

  .pulse-dot-curiosity {
    width: 10px;
    height: 10px;
    background: #8b5cf6;
    border-radius: 50%;
    flex-shrink: 0;
    animation: pulse-curiosity 1.5s ease-in-out infinite;
    box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4);
  }

  @keyframes pulse-curiosity {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
      box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4);
    }

    50% {
      opacity: 0.8;
      transform: scale(0.85);
      box-shadow: 0 0 0 8px rgba(139, 92, 246, 0);
    }
  }

  @keyframes curiosity-glow {
    0%, 100% {
      background-color: rgba(139, 92, 246, 0.1);
    }

    50% {
      background-color: rgba(139, 92, 246, 0.18);
    }
  }

  :global(.dark) .curiosity-reply {
    border-left-color: #a78bfa;
  }

  /* Interim transcript animations */

  .interim-transcript {
    animation: pulse 1.5s ease-in-out infinite;
  }

  .interim-icon {
    animation: bounce 0.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }

    50% {
      opacity: 0.7;
    }
  }

  @keyframes bounce {
    0%, 100% {
      transform: translateY(0);
    }

    50% {
      transform: translateY(-2px);
    }
  }

  /* Mic button - prevent long-press browser behavior */

  :global(.dark) .mic-btn {
    @apply border-white/10 bg-gray-900 text-gray-100;
  }

  /* Conversation mode - green */

  .mic-btn.conversation {
    @apply bg-green-500/15 border-green-500 text-green-500 dark:bg-green-400/20 dark:border-green-400
           dark:text-green-400;
  }

  .conversation-icon {
    animation: pulse 2s ease-in-out infinite;
  }

  .mic-btn.conversation:not(.recording) {
    animation: ready-pulse 2s ease-in-out infinite;
  }

  /* Interrupt ready - red pulsing */

  .mic-btn.interrupt-ready {
    @apply bg-red-500/15 border-red-500 text-red-500 dark:bg-red-400/20 dark:border-red-400 dark:text-red-400;
    animation: interrupt-pulse 1s ease-in-out infinite;
  }

  @keyframes interrupt-pulse {
    0%, 100% {
      transform: scale(1);
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
    }

    50% {
      transform: scale(1.05);
      box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
    }
  }

  @keyframes ready-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4);
    }

    50% {
      box-shadow: 0 0 0 6px rgba(34, 197, 94, 0);
    }
  }

  /* Recording waveform animation */

  .mic-btn.recording .recording-icon rect {
    animation: waveform 0.8s ease-in-out infinite;
  }

  .mic-btn.recording .recording-icon rect:nth-child(1) {
    animation-delay: 0s;
  }

  .mic-btn.recording .recording-icon rect:nth-child(2) {
    animation-delay: 0.1s;
  }

  .mic-btn.recording .recording-icon rect:nth-child(3) {
    animation-delay: 0.2s;
  }

  .mic-btn.recording .recording-icon rect:nth-child(4) {
    animation-delay: 0.3s;
  }

  .mic-btn.recording .recording-icon rect:nth-child(5) {
    animation-delay: 0.4s;
  }

  @keyframes waveform {
    0%, 100% {
      transform: scaleY(0.5);
    }

    50% {
      transform: scaleY(1);
    }
  }
</style>
