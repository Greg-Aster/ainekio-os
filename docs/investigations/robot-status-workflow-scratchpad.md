# Robot Status Workflow Scratchpad

Status: temporary local acceptance checklist; source is integrated in the current
uncommitted worktree, automatic runtime acceptance remains pending, started
2026-08-27. This file is not maintained architecture documentation and should be
deleted when acceptance is completed or explicitly deferred.

Latest process check: on 2026-08-31 neither the Site nor Robot Operator was
running. Process state recorded in the dated evidence below is historical, not a
claim about the current runtime.

## Goal

Add one independently runnable Robot Status agent and editable cognitive graph
that periodically converts bounded, canonical robot information into a compact
per-profile situational snapshot. Other graphs can opt into that snapshot
through one reusable Robot Status context node.

The snapshot is supporting self-context for Ainekio. It does not execute robot
actions, schedule work, replace fresh Environment evidence, or become a second
goal, queue, buffer, Agency, or Environment state owner.

## Baseline evidence

- The Agent Catalog, `etc/agents.json`, Execution Engine, Robot Operator, and
  cognitive-graph registry have no `robot-status` agent or workflow.
- Robot Operator currently schedules only Boredom Observer, Movement, and
  Reflection.
- Environment Bridge already owns current sessions, latest observations,
  correlated action results, and Ainekio telemetry such as `vbat`.
- Agency storage already owns active desires through `listActiveDesires()`.
- Conversation, inner, system, and robot histories already have four canonical
  per-profile buffers.
- The Conversation interface's System view already reads the canonical System
  Buffer and projects the separate Robot Buffer beside it. A fifth buffer is
  neither needed nor permitted.
- `packages/core/src/state.ts` owns system-level orchestrator working memory in
  `out/state/short-term.json`; it is not profile-resolved robot self-context.

## Canonical ownership

- `packages/core/src/robot-status.ts`: typed, profile-resolved current Robot
  Status snapshot and bounded snapshot history.
- Environment Bridge: raw connection, body telemetry, current observation, and
  correlated action facts.
- Robot Buffer: verified prior action records.
- Conversation Buffer: recent user/assistant narrative used only to infer
  current situational intent.
- Agency storage: active desires and their strength/status.
- Robot Status graph: one bounded LLM pass deriving semantic situation fields
  from those sources.
- Robot Status writer node: validates the semantic result, combines it with
  deterministic source facts, and atomically updates the canonical JSON file.
- System Buffer: one concise visible status update in the System Feed.
- Robot Operator: the only automatic timer/admission owner for Robot Status and
  the three boredom children.
- Work Coordinator: the only queue and interruption owner.

## File format decision

Use JSON for the canonical snapshot. Graphs need typed fields, bounded history,
timestamps, and source separation. Markdown would force every consumer to parse
prose and would make deterministic telemetry indistinguishable from LLM-derived
interpretation.

The System Feed receives a concise human-readable summary generated from the
same validated snapshot; it does not read or duplicate the file.

## Snapshot contract

The snapshot separates source facts from model-derived semantics:

```text
version / updatedAt
sourceUpdatedAt
body                 exact bounded Bridge status, explicit battery voltage,
                     motion availability and activity, and telemetry
lastAction           latest verified Robot Buffer action result, including the
                     preserved semantic movement summary when one exists
agency.activeDesires bounded summaries from Agency storage
situation             LLM-derived summary, environment description,
                      current goal/intent, user context, uncertainties
history               compact prior status summaries only
```

Raw images, full conversations, full desire plans, chain-of-thought, and
unbounded historical snapshots are not persisted.

## Workflow

```text
Robot Operator or manual Agent Monitor run
  -> Robot Status graph
       Environment Bridge Status
       Recent Conversation Buffer
       Recent Robot Buffer
       Active Desires
       Previous Robot Status
       Editable instructions
       Robot Status Context Builder
       one model-router call
       Robot Status Writer
       System Buffer
```

The reusable Robot Status read node is inserted into Boredom Autonomy and
Environment Mode. The Boredom Observer, Movement, and Reflection planner graphs
do not read Robot Status; they author an intention first, and only the downstream
Boredom Autonomy executor combines that intention with Robot Status. Each
consumer includes the snapshot exactly once as supporting context. Fresh
correlated observations and action results remain authoritative for physical
claims.

The read node exposes a compact decision context rather than replaying the full
Bridge snapshot. It keeps current battery, motion, connection, semantic
situation, verified last action, active desires, and bounded status history.
Raw telemetry, gateway state, and capability catalogs remain in the canonical
JSON and in their live Environment owners; they are not duplicated into the
downstream model context where they could crowd out goals or desires.

## Implementation checklist

- [x] Inspect maintained-source and refactor authorities.
- [x] Establish the missing-agent baseline and trace existing owners.
- [x] Confirm the System Feed already has a canonical System Buffer.
- [x] Add typed profile-resolved Robot Status storage.
- [x] Add bounded active-desire retrieval node.
- [x] Extend Environment Bridge Status with bounded current robot telemetry.
- [x] Add Robot Status read, context-builder, and writer nodes.
- [x] Add and validate the editable Robot Status graph.
- [x] Register Robot Status in the Agent Catalog and `etc/agents.json`.
- [x] Add Robot Status to Robot Operator timing/admission and Agent Monitor
      variables without adding another scheduler.
- [x] Feed Robot Status into downstream Boredom Autonomy and Environment Mode
      once while keeping all three boredom planners status-free.
- [x] Add focused storage, node, graph, catalog, and Robot Operator tests.
- [x] Run graph, node-default, architecture, type, build, stale-reference, and
      diff validation.
- [x] Build one coherent canonical site distribution containing the same queue
      owner/service-token module for middleware and the internal enqueue route,
      plus the current Robot Status battery and motion projection.
- [x] Execute the canonical Robot Status work handler without robot-action
      dispatch: all 10 graph nodes completed, one configured-model call ran,
      the profile snapshot updated, and System Buffer persisted one event.
- [ ] Restart the canonical site and Robot Operator together so the graph
      registry and four-child Robot Operator use that built/runtime generation.
- [ ] Observe one automatic Robot Status admission from Robot Operator.
- [x] Verify a live manual run writes a fresh snapshot with current body,
      battery, motion, action, Agency, and semantic fields and appends one
      System Buffer event.
- [x] Verify subsequent live Boredom Autonomy runs load that fresh snapshot
      once.
- [ ] Verify a subsequent live Environment Mode run loads that fresh snapshot
      once; keep physical effects separately unverified unless observed.

## Acceptance evidence

- A manual `workflow.robot-status` run executes the checked-in graph through the
  Work Coordinator.
- The graph performs one model call and atomically updates the current
  per-profile `robot-status.json` snapshot.
- The file contains exact bounded body/action/desire facts and a validated
  semantic situation, with bounded history and no image data.
- The run appends one durable `robot_status` event through the existing System
  Buffer node, making it visible in the System view.
- Robot Operator schedules Robot Status in Semi and Full without overlapping
  another robot-autonomy child.
- Boredom Autonomy and Environment Mode receive the same snapshot through the
  reusable read node without gaining persistence responsibility.
- Focused tests and repository guardrails pass. Live model output, physical
  telemetry, and timing remain separately unverified until the runtime is
  rebuilt/restarted and connected to Ainekio.

## Source validation results

- Focused Robot Status, Robot Operator, Boredom Autonomy, Environment context,
  buffer ownership, and Agent Catalog tests: 6 files passed.
- Core, Brain, repository-test, and Site typechecks: passed; Site reported 353
  files with zero errors, warnings, or hints.
- Cognitive graphs: 27/27 valid. Graph executor coverage: 262 nodes with no
  missing executors. Node defaults and Agent Monitor validation passed; Agent
  Monitor listed `robot-status` as startable.
- Full `pnpm test`: passed after rerunning outside the filesystem sandbox. The
  first run reached the user-agnostic check and was denied permission to spawn
  its read-only `git ls-files`; the unrestricted rerun passed that check and all
  remaining suites.
- Architecture guardrail: zero violations. Site production build and
  `git diff --check`: passed.
- Final source search found one contextual Robot Status snapshot owner, one
  writer, one Robot Operator admission path, and the intended read-node uses in
  Environment Mode and Boredom Autonomy. Existing Environment Bridge
  `robotStatus` telemetry remains an input source rather than a competing
  situational-state owner.
- Consumer regressions now parse the actual Environment selector envelope and
  Boredom Autonomy model messages. They prove that battery, motion, verified
  last action, inferred goal, and active-desire title/reason survive the bounded
  prompt projection. This caught and repaired an existing generic projection
  depth that previously emptied nested active-desire objects.
- The site distribution was rebuilt again after that repair. Its middleware,
  internal enqueue route, and Robot Status runtime import the same generated
  Work Coordinator owner module; the built selector contains the bounded
  Robot Status projection and the built status nodes contain explicit battery,
  motion, situation, action, and active-desire fields.
- A non-physical live acceptance run completed all 10 nodes in the checked-in
  Robot Status graph in 4.099 seconds using the configured Ollama backend. The
  saved snapshot timestamp and the latest `robot_status` System Buffer event
  timestamp match that run. It recorded the latest connected session, motion
  availability, verified completed action, semantic goal/intent, and an empty
  active-desire list. Battery voltage remained explicitly unknown because the
  Bridge supplied no current telemetry timestamp or `vbat`; the workflow did
  not fabricate a value. This run exercised the canonical work handler directly,
  not automatic Work Coordinator admission.
- A second non-physical live run refreshed the snapshot at
  `2026-08-27T17:11:46.437Z`; its System Buffer event followed four milliseconds
  later. Robot Status now describes the latest verified historical motion as a
  16-frame, 4.8-second generated plan ending in `hold`. Movement Generator also
  preserves its semantic plan summary in action metadata for future Robot
  Buffer results, so later status updates retain what the movement represented
  rather than only its protocol type.
- The existing Environment and Boredom Autonomy context builders each loaded
  that same fresh Robot Status timestamp and retained its battery, motion,
  verified action, goal, and Agency desire count. Selectors and action dispatch
  were intentionally not invoked, so this is downstream context evidence and
  not a claim about model decisions or physical behavior.
- The previous site process began at 09:26 from generated
  `mode-controller_Dxh...`; the canonical distribution was rebuilt afterward
  and now consistently imports `mode-controller_CHy...`. While that process was
  alive, middleware ownership remained in the old in-memory module while
  dynamically loaded routes used the replacement module and rejected service
  tokens. The site is now stopped. The still-running Robot Operator remains the
  old three-child process and is retrying against port 4321 with
  `ECONNREFUSED`. This is stale/mixed runtime generation, not a second queue or
  a reason to weaken the coordinator token contract; the site and Robot
  Operator must be restarted together.
- Not yet accepted: coordinated restart into the rebuilt distribution,
  automatic Robot Status admission through Work Coordinator, an automatic
  Semi/Full status cycle, live full-graph downstream selector consumption, or
  any physical Ainekio behavior. The previous goal was
  closed from source validation before these runtime requirements were met; this
  scratchpad remains open until the non-physical runtime evidence is captured.

## Live acceptance update: 2026-08-27 10:16 PDT

- Two Agent Monitor admissions of `workflow.robot-status` completed through the
  Work Coordinator. Queue metadata identifies both as `source=user` and
  `triggeredBy=manual`; they are not evidence of periodic Robot Operator
  admission.
- The second run updated the canonical snapshot at
  `2026-08-27T17:16:46.769Z` and appended the matching System Buffer event. It
  recorded connected session `ainekio-01`, current Bridge telemetry,
  `motion.available=true`, the latest verified `captureImage` result, zero
  active desires, populated semantic situation fields, and three bounded prior
  summaries. The Bridge supplied `vbat=0`; Robot Status preserved that source
  value rather than interpreting it.
- Live Boredom Autonomy executions completed the single `robot-status` read node
  before the context builder and selector. The queue then recorded completed
  command, observation, movement, conversation, and continuation work matching
  the operator-visible crab-walk and camera sequence. This proves runtime
  consumption and protocol-level completion; the user's observation is the
  separate physical confirmation.
- The live Robot Operator state still contained only Boredom Observer, Movement,
  and Reflection. At `17:16:04Z` it automatically admitted those three agents,
  while no automatic Robot Status item was admitted. The operator process had
  not been restarted into the four-child source generation, so periodic Robot
  Status remains unaccepted.
- The terminal failures during otherwise successful autonomy turns were
  `vector.semantic-search` embedding calls, not Robot Status or robot-action
  failures. Embeddings are configured for the enabled, auto-started local model
  service on port 4324, but the service was absent. Its launcher trusted the
  stale `logs/run/local-models.pid` value `133` because that PID existed at
  launch time, reported `already running`, and never checked the service health
  or process identity. Port 4324 remained closed, so semantic familiarity
  searches failed while the main Environment observations continued. Repairing
  that launcher is a separate local-model service lifecycle task, not a reason
  to alter Robot Status or autonomy error handling.
- The System Feed projection previously published only the model-authored
  `situationalSummary`. That hid the rest of the saved snapshot and repeatedly
  exposed a historical lockout narrative. The canonical Robot Status Writer now
  publishes a compact report from the validated snapshot it just saved:
  timestamp, robot connection, battery, motion, last verified action,
  environment, goal, intent, user context, active desires, and uncertainties.
  The editable status instruction now carries historical conditions forward
  only when current deterministic facts still support them. The existing
  writer-to-System-Buffer edge remains the sole publication path.
- Focused Robot Status tests, Core typecheck, 27/27 graph validation, node
  defaults, architecture guardrail, site production build, stale-reference
  search, and `git diff --check` passed for the System Feed repair. The rebuilt
  site distribution contains the new report formatter. A fresh live Robot
  Status run remains required to verify the rendered event with current robot
  data.


### 2026-10-14 20:45–20:46 PDT — body-event backlog after handling the robot

- Owner reported ten Queue items after turning on and moving the robot. Authenticated live Queue read at 20:45:14 confirmed ten unfinished work items: seven `environment.observation` jobs and three `graph.resume` jobs belonging to two Body Event Trigger executions. Two were running and eight queued; these were not completed history rows.
- Read-only inspection of the existing SQLite ledger identified the seven observations as two `tipped` events and five `rapid_movement` events, with distinct event identities/timestamps from 20:41:58 through 20:43:24. The bridge admitted them to `body-event-trigger`; no user speech was present in those seven inputs.
- Execution `eaa825d1-7ed5-41dc-8d5d-24a6fbe99356` retained one accepted resume and one pending follow-up, rather than the earlier unbounded per-event resume fan-out. Its Persona Qwen3.5 9B image-input call failed after 107,993 ms with `llama.cpp returned no assistant text (finish reason: length)`; retry failed again after 112,704 ms. Other successful Persona/Visual Planning calls took approximately 105–108 seconds. These API elapsed times include any backend waiting and do not establish pure generation speed.
- At 20:46:13 ten items remained, now three running/seven queued; at least one original observation and one resume had completed, so the system was making progress but accumulating slow body-event processing. No unresolved physical Stop receipt was established as this backlog's cause.
- Remaining diagnosis: inspect the failed call's saved input/output and backend timings, including reasoning and image processing; trace whether the event's selected objective actually warranted its subsequent review. Goal Review currently enables reasoning with maxTokens 8192, but this setting alone does not prove why these calls returned no assistant text. Preserve distinct event evidence when considering any admission/lifecycle repair; do not silently discard events or impose new behavior limits.
- Inspection only: no model calls, robot commands, cancellations, restarts or production source changes. Private snapshots: `/tmp/robot-ready/natural-wake-2026-10-15T03-45-24-645Z.json`; audit evidence: `logs/audit/2026-10-15.ndjson`.


### 2026-10-14 20:54 onward — repeated body reactions, cancellation, and evidence repair

Confirmed causal chain from saved model inputs/outputs:

1. Distinct body events created distinct Body Event Trigger executions. The Qwen 9B event interpreter repeatedly copied “Whoopsie-daisy” and an earlier execution's stretch/stand objective into new instructions, despite its own `currentTask` being null. The 20:58:29 boot event (`1484b289-ee47-4227-a13e-22036efd99ce`) explicitly claimed that null field contained an unfinished task. This is model misinterpretation, not the queue replaying one identical admission.
2. The .8B Task model selected that speech and motion again. Body receipts include both completed and rejected stretches; the rejection text is `Motion mapping failed or pulse exceeds PWM timer capacity`. The firmware maps multiple invalid-argument paths to that text, so it does not establish which mapping/pulse operation failed. No firmware or calibration change was made here.
3. Goal Review generated another user-visible response, in one case copying the just-delivered response almost verbatim, and selected continuation. The subsequent Task call repeated the original program even though returned evidence included rejection and already-delivered speech. Distinct producer/occurrence identities explain the multiple chat entries; text deduplication would conceal the faulty decisions.
4. Current Execution separately cut the event stream to its last sixteen entries. In incident review inputs, display/speech/resume records evicted early action evidence. This is a concrete delivery defect independent of the model mistakes.

Owner-authorized cancellation used the existing Queue execution API. The two remaining executions at 20:56 were cancelled; Queue reported zero work afterward. A new boot at 20:58:29 admitted another reaction; this was a new execution, not resurrection of a cancelled one. It and its pending speech were subsequently cancelled under the same incident authorization. At 21:00:32 the API again reported zero running/queued items and no unfinished executions. Physical rest was not inferred from this Queue state.

The dream question in the supplied transcript belongs to execution `2a65e42a-9b1c-4acf-9bdd-db38aa0ac43f`, distinct from the boot execution producing the intervening stretch replies. Its saved execution is failed. Do not describe the interleaved stretch replies as a verified answer to or rerouting of that dream request. Separate concurrent dream-routing work is outside this repair.

Source repairs in progress/validation:

- Removed the sixteen-event cutoff from the existing Current Execution node, its editor schema, and every maintained graph configuration using it. Complete ordered execution evidence retains existing image references and observation-change compaction; no extra store, scheduler, response filter, or automatic stop was added.
- Body Event now uses the existing shared Robot Status context projection instead of injecting the full saved gateway snapshot containing older body events. Read-time live status and independently attributed active executions remain available. Shared status projection preserves its execution/effect provenance and complete task outcomes, feedback, dates, and uncertainties; removed its field/depth budgets for those records.
- Forty focused context/status tests pass, including early rejection/correction preservation after 24 later display events, unchanged original records/image bytes, and new boot versus historical tip attribution. Core typecheck, all 45 graph definitions, and node-default validation passed; the latter retains pre-existing documentation/persistence warnings. Staged Site build is tracked separately; activation is not yet claimed.

Offline model qualification, with no robot dispatch or chat publication:

- Owner approved exact factual ownership and already-delivered-response clarifications. The event wording alone was evaluated on two saved cases, three repeats per variant: all six baseline outputs copied the old phrase/task; five of six clarified outputs did too, and the sixth misidentified boot as a historical tip. No demonstrated semantic fix; that wording has not been applied to production graphs.
- Seven further calls compared shared status projection alone and projection plus the approved wording. Some boot outputs recognized the boot and selected a new sequence, but rapid-event task copying persisted and two no-action outputs used null `instruction`, failing the existing string contract. Qualification remains incomplete; no reliable behavioral success is claimed.
- The application and model endpoints disappeared during the eighth projected replay. The lead terminated only its own evaluation process and asked whether services should remain off. Goal Review reasoning was concurrently changed from true to false by another task; that edit was preserved. The approved Goal Review wording evaluation was prepared but not run before shutdown. No services were restarted by this repair.

Private frozen inputs, complete outputs, and evaluation scripts: `logs/benchmarks/body-event-loop-20261014/`. Remaining work: finish controlled model qualification when service ownership is resolved, verify compiled source, and activate only within the owner's runtime authorization. Source evidence delivery is repaired; model interpretation, response repetition, and the firmware rejection are not declared solved.

Staged Site build completed at 21:08:26 PDT under `apps/site/node_modules/.cache/body-event-repair-build`; source repairs have not been activated. The task adds no new response suppression or retry gate.
Compiled runtime verification subsequently passed against `/home/greggles/metahuman`, including all 45 workflows. Model qualification remains incomplete because services stopped; the approved Goal Review wording remains unapplied and unevaluated.

## 2026-10-15 — speech interruption and abandoned delivery repair

### 09:08 PDT incident — repeated approach announcement, one conversation entry

Read-only investigation of execution `16873fd9-9c17-4087-a0ce-9a41f52b122d` found two distinct model-selected utterances. Task speech work `task-1792080487395-4f591dc2` spoke “I'm moving closer now to get a better look at your expression.” Its two chunks completed at 09:08:13 and 09:08:15. Conversation inference `task-1792080501807-1138d9eb` then generated the longer glare response, repeating that sentence as its opening. Speech work `task-1792080510074-71d712c9` rendered that full response once; its three chunks completed at 09:08:36, 09:08:43 and 09:08:51. Body Control receipts identify computer playback. The supplied conversation context already contained the initial speech text, its delivery identity, and completed speech evidence in `taskResult`; this was not an absent-receipt case. The Task speech branch calls TTS directly without conversation-buffer admission, whereas conversation delivery persists its response before TTS. That explains two audible occurrences of the opening with one full chat entry. Records establish repetition of the opening; they do not establish two complete playbacks of the full paragraph. No source changes, model calls, or robot commands were made for this investigation. Remaining work: align selected task speech with canonical conversation evidence and separately evaluate the model's repetition despite supplied completion evidence, without text filtering or unapproved prompt changes.

### 09:21 PDT — remove Task's direct speech delivery path

Owner explicitly authorized removing the duplicate path while retaining model-selected speech steps. Active Task now calls the same Environment conversation-delivery owner as generated Persona replies. That owner runs the existing editable `environment-conversation` graph: buffer admission, configured memory capture, then TTS Output. Selected text is passed unchanged; no model inference, prompt change, response filter, new queue or playback wait was added. TTS Output returns its existing admission result to the task's receipt tracking. Existing speech-step admission errors remain errors.

Eighteen focused tests passed, including a real isolated durable-graph integration: one exact assistant buffer record, one long-term memory record with memory saving enabled, one robot-render admission, and no duplicate record/admission when the saved execution is replayed. The task finishes its selected phases without a graph-node playback wait; the execution separately retains its outstanding render work. Core typecheck, staged Site build and compiled/source verification of 45 workflows passed. Both speech tests are registered in the durable-execution test command. No physical actions or model evaluations were dispatched for this repair.

Activation is pending: Full Auto still had unfinished workflows at the deployment check. Requested approval to briefly pause admission, cancel those live workflows with their results preserved, and restart MetaHuman. This repair does not establish that the Persona model will stop choosing repeated words; that remains a separate evaluation.

### 09:30 PDT — duplicate feed entries traced to Goal Review

Read-only inspection confirmed exact duplicate persisted conversation entries, not a browser-only rendering duplication. In execution `87831981-1f0a-4186-a211-66ccd8f910d5`, the Persona conversation at 09:19:57 was repeated at 09:20:18; the next Persona conversation at 09:21:34 was repeated at 09:22:07. Each pair has distinct buffer occurrence keys and distinct robot-speech rendering work. Saved Goal Review checkpoints contain the exact earlier Persona text in the review model's raw JSON `response` field, which its parser forwards for delivery. Both reviews selected `outcome:continue`, resulting in additional observation/continuation work. This is an independently authored duplicate response from Goal Review, not a transport replay or the Task executor's direct-TTS branch. Removing that Task bypass does not resolve these review-generated duplicates. No prompt changes, runtime mutations, or physical/model calls were made during this diagnosis; next repair boundary is Goal Review's user-response responsibility and its handoff to the conversation owner.

Owner clarified the product contract: new input proceeds immediately and newer speech interrupts the previous utterance. Completion receipts report outcomes; an old speech receipt must not authorize or delay replacement playback. Chunks within the same utterance retain their order. No model-visible instructions changed.

Observed startup backlog at 08:18 PDT: 18 speech chunks and five graph continuations. The first speech claim was from the previous evening. Its action identity had no record in the running Body Control receipt database; Core had restored the claimed item as outcome_unknown without requesting cancellation/reconciliation. Shared user-turn interruption cleared browser delivery only. Body Control additionally serialized whole PCM producers, delaying replacement speech.

Repairs at existing owners:
- Coordinator interruption cancels old render work and unsent chunks, allows replacement speech immediately without the old receipt, and preserves movement independence. Late chunks and responses from interrupted turns cannot replace current speech.
- Shared TTS user-input/manual interruption now reaches robot speech. Stream closure releases its own interrupted delivery through the existing cancellation transport. Restart performs the same reconciliation and cancels the interrupted utterance's remaining chunks.
- Unsent speech cancellation now delivers factual not-sent evidence to the owning durable execution. Activation exposed a race between that delivery and terminated-parent reconciliation; confirmUndispatched now verifies the original receipt and reuses its committed confirmation, including after terminal result delivery. The parent objective is not automatically cancelled or declared achieved.
- Body Control cancels the previous PCM producer at the speaker handoff; its computer playback path also interrupts the previous process. These changes do not flash firmware, synthesize substitute responses, or change model choices.

Validation: 33 final Coordinator/cancellation tests, eight stream/camera-read tests, 65 receipt/recovery tests, and 18 Body Control speech/pacing tests passed. TTS delivery tests also passed. The existing gateway-restart speech test expected a fabricated cancellation; updated it to require unknown earlier effect plus positively identified ended execution session. Core typecheck and staged build passed before final activation; final deployment verification follows below.

