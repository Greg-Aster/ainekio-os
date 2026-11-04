<script lang="ts">
  import { onMount, beforeUpdate, afterUpdate, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import Thinking from './Thinking.svelte';
  import TerminalChat from './terminal/TerminalChat.svelte';
  import { reportChatError } from '../lib/client/system-errors';
  import InputArea from './chat/InputArea.svelte';
  import MessageList from './chat/MessageList.svelte';
  import ApprovalPrompt from './ApprovalPrompt.svelte';
  // Operator proposals are rendered inline by OperatorProposalCard.
  import { canUseOperator, currentMode, isOwner } from '../stores/security-policy';
  import { yoloModeStore, statusRefreshTrigger } from '../stores/navigation';
  import { calculateVoiceVolume } from '../lib/client/utils/audio-utils.js';
  import { nextSpeechOutputState, speechOutputState, speechOutputSettings, type SpeechOutputState } from '../lib/client/assistant-speech-preference';
  import { useTTS } from '../lib/client/composables/useTTS';
  import { useMicrophone } from '../lib/client/composables/useMicrophone';
  import { useThinkingTrace } from '../lib/client/composables/useThinkingTrace';
  import { useMessages, useActivityTracking, type ChatMessage, type ReasoningStage } from '../lib/client/composables/useMessages';
  import { forceHealthCheck } from '../lib/client/server-health';
  import { apiEventSource, apiFetch } from '../lib/client/api-config';
  import {
    buildConversationParams,
    buildResponsePipelineRequestBody,
    parseConversationStreamEvent,
    readLlmOptions,
    responsePipelineCardTypeForReply,
  } from '../lib/client/conversation-transport';
  import { connectProposalsStream, disconnectProposalsStream } from '../stores/proposals';
  import { autonomyModeDefinition, nextAutonomyMode, type AutonomyMode } from '../lib/client/active-operator-modes';
  import { setActiveOperatorMode, triggerManagerSnapshot, useTriggerManager } from '../lib/stores/trigger-manager';
  import { projectBufferFeed, receiveLiveConversation, replaceBufferSlice, type BufferView } from '../lib/client/buffer-feed';

  export let terminalSelected = false;
  let terminalChat: TerminalChat;
  let terminalRunning = false;

  // Component state
  let input = '';
  let loading = false;
  let responsePipelineAbortController: AbortController | null = null; // For cancel button
  let responsePipelineTaskId: string | null = null;
  let reasoningStages: ReasoningStage[] = [];
  let reasoningDepth: number = 0;
  const reasoningLabels = ['Off', 'Quick', 'Focused', 'Deep'];
  const clampReasoningDepth = (value: number) => Math.max(0, Math.min(reasoningLabels.length - 1, Math.round(value)));
  let chatResponseStream: EventSource | null = null;
  let activeChatTaskId: string | null = null;
  let reconcilingChatTaskId: string | null = null;
  let queuedChatStreams = new Map<string, EventSource>();
  let bufferStream: EventSource | null = null;
  // Live workflow replies are local view state, never a conversation buffer or cache.
  let liveConversationMessages: ChatMessage[] = [];
  let isTabVisible = true;
  // One selection owns all persistent feeds, including Terminal.
  let selectedViews = new Set<BufferView>(['conversation']);
  $: if (terminalSelected) toggleView('terminal', true);

  const composeOptions = [
    { target: 'conversation', label: '💬 Conversation', title: 'Voiced conversation input' },
    { target: 'inner', label: '💭 Unvoiced thought', title: 'Unvoiced thought input' },
    { target: 'terminal', label: '⌨️ Terminal', title: 'Send to the same Codex terminal session' },
  ] as const;
  let composeTarget: 'conversation' | 'inner' | 'terminal' | null = 'conversation';
  $: availableComposeOptions = composeOptions.filter(option => selectedViews.has(option.target)
    && (option.target !== 'terminal' || $isOwner));
  $: if (availableComposeOptions.length === 1 || !availableComposeOptions.some(option => option.target === composeTarget)) {
    composeTarget = availableComposeOptions[0]?.target ?? null;
  }
  $: showComposeSelector = selectedViews.size > 1 && availableComposeOptions.length > 0;
  let mode: 'conversation' | 'inner' = 'conversation';
  $: mode = composeTarget === 'inner' ? 'inner' : 'conversation';
  let transientStatus = '';
  let transientStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let messagesContainer: HTMLDivElement;
  let shouldAutoScroll = true;
  // Buffer stream provides real-time updates via fs.watch SSE
  let visibilityCleanup: (() => void) | null = null;
  // Convenience toggles
  let ttsEnabled = true;
  let speechOutput: SpeechOutputState = 'browser';
  let speechPreferenceLoading = true;
  let speechPreferenceError = '';
  $: speechOutputLabel = speechOutput === 'off' ? 'Off' : speechOutput === 'browser' ? 'Browser' : 'Body Control';
  let yoloMode = false;
  // Active Operator three-state control
  let autonomyMode: AutonomyMode = 'reactive';
  let activeOperatorLoading = false;
  let releaseTriggerManager: (() => void) | undefined;
  $: if ($triggerManagerSnapshot?.autonomyMode) autonomyMode = $triggerManagerSnapshot.autonomyMode;
  $: activeOperatorMode = autonomyModeDefinition(autonomyMode);
  // Synchronous guard to prevent double/triple submit race condition
  let sendInProgress = false;

  // Initialize TTS composable
  const ttsApi = useTTS();
  const { isPlaying: ttsIsPlaying, isLoading: ttsIsLoading } = ttsApi;

  // Initialize Messages composable
  // History clearing follows the selected input destination; inference keeps its existing conversation mode.
  const messagesApi = useMessages({
    getMode: () => composeTarget ?? 'conversation',
    onMessagesChange: (msgs) => {
      // This handles any side effects when messages change
      // (currently none needed, but useful for future extensions)
    },
    onTransientSystemMessage: showTransientSystemMessage,
  });
  const {
    messages,
    selectedMessage,
    selectedMessageIndex,
    conversationSessionId
  } = messagesApi;

  $: displayMessages = projectBufferFeed([...$messages, ...liveConversationMessages], selectedViews);

  function showTransientSystemMessage(message: string) {
    transientStatus = message;
    if (transientStatusTimer) clearTimeout(transientStatusTimer);
    transientStatusTimer = setTimeout(() => {
      transientStatus = '';
      transientStatusTimer = null;
    }, 10_000);
  }

  function showChatError(error: unknown, eventId?: string, record = true) {
    const message = error instanceof Error ? error.message : String(error);
    messagesApi.pushMessage('system', `Error: ${message}`);
    if (record) void reportChatError(error, { eventId }).catch(failure => console.error('[chat] Error evidence was not recorded:', failure));
  }

  function pushComposedInput(content: string, target: 'conversation' | 'inner' = mode) {
    messagesApi.pushMessage(
      target === 'inner' ? 'thought' : 'user',
      content,
      undefined,
      {
        bufferSource: target,
        ...(target === 'inner' ? { type: 'user_thought', unvoiced: true } : {}),
      },
    );
  }

  function pushGeneratedResponse(
    content: string,
    target: 'conversation' | 'inner' = mode,
    meta: Record<string, any> = {},
  ) {
    if (typeof content !== 'string' || !content.trim()) return;
    messagesApi.pushMessage(
      target === 'inner' ? 'reflection' : 'assistant',
      content,
      undefined,
      { ...meta, bufferSource: target },
    );
  }

  // Initialize Activity Tracking
  const activityApi = useActivityTracking();

  // Initialize Microphone composable
  const mic = useMicrophone({
    getTTSPlaying: () => get(ttsIsPlaying),
    onTranscript: (transcript: string) => {
      // Auto-send in continuous mode (desktop) or conversation mode (mobile)
      const autoSend = get(mic.isContinuousMode) || get(mic.isConversationMode);

      if (autoSend) {
        console.log('[chat-mic] Transcribed & sending:', transcript.substring(0, 50) + (transcript.length > 50 ? '...' : ''));
        input = transcript;
        void sendMessage();
      } else {
        // Single input mode: put transcript in input field for user to review/edit
        // APPEND to existing input if there's already text (allows multiple voice inputs)
        console.log('[chat-mic] Transcribed:', transcript.substring(0, 50) + (transcript.length > 50 ? '...' : ''));
        if (input.trim()) {
          // Append with a space separator
          input = input.trim() + ' ' + transcript;
          console.log('[chat-mic] Appended to existing input, total length:', input.length);
        } else {
          input = transcript;
        }
        // Do NOT auto-send - let user review and edit before manually sending
      }
    },
    onSystemMessage: (message: string) => {
      // Show friendly message to user (add to messages as system message)
      messagesApi.pushMessage('system', message);
    },
    isComponentMounted: () => isComponentMounted,
  });
  const {
    isRecording: micIsRecording,
    isContinuousMode: micIsContinuousMode,
    interimTranscript: micInterimTranscript,
    isNativeMode: micIsNativeMode,
    isConversationMode: micIsConversationMode,
  } = mic;
  let lastTTSPlayingForMic = false;

  $: if ($ttsIsPlaying !== lastTTSPlayingForMic) {
    if ($ttsIsPlaying) {
      mic.suspendContinuousForTTS();
    } else {
      mic.resumeContinuousAfterTTS();
    }
    lastTTSPlayingForMic = $ttsIsPlaying;
  }

  // Initialize Thinking Trace composable
  const thinkingTraceApi = useThinkingTrace({
    getCurrentMode: () => $currentMode || 'dual',
    getReasoningDepth: () => reasoningDepth,
    getReasoningStagesCount: () => reasoningStages.length,
  });
  const {
    trace: thinkingTrace,
    statusLabel: thinkingStatusLabel,
    active: thinkingActive,
    steps: thinkingSteps,
    showIndicator: showThinkingIndicator
  } = thinkingTraceApi;

  // Subscribe to shared YOLO mode store
  const unsubscribeYolo = yoloModeStore.subscribe(value => {
    yoloMode = value;
  });


  // Component lifecycle flag for cleanup
  let isComponentMounted = true;


  async function loadSpeechPreference(): Promise<void> {
    speechPreferenceLoading = true;
    try {
      const response = await apiFetch('/api/voice-settings');
      if (!response.ok) throw new Error(`Unable to load speech settings (${response.status})`);
      speechOutput = speechOutputState(await response.json());
      ttsEnabled = speechOutput !== 'off';
      speechPreferenceError = '';
      saveChatPrefs();
    } catch (error) {
      speechPreferenceError = (error as Error).message;
    } finally {
      speechPreferenceLoading = false;
    }
  }

  function loadChatPrefs() {
    try {
      const raw = localStorage.getItem('chatPrefs');
      if (!raw) {
        console.log('[chat-prefs] No chatPrefs in localStorage, using defaults');
        ttsEnabled = true;
        return;
      }
      const p = JSON.parse(raw);
      // Speech is enabled unless the user explicitly disabled it. The legacy
      // ttsEnabled=false value is not authoritative because older builds wrote
      // it automatically even when the user never pressed the speech button.
      ttsEnabled = p.speechDisabled !== true;
      if (typeof p.reasoningDepth === 'number') {
        reasoningDepth = clampReasoningDepth(p.reasoningDepth);
      } else if (typeof p.reasoningEnabled === 'boolean') {
        reasoningDepth = p.reasoningEnabled ? 2 : 0;
      }
      console.log('[chat-prefs] Loaded:', { ttsEnabled, reasoningDepth });
    } catch (e) {
      console.error('[chat-prefs] Error loading:', e);
      ttsEnabled = true;
    }
  }
  function saveChatPrefs() {
    try {
      const raw = localStorage.getItem('chatPrefs');
      const prefs = raw ? JSON.parse(raw) : {};
      delete prefs.ttsEnabled;
      Object.assign(prefs, {
        speechDisabled: !ttsEnabled,
        reasoningDepth,
        reasoningEnabled: reasoningDepth > 0,
      });
      localStorage.setItem('chatPrefs', JSON.stringify(prefs));
    } catch {}
  }

  async function toggleAssistantSpeech(): Promise<void> {
    const next = nextSpeechOutputState(speechOutput);
    speechPreferenceLoading = true;
    try {
      const response = await apiFetch('/api/voice-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(speechOutputSettings(next)),
      });
      if (!response.ok) throw new Error(`Unable to save speech output (${response.status})`);
      speechOutput = next;
      ttsEnabled = next !== 'off';
      speechPreferenceError = '';
      saveChatPrefs();
      if (ttsEnabled) ttsApi.prefetchVoiceResources();
      else await interruptAssistantSpeech('speech-disabled');
      window.dispatchEvent(new CustomEvent('voice-settings-updated'));
    } catch (error) {
      speechPreferenceError = (error as Error).message;
    } finally {
      speechPreferenceLoading = false;
    }
  }

  async function interruptAssistantSpeech(
    reason: 'user-input' | 'barge-in' | 'manual-stop' | 'speech-disabled',
  ): Promise<void> {
    const stopReason = reason === 'speech-disabled' ? 'disabled' : 'interrupted';
    ttsApi.interruptPlayback(stopReason);
    try {
      const response = await apiFetch('/api/tts-queue-interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        console.warn(`[tts-interrupt] Queue interruption was rejected (${response.status})`);
      }
    } catch (error) {
      console.warn('[tts-interrupt] Could not notify the queue owner:', error);
    }
  }

  function updateReasoningDepth(value: number, persist = false) {
    const clamped = clampReasoningDepth(value);
    if (clamped !== reasoningDepth) {
      reasoningDepth = clamped;
      if (clamped === 0) reasoningStages = [];
    }
    if (persist) saveChatPrefs();
  }

  function handleReasoningInput(event: Event) {
    const target = event.target as HTMLInputElement;
    updateReasoningDepth(Number(target.value), false);
  }

  function handleReasoningChange(event: Event) {
    const target = event.target as HTMLInputElement;
    updateReasoningDepth(Number(target.value), true);
  }

  // Server-first conversation buffer management

  onMount(() => {
    loadChatPrefs();
    void loadSpeechPreference();
    releaseTriggerManager = useTriggerManager();
    mic.loadVADSettings(); // Load VAD settings from voice config

    // Connect to proposals SSE stream for real-time updates (no polling)
    connectProposalsStream();

    // Enable hardware button capture only if user opted in via Voice Settings
    // This creates a background audio session for earbud/headphone button support
    const hardwareButtonsEnabled = localStorage.getItem('mh-hardware-buttons') === 'true';
    if (hardwareButtonsEnabled) {
      console.log('[chat] Hardware button capture enabled by user preference');
      mic.setupMediaSession();
    }

    if (ttsEnabled) {
      ttsApi.prefetchVoiceResources();
    }



    // Initialize or restore conversation session ID
    try {
      const storedSessionId = localStorage.getItem('mh_conversation_session_id');
      if (storedSessionId) {
        conversationSessionId.set(storedSessionId);
      } else {
        const newId = messagesApi.generateSessionId();
        localStorage.setItem('mh_conversation_session_id', newId);
      }
    } catch (e) {
      // Fallback if localStorage unavailable
      messagesApi.generateSessionId();
    }

    // The stream sends the initial buffer snapshots and subsequent updates.
    connectMultipleBufferStreams();
    console.log(`[ChatInterface] Connected to buffer streams for:`, Array.from(selectedViews));

    isTabVisible = !document.hidden;
    // Reconnect buffer streams when tab becomes visible (in case connection dropped)
    const handleVisibilityChange = () => {
      isTabVisible = !document.hidden;
      if (!isTabVisible) {
        disconnectAllBufferStreams();
        return;
      }

      if (selectedViews.size > 0) {
        // Check if any streams need reconnection
        const needsReconnect = !bufferStream || bufferStream.readyState === EventSource.CLOSED;

        if (needsReconnect) {
          console.log('[chat] Tab visible, reconnecting buffer streams');
          connectMultipleBufferStreams();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Store cleanup function for onDestroy
    visibilityCleanup = () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };

    // Curiosity questions and agent notifications now come through normal conversation flow
    // They're saved as conversation events by agents and loaded via /api/chat/history

    // Listen for voice settings changes (triggered when user updates VAD settings in UI)
    window.addEventListener('voice-settings-updated', handleVoiceSettingsUpdate);

    // CRITICAL: Aggressive cleanup on page unload to prevent connection leaks
    // This ensures EventSource connections are closed even if Svelte cleanup doesn't run
    const aggressiveCleanup = () => {
      console.log('[chat] Page unload - force closing ALL connections');
      chatResponseStream?.close();
      queuedChatStreams.forEach(stream => stream.close());
      queuedChatStreams.clear();
      disconnectAllBufferStreams();
      disconnectProposalsStream();
    };
    window.addEventListener('beforeunload', aggressiveCleanup);
    window.addEventListener('pagehide', aggressiveCleanup);

    // Store cleanup for onDestroy
    const windowCleanupFunctions = [
      () => window.removeEventListener('beforeunload', aggressiveCleanup),
      () => window.removeEventListener('pagehide', aggressiveCleanup),
    ];

    // Add to existing cleanup
    const originalVisibilityCleanup = visibilityCleanup;
    visibilityCleanup = () => {
      originalVisibilityCleanup?.();
      windowCleanupFunctions.forEach(fn => fn());
    };
  });

  // Event handler stored at module level for proper cleanup
  function handleVoiceSettingsUpdate() {
    console.log('[chat-mic] Voice settings updated, reloading...');
    mic.loadVADSettings();
    void loadSpeechPreference();
    ttsApi.refreshVoiceSettings();
  }

  function disconnectAllBufferStreams() {
    bufferStream?.close();
    bufferStream = null;
  }

  onDestroy(() => {
    // Mark component as unmounted to stop animation loops
    isComponentMounted = false;

    // Clean up event listeners and streams
    visibilityCleanup?.();
    chatResponseStream?.close();
    queuedChatStreams.forEach(stream => stream.close());
    queuedChatStreams.clear();
    disconnectAllBufferStreams();
    disconnectProposalsStream(); // Clean up proposals SSE stream
    activityApi.clearActivity();
    thinkingTraceApi.stop();
    unsubscribeYolo();
    releaseTriggerManager?.();
    if (transientStatusTimer) clearTimeout(transientStatusTimer);

    // Clean up voice settings event listener
    if (typeof window !== 'undefined') {
      window.removeEventListener('voice-settings-updated', handleVoiceSettingsUpdate);
    }

    // Clean up mic resources
    mic.disableMediaSession();
    mic.cleanup();
  });

  beforeUpdate(() => {
    if (messagesContainer) {
      // Measure before new content changes the height; allow pixel rounding.
      shouldAutoScroll = messagesContainer.scrollHeight - messagesContainer.clientHeight
        - messagesContainer.scrollTop <= 1;
    }
  });

  afterUpdate(() => {
    if (shouldAutoScroll && messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  });

  async function enqueueUserMessageTask(input: Record<string, any>) {
    const res = await apiFetch('/api/unified-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'user_message',
        priority: 'critical',
        input,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Failed to enqueue message (${res.status})`);
    }
    return data.task as { id: string };
  }

  async function getQueuedTaskStatus(taskId: string): Promise<{
    status: 'queued' | 'running' | 'completed' | 'failed';
    error?: string;
  }> {
    const res = await apiFetch(`/api/unified-queue/tasks/${encodeURIComponent(taskId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || !data.task?.status) {
      throw new Error(data.error || `Could not read queued task status (${res.status})`);
    }
    return data.task;
  }

  async function reconcileQueuedChatTask(taskId: string): Promise<void> {
    if (reconcilingChatTaskId === taskId) return;
    reconcilingChatTaskId = taskId;
    let statusFailures = 0;

    try {
      while (activeChatTaskId === taskId && loading) {
        try {
          const task = await getQueuedTaskStatus(taskId);
          statusFailures = 0;

          if (task.status === 'completed') {
            activeChatTaskId = null;
            thinkingTraceApi.stop();
            reasoningStages = [];
            loading = false;

            return;
          }

          if (task.status === 'failed') {
            activeChatTaskId = null;
            thinkingTraceApi.stop();
            reasoningStages = [];
            loading = false;
            showChatError(task.error || 'Queued message failed', `work-failure:${taskId}`, false);

            return;
          }

          thinkingTraceApi.setActive(true);
          thinkingTraceApi.setStatusLabel(task.status === 'running'
            ? '⚙️ Server is processing your message...'
            : '⏳ Message is queued...');
        } catch (error) {
          statusFailures++;
          console.warn('[chat] Could not reconcile queued task:', error);
          thinkingTraceApi.setActive(true);
          thinkingTraceApi.setStatusLabel('🔄 Reconnecting to message status...');

          if (statusFailures === 3) {
            thinkingTraceApi.appendTrace('The server accepted the message, but live status is temporarily unavailable.', 15);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      if (reconcilingChatTaskId === taskId) {
        reconcilingChatTaskId = null;
      }
    }
  }

  function openQueuedBackgroundStream(taskId: string, userMessage: string, queuedMode: 'conversation' | 'inner') {
    const stream = apiEventSource(`/api/unified-queue/tasks/${encodeURIComponent(taskId)}/stream`);
    queuedChatStreams.set(taskId, stream);

    const close = () => {
      stream.close();
      queuedChatStreams.delete(taskId);
    };

    stream.onmessage = (event) => {
      try {
        const { type, data } = parseConversationStreamEvent(event.data);
        if (type === 'queued_task_started') {
          pushComposedInput(userMessage, queuedMode);
          loading = true;
          thinkingTraceApi.setActive(true);
          thinkingTraceApi.setStatusLabel('Queued message started');
          thinkingTraceApi.setTrace([`Queued task ${taskId} started`]);
        } else if (type === 'queued') {
          thinkingTraceApi.setActive(true);
          thinkingTraceApi.setStatusLabel(`Queued behind ${Math.max(0, Number(data.position || 1) - 1)} task(s)`);
        } else if (type === 'progress' && data?.message) {
          thinkingTraceApi.setActive(true);
          thinkingTraceApi.appendTrace(String(data.message), 15);
        } else if (type === 'reasoning') {
          thinkingTraceApi.appendTrace(typeof data === 'string' ? data : String(data?.content || ''), 15);
        } else if (type === 'answer') {
          thinkingTraceApi.stop();
          pushGeneratedResponse(data.response, queuedMode, { facet: data.facet });
          loading = false;
          close();

        } else if (type === 'error') {
          thinkingTraceApi.stop();
          showChatError(data?.message || 'Queued message failed', `work-failure:${taskId}`, false);
          loading = false;
          close();

        } else if (type === 'queued_task_completed') {
          thinkingTraceApi.stop();
          loading = false;
          close();

        }
      } catch (err) {
        showChatError(err);
        loading = false;
        close();

      }
    };

    stream.onerror = () => {
      showChatError('Queued message stream disconnected.');
      loading = false;
      close();

    };
  }

  /**
   * Send a stateful Agency or Curiosity card reply through its focused graph.
   * Ordinary selected-message replies stay on the active conversation graph.
   */
  async function sendResponsePipeline(
    message: string,
    cardType: string,
    cardData: Record<string, any>,
    responseBufferId?: string | null
  ) {
    if (!message.trim()) return;

    const timestamp = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const startTime = Date.now();

    // Preserve original message for restoration on failure
    const originalMessage = message;

    // Add user message to UI
    pushComposedInput(message, 'conversation');

    loading = true;
    thinkingTraceApi.start();
    thinkingTraceApi.setStatusLabel(`🔍 Validating...`);
    thinkingTraceApi.setTrace([
      `[${timestamp()}] 📤 RESPONSE PIPELINE INITIATED`,
      `[${timestamp()}] Card type: ${cardType}`,
      `[${timestamp()}] Desire: ${cardData.desireTitle || cardData.desireId || 'N/A'}`,
      `[${timestamp()}] Multi-turn buffer: ${responseBufferId || 'creating new'}`,
      `[${timestamp()}] `,
      `[${timestamp()}] 🔍 PRE-FLIGHT CHECKS`,
    ]);

    // Heartbeat interval for long-running requests
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let connectionEstablished = false;

    // AbortController for cancellation
    let abortController = new AbortController();
    responsePipelineAbortController = abortController; // Store for cancel button

    // Helper to restore input and cleanup on failure
    const restoreInputAndCleanup = () => {
      input = originalMessage; // Restore the message to input field
      thinkingTraceApi.stop();
      loading = false;
    };

    try {
      // Step 0: Pre-flight validation
      console.log('[response-pipeline] Step 0: Pre-flight checks');

      chatResponseStream?.close();
      chatResponseStream = null;

      // Check 1: Session validity (NO TIMEOUT - but with progress notifications)
      try {
        console.log('[response-pipeline] Starting auth check at', new Date().toISOString());
        thinkingTraceApi.appendTrace(`[${timestamp()}] Checking session...`, 5);

        // Progress indicator to show we're waiting (NO TIMEOUT, just visibility)
        let notificationShown = false;
        const progressInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          console.log(`[response-pipeline] ⏳ Still waiting for auth check... (${elapsed}s)`);
          thinkingTraceApi.appendTrace(`[${timestamp()}] ⏳ Still checking session... (${elapsed}s)`, 3);

          // Show user notification after 10 seconds
          if (elapsed >= 10 && !notificationShown) {
            notificationShown = true;
            console.warn('[response-pipeline] ⚠️  AUTH CHECK TAKING LONGER THAN EXPECTED (>10s)');
            console.warn('[response-pipeline] This usually indicates:');
            console.warn('[response-pipeline]   1. Server is overloaded');
            console.warn('[response-pipeline]   2. Network connection is very slow');
            messagesApi.pushMessage('system', '⏳ **Session Check Taking Longer Than Expected**\n\nChecking your session is taking over 10 seconds. This is unusual and may indicate server load or network issues.\n\n**Status**: Still trying (no timeout)...\n**Your reply is preserved** and will be restored if this fails.');
          }

          // Escalate notification after 30 seconds
          if (elapsed >= 30) {
            console.error('[response-pipeline] ⚠️  AUTH CHECK EXTREMELY SLOW (>30s)');
            console.error('[response-pipeline] Consider:');
            console.error('[response-pipeline]   - Checking server logs for errors');
            console.error('[response-pipeline]   - Verifying network connection');
            console.error('[response-pipeline]   - Using browser DevTools Network tab to see what\'s stuck');
          }
        }, 5000);

        let authCheck: Response;
        try {
          console.log('[response-pipeline] Calling apiFetch(/api/auth/me)...');
          const authStartTime = Date.now();
          authCheck = await apiFetch('/api/auth/me');
          const authDuration = Date.now() - authStartTime;
          console.log(`[response-pipeline] Auth check completed in ${authDuration}ms:`, authCheck.status, authCheck.ok);

          if (authDuration > 5000) {
            console.warn(`[response-pipeline] ⚠️  AUTH CHECK WAS SLOW (${authDuration}ms)`);
          }
        } finally {
          clearInterval(progressInterval);
        }

        if (!authCheck.ok) {
          thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ SESSION EXPIRED`, 5);
          messagesApi.pushMessage('system', '⚠️ **Session Expired - Your Reply Was Not Sent**\n\nYour session has expired. Your message has been restored to the input field.\n\n💡 Please refresh the page, log in again, and resubmit your message.');
          restoreInputAndCleanup();
          return;
        }
        thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Session valid`, 5);
      } catch (authError: any) {
        console.error('[response-pipeline] Auth check error:', authError);

        let errorTitle = '⚠️ Connection Error - Your Reply Was Not Sent';
        let errorMessage = 'Unable to connect to the server.';
        let suggestion = 'Your message has been restored to the input field. Please check your network connection and try again.';

        // Differentiate error types (NO timeout handling - just real errors)
        if (authError?.message?.includes('fetch failed') || authError?.message?.includes('ECONNREFUSED')) {
          errorTitle = '🔌 Server Unreachable - Your Reply Was Not Sent';
          errorMessage = 'Cannot connect to the MetaHuman server.';
          suggestion = 'Your message has been restored. Check that the dev server is running with `pnpm dev` in apps/site/.';
        } else if (authError?.status === 404) {
          errorTitle = '🔍 Endpoint Not Found - Your Reply Was Not Sent';
          errorMessage = `API endpoint returned 404: ${authError?.url || '/api/auth/me'}`;
          suggestion = 'Your message has been restored. This may be a build issue. Try rebuilding with `pnpm build` in apps/site/.';
        } else if (authError?.status >= 500) {
          errorTitle = '💥 Server Error - Your Reply Was Not Sent';
          errorMessage = `Server returned error ${authError?.status || 'unknown'}`;
          suggestion = 'Your message has been restored. Check the server logs for details.';
        } else if (authError?.status === 401 || authError?.status === 403) {
          errorTitle = '🔐 Auth Check Failed - Your Reply Was Not Sent';
          errorMessage = 'Unable to verify your session.';
          suggestion = 'Your message has been restored. Your session may have expired. Please refresh and log in again.';
        } else {
          // Unknown error - show actual message
          errorMessage = authError?.message || 'An unexpected error occurred during authentication.';
          suggestion = 'Your message has been restored to the input field. Please try again.';
        }

        // Add context about what was being replied to
        const contextInfo = cardData.desireTitle
          ? `\n\n**You were replying to**: ${cardData.desireTitle}`
          : cardData.questionId
            ? '\n\n**You were replying to a question**'
            : '';

        thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ ${errorTitle}`, 5);
        messagesApi.pushMessage('system', `${errorTitle}\n\n${errorMessage}${contextInfo}\n\n💡 ${suggestion}`);
        void reportChatError(authError).catch(failure => console.error('[chat] Error evidence was not recorded:', failure));
        restoreInputAndCleanup();
        return;
      }

      // Check 3: Connection health
      thinkingTraceApi.appendTrace(`[${timestamp()}] Checking server connection...`, 5);
      const healthResult = await forceHealthCheck();
      if (!healthResult.connected) {
        thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ Server offline`, 5);
        messagesApi.pushMessage('system', '⚠️ **Server Offline - Your Reply Was Not Sent**\n\nThe server is not responding. Your message has been restored to the input field.\n\n💡 Please check if the server is running and try again.');
        restoreInputAndCleanup();
        return;
      }
      thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Server connected`, 5);
      thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Pre-flight checks passed`, 5);

      // Step 1: Prepare request
      console.log('[response-pipeline] Step 1: Preparing request', {
        cardType,
        desireId: cardData.desireId,
        hasBuffer: !!responseBufferId,
        messageLength: message.length,
      });
      thinkingTraceApi.setStatusLabel(`📝 Processing ${cardType} response...`);
      thinkingTraceApi.appendTrace(`[${timestamp()}] `, 5);
      thinkingTraceApi.appendTrace(`[${timestamp()}] Step 1: Preparing request...`, 10);

      const requestBody = buildResponsePipelineRequestBody(
        message,
        cardType,
        cardData,
        $conversationSessionId,
        responseBufferId,
      );

      // Step 2: Enqueue request (no automatic timeout - user has cancel button)
      console.log('[response-pipeline] Step 2: Queueing response pipeline task');
      thinkingTraceApi.appendTrace(`[${timestamp()}] Step 2: Queueing response...`, 10);
      thinkingTraceApi.appendTrace(`[${timestamp()}] ⏳ Waiting for queued response...`, 10);

      // Start heartbeat to show the system is alive
      heartbeatInterval = setInterval(() => {
        if (!connectionEstablished) return; // Don't show heartbeat until connection is established

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        thinkingTraceApi.appendTrace(`[${timestamp()}] ⏱️  Still processing... (${elapsed}s elapsed)`, 5);
      }, 10000); // Every 10 seconds

      const task = await enqueueUserMessageTask({
        kind: 'response-pipeline',
        responsePipeline: requestBody,
      });
      responsePipelineTaskId = task.id;

      const result: any = await new Promise((resolve, reject) => {
        const stream = apiEventSource(`/api/unified-queue/tasks/${encodeURIComponent(task.id)}/stream`);
        queuedChatStreams.set(task.id, stream);

        const cleanup = () => {
          stream.close();
          queuedChatStreams.delete(task.id);
          abortController.signal.removeEventListener('abort', onAbort);
        };

        const onAbort = () => {
          cleanup();
          const error = new Error('Request cancelled by user');
          error.name = 'AbortError';
          reject(error);
        };

        abortController.signal.addEventListener('abort', onAbort, { once: true });

        stream.onopen = () => {
          connectionEstablished = true;
          thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Queue stream connected`, 10);
        };

        stream.onmessage = (event) => {
          try {
            const { type, data } = parseConversationStreamEvent(event.data);

            if (type === 'queued_task_started') {
              connectionEstablished = true;
              thinkingTraceApi.setStatusLabel(`📝 Processing ${cardType} response...`);
              thinkingTraceApi.appendTrace(`[${timestamp()}] Queued task started`, 10);
            } else if (type === 'queued') {
              const ahead = Math.max(0, Number(data.position || 1) - 1);
              thinkingTraceApi.setStatusLabel(`Queued behind ${ahead} task(s)`);
              thinkingTraceApi.appendTrace(`[${timestamp()}] Waiting in queue: position ${data.position || '?'}`, 5);
            } else if (type === 'progress') {
              connectionEstablished = true;
              if (data?.message) {
                thinkingTraceApi.appendTrace(`[${timestamp()}] ${data.message}`, 5);
              }
            } else if (type === 'answer') {
              cleanup();
              resolve({
                success: true,
                response: data.response,
                responseBufferId: data.responseBufferId,
                actionTaken: data.actionTaken,
                pipelineTriggered: data.pipelineTriggered,
                nextStatus: data.nextStatus,
                executionTimeMs: data.executionTime,
              });
            } else if (type === 'error') {
              cleanup();
              reject(new Error(data?.message || 'Response pipeline failed'));
            }
          } catch (streamError) {
            cleanup();
            reject(streamError);
          }
        };

        stream.onerror = () => {
          cleanup();
          reject(new Error('Queued response pipeline stream disconnected'));
        };
      });

      console.log('[response-pipeline] Step 3: Queued response received', {
        elapsed: Date.now() - startTime,
      });
      thinkingTraceApi.appendTrace(`[${timestamp()}] Step 3: Queued response received`, 10);

      const elapsed = Date.now() - startTime;
      console.log('[response-pipeline] Step 5: Processing result', {
        success: result.success,
        actionTaken: result.actionTaken,
        pipelineTriggered: result.pipelineTriggered,
        newBufferId: result.responseBufferId,
        executionTimeMs: result.executionTimeMs,
        totalElapsed: elapsed,
      });
      thinkingTraceApi.appendTrace(`[${timestamp()}] Step 5: Result received (${elapsed}ms total)`, 10);

      if (!result.success) {
        console.error('[response-pipeline] Pipeline returned error:', result.error);
        console.error('[response-pipeline] Error details:', {
          error: result.error,
          errorDetails: result.errorDetails,
          failedNode: result.failedNode,
          suggestion: result.suggestion,
        });

        // Build detailed error message
        let errorMessage = `⚠️ **Pipeline Error**\n\n${result.error}`;

        if (result.errorDetails) {
          errorMessage += `\n\n**Details**: ${result.errorDetails}`;
        }

        if (result.failedNode) {
          errorMessage += `\n\n**Failed at node**: ${result.failedNode}`;
        }

        if (result.suggestion) {
          errorMessage += `\n\n💡 **Suggestion**:\n${result.suggestion}`;
        }

        // Show in thinking trace
        thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ ${result.error}`, 10);
        if (result.failedNode) {
          thinkingTraceApi.appendTrace(`[${timestamp()}] 🔍 Failed at: ${result.failedNode}`, 10);
        }

        // Show to user
        messagesApi.pushMessage('system', errorMessage);

        throw new Error(result.error || 'Pipeline execution failed');
      }

      // Add assistant response to UI with response pipeline metadata
      if (result.response) {
        pushGeneratedResponse(result.response, 'conversation', {
          source: 'response_pipeline',
          cardType,
          desireId: cardData.desireId,
          responseBufferId: result.responseBufferId,
          actionTaken: result.actionTaken,
          pipelineTriggered: result.pipelineTriggered,
          dialogueSource: 'response-pipeline',
        });
      } else {
        console.warn('[response-pipeline] No response text in result');
        thinkingTraceApi.appendTrace(`[${timestamp()}] ⚠️ No response text returned`, 10);
      }

      // Update thinking trace with result
      thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Action: ${result.actionTaken || 'completed'}`, 10);
      if (result.pipelineTriggered) {
        thinkingTraceApi.appendTrace(`[${timestamp()}] 🔄 Downstream Desire work queued`, 10);
      }
      if (result.nextStatus) {
        thinkingTraceApi.appendTrace(`[${timestamp()}] 📊 Status → ${result.nextStatus}`, 10);
      }
      thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ RESPONSE PIPELINE COMPLETE (${elapsed}ms)`, 10);

      thinkingTraceApi.stop();
    } catch (err) {
      const elapsed = Date.now() - startTime;

      if (err instanceof Error && err.name === 'AbortError') {
        thinkingTraceApi.appendTrace(`[${timestamp()}] ⏸️  Request cancelled by user`, 10);
        messagesApi.pushMessage('system', '⏸️ **Request Cancelled**\n\nYou cancelled the response pipeline request.');
        thinkingTraceApi.stop();
        return;
      }

      console.error('[response-pipeline] FATAL ERROR:', err);
      console.error('[response-pipeline] Error details:', {
        name: err instanceof Error ? err.name : 'unknown',
        message: err instanceof Error ? err.message : String(err),
        elapsed,
      });
      const errorMsg = err instanceof Error ? err.message : 'Response pipeline failed';
      thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ ERROR: ${errorMsg}`, 10);
      thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ PIPELINE FAILED after ${elapsed}ms`, 10);
      showChatError(err);
      thinkingTraceApi.stop();
    } finally {
      // Clear heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      // Clear abort controller
      responsePipelineAbortController = null;
      responsePipelineTaskId = null;

      loading = false;

    }
  }

  async function sendMessage() {
    // No input - nothing to do
    if (!input.trim()) return;

    if (!composeTarget) { showTransientSystemMessage('The selected view is read-only.'); return; }

    // Already processing a send - ignore
    if (sendInProgress) return;

    if (composeTarget === 'terminal') {
      if (!$isOwner) { showTransientSystemMessage('Terminal access is restricted to the installation owner.'); return; }
      sendInProgress = true;
      const message = input;
      try {
        await terminalChat.send(message);
        if (input === message) input = '';
      } catch (error) { showTransientSystemMessage((error as Error).message); void reportChatError(error).catch(failure => console.error('[chat] Error evidence was not recorded:', failure)); }
      finally { sendInProgress = false; }
      return;
    }

    sendInProgress = true;
    await interruptAssistantSpeech('user-input');

    const healthResult = await forceHealthCheck();
    const connected = healthResult.connected;

    // Chat execution is server-owned. Keep the draft intact when disconnected.
    if (!connected) {
      sendInProgress = false;

      messagesApi.pushMessage('system', '⚠️ MetaHuman server is unavailable. Reconnect before sending this message.');
      return;
    }

    await ttsApi.ensureAudioUnlocked();
    if (ttsEnabled) {
      ttsApi.prefetchVoiceResources();
    }

    // Signal activity when sending a message
    activityApi.signalActivity();

    const userMessage = input.trim();
    const requestComposeTarget = mode;
    input = '';

    // Capture replyTo metadata if any message is selected
    const replyToMetadata = messagesApi.getReplyToMetadata();
    const replyToQuestionId = replyToMetadata.questionId;
    const replyToContent = replyToMetadata.content;
    const replyToDesireId = replyToMetadata.desireId;
    const replyToDesireTitle = replyToMetadata.desireTitle;
    const replyToCardType = replyToMetadata.cardType;
    const replyToDialogueSource = replyToMetadata.dialogueSource;
    const isAgencyCardReply = replyToMetadata.isAgencyMessage;
    const existingResponseBufferId = replyToMetadata.responseBufferId;

    // Clear selection after capturing metadata
    const wasReplying = $selectedMessage !== null;
    messagesApi.clearSelection();

    const responsePipelineCardType = responsePipelineCardTypeForReply({
      cognitiveMode: $currentMode,
      cardType: replyToCardType,
      questionId: replyToQuestionId,
      desireId: replyToDesireId,
      dialogueSource: replyToDialogueSource,
      isAgencyMessage: isAgencyCardReply,
    });

    // Dedicated interactive cards keep their focused workflow. An ordinary
    // selected-message reply in Environment mode stays on the Environment graph,
    // which already receives replyToContent and owns semantic action decisions.
    if (
      wasReplying
      && replyToContent
      && requestComposeTarget === 'conversation'
      && responsePipelineCardType
    ) {
      sendInProgress = false; // Reset guard before delegating

      console.log(`[sendMessage] Routing to response pipeline: type=${responsePipelineCardType}, hasDesire=${!!replyToDesireId}`);

      await sendResponsePipeline(userMessage, responsePipelineCardType, {
        desireId: replyToDesireId,
        desireTitle: replyToDesireTitle,
        content: replyToContent,
        dialogueSource: replyToDialogueSource,
        questionId: replyToQuestionId,
        ...replyToMetadata.meta,
      }, existingResponseBufferId);
      return;
    }

    if (loading) {
      try {
        const llm_opts = readLlmOptions();
        const params = buildConversationParams({
          message: userMessage,
          mode: requestComposeTarget,
          sessionId: $conversationSessionId,
          reasoningDepth,
          yoloMode,
          llmOptions: llm_opts,
          replyTo: {
            questionId: replyToQuestionId || undefined,
            content: replyToContent || undefined,
            desireId: replyToDesireId || undefined,
            desireTitle: replyToDesireTitle || undefined,
          },
        });
        const task = await enqueueUserMessageTask({
          kind: 'persona-chat',
          personaChat: Object.fromEntries(params.entries()),
        });
        openQueuedBackgroundStream(task.id, userMessage, requestComposeTarget);
      } catch (err) {
        input = userMessage;
        showChatError(err);
      } finally {
        sendInProgress = false;
      }
      return;
    }

    pushComposedInput(userMessage, requestComposeTarget);

    loading = true;
    sendInProgress = false; // loading now takes over as the guard
    reasoningStages = [];

    // Timestamp helper for detailed trace
    const timestamp = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const msgStartTime = Date.now();

    // Show detailed timestamped information IMMEDIATELY
    thinkingTraceApi.setStatusLabel('📤 Sending message...');
    thinkingTraceApi.setTrace([
      `[${timestamp()}] 📤 MESSAGE SENT`,
      `[${timestamp()}] Content: "${userMessage.substring(0, 60)}${userMessage.length > 60 ? '...' : ''}"`,
    ]);
    thinkingTraceApi.setActive(true);
    console.log('[sendMessage] Step 1: Set loading state');

    try {
      console.log('[sendMessage] Step 2: Entered try block');
      thinkingTraceApi.appendTrace(`[${timestamp()}] ⏳ Preparing request...`, 15);

      const llm_opts = readLlmOptions();
      console.log('[sendMessage] Step 3: Got llm_opts');

      const params = buildConversationParams({
        message: userMessage,
        mode: requestComposeTarget,
        sessionId: $conversationSessionId,
        reasoningDepth,
        yoloMode,
        llmOptions: llm_opts,
        replyTo: {
          questionId: replyToQuestionId || undefined,
          content: replyToContent || undefined,
          desireId: replyToDesireId || undefined,
          desireTitle: replyToDesireTitle || undefined,
        },
      });
      console.log('[sendMessage] Step 4: Created URLSearchParams');
      thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Request params built`, 15);
      // audience removed - focus selector obsolete with ReAct operator

      // Add replyTo metadata if replying to any message (curiosity, desire, or regular)
      if (replyToQuestionId) {
        console.log('[reply-to] Replying to curiosity question:', replyToQuestionId);
      }
      if (replyToDesireId) {
        console.log('[reply-to] Replying to desire/goal:', replyToDesireId, replyToDesireTitle);
      }
      if (replyToContent) {
        console.log('[reply-to] Replying to message:', replyToContent.substring(0, 100));
      }

      console.log('[sendMessage] Step 5: Queueing chat request');
      thinkingTraceApi.appendTrace(`[${timestamp()}] 🌐 Queueing message`, 15);



      // PRE-FLIGHT AUTH CHECK: Verify session is valid before opening EventSource
      // This prevents silent hangs when session cookie is stale/mismatched
      // NO TIMEOUT - User has cancel button, let the server take as long as it needs
      try {
        console.log('[sendMessage] Starting auth check...');
        thinkingTraceApi.appendTrace(`[${timestamp()}] 🔐 Verifying session...`, 15);

        // Progress notifications (same as response pipeline)
        let notificationShown = false;
        const authProgressInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - msgStartTime) / 1000);
          console.log(`[sendMessage] ⏳ Still waiting for auth check... (${elapsed}s)`);
          thinkingTraceApi.appendTrace(`[${timestamp()}] ⏳ Still checking session... (${elapsed}s)`, 10);

          if (elapsed >= 10 && !notificationShown) {
            notificationShown = true;
            console.warn('[sendMessage] ⚠️  AUTH CHECK TAKING LONGER THAN EXPECTED (>10s)');
            messagesApi.pushMessage(
              'system',
              '⏳ **Session Check Slow**\n\nVerifying your session is taking longer than expected (>10s). Still trying...',
            );
          }

          if (elapsed >= 30) {
            console.error('[sendMessage] ⚠️  AUTH CHECK EXTREMELY SLOW (>30s)');
          }
        }, 5000);

        let authCheck: Response;
        try {
          const authStartTime = Date.now();
          authCheck = await apiFetch('/api/auth/me');
          const authDuration = Date.now() - authStartTime;
          console.log(`[sendMessage] Auth check completed in ${authDuration}ms:`, authCheck.status);

          if (authDuration > 5000) {
            console.warn(`[sendMessage] ⚠️  AUTH CHECK WAS SLOW (${authDuration}ms)`);
          }
        } finally {
          clearInterval(authProgressInterval);
        }

        if (!authCheck.ok) {
          const errorData = await authCheck.json().catch(() => ({}));
          console.error('[sendMessage] Auth check failed:', authCheck.status, errorData);
          thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ SESSION EXPIRED - Please refresh and log in again`, 15);
          thinkingTraceApi.setStatusLabel('🔒 Session Expired');
          loading = false;
          // Show error to user
          messagesApi.pushMessage(
            'system',
            '⚠️ **Session Expired**\n\nYour session has expired or is invalid. Please refresh the page and log in again.',
          );
          return;
        }
        console.log('[sendMessage] Auth check passed');
        thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Session verified`, 15);
      } catch (authError: any) {
        // Differentiate error types for better logging and debugging
        let errorType = 'Unknown Error';
        let shouldContinue = false;

        if (authError?.message?.includes('fetch failed') || authError?.message?.includes('ECONNREFUSED')) {
          errorType = 'Server Unreachable';
          shouldContinue = false;
          console.error('[sendMessage] Server unreachable:', authError);
          thinkingTraceApi.appendTrace(`[${timestamp()}] 🔌 Server unreachable (will likely fail)`, 15);
        } else if (authError?.status === 404) {
          errorType = 'Endpoint Not Found (404)';
          shouldContinue = false;
          console.error('[sendMessage] Auth endpoint not found:', authError);
          thinkingTraceApi.appendTrace(`[${timestamp()}] 🔍 Auth endpoint not found (build issue?)`, 15);
        } else if (authError?.status >= 500) {
          errorType = `Server Error (${authError?.status})`;
          shouldContinue = false;
          console.error('[sendMessage] Server error during auth check:', authError);
          thinkingTraceApi.appendTrace(`[${timestamp()}] 💥 Server error ${authError?.status}`, 15);
        } else if (authError?.status === 401 || authError?.status === 403) {
          errorType = 'Session Invalid';
          shouldContinue = false;
          console.error('[sendMessage] Session invalid:', authError);
          thinkingTraceApi.appendTrace(`[${timestamp()}] 🔐 Session invalid (please refresh)`, 15);
        } else {
          errorType = authError?.message || 'Unexpected error';
          shouldContinue = true; // Try anyway for unknown errors
          console.error('[sendMessage] Auth check error:', authError);
          thinkingTraceApi.appendTrace(`[${timestamp()}] ⚠️ Could not verify session (${errorType})`, 15);
        }

        // Continue anyway - might work, might not
        // (EventSource will fail with better error if server is truly down)
      }

      // Use EventSource for SSE streaming (works for both web and React Native WebView)
      // CRITICAL: Close any existing EventSource before creating a new one
      if (chatResponseStream) {
        console.log('[sendMessage] Closing existing EventSource...');
        chatResponseStream.close();
        chatResponseStream = null;
      }

      const task = await enqueueUserMessageTask({
        kind: 'persona-chat',
        personaChat: Object.fromEntries(params.entries()),
      });
      activeChatTaskId = task.id;
      chatResponseStream = apiEventSource(`/api/unified-queue/tasks/${encodeURIComponent(task.id)}/stream`);
      console.log('[sendMessage] Step 6: EventSource created!');
      thinkingTraceApi.appendTrace(`[${timestamp()}] 🔌 EventSource created, waiting for server...`, 15);
      thinkingTraceApi.setStatusLabel('🔌 Connecting...');

      // Track connection time for user visibility
      const connectStart = Date.now();
      let connectionTimer: ReturnType<typeof setInterval> | null = null;
      let connectionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
      let connectionEstablished = false;

      const clearConnectionTracking = () => {
        if (connectionTimer) {
          clearInterval(connectionTimer);
          connectionTimer = null;
        }
        if (connectionFallbackTimer) {
          clearTimeout(connectionFallbackTimer);
          connectionFallbackTimer = null;
        }
      };

      // If the browser cannot acquire an SSE connection promptly, stop waiting
      // on that transport and follow the server-owned task by status instead.
      // The task continues independently, so this cannot duplicate the message.
      connectionFallbackTimer = setTimeout(() => {
        if (!connectionEstablished && activeChatTaskId === task.id) {
          console.warn('[EventSource] Live stream delayed; switching to task reconciliation');
          chatResponseStream?.close();
          chatResponseStream = null;
          clearConnectionTracking();
          thinkingTraceApi.appendTrace(`[${timestamp()}] Live response delayed; following accepted task ${task.id}`, 15);
          thinkingTraceApi.setStatusLabel('🔄 Following accepted message...');
          void reconcileQueuedChatTask(task.id);
        }
      }, 8000);

      // Start timer to show elapsed time WITH timestamps
      connectionTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - connectStart) / 1000);
        const totalElapsed = Math.floor((Date.now() - msgStartTime) / 1000);
        thinkingTraceApi.appendTrace(`[${timestamp()}] ⏱️ Waiting for server response... (${elapsed}s)`, 15);
      }, 2000);

      chatResponseStream.onopen = () => {
        connectionEstablished = true;
        if (connectionFallbackTimer) {
          clearTimeout(connectionFallbackTimer);
          connectionFallbackTimer = null;
        }
        console.log('[EventSource] Connection opened!');
        if (connectionTimer) clearInterval(connectionTimer);
        const elapsed = Math.floor((Date.now() - connectStart) / 1000);
        thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ CONNECTION OPENED (${elapsed}s)`, 15);
        thinkingTraceApi.setStatusLabel('⚡ Connected - Executing graph...');
      };

      chatResponseStream.onmessage = (event) => {
        connectionEstablished = true;
        if (connectionFallbackTimer) {
          clearTimeout(connectionFallbackTimer);
          connectionFallbackTimer = null;
        }
        if (connectionTimer) clearInterval(connectionTimer);
        console.log('[EventSource] onmessage fired, raw event.data:', event.data.substring(0, 200));
        thinkingTraceApi.appendTrace(`[${timestamp()}] 📥 Received server event`, 15);
        try {
          const { type, data } = parseConversationStreamEvent(event.data);
          console.log('[EventSource] Parsed type:', type, 'data keys:', Object.keys(data));

          if (type === 'progress') {
            // Real-time progress updates from graph execution
            if (data && data.message) {
              thinkingTraceApi.setActive(true);

              // Update the thinking trace with progress messages - ALL WITH TIMESTAMPS
              const progressMsg = data.message;
              console.log('[Progress Event] step:', data.step, 'message:', progressMsg.substring(0, 100));

              if (data.step === 'loading_graph') {
                thinkingTraceApi.setStatusLabel('📋 Loading workflow...');
                thinkingTraceApi.appendTrace(`[${timestamp()}] 📋 ${progressMsg}`, 15);
              } else if (data.step === 'graph_loaded') {
                thinkingTraceApi.setStatusLabel('📊 Graph loaded');
                thinkingTraceApi.appendTrace(`[${timestamp()}] 📊 ${progressMsg}`, 15);
              } else if (data.step === 'graph_starting') {
                thinkingTraceApi.setStatusLabel('⚡ Executing graph...');
                thinkingTraceApi.appendTrace(`[${timestamp()}] ⚡ ${progressMsg}`, 15);
              } else if (data.step === 'node_executing') {
                thinkingTraceApi.setStatusLabel('🔄 Processing...');
                thinkingTraceApi.appendTrace(`[${timestamp()}] ▸ ${progressMsg}`, 15);
              } else if (data.step === 'thinking') {
                // Show actual AI thoughts from scratchpad
                console.log('[Thinking Event] Appending to trace:', progressMsg.substring(0, 150));
                thinkingTraceApi.setStatusLabel('🧠 Thinking...');
                thinkingTraceApi.appendTrace(`[${timestamp()}] 💭 ${progressMsg}`, 15);
              } else if (data.step === 'node_error') {
                thinkingTraceApi.setStatusLabel('⚠️ Error detected...');
                thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ ERROR: ${progressMsg}`, 15);
              } else if (data.step === 'graph_complete') {
                // Graph execution completed, waiting for final answer
                thinkingTraceApi.setStatusLabel('✓ Completed, finalizing...');
                thinkingTraceApi.appendTrace(`[${timestamp()}] ✓ ${progressMsg}`, 15);
              } else if (data.step?.startsWith('big_brother_')) {
                // Big Brother status updates - show prominent status WITH TIMESTAMPS
                if (data.step === 'big_brother_init') {
                  thinkingTraceApi.setStatusLabel('🤖 Big Brother initializing...');
                  thinkingTraceApi.appendTrace(`[${timestamp()}] 🤖 Big Brother: Initializing...`, 15);
                } else if (data.step === 'big_brother_ready') {
                  thinkingTraceApi.setStatusLabel('🤖 Big Brother ready');
                  thinkingTraceApi.appendTrace(`[${timestamp()}] 🤖 Big Brother: Ready`, 15);
                } else if (data.step === 'big_brother_sending') {
                  thinkingTraceApi.setStatusLabel('📤 Sending to Big Brother...');
                  thinkingTraceApi.appendTrace(`[${timestamp()}] 📤 Big Brother: Sending prompt...`, 15);
                } else if (data.step === 'big_brother_executing') {
                  thinkingTraceApi.setStatusLabel('⚙️ Big Brother working...');
                  thinkingTraceApi.appendTrace(`[${timestamp()}] ⚙️ Big Brother: Executing...`, 15);
                } else if (data.step === 'big_brother_complete') {
                  thinkingTraceApi.setStatusLabel('✅ Big Brother complete');
                  thinkingTraceApi.appendTrace(`[${timestamp()}] ✅ Big Brother: Complete`, 15);
                } else if (data.step === 'big_brother_error') {
                  thinkingTraceApi.setStatusLabel('❌ Big Brother error');
                  thinkingTraceApi.appendTrace(`[${timestamp()}] ❌ Big Brother: ERROR`, 15);
                }
                thinkingTraceApi.appendTrace(`[${timestamp()}] ${progressMsg}`, 15);
              } else {
                // Generic progress update
                thinkingTraceApi.appendTrace(`[${timestamp()}] ${progressMsg}`, 15);
              }
            }
          } else if (type === 'cancelled') {
            // Request was cancelled by user
            clearConnectionTracking();
            activeChatTaskId = null;
            thinkingTraceApi.stop();
            messagesApi.pushMessage('system', data.message || '⏸️ Request cancelled');
            loading = false;
            reasoningStages = [];
            chatResponseStream?.close();
            chatResponseStream = null;

          } else if (type === 'reasoning') {
            thinkingTraceApi.stop();
            if (typeof data === 'string') {
              reasoningStages = [
                {
                  round: 1,
                  stage: 'plan',
                  content: data,
                  timestamp: Date.now(),
                },
              ];
            } else if (data && typeof data === 'object') {
              const stageObj: ReasoningStage = {
                round: Number(data.round) > 0 ? Number(data.round) : 1,
                stage: String(data.stage || 'plan'),
                content: String(data.content || ''),
                timestamp: Date.now(),
              };
              reasoningStages = [...reasoningStages, stageObj];
            }
          } else if (type === 'answer') {
            clearConnectionTracking();
            activeChatTaskId = null;
            thinkingTraceApi.stop();
            if (reasoningStages.length > 0) {
              // Only persist reasoning to messages in inner dialogue mode
              // Persisted reasoning arrives only from the Inner Dialogue Buffer stream.
              reasoningStages = [];
            }
            pushGeneratedResponse(data.response, requestComposeTarget, { facet: data.facet });

            loading = false;
            chatResponseStream?.close();
            chatResponseStream = null;

          } else if (type === 'queued_task_completed') {
            clearConnectionTracking();
            activeChatTaskId = null;
            thinkingTraceApi.stop();
            loading = false;
            reasoningStages = [];
            chatResponseStream?.close();
            chatResponseStream = null;

          } else if (type === 'system_message') {
            // System status message (e.g., summarization progress)
            if (data.content) {
              messagesApi.pushMessage('system', data.content);
            }
          } else if (type === 'error') {
            clearConnectionTracking();
            activeChatTaskId = null;
            // Display the actual error message from the server
            const errorMessage = data.message || 'Unknown error occurred';
            const suggestion = data.suggestion || '';
            const isGPUError = data.isGPUError || errorMessage.includes('GPU') || errorMessage.includes('memory');

            console.error('[chat] Server error:', errorMessage);

            // Format user-friendly error message
            let displayMessage = `⚠️ ${errorMessage}`;
            if (suggestion) {
              displayMessage += `\n\n💡 ${suggestion}`;
            } else if (isGPUError) {
              displayMessage += '\n\n💡 Try refreshing the page or wait a moment for GPU memory to clear.';
            }

            messagesApi.pushMessage('system', displayMessage);
            thinkingTraceApi.stop();
            loading = false;
            reasoningStages = [];
            chatResponseStream?.close();
            chatResponseStream = null;

            return; // Don't throw, we handled it
          }
          // Note: Big Brother output is streamed to System Terminal's Big Brother tab via WebSocket
        } catch (err) {
          console.error('Chat stream error:', err);
          clearConnectionTracking();
          activeChatTaskId = null;
          showChatError(err);
          thinkingTraceApi.stop();
          loading = false;
          reasoningStages = [];
          chatResponseStream?.close();
          chatResponseStream = null;

        }
      };

      chatResponseStream.onerror = async (err) => {
        if (activeChatTaskId !== task.id) return;
        console.error('[EventSource] onerror fired! Error:', err);
        console.error('[EventSource] ReadyState:', chatResponseStream?.readyState);
        clearConnectionTracking();
        chatResponseStream?.close();
        chatResponseStream = null;

        // Force a health check to get accurate connection status
        const healthResult = await forceHealthCheck();

        // Once the server has accepted the queued message, never resubmit it
        // through another tier: that can create a duplicate answer. Reconcile
        // the accepted task when possible and let buffers resync after restart.
        if (!healthResult.connected) {
          console.log('[EventSource] Server went offline after accepting queued message');
          activeChatTaskId = null;
          thinkingTraceApi.stop();
          loading = false;
          reasoningStages = [];
          messagesApi.pushMessage('system', 'The server accepted your message, but the live connection was lost. Its saved result will appear when the server reconnects.');

          return;
        }

        thinkingTraceApi.setActive(true);
        thinkingTraceApi.setStatusLabel('🔄 Reconnecting to accepted message...');
        thinkingTraceApi.appendTrace('Live response stream disconnected; the server task is still running.', 15);
        void reconcileQueuedChatTask(task.id);
      };

    } catch (err) {
      console.error('Chat setup error:', err);
      if (activeChatTaskId) {
        thinkingTraceApi.setActive(true);
        thinkingTraceApi.setStatusLabel('🔄 Following accepted message...');
        thinkingTraceApi.appendTrace('The live response could not open; checking the accepted server task.', 15);
        void reconcileQueuedChatTask(activeChatTaskId);
        sendInProgress = false;
        return;
      }
      showChatError(err);
      thinkingTraceApi.stop();
      loading = false;
      sendInProgress = false; // Safety net: ensure guard is reset on error
      reasoningStages = [];

    }
  }

  /**
   * Stop/cancel the current request
   * Aborts both client-side fetch and notifies server
   */
  async function stopRequest() {
    if (!loading) return;

    console.log('[stop-request] Stopping request...');
    const queuedResponseTaskId = responsePipelineTaskId;

    // 1. Abort client-side fetch immediately
    if (responsePipelineAbortController) {
      console.log('[stop-request] Aborting client-side fetch');
      responsePipelineAbortController.abort();
      responsePipelineAbortController = null;
    }

    // 2. Cancel the canonical Work Coordinator item so its AbortSignal reaches
    // the graph executor even if the browser stream has already closed.
    if (queuedResponseTaskId) {
      try {
        const response = await apiFetch(`/api/unified-queue/tasks/${encodeURIComponent(queuedResponseTaskId)}`, {
          method: 'DELETE',
        });
        if (!response.ok && response.status !== 409) {
          console.error('[stop-request] Failed to cancel queued response task:', await response.text());
        }
      } catch (error) {
        console.error('[stop-request] Error cancelling queued response task:', error);
      }
    }

    // 3. Cancel any visible terminal-provider session correlated to this turn.
    if ($conversationSessionId) {
      try {
        console.log('[stop-request] Requesting server-side cancellation for session:', $conversationSessionId);
        const response = await apiFetch('/api/cancel-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: $conversationSessionId,
            reason: 'User clicked stop button'
          })
        });

        if (!response.ok) {
          console.error('[stop-request] Failed to cancel:', await response.text());
        } else {
          console.log('[stop-request] Server-side cancellation requested successfully');
        }
      } catch (error) {
        console.error('[stop-request] Error requesting server-side cancellation:', error);
      }
    }
  }

  // Activity tracking for sleep service

  async function handleKeyPress(e: KeyboardEvent) {
    // Signal activity on key press
    activityApi.signalActivity();

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await sendMessage();
    }
  }

  async function handleDelete(relPath: string) {
    const success = await messagesApi.deleteMessage(relPath);
    if (!success) {
      alert('Failed to delete message');
    }
  }

  function toggleView(view: BufferView, include = false) {
    const newSet = new Set(selectedViews);

    if (newSet.has(view)) {
      if (include) return;
      // Can't deselect if it's the only one
      if (newSet.size > 1) {
        newSet.delete(view);
      }
    } else {
      newSet.add(view);
    }

    selectedViews = newSet;

    // Initial selection is read on mount; later changes replace the same reader.
    if (bufferStream) connectMultipleBufferStreams();
  }

  // One transport preserves the separate canonical buffer projections.
  function connectMultipleBufferStreams() {
    disconnectAllBufferStreams();
    if (typeof document !== 'undefined' && document.hidden) return;
    const modes: string[] = [...selectedViews];
    if (selectedViews.has('system')) modes.push('robot');
    if (!modes.length) return;
    const source = apiEventSource(`/api/buffer-stream?mode=${modes.join(',')}`);
    bufferStream = source;
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'error') {
          showChatError(`Buffer update failed (${data.mode || 'connection'}): ${data.error}`);
        } else if (data.type === 'update' && Array.isArray(data.messages)) {
          messages.update(msgs => replaceBufferSlice(msgs, data.mode, data.messages));
        } else if (data.type === 'conversation' && data.message) {
          liveConversationMessages = receiveLiveConversation(liveConversationMessages, data.message);
        }
      } catch (error) {
        showChatError(error);
      }
    };
    source.onerror = (error) => {
      console.error('[chat] Buffer stream disconnected; reconnecting', error);
    };
  }

  async function cycleActiveOperatorMode() {
    if (activeOperatorLoading) return;
    const nextMode = nextAutonomyMode(autonomyMode);
    if (nextMode === 'full' && !confirm('Enable fully autonomous mode? Active Operator may admit completion-driven robot workflow chains.')) return;
    activeOperatorLoading = true;
    try {
      await setActiveOperatorMode(nextMode);
      autonomyMode = nextMode;
      console.log('[active-operator] Mode changed to:', nextMode);
    } catch (error) {
      console.error('[active-operator] Error changing mode:', error);
    } finally {
      activeOperatorLoading = false;
    }
  }

  async function handleValidate(relPath: string, status: 'correct' | 'incorrect') {
    try {
      const res = await apiFetch('/api/memories/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath, status }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to validate');
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function clearChat() {
    reasoningStages = [];
    thinkingTraceApi.stop();

    const target = composeTarget;
    if (!target) return;

    // Terminal history has its own session identity, owned by the terminal service.
    if (target !== 'terminal') {
      try {
        const newId = messagesApi.generateSessionId();
        localStorage.setItem('mh_conversation_session_id', newId);
      } catch {
        messagesApi.generateSessionId();
      }
    }

    // Clear only the explicit compose target. Read-tab selection never decides
    // which canonical buffer is mutated.
    const serverCleared = await messagesApi.clearServerBuffer();
    if (serverCleared) {
      if (target === 'conversation') liveConversationMessages = [];
      messages.update(current => replaceBufferSlice(current, target, []));
      console.log(`[ChatInterface] ${target} buffer cleared successfully`);
    } else {
      console.warn(`[ChatInterface] Failed to clear ${target} buffer`);
    }
  }

</script>

<div class="chat-interface">
  <!-- Header with all controls -->
  <div class="mode-toggle-container sm:gap-3">
    <!-- Mode Toggle Buttons (VS Code-style multi-select) -->
    <div class="mode-toggle">
      <button
        class="mode-btn {selectedViews.has('conversation') ? 'active' : ''}"
        on:click={() => toggleView('conversation')}
        aria-pressed={selectedViews.has('conversation')}
        aria-label="Toggle conversation view"
        title="Toggle Conversation buffer (can combine with other views)"
      >
        <span class="mode-icon" aria-hidden="true">💬</span>
        <span class="mode-label">Conversation</span>
      </button>
      <button
        class="mode-btn {selectedViews.has('inner') ? 'active' : ''}"
        on:click={() => toggleView('inner')}
        aria-pressed={selectedViews.has('inner')}
        aria-label="Toggle inner dialogue view"
        title="Toggle Inner Dialogue buffer (can combine with other views)"
      >
        <span class="mode-icon" aria-hidden="true">💭</span>
        <span class="mode-label">Inner Dialogue</span>
      </button>
      <button
        class="mode-btn {selectedViews.has('system') ? 'active' : ''}"
        on:click={() => toggleView('system')}
        aria-pressed={selectedViews.has('system')}
        aria-label="Toggle system view"
        title="Toggle merged System and Robot Buffer feed"
      >
        <span class="mode-icon" aria-hidden="true">💻</span>
        <span class="mode-label">System</span>
      </button>
      <button
        class="mode-btn {selectedViews.has('terminal') ? 'active' : ''}"
        on:click={() => toggleView('terminal')}
        aria-pressed={selectedViews.has('terminal')}
        aria-label="Toggle terminal view"
        title="Toggle Terminal buffer (can combine with other views)"
      >
        <span class="mode-icon" aria-hidden="true">⌨️</span>
        <span class="mode-label">Terminal</span>
      </button>
    </div>

    <!-- Active Operator Toggle -->
    <button
      class="active-operator-toggle {activeOperatorMode.buttonClass}"
      class:loading={activeOperatorLoading}
      title={`${activeOperatorMode.label}: ${activeOperatorMode.description} Click to advance mode.`}
      aria-label={`Active Operator ${activeOperatorMode.label}. ${activeOperatorMode.description}`}
      on:click={cycleActiveOperatorMode}
      disabled={activeOperatorLoading}
    >
      <span class="active-operator-icon">⚡</span>
      <span class="active-operator-badge">{activeOperatorMode.badge}</span>
    </button>

    <!-- Speech admission and destination use the saved Voice Settings. -->
    <div class="quick-audio">
      <button
        class="icon-btn {ttsEnabled ? 'tts-active' : ''}"
        title={`Speech: ${speechOutputLabel}. Click to switch to ${nextSpeechOutputState(speechOutput) === 'off' ? 'Off' : nextSpeechOutputState(speechOutput) === 'browser' ? 'Browser' : 'Body Control'}.`}
        aria-label={`Speech output: ${speechOutputLabel}`}
        disabled={speechPreferenceLoading}
        on:click={toggleAssistantSpeech}>
        <!-- Speaker icon -->
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3zM16.5 12a4.5 4.5 0 00-1.5-3.356V15.356A4.5 4.5 0 0016.5 12z"></path></svg>
        <span>{speechOutputLabel}</span>
      </button>
      {#if speechPreferenceError}<span role="alert">{speechPreferenceError}</span>{/if}
    </div>

    {#if composeTarget && displayMessages.length > 0}
      <button class="clear-btn" on:click={clearChat} title="Clear chat history">
        <span class="clear-icon" aria-hidden="true">🗑️</span>
        <span class="clear-text">Clear</span>
      </button>
    {/if}
  </div>


  <!-- Messages Area -->

  <!-- Shared conversation interface -->
  <div class="chat-main-area">
    <!-- Messages panel -->
    <div class="messages-panel">
      <div class="messages-container" bind:this={messagesContainer}>
        {#if selectedViews.has('terminal')}
          {#if $isOwner}<TerminalChat bind:this={terminalChat} bind:running={terminalRunning} />
          {:else}<p>Terminal access is restricted to the installation owner.</p>{/if}
        {/if}
        {#if displayMessages.length === 0 && !selectedViews.has('terminal')}
          <div class="welcome-screen">
            <div class="welcome-icon">🧠 => 💻</div>
            <h2 class="welcome-title">MetaHuman OS</h2>
            <p class="welcome-subtitle">
              {#if selectedViews.has('conversation') && selectedViews.has('inner')}
                View combined conversation and inner dialogue
              {:else if selectedViews.has('conversation')}
                Start a conversation with your digital personality extension
              {:else}
                Explore your MetaHuman's inner dialogue
              {/if}
            </p>
            <div class="welcome-suggestions">
              <button class="suggestion" on:click={() => { input = "Tell me how you will take over the world?"; sendMessage(); }}>
                Tell me how you will take over the world?
              </button>
              <button class="suggestion" on:click={() => { input = "Wimmy wham wham wozzle!?"; sendMessage(); }}>
                Wimmy wham wham wozzle!?
              </button>
              <button class="suggestion" on:click={() => { input = "Tell me about yourself in the most technical way possible"; sendMessage(); }}>
                Tell me about yourself in the most technical way possible.
              </button>
            </div>
          </div>
        {:else}
          <MessageList
            messages={displayMessages}
            mode="combined"
            showSystemMessages={true}
            selectedMessageIndex={$selectedMessageIndex}
            {loading}
            {reasoningStages}
            showThinkingIndicator={$showThinkingIndicator}
            thinkingSteps={$thinkingSteps}
            thinkingStatusLabel={$thinkingStatusLabel}
            on:messageClick={(e) => {
              if ($selectedMessageIndex === e.detail.index) {
                messagesApi.clearSelection();
              } else {
                messagesApi.selectMessage(e.detail.message, e.detail.index);
              }
            }}
            on:deleteMessage={(e) => handleDelete(e.detail.relPath)}
            on:validateMessage={(e) => handleValidate(e.detail.relPath, e.detail.status)}
            on:speakMessage={async (e) => {
              if (ttsEnabled) {
                await interruptAssistantSpeech('manual-stop');
                void ttsApi.speak(e.detail.content);
              }
            }}
          />
        {/if}
      </div>

  <!-- Approval Prompt - appears above input when desires need approval -->
  <!-- Shows in BOTH conversation AND inner dialogue modes - users need to see approval requests regardless of view -->
  <ApprovalPrompt onApprovalChange={() => {
    console.log('[chat] Approval change detected');
  }} />

  <!-- Operator proposals are displayed inline by OperatorProposalCard. -->

  <!-- Input Area -->
  <div class="input-container">
    {#if showComposeSelector}
      <div class="compose-target" aria-label="Compose target">
        <span class="compose-label">Send as</span>
        {#each availableComposeOptions as option}
          <button
            class:active={composeTarget === option.target}
            on:click={() => { composeTarget = option.target; }}
            aria-pressed={composeTarget === option.target}
            title={option.title}
          >{option.label}</button>
        {/each}
      </div>
    {/if}
    {#if !composeTarget}<p class="read-only-notice">The selected view is read-only.</p>{/if}
    {#if transientStatus}
      <div class="transient-status" role="status">{transientStatus}</div>
    {/if}
    <InputArea
      bind:input
      loading={composeTarget === 'terminal' ? terminalRunning : loading}
      composeTarget={composeTarget}
      readOnly={!composeTarget}
      selectedMessage={$selectedMessage}
      isRecording={$micIsRecording}
      isContinuousMode={$micIsContinuousMode}
      isConversationMode={$micIsConversationMode}
      ttsIsPlaying={$ttsIsPlaying}
      interimTranscript={$micInterimTranscript}
      on:send={sendMessage}
      on:stop={() => { if (composeTarget === 'terminal') void terminalChat.close().catch(error => showTransientSystemMessage(error.message)); else void stopRequest(); }}
      on:keypress={(e) => handleKeyPress(e.detail.event)}
      on:micClick={() => {
        // Tap on mic: stop any active listening mode first
        if ($micIsConversationMode) {
          console.log('[chat-mic] Stopping conversation mode');
          mic.toggleConversationMode();
          return;
        }
        if ($micIsContinuousMode) {
          mic.toggleContinuousMode();
          return;
        }
        // Normal single recording
        if ($micIsRecording) {
          mic.stopMic();
        } else {
          messagesApi.pushMessage('system', '🎤 Starting microphone...');
          mic.startMic();
        }
      }}
      on:micLongPress={() => {
        // Long-press: toggle conversation mode on ALL devices
        console.log('[chat-mic] Long press detected, toggling conversation mode');
        if (!$micIsConversationMode) {
          messagesApi.pushMessage('system', '🎤 Conversation listening mode enabled. Speak when ready.');
        }
        mic.toggleConversationMode();
      }}
      on:micContextMenu={() => {
        // Right-click: toggle conversation mode on ALL devices
        console.log('[chat-mic] Right-click detected, toggling conversation mode');
        if (!$micIsConversationMode) {
          messagesApi.pushMessage('system', '🎤 Conversation listening mode enabled. Speak when ready.');
        }
        mic.toggleConversationMode();
      }}
      on:ttsStop={() => {
        void interruptAssistantSpeech('manual-stop');
      }}
      on:ttsStopAndListen={() => {
        // Tap-to-interrupt: Stop TTS and start listening (ChatGPT/Google style)
        console.log('[chat-mic] Tap-to-interrupt: stopping TTS and starting to listen');
        void interruptAssistantSpeech('barge-in');
        // If in conversation mode, VAD will auto-restart
        // If not, enter conversation mode
        if (!$micIsConversationMode) {
          mic.toggleConversationMode();
        }
      }}
      on:clearSelection={() => messagesApi.clearSelection()}
    />
  </div>
    </div>
    <!-- End messages-panel -->

  </div>
  <!-- End chat-main-area -->
</div>

<style>
  .read-only-notice { padding: .5rem .75rem 0; color: var(--text-muted, #9ca3af); font-size: .8rem; }

  .compose-target {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.75rem 0;
  }

  .compose-label {
    color: var(--text-muted, #9ca3af);
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .compose-target button {
    border: 1px solid var(--border-color, #374151);
    border-radius: 999px;
    padding: 0.25rem 0.6rem;
    background: transparent;
    color: var(--text-muted, #9ca3af);
    font-size: 0.75rem;
    cursor: pointer;
  }

  .compose-target button.active {
    border-color: #8b5cf6;
    background: rgba(139, 92, 246, 0.14);
    color: #ede9fe;
  }

  .transient-status {
    margin: 0.45rem 0.75rem 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid rgba(245, 158, 11, 0.3);
    border-radius: 0.5rem;
    background: rgba(245, 158, 11, 0.08);
    color: #fcd34d;
    font-size: 0.78rem;
    white-space: pre-wrap;
  }

</style>
