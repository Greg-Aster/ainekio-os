# Chat

Chat is the main conversational surface in MetaHuman OS. It combines profile-scoped conversation, optional inner and system feeds, voice input, queued work, and explicit operator controls without treating those different channels as one history.

## Open Chat

Start MetaHuman OS, sign in, and select **Chat** in the left sidebar. If the page reports that no model backend is available, check the configured backend before troubleshooting the conversation itself:

```bash
./bin/mh status
./bin/mh backend status
```

## Choose What You Read

Conversation is selected when Chat opens. The four buttons above the message
list select persistent feeds and can be combined in any combination:

- **Conversation** shows user and persona messages from the Conversation Buffer.
- **Inner Dialogue** shows private thoughts, reflections, dreams, and related Inner Buffer records.
- **System** merges System and Robot Buffer records and remains read-only.
- **Terminal** shows exchanges with Big Brother from the Terminal Buffer.

Selected feeds merge chronologically. Each history comes from its existing
profile buffer file and retains its configured message limit across reloads and
application sessions. Selecting Conversation does not implicitly select Terminal.

With a single selected tab that accepts input, the input automatically uses that destination
and hides **Send as**. With multiple tabs selected, **Send as** lists the writable
selected destinations: Conversation, Unvoiced thought, and/or Terminal. Your chosen
destination remains selected while it is available. System-only selection disables
message input without changing its displayed history.

## Send a Message

1. Select the intended compose target.
2. Enter a message.
3. Press **Send**.

If another chat request is already running, the new request may enter the shared queue instead of starting immediately. The **Queue** tab in the right sidebar shows admitted work and its state.

Select an existing message before sending to include it as focused reply context. Ordinary replies stay in the active conversation workflow. Curiosity questions and Agency cards that can change Desire state use the dedicated response pipeline; passive Agency notices do not. In Environment mode, ordinary selected-message replies therefore remain in the Environment workflow so the same LLM decision can respond or select an environment action. Clear the selection when it is no longer relevant.

## Stop and Clear

- **Stop** cancels the current chat request.
- Interrupting speech stops browser TTS playback; it does not by itself cancel model work.
- **Clear** clears only the selected input destination's server buffer. The visible read-filter combination never decides what is deleted.

Clearing Conversation therefore does not clear Terminal exchanges, Inner Dialogue, System, audit logs, memories, or unrelated runtime data.

## Thinking, Big Brother, and Active Operator

These controls change execution behavior and should be used deliberately:

- **Thinking mode** changes the chat reasoning behavior exposed by the current model path.
- **Big Brother** can escalate selected work to its configured terminal provider. A normal click enables escalation mode; right-click enables full delegation. The provider must be configured and available.
- **Active Operator** cycles through its supported operating modes. Higher-autonomy modes can admit bounded work from configured triggers and policy.

A UI status message proves that a request was submitted or progressed only as far as the displayed state. For terminal work, inspect the Terminal view and final work result before treating it as complete.

## Use the Microphone

- Tap the microphone for one recording. The transcript is placed in the input so you can review it before sending.
- Long-press or right-click the microphone to toggle conversation listening mode. In that mode completed transcripts can be sent automatically.
- Tap while speech is playing to interrupt playback and return to listening.