Broader workflow test limitation: 34 existing tests fail on stale intent fixtures or associated graph expectations (for example needsConversationHistory/needsMemory/needsRobotStatus are no longer accepted intent fields). Those tests fail before the speech repair path; their contract migration is separate work, not concealed by relaxed parsing. Repeated Body Event/model-authored reactions and motion-mapping errors remain separate unresolved issues. User explicitly approved activation after observing MetaHuman had been stopped externally.

Activation and live evidence, 08:50–08:56 PDT:
- Final staged build and compiled-runtime parity verification passed, including 45 graph definitions. MetaHuman started through `start.sh --app-only`; Body Control restarted through its existing physical-gateway entrypoint. Existing model and Kokoro services were retained. No firmware was flashed and no movement test was dispatched.
- The previous evening's abandoned speech claim received a real cancellation result from Body Control after reconnection. Its missing historical receipt no longer holds the speech resource.
- First live test used an unsupported standalone, non-durable rendering invocation. Playback interruption occurred, but both rendering jobs failed with `Robot speech admission did not complete`; this is not counted as a passing graph integration test. Evidence: `/tmp/robot-ready/live-speech-replacement-result.json`.
- Repeated using the existing audio-preparation, command-preparation and Coordinator submission owners. The first utterance was playing; the second interrupted it, cancelled its remaining unsent chunk, and completed playback. Replacement command admitted at 15:55:55.400 UTC; old playback cancellation recorded at 15:55:55.545 UTC, and replacement playback completed at 15:55:59.797 UTC. Evidence: `/tmp/robot-ready/live-prepared-speech-replacement-result.json`.
- Playback target was Body Control's configured **computer** speakers. This proves live transport/computer playback interruption, not physical robot-speaker playback or an end-to-end model conversation. Robot transport preemption is covered by the gateway tests.
- Authenticated Queue snapshot at 08:56:04 PDT contained no active tasks, zero queued/running work, and no in-flight remote work. Evidence: `/tmp/robot-ready/natural-wake-2026-10-15T15-56-04-814Z.json`. Startup also reported old saved-graph conflicts and Body Event model-output failures; those are not declared resolved by this speech repair.

### 10:13 PDT — one final conversation output and selected-result handoff

Owner approved removing Goal Review's outward `response` field and supplying its assessment to final conversation instead. Owner additionally clarified that replies are not goals: Intent `needsResponse` selects the conversation route. Approved removing `response` from Task/Goal Review completion-basis choices; the remaining model-visible choices are action_result, visual_observation, environment_state and user_input. No other model prompt text was changed.

Environment Mode and Robot Autonomy Executor now order selected task results and applicable Goal Review before the final context builder. Intent analysis connects directly to `routingAnalysis`; each consumer retains its independently selected context. Existing graph dependencies provide readiness; inactive sources remain skipped. The builder does not generate text: the configured Persona model does, followed by one explicit Conversation Out. Goal Review's conversation, memory and TTS nodes were deleted. Its internal recursive continuation/wait nodes were removed; assessment and selected continuation return to the caller, which handles continuation after selected response delivery. Robot Autonomy Controller's direct review consumer uses the same finite assessment contract. No polling, timeout, response filter or duplicate-message suppression was added.

The existing execution-event receiver accepts the returned continuation once per pass; newer human input and task-result handoffs retain precedence. An interrupted/unfinished task pass does not start premature review or final conversation. Updated graph labels, positions and the editor-only guide distinguish context, task execution, assessment, Persona, Conversation Out and continuation. Browser node ports and canonical/public graph copies match. The graph validator now recognizes nested output paths already supported by the executor (for the child assessment and continuation outputs).

Validation: 81 focused owner/integration tests passed, plus 22 executor tests. A later targeted rerun of four action/result/continuation/restart cases passed after marking Conversation Out as the explicit graph output; 14 Task contract tests passed after adding rejection of response-goal output. Core typecheck, staged Site build and compiled-runtime parity verification of all 45 workflows passed. Simulated tests prove selected slow data delays the join, unselected camera work never starts, greetings call only Intent and Persona, assessment/receipts reach Persona, continuation starts after the reply is recorded, newer input supersedes an old continuation, and saved replies/assessments survive restart without regeneration or duplicate admission. No physical actions or actual-model qualification calls were dispatched.

Broader consumer check: 155/174 initially passed; 15 failures were Goal Review fixtures using its removed response field/old internal continuation ownership and were migrated and passed in the focused run. Four other existing failures remain outside this repair: two active-task-state tests expect the retired action-only review eligibility, one speech-interruption test expects an older job to complete rather than cancel, and one planner-context test rejects already-present capability wording. These do not constitute a passing full-suite baseline. Evidence: /tmp/robot-ready/final-response-{acceptance,scheduler,final-handoff,contract,consumers,typecheck,build,runtime-check}.log.

Activation: authenticated Queue inspection at 10:13 PDT showed Reactive mode, zero tasks and zero unfinished executions. Activated the verified staged build through the existing app-only restart owner; no workflows were cancelled. The earlier Task direct-TTS removal is included. Previous generated build retained under apps/site/node_modules/.cache/before-final-response-20261015-1013. Runtime health verification follows. Actual-model routing/grounding quality and physical playback remain separate live checks; removing the competing Goal Review publisher does not prove a model will never independently repeat wording on another turn.

Post-activation check at 10:14 PDT: compiled runtime matches source and validates all 45 graphs; server PID 197453 is running. Authenticated Queue GET returned HTTP 200, lifecycle running, paused=false, degraded=false, zero tasks and zero unfinished executions. Startup nevertheless reported old receipt-recovery errors, including task-1792077456059-18051f28: Execution intent is not eligible for non-dispatch confirmation. This is an unresolved runtime finding, not hidden by the empty Queue or declared fixed by the final-response repair. No receipt was deleted or fabricated.


### October 15 — Goal Review updates state; Active Operator owns further work

The 10:22–10:29 Boredom Observer burst was one durable execution. Its visual planner authored speech steps and walk commands; Persona also authored a final reply on each pass. Goal Review's `continue` assessment constructed another Environment/autonomy invocation, causing immediate replanning of the same goal. The supplied autonomy attribution was present, but the planner called its own intention a user request. Review inferred screen-viewing progress from face detections, which did not establish screen readability. These model errors and overlapping program-speech/Persona announcements remain separate from the removed execution loop.

Owner clarified that Goal Review updates Robot Status only; Full Auto or an appropriately triggered Semi Auto agent considers goals with other available context, plans work and executes it. After selected work, review can evolve or retire a goal. Explicitly authorized removal of the continue assessment and approved the exact objective/completionCriteria revision wording.

Removed continue from the review schema/parser/prompt; deleted the parser's workflow invocation and unused awaitContinuation output, caller continuation edges, Autonomy Controller's continue-reviewed-objective node and the event receiver's assessment-continuation input. Preserved actual user/autonomy events and task-result handoffs. Review now returns model-authored objective and completionCriteria through the existing Robot Status Out/durable execution owner, preserving the original instruction, objective identity and receipts. Abandonment retires active consideration without claiming success. No new manager, scheduling path, duplicate filter or automatic stop was added.

Validation and activation are pending below. Tests use simulated provider and robot transports. The initial regression pass exposed two fixture adapter setup errors (corrected) and two restart-version conflicts while source was changing; these are not passing evidence.

Validation: 69 distinct focused tests pass (68 in the combined run plus the affected Robot Status graph-contract test after migrating its retired activity-selection assertions). Coverage includes all supported assessment outcomes in Reactive/Semi/Full modes, no review-started workflow or speech, one Intent-selected final response, no further calls without new input, preserved revised-goal provenance/receipts, abandonment without fabricated success, revised-goal delivery to a separately triggered Full Auto controller, and saved-answer/receipt restart. Core typecheck and staged Site build passed. Compiled runtime matches current source and validates all 45 workflows. Task-scoped diff check passed. Evidence: /tmp/goal-review-removal-{tests-v2,status-rerun,typecheck,build,runtime}.log. No actual-model inference or physical actions were dispatched by these tests.

Activation pending owner permission: the 10:40 read found a newer Boredom Movement execution (b73bf620-f558-4f4b-8e92-92662bcedbb3) with a perception wait and live command work. Asked to cancel that execution through Queue and restart the app; have not cancelled it or changed running services. The 10:22 execution is no longer listed as active. Built output is staged at apps/site/node_modules/.cache/goal-review-state-only-build.


### October 15 — Visible autonomy intentions and long-term recall

Owner requested that autonomy-to-Environment commands expose the model's reasoning in the existing Inner Dialogue output and save the entry to memory under autonomy. Source inspection found that selected plannerDecision records existed in execution checkpoints, and optional outward responses could be saved as conversation, but the four autonomy-to-execution handoffs had no Inner Dialogue Buffer or Inner Dialogue Memory Saver.

The shared Robot Operator Environment Dispatch now emits a reflection entry containing its delegated instruction, stated reason and observation. Observer, Movement, Reflection and Full Auto Controller graphs route the entry through the two existing output nodes before forwarding the unchanged child invocation. Saved entries retain source=autonomy, dialogueSource/agentId, decision timestamp, original observation timestamp, triggerSource, sessionId, cycleId/correlationId, step, target graph, executionId and structured plannerDecision. Tags include autonomy and autonomy-intention. A manually triggered autonomy planner retains triggerSource=user without attributing its model-generated intention to the user. No model-visible prompt change or extra LLM call was made. No TTS path was added.

The existing memory-write policy remains at its owner; Environment-triggered workflows provide canWriteMemory(environment), which currently enables these saves. Buffer admission and long-term capture retain existing occurrence identities, so resuming the same execution does not republish its entry, while distinct decisions with equal text remain separate records. Controller entries gain an Autonomy label in the existing reflection card; the three Boredom labels already existed. Validation and activation follow below.

Validation: 44 combined tests passed across the new six-case autonomy intention suite, existing autonomy workflow tests and durable goal-continuation integration. The new suite exercises each of the four real saved handoff/output paths with simulated child execution, real durable buffer admission and actual local memory files, checks unchanged delegated instruction, full provenance/time preservation, no public conversation, no duplicate replay, distinct equal-text decisions and rejected handoffs. Three additional delegation/dispatch checks passed. A broader name selection also hit the already-recorded planner-context assertion rejecting the pre-existing requested-step-count capability text; that unrelated test remains failing and was not weakened.

Core typecheck passed. The final Site build includes the Autonomy card label; compiled runtime/source parity and all 45 saved workflows validate. Canonical/public graph copies match and task-scoped diff check passed. Evidence: /tmp/autonomy-inner-output-{integration,dispatch-tests,typecheck,build,runtime}.log. No production model or physical robot action was called by these tests. No new prompt wording was introduced by this output repair.

Not activated: the combined Goal Review and autonomy-inner-output changes are staged in apps/site/node_modules/.cache/autonomy-inner-output-build, superseding the earlier staged Goal Review build. The previously requested live-work cancellation/restart approval remains pending; no additional work was cancelled and running services were not changed.

Activation at 10:54 PDT: owner explicitly requested activation. The authenticated pre-activation Queue read found zero queued/running tasks and no unfinished executions, so no workflow or command cancellation was necessary. Verified staged compiled-runtime/source parity, retained the previous build at apps/site/node_modules/.cache/before-autonomy-inner-output-20261015-105426, switched the staged build into apps/site/dist, and requested the existing app-only restart via ./start.sh --restart-app. Model and Body Control services were left to their existing owners. The new server reports listening at 10:54:26 PDT. Authenticated Queue returned HTTP 200 with coordinator running, paused=false, degraded=false and no unfinished executions. Served Goal Review and all four autonomy handoff graphs contain the repaired contract/output wiring. Compiled runtime matches current source and validates all 45 workflows. No physical action or actual-model evaluation was dispatched to verify activation; live model and robot behavior remain to be observed. Evidence: /tmp/autonomy-inner-output-live-runtime.log and /tmp/robot-ready/natural-wake-2026-10-15T17-54-35-452Z.json.


### October 15 — Autonomous evidence handoff and shared execution workflow (in progress)

The recorded lighting incident supplied Task with inputSource=autonomy and the planner decision, but Qwen described it as a user suggestion. That Task call contained no persona, dialogue history or retrieved memories, so those sources did not directly cause this instance. Unchanged-context replay reproduced the error twice. The approved attribution wording failed 3/3 replays, assistant-role authorship failed 3/3, and their combination failed 3/3; none is deployed. Big Brother interpreted authorship correctly in two identical-context baseline comparisons. These are narrow actual-model observations, not overall accuracy or physical success. No actions were dispatched by these evaluations. Evidence is retained locally under /tmp/autonomy-evidence-repair.

Separately repaired the factual handoff: Observer/Controller now carry the selected frame identities, original timestamps and current-image selection into execution. The observation-current flag comes from the bridge output, rather than inherited initial context. Task-selected speech now carries the same autonomy provenance as Persona responses through existing buffer, memory and speech owners. Thirty-five distinct focused tests, Core typecheck, staged Site build and all 45 then-existing workflow validations passed; these source changes were not activated before the next requested refactor.

Owner authorized merging Robot Autonomy Executor into Environment Mode with two explicit inputs, then explicitly requested deletion of the duplicate executor to prevent confusion and regression. Environment Mode remains the single execution graph. The independent Autonomy Controller and boredom planners remain intention producers. The merge preserves existing human/autonomy prompt text verbatim, source metadata, and selected result joins; it does not deploy the failed prompt experiments or train an adapter. Validation and activation remain pending. After the shared workflow is stable, paired human/autonomy attribution tests should qualify any proposed training change; no autonomy LoRA is yet trained or selected. Separate known Goal Review grammar compilation and cancellation-recovery failures remain unresolved by this change.

Merge implementation: Environment Mode now has Human Input and Autonomy Input feeding the existing Environment Request join. Shared Intent/context nodes select their original source-specific prompt properties. All eight instruction strings were compared byte-for-byte with the pre-merge graphs. Source metadata reaches Task speech and Persona; a new human message clears inherited planner attribution. Body Event and autonomous producers replace the other source's inherited turn fields. The two retired executor JSON files are deleted, all maintained callers and training prompt loading now use Environment Mode, and the duplicate service-level autonomyGraph setting was removed in favor of environmentGraph. The Controller remains separate. History keeps its pre-merge source-specific inner-dialogue selection. Shared Task/vision model nodes use Environment Mode's existing sampling settings (repeatPenalty=1); the retired executor had 1.15. No model-role assignment was changed by this merge.

Concurrent-work note: another owner-authorized task consolidated environmentIntent into orchestrator and moved larger planning delegation to planner while tests were running. The owner confirmed that migration; this repair preserves it and updates its isolated fixtures accordingly. A newer Goal Review role assignment also required psychotherapist in the isolated test model registry. These changes invalidated the intermediate build and some fresh-process test runs; those runs do not establish acceptance.

Broader baseline findings, not repaired here: durable-execution/workflows.spec.ts still supplies retired Intent fields, producing unsupported-field failures and subsequent fixture lease failures (34 failures). buffer-ownership.spec.ts expects retired direct Environment/Goal Review conversation writers and omits current delivery graphs. robot-operator.spec.ts has stale queue-watch and dashboard-text expectations. An intermediate Core typecheck encountered concurrent llama-cpp.spec.ts lines 419–421 narrowing errors. These are separate from the shared graph's focused behavioral checks; no validation was weakened to hide them. Final validation/activation is recorded below when complete.

Final merge qualification: 109 distinct focused checks passed across the shared human/autonomy graph, selected context and final-result routing, real durable goal persistence/continuation/restart with simulated transport, dated image handoff, speech provenance, Inner Dialogue persistence, history, graph/editor contracts and producer dispatch/configuration. The 103-case run had one outdated assertion listing robot_operator_input as retired; it was replaced with the requested one-Autonomy-Input assertion, and all six graph-contract tests then passed. Six producer/configuration checks also passed. Source-specific instruction strings remain byte-for-byte unchanged. A separate production-source TypeScript check passes; full Core typecheck still reports the concurrent llama-cpp.spec.ts narrowing errors listed above. The Site build passes, scoped diff checks pass, and compiled runtime matches current source with 44 workflows validated. Evidence: /tmp/autonomy-evidence-repair/merge-{qualified-tests,final-graph-tests,final-dispatch-tests,production-typecheck,qualified-build,live-runtime}.log.

Activated at 11:43 PDT via the existing app-only restart owner. Pre-activation Queue had zero queued/running work and zero unfinished executions, so nothing was cancelled. The old build is retained in apps/site/node_modules/.cache/before-autonomy-merge-20261015-114313. After restart, authenticated Queue returned HTTP 200 with running=true, paused=false, degraded=false and no queued/running work or unfinished executions. The served Environment Mode graph has 43 nodes and both Human Input and Autonomy Input; Intent uses the concurrently consolidated orchestrator role. The retired boredom-autonomy-mode.json URL returns 404. The independent Autonomy Controller remains available (HTTP 200). Model and Body Control lifecycle were not changed. These activation checks prove runtime/editor wiring, not physical robot behavior or resolution of Qwen's known authorship confusion. Next model-quality work is paired human/autonomy evaluation against this shared workflow before deciding between a qualified wording revision and targeted adapter training.

### 2026-10-15 — Training GPU handoff and repeated speech diagnosis

Owner requested all models use Big Brother while training and the GPU remain free. Through the existing model-registry assignment handler, all nine language-model roles were assigned to `big-brother.configured` in defaults and Dual/Agent/Emulation/Environment overrides. The embedder remains its existing non-chat provider. Existing Kokoro device owner moved synthesis from auto/GPU to CPU and verified readiness; Whisper was already CPU and ready. Both llama.cpp services were stopped through `bin/llama-cpp-services`; boot autostart was disabled, retaining the linked 9B unit for explicit future startup. The 9B service required its existing systemd stop timeout to exit. No model files were deleted. Prior registry and voice configuration are retained locally under `/tmp/metahuman-training-handoff/`. An unchanged recorded planning request through the configured Vision role returned from Big Brother / GPT-6 Sol in 5.933 seconds, without physical action dispatch. Final GPU inspection showed no compute processes and approximately 14.2 GiB free; desktop/display allocation remains. User indicated Blender would be closed; this task did not close it.

Owner also requested investigation of duplicate answers. Confirmed exact 11:55 message beginning “You know, that look on your face…” appears twice in the persisted conversation buffer, at 18:55:09.342Z and 18:55:29.383Z, under Boredom Reflection execution `bd7e4781-7cf7-4e8c-874c-774f987ba795` and the same correlation ID but different output identities. Saved checkpoints show the first came from a Task-selected speech step through `active-task` and Environment Conversation; the second came from final Persona response through a separate invocation of that same output workflow. Both buffer and TTS nodes completed for each invocation. Intent selected both needsAction and needsResponse. The final conversation context did contain the exact prior speech text and its admitted/rendering evidence; this is not simply absent task-result context. Persona nevertheless returned the same sentence. The defect is overlapping conversational authorship/admission between program speech and final response, not a frontend-only duplicate or one TTS item played twice. No duplicate-output source repair, prompt change, cancellation, or suppression was applied in this diagnostic. Local checkpoint evidence: `/tmp/metahuman-training-handoff/duplicate-*.json`. Next repair should resolve speech ownership while preserving explicitly selected ordered speech; do not use text deduplication to hide competing output decisions.


### 2026-10-15 — Independent 9B autonomy/persona LoRA preparation

Owner requested two independent candidates without deployment or production-role changes. This task prepared local review evidence at `out/ainekio-9b-lora-preparation-20261015/REVIEW.txt`, with source/artifact hashes, exact draft messages, family assignments, token measurements, retained negative examples and reproduction scripts. This is preparation, not completed training or qualification. No new launcher, production prompt, model assignment, adapter activation, service lifecycle change or physical command was introduced.

**Current baseline and resources.** Canonical profile configuration resolves the Environment language-model roles to Big Brother following the concurrent GPU handoff. The initially observed local 9B process used the installed Q4_K_M GGUF, F16 projector, dynamic-KV llama.cpp binary, q8_0/q4_0 KV cache and one slot. Its subsequent shutdown was confirmed; the requested unchanged replay through Core's llama.cpp provider failed with `ECONNREFUSED 127.0.0.1:8080`. No new 9B output was obtained. Previously saved Qwen authorship failures and Big Brother comparisons remain historical regression evidence. Final hardware reading: RTX 4080, 16,376 MiB total / 14,639 MiB free; approximately 5.0 GiB disk available. Local BF16 weights alone do not fit. Unsloth's published example estimates 22 GB for 9B BF16 LoRA and cautions about Qwen3.5 four-bit training; longer complete examples require measured capacity. No remote resources were reserved or charged and no profile data was uploaded.

**Dataset readiness.** The existing personalization inspector found 815 source memories, 24 curated records, 21 rejected records and three nominally trainable legacy reviews. The three lack verified mode attribution, so the canonical Environment-only selector returns zero training and zero evaluation examples. The existing Environment decision bank contains 403 decisions and one rejecting review, with zero approved positives. These findings concern eligibility, not permission to reinterpret old modes or learn raw outputs. The packet contains 12 synthetic executor drafts across six source-paired families and three attributable persona review examples, all explicitly unapproved. The source-family allocation precedes paired generation; the recorded lighting and previously inspected persona incidents remain regressions. Fresh final-evaluation families and reviewed high-level planner examples remain outstanding.

**Contract evidence.** Six executor drafts pass the existing output validator. Six speech-bearing drafts are blocked: the current Environment Task prompt permits speech steps and `requiredCompletionBasis: response`, while the working-tree helper rejects both. This task did not change that concurrent speech-ownership work. Owner instructed preparation to continue independently. The blocked records are diagnostic drafts, not positive training labels. The current personalization selector reconstructs conversational pairs and a persona context; it does not directly ingest arbitrary exact planner/executor messages. Existing personalization review exposes Ollama/vLLM, while Core's llama.cpp provider separately supports loaded-adapter selection. Exact autonomy ingestion and llama.cpp candidate review need work at the existing owners; the 0.8B specialist configuration remains unchanged.

**Identity, tokens and validation.** Installed 9B GGUF, projector and server checksums are recorded in the private manifest. Its metadata identifies the Qwen upstream but not an exact source revision, so native-weight lineage remains unverified. Only public tokenizer/configuration files were fetched from pinned `unsloth/Qwen3.5-9B` revision `005429cee5cb648998cf2b70eebdd83175989c9a`; native weights were not downloaded. Native and installed template source bytes differ, but explicit non-thinking rendering matches on all 17 measured records. The real trainer tokenizer verifies final-continuation-only labels on all 15 target-bearing draft/review records. Complete examples measure 249–1,584 tokens; the complete lighting regression needs 7,208 autonomy / 6,897 human prompt tokens before output. No truncation was used. Future capacity must follow the complete approved corpus, not the profile's current 2,048 sequence setting. Identity-only/no-static persona variants are written as exact proposals for owner review, not applied; 304/344 standalone-section tokens are potential savings, not behavioral qualification or measured whole-prompt savings.

Existing focused evidence: the two Core objective/dataset test files passed; all six dataset-pipeline checks passed after rerunning outside the sandbox to permit its Python subprocess; Python trainer contracts passed eleven checks with two optional actual-model tests skipped. No optimizer, exported-adapter, served-candidate, composition, long-context behavior or physical qualification ran. Remaining work: owner example/variant review, corpus curation and exact-context preservation, fresh independent evaluation families, verified native base, resource quote/authorization, small independent diagnostic fits, and native-versus-served evaluation. Production persona injection remains intact and no static material is yet qualified for removal.

### 2026-10-15 — Single Persona speech owner repaired and activated

Owner approved deleting Task's `kind:speech` step and its delivery path, accepting removal of exact spoken lines inserted between motion steps. Approved replacement: “The task planner selects task state and executable actions. The conversation model receives the selected task results and generates the outward response when Intent selects needsResponse.” This replaces the former speech-step wording in both shared graph source prompts and capability context. The schema branch, parser case, program type, Task speech admission/progress state, conversation-delivery call and unused Task speech metadata edge are removed. The final Persona delivery retains buffer/memory/TTS ownership. No text-equality suppression, additional waiting, automatic stop, or fallback was added.

Migrated speech delivery/replay and playback receipt tests to the surviving conversation owner. Focused latest results cover 133 distinct passing checks across parser/schema/context, shared human/autonomous routing, explicit silence, final action evidence, conversation persistence/replay, correlated speech playback, graph contracts, and training corpus. Production Core typecheck passes. Full Core typecheck still has the three previously recorded `llama-cpp.spec.ts` lines 419–421 narrowing errors; those files were not changed. Site build and compiled/source parity passed with 44 workflows validated. Scoped diff checks pass.

Three offline replays rebuilt the recorded duplicate incident's Task context with the approved contract and used configured Big Brother / GPT-6 Sol, without action dispatch. All returned valid current-contract outputs and no speech steps. Two selected a face expression and one selected adapter `sendText`; all retained a conversational task objective. Thus the competing speech path is removed, but model task-selection correctness is not qualified by this repair. `sendText` remains a separately advertised adapter-text capability, not TTS; the gateway publishes a transcript. Its conversational misuse is recorded for separate investigation, not silently filtered. Recorded input, schemas and outputs are retained under `/tmp/persona-speech-repair/replay-*.json`.

