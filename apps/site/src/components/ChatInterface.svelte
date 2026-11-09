<script lang="ts">
  import { onMount, beforeUpdate, afterUpdate, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import type { ResponseEntryReference } from '@metahuman/core/cognitive-graph-contract';
  import TerminalChat from './terminal/TerminalChat.svelte';
  import { reportChatError } from '../lib/client/system-errors';
  import InputArea from './chat/InputArea.svelte';
  import MessageList from './chat/MessageList.svelte';
  import ApprovalPrompt from './ApprovalPrompt.svelte';
  import { currentMode, isOwner } from '../stores/security-policy';
  import { yoloModeStore } from '../stores/navigation';
  import { nextSpeechOutputState, speechOutputState, speechOutputSettings, type SpeechOutputState } from '../lib/client/assistant-speech-preference';
  import { useTTS } from '../lib/client/composables/useTTS';
  import { useMicrophone } from '../lib/client/composables/useMicrophone';
  import { useThinkingTrace } from '../lib/client/composables/useThinkingTrace';
  import { useMessages, useActivityTracking, type ChatMessage, type ReasoningStage } from '../lib/client/composables/useMessages';
  import { apiEventSource, apiFetch } from '../lib/client/api-config';
  import {
    buildConversationParams,
    buildResponsePipelineRequestBody,
    parseConversationStreamEvent,
    readLlmOptions,
    responsePipelineCardTypeForReply,
  } from '../lib/client/conversation-transport';
  import { autonomyModeDefinition, nextAutonomyMode, type AutonomyMode } from '../lib/client/active-operator-modes';
  import { setActiveOperatorMode, triggerManagerSnapshot, useTriggerManager } from '../lib/stores/trigger-manager';
  import { projectBufferFeed, receiveLiveConversation, replaceBufferSlice, type BufferView } from '../lib/client/buffer-feed';

  export let terminalSelected = false;
  let terminalChat: TerminalChat;
  let terminalRunning = false;

  // Component state
  let input = '';
  let loading = false;
  let reasoningStages: ReasoningStage[] = [];
  let reasoningDepth: number = 0;
  const reasoningLabels = ['Off', 'Quick', 'Focused', 'Deep'];
  const clampReasoningDepth = (value: number) => Math.max(0, Math.min(reasoningLabels.length - 1, Math.round(value)));
  let activeChatTaskId: string | null = null;
  let queuedChatStreams = new Map<string, EventSource>();
  let bufferStream: EventSource | null = null;
  // Live workflow replies are local view state, never a conversation buffer or cache.
  let liveConversationMessages: ChatMessage[] = [];
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
  const { isPlaying: ttsIsPlaying } = ttsApi;

  // Initialize Messages composable
  // History clearing follows the selected input destination; inference keeps its existing conversation mode.
  const messagesApi = useMessages({
    getMode: () => composeTarget ?? 'conversation',
    onTransientSystemMessage: showTransientSystemMessage,
  });
  const {
    messages,
    selectedMessage,
    selectedMessageIndex,
    conversationSessionId
  } = messagesApi;

  $: displayMessages = projectBufferFeed($messages, selectedViews, liveConversationMessages);

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
    target: 'conversation' | 'inner',
    taskId: string,
    responseEntry?: ResponseEntryReference,
    meta: Record<string, any> = {},
  ) {
    if (typeof content !== 'string' || !content.trim()) return;
    liveConversationMessages = receiveLiveConversation(liveConversationMessages, {
      role: target === 'inner' ? 'reflection' : 'assistant',
      content,
      timestamp: Date.now(),
      taskId,
      responseEntry,
      meta: { ...meta, bufferSource: responseEntry?.mode ?? target },
    });
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
    statusLabel: thinkingStatusLabel,
    steps: thinkingSteps,
    showIndicator: showThinkingIndicator
  } = thinkingTraceApi;

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

  // Server-first conversation buffer management

  onMount(() => {
    loadChatPrefs();
    void loadSpeechPreference();
    releaseTriggerManager = useTriggerManager();
    mic.loadVADSettings(); // Load VAD settings from voice config


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

    // Reconnect buffer streams when tab becomes visible (in case connection dropped)
    const handleVisibilityChange = () => {
      if (document.hidden) {
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
    // They're saved as conversation events by agents and loaded via /api/conversation-buffer

    // Listen for voice settings changes (triggered when user updates VAD settings in UI)
    window.addEventListener('voice-settings-updated', handleVoiceSettingsUpdate);

    // CRITICAL: Aggressive cleanup on page unload to prevent connection leaks
    // This ensures EventSource connections are closed even if Svelte cleanup doesn't run
    const aggressiveCleanup = () => {
      console.log('[chat] Page unload - force closing ALL connections');
      queuedChatStreams.forEach(stream => stream.close());
      queuedChatStreams.clear();
      disconnectAllBufferStreams();
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
    queuedChatStreams.forEach(stream => stream.close());
    queuedChatStreams.clear();
    disconnectAllBufferStreams();
    activityApi.clearActivity();
    thinkingTraceApi.stop();
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

  // All accepted chat work uses the same replayable task stream. EventSource
  // reconnects the reader; execution and cancellation stay with Work Coordinator.
  function openChatTaskStream(
    taskId: string,
    target: 'conversation' | 'inner',
    card?: { type: string; data: Record<string, any> },
  ) {
    if (!isComponentMounted) return;
    const stream = apiEventSource(`/api/unified-queue/tasks/${encodeURIComponent(taskId)}/stream`);
    queuedChatStreams.set(taskId, stream);
    activeChatTaskId = taskId;
    loading = true;

    const close = () => {
      stream.close();
      queuedChatStreams.delete(taskId);
      loading = queuedChatStreams.size > 0;
      if (activeChatTaskId === taskId) {
        activeChatTaskId = [...queuedChatStreams.keys()].at(-1) ?? null;
        reasoningStages = [];
        thinkingTraceApi.stop();
      }
    };

    stream.onopen = () => {
      if (activeChatTaskId === taskId) {
        reasoningStages = [];
        thinkingTraceApi.setActive(true);
        thinkingTraceApi.setStatusLabel('Connected to accepted message');
        thinkingTraceApi.setTrace([`Following task ${taskId}`]);
      }
    };
    stream.onmessage = (event) => {
      try {
        const { type, data } = parseConversationStreamEvent(event.data);
        if (type === 'queued_task_started') {
          activeChatTaskId = taskId;
          reasoningStages = [];
          thinkingTraceApi.setActive(true);
          thinkingTraceApi.setStatusLabel(card ? `Processing ${card.type} response…` : 'Processing message…');
          thinkingTraceApi.setTrace([`Task ${taskId} started`]);
        } else if (type === 'queued' && activeChatTaskId === taskId) {
          thinkingTraceApi.setStatusLabel(`Queued behind ${Math.max(0, Number(data.position || 1) - 1)} task(s)`);
        } else if (type === 'progress' && data?.message && activeChatTaskId === taskId) {
          thinkingTraceApi.setActive(true);
          thinkingTraceApi.setStatusLabel(String(data.message));
          thinkingTraceApi.appendTrace(String(data.message), 15);
        } else if (type === 'reasoning' && activeChatTaskId === taskId) {
          thinkingTraceApi.stop();
          const stage: ReasoningStage = {
            round: typeof data === 'object' && Number(data.round) > 0 ? Number(data.round) : 1,
            stage: typeof data === 'object' ? String(data.stage || 'plan') : 'plan',
            content: typeof data === 'string' ? data : String(data?.content || ''),
            timestamp: Date.now(),
          };
          reasoningStages = [...reasoningStages, stage];
        } else if (type === 'answer') {
          pushGeneratedResponse(data.response, target, taskId, data.responseEntry, card ? {
            source: 'response_pipeline',
            cardType: card.type,
            desireId: card.data.desireId,
            responseBufferId: data.responseBufferId,
            actionTaken: data.actionTaken,
            pipelineTriggered: data.pipelineTriggered,
            dialogueSource: 'response-pipeline',
          } : { facet: data.facet });
          if (activeChatTaskId === taskId) {
            reasoningStages = [];
            thinkingTraceApi.stop();
          }
          // An answer is available; only the task's terminal event ends tracking.
        } else if (type === 'system_message' && data.content) {
          messagesApi.pushMessage('system', data.content);
        } else if (type === 'cancelled') {
          messagesApi.pushMessage('system', data.message || 'Request cancelled');
          close();
        } else if (type === 'error') {
          const message = data?.message || 'Queued message failed';
          const details = [message, data?.failedNode ? `Failed at node: ${data.failedNode}` : '', data?.suggestion].filter(Boolean);
          showChatError(details.join('\n\n'), `work-failure:${taskId}`, false);
          close();
        } else if (type === 'queued_task_completed') {
          close();
        }
      } catch (error) {
        showChatError(error);
        close();
      }
    };
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) {
        showChatError(`The live reader for accepted task ${taskId} closed. The server task has not been cancelled.`);
        close();
      } else if (activeChatTaskId === taskId) {
        thinkingTraceApi.setActive(true);
        thinkingTraceApi.setStatusLabel('Reconnecting to accepted message…');
      }
    };
  }

  async function sendMessage() {
    if (!input.trim()) return;
    if (!composeTarget) { showTransientSystemMessage('The selected view is read-only.'); return; }
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

    const submittedInput = input;
    const message = submittedInput.trim();
    const target = mode;
    const sessionId = $conversationSessionId;
    const submittedReply = $selectedMessage;
    const replyTo = messagesApi.getReplyToMetadata();
    const cardType = responsePipelineCardTypeForReply({
      cognitiveMode: $currentMode,
      cardType: replyTo.cardType,
      questionId: replyTo.questionId,
      desireId: replyTo.desireId,
      dialogueSource: replyTo.dialogueSource,
      isAgencyMessage: replyTo.isAgencyMessage,
    });
    const card = submittedReply && replyTo.content && target === 'conversation' && cardType
      ? { type: cardType, data: {
        desireId: replyTo.desireId,
        desireTitle: replyTo.desireTitle,
        content: replyTo.content,
        dialogueSource: replyTo.dialogueSource,
        questionId: replyTo.questionId,
        ...replyTo.meta,
      } } : undefined;
    const taskInput = card ? {
      kind: 'response-pipeline',
      responsePipeline: buildResponsePipelineRequestBody(message, card.type, card.data, sessionId, replyTo.responseBufferId),
    } : {
      kind: 'persona-chat',
      personaChat: Object.fromEntries(buildConversationParams({
        message,
        mode: target,
        sessionId,
        reasoningDepth,
        yoloMode: $yoloModeStore,
        llmOptions: readLlmOptions(),
        replyTo: {
          questionId: replyTo.questionId || undefined,
          content: replyTo.content || undefined,
          desireId: replyTo.desireId || undefined,
          desireTitle: replyTo.desireTitle || undefined,
        },
      }).entries()),
    };

    sendInProgress = true;
    try {
      await interruptAssistantSpeech('user-input');
      await ttsApi.ensureAudioUnlocked();
      if (ttsEnabled) ttsApi.prefetchVoiceResources();
      activityApi.signalActivity();
      if (!loading) {
        reasoningStages = [];
        thinkingTraceApi.setActive(true);
        thinkingTraceApi.setStatusLabel('Sending message…');
        thinkingTraceApi.setTrace(['Submitting message to Work Coordinator']);
      }
      const task = await enqueueUserMessageTask(taskInput);
      if (input === submittedInput) input = '';
      if ($selectedMessage === submittedReply) messagesApi.clearSelection();
      if (!isComponentMounted) return;
      pushComposedInput(message, target);
      openChatTaskStream(task.id, target, card);
    } catch (error) {
      if (isComponentMounted) showChatError(error);
      if (!queuedChatStreams.size) thinkingTraceApi.stop();
    } finally {
      sendInProgress = false;
    }
  }

  async function stopRequest() {
    const taskId = activeChatTaskId;
    if (!taskId) return;
    try {
      const response = await apiFetch(`/api/unified-queue/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 409) {
        const data = await response.json();
        throw new Error(data.error || `Could not cancel task (${response.status})`);
      }
    } catch (error) {
      showChatError(error);
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

    // Clear only the explicit compose target. Read-tab selection never decides
    // which canonical buffer is mutated.
    const serverCleared = await messagesApi.clearServerBuffer();
    if (serverCleared) {
      liveConversationMessages = liveConversationMessages.filter(message =>
        (message.responseEntry?.mode ?? message.meta?.bufferSource ?? (message.meta?.liveConversation ? 'conversation' : undefined)) !== target);
      // Terminal history has its own session identity, owned by the terminal service.
      if (target !== 'terminal') {
        try {
          const newId = messagesApi.generateSessionId();
          localStorage.setItem('mh_conversation_session_id', newId);
        } catch {
          messagesApi.generateSessionId();
        }
      }

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
            <h2 class="welcome-title">Ainekio OS</h2>
            <p class="welcome-subtitle">
              {#if selectedViews.has('conversation') && selectedViews.has('inner')}
                View combined conversation and inner dialogue
              {:else if selectedViews.has('conversation')}
                Start a conversation with your digital personality extension
              {:else}
                Explore your Ainekio OS's inner dialogue
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

  <!-- Pending Desire approvals remain available across the selected chat views. -->
  <ApprovalPrompt />


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
  .chat-interface {
    @apply flex flex-col h-full w-full overflow-hidden;
  }

  .mode-toggle-container {
    @apply flex flex-wrap items-center justify-between gap-3 p-4 border-b border-black/10 flex-shrink-0;
  }

  :global(.dark) .mode-toggle-container {
    @apply border-white/10;
  }

  .mode-toggle {
    @apply flex flex-wrap items-center gap-2 p-1 bg-black/5 rounded-lg;
  }

  :global(.dark) .mode-toggle {
    @apply bg-white/5;
  }

  .mode-btn {
    @apply inline-flex items-center gap-2 px-3 py-2 border-0 bg-transparent rounded-md text-sm font-medium
           text-gray-500 cursor-pointer transition-all;
  }

  :global(.dark) .mode-btn {
    @apply text-gray-400;
  }

  .mode-btn:hover {
    @apply bg-black/5;
  }

  :global(.dark) .mode-btn:hover {
    @apply bg-white/5;
  }

  .mode-btn.active {
    @apply bg-white text-gray-900 shadow-sm;
  }

  :global(.dark) .mode-btn.active {
    @apply bg-gray-900 text-gray-100;
  }

  .messages-container {
    @apply flex-1 overflow-y-auto overflow-x-hidden;
  }

  .chat-main-area, .messages-panel {
    @apply flex flex-col flex-1 overflow-hidden;
  }

  .input-container {
    @apply p-4 border-t border-black/10 bg-white/80 backdrop-blur-xl flex-shrink-0;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  }

  :global(.dark) .input-container {
    @apply border-white/10 bg-gray-950/80;
  }

  .welcome-screen {
    @apply flex flex-col items-center justify-center h-full p-8 text-center;
  }

  .welcome-icon {
    @apply text-6xl mb-4;
  }

  .welcome-title {
    @apply text-3xl font-bold text-gray-900 m-0 mb-2;
  }

  :global(.dark) .welcome-title {
    @apply text-gray-100;
  }

  .welcome-subtitle {
    @apply text-base text-gray-500 m-0 mb-8;
  }

  :global(.dark) .welcome-subtitle {
    @apply text-gray-400;
  }

  .suggestion {
    @apply p-4 border border-black/10 bg-white rounded-xl text-sm text-gray-900 cursor-pointer transition-all
           text-left;
  }

  :global(.dark) .suggestion {
    @apply border-white/10 bg-gray-900 text-gray-100;
  }

  .suggestion:hover {
    @apply border-violet-600 shadow-lg shadow-violet-600/15;
  }

  :global(.dark) .suggestion:hover {
    @apply border-violet-400 shadow-violet-400/15;
  }

  .mode-label {
    @apply text-sm font-semibold px-3 py-1.5 rounded-full bg-white/55 transition-all;
  }

  :global(.dark) .mode-label {
    @apply bg-gray-900/55;
  }

  .mode-icon {
    @apply text-base leading-none;
  }

  .quick-audio {
    @apply flex items-center gap-2 flex-wrap;
  }

  .active-operator-toggle {
    @apply inline-flex items-center gap-1 px-2 py-1.5 border border-black/15 bg-white text-gray-900 rounded-md
           cursor-pointer transition-all;
  }

  :global(.dark) .active-operator-toggle {
    @apply border-white/20 bg-gray-900 text-gray-100;
  }

  .active-operator-toggle:hover {
    @apply bg-gray-50;
  }

  :global(.dark) .active-operator-toggle:hover {
    @apply bg-gray-800;
  }

  .active-operator-toggle.semi {
    @apply bg-amber-500 text-white border-amber-500;
  }

  :global(.dark) .active-operator-toggle.semi {
    @apply bg-amber-400 text-gray-900 border-amber-400;
  }

  .active-operator-toggle.full {
    @apply bg-violet-700 text-white border-violet-700;
    box-shadow: 0 0 0 2px rgb(124 58 237 / 0.2);
  }

  :global(.dark) .active-operator-toggle.full {
    @apply bg-violet-500 text-white border-violet-400;
  }

  .active-operator-toggle.loading {
    @apply opacity-60 cursor-wait;
  }

  .active-operator-icon {
    @apply text-base;
  }

  .active-operator-badge {
    @apply text-xs bg-black/15 text-current rounded px-1 font-bold;
  }

  :global(.dark) .active-operator-badge {
    @apply bg-white/20;
  }

  .icon-btn {
    @apply inline-flex items-center gap-1 px-2 py-1.5 border border-black/15 bg-white text-gray-900 rounded-md
           cursor-pointer;
  }

  :global(.dark) .icon-btn {
    @apply border-white/20 bg-gray-900 text-gray-100;
  }

  .icon-btn.tts-active {
    @apply bg-green-600 text-white border-green-600;
    box-shadow: 0 0 8px 2px rgba(34, 197, 94, 0.5);
  }

  :global(.dark) .icon-btn.tts-active {
    @apply bg-green-500 border-green-500;
  }

  .welcome-suggestions {
    @apply flex flex-col gap-3 max-w-md w-full;
  }

  .clear-btn .clear-icon {
    display: none;
  }

  .clear-btn .clear-text {
    display: inline;
  }

  @media (max-width: 640px) {
    .mode-toggle-container {
      flex-wrap: nowrap;
      gap: 0.5rem;
      padding: 0.75rem 0.5rem;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .mode-toggle-container::-webkit-scrollbar {
      display: none;
    }

    .mode-toggle {
      flex: 0 0 auto;
      gap: 0.35rem;
    }

    .mode-btn {
      flex: 0 0 auto;
      padding: 0.45rem 0.5rem;
      font-size: 1rem;
      min-width: unset;
    }

    .mode-label,
    .control-text {
      display: none;
    }

    .mode-icon {
      font-size: 1.1rem;
    }

    .icon-btn {
      padding: 0.35rem 0.45rem;
      min-width: unset;
    }

    .clear-btn {
      padding: 0.35rem 0.5rem;
      min-width: unset;
      font-size: 1.1rem;
    }

    .clear-btn .clear-text {
      display: none;
    }

    .clear-btn .clear-icon {
      display: inline;
    }
  }

  .read-only-notice {
    padding: .5rem .75rem 0;
    color: var(--text-muted, #9ca3af);
    font-size: .8rem;
  }

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