On the Site, the voice path is browser microphone → managed Whisper
transcription → normal chat request → TTS queue → browser playback. The
maintained React Native shell may use device-native speech recognition instead.
Check each stage separately when diagnosing a failure. See
[Voice Features](/user-guide#voice-features).

## Terminal Conversation

Owners can select **Terminal** from the sidebar or chat toolbar. Terminal-only
selection routes input there automatically; with other feeds selected, choose
**Send as Terminal** beside the input. Opening
this view does not start a process. The first terminal message starts the existing
Big Brother Terminal service and opens its native Codex session. Later messages
continue that exact Codex thread, including messages sent while a turn is running.
Final replies appear in the chat as **Big Brother**. The expandable **Terminal activity** section retains the same owned session's execution transcript.

Terminal messages use the configured Codex command, arguments, permissions,
model and reasoning settings. The first turn includes the root `agents_big_brother` orientation file and
resolved workspace/profile/conversation-buffer locations, followed by the complete
message. Later turns send only the new message to the same thread. Terminal input
does not run the MetaHuman conversation workflow or become a diagnostic report.
Big Brother diagnostic and tool sessions remain separate.

Completed chat turns enter the editable **Big Brother Response** workflow in
`etc/cognitive-graphs/big-brother-response-mode.json`. Existing User Input and
Conversation Work Result nodes provide the original request and final reply;
the Conversation Buffer node selects its Terminal channel, TTS Output uses the
saved speech destination, and Stream Writer returns the final text. No Persona
model rewrites Codex's answer. Terminal exchanges use the canonical buffer owner
and the existing conversation retention setting, separately from the persona's
Conversation Buffer. Select both Conversation and Terminal to see both histories.

The existing execution store persists each response and its submission identity
before the Coordinator admits delivery. Recovery resumes response delivery;
it does not rerun Codex. Speech admission does not wait for audible playback,
and independent response work does not block subsequent terminal turns.

Hiding Terminal, switching views or reloading preserves the session. Reconnect
restores its current transcript using the application's authenticated connection.
**Close session**, **Stop** while composing terminal input, or closing the native
window ends that session and its pending turns. The next terminal message starts
a new thread. Stopping Terminal in Agent Monitor closes all owned provider work.
After a service restart, saved processes are cleaned up and commands are never
replayed. Logging out revokes browser access without stopping retained work.

## System Code Review

System Code Review is available alongside the other Active Operator operations.
Active Operator receives unresolved technical issues and their previous review
outcomes when assessing activation. Its existing model decides whether to select
the coding operation. The agent can also be run manually from the agent catalog.

The editable **System Code Review** workflow uses the configured Coder model to
prepare an investigation request, then runs it through the existing Big Brother
Terminal service. Diagnosis is read-only at every trust level. Automatic source
repair follows the existing high-risk approval policy: `adaptive_auto`, including
the status widget's subsequent YOLO step. Lower trust levels receive a diagnosis
and proposed repair. The terminal owner reads trust again when work starts.

Every attempt records a report as **System Code Review** in Conversation and
Persona Memory, including failures and unrepaired issues. Help Tickets retain
issue identity, evidence, review history and resolution references. Resolved and
duplicate tickets leave the unresolved list; a new error occurrence remains new
evidence. A failed investigation does not establish a cause or a completed repair.
Report delivery recovery preserves the original report without repeating Codex.

Client errors are recorded when the backend accepts their report. Coordinator
execution failures use its existing durable failure-notice path. Manual terminal
conversation keeps its own session. Desire integration remains a later option.

## Speech Output

The speaker control selects Off, Browser, or Body Control for workflow speech.
Browser uses the existing TTS queue and authenticated playback consumer. Body
Control receives audio through Environment Bridge and selects its configured
computer or robot speaker. Computer playback remains available without a physical
robot connection. Synthesis, delivery receipts and actual audibility are separate
evidence; a completed audio file alone does not prove that it was heard.

## Privacy and Persistence

Conversation, inner-dialogue, system, robot, and terminal histories are server-owned, profile-resolved buffers. They are not interchangeable with durable episodic memory. Use explicit memory capture when something must be retained as a memory rather than relying on the current chat view.

Guest sessions are authenticated, read-only sessions with limited profile access. Private profiles are not available to guests.

## Related Guides

- [Memory](/user-guide#memory-system)
- [Dashboard and Monitoring](/user-guide#dashboard-monitoring)
- [Tasks and Projects](/user-guide#task-management)
- [Voice Features](/user-guide#voice-features)
- [Cognitive Modes](/user-guide#cognitive-modes)