Owner reserved specialist training sources for this repair. Source labels and generated corpus are now version 16: speech-only requests have no Task program, mixed requests retain physical/sensing steps, and explicitly requested speech uses Intent's response route. All 6,358 development, 1,518 evaluation and 187 regression records have zero speech-step targets, including larger-planner reference outputs. Existing run snapshots, adapters and qualification reports were not modified. These revised comparison references must not be mixed with previous-version scores; reviewed cases are not newly unseen holdouts. The training README and Robot Bible describe the new boundary.

Owner authorized cancellation of incident execution `bd7e4781-7cf7-4e8c-874c-774f987ba795` and activation. Cancelled that execution via the authenticated Queue endpoint with history preserved; briefly paused admission and used an app-only launcher restart at approximately 12:10 PDT. One Body Event execution already in flight at preparation, `a9ac1aa6-3739-4127-96db-5c04b25ebdad`, subsequently became failed across the runtime transition; startup logged the existing executable-version conflict. It was not silently migrated or cancelled by this task. Post-start authenticated Queue reported running, unpaused, not degraded, zero queued/running work and zero unfinished executions. Served Environment Mode returned HTTP 200, contained the approved wording and one final conversation delivery node, and lacked the retired speech wording. Big Brother role assignments remain, local llama.cpp services remain stopped, voice remains CPU, and GPU inspection showed no compute processes. No physical or audible robot validation was performed. Prior Site build is retained at `apps/site/node_modules/.cache/before-persona-speech-20261015`.


### 2026-10-15 — 9B training resource follow-up and approved seeds

The Installation Owner approved both exact candidate-only persona ablations (identity plus goals, and goals without static persona), preserving all dynamic context and execution contracts. The owner also approved six paired capture/change-goal/cancel autonomy seed targets and the attributable “How are you?” greeting continuation. The function-status and dream examples remain diagnostics. These approvals are recorded with sample identities in the private preparation packet; they do not authorize a paid run or production changes. The seven seeds are not complete independent training/evaluation corpora.

Refreshed the six valid autonomy prompts and paired lighting regression through the current Environment context builder after the single Persona speech-owner repair. Old speech-bearing Task targets remain in the original snapshot as excluded diagnostics; the earlier reported contract discrepancy is no longer a current blocker. All six refreshed action targets pass the current parser. The current eleven tokenizer comparisons render identically with explicit non-thinking mode; final-continuation masks pass on nine target-bearing review records. Complete review rows use 249–1,478 tokens; the lighting prompts now use 7,022 autonomy / 6,711 human tokens before output. These counts supersede the earlier snapshot; no context was truncated and no model inference ran.

Corrected the feasibility distinction after the owner reported previous local 14B training: fully GPU-resident 9B BF16 weights exceed the 16 GB GPU, but this does not rule out local quantized LoRA training. The canonical trainer supports 4-bit loading and Unsloth checkpointing. Its current pinned-package/CUDA preflight passes outside the sandbox; the sandbox failure was accelerator visibility, not a broken local environment. A located successful 2025-12-31 Qwen3-14B log records 4-bit loading on a remote RTX 5090, and does not establish or contradict the separate owner-reported local runs. No local 9B fit or quantization-quality comparison has yet run. After the owner's cleanup, free disk is 19.65 GiB; native weights alone are 17.98 GiB, before checkpoint/export workspace. No weights were downloaded.

Read-only authenticated RunPod checks confirmed an available account and no active pods or hourly spend; balance and live quotes are retained only in the private packet. The configured trainer tag was last pushed 2025-10-27, whereas current source pins Unsloth 2026.8.3 / Transformers 5.5.0. The worker uploads current trainer and requirements then checks packages, without upgrading the image. Public image manifest/config metadata was read without pulling image layers. Remote environment readiness remains unverified; no image was built or published and no template changed. A 48 GB GPU BF16 quote and 80 GB alternative include the existing launcher's 306 GB volume plus 40 GB container allocation. Duration scenarios are estimates, not an authorized run or measured throughput.

The updated private REVIEW.txt and machine-readable manifests identify approved examples, exact experimental wording, current source hashes, local readiness, account/quote evidence and remaining owner integration work. Remaining work includes a sufficient curated persona corpus, full planner/executor envelopes through the existing personalization dataset owner, fresh family-independent evaluation, a verified common native snapshot, then independent diagnostic fits and native/exported/llama.cpp comparisons. No adapter was trained, deployed or overwritten, and no physical commands were dispatched.

### 2026-10-15 — Restored pre-training local model assignments

Owner moved training to RunPod and requested the original LLM settings. Restored the exact saved default and cognitive-mode assignment maps from the pre-training handoff backup, removing temporary all-role Big Brother overrides and retaining current model definitions and artifacts. Environment Intent/Task again select the existing .8B Intent/Task adapters; Persona, Planner, Vision, Curator, Coder and Summarizer use local Qwen 3.5 9B through llama.cpp. Pre-existing Big Brother assignments (including Environment Psychotherapist and global Persona) remain as saved.

Re-enabled both existing llama.cpp systemd units and started them through `bin/llama-cpp-services`; both report active/enabled and healthy. The shared .8B server lists the two expected adapters. Restored Kokoro device selection to `auto` through the voice lifecycle owner; its managed restart completed and health reports CUDA with no fallback. Whisper remains CPU. The running Site's authenticated model-registry endpoint returned HTTP 200 and the restored Environment assignments. No app rebuild/restart, new model training, inference-quality evaluation, or physical command was performed. The previously activated single-Persona speech repair remains in place. Evidence is in `/tmp/metahuman-training-handoff/restore.log` and `restored-live-registry.json`.


### 2026-10-15 — Authorized RunPod trainer update and first 9B diagnostic

The owner explicitly requested updating the online training system and training there. Updated the existing personalization remote worker to install the uploaded pinned requirements before its existing environment validation, so the old template does not prevent current Qwen3.5 dependencies from running. Kept Core's launcher and the shared Python trainer; no alternate launcher, production model assignment, robot action path or 0.8B adapter changed.

Added an explicitly reviewed-message input through the same Core launch/dataset owners. It preserves complete planner/executor messages, per-sample system context, source hashes, target authors, review attribution and family splits, including prior frozen split history. The same manifest consumer verifies the objective and target author. The native checkpoint revision is frozen in the launch configuration and saved in the PEFT adapter for reload. Optional native baseline/reloaded-candidate generations retain exact evaluation prompts, outputs, latency, token counts and peak allocation. These outputs supplement loss rather than establish behavioral acceptance.

Prepared two intentionally small BF16 diagnostics from the same pinned 9B base: autonomy has four training examples and two separate cancellation-family evaluation examples; persona has five individually reviewed attributable expressions and one expression from a separate conversation. Excluded known errors, unsupported action/vision claims and the dream incident. No paraphrases were generated. Full native example lengths are at most 1,478/345 tokens, with 9,216 capacity provisioned for the longer authorship regression plus the existing 2,048 output allowance. The native baseline will replay the retained authorship case before optimizer steps; final fresh behavioral evaluation remains distinct and unperformed.

Validation before launch: shared Python contracts passed eleven checks with two optional GPU cases skipped; eight dataset-pipeline checks passed, including real Python manifest consumption and preserved exact messages. Core launch/dataset and artifact/history focused files passed. Brain typecheck passed. Core typecheck still has only the three previously reported llama-cpp.spec.ts lines 419–421 errors. Source diff checks pass. The first run was admitted by the canonical launcher at 19:40:49Z; provider creation is confirmed and SSH readiness is pending. Account and pod identities/costs are retained in the private remote-diagnostic packet, not this maintained document. No optimizer or candidate success is claimed at this checkpoint.

### 2026-10-15 — Active Operator agent ownership consolidation

Owner requested an Active Operator agent to command the existing operator functions before configuring new behavior. Moved the existing persistent scheduling implementation and its test from `brain/services/robot-operator` into `brain/agents/active-operator/index`. The catalog names that single agent Active Operator and maps its source directory through the existing source-identity mechanism. Retained the durable `robot-operator` ID, lock, settings key, runtime records and six child-workflow ownership links. No parallel scheduler, new model call, prompt change, trigger timing change or mode behavior change was introduced. Agent Monitor retains process lifecycle; the Core mode controller, Work Coordinator and shared Environment workflow retain their existing responsibilities.

The Agent Catalog entry now embeds the existing Active Operator mode control component. Dashboard, mode descriptions and child-owner labels use Active Operator. Agent Monitor default executable settings now follow the catalog's declared service path, so regeneration preserves the moved entrypoint. Removed the old service entrypoint and updated test registration, current Bible/architecture links and the existing roadmap's owner paths. Existing model assignments and trained adapters are untouched.

Acceptance: an isolated catalog test proves one discovered persistent agent, all six child links, preserved durable identity, executable resolution, boot/control availability and absence of a second Trigger Manager schedule. The real agent entrypoint runs against simulated Coordinator work: Reactive admits nothing, Semi admits its configured observer, switching back to Reactive becomes dormant, and Full preserves controller admission, graph-edit recovery and saved-execution signaling. Both focused tests pass, as do Agent Monitor's isolated lifecycle validator and the catalog/UI ownership check. Brain typecheck and production-only Core typecheck pass. The broader existing suites have unrelated failures: catalog expects 13 Trigger Manager entries but installation has 15; Robot Operator tests expect an obsolete watcher expression and dashboard heading; architecture test expects the independently restored thought agent-trigger file to be absent. Full Core typecheck reports existing llama-cpp test narrowing errors plus an unrelated active-task-state test type error. These were not weakened or repaired in this task.

Source/build evidence is separate from activation. The first staged Site build passed, but another task changed five shared motion source files immediately afterward, invalidating compiled/source parity. The second staged Site build also passed, but concurrent Core edits again changed the executable hash before parity verification. Activation is therefore deferred until the concurrent runtime work settles; repeated rebuilds were stopped rather than claiming that the staged artifact matches the moving source. The live installation remains in Semi with an unfinished Boredom Observer and Environment execution; neither was cancelled, and no service was restarted or physical command sent for this refactor. Private evidence and the before-task snapshots are under `/tmp/active-operator-agent/`.

After the owner rebuilt and restarted, the authenticated Agent Catalog returned one Active Operator entry using `agents/active-operator/index.ts`, with all six existing children attached. Live operator status is healthy and Semi/armed; Queue showed zero queued items and one running item at inspection. The background operator process itself retained its 10:08 start time, so the web restart did not relaunch that worker; its scheduling implementation was unchanged by this refactor. The installed compiled/source check still reports a hash mismatch after concurrent edits to motion types and the active-task node. This is live catalog activation evidence, not complete current-source parity or a fresh agent-process launch. No further restart, cancellation or motion was performed. Read-only evidence: `activated-catalog.json`, `activated-runtime-check.log`, and refreshed live snapshots under `/tmp/active-operator-agent/`.

### 2026-10-15 — First remote 9B diagnostic completed; independent persona run active

The authorized autonomy BF16 diagnostic completed through `launchTrainingJob` /
`full-cycle` on RunPod; its pod termination was confirmed. Private run label:
`2026-10-15T19-40-49-912Z`. Four reviewed training samples and two family-separated
cancellation evaluation samples are diagnostic coverage only. Native held-out loss
changed from 0.415508 to 0.022417, and saved-adapter reload produced correct null
program/cancel handoffs for both human and autonomous inputs. The lighting
regressions still fail the executable contract. The autonomous lighting output
stopped explicitly misattributing the request to the human; this does not establish
broad authorship accuracy. Training peak allocated memory was 19,695,173,632 bytes.

Exact native base files were hashed remotely. The first adapter reload used the
dependency's adapter-path loader; its `main` cache reference and sole native
snapshot both matched the requested pinned commit. Inspection identified that
Unsloth can discard an adapter's recorded base revision during loading. The shared
trainer now explicitly loads the pinned base before attaching the saved PEFT
adapter; a focused mocked regression verifies that boundary. The independent
persona diagnostic uses this correction and starts from the same base, not the
autonomy adapter. Run label: `2026-10-15T19-57-39-200Z`.

The owner explicitly approved temporarily stopping the production 9B server for
isolated llama.cpp comparisons and restoring its exact configuration afterward.
The autonomy adapter converted with the installed upstream converter. A live-base
replay showed cancellation already succeeds under runtime schema constraints;
native unconstrained gains must not be presented as a serving improvement. A
concurrent locomotion schema change affected lighting validation, so comparison
inputs were refreshed through the current Context Builder and archived separately
under the private packet's `serving-contract/`. Older baseline outputs are retained
with their original contract context, not silently relabeled. No physical actions
or model assignment changes were made. Serving comparison and persona results are
still pending at this entry.

### 2026-10-15 — Remote 9B diagnostics and serving comparison complete

Both independent BF16 diagnostics completed and both RunPod pods were terminated.
The account reported no remaining pods or hourly spend; the observed balance
change was approximately $0.32. Autonomy used 4 train / 2 evaluation samples;
persona used 5 / 1. Both are small diagnostic fits, not a completed broad training
campaign. Their native weight-shard hashes match the same pinned 9B revision.
The second run exercised the explicit pinned-base PEFT reload repair. Held-out
losses improved, but neither candidate is qualified for activation.

Actual llama.cpp comparisons preserved full context and sampled each adapter
independently. The exact GPU-projector configuration failed to fit; text tests
moved only the unused projector to CPU, with 22 unchanged base outputs matching
the production configuration. The autonomy candidate loses both lighting
objectives after serving and regresses one unconstrained cancellation format.
The persona candidate is more concise but retains invented experiences, source
confusion and an unsupported completed-movement claim under the real conversation
contract. Reduced static persona saves prompt tokens but has not demonstrated
reliable identity internalization. No production persona reduction or combined
adapter qualification is recommended.

The production 9B service is healthy, its startup arguments were restored exactly,
its adapter inventory is empty, and model-assignment bytes match the pre-comparison
snapshot. The existing 0.8B process remained unchanged. No physical actions were
dispatched. Full private results, manifests, commands, hashes, failure examples,
latency/VRAM measurements and remaining coverage gaps are in the existing
`out/ainekio-9b-lora-preparation-20261015/REVIEW.txt` packet. Broader attributed
planner/persona data and fresh final evaluation families remain necessary; these
results do not justify a larger fit on the tiny diagnostic seed set.


## 2026-10-15 — Active Operator activation modernization

Installation Owner approved the exact activation contract and clarified both modes: Semi requests every returned update at 100; Full requests the highest returned activation even below 100, with returned order resolving ties. Empty updates remain allowed. Reactive stays dormant. This supersedes the earlier Semi-only rollout preference.

The existing persistent agent and controller graph are the surviving owners. Agency now has Desires and Active Operator tabs. Activation meters, trends, stated reasons, instructions and dated work records come from the operation catalog and existing durable assessment checkpoints. No second activation store, scheduler or queue was added. Independent operation admissions preserve the existing output, memory, and execution owners. Old Semi timers, the global correlated-cycle barrier, selected-work waits, and the old single-task speech-capable controller contract were removed. Reflection/daydream/curiosity interval and inactivity admissions are migrated to Active Operator; manual invocation and Sleep retain their owners. Goal Review remains outside activation selection.

Source validation is complete; live services have not been restarted by this task. Focused owner tests passed 26/26 and selected graph integration tests passed 3/3. Durable-store and decision-continuity checks passed; an assessment-history SQLite initialization defect found during the combined run was repaired, and all four activation tests passed afterward. Production Core and Brain typechecks and the staged Site build passed. The final compiled runtime matched source and validated all 44 current workflows. The full Core typecheck still reports three pre-existing test errors in `llama-cpp.spec.ts:419-421`; older Goal Review and boredom fixtures also have unrelated baseline failures. These are not passing full-repository validation claims.

Read-only context assembly initially decoded unrelated historical execution payloads. The existing durable store now supports targeted lookup and lazy iteration; the activity projection reads referenced execution records, and activation history opens only relevant assessment checkpoints. This reduced the measured catalog read from about 17 seconds to 298 ms and profile context assembly to 452 ms, without truncating model-selected information or adding a second store.

Offline model checks used the approved wording and configured Persona role, with no physical dispatch. Six sparse-context cases returned valid activation JSON and exercised both mode rules, but reasoning-enabled inference took 71.5–125.1 seconds (median 87.3 seconds); some outputs inferred unavailable prerequisites. A separate read-only profile-context check took 111.7 seconds and returned an allowed empty update list. That check omitted camera acquisition and execution-dependent history nodes; it is not a full live-cycle qualification. Private results are under `logs/benchmarks/active-operator-20261015/`. A final catalog cleanup removed internal dispatch metadata from model-visible operation descriptions after the profile check. Valid formatting is not proof of useful autonomy.

Remaining work: activate the rebuilt services when requested; inspect the Agency tab live; qualify useful operation choices and assessment latency with current profile, camera, and action evidence. No model assignment, reasoning setting, or physical behavior was changed to conceal the slow or empty model decisions. Runtime operation admission and physical behavior remain unverified for this revision.


### 2026-10-15 — Autonomy training scope corrected to independent initiative

The owner clarified that the training goal is an independent robot companion that selects goals and activities, not imitation of current conversation or merely executing assigned tasks. The first broader executor draft (1,258 training rows) is retained privately but set aside. No new paid run or production assignment was made. The live decision bank snapshot contains 446 decisions (251 Intent / 195 Task) and one rejecting review, with no approved positives; none were admitted as positive targets.

Traced the current Robot Bible purpose and Full-autonomy definition, Agent Catalog, connected-body capability advertisement, Autonomy Controller, and Reflection/Movement/Observer graph contracts. The relevant Controller and intention planners use the shared Persona model role, currently the local base 9B; this training objective is autonomy decisions, not persona-expression training. The current connected body advertises gestures, camera acquisition, expression and goal-directed locomotion. Source capability advertisement does not establish physical qualification.

Prepared a replacement private draft at `out/ainekio-9b-autonomy-training-20261015/initiative/`: 1,048 training examples from 32 scenario families, 196 development-evaluation examples from six families, and 200 final examples from six separate families. Seven state stages and four evidence variants are correlated siblings, not independent real-world experiences. Examples cover exploration, play, companionship, embodiment, learning, reflection, imagination and specific desires. Stages distinguish new opportunities, useful work in progress, completed objectives, failures, disconnected body capabilities, new evidence and an explicit changed human context. Targets select operations or author high-level intentions. Historical assistant claims, dreams and private thoughts are attributed input context only.

All examples are synthetic; no conversation reply or raw model decision was copied as a positive target. Existing graph policy wording and canonical context builders are unchanged. Output schemas/parsers and canonical dataset/launch validators passed. Source, family and complete prompt splits have zero cross-split overlap. Native tokenizer measurement verified final-assistant-only supervision, with a 3,720-token maximum complete example and zero truncation; planned capacity is 12,288 to preserve the Controller generation allowance. The image-conditioned Observer is excluded from this text-only fit, although Controller examples can select that installed operation.

The draft uses the same pinned Qwen3.5-9B base, independent of the rejected diagnostic: BF16, rank 8 / alpha 16, two epochs, learning rate 0.0001, batch 1 / accumulation 8. It remains on Core training-launch -> existing personalization full-cycle -> shared RunPod trainer. A credential-free draft launch request, hashes, source snapshots, exact examples, split allocation and token report are prepared. Final cases remain outside the training upload.

Read-only provider quote: RTX A6000 48 GB $0.59/hour plus existing personalization storage, approximately $0.638/hour total; estimated 2–6 hours, proposed $4 authorization. The account snapshot showed $8.30 with a separate active pod spending about $0.60/hour. That pod was not changed. Representative-example and specific-run-budget review was requested using `initiative/REVIEW.txt`, as required by the original brief. Pending: owner review, any requested label changes, a funded full fit, native/served behavioral comparison, shared-role conversation regressions, and qualification of independent decisions and outcomes. No robot command was dispatched.

Owner approved the ten representative examples and this run up to $4. Canonical launch started `2026-10-15T21-10-08-733Z` on a 48 GB RTX A6000 at $0.6380556/hour including storage. The one-off supervisor uses the existing `waitForTrainingJob` cancellation owner with a deadline calculated from actual provider pricing and a three-minute termination reserve; no new launcher or runtime budget mechanism was added. Approval, immutable request, dataset identity and budget receipts are retained in the same private packet. Native baseline loss evaluation completed; training and behavioral qualification remain in progress. Two independently managed local 2B training jobs currently occupy the local GPU and the 9B service is stopped by that work; this run has not changed their lifecycle. The separate remote 0.8B training pod is also untouched. Final serving evaluation includes all seven scenario stages, matching no-thinking native-parity probes, retained authorship conversations and the actual empty-activation profile regression. No physical command was dispatched.

The approved initiative fit completed both epochs (262 optimizer steps; 4,824 seconds fitting). Its saved adapter was reloaded for independent evaluation, downloaded and hash-verified; the canonical worker confirmed pod termination at `2026-10-15T22:49:25.435Z`. Creation-to-cleanup time and the quoted all-in rate imply $1.0553, below the $4 authorization; this is a rate-based estimate, not an itemized invoice. Peak allocated training memory was 22.11 GB (23.78 GB reserved). Held-out loss decreased from 2.5370 to 0.4310. All eight native candidate responses pass the existing output parsers, versus zero native baseline responses; this is contract evidence, not qualification of useful autonomy. The shared trainer's numerical quality gate passed, but the candidate remains unactivated. Upstream llama.cpp F32 adapter conversion succeeded; native adapter SHA-256 is `1e3a711ea75cb31f0ab6fbd1820f11f0235de7502be6aee2aca67f59c49ad8d8`, exported adapter SHA-256 is `1755509909132d9e238087ab486210e22b2d9c094fcff04cea8a172fc46fe460`. Serving and shared-role conversation comparisons are pending local GPU availability while the independent 2B task completes its serving qualification. Private receipts are in `initiative/training-completion.json`, with reproducible commands in `initiative/COMMANDS.txt`. No model assignment or physical command was changed by this work.


### 2026-10-15 — Owner-requested removal of robot output caps and shortened comparison

The owner explicitly requested no artificial output-token limit and then reduced the autonomy serving comparison to 0.35% of the planned tests. The 71-case plan cannot express that fraction as a whole case, so the active comparison is one paired case (1.41%), the first case in the previously frozen order. The full capped baseline was interrupted with 28 completed cases, and the uncapped candidate sweep was interrupted with five completed cases. Interrupted in-flight cases are not scored as model failures. Prior results remain under the private initiative artifact directory; capped and uncapped results are separate.

The existing llama.cpp provider now accepts the backend's `max_tokens: -1` unlimited-generation sentinel, uses it by default, and retains explicit caller cancellation without an inference deadline. The existing backend configuration and eight robot graphs (autonomy, reflection, movement, observer, Environment, freestyle, status, and goal review) now request unlimited output. Their graph/editor schemas and the existing Backend Settings input accept that setting. Only token settings changed in graph JSON; model-visible prompt wording, context, capability contracts, and assignments were preserved. The installed llama.cpp source disables context shifting when the vision projector is loaded; actual context capacity remains a backend constraint, not an application output cap.

Validation: all 20 provider HTTP/API tests pass, including default, explicit, and persisted unlimited generation and retained caller cancellation. Node-default validation and all 44 graph validations pass; graph mirrors match. Core typechecking reports three existing `never`-narrowing errors in the unrelated image-routing test at `llama-cpp.spec.ts:432–434`; the failing block is byte-identical to the pre-edit snapshot. No physical robot command was dispatched. Source/configuration repair is not proof of deployment to an already-built running Site.

The owner-shortened paired comparison is complete: identical 3,263-token inputs and unlimited output; base 62.92 seconds / 4,504 completion tokens, candidate 3.72 seconds / 145 tokens. Both satisfy the current output contract and choose valid alternative operations. The base explicitly considers the sculpture's recorded absence; the candidate selects observation but repeats acquiring the sculpture without clearly adapting to that evidence. This single result does not establish functional superiority, so the candidate remains inactive. It is a Full-mode case, not Semi-mode qualification. No static persona reduction was tested or applied; prompt-token savings are zero. Private evidence and the recommendation are in `out/ainekio-9b-autonomy-training-20261015/initiative/SHORT-COMPARISON.txt` and `short-comparison-result.json`. The RunPod training pod was already terminated; only the local isolated comparison server was stopped afterward. Production inference services were inactive before and immediately after the comparison, and were not started by this task.


### 2026-10-15 — Owner-requested eight-case autonomy comparison

The owner requested a slightly longer comparison without the full suite. Selected eight paired controller cases from the frozen 71-case plan: six scenario families, completed-action authorship regression, and the actual retained Semi-mode input. This is a small diagnostic sample, not fresh qualification; previously exposed cases are explicitly identified. Exact prior uncapped results are reused (one base, two candidate). Both models retain identical prompts, complete context, sampling, reasoning, output validation, and unlimited generation. The existing private evaluation helper calls the canonical provider and activation-selection owner; no graph is admitted and no physical action is dispatched. Selection and reuse receipts, individual outputs, and semantic review are under the existing initiative artifact directory. Production inference services were inactive at preflight; isolated server PID 648918 uses port 18080 and the same model/vision-projector placement as the earlier comparison.

Eight-case comparison completed: base final-output validity 8/8, trained 7/8; median complete-call latency 37.7 versus 3.1 seconds. This is parser validity and descriptive single-call latency, not behavioral accuracy or a repeated benchmark. Both selected an operation in 6/8 cases; neither selected one in the retained Semi-mode case (trained returned 82, base returned empty updates). The trained adapter handled quiet-speech correction and new local evidence usefully, but one completion stopped with JSON only in reasoning and empty final text, and other instructions lost the changed-scene, plan-revision, or disconnected-body context. Base also showed imperfect plan-owner selection and dream/observation separation. Functional superiority remains unestablished; no deployment or assignment change was made. The private `SAMPLED-COMPARISON.txt`, `sampled-comparison-result.json`, and per-case semantic review retain the evidence. The isolated comparison server was stopped after completion; production services were left inactive as found. No additional remote cost or physical action occurred.


### 2026-10-15 — Owner-approved autonomy-only production assignment

After reviewing the eight-case results, the owner explicitly requested production use for autonomy only and approved a separate Autonomy category. Added `autonomy` to the shared category catalog and changed only the controller (`llm`) and Boredom Reflection/Movement (`planner`) node roles. Existing Model Resolver migration initializes the new category from prior Persona defaults and mode choices once; it preserves explicit Autonomy choices and later choices to inherit. No checkpoint ID or private model path was embedded in a graph. Persona conversation, Boredom Observer, Planner, Vision, and both 2B specialist assignments are unchanged.

Registered the verified GGUF via the existing Model Registry settings owner and assigned Ainekio Environment / Autonomy via the existing assignment owner. Model ID: `llama-cpp-lora.24c5af08d4c402b0`. The existing `llama-cpp.service` loads the immutable deployed adapter at default scale zero using its local systemd override; Autonomy requests choose scale one. Base conversation requests leave it disabled. The controller's existing image input is preserved; the adapter's base/projector accepted and correctly described a synthetic red square in a live inference smoke test using the unchanged maintained vision-smoke wording. This is image-path evidence, not general image-conditioned qualification.

The production service is running with the adapter loaded. Direct Model Router verification produced a valid Autonomy decision with adapter ID 0 / scale 1 and a conversation response without the adapter. No cognitive workflow was admitted and no physical robot command was dispatched. These configured workflows will use the adapter on their next admission; this task did not start autonomous robot operation.

Validation: 21 provider tests passed, including alternating Autonomy/Persona adapter isolation; registry migration/settings/category presentation checks passed; node defaults and all 44 graphs validate; Site build passed with existing bundler warnings. Core typecheck still reports the three pre-existing `never`-narrowing errors in the unrelated image-routing test at `llama-cpp.spec.ts:432–434`. No clean full-workspace verification is claimed. Private activation, live routing, image smoke, artifact hash, unchanged-assignment proof, and rollback payload are retained under the initiative `production/` directory. The earlier recommendation to keep the candidate inactive is historical evaluation advice superseded by the owner's explicit experimental-deployment decision, not by improved qualification evidence.

### 2026-10-15 — Disable Active Operator assessment reasoning

The owner requested reasoning off in Full Auto after live GPU context-cache allocation failures. Changed only the existing controller model node's `enableThinking` from true to false and synchronized its public graph artifact. Full and Semi share this assessment graph; conversation and other workflow settings are unchanged. The existing loader detects file changes for fresh admissions; already admitted executions keep their graph snapshot. No service restart, token cap, prompt rewrite, or test-issued robot command was introduced. Canonical/public JSON comparison proves this turn's graph change is solely the reasoning boolean. This configuration change does not establish that GPU memory exhaustion is resolved.


## 2026-10-16 — Demonstration response-latency review

Read-only review of October 15 durable checkpoints and audit records found substantial interactive latency independently of the cancelled runaway Active Operator assessment. The owner has not yet identified the exact demonstration time. At 18:05, “Hello, how are you?” reached speech admission 15.59 seconds after graph creation; measured Intent and Persona inference accounted for 1.283 and 3.900 seconds respectively. “Please stand up” reached first synthesized audio at 29.67 seconds; “What do you see right now?” at 26.17 seconds. The 19:48 “what do you see now?” request reached speech admission at 14.22 seconds, but synthesis started at 39.61 seconds and first audio arrived at 39.88 seconds. These measure graph creation to server-side milestones, not microphone capture to audible hardware playback.

Three separate areas need investigation: inter-node/checkpoint and continuation overhead (several seconds beyond measured inference); browser speech admission-to-synthesis delay (25.39 seconds in the 19:48 case, with only 277 ms for first synthesis); and the separately confirmed autonomy generation monopolizing the 9B server. The latter was cancelled October 15 with both durable cancellation and llama.cpp cancellation acknowledged. Interactive examples above had reasoning disabled. Disabling autonomy reasoning alone therefore cannot explain or repair all response latency. Browser-side receipt/unlock/network evidence is absent from these server records, so the long browser delivery gap is not yet attributed to a specific client defect. No production code, prompts, modes, models or services changed during this review.


### 2026-10-16 — Live wave timing check

With owner confirmation that Body Control is local, switched through Agent Monitor's existing service owner from Environment Bridge Remote to Local. Local bridge reported ready and advertised the connected P4 wave capability; no direct gateway command was used. Sent one “Please wave” through `/api/unified-queue` / `chat.persona` at 10:50:29 PDT (session `latency-wave-1792173029037`, task `task-1792173034797-3f78adf5`, execution `4f27250b-91a9-4498-becb-0421305758a8`). HTTP admission returned after 7.405 seconds; work started at +12.557 seconds; terminal failure was recorded at +62.841 seconds. Error: `llama.cpp /lora-adapters timed out after 2000ms`. The execution recorded no action/result events and did not reach motion planning or dispatch. No wave completion or conversational response was established.

During the test, the web-server process was using roughly a CPU core and trivial graph nodes had multi-second gaps between them. A subsequent direct read-only `/lora-adapters` request returned HTTP 200 in 271 ms. This establishes that the server was reachable at that later time, not why the earlier application request timed out. Current specialist serving is Qwen3.5 2B with separate Intent/Task adapters; do not describe this test as the earlier 0.8B setup. Remaining diagnosis: separate web-process scheduling/persistence overhead from backend latency using the recorded execution. No automatic repeat, new timeout, model-setting change, or service restart was applied.


### 2026-10-16 — Live CPU profile identifies Agent Monitor overhead

A 12.17-second V8 CPU profile of the running MetaHuman web process identified the dominant stall owner: 87.3% of sampled time was under monitor-stream `sendSnapshot`, 87.2% under `getAgentMonitorSnapshot`, and 85.6% under `getAgentLogs` (inclusive percentages overlap). The monitor rebuilds on audit/bridge changes; statuses, per-agent metrics, and data panels each call `getAgentLogs`, which synchronously reads and parses the entire daily audit log before filtering. The daily file was only 2.56 MB, but repeated whole-file processing across agents dominated the shared server thread. Durable recovery accounted for about 5.3% in this sample; it was not the dominant cause. Profile saved locally at `/tmp/metahuman-latency-20261016.cpuprofile`; the temporary diagnostic inspector was closed afterward.

Both llama.cpp processes were confirmed on GPU (approximately 7.7 GB for 9B and 4.0 GB for the specialist service); Kokoro also occupied GPU memory. This is application-side CPU work, not CPU-offloaded model inference. The failed wave's adapter discovery uses an explicit 2000 ms deadline in `providers/llama-cpp.ts`; the CPU profile explains the severe application stalls and makes delayed socket processing a plausible timeout mechanism, but does not retrospectively prove the exact response-arrival time of that failed lookup. Proposed repair is at the existing monitor/log owner: eliminate repeated full-log scans and synchronous rebuild work per agent/subscriber, preserve current displayed evidence, and measure request responsiveness under monitor updates. Do not merely extend the timeout or add throttles to mask the work. No production source was edited during this diagnosis.

### 2026-10-16 — Monitor log processing removed and activated

Owner authorized deletion of automatic Agent Monitor log/history processing. Removed audit-directory subscription, per-agent historical metrics, recent-completion projection, automatic overview log reads and Task Log UI. Live registry/process/Coordinator/bridge status, controls, lifecycle failure information and explicit manual CLI/API diagnostics remain at their existing owners. Existing audit retention now covers dated compressed archives as well as plain files. Deleted exactly five untracked, unopened November 2025 archives, freeing 5,777,025 bytes; no other log categories were deleted.

Validation: all 72 monitor validator checks and 11 stream tests passed; scripts and production Core typechecks passed; the full Core test-inclusive check retains three unrelated `never` errors in `llama-cpp.spec.ts:432–434`. Site build and compiled-runtime validation of all 44 workflows passed. Repeated source snapshots measured 13.7, 3.0, 3.4, 2.8 and 2.7 ms with zero audit reads. With explicit approval, cancelled only the saved Boredom Reflection execution below and restarted the application through the existing launcher. Live API and stream confirm the retired fields are absent, with 26 startable cards and 31 live data panels. Both llama.cpp PIDs and Kokoro PID remained unchanged; Body Control was not restarted.

HTTP overview timings remain workload-dependent: warmed calls initially measured about 260–276 ms, and 602–1,611 ms during subsequent Body Event work. These include the rest of request handling and server load; they are not snapshot-only timings. The removed audit scanning is verified, but no claim is made that all robot response latency is repaired. No additional test motion was dispatched during activation. Evidence is local under `/tmp/metahuman-monitor-removal/`.

### 2026-10-16 — Why the saved Boredom Reflection remained waiting

Preserved the original execution, events, task, graph snapshots, outbox and expanded checkpoint before authorized cancellation. Execution `ebd64afb-0f48-4b0b-9a54-f5d9bd7ba48e` began October 15 at 20:00:36 PDT. Its planner intention was to ask what useful embodied participation meant and offer company with an interested expression. The Task model received that unchanged current instruction and separately dated conversation history, but selected `robotCommand:stand` and the objective “What does a companion look like in this moment?”. This is an observed selection failure; the contribution of older conversation requires an isolated replay, not an assumption.

The stand received a terminal rejection: “Motion mapping failed or pulse exceeds PWM timer capacity”. Goal Review subsequently returned `wait`, revising the objective to the question/offer and requiring a correlated communication result. Review ran before Persona; the final question was then published and local TTS admitted, while the saved goal retained the earlier wait assessment. The last checkpoint selected `await-objective-input`; `execution_context` emitted `awaitContext:true` and `needsGoalReview:false`, and the existing event-wait node waited specifically for user/autonomy input. It did not consume later speech as goal completion. Review also described a thinking-display receipt as the requested interested expression, which the recorded command does not establish.

All 17 outbox effects were completed. Before cancellation there were no active queued work items, no live execution writer, and no unfinished motor command for this workflow. Queue displays durable unfinished executions alongside executable jobs; this retained goal was visible there but was not reserving a Coordinator lane or blocking new movement. Subsequent live work after activation was a newly admitted Body Event Trigger execution, not recovery of this cancelled reflection.

Remaining defects: Task selected an unrelated action; Goal Review reintroduced reply delivery into a goal despite the intended separation of replies and goals. Current Task prompt text also still advertises `response` as a completion-basis value, although the Goal Review schema excludes it. This stale contract description is concrete, but does not alone prove the cause of this output, which used `action_result`. The next repair should reconcile the existing reply/goal contract and evaluate this exact saved input and review evidence, while keeping persistent genuine goals separate from active resource ownership. Do not add automatic expiry, forced success, repeated review calls or a global queue barrier. This investigation changed no workflow prompts, model assignments or goal lifecycle code.

### 2026-10-16 — Repair the producer of the reflection's stale goal wait

Further tracing found the earlier lifecycle defect: the recorded Task output explicitly selected `requiredCompletionBasis:action_result` and `continuationPolicy:none`, but Active Task unconditionally rewrote any program failure to `outcome:continue`. Successful one-off programs already settled at this owner; failed ones instead acquired an extra review and could become persistent goals. Five receipt-failure regression cases reproduced this before the repair.

Active Task now settles a terminally failed one-off receipt objective as `failed`, with `objectiveComplete:false` and the original failure/uncertainty retained. It uses the same existing receipt-objective definition as success settlement. Bounded and observation-based goals retain their existing interpretation/review path. No new timeout, retry, queue, automatic cancellation, forced success or physical command was added. Robot Status and durable task selection no longer present such a failed objective as active while Persona finishes its response. Intent's actual routing decision now reaches Goal Review through the existing Current Execution node and child context. The previously approved removal of `response` as a Task completion basis is reconciled in both human/autonomy prompt descriptions and public graph artifacts, with a contract consistency test.

The additionally approved wording was tested, not deployed: three paired actual-model Task replays reproduced the incorrect stand selection on the recorded input; the candidate wording changed it to a request for user input with no program, without establishing the intended behavior. Three paired Goal Review replays through the configured Big Brother Psychotherapist retained the erroneous speech-delivery criteria in both variants. This is not a qualified semantic repair. The lifecycle correction instead prevents the recorded rejected one-off selection from entering Goal Review at all. Wrong action selection and semantic review quality remain open; no model role or adapter was changed.

Software acceptance uses the real saved Environment graph, SQLite execution owner and Coordinator with simulated providers/actions. The recorded erroneous stand decision plus rejection now ends its task as failed, skips Goal Review, delivers one reply and leaves no input wait; re-entry produces no repeated reply or action. Another test preserves a genuine waiting goal while admitting fresh conversation and a finite motion on the same body. Current Intent routes reach the review without claiming that selected speech was delivered. Terminal failures, successful receipts, bounded goal retention and failed-goal status projection are covered.

Validation: focused integration/store/status/context/contract suite 92/95 passed; its three failures reproduce on an isolated baseline (two old Full Auto fixtures still emit the retired controller contract, and a role assertion expects Persona instead of Psychotherapist). Active Task state suite 93/99 passed; the same six failures reproduce before this repair (two older review-eligibility assertions and four person-reacquisition cases). All newly added/changed acceptance cases pass. Production Core typecheck, node defaults, Site build and compiled validation of all 44 workflows passed. Full Core retains its three pre-existing `llama-cpp.spec.ts:432–434` errors. These failures remain recorded rather than weakening their assertions.

Activated through the existing application launcher at 11:54 PDT with no unfinished workflow or queued work to cancel. Authenticated Queue API afterward reports zero work items and zero unfinished workflows. Both llama.cpp PIDs and Kokoro PID are unchanged; Body Control lifecycle was untouched. This is activated software and simulated-action evidence, not physical robot qualification. Local evidence: `/tmp/metahuman-goal-reply-repair/`.

### 2026-10-16 — Delete task-level continue after owner direction

Owner clarified that Goal Review updates Robot Status and must not further the objective, then requested deletion of the remaining problematic mechanism. Current review already had no continue outcome or action/workflow/speech output. The remaining producers were Task's shared outcome enum, both Task graph prompts, and Active Task's automatic replacement of a finished/failed program decision with `continue`. Deleted those remnants and removed stale catalog claims that review could continue, speak or select activities. Goal Review retains assessment/status persistence; new work selection remains with independently admitted Active Operator or human input. Internal advancement through an already selected program and explicitly requested input handoffs remain intact.

Current training corpus regenerated as version 19 from the same owner: 6,766 development, 1,590 evaluation and 187 regression records. Checked every record identity and hash excluding prompt/schema: requests, reference outputs, provenance and folds are unchanged. Removed the retired option and previously retired response completion basis from generated contracts. No adapter retraining, role change, frozen-run rewrite or physical action.

Validation: 93/96 tests passed across Task parser/context, Goal Review contract/graph, durable continuation and selected active-task receipt cases. The three failures reproduce pre-existing issues: the V2 catalog-rule assertion and two Full Auto fixtures using the old activation output contract. Production Core typecheck, node defaults, 44 graph validations, Site build and compiled runtime check passed. Program completion/rejection preserves the selected goal decision without creating continue; re-entry does not dispatch another action. Goal Review graph tests in Semi and Full update status only. Full Auto live goal pursuit is not qualified by these tests.

Activated the tested Site build at 12:12 PDT through the existing app-only launcher restart. Queue was empty before activation and remained empty afterward; no workflow cancellation was necessary. Node schemas returned HTTP 200. Model/voice services were left running; Body Control was not restarted. Evidence: `/tmp/metahuman-remove-continue/`. Robot Bible and maintained ownership description updated.

### 2026-10-19 — Active Operator repeatedly assesses without dispatching

Read-only live diagnosis at 17:55–17:57 PDT: Active Operator is in Semi mode. Completed assessment executions started at 17:55:10, :25, :42, :57 and 17:56:12, :27, each taking about 12.6–14.1 seconds. The latest four inspected checkpoints contain empty `selected` and dispatch `requests` arrays. Returned updates include Movement 86, Observer 76, Movement 68; none reaches Semi's owner-selected 100 threshold. Repeated assessment alone does not increment activation: the model supplies absolute values and keeps repeating the same embodied-participation intention.

Admission cause: `brain/agents/active-operator/index.ts` watches every change in the queue-state directory and calls `assess()`. Once its own assessment leaves active work, the admission test succeeds and submits another assessment. Queue bookkeeping therefore supplies a self-trigger, including when no operation was selected. This is distinct from a stuck physical command or Goal Review continuation. Repair should replace the indiscriminate queue-directory admission trigger with defined assessment-relevant events; idle reassessment semantics need to honor the owner's latest direction against repeated calls while preserving the separately requested activity/threshold design. No runtime/source change, cancellation, mode change or physical command was made during this diagnosis.

### 2026-10-19 — Semi Auto inactivity admission repaired

Owner specified that Semi assesses after inactivity, with a configurable five-minute default. Implemented `semiInactivityMinutes` in the existing Active Operator configuration owner/API and settings component. Interval-only saves preserve the current mode. The existing persistent Active Operator now schedules one deadline from recorded system activity, entry into Semi, or completion of its prior assessment. Queue changes reconcile the deadline rather than admitting assessments immediately; recorded activity reschedules it. Reactive/disabled/Sleep/shutdown clear the timer. Full retains its previous independent assessment behavior. No model instruction, selection threshold, forced action or second scheduler/service was added.

Seven focused tests passed, including simulated five-minute expiry, recorded-activity reset, repeated queue notifications, assessment completion, live interval editing, Reactive cancellation, existing Full admission, config persistence and mode preservation. Brain and production Core typechecks, Site build and compiled runtime verification passed. Registered the configuration test in the existing durable-execution test command; updated Robot Bible and Maintained Surface.

MetaHuman and Active Operator had stopped before activation was attempted; the existing control API was unreachable and no restart occurred. Read-only checks found no unfinished executions or active queued/leased/waiting work. Installed the validated build at `apps/site/dist` for the next normal startup and left all services stopped as found. No physical commands, model-role changes or live workflow cancellations. Live UI and real-time five-minute operation remain unverified. Evidence: `/tmp/metahuman-semi-inactivity/`.

### 2026-10-20 — Startup recovery rejected already-settled speech cancellations

Startup reported three non-dispatch confirmation conflicts for old, never-started speech jobs whose parent executions had failed. Each already had the exact correlated `physical_result` cancellation with `delivery.outcome: not_sent`, and its dispatch bookkeeping was completed. The confirmation owner recognized only a separate `dispatch_cancelled` marker, then rejected the completed dispatch before receipt replay reached its existing identity check. No new physical command caused these three errors.

Repaired `ExecutionStore.confirmUndispatched` to recognize the existing correlated not-sent cancellation as confirmation. The later receipt replay still validates the complete event identity. Removed the redundant second cancellation-marker lookup inside the same transaction. Recovery, cancellation evidence, and unresolved-work reconciliation remain at their existing owners; no retry, downstream error suppression, queue, model instruction or physical behavior was added.

Baseline: the result-only regression reproduced the live exception; separate-marker and unsettled formats already passed. All 64 store/recovery tests now pass, including restart/repeated delivery, unchanged settled records, and rejection of mismatched evidence. Replayed the three actual incident receipts three times against isolated copies of their execution records: zero admissions and byte-identical database state. Production Core typecheck, Site build and compiled runtime validation of all 45 workflows passed. Activated through the application-only launcher restart at 16:57 PDT after confirming the live queue had no work or unfinished executions. The authenticated Queue API afterward reports running, not degraded, and empty; node schemas return HTTP 200. The startup recovery exception has not recurred in the checked runtime log. Model and Body Control services were not restarted; no physical command or workflow cancellation was needed. Local evidence: `/tmp/metahuman-cancelled-speech-recovery/`.

### 2026-10-20 — Remove whole-message size rejection from Environment transport

Owner explicitly requested deletion of the hardcoded message-size rejection after the physical gateway entered a reconnect loop. The first oversized saved observation was 426,015 bytes against a 393,216-byte sender ceiling: roughly 289 KB camera data plus 114 KB depth-preview data nested in position state. `_restore_connection` replay reached `_send`, threw, and closed the connection; dashboard behavior-settings errors were a consequence. This is separate from the already-settled speech cancellation repair above.

Deleted the gateway JSON byte-ceiling constant, outbound rejection and inbound byte-length rejection. Deleted MetaHuman Bridge's generic message-size constant/check and its reuse of the audio-frame ceiling; configured its existing WebSocket receiver with `maxPayload:0` (the library's no-limit setting). JSON object validation and delivery identities/acknowledgements remain. Removed the obsolete ceiling comment and unreferenced compiled bridge chunk. No data trimming, backlog deletion, new retry, fallback, prompt change or physical action was introduced by this repair. The dashboard depth preview remains in the saved and newly produced position payload; separating dashboard media from numerical position state remains a distinct data-assembly follow-up, not silently applied here.

The new real-WebSocket reconnect test reproduced the original disconnect before removal, then preserved a 714 KB synthetic observation across unacknowledged reconnect and acknowledgement. All 26 focused gateway/receipt tests and all 10 Bridge lifecycle tests passed; the latter include a >600 KB image delivered unchanged to Core while independent acknowledgements proceed. Brain typecheck, Site build and compiled verification of all 45 workflows passed. Read-only copies of all 115 observations pending at replay time passed the repaired sender twice with identical contents and no physical dispatch.

Activated the gateway with its existing stop/start launcher and original process environment, and restarted Local Bridge through Agent Monitor's control API. Gateway launcher output is in its existing `build/gateway/physical/launcher.log`. The bridge worker uses compiled artifacts: installed the tested bridge chunk and three local/remote/shared entrypoints only after verifying every imported compiled dependency was byte-identical to the running application. Removed the superseded chunk after confirming it had no remaining imports. Site and model services were not restarted; live workflow cancellation was unnecessary. The formerly blocked observation was acknowledged and the gateway delivery table drained to zero; the Bridge is connected. Delivered observations entered MetaHuman's existing processing queue, so an empty gateway backlog does not imply all model processing is finished. Evidence: `/tmp/ainekio-bridge-size-removal/`.

### 2026-10-20 — Admit new input only while its recipient is connected

After transport recovery, 87 Body Event jobs represented old boot/wake and servo-feedback events accumulated while MetaHuman was disconnected. The producer was Body Control's `_send_observation`: it persisted unsolicited input before attempting a send, even without an authenticated bridge socket. The owner clarified that already-admitted work must survive disconnection and resume; only new input produced without a recipient must be absent from the delivery queue. This supersedes the initial broader suggestion of discarding reconnect replay.

Repaired admission in the existing Environment Adapter: new unsolicited events, transcripts and snapshots require an open authenticated socket before persistence. The same socket is retained for the send attempt. A disconnect after admission preserves the saved input for reconnect; correlated results of already-accepted actions retain their existing receipt lifecycle even offline. No new queue, health monitor, timer, replay filter, data purge or instruction change was introduced. Body Control already owns the authenticated WebSocket and bridge-ready state; these describe transport availability, not model/workflow health. MetaHuman's existing Bridge Out already refuses new body-command admission when no adapter is subscribed; no second outbound mechanism was added.

Acceptance: the new offline-input regression failed before repair. All 27 focused gateway/receipt tests passed afterward, covering offline boot/text/image inputs, admission followed by disconnect, preserved identities on reconnect and acknowledgement. Broader adapter/receipt/speech suites ran 90 cases: 89 passed under system Python; the sole dependency error required cv2, and that remaining case passed under the running gateway's Python with the test-fixture path supplied. An isolated invocation of the actual MetaHuman Bridge Out owner confirmed no connected adapter produces zero admitted commands and no new queue records. No physical test actions were dispatched. Task diff checks passed.

Activated through Body Control's existing stop/start launcher with its original process environment at 17:30 PDT. MetaHuman and model services were left running. The replacement gateway reconnected to the Local Bridge; pending gateway deliveries and active Coordinator work were both zero afterward. The earlier incident work had already been cancelled by the owner through the UI; this repair cancelled or deleted no existing work. Reconnect preservation is established by simulated and real-WebSocket tests, not by dispatching live robot motion. Evidence: `/tmp/ainekio-live-observations/`.

### 2026-10-22 — Temporary Big Brother routing for live robot tests

Owner requested Big Brother for testing while releasing local LLM GPU memory. Used the same authenticated Model Registry API as the sidebar Status widget to assign all eleven language-model categories in both defaults and Environment Mode to `big-brother.configured`; Embedder remains on its existing provider. Readback resolves every Environment language role to Codex GPT-6 Sol. Backend Settings retains reasoning `none`; no prompt or graph contract changed. Previous effective assignments are retained locally in `logs/run/model-switch-before-20261022.json` for restoration.

Stopped the production llama.cpp services through `bin/llama-cpp-services stop`. The 9B service had already failed startup with a CUDA allocation error; the active 2B specialist service released roughly 3.4 GiB. A real Persona call through Core Model Router returned `OK` from Big Brother/GPT-6 Sol in 22.962 seconds; this verifies inference routing, not full workflow latency or physical actions. No robot command was dispatched by this check. The widget's role selection does not itself stop local services; the explicit lifecycle stop was separate. Startup configuration was not changed, so application startup can start its configured local services again.

GPU memory remained approximately 5.7 GiB in use by the desktop, Blender, Body Control depth processing, its separate experimental Freestyle model and Kokoro. These remaining applications were not stopped or moved to CPU. This is release of MetaHuman local language-model allocation, not an empty GPU. Existing oversized text context and the physical servo-progress rejection remain unresolved by this provider switch.

### 2026-10-22 — Live latency tests and three approved owner repairs

Owner approved repairing telemetry subscription lookup, separating depth-preview pixels from textual measurements, and independent Big Brother model invocations. The recorded `Please wave` Task request contained a Base64 PNG under `state.locomotionMeasurement.position.depthPreview`; this was dashboard media copied into text, not a vision attachment. Replaying its complete saved context through the repaired projector reduced serialization from 115,284 to 29,072 characters (86,212 removed). Body Control still creates and displays its 320-pixel-wide colour depth preview. Numerical estimates, provenance, timestamps and uncertainty remain; existing camera-image access is unchanged. The adapter producer now separates that preview from bridge measurements, and Core's existing context projector handles older stored observations without rewriting their evidence. No model instruction or token cap changed.

The live server's 12-second CPU profile attributed 21.4% of sampled time to sensor-wait notification, which loaded all 7,307 execution records even without sensor subscribers. ExecutionStore now queries its existing wait records by profile and exact sensor reason using an index; only matching waiting records enter decoding. Existing event identities and acknowledgements remain. The post-activation profile attributes 0.9% to that path. These are workload snapshots, not a controlled overall-speed benchmark.

A greeting also failed because a concurrent call occupied the terminal provider's global single-flight reservation. Ordinary Big Brother calls now retain independent sessions, process receipts, results and cancellation. Completed or failed ordinary sessions are retired by subsequent calls; active siblings and diagnostic sessions remain intact. Explicit Big Brother stop closes all ordinary sessions. Diagnostic thread turns retain their existing sequencing independently. Two actual concurrent Persona calls through Core and the restarted terminal owner both returned `OK` from GPT-6 Sol in 4.99 and 5.11 seconds, with total elapsed 5.12 seconds.

Validation: new subscription and context tests reproduced the defects before repair; gateway preview test also failed before repair. The initial focused suite passed 92/94: one unrelated V1/V2 contract-wording assertion also fails against the original helper, and one terminal fixture counted calls from a new preceding test. The fixture now isolates its own call records; the final terminal service suite passes 14/14. Three focused gateway measurement tests pass, including source preview preservation and stale-body evidence. Core typecheck, Site build and compiled validation of all 45 workflows pass. Task diffs and retired single-flight reference checks pass. No physical motion or firmware change was made.

Activated with application-only restart and the existing terminal and Body Control lifecycle owners at approximately 16:37 PDT. Body Control exceeded its launcher's five-second shutdown check, then exited normally; it was restarted with its configured launcher. No workflow cancellation or forced process termination was used. Fresh connected bridge observations contain no depthPreview. Production llama.cpp remains stopped; the separate Freestyle training process remains running. Debug profiling listener was closed after collection.

Live comparison with unchanged requests: `Show the happy face on your display.` received its completed display receipt in 15.96 seconds versus 22.04 before. `Tell me one short fact about cats.` returned Persona results in 15.65 and 20.98 seconds versus 20.27 before. The first retest's speech was interrupted by the next test input, so it is not counted as completed playback. The uninterrupted repeat received Body Control computer `speech_played` at 32.13 seconds versus the earlier first chunk at 35.39 seconds (earlier final chunk 39.20 seconds). These receipts mark playback completion, not first audible sound, and playback target was Computer. All test executions finished. Model timing and background GPU training vary; this does not establish a stable end-to-end speedup.

Remaining targets: the new CPU profile still attributes substantial time to durable recovery (36%) and queue dispatch (30.6%, overlapping call stacks), including further historical enumeration/profile decoding. Trace those existing owners before another latency repair. A successful display-only request still emits `Graph executed but produced no response` twice in the chat stream after Intent chooses no reply; this misleading presentation is separate from the confirmed display action. The earlier physical servo-progress rejection remains unqualified. Evidence and exact timing records: `/tmp/metahuman-latency-20261022/`.

### October 22 — approved on-demand depth lifecycle

Root cause: the camera callback submitted every received frame for metric processing regardless of whether a workflow needed it; selecting MoGe retained its worker. Before activation that worker held 1,476 MiB of GPU memory. The Installation Owner approved `operation:"depthDemand"`, `consumerId`, and `enabled` on the existing camera-read bridge. No model-visible wording changed.

CameraFramePlugin now owns shared consumers and unloads MoGe after the last release. Core Active Task acquires measurements for distance and metric approach/follow goals, then releases on settlement; terminal execution cleanup also releases after cancellation/failure. Bridge registrations retain execution and request identity across reconnection. A pending read relinquishes its Coordinator transport lease for redelivery, without treating disconnect as a failed handler attempt or inventing another acquisition. Completed acquisitions are re-established for ongoing executions on a new connection. Ordinary camera reads remain independent of depth loading. Body Control drops the closed connection's consumers, shares depth with active gait recording, and offers an explicit one-sample dashboard operation. Streaming/photos do not implicitly request depth. The standalone trial recorder remains a passive consumer of available status, not an implicit activation source.

Focused validation: 68 Python camera/bridge/gait tests, 18 navigation tests, 8 bridge/durable-read tests, four dashboard tests, the Coordinator contract script and two cancellation tests pass. An initial cancellation-test invocation lacked Node's required module-mocking flag; the corrected invocation passes. Core typecheck, Site build and compiled validation of 45 workflows pass. Broader Active Task coverage retains eight failures also reproduced against the original implementation (review/continuation, identity/reacquisition, and cancellation/resume assertions); those are not claimed repaired. Tests exercise disconnected first measurement, shared release, new measurement after release, camera reads concurrent with loading, pending-read reconnect identity, and execution cancellation. No physical motion was dispatched.

Activated MetaHuman with its app-only restart and Body Control with its existing stop/start scripts at approximately 17:15 PDT; no work needed cancellation. Separate Freestyle model training remains running. Immediately after restart the bridge was receiving fresh gateway observations but the physical body had not yet reconnected; the depth worker was absent from GPU allocations. Gait logging and learning are enabled in this installation and are preserved: when recording receives camera frames it is a legitimate depth consumer, so this does not establish idle VRAM release with recording enabled. An explicit question about retaining those settings is pending. First navigation use pays model-loading time; reactivation resets the local MoGe odometry reference. Live physical navigation and end-to-end latency improvement remain unqualified. Evidence: `/tmp/depth-demand-*.log`.

### October 22 — Big Brother live timing round and startup attribution

Owner requested varied response-time checks through Big Brother while GPU training runs. Eight natural-language requests entered the normal Environment chat/Coordinator path between 18:23 and 18:30 PDT. Every recorded language call in that window (26, including body-event reactions) used `big-brother` / `gpt-6-sol`; the configured reasoning effort was `none`. Median model-call duration was 4.97 seconds, range 3.74–7.45 seconds. No local language model was started or reassigned. Voice and perception retain their existing service owners. Times below start at HTTP submission, exclude wake-word/STT time, and distinguish model answer availability from audible output. Later requests overlapped parts of the mixed-task conversation/speech pipeline, so these are live workload samples, not an isolated serial benchmark.

| Request | Body Control accepted | Action result | Persona answer ready |
| --- | ---: | --- | ---: |
| One short cat fact | — | Speech finished at 24.77 s | 16.26 s |
| Happy display expression | 13.12 s | Completed 13.37 s | No reply selected |
| Wave | 14.54 s | Servo-progress rejection 19.92 s | No reply in originating execution |
| Latest camera image description | — | Cached image read; speech finished 33.23 s | 16.90 s |
| Nod | Not dispatched | Model requested user input after the prior output fault | No reply selected |
| Bow, then a short cat fact | 16.40 s | Bow completed 25.93 s; sendText received 27.67 s | 52.83 s |
| 17 + 26 | — | Correct answer 43; later request interrupted playback | 26.81 s |
| Stand and briefly report | 18.04 s | Stand completed 19.24 s; speech finished 60.53 s | 40.48 s |

The owner confirmed servo rejection is expected during these timing tests; it is not grounds to terminate timing work. The initial batch script was interrupted after the wave rejection, then individual requests continued under that clarification. The explicit later pause stopped new admissions; the already-submitted stand finished. On resumption the physical body was disconnected and no active Queue work remained. Wave, nod and bow retained unresolved durable objectives (`user_or_autonomy`); those are saved goals, not still-running motor commands. No cancellation, production code change, prompt edit, or firmware change was made in this diagnostic round.

Confirmed follow-up targets:

- The happy face completed successfully but its chat stream emitted “Graph executed but produced no response” twice. This repeats the previously recorded presentation defect.
- Nod selected `request_user` with no action after reading the previous fault, but Intent had selected no response. The model's request for user input never became an outward reply. Do not mislabel this as a slow or dispatched nod.
- Bow-plus-fact selected `sendText`, then Goal Review waited for spoken-delivery evidence. It recreated a response-as-goal completion condition that the owner previously removed. Persona's later reply described that missing speech confirmation; a newer request also made the older speech generation obsolete. The text-received receipt is not a playback receipt, and this is not evidence of a Kokoro failure.
- The stand request made four sequential language calls (Intent, Task, Goal Review, Persona), totaling 19.58 seconds. The answer was ready at 40.48 seconds: another 20.90 seconds elapsed in admission, graph/data handoffs and physical execution. Of that, command acceptance to completion took 1.20 seconds. Trace those owners before attributing all delay to inference. The saved chat progress records show significant time before Intent and between returned evidence, review and Persona. Arithmetic overlapped the bow continuation, so its 26.81 seconds is not an isolated small-prompt baseline.
- Startup attribution is concretely inconsistent. In the recorded boot execution, Body Event generated an instruction adding “Report the results accurately without claiming a posture the available evidence does not verify.” `environmentEventRequestNode` returned that body-event intention with `autonomy:false`; the conversation context therefore used the human-request system prompt even though its envelope said `inputSource:autonomy`. Intent selected no persona source, leaving `activePersona:null`. The human conversation prompt further emphasizes discrepancies and unmeasured physical conditions. These inputs favor the procedural startup report the owner objected to; they do not establish that the model lacks the concept of being a robot. The Body Event prompt also still asks that model to choose exact spoken words despite Persona owning outward speech.

Owner intent clarified: the boot stretch and picture are an expressive startup routine, not a human-issued work order requiring a narrated completion report. Preserve accurate evidence without turning ordinary startup expression into a checklist. Next work should correct body-event authorship at its existing input owner, evaluate persona-context selection, and review the model-visible reporting/delegation wording with the owner's exact-text approval. Do not add scripted greetings, compulsory emotions, or claims of physically verified posture. Saved evidence and timing summaries: `/tmp/metahuman-latency-20261022/round2-*.json`, `round2-*.jsonl`, and `round2-model-calls.json`.

#### Timing attribution follow-up

The five requests producing Persona answers took respectively: cat 16.26 s (10.09 s model calls, 6.17 s other), vision 16.90 s (8.96/7.94), arithmetic 26.81 s (11.21/15.60), bow-plus-fact 52.83 s (23.88/28.95), and stand 40.48 s (19.58/20.90). “Model calls” includes the Big Brother CLI/provider round trip, not separately measured server inference. “Other” includes actual movement where applicable. Answer availability precedes conversation publication and audio delivery; these are not first-audible-sound timings.

Stand's critical path, seconds: admission/input/pre-Intent work 6.82; Intent 4.00; Task context/handoff 0.94; Task 4.97; command delivery 1.30; reported movement 1.20; receipt/resume/review preparation 6.42; Goal Review 5.90; review-result/Persona handoff 4.12; Persona 4.70; result recording 0.10. Speech was accepted another 3.84 s after answer availability. Saved checkpoint node entries establish that the final conversation-context node itself took 137 ms, review context 87 ms, review robot status 61 ms, and review conversation/inner/robot history readers 3/1/7 ms. Significant gaps exist outside those handlers; do not label the entire handoff interval context computation or inference.

Current source diagnosis: `recoverDurableExecutions` fully enumerates executions three times per maintenance pass, calls settlement and terminal reconciliation for every record, and calls dispatch readiness after each record. The database contained 7,428 executions at inspection. `relayExecutionOutbox` also reads all pending dispatches before filtering by execution. `ExecutionEngine.runLoop` runs recovery on each pass; dispatch repeatedly scans queue candidates and resource availability. The earlier post-repair 12.46-second CPU sample corroborates substantial work here (resource availability alone 16.4% self time; recovery and dispatch inclusive totals overlap). That sample predates the latest timing round and cannot assign exact seconds of an individual request to these functions.

Repair priorities: select records requiring recovery/retirement and per-execution pending effects at the existing SQL owner before decoding; remove repeated global selection from per-record recovery while preserving prompt admission and receipt ownership; measure handoff/checkpoint work after that repair; fix the observed response-as-goal contract regression separately; then split speech synthesis and transport latency. Preserve requested context and model-selected ordering. No production code or prompt changed in this follow-up; no performance improvement is claimed yet.

### October 22 — selective execution recovery repair

Owner authorized deleting the unnecessary processing identified above. The actual recovery path performed four full-history enumerations, including the one inside Checkpointer retention. These have been removed. Execution Store now selects running/interrupted work, effect-delivery waits, pending messages, unresolved terminal cancellation and unfinished Coordinator references before decoding records. Settled cancellations with recorded outcomes are excluded. Dormant goals stay stored and are not recovery work. Existing indexed SQLite storage owns the selection; no second registry, scheduler, delay, input cap or fallback was introduced.

Outbox relay now selects only the requested execution's pending messages instead of decoding every execution's pending messages and filtering afterward. Retention selects expired terminal identities directly and uses its existing retirement records for receipt/buffer cleanup, removing the before/after history comparison. Existing history readers remain for actual history consumers and explicit profile reset. Application-restart recovery policy, reconnect behavior, receipt identity and model-visible instructions are unchanged.

The new selective-recovery regression failed before the repair. Final owner/authentication/receipt tests pass 92/92, including completed history exclusion, dormant-goal preservation, cancellation already acknowledged without a separate non-dispatch marker, retirement, concurrent execution identity and repeated delivery. Queue admission/cancellation/Coordinator integration checks pass 22/22. The broader saved-workflow suite fails 34/34; an isolated copy with the original four owners reproduces the same 34 failures, including stale Intent contract fixtures and retired workflow expectations. Those baseline failures were not weakened or repaired here. Core typecheck and Site build pass; the compiled runtime confirms source parity and validates all 45 workflows. The runtime verifier must be invoked from the built `check-runtime.mjs`; directly invoking its build-input TypeScript script failed on top-level-await module format before the corrected invocation passed.

Read-only evaluation against the latest database selected zero recovery candidates from 7,453 executions; three goals remained dormant and the live Queue contained no work. This proves selection, not measured live latency improvement. Build activation is pending the owner's response about cancelling the three unfinished latency-test workflows (wave, nod, bow-plus-cat-fact) whose saved executable identity differs from the new build, and restarting only MetaHuman. Model services, training and Body Control have not been restarted; no robot action or workflow cancellation was dispatched by this repair. Evidence: `/tmp/recovery-selective-*.log`, `/tmp/recovery-workflows-original.log`.

### October 23 — slow boot and unsolicited completion report

Read-only inspection matched the owner's quoted report to boot execution `16d4e1a7-6773-4ae4-99d9-573e70235c48`, admitted at 08:52:41 PDT. The serving Site process still started October 22 at 17:14:56; the selective-recovery build has not been activated. Timings from execution admission (not physical power-on): greeting sendText acknowledged 28.21 s; fresh capture completed 34.81 s; stretch accepted 37.70 s/completed 41.32 s; stand completed 44.62 s; Persona answer ready 74.51 s/published by its response node 75.50 s; first speech accepted 98.01 s; final speech completion 131.96 s. Five Big Brother/GPT-6 Sol calls took 38.339 s total: Body Event 7.758, Intent 6.178, Vision planning 7.763, Goal Review 10.191, Persona 6.449. These include provider/CLI round trips. TTS reported first audio available at 80.37 s (a cached first chunk, 75 ms after synthesis-stream startup); the later acceptance gap is not established to be synthesis time and needs delivery-path tracing.

The initial Body Event model explicitly generated: “Report what the picture and command results establish, including any uncertainty about physical posture or audible speech.” This sentence was not a literal fixed boot prompt: it was model output promoted into the downstream request. Its input included 30 conversation records, including four prior procedural boot reports about posture and/or audibility. Repetition in context is verified; its causal contribution requires a controlled replay. The saved boot prompt still explicitly directs the event model to choose exact spoken wording and include it verbatim. The next planner chose sendText, whose text_received receipt is not speech playback. Goal Review then made a report part of the objective and returned wait because that report had not yet been supplied.

The saved Event Request output again has autonomy:false, although plannerDecision.source is body-event-trigger. Intent sees “Current user message”; Conversation receives the human-request system prompt despite selectedContext.inputSource being autonomy. Intent selects no persona context; activePersona is null. Conversation instructions explicitly request discrepancy reporting and distinguish command completion from unmeasured posture. Together these establish the unwanted report's immediate instruction chain. They do not justify claiming measured posture or fabricating audible speech. No prompts, source, live workflows, or physical actions changed during this inspection. Repair should address generated request attribution and the stale speech-authoring contract, then qualify proposed instruction changes with exact-text approval; merely suppressing the resulting status text would leave its originating request and goal wrong.

### October 23 — reusable Robot Wake-Up graph and readable editor

The owner requested applying the node-design rules to the cluttered wake workflow. Removed both newly introduced wake-specific node implementations and registrations. Robot Wake-Up now contains nine instances of existing nodes: Wake-Up Event; Stretch + Take Photo; Receive Action Results; Read Captured Photo; Read Personality; Prepare Greeting; Stand; Generate Greeting; Say Greeting. Typed wake events route directly to this graph. Non-wake interpretation remains in the existing graph, now named Other Body Events; the retired Robot Startup graph is absent.

The existing action output accepts editable configured actions when no action input is connected; an explicitly empty connected selection remains empty. Existing result input preserves correlated captured frames and accepts completed non-camera commands without demanding another observation. Existing context and conversation owners carry the original autonomous event, active persona, recorded results, image and response provenance. One Persona call owns the greeting; no Intent, Task planning, goal creation or Goal Review runs for wake-up. The previously approved startup prompt is unchanged. Stand dispatch follows the initial results; greeting does not wait for a Stand completion receipt.

Consolidated three color tables into the existing browser-safe node presentation owner. Inputs are blue, outputs green, LLM calls red, and context cyan. Instance labels and comments explain each role. Collapsed cards expose connected/essential ports, with all ports/settings available on expansion; configured prompts and action objects are readable. Control connections now have visible input handles. The graph uses left-to-right stages and separate persona/stand rows, with space checked against actual expanded cards in the real Svelte editor under an isolated preview. No production service or physical robot was started for these checks.

Focused simulated wake/result/input/routing checks passed 18/18; editor property/conversion/grouping checks passed 14/14, and shared conversation delivery/graph authoring checks passed 10/10. Wake tests cover successful and failed capture, one Persona call, one delivery, replay without duplication, no goal, and empty connected actions. Core typecheck passed. The broader context-builder suite retains one failure also reproduced using its original HEAD implementation (V2 capability-rule assertion); it was not changed to hide that failure. Full Site Svelte checking reports existing errors, including the unchanged prompt-source schema typing; this is not a clean full-workspace baseline. Final Site build passed; the compiled runtime matches Core source and validates all 46 workflows. Svelte checking retains 156 errors and 321 warnings across 66 files; the edited BaseNode has only its pre-existing prompt-source schema error. The isolated visual review confirmed all 13 edges, including both control edges, are rendered. Activation and physical timing remain unverified; no runtime restart or live cancellation was performed.

### October 23 — Body Control owns startup; obsolete graph coordination removed

This supersedes the nine-node startup design above. The owner identified the unnecessary OS round trip and physical-result join. The current stretch execution contract already includes return_to_standing and hold_standing, so a separate Stand command duplicated the motion. Body Control now handles typed wake events through its existing Environment adapter: reuse the correlated snapshot command and camera owner, dispatch existing emote/stretch, and forward one wake observation containing the image, original event identity/reason/clock, capture result, stretch dispatch evidence and recorded body status. It does not await the stretch terminal receipt. The procedure runs outside the robot receive callback, preserving other incoming events. Existing protocol is unchanged; this host repair requires no firmware flash. Dispatch evidence does not claim physical completion. Offline-new-input policy remains: an absent/replaced Bridge does not acquire the old unadmitted greeting, while already admitted observations retain acknowledgement replay.

Robot Wake-Up now has six existing node instances, named Environment Bridge Input, Camera Image Input, Persona Loader, Conversation Context, Persona Model and Conversation Output. Image Input formats the supplied JPEG; it sends no capture or latest-image request. Explicit body status reaches context with its recorded status timestamp. The graph sends no robot action and creates no goal. Persona remains the sole reply author, with shared buffer, memory (when enabled), conversation feed and configured TTS delivery; autonomous source and robot-wake-up metadata are preserved.

Deleted the Stretch + Take Photo, Receive Action Results and Stand instances and their edges. Removed the startup-only configured-action extension and the startup-only result-wait frame/receipt outputs plus their dedicated tests; the reusable originals remain because Boredom Observer still calls them. The two custom startup node types and retired Robot Startup graph remain absent. The shared Context Builder retains only the factual inputs used by the remaining graph. No new node type, provider call, timer or retry owner was introduced.

Validation: nine Body Control startup tests pass, including the real GatewayConnection boot/camera protocol with the stretch receipt deliberately left pending, failure evidence, independent event handling and reconnect behavior. Thirteen focused Core/routing/output tests and Core typecheck pass. The selected startup/body-event/adapter owner suite also passes 77/77. The broader Python run passed 86 of 87 before adding the final gateway integration test, with one import error because this interpreter lacks cv2; the shared context suite passes 19 of 20 with the same previously reproduced capability-rule baseline failure. Final Site build passes and compiled runtime matches source with 46 graphs validated. The actual editor was inspected in an isolated preview with the six-node layout. No live robot action, firmware flash, model service change or production restart has occurred; measured physical latency remains unverified.

The owner explicitly approved deleting the obsolete boot/stretch/stand clause from Other Body Events. That exact clause is removed; the other instructions and the approved Persona startup prompt are unchanged. Typed wakes route exclusively to Robot Wake-Up.

The camera regression reproduced a received capture waiting on the outbound camera worker. Correlated image futures now resolve at the existing complete-frame receive owner. Removed the two-second action-visual wait, received-frame bookkeeping set and obsolete resolution helper. The new regression passes with no outbound camera worker running. The late-image test now exercises the frame-receive entrypoint, retaining its no-unsolicited-observation assertion. The selected 77-test Python suite passes after this change.

### October 23 — Explicit wake-up status and delivery nodes

The owner clarified that the workflow must visibly contain Robot Status, Conversation Buffer, Memory Capture, conversation output and TTS. The bundled Conversation Output call concealed those responsibilities in a child graph. Replaced that instance with existing Conversation Work Result, Conversation Buffer, Memory Capture, Stream Writer and TTS nodes, and added the existing Robot Status source to context. The graph now has eleven existing node instances; no new node type or model instructions were added. Conversation Work Result accepts the existing identified model work as an optional input so it can expose the response and its metadata without invoking a delivery subworkflow. Its original child-workflow input remains supported for other active callers. The physical startup remains in Body Control.

Buffer admission publishes one feed entry. Memory, interface return and TTS branch directly from the buffer, with no memory-to-speech dependency. Existing memory/audio settings remain authoritative. The focused wake-up and shared-delivery tests pass for successful/failed camera capture, dated live Robot Status, one model call, one buffer entry, one saved memory with autonomy metadata, one queued speech render, and replay without duplicates. Core typecheck passes. No physical action or inference was dispatched. The user is rebuilding/restarting the application; live editor/runtime verification is separate.

The eleven-node graph was rendered using the actual Svelte BaseNode editor components in an isolated preview. All expected nodes and functional colors were visible; expanded cards had no overlaps. Temporary preview files and processes were removed. Four focused wake/shared-delivery tests and the final Core typecheck pass.

Final Site build passed, and the compiled runtime matches source and validates all 46 workflows. The production HTTP listener was not running at the final check; no service restart or live wake test was performed.

### October 23 — Wake latency investigation (11:43 boot)

Read-only investigation; no robot commands, playback, firmware changes or production code edits. Boot connection logged at 11:43:42 (whole-second precision); snapshot frame ready 11:43:46.031, Core received it 46.066. Existing P4 camera.c deliberately settles each still for at least eight frames and 300 ms of stable exposure/gain, with a 4-second settling budget. Auto resolution can meter at 960p, change to 1080p, and settle again. Capture metadata has settle_ms/settled internally, but those fields were absent from this stored wake observation, so hitting the four-second budget versus earlier stability/mode switching is not proven for this incident. Do not label this a fixed four-second delay or remove exposure settling without reviewing the image-quality tradeoff.

Big Brother Persona request took 5,795 ms with image input. After the image reached Core, model request began about 1.44 s later. Model finished 53.297; TTS stream began 54.857 (1.56 s). First audio reported 57.089; artifact identity timestamp was 57.705; speech child graph began 57.817 and completed 58.193; Body Control accepted audio at 58.179. Those intervals overlap where transport admission occurs during graph completion.

Confirmed unnecessary speech-path work: stageRobotSpeech invokes cleanupSpool, which calls loadQueueState and decodes every Coordinator record before selecting active audio references. The current ledger held 11,787 records / 177,313,695 JSON characters: zero active items, 200 history entries, 11,587 retained delivery receipts. Read-only replay of the exact JavaScript SELECT-all/JSON.parse path took 584 ms and 540 ms. This closely matches the recorded 616-ms first-audio-to-artifact gap; it does not explain the earlier 2,232-ms synthesis interval. Repair belongs to queue-persister and its speech consumer: read the referenced pending artifacts without materializing unrelated retained records. This diagnosis does not authorize deleting delivery receipts.

Kokoro remains CUDA with no reported fallback. Direct HTTP replay of the same chunks, without playback, took approximately 250–290 ms; the existing Core KokoroService replay with cache disabled took 279/300 ms, with health requests 13/3 ms. The recorded first-chunk metric includes readiness, HTTP, cache writing and client scheduling, not GPU inference alone. The live first-chunk slowdown is not reproduced in isolation and must not be attributed conclusively to cold start. Concurrent memory indexing did run during that first chunk. Its owner reads/rewrites a roughly 31 MB JSON index; read-only read/parse and encode measurements were 234/197 ms, but their exact contribution to the historical 2.2 seconds is unproven.

Wake root checkpoints expand from 186 KB to 2.93 MB through repeated evidence/node state. Offline use of the actual checkpoint serializer took about 0.4 s across all 13 root checkpoints, excluding pending writes, SQLite commits, outbox delivery and scheduling. This is measurable overhead, not evidence that it accounts for the whole handoff delay. Existing node execution times were small (Robot Status 72 ms, Context 1 ms, memory save 90 ms); no stretch receipt blocked greeting. Priority: remove the full-ledger audio-cleanup read at its existing owner; then sample the normal concurrent TTS path with separate server and client timings before changing Kokoro or scheduling.

### October 23 — Camera and audio staging latency repairs

The owner selected native 1280×960 snapshots. Body Control's saved selected-robot setting already specifies 960P (settings file last modified October 20), so Auto's second mode switch is not established as the cause of the recorded four-second startup capture. No setting override or dashboard-auth bypass was needed.

P4 camera.c now retains the running sensor's exposure assessment between photos and measures stability during preview. Sensor restart or mode change resets that assessment; changed exposure/gain still invalidates prior stability. Deleted the per-request reset and redundant Auto-transition reset. No shutter/gain restriction, new settling delay or camera owner was added. Native regression first failed on the old implementation, then passed after repair: successive settled snapshots and a snapshot after stable preview emit on the next simulated 50-ms frame; a changing-light snapshot after stable preview still reports unsettled evidence at the existing settling budget. Cold-start/mode-change behavior and cancellation remain covered. These simulated timings are not physical latency measurements. Firmware has not been flashed.

Audio spool cleanup no longer restores and decodes the complete Coordinator ledger. queue-persister exposes the active-reference projection, joining only current item identities to stored work. Existing Coordinator restore remains its canonical startup owner; pending artifact retention, cancellation and missing-record errors remain intact. The actual read-only SQL query on the current ledger took 0.40–0.73 ms versus the prior 540–584 ms full read/decode. EXPLAIN confirms indexed work-item lookup rather than a historical-payload scan. No receipts were deleted and no parallel ledger/cache/retry system was introduced. Regression coverage deliberately corrupts unrelated history/receipt payloads to prove audio reference lookup does not decode them.

Kokoro's existing tts_generated audit record now separates readinessMs, requestMs and cacheWriteMs, retaining its total duration. Request time explicitly includes HTTP and client scheduling, not solely GPU inference. No new logging stream, warm-up process, inference behavior or server restart was added. Historical 2.2-second first-chunk attribution remains unresolved: isolated exact-text synthesis is fast; the new breakdown needs a normal live trace after activation.

Validation: 17 focused queue/audio/Kokoro tests pass; Core typecheck passes; native camera regression executable passes; task-file diff whitespace checks pass. Updated the Body Control camera documentation and Bible. Source changes are not activated: no MetaHuman restart, firmware flash, physical motion or speaker playback was performed in this repair. Remaining work: activate the OS build and P4 firmware through their existing owners, then measure cold startup and warm snapshots separately and inspect the split TTS timings under normal concurrent workload.

### October 23 — Normal-message follow-up: missing microphone audio

Owner identified the latest test as “how are you today”; no message appeared. The diagnostic audio identifies audio:ainekio-p4-e6ebe5:9:0, ended 19:11:52.702 UTC, 74,924 WAV bytes, 2,340 ms, wakeTriggered true, truncated false. Whisper returned empty text at 19:11:53.211 after 507 ms. Bridge's existing empty-transcript branch reported ignored / No speech was transcribed, so this utterance never reached Intent, Persona or Kokoro.

Authenticated read of the retained WAV found 117 twenty-millisecond frames: 101 entirely zero, only 16 carrying nonzero audio (indices 0–6, 49, 72, 82, 104, 112–116). Robot telemetry changed from mic_drops=0 at 19:11:48 to 101 at 19:11:53. Gateway AudioUtteranceAssembler fills missing sequence numbers with silence. Offline replay on the existing cached base.en CPU model returned no segments with VAD enabled (zero seconds retained by VAD) or disabled (the full 2.34 seconds considered). No services/settings were changed and no playback occurred. This is a lost-audio failure before TTS, not evidence of Kokoro failing to answer.

Source tracing finds a concrete transmitter scheduling concern in P4 controller.c: its shared link loop can block 20 ms waiting for a control reply, drains only one microphone packet, then synchronously sends a camera packet; microphone production is one packet per 20 ms, with eight packet slots and drop-on-full. Camera frames continued during the loss, and the gateway recorded a 1,558-ms body-clock gap. The missing sequence numbers and exact matching firmware drop count localize loss to the microphone transmit path; per-send hardware timing is still needed to distinguish the precise blocking contribution. No firmware change was made in this diagnostic.

The preceding successful normal exchange, “Good morning. Thank you for the introduction.”, was also slow: transcription at 18:50:41.412, TTS start 18:51:01.441, first audio 03.872 (2.431 s), first Body Control acceptance 05.671, i.e. 24.259 s from transcription to acceptance. Second chunk synthesis took 1.588 s. Intent and Persona calls measured 6.338 s and 5.752 s. A later startup greeting at 19:03 also measured 3.177 s to first audio. Live MetaHuman still runs the 11:37 process/build, so the new split Kokoro timings and selective audio-ledger repair are not active. Test-only stream-test/cache-test audit entries are excluded from these live measurements.

### October 23 — Approved P4 microphone/camera transport activation

Owner approved camera-chunk protocol type 0x03 and subsequently explicitly requested flashing. Existing P4/Body Control owners now transfer a JPEG in contiguous pieces with the original frame counter, uint32le total length and offset. The link task drains ready audio between pieces, receives control replies without the former 20-ms queue wait, and uses producer notification while idle. No microphone queue enlargement, image-quality change, new transport service or retry layer was added. Complete JPEG frames remain supported for older bodies. Native production callback-to-gateway regression delivered all 117 simulated microphone frames while transferring five large images, with zero missing frames and five complete reconstructed images. Forty gateway/P4 audio tests, portable binary fixtures, full ESP-IDF build and three interacting body/camera native tests pass.

At 13:15 PDT, uploaded and activated the prepared 3,400,528-byte application using the existing authenticated P4 OTA owner. Artifact SHA256 c93d4f8a0569dd88bd0ceca002129f844d4275b22ad9049225e13846a6d3ec40; embedded ELF SHA256 55194bb1ac7060c8b072e88f9d1ebbcd2e147c0cd0d63cc51b3d9ac0439a7ad2; version 0.8.117-p4-rest-release. This prepared image includes the workspace's previously disclosed rest-release changes, camera exposure reuse and microphone/chunk repair. Body Control receiver was activated before firmware. Robot moved from ota_0 to ota_1 and returned state accepted, pending_verify false, error ESP_OK. Gateway reconnected at 20:15:26 UTC, epoch 3; completed camera frames resumed, output_ready true, output_fault 0, mic_drops 0 before a new spoken test. These observations establish deployment and image reception, not speech-loss or latency qualification. Broader latency investigation remains paused; flashing did not restart MetaHuman or change model services.

### October 23 — Body Control motion selector and startup integration

Owner requested a default motion-system selector so startup requests stretch from the configured system. Implemented a per-robot Freestyle / Motion Library selector in Body Control Poses and emotes, persisted through its existing control-settings owner. GatewayService.request_motion owns selection; the wake procedure no longer directly chooses emote/stretch. Freestyle uses its existing configured generator/executor and returns a submitted job identity without waiting for generation or physical completion. Library uses the existing command sequence. Unconfigured robots retain library behavior; no automatic fallback was introduced. Direct library/manual and explicit Environment command paths remain unchanged. No model instructions changed.

Validation: 91 gateway/dashboard/startup tests passed with PYTHONPATH=Master:Slave/software:Emulator:Emulator/tests; dashboard motion-handler checks including selection persistence in the UI, unsaved edits and delayed per-robot saves passed. Saved setting restoration, no movement on save, Freestyle versus library routing, and missing Freestyle reporting are covered. The broader 67-case adapter/startup run passed 66 under system Python, with the remaining camera-provenance test needing cv2; that test passes using the existing ComfyUI environment. The full suite in that environment hits five pre-existing WebSocket API-version fixture errors. No dependencies were installed or changed.

Activation outstanding: Body Control needs a restart to load Python routing, then select Freestyle and save for the intended robot. No service restart, model inference, physical motion, or firmware flash was performed for this selector change. Live startup/Freestyle physical behavior is not yet verified.

## 2026-10-23 — Current context, persona provenance, and Body Control motion ownership

- Confirmed startup input included a completed morning task as current, repeated old diagnostic instructions, and `currentVision:false` despite an attached fresh frame. Text payload was 19,362 characters; Robot Status contributed 13,179. Repaired current-task selection at ExecutionStore, separated status history on its existing output, and connected wake observation/currentness to Conversation Context. No token cap, new node, prompt extension, or motion-completion wait added.
- Removed exactly the learned persona heuristic “motor output reports a fault” → “cannot confirm current physical posture or movement completion” through Identity archive/save. Psychoanalyzer receipt `psych-3250bc7d6e731765b1c9c9b7` dated 2026-10-15 cites two assistant diagnostic messages and one user stand request despite recorded `userInputOnly:true`. Current selector already excludes assistant-role evidence; recurrence at that historical boundary is not yet proven. Do not invent an additional filter.
- Confirmed named MetaHuman motions bypassed the configured selector; custom right-hand request instead entered MetaHuman’s obsolete eight-servo generator and failed remote inference with HTTP 404 before dispatch. Owner approved `requestMotion` action and exact description wording, plus exclusive edits to the Body Control adapter/Freestyle bridge.
- Replaced the old generator graph/node/Coordinator handler and generatedMotion program branch with a typed action carrying the movement description through the existing bridge. Body Control owns the chosen system, generation, receipts, cancellation and reconnect results. Existing manual library/low-level control remains separate. No automatic fallback on Freestyle error.
- Added exact wave, right-hand and Hamlet requests as held-out training regression cases. Converted obsolete custom-motion fitting examples to the approved action. Frozen training outputs and model assignments were not modified. Actual configured Task and Persona roles currently resolve to Big Brother GPT-6 Sol, not the registered Task LoRA.
- User will build/restart after this edit round; do not activate services or claim live repair. Tests use simulated body commands. Current qualification and remaining baseline failures are reported below when checks finish.
- Final focused evidence: 33 Core contract/wake/scoring tests, 3 Environment workflow/Active Task tests, 33 Body Control motion/startup/selection tests, 55 adapter tests under system Python plus the camera-provenance test under the existing cv2-equipped environment all pass. GatewayService's earlier 36-test pass remains applicable. Core typecheck passes. Saving the motion selector now publishes capabilities through the existing bridge; a lost dispatched-motion receipt reports outcome_unknown with the ended job identity instead of a confirmed failure or indefinite pending work.
- Actual configured Big Brother Task replays selected valid requestMotion actions for wave (4.295 s), right-hand raise (4.961 s), and Hamlet (5.601 s); the last retained a free-form performance description. Evidence: logs/benchmarks/body-control-motion-20261023/replays.json. This is three action-selection checks, not physical-motion or local-LoRA qualification.
- Training corpus suite: 23/25 pass. Remaining failures concern reused frozen Intent records lacking needsGoalReview and a goal-attribution test parsing the current plain-text user-message envelope as JSON. Current freshly generated source records pass runtime-output/capability validation. Earlier broader context/Active Task suites also retain unrelated stale goal-review role/continuation/locomotion expectations; no full-suite success is claimed. Training sources and scoring were updated, not frozen datasets or adapters. Next training must regenerate and qualify the contract under actual serving before replacing the active Task role.
- Activation remains with the owner: rebuild MetaHuman and restart MetaHuman and Body Control after this round. No firmware flash is required for these host changes. Do not interpret source/tests as evidence that the still-running old runtime has changed.

### October 23 — Bread-picking reply omitted correlated motion completion

Owner reported the extra statement “The motion request was admitted, but I don’t have confirmation that the gesture happened.” Execution 218b2b59-e928-4e4d-9909-228b77cd60f9 received “Please act like you're picking some bread.” at 18:04:34 PDT. Its requestMotion action 1e8a3e2a-4a22-41b1-bf8e-4431efe43dd5 returned Freestyle completion at 18:04:52.389 with body receipts 29–32 all done. Persona context was assembled at 18:04:54.433, after that result, but execution was null. The supplied taskResult retained only the string evidence ["completed"], while the selected Task decision still described admission and an unsettled bounded objective.

Root cause reproduced through the saved Environment graph: conversation-execution had only an incoming control edge from optional Goal Review. With needsGoalReview:false, all incoming edges were inactive and the reader was skipped. Added one visible Active Task result → Current Execution taskResult edge using existing ports. The review edge remains for selected assessments. No new node, model call, wait, prompt instruction, or completion claim was introduced. The regression now covers response selected/unselected with review off and asserts that Persona receives the exact correlated receipt, action identity and movement description. Both integration cases and all 10 execution-context tests pass.

Six offline Big Brother gpt-6-sol replays used the exact recorded prompt and context, with only the repaired execution evidence added in three variants. Original: 2/3 said no confirmation, 1/3 acknowledged a result but added a physical caveat. Repaired: 3/3 acknowledged completion, but all three still added a visual/physical-confirmation caveat. Thus receipt delivery is repaired in source; the conversational-style complaint remains unresolved. The current conversation system prompt includes “A reported command completion does not establish unmeasured physical conditions.” The owner has been asked to approve deletion-only evaluation of that sentence; no instruction change or evaluation variant using changed instructions has been applied. Evidence and all six outputs: logs/benchmarks/persona-receipt-20261023/. Replays dispatched no physical actions. No services were restarted.

Follow-up: owner approved the deletion-only experiment. Eleven offline gpt-6-sol samples completed using the existing configured Persona backend. All three recorded completed-motion replays with that sentence deleted still added a physical/visual-confirmation caveat, so the deletion did not qualify and was not applied to the production graph. Two paired synthetic pre-dispatch-failure cases and two paired accepted-only cases retained the reported failure/pending outcome under both prompts; the deleted variant sometimes used present-tense theatrical language before its pending disclaimer, so it is not evidence of fully resolved grounding. Exact inputs and outputs are in deletion-results.json beside the earlier evidence. No physical commands or service changes occurred. Requested approval for a subsequent deletion-only test of the two explicit response-reporting directives about preserving uncertainty and describing discrepancies. The prior receipt-handoff source repair remains separate and valid; conversational wording remains unresolved.

The owner approved that broader deletion-only evaluation. Initial and paired-repeat results: four of six completed-motion outputs omitted the technical disclaimer, versus zero of six under the original prompt with the same repaired receipt context. Two of six still included the caveat. The two synthetic failure and two accepted-only samples under the candidate explicitly retained failure/pending status; theatrical first-person phrasing sometimes preceded those qualifications, so these checks are not blanket semantic qualification. Evidence: reporting-deletion-results.json and reporting-confirmation-results.json in the same benchmark directory. Applied only the three approved sentence deletions to conversation-context.systemPrompt; added no replacement direction. The factual-grounding statements, supplied evidence, model assignments and other prompts remain unchanged. Both focused saved-graph integration tests pass after the edit, and all 45 graph definitions validate. Scratchpad records a partial wording improvement, not complete resolution or physical proof. No services restarted, no firmware changes and no physical actions dispatched.

### October 23 — Autonomy Robot Status delegation loses its selected evidence

Owner supplied the 18:45 greeting and 18:46 Autonomy/Robot Status intention. Read-only diagnosis: controller execution 1ed4203b-6a11-48ca-aea4-e4f0deaf438f acquired camera frame 44 at 18:46:43.011 PDT, then selected robot-status with an instruction referencing that attached image. activeOperatorDispatchNode passes frames/observation through only its environment-executor branch; the other-operation request carries plannerDecision and graphContext.taskBrief, but no selected frame. executeRobotStatusGraph then constructs a fresh context without that taskBrief/plannerDecision or selected session. Its graph and context builder supply textual status/history only, not image content. Child 59aaf63c-78fe-462a-b27b-d00a0f7050f4 completed at 18:46:59 with “No current visual frame is available” and saved that stale visual conclusion again. The controller's “keep physical posture and motion outcome unverified” sentence is model-authored planner output, not an appended conversation string or the revised Persona prompt. Robot Status's own standing prompt still asks it to record uncertainty for missing facts.

Repair target: carry the selected operation's instruction, session and source-timed frame through the existing Coordinator/Robot Status owners and visible graph ports; preserve image identity/time and use the existing model image transport. Prove that selected evidence reaches the status model and its resulting snapshot reaches the next controller assessment. No extra capture, model call, node type or behavioral prompt change is needed merely to fix that handoff. This finding is not yet implemented or validated; no runtime work was cancelled or services changed during diagnosis.

Recognition follow-up: live backend is ultralytics+sface (YOLO detection wrapped with YuNet/SFace identity). The saved gallery contains greg with four samples; no enrollment data was modified. Recognition does reach MetaHuman via vision.recognition. In the exact 18:46 controller model input, recognition referred to frame 43 at 18:46:41.485 and reported zero people/zero face matches; the attached image was frame 44 at 18:46:43.011. The model input explicitly carried imageAssociation:different_frame and no matched name. At 18:53:07, the current bridge record detected one person (detection score 0.5235) but identity.state was unknown, with zero face matches. A person-class score is not face-match similarity. Source preserves identity.name/personId/state/similarity when supplied; this evidence does not show a Greg match being removed. Current image reads and recognition telemetry are independent snapshots. Investigate face-detection/matching misses separately from the image/recognition association and Robot Status delegation defects; do not infer the exact face-miss reason from unknown alone. No source/runtime changes were made in this follow-up.


## 2026-10-23 — Frame-bound recognition through autonomy and Robot Status

- **Requested repair:** Carry the actual camera image with its matching YOLOE/object/face estimates into autonomy and Robot Status, with no prompt changes. Prior incident had recognition for frame 43, camera bytes for frame 44, and a delegated Status task that received neither image.
- **Body Control owner:** Reused `CameraFramePlugin.current_analysis()` and its existing analyzed JPEG. `environment.visual.read` returns this available analyzed pair; immediate snapshots attach recognition only for the same robot/epoch/counter. Without available analysis, raw camera reads remain available without recognition. No new capture, inference, queue, service or wait. Original source time and identity remain on the image; no face enrollment data is transmitted.
- **Core owners:** Shared frame projection now preserves recognition in autonomy and Environment Mode contexts. Active Operator's Robot Status request carries its selected frames; the existing queue handler forwards them and the originating planner decision. Robot Status uses visible existing Operator Input → Image Input → Context Builder edges; the model receives JPEG content plus matching metadata. Session-specific body facts cannot come from a different connected robot. Snapshot JSON records frame provenance/recognition without JPEG bytes.
- **Acceptance:** Body Control camera pair/mismatch/repeated-read/no-recognition/epoch tests pass (3 tests), and the existing camera cache provenance/epoch test passes. Saved Robot Status graph tests exercise `face_match`, `tracked`, and `unknown` through real graph wiring, context construction and persisted Status output, with the model mocked to inspect its exact input. Queue handoff, Active Operator admission and autonomy context tests pass. Core typecheck passes; all 45 saved graphs validate. Broader 60-test regression run: 58 pass, 2 existing unrelated assertions fail (V2 capability wording in `context-builder.node.spec.ts:88`; Goal Review role expects Persona while configured graph uses Psychotherapist in `robot-status.spec.ts:905`). Those assertions and settings were not changed. Additional two focused graph/autonomy tests pass.
- **Activation and limits:** Source changes only; no service restart, firmware flash, physical actions or production LLM calls. MetaHuman rebuild/restart and Body Control restart are needed to activate. Live named-face accuracy and the resulting LLM interpretation still require a live test after activation. A plain `person` with `identity.state:unknown` remains unknown; transport cannot create a Greg face match. Independently triggered Status without delegated image evidence retains its existing text-only behavior; this repair carries the camera evidence already selected by autonomy.


## 2026-10-24 — Morning latency review and active-context query repair

Reviewed the 10:27–11:08 PDT conversations using their durable execution checkpoints/events and the existing audit timing records. Recorded workflow lifetime includes playback, interruption and later continuation; it is not interchangeable with time to first reply or first generated audio.

| Request | Workflow admission to first synthesized audio | Own model calls | Other recorded cost |
| --- | ---: | ---: | --- |
| “Can you hear me?” (10:28) | 15.17 s | Intent 4.763 s + Persona 3.923 s | First TTS chunk 1.318 s; remaining 5.17 s is handoff/context/scheduling. Body Control then rejected computer playback because `paplay` was missing. |
| “What can you see now?” (10:39) | 41.81 s | Intent 5.630 s + Vision planner 5.844 s + Persona 6.879 s | First TTS chunk 0.320 s; camera acceptance-to-result 3.271 s. Supplied frame was approximately 36 s old at request admission, so the selected fresh capture was not proven redundant. Remaining latency spans camera-read work, graph handoffs, context, output delivery and browser TTS admission; exact CPU attribution is not established. |
| Continue story with body motions (10:51) | 52.36 s | Intent 4.374 s + Task 5.077 s + final Persona 6.267 s | Motion accepted at +14.35 s and cancelled at +31.09 s. Final reply followed that action result. Concurrent Persona calls are separate work and are not all charged to this request. |

All 190 completed model calls in this morning window used configured Big Brother GPT-6 Sol. Intent median was 4.675 s; Persona median 5.041 s. No model assignments or instructions changed. Across 59 speech starts, synthesis-to-first-audio median was 643 ms (max 3.645 s); this excludes admission/transport/browser playback. Whisper median for 32 recorded transcriptions was 706.5 ms, with an 8.465 s outlier. Current GPU state cannot establish GPU load during an earlier request.

**Confirmed overhead repaired:** `graph-executor.ts` built `activeExecutions` by decoding all 8,339 saved records and filtering afterward. The existing ExecutionStore now queries running/waiting records for that profile first, using its existing status index. Same three current records returned in 0.07–0.19 ms versus 41–81 ms for the former path in a five-run, read-only Node comparison on the live database. No history was deleted, no cache/limiter/fallback/wait was added, and compatibility/steering checks remain intact. This is a small measured improvement, not a claim to have removed the remaining multi-second delays.

**Outstanding findings:** Speech-like incoming fragments repeatedly resemble preceding narration; playback/microphone origin needs confirmation before changing capture behavior. The configured Body Control computer player failed at least one early speech action with missing `paplay`; no dependency was installed or playback route changed. Three saved waits remain: a disconnected-camera clarification, an ambiguous camera-request clarification, and a story continuation represented as a task awaiting input. No live work was cancelled. An empty continuation instruction also failed graph.resume three times around 11:02; its producer still needs a separate repair. First-chunk readiness can exceed a second, but the available client-side timing does not distinguish server scheduling from MetaHuman event-loop stalls; do not attribute all of it to GPU synthesis.

**Validation:** 44 ExecutionStore tests pass, including active-only decoding, profile isolation, preserved wait metadata and changed state on repeated reads. A real one-node durable graph verifies the Current Execution output reads active peers without calling historical listing. Core typecheck passes. An older compatibility-handoff workflow test fails because its fixture does not receive the expected active execution; replay with the original list/filter implementation fails the same assertion, establishing this is not caused by the query repair. No source/runtime activation or physical testing claimed: build/restart has not been performed for this repair.


### 2026-10-24 — Q6A communication loss and remote tunnel lifecycle

The owner requested restoration of immediate communication followed by qualification between different locations. The robot remained connected to Q6A Body Control at 192.168.0.88; WireGuard peer 10.77.42.2 answered in approximately 5 ms. MetaHuman had no bridge process or SSH forward. The existing remote-agent error log recorded `client_loop: send disconnect: Broken pipe` followed by `ssh forwarder exited (255)`. The forwarder had aborted the whole agent while the reconnect loop covered only WebSocket connections.

Restarted Remote Bridge through its existing authenticated Agent Monitor API at 15:13 PDT. The bridge authenticated and the subsequent “Can you hear me?” reached the graph: Whisper 702 ms, local 0.8B Intent 759 ms, local Qwen 9B Persona 4,258 ms. This establishes speech input and model response delivery, not audible playback. Body Control rejected all three outgoing speech chunks because Computer playback selected unavailable `paplay`; the owner has been asked whether output should be Robot or Q6A computer speakers.

Source repair retains the forwarder as a resource owned by the existing bridge reconnect loop. WebSocket failures retain a live tunnel, failed tunnels are replaced, and explicit shutdown disposes both. Removed the outer forwarder wrapper that terminated the agent. Sixteen focused connection/lifecycle tests and Brain typecheck pass, including a real fixture child process killed between successful mocked bridge connections. Runtime activation of this code remains pending a compatible build; restoring the existing live connection is already complete.

Internet qualification remains pending. Both computers currently share the same Wi-Fi subnet. Their WireGuard endpoint settings require administrator access; requested endpoint/listen-port output without private keys. A separate-network test is required after checking public endpoint reachability and router/firewall configuration. No VPN settings, firewall rules, credentials, prompts, or robot motions were changed.

### 2026-10-25 — One automatic Environment Bridge owner

Root cause: the Local/Remote agent choice stopped the other endpoint and persisted that startup choice. Remote therefore kept connecting to the stopped Q6A gateway while the P4 was connected to local Body Control. The old handshake could not be used for discovery: it claimed control and replayed work immediately.

Owner-approved repair: one `environment-bridge` service watches configured local and remote endpoints through the approved authenticated `bridge.watch` / `bridge.availability` exchange. Availability reports selected robot, gateway instance, session and connectivity without replay or control ownership. The existing control/data path activates the sole available robot or an explicitly selected robot. Multiple different robots require a user choice. Initial discovery results are considered together so a first reply cannot briefly claim one of two already available robots. A disconnected endpoint does not prevent use of the other. Existing SSH/Cloudflare forwarding remains owned by remote discovery; one active control stream is retained. Agent Monitor shows discovered robots and persists selection through its existing settings owner.

Removed: Local/Remote agent entrypoints, duplicate catalog/service registrations, mutual-agent stopping, selection lock and startup-choice switching. No model instructions, motion selection or physical command tests changed. The availability projection uses existing diagnostics; no new history store or service was added.

Evidence: 21 focused connection/lifecycle/settings tests passed; after the startup selection race was reproduced, its stronger regression and 11 existing core lifecycle tests passed (14 total). Body adapter suite: 58 passed using the deployment's legacy WebSocket API. Core and Brain typechecks, Site check and production build passed. Existing monitor validation passed; the broader catalog test stops at an unrelated trigger-count baseline mismatch (10 versus expected 13). Interacting action-stream teardown edits from another task were preserved; all 14 focused stream tests passed. Owner reserved overlapping bridge files for activation. Local Body Control was restarted and authenticated live discovery reports connected P4 `ainekio-p4-e6ebe5`. The matching Q6A adapter source was updated and compiles; its gateway is currently stopped. Live MetaHuman activation verification follows below. Off-network WireGuard qualification remains separate and unproven.

Activation verified at 14:51 PDT: compiled `environment-bridge` started through the existing Agent Monitor control endpoint; monitor reports `ready`, exactly one bridge agent, one active session and one action stream. Automatically selected local `ws://127.0.0.1:8790/environment` serving P4 `ainekio-p4-e6ebe5`. Remote forwarded endpoint remains unavailable because the Q6A gateway is stopped; it does not prevent local operation. MetaHuman's application launcher verified compiled Core/source agreement and 45 graphs. No live physical test command was issued. Separate observation: an existing saved Active Operator assessment reports `ExecutionConflictError` against the rebuilt graph/node versions; no cancellation or autonomy repair was performed in this transport task. Remote source activation will occur when its gateway is next started; real off-network switching remains untested.

### 2026-10-25 16:34 PDT — Fresh conversation latency and CPU attribution

Owner spoke “Hello, how are you today?” through local Body Control after bridge activation. Execution `746616c9-1691-4dc2-ba54-6d7efe604010`, utterance `audio:ainekio-p4-e6ebe5:3:0`. Recorded audio ended 23:34:20.877 UTC, 140 frames with zero missing frames. First speech chunk accepted by Body Control at 23:34:37.041: 16.164 seconds. This is acceptance, not an instrumented audible-start measurement.

Timeline: transcription finished 22.262 (1.381 s inference); Intent started 25.336 and finished 26.106 (0.770 s, 554 input tokens); Persona started 28.378 and finished 32.233 (3.855 s, 4,921 input tokens); TTS began 34.193; first audio generated 36.208 (2.015 s; readiness 165 ms, request 1,848 ms, cache write <1 ms); Body Control accepted 37.041. LLM total 4.625 s; transcription plus first-chunk TTS 3.396 s; approximately 8.143 s outside those measured calls. Task, camera, memory retrieval, Goal Review and action execution branches were skipped. No thinking tokens or image inputs went to either model. Root checkpoint contains 1.87 MB after blob expansion; numerous short node batches are separated by 100–800 ms handoffs. Three thinking-face commands were emitted across transcription and response stages; these are separate selected feedback stages, not proven duplicate execution.

Read-only live CPU profiling located the main application waste. Site used a full CPU core in a three-second sample; Active Operator used 116% while model servers were mostly idle. In a subsequent 5.253-second Site profile, repeated `loadSessions` calls from `recoverDurableExecutions → stillActive` accounted for 2.177 s (~41%). Recovery loops through all retained receipts and calls `dispatchReady` between records, repeatedly scanning the task collection. Active Operator's 5.191-second profile spent ~2.447 s in `loadQueueState` materialization, plus 0.739 s garbage collection. Its queue-directory watcher rereads the full ledger to test whether an assessment is active. Ledger at measurement: zero active items, 200 history entries, 13,693 retained receipts, 235,064,217 bytes across 13,893 work records. Auth document contains 134 sessions / 31,768 bytes; the excessive repeated reads, not unusually large individual auth data, dominate.

Repair priorities: use the queue persistence owner's selective active-work query for Active Operator; have recovery select only unresolved delivery/reconciliation work rather than walking completed receipts; keep authenticated-owner checking accurate without repeatedly materializing the complete session document; retire acknowledged terminal queue copies through the existing lifecycle once their required consumers no longer need them. Preserve durable action/result evidence in its canonical execution owner. Do not delete receipts indiscriminately or add delays, limits, fallback paths, or instruction changes. Kokoro's variable request time needs separate server-vs-client scheduling attribution after this CPU waste is repaired (the final 110-character chunk took 349 ms versus 2.015 s for the first 24-character chunk).

No production source, model settings, prompts, queue state or service mode was changed during this diagnostic. Built-in Node CPU profiling was temporary; inspector listeners were closed afterward. Linux perf access was unavailable; no system permission settings were changed. Local profiles are `/tmp/robot-latency-site.cpuprofile` and `/tmp/robot-latency-active-operator.cpuprofile`.


### 2026-10-25 — Selective queue reads and receipt recovery repair

Owner reserved Active Operator and queue/durable execution paths; existing edits were preserved. The Coordinator and ExecutionStore remain the owners. Active Operator now reads active-item membership through `readActiveQueueItems`, replacing its full-ledger restore call. Full restoration remains at actual startup. ExecutionStore selects undelivered receipt identities using a partial index and excludes already correlated unsent-speech cancellation results. Recovery intersects these identities with the existing receipt-delivery contract and retains active admission reconciliation. Camera-read reconciliation only visits active camera reads. Delivered terminal results no longer cause repeated authentication reads, result hashing, I/O yields and dispatch scans. No prompt, model, behavior, limiter, retry, auth bypass or new queue was introduced.

Local ledger comparison: zero active items, 200 history entries and 13,717 durable receipts (236,602,005 payload bytes). Full restoration took 787.83 ms; active-only query median 0.437 ms across ten reads, maximum 0.715 ms, with identical active membership. Read-only cross-store inspection found zero terminal receipts needing delivery. Receipt copies are currently retained for admission identity until execution retirement; configured retention is 30 days from the execution's last update. The four entries created before September 25 belong to retained executions updated later, rather than a demonstrated failure of that retention policy. No retained receipt was deleted in this repair.

Validation: 101 tests passed across queue persistence, durable store/recovery, authenticated recovery and Active Operator; an additional 128-receipt selection/index regression passed separately (102 total). Tests cover current membership without parsing historical payloads, undelivered results whose dispatch is already terminal, unchanged correlated cancellation on repeated restart, I/O yielding, no writes for idle settled receipts, and one dispatch check rather than one per historical receipt. The former idle test required an HTTP round trip to finish before recovery ended; it now checks event-loop yielding and the HTTP response without requiring idle recovery to stay busy. Core and Brain typechecks and Site production build passed. Task diff whitespace/reference checks passed.

Activation pending owner approval: three saved Environment Mode conversations from October 24 remain waiting for user/autonomy (large-cat question, ambiguous camera phrase, lighthouse story). Requested authorization to cancel these saved executions while preserving their recorded results, then restart MetaHuman and Active Operator. Body Control and model services remain unchanged. Do not claim improved end-to-end robot latency until activation and a fresh spoken test. Kokoro first-chunk timing remains a separate unresolved investigation.


Activation follow-up, October 25 17:02 PDT: owner approved continuation. Cancelled exactly the three listed saved conversations through the authenticated Queue cancellation endpoint; all returned success and retained their execution evidence. Restarted MetaHuman through its launcher and Active Operator through its existing service-control endpoint. Body Control, both llama.cpp servers and Kokoro retained their processes. The bridge reports one connected session and zero pending commands; queue membership and active-execution queries are empty.

Post-activation profiling found a second historical-read consumer in the same Active Operator path: `activeRobotExecutions` called `store.list` and filtered afterward. The helper now uses existing `store.active(username)` before reading environment membership. Other existing robot-operator edits were preserved. Added a regression proving terminal historical definitions are never decoded for active admission. All 28 affected recovery/Active Operator tests passed; Core typecheck and the rebuilt Site passed. Activated that follow-up with no further work cancellation needed. Short CPU samples changed from Site approximately 100% / Active Operator 116% of one core before the repair to Site 42.6% / Active Operator 33.6% after both changes. These are separate short live samples, not controlled end-to-end latency measurements. The earlier post-first-activation Site profile was mostly idle, with remaining work led by telemetry state writes; Active Operator historical decoding accounted for its remaining high CPU before the second repair. Temporary inspectors were closed. A fresh spoken “How are you today?” timing test has been requested; no new microphone-to-audio result is claimed yet.


### 2026-10-25 17:16–17:19 PDT — Two spoken latency checks after activation

First request, “How are you today?”, execution `288606d7-3c77-4ea3-bd89-c268d773358c`, microphone `audio:ainekio-p4-e6ebe5:7:0`: recording ended 00:16:08.926272 UTC, first speech accepted by Body Control 00:16:26.017429, total **17.091 s** (previous baseline 16.164 s). All 135 frames arrived. STT 0.749 s; Intent call 3.063 s; Persona call 3.765 s (4,911 prompt/74 completion tokens); first audio generation 1.724 s; other handoffs 7.790 s. Native Intent logs confirm it exited sleep and reloaded; actual prompt/decode 0.544 s. Native Persona prompt/decode 2.253 s, so model-call elapsed time includes substantial non-inference time. Separate Fast Body Event and Robot Wake-Up requests occurred around this test; the wake Persona call used an image, while the conversational request did not. CPU reduction did not establish an end-to-end speed improvement.

Second request transcribed as “Can you explain this either loop more?”, execution `15e00ba9-2ef5-4c5b-9b46-3b3bf5884a98`, microphone `audio:ainekio-p4-e6ebe5:7:135`: recording ended 00:19:02.736443 UTC; first speech accepted 00:19:25.648575, total **22.912 s**. All 147 frames arrived. STT 0.665 s; warm Intent 0.614 s; Persona call 10.362 s (8,753 prompt/524 completion tokens, no thinking/image); first audio generation 1.532 s; remaining handoffs 9.739 s. Persona authored 1,978 characters before TTS admission, with 1,602 spoken characters split into 19 chunks. First-audio acceptance is not instrumented audible start. The longer answer explains much of the increased model time; handoffs remain independently excessive. No inference settings, output limits, prompts, services or physical commands were changed during these measurements. Next diagnostic targets: graph/model-return/output handoffs and voice readiness overhead, preserving complete selected context and model choices.


### 2026-10-25 17:28 PDT — Main-thread attribution of remaining response delays

For the 17:19 spoken question, the 9.739-second residual is localized: transcription end → Intent call start 4.268 s; Intent return → Persona call start 2.201 s; Persona return → TTS start 1.899 s; first generated audio → Body Control acceptance 1.370 s. Saved node entries show many 0–7 ms node bodies separated by 100–1,000 ms gaps. The root checkpoint before Persona expands to 1.59 MB, mostly saved nodeEntries, although contextSnapshot is only about 26 KB. Isolated staging of that same full checkpoint took 36–44 ms, so checkpoint serialization alone does not explain the large gaps.

One authorized conversation-only diagnostic “How are you today?” was submitted through the existing authenticated UI queue route at 00:24:46.939 UTC (task `task-1792974286967-6b4f96a6`, execution `040e0f17-584c-4e33-8323-0043ad0422f7`). A 30.44-second Node CPU sampling profile was captured around this request and subsequent delivery. The server had independently restarted since the previous test; the profiled PID was 2427024. No diagnostic source edits, service restarts, settings changes or motion requests were made. Profile `/tmp/robot-delay-live.cpuprofile`; temporary inspector was closed.

Measured inclusive main-thread sample time: notifyChange 9.976 s; nested saveQueueState 2.975 s, snapshotIdentity 2.549 s and snapshot 1.101 s. exportState across callers 2.827 s. These overlap and must not be summed. Queue lifecycle publication still rebuilds snapshots and canonical identity over all retained task identities/idempotency entries, then serializes membership even when one work item changes. Several mutation paths call notifyChange directly and again through emit; the second call still builds and compares a full snapshot before deciding nothing changed. An isolated in-memory diagnostic, with no disk writes or model calls, measured median appendOutput bookkeeping of 0.109 ms with one terminal receipt versus 28.627 ms with 14,000 synthetic receipts. This proves cost scales with unrelated retained work. Persistence is already row-based but its surrounding bookkeeping remains whole-ledger work.

A separate live stack decoded all saved executions in handleEnvironmentBridgeBehaviorSettings; its loadUsers/profile-policy reads alone occupied about 1.15 s of the profile, excluding other decoding. Body Control dashboard refreshBehaviorControl is requested at five-second intervals while updating its body display. The handler should use the existing active-execution query for this active-status/cancellation selection; retaining the UI feature does not require historical decoding.

Vector append runs in the same Node process and writeIndexFile synchronously serializes and replaces the entire 38,179,893-byte semantic index for one new memory. appendEventToIndex occupied 1.815 s in this sample; two index work items reported 1.531 s and 2.194 s wall durations. This is actual memory indexing, not queue history, but it blocks other event-loop work despite being admitted as background work. Native SQLite run samples totalled 5.255 s across owners, including checkpoint writes and queue persistence; this is main-thread sampled time, not proof that fsync alone costs that much. Checkpoint put/putWrites inclusive samples were 2.138/1.089 s.

Repair order recommended: delta-based mutation/snapshot/persistence at the existing Coordinator owner; active-only execution selection in Body Control behavior-settings; incremental/nonblocking writes at the existing semantic-index owner. Preserve durable admission identity, atomic commit/rollback and complete memory evidence. Reprofile after these before changing checkpoint semantics. Full-answer-before-TTS remains a separate architectural latency contribution for long answers, not an explanation for the 9.739-second non-model residual. Exact attribution of Kokoro health-readiness intervals to client stalls versus service work remains unproven. No new delays, output caps, truncation or model-visible wording are proposed.


### 2026-10-25 — Repair practice consolidation and queue result ownership

The Owner requested researched changes to prevent compensating mechanisms and
regressions, rather than another instruction appended to AGENTS.md. Consolidated
AGENTS.md, replaced the historical refactor-program checklist with the existing
Blueprint's repair/state-lifecycle design, and updated the Audit Protocol. Research
sources and their limitations are linked in the Blueprint. No new governance
service, agent, dependency, runtime gate, scheduled sweep or CI framework was added.

Concrete failure: `addTerminal` evicted durable work from recent activity but retained
its full queue payload regardless of delivered results. Prior tests explicitly
expected that retention, and a later cleanup query compensated for it. A new test
through the real Execution Engine reproduced growth before the repair. The existing
durable receipt owner now commits evidence and acknowledges that handoff to the
Coordinator; normal lifecycle releases delivered copies outside the existing
recent-activity window. An unfinished parent does not require those copies.
Undelivered results, failure notices and unresolved physical outcomes retain their
existing responsibilities. Removed the separate settled-receipt cleanup method,
selection query and maintenance call. Historical admission/result facts remain in
the Execution Store. Current recent-activity consumers include Available Autonomy
Tasks and Active Operator status; the existing window was not enlarged or tightened.

Validation: 110 focused queue, persistence, recovery and cancellation tests passed;
Core typecheck passed. Coverage includes ordinary repeated delivery without cleanup,
restart between committed result and queue acknowledgement, failed queue persistence,
physical-result correlation and original evidence preservation. The new ordinary-
delivery test failed before the source change and passed afterward.

Broader qualification is not complete: `pnpm test:durable-execution` reports 335/402
passing and 67 failing. The active-task/expression run reports 9/35 passing. Observed
failures include Intent fixtures missing `needsGoalReview`, retired routing/program
fields, changed graph/output expectations, and missing fixture memory-index setup.
These assertions were not weakened; this run does not establish a clean full
workflow baseline. Reconcile those contracts and their fixtures before claiming
complete workflow qualification. No services restarted, live queue data deleted,
physical actions dispatched, or model instructions changed in this repair. Source
is not activated and new live latency has not been measured.

Activation follow-up, October 25 18:45 PDT: the Owner authorized service restarts
and temporarily selecting Big Brother during the active Freestyle training job.
The Site build passed; the compiled runtime matched Core source and validated all
45 workflows. MetaHuman, its background services, Body Control, Freestyle serving,
Kokoro, Whisper and CPU embeddings were restarted through their existing owners.
The queue had no active work before or after activation; no cancellation was needed.
All 11 supported language-model roles and existing mode overrides now resolve to
the configured Big Brother GPT-6 Sol with reasoning disabled. Previous assignments
are saved locally in `logs/run/model-switch-before-training-20261025.json` for
restoration. A profile-context Persona call returned `READY` through Big Brother;
MetaHuman's local llama.cpp servers remain stopped. The existing Freestyle training
process continued uninterrupted; Freestyle motion serving and voice remain local.
The authenticated availability exchange reaches local Body Control, which currently
reports no connected robot. The remote Body Control endpoint is also unavailable.
Physical response and latency remain untested. Optional Kitten startup reported
missing installation files; the configured Kokoro and Whisper health checks passed.
The broader test-suite qualification limits recorded above remain unresolved.

### 2026-10-25 18:49–18:51 PDT — Live startup and two Big Brother conversations

The local robot reconnected at approximately 18:49:50. Body Control recorded the
snapshot result at 18:49:53 and a Freestyle `motion_plan` result at 18:49:55. The
startup graph made one Persona call (5.948 s); first greeting audio was accepted by
Body Control at 18:50:04.883, roughly 15 seconds after connection. These receipts
do not independently prove the physical stretch or exact audible onset.

The spoken inputs were “I'm busy working on you” and “I'm trying to make you more
consistent and conversational and more like an autonomous companion.” Both routed
to response only: no Task model, camera analysis or Goal Review. All five LLM calls
across startup and these conversations used Big Brother GPT-6 Sol without thinking.

| Interval (seconds) | First conversation | Second conversation |
| --- | ---: | ---: |
| Completed recording received → transcription | 1.933 | 0.941 |
| Transcription → Intent call | 1.621 | 1.744 |
| Intent call | 4.768 | 4.061 |
| Intent return → Persona call | 0.962 | 1.045 |
| Persona call | 5.313 | 6.451 |
| Persona return → TTS start | 1.028 | 1.102 |
| TTS start → first generated audio | 1.355 | 1.069 |
| Generated audio → Body Control acceptance | 0.213 | 0.613 |
| Total through first audio acceptance | 17.192 | 17.027 |

Big Brother call duration includes provider/CLI/network overhead, not solely remote
inference. These totals exclude utterance recording time and do not measure exact
speaker onset. Handoffs total 3.824 and 4.504 seconds; the older 9.739-second sample
used different requests/backend and is not a controlled improvement comparison.
Checkpoint node timing shows mostly millisecond node bodies with roughly 50–200 ms
inter-node gaps. Next investigation: profile scheduling/persistence at the existing
graph owner to attribute those gaps before changing it. The observation-history
node also ran before Intent (426 ms first turn, 7 ms second) despite neither turn
selecting environment context; inspect its actual consumers before moving/removing it.

Startup and both conversation executions reached `completed`; the active queue
was empty after they finished. This verifies those turns, not long-run retention or
reconnect behavior. A later 18:51:42 microphone capture yielded an empty transcript
(Whisper returned in 89 ms); whether that recording contained speech remains
unverified. Kokoro and Freestyle still use local GPU resources alongside training;
the MetaHuman local llama.cpp services remain stopped. No runtime source or prompt
was changed during this measurement.

### 2026-10-25 19:27 PDT — Reduce the measured inter-stage handoffs

**Scope and cause.** Targeted the 3.824–4.504 seconds between transcription, Intent, Persona, synthesis and Body Control delivery. Runtime CPU/SQL profiling found synchronous SQLite commit calls consuming about 1.6 seconds and connection closure about 0.25 seconds in a diagnostic conversation. This profile included a disconnected-speaker failure and is attribution evidence, not a successful end-to-end timing. The Coordinator also committed every live `task_output` progress chunk, although its existing live replay buffer serves stream reconnects and the next lifecycle transition can retain that buffer.

**Repair at the existing owners.** `UnifiedQueueManager` publishes progress immediately without its own ledger commit; admission, claim, completion and delivery acknowledgement retain their normal commits. No new queue, timer, cache, cleanup process, checkpoint batching or prompt change was introduced. With the Installation Owner's explicit approval, the Coordinator persister and Execution Store use SQLite WAL `synchronous=NORMAL` instead of `FULL`. Atomic transactions, immutable result identities, replay and rollback remain. Application crashes and reconnects retain committed work; power loss or an OS crash may lose recent commits. The approved tradeoff is recorded in Maintained Surface and the Bible.

**Measured isolated evidence.** On this machine's filesystem, three replays of 17 recorded checkpoints had median save times of 663.75 ms (FULL) and 350.12 ms (NORMAL); reopened state matched. A queue lifecycle with 20 progress updates dropped from 23 commits / median 435.63 ms to 3 commits / median 91.63 ms. Its final result and progress replay were retained. Temporary benchmark databases were removed after each comparison. These are component measurements, not a prediction that the entire conversation becomes twice as fast.

**Validation and activation.** The progress regression failed before the repair with an actual SQLite trigger rejecting an unwanted progress commit, and passed afterward. Ninety focused tests passed across queue persistence, durable admission, stream lifecycle, execution storage and work lifecycle. Coverage includes abrupt SIGKILL of an isolated writer, recovery of its checkpoint and pending writes, and preservation of its undelivered work result. Concurrent autonomy changes subsequently modified the execution store; the interacting storage/persistence tests were rerun (59 passed). Site build passed and compiled runtime validation confirmed all 45 workflows. Core typecheck still reports errors in concurrently edited autonomy and training code; no clean repository-wide typecheck is claimed. The application restarted through its existing launcher at 19:24:37; Body Control, Big Brother assignments and the running Freestyle training process were left in place. No incident workflow needed cancellation; the queue was empty at activation.

**Fresh spoken test.** “How are you today?” was transcribed unchanged from `audio:ainekio-p4-e6ebe5:2:147`, execution `216acad4-6ce9-454c-90ef-265d295626fe`. All timestamps below use the same existing owners as the earlier live measurements:

| Handoff | Earlier live range | Repaired spoken test |
| --- | ---: | ---: |
| Transcript ready → Intent starts | 1.621–1.744 s | 1.110 s |
| Intent finishes → Persona starts | 0.962–1.045 s | 0.744 s |
| Persona finishes → TTS starts | 1.028–1.102 s | 0.672 s |
| First audio generated → Body Control accepts | 0.213–0.613 s | 0.272 s |
| Total handoff time | 3.824–4.504 s | **2.798 s** |

The handoff total decreased by 1.026–1.706 seconds (27–38%) against those earlier samples. This is one post-activation live sample under ongoing training and concurrent repository work, not a controlled statistical latency guarantee. Big Brother Intent took 3.864 s and Persona 5.182 s. Transcription took approximately 0.646 s after receipt of the completed recording; first-chunk TTS took 0.933 s. Complete recording received at 02:25:16.974580Z; transcript timestamp 02:25:17.621Z; first speech accepted at 02:25:30.397760Z: **13.423 seconds** from completed recording to first delivery, excluding the recording itself. Body Control reported both chunks `speech_played` to its configured **computer** output. These receipts do not independently measure speaker onset or confirm human audibility. Execution completed and Queue returned to zero active items.

Remaining measured handoff time is about 2.8 seconds. Per-node checkpoint serialization and commits still exist; this repair did not weaken those execution boundaries. Do not conflate the remaining 9.046 seconds in the two Big Brother calls with handoff overhead. Further changes should follow a new profile of the active runtime, not another history purge or speculative scheduler.

**Publication:** The seven-file latency repair, regression tests and storage-contract documentation were committed as `6472be23f4508d8ad75a1fac42c0247e7798da91` and pushed to `origin/dev`. The isolated publication snapshot passed 81 focused tests and Core typecheck; it excludes concurrent autonomy/training changes and local diagnostic records. GitHub's branch SHA matched the commit. Main `dev` was fast-forwarded while preserving all overlapping working files byte-for-byte; unrelated edits remain local. The temporary publication worktree was removed.

### 2026-10-26 — Wake image recognition and recorded status separation

The 10:48 PDT wake execution `313efabb-2edc-4c14-bbf8-528c63bb52e2` said “Morning, Greg—if that’s you at the desk.” Its initial photo did not contain recognition metadata. Before Persona started, separately arriving telemetry supplied a fresh `greg` face match for the exact epoch-4/counter-2 frame (573 ms old; recognition inference 187 ms). The same context included a 33-minute-old status interpretation questioning the person’s identity. Missing recognition was not the cause of this particular greeting, but immediate still delivery made the image/recognition association timing-dependent. The old description was retained without separating it from the current situation.

The Owner explicitly approved pairing a requested photo with recognition completion on the existing camera worker. Body Control now joins the existing inference by frame identity; requested stills remain in that worker’s queue while replaceable previews continue using the latest waiting preview. In-flight result references are released at completion, replacement, disable or shutdown. No new worker, persistent store, polling, second inference path or model instruction was introduced. Recognition failures accompany the photo; disabled recognition does not wait. Still metadata retains its original timestamp even when live recognition has expired. Input, motion and other actions remain independent.

Core now owns the shared status projection in `robot-status.ts`, replacing the duplicate node implementation. Saved descriptive interpretation is grouped under `recordedSituation` with status/source times and image identities, separately from live facts and durable goals. The wake Conversation Context path no longer bypasses that projection. Existing model-visible instruction text is preserved, including the different existing Agency-context presentations of direct and routed consumers. Relevant suites are registered in `test:environment-graph`.

Validation: the status regression failed before the repair. Camera tests exercise repeated frame admission, exactly one inference, requested still survival during preview replacement, failure, disable, shutdown, dated results and connection-epoch changes. The simulated wake tests carry image+recognition through Body Control and the saved MetaHuman graph while proving an independent input can proceed. All 80 camera/adapter tests pass using the installed gateway Python environment. Core’s 106-test focused run passes 102; four unrelated baseline failures (retired V2 locomotion prose, an autonomy description expectation, a stale Environment graph layout assertion and Goal Review’s assigned role) also reproduce with the original helper implementation. Core typecheck and Site build pass; compiled runtime validates all 45 workflows.

Unchanged-instruction model replay: all three final repaired-context responses greeted Greg without an identity qualifier. The original context also produced three unqualified greetings, so this is not a measured accuracy improvement or proof that hesitation cannot recur. Some replays still narrated stretching from submitted motion evidence; that separate model-grounding limitation is recorded, not silently corrected by instructions in this repair. No physical actions were dispatched by these tests.

Activation: MetaHuman restarted through its existing launcher and Body Control restarted through `start-physical-gateway.sh`. Runtime parity passed with all 45 workflows; both application APIs responded, the new gateway instance was visible to the bridge watcher, and Queue contained zero tasks and zero executions. The running Freestyle training process was left in place.

Fresh live verification, 11:29 PDT: the Owner powered on the robot and heard its greeting. Robot Wake-Up execution `798422f7-507b-4ce0-b1b3-942c0115248e` completed. Its epoch-1/counter-2 photo, timestamp `2026-10-26T18:29:39.807307+00:00`, arrived with embedded recognition for that exact frame: one enrolled face match, `name: greg`, `state: face_match`. The saved greeting model input contains both the image and that metadata. The old status description is under `recordedSituation`, dated `17:15:29.304Z`. The output was “Morning, Greg. I see you at the keyboard, already deep in the machinery. I’m awake—and I’ll try not to supervise too loudly.” Feed, buffer, memory and TTS nodes completed; Queue returned to zero tasks and executions. This verifies the repaired live data handoff and a successful greeting, not universal future recognition accuracy.

### 2026-10-26 — Additional named-person enrollment

The Owner supplied five photos and an enrollment name, then authorized preparing upload copies. Four distinct photos were resized/compressed without changing the originals; the duplicate full-frame/cropped pair contributed one sample. All four prepared images contained exactly one face detectable by the configured YuNet model and were accepted through the running Body Control enrollment API. Live status and the existing private gallery both confirm four samples for the additional person. The prior enrollment and recognition model are unchanged. Temporary upload copies were deleted; the existing owner retains names and face features, not the uploaded photos. No code, prompt, model assignment or service restart was needed. Enrollment is active on this local Body Control installation; live camera recognition of the added person remains untested.

### 2026-10-26 — Spoken visual question failed before Persona

The Owner’s “Who do you see?” was transcribed unchanged at `18:46:55.299Z`, utterance `audio:ainekio-p4-e6ebe5:2:154`. Environment Mode execution `e876d085-d5c2-487e-aa16-cc23f5c87b0b` selected vision after a 2.95-second Intent call. The camera result endpoint rejected the reply with “Camera read result does not match a Coordinator request”; the Bridge then disconnected, and the pending read failed as `bridge_disconnected` at `18:46:59.208Z`. Persona was never called. Later speech belonged to a Fast Body Event, not an answer to this question.

The running application started at 11:22 PDT while Site build artifacts had since been replaced (latest completed build 11:47). Logs also show missing old hashed `display-feedback` modules, which prevented error feedback. The application was restarted through its existing launcher at 11:51 after confirming no active Queue work; no work was cancelled and no production source was changed. A direct cached-image read through the same Coordinator/Bridge path then completed successfully (`task-1793040717775-1388141b`); Queue returned to zero, the local bridge was connected, and runtime validation matched current source with 45 workflows. Training was not interrupted. This establishes operational recovery and a successful camera handoff; the exact rejected reply payload was not retained, so a specific request-ID defect beyond the mixed-build evidence is not proven. A fresh end-to-end spoken retry remains to be checked.

### 2026-10-26 — Cached vision discarded frame-bound identity after live expiry

Repeated “Who do you see right now?” requests completed but omitted known names. The 11:55 reply came from execution `8306535c-2784-4b38-b086-9a027fedabdf`: its selected image was frame 409 without recognition; Persona separately received an April match for frame 414, correctly labeled `different_frame`. The 11:58 reply (`86b808b6-e23e-4bb9-93d2-f87c55f84f45`) received frame 520 without recognition while later telemetry matched Greg on frame 525. These results do not establish identity for the earlier images.

The existing cached-reader callback used `CameraFramePlugin.current_analysis`, whose configured one-second live freshness window hides older analyses. The stream was producing roughly 0.7 analyzed frames per second; frame 520 was about 1.33 seconds old when read began. The adapter therefore returned the raw JPEG without its already-computed metadata. This was separate from the requested-still dependency fixed earlier.

Repair: the same camera owner exposes its retained image/result pair through `latest_analysis`; the adapter uses that view. Existing `current_analysis` delegates to it and retains live freshness semantics for dashboard/status. One retained pair, its original timestamp, selected body/epoch ownership and disabled/error behavior remain. No capture, inference wait, model call, new store, retry, prompt edit or freshness-setting change was introduced. The existing owner documentation and wiring were updated.

The new real-worker/adapter regression failed on the original behavior with missing recognition and passes after repair. It covers repeated reads after expiry, an in-progress newer frame, image/result identity, original timestamps, disabled recognition, reconnect and absence of extra inference. All 82 camera/adapter tests pass. Source diff checks pass. Body Control was restarted into the repaired Python source. A separate Site rebuild at 12:01 had again left an older application running and Queue returned a coordinator-ownership error; with no running/waiting durable work, MetaHuman was also activated through its existing launcher. Training was left running.

Live read `task-1793041546127-9fcfac7b` completed with JPEG frame 770 and its own recognition record, both timestamped `2026-10-26T19:05:44.695328+00:00`; the image was 1,481 ms old at completion. The recognition metadata contained the saved Greg label. This proves the formerly failing aged-image handoff now retains its metadata. It does not prove future face-match accuracy or the final model’s interpretation. A subsequent spoken retry, execution `32efc16b-0fbc-42b9-a71a-f42ad7b59dbd`, completed and replied: “I see you leaning toward the camera, Greg—at least, that’s who the face match suggests.” Its selected frame retained the matching recognition metadata in the saved model input. This establishes a successful post-repair conversational use of the provided match; a new April-specific live trial has not been observed. Queue subsequently returned to zero active work. Rebuilding the shared Site output underneath a live server remains a separate deployment-lifecycle issue.

### 2026-10-26 — Full Auto observation and successful vision latency

Read-only production diagnosis after the Owner enabled Full Auto at approximately 12:14 PDT. Four Active Operator assessments ran between `19:14:07Z` and `19:14:48Z`. The first (`a030e903-cee2-4dfa-9ec9-f8311cbfca85`) selected Robot Status to replace a two-person description with the current one-person view. That child (`933e7f13-d3ce-4445-b57e-fe40f8236ec4`) completed. The remaining assessments selected no operations; no new Environment execution, movement or conversation was admitted by this Full Auto episode. The four controller model calls took 7.578, 7.240, 5.336 and 5.137 seconds; the status model took 5.050 seconds. At `19:17:59Z`, Full Auto remained armed, Queue was empty, and its existing runtime was awaiting model-selected evidence changes with no timed reassessment selected.

The last model decision cites no new objective and an unresolved rear-right carrier concern. Supplied inner-dialogue context includes earlier autonomy intentions from `16:58:33Z` and `17:15:21Z` that repeat the concern and direct the selected operation not to move. These are dated model-authored historical entries, not a newly observed joint failure. Current `output_fault: 0` does not establish that the earlier problem is resolved. This is evidence of historical concern influencing current model decisions; whether that concern still reflects a physical defect remains unverified. No code, prompts, settings or services were changed for this observation.

The earlier successful visual question at `19:10:13.305Z`, execution `597783c4-d2f3-496e-bb89-e817aa4fd432`, reached first speech acceptance at Body Control at `19:10:36.010731Z`: 22.706 seconds from workflow admission, excluding recording/transcription. Intent took 4.106 seconds, the vision/task model 6.938 seconds, and the Persona work item 4.412 seconds. Cached image retrieval itself took 79 ms. The remaining approximately 7.17 seconds span admission, inter-stage handoffs, response publication, first speech synthesis and delivery; this aggregate is not all queue waiting. The other visual question at `19:09:23.885Z` reached first speech acceptance at `19:09:41.419671Z` (17.535 seconds), with 2.998-second Intent, 5.019-second vision/task, 3.877-second Persona work and 101-ms image retrieval. First speech acceptance is not a microphone-to-audibility measurement. These runs establish repeated model calls and remaining handoff/audio overhead as latency targets; they do not justify another camera capture wait or retention cleanup.

Follow-up root-cause trace: the saved Full Auto system message already explicitly permits originating intentions without a user request. Persona, 13 available operations, 12 memories and a current image were supplied; active Desire entries were empty. This was Big Brother routing, not a local Task adapter failure. The last assessment received 74,030 characters of text context with 16 mentions of the rear-right concern across retained activation decisions, recorded activities, dated narrative/status and memory. The task-catalog owner presents the prior per-operation assessment; the parser preserves omitted operations' prior levels and reasons. The controller's own previous no-operation decision also enters the next assessment. These paths repeatedly present related historical conclusions; the count does not establish independent hardware faults or prove the isolated causal weight of repetition without a controlled replay.

The original concern was real recorded telemetry: Other Body Events execution `6bea8427-cee4-49e8-a27d-9bce9c4a07c2`, `16:53:22Z`, carried `servo_feedback_fault` for joint 4/rear-right carrier, 244 mV, `below_calibration_mask: 16`, `usable: false`. It explicitly retained `motion_policy: continue_authored_motion` and did not release outputs. However, the later Full Auto model input itself contained fresh `19:14:41Z` feedback with `usable: true`, all unavailable/clipped/below/above masks zero, and that joint at 639 mV. This establishes that the old reported condition was not present in that newer sample, not permanent physical fitness. The model nevertheless repeated that the concern remained unresolved and selected no operation.

The sustained-idle mechanism is confirmed at the existing Active Operator owner: the model returned empty updates, `reconsider.now: false`, `reconsider.at: null`, and event selections limited to input/results/desires plus operating-state/body-event/scene changes. `brain/agents/active-operator/index.ts` therefore admits no new assessment while those selected facts stay unchanged. New measurement samples and elapsed quiet time alone do not wake this policy. Thus the current Full contract permits an external-event-only waiting state, even though the Owner expects self-directed activity. No queue receipt was preventing admission. Appropriate next work is to consolidate historical evidence at the context/catalog owners, preserve its identity and source time alongside current measurements, and evaluate the same autonomous decision without changing instructions; any revised Full idle/reconsideration behavior or wording needs its specific contract approval. At `19:21:52Z` the UI was Reactive; this diagnostic did not change modes or dispatch work.

### 2026-10-26 — Full Auto continuous-assessment repair and remaining model failure

The Owner approved removing Full Auto's suspension policy and replacing its model-visible scheduling clause with: “Full Auto continues assessing while enabled. Selecting no operation does not suspend future assessments. Selected operations execute independently.” Semi's configured interval and model selection choices remain unchanged. The existing Active Operator now admits the next assessment after the current assessment settles. Removed its wake-fact comparisons, admission-history query, result-cursor reader/migration and obsolete subscription state. No second scheduler, retry mechanism, delay or new persistent store was added. Current operation settings are separated from dated operation decisions/activity; selected inner dialogue retains execution, cycle, operation, source-observation and delivery identities. No selected evidence is truncated or dropped.

Regression evidence: the originating admission test failed before repair and passes after it, including empty/failed/cancelled outcomes, independent work, repeat notifications, restart, disconnect/reconnect, Reactive and Semi intervals. The attribution/context test also failed before repair and passes after it. The seven focused suites report 135 passes and the same two pre-existing Boredom assertions as the initial baseline (obsolete robotCommand absence and maxTokens=384 expectations). Core and Brain typechecks pass.

Offline replay of the exact recorded Full assessment used the configured Big Brother role with the recorded reasoning input and no dispatch. Original input: 2/2 no-action decisions repeating the old joint concern. Repaired context with unchanged original instructions/schema: 2/2 the same error. Repaired context plus the approved continuous-assessment contract: 3/3 no-action decisions repeating that concern. Thus the suspension defect is repaired, but useful autonomous activity and the model's historical-versus-current feedback interpretation are **not qualified**. Continuous reassessment does not itself prove meaningful behavior.

During this repair another task updated the companion/architecture documents to require activity on every Full assessment and continued nonphysical work without a body connection. Those additional behavior changes differ from this thread's approved allowance for no-action decisions and are not silently applied here. The Owner confirmed this repair should finish its approved scope, leaving those broader changes to the other task. MetaHuman and Event Bus also stopped externally during validation; Body Control and Freestyle processes remained running. Validation and activation completed: the consumer suites passed 26/27; the remaining goal-continuation assertion expects waiting but receives idle, reproduced with the original test copied from the pre-repair snapshot. Together the focused and consumer suites passed 161/164, with three confirmed pre-existing test failures. Architecture checking also reports five pre-existing violations: missing agent core/cli/index surfaces for Active Operator and the two Environment Training agents, plus deep Core imports in two unrelated tests. No baseline or assertion was weakened. Site build passed and its compiled validator confirms source parity and all 45 workflows.

With explicit authorization, Event Bus and MetaHuman were started through their existing launchers, and Active Operator was restarted through Agent Control. The active worker runs the compiled artifact. At 12:42 PDT the authenticated status reports Reactive/dormant and zero Queue work; the user's mode and model assignments remain unchanged. Body Control and Freestyle processes were not restarted and no physical action was dispatched. Full assessment continuation is proven by the owner lifecycle regression; a live Full Auto behavioral trial remains unperformed.

### 2026-10-26 — Startup model ownership diverges from Status assignments

Read-only source/runtime diagnosis after the Owner's 12:44 PDT restart. The Status widget writes profile defaults and cognitive-mode role mappings through Model Registry. All active conversation/decision roles remain Big Brother. However, `bin/start-services` independently starts `bin/llama-cpp-services start`, `mh backend start`, and the local model service. The Python service launcher enumerates all installed units with this repository's WorkingDirectory and its serve command; it never reads role assignments and does not restrict enumeration to enabled units. It started the unassigned Qwen 9B and 0.8B listeners and attempted the obsolete Speck test service, which exited 127. Qwen 9B was stopped by another control action ten seconds later. Native listener logs show on-demand router startup, not a completed model-weight load; the 0.8B model explicitly reported unloaded at inspection.

There is also duplicate embedding startup ownership: local-model-service preloads its backend-configured embedding model, then Maintenance Service calls Core preloadEmbeddingModel, which uses the same separate backend configuration and submits both a load request and a dummy embedding. These startup calls do not resolve the widget's profile role. The currently preloaded CPU embedding model happens to match the saved Embedder assignment. Existing launcher coverage explicitly expects all discovered installation services to be started; it does not exercise Status assignment through startup. The defect is disconnected startup/residency ownership, not evidence that conversation calls ignored Big Brother.

At inspection, substantial GPU users were the independently managed Freestyle server, Freestyle training job, Body Control depth worker, Kokoro and Blender. None were stopped. No production code, assignments or lifecycle configuration was changed during this diagnostic. Corrective scope belongs to the existing startup/provider owners and duplicate embedding warmup; it must preserve actual selected-provider availability without adding a new model manager or silent fallback.


Repair for the startup ownership defect: startup now asks Core's backend owner to resolve the active profile/mode's Status assignments. The existing systemd launcher starts only matching model aliases and endpoints. Status assignment and cognitive-mode changes reuse that owner. Removed the blanket startup, both embedding preloads and their settings/export, the separate local-service selection controls, and backend substitutions in Model Resolver, registry inventory and provider transport. The explicit generic local deployment slot and explicit service administration remain; they do not override concrete role assignments. vLLM profile adapter startup preparation is shared by CLI and provider callers. No model-visible instructions, role assignments, queues, background managers or warmup inference were added.

Validation: 65 model/routing tests plus the model-default contract script, 16 launcher tests, Core and CLI typechecks, local-model-service build and Site build passed. Tests cover cloud-only repeated startup, unassigned inventory/other modes, disabled roles, selected endpoint/model/adapters, role and mode changes, startup failures, and no embedding/generator load attempts across service restarts. The original launcher regression failed against blanket startup. The compiled runtime validates 45 workflows. Architecture check reports nine unrelated existing/concurrent agent-layout and deep-import violations; its baseline was not changed. The live selected-service startup left all unassigned MetaHuman llama.cpp listeners stopped with the saved Big Brother assignments. Activated at 13:13 PDT through the normal start.sh background-service path. Site returned HTTP 200; the launcher reported Status-selected startup for Ainekio; systemd reported zero running MetaHuman llama.cpp units; local-model-service health showed both embedder and generator unloaded. Freestyle, Body Control and independently running training processes were not changed. No inference or physical command was needed for this startup qualification.


## 2026-10-27 — Motion retirement and deployment mismatch

Owner request: remove obsolete MetaHuman motion-generation paths and retired Freestyle `reassess`; retain Body Control's manual library for demos. Approved deletion-only Task prompt changes remove the generic named-command example and old continuous-command directions. No new behavior instructions were added.

Root evidence: Body Control restarted with the executor that no longer implements `reassess`, but the independently running Freestyle API still loaded `artifacts/recovery-completion/final/dataset`, whose tools include that operation. The API process began October 26 at 16:12; Body Control restarted October 27 at 09:50. Startup job `c544798c55d64ae0b2f9ae982a7476d0` failed with `Unknown program operation reassess`. This is incomplete serving-contract retirement, not proof the new executor re-entered the model. The earlier unresponsive “Please stretch” turn failed before motion dispatch because Intent could not allocate its CUDA buffer; the explicitly requested test-server shutdown was completed separately.

MetaHuman repair: deleted the obsolete eight-joint decoder/types, command admission/serialization, commanded-pose bookkeeping, and generation-specific outgoing diagnostics; removed the obsolete joint-generation training bank, export, review/API/UI branches and public exports. Intent/Task training remains. Updated Task graph prompts and public mirror using the approved deletions. Robot Status now records `requestMotion` as a body action and retains its movement description. Updated affected fixtures and registered motion-request tests in the maintained Environment graph test command. Manual Body Control library and the independent Freestyle executor/model are not removed. Generic adapter command support still has explicit consumers; it is not advertised by the live Freestyle robot.

Checks: the pre-repair store admitted a full eight-joint `robotMotionPlan` in an isolated dry replay; the repaired owner rejects that retired action through its existing action-type contract. 29 focused movement/context/training tests and two focused Robot Status tests pass. Core, Brain and scripts typechecks, Site build, all 45 graph validators and diff whitespace checks pass. Compatibility exercised the new motion admission/dispatch/completion and queue retirement, then failed later at the separate receipt-replay resume-count assertion (0 versus 1). Replaying the same suite with the pre-repair store restored through an isolated module loader reproduces that exact failure at the same assertion; it is not introduced by this removal and remains unresolved. Broader graph/status checks retain stale token-count/model-role expectations; no unrelated assertions were changed to hide those failures.

Initial activation was deferred because another task was changing Freestyle bridge/service configuration. The owner then explicitly directed correction of live Freestyle. At 11:01 PDT, restored production model/API services on 8795/8794, stopped the test listener on 8796, and corrected both the source and installed API unit to use `artifacts/finite-programs/contract`. This retains the deployed raw-tool model and its tool order, deleting the retired operation. The proposed compact `training-data` pairing was not deployed: the exact recorded startup replay with the old model returned stop/release/hold instead of stretch. Live health now matches contract SHA `d6d81f1de1c4bc877973e7754252da1d1ecfc90572ac6f48c97bb51a80d7cec3`, tools SHA `b546272ecf7d7f04a772e539b3226cd59c071a441386c155d8120ae87422cda1`, and unchanged model SHA `a8a9b7e2da6f40f1597e43ac7af46e82a779a5973bd5bf679248c7b75bf94943`. Live hand-raise/wave/stretch generation replays completed in 0.586/1.669/3.618 seconds and compiled without retired operations. Forty-eight generator/executor tests passed. No physical commands were sent and Body Control was not restarted. A separate recorded wake request still produced an oversized program and was manually cancelled; full wake-input quality and standing endings remain unqualified model work. Historical training artifacts preserve their evidence but are not the current serving contract. This activation does not retrain the existing weights.


## 2026-10-27 — Conversation timezone correction

The 15:14 PDT time question received `currentTime: 2026-10-27T22:14:25.377Z` without a local timezone, and Persona answered 22:14 as local time. Environment's existing selector-envelope owner now supplies `localTime` and `timeZone` from the runtime's configured timezone alongside the unchanged UTC instant, using the same representation already supplied by Active Operator. No prompt wording, clock service, model settings, or timestamp storage changed.

The new regression tests failed before the repair and pass afterward through the actual Task/Conversation context builder. All 32 context/source-routing tests pass, including the exact incident time, summer/winter offsets, local date boundaries, half-hour timezone, UTC, and task-to-conversation preservation. Core typecheck and Site build pass. The separate request-routing suite has 34 failures with both the original and corrected helper, primarily missing `needsGoalReview` in existing fixtures; no unrelated assertions were changed.

Activated through `start.sh --restart-app` at 15:23 PDT. Another task selected a newer build during activation; the actual running release was verified to contain the correction and match current Core, with all 45 workflows validated and HTTP 200. Model servers and Body Control were not restarted; no physical commands were sent. A fresh spoken model answer has not yet been evaluated.


## 2026-10-27 — Ainekio name transcription

The speech recognizer received no name vocabulary even though the active persona defines Ainekio. The existing Core STT request now resolves that configured identity per request and carries its name through WhisperService to faster-whisper’s native hotwords parameter. Authenticated profile context takes precedence over the active background profile; no identity means no invented hint. Both server and explicitly selected CLI transports carry the name as data, without transcript replacements, additional inference, or changed model/device settings.

Regression: the two name-delivery/profile tests fail against the previous STT owner and pass after repair. The maintained voice-owner command now runs those tests plus the Python recognizer-handoff test; existing lifecycle/config tests, Core typecheck, Site build, and all 45 compiled workflow checks pass. On the saved 1.16-second microphone clip from the Owner’s repeated-name test, unchanged base.en returned “next year.” without the hint and “Ainekio” with it. The repaired authenticated /api/stt path returned “Ainekio” in 0.634 seconds. Synthetic control speech retained “and next year we will visit again” and “Please raise your right hand”; a non-speech microphone clip remained empty. The earlier “How are you today?” recording did not establish name accuracy because both variants omitted the name.

Activated Whisper through the existing voice-service owner, MetaHuman through application-only restart, and Environment Bridge through Agent Control. The new bridge executable is connected to local Body Control. No robot action was dispatched by the replay tests, and body/LLM/TTS services were not restarted. One recorded-name correction establishes improvement for that sample, not universal recognition accuracy.
