# Autonomy continuity: review and integration plan

Date: 2026-10-25. Status: implemented, tested and activated at approximately
20:05 PDT; physical and sustained-autonomy qualification remain open.

## Approved implementation contract

The owner requested implementation by repair agents and approved the following
Full Auto contract and wording, including the additional ports and readers below.
Semi keeps its current update schema and activation threshold.

Full retains `updates`. Each update also has `target`, which is null for a new
operation, `{kind: "execution", executionId}` for an existing execution, or
`{kind: "desire", desireId, operation}` for an existing desire. Desire operations
are the existing `plan`, `execute`, `review` and `checkin`. Execution continuations
use the existing durable event owner and preserve autonomous authorship. The
execution owner receives the instruction; Desire targets select its existing lifecycle
operation, while instruction and reason remain controller evidence. Dispatch does
not mark an objective done.

Full also returns `memoryRequest` (null, or the existing memory selection fields)
and `reconsider: {on, at, now}`. Selected memory is retrieved for the next assessment;
null selects no additional memory lookup. `on` selects human input, work results,
changed environment evidence and/or changed desires. `at` is an optional
model-selected ISO time; `now` requests an immediate assessment. These are handled
by the existing Active Operator service and its notification/timer lifecycle.
Queue bookkeeping alone is not new evidence. A fully quiet selection remains
quiet until operator reactivation/reconfiguration. Entering Full starts assessment;
independent work, speech and human requests remain available throughout.

Exact text to append to the editable Full controller instructions:

> In Full Auto, an update may identify a target. target is null for a new operation, {kind: "execution", executionId} to send the instruction to that recorded execution, or {kind: "desire", desireId, operation} to request plan, execute, review or checkin through the Desire owner. Use recorded identifiers. Execution targets receive the instruction through their existing owner. Desire targets request the selected lifecycle operation on the recorded desire; instruction and reason remain the controller's decision evidence. Requesting work does not establish completion. Return memoryRequest as null or a selection using memoryQuery, memoryOrder, memoryTypes, memoryTimeRange and memorySleepCycle for the next assessment's memory lookup. null selects no additional memory lookup. Return reconsider with on, at and now. on selects changes that should prompt another assessment: input for new human input, result for returned work outcomes, environment for changed robot observations, and motivation for changed desires. at is an optional ISO 8601 time for reassessment. now requests another assessment immediately. An empty on list with at null and now false selects no further assessment until the operator reactivates or reconfigures the system. These selections govern assessment only; other admitted work remains independent.

Approved ports use these exact descriptions:

- `activeExecutions`: “Current executions with their recorded objective, state and input capability.”
- `memoryHints`: “Memory selection recorded by the previous assessment.”
- `selectedMemoryContext`: “Selected memories retrieved for this assessment.”
- `fullInstruction`: “Graph-owned instructions for this one LLM task”

The separately approved clarification is: “Execution targets use
robot-autonomy-executor; Desire targets use desire-agent.” The Full instructions
are visible in a separate existing Text Input node and selected only in Full;
Semi retains its existing instruction text.

The existing `readActivationAssessments` reader becomes a public Core export
so Brain reads the persisted selection rather than creating another state owner.
Existing execution-event delivery accepts the recorded autonomous source and
routes continuation through the selected execution's Environment graph, preserving
its original request and compatibility rules. Neither change creates a new executor.

## Integration evidence and remaining qualification

The repair uses the existing controller, admission service, Execution Store,
Environment event owner, Memory Router and specialist evidence reader. It removes
the semantic handoff truncation and queue-only activity reconstruction; it does
not install another agent loop, scheduler, history store or model fallback.

Current source checks establish complete instruction and memory attribution across
the planner/dispatch/input boundary, retained task identity after queue receipt
eviction and database reopen, autonomous continuation without changing the original
objective, and separation of command receipts from visual goal success. The service
tests cover independent work, evidence arriving during assessment, quiet selection,
model-selected immediate/timed reassessment and consumed-request recovery after
an admitted graph fails. If work fails before any graph admission, the service
does not retry on queue churn; after a service restart there is no saved graph
attempt to recover, so an initial assessment may be attempted again.

At representative retained volume, the direct latest-result reader decoded one
payload from 5,002 events. Incremental result lookup decoded no result payloads
from 4,005 events. Wake classification against 5,000 stored effects and a new
2 MB result decoded one correlated dispatch, rather than historical effects or
image data. These are isolated local measurements, not robot response benchmarks.

Integration review found and repaired another performance boundary: a catalog with
5,000 recent no-work controller assessments still scanned 5,002 admitted inputs
to recover earlier selected activity, taking about 419 ms in the fully settled
fixture. The approved outbox-provenance index reduced the same catalog read to about
6 ms and two decoded admissions while retaining the older selected activity.
The final Store/history suite passes 61 tests, including encrypted-codec backfill,
failed-migration rollback, concurrent reopeners and queue receipt eviction.

Core and Brain typechecking pass. All 45 workflow definitions validate. Site checking
reports no errors or warnings across 370 files. The architecture checker reports five existing violations:
three agent-directory entrypoint contracts and two Brain test imports of Core
source. Those structures/imports already exist in the committed baseline; this
repair neither updates the guardrail baseline nor conceals their failure.

Six synthetic replays through the actual graph-configured context/model nodes and
production parser completed on Big Brother / Codex `gpt-6-sol`. The first five
returned the correct existing execution/desire identities, preserved incomplete
visual outcomes, requested relevant older memory and respected explicit quiet.
Their model-call times were 3.12–8.03 seconds (median 5.10 seconds). The memory case
selected a broader interval than “last week”; temporal precision remains
unqualified. A sixth case with companion identity and standing aims, but no human
request or existing objective, originated an observation to establish the current
surroundings in 4.60 seconds. This demonstrates one self-directed selection, not
sustained autonomous usefulness. These are component replays, not an accuracy or
latency benchmark; the actual selected body was disconnected and no live admission
or physical output was exercised.

The owner also approved removal of the unused `graph.signal` handler and queue
special cases. Its old inline-controller test cases are replaced by checks of the
explicit controller-to-execution handoff; user steering and actual result delivery
retain their existing owners. The four real controller/Goal Review continuation
checks pass after the approved Robot Status repair: unresolved `idle` goals remain
visible, with a persistence regression shown failing before and passing after.
Authentication, recovery and cancellation checks pass 31/31.

Broader fixture checks still contain pre-existing expectation mismatches: a
Robot Status assertion expects Persona where the saved Goal Review graph selects
Psychotherapist; earlier Robot Operator/context checks expect retired motion
capabilities, a removed step-count phrase, and a capped output setting. Those
assertions were not weakened, and the complete repository test suite is not
reported as passing.

The final Site build and compiled-runtime validation pass for all 45 workflows.
The owner authorized activation through the application-only launcher restart and
the existing Active Operator service lifecycle. Both processes were replaced;
the application returned HTTP 200 and the new Active Operator reported Semi mode,
dormant because the selected body was disconnected. All four llama.cpp process
identities and the model, service and Active Operator configuration hashes were
unchanged across activation. Build warnings concern existing circular/chunk imports;
they did not prevent compilation or runtime validation.

No physical action, new training fit, model assignment change or publication was
performed. The disconnected body prevented a live embodied autonomy cycle. Source,
simulated-work and component replay success do not establish sustained useful
companion behavior or general model accuracy.

## Live qualification and corrective repair — 2026-10-26

The owner's connected-body Full Auto test completed 30 assessments between
16:07:18Z and 16:11:06Z, selecting no activities. The first returned zero updates
for two operations; the remaining 29 returned empty updates. Median complete
assessment duration was 7.07 seconds. The queue drained normally, and switching
back to Reactive left no queued work. This is a failed initiative qualification,
not successful autonomy inferred from valid output or a running service.

The model received the approved Full instructions, current decision time, persona,
four standing goals, 12 attributed memories, 13 available operations and an image.
There were no active desires. Its first explanation treated an old statement about
working on the robot as current and cited manual takeover. Robot Status inferred
that takeover from the last body command's source; the gateway retained that source
after completion. The approved status repair replaces the inference with
`control.lastBodyCommandSource`, preserving actual current work, sequence and lease.

Four same-input replays, preserving full history, images, prompts, schema and
settings, selected no work both before and after that factual correction. A separate
existing-checkbox comparison requested high reasoning: the first corrected case
selected Desire review, while the later case still selected no work. Actual provider
records confirmed `gpt-6-sol` with effort `high`, compared with `none` in the original
run. Neither comparison dispatched actions or saved conversational training data.
These selected failures are diagnostic evidence, not a general accuracy benchmark.

The wake reader also mixed actual measurements with uptime, heap and processing
counts. Its repair preserves complete observations while comparing measurements
without that bookkeeping. The owner approved explicit Full environmental wake
selections: `state`, `bodyEvent`, `scene`, and `samples`. Per-sample sensing and live
goal execution remain independent. Real identity estimates and availability can
still change often; this repair does not introduce a settling threshold or timer.

Provider inspection confirmed that ordinary graph inference was flattened into
one Codex user message and inherited coding, repository, memory and skills context.
The owner approved native message transport through the existing terminal provider,
with graph system instructions and selected messages preserved, and those unrelated
automatic additions omitted. Diagnostic/tool sessions retain their separate existing
behavior. The owner also specified high reasoning for Full decision-making and no
reasoning for ordinary execution calls; matching graph wiring is approved.

Native provider qualification preserved the complete saved input, original image
and frozen schema in two actual Codex calls. The first selected Robot Status
(14.60 seconds); the later case selected no work (7.02 seconds). The matched old
high-reasoning run also selected work in one of two cases, selecting Desire review
in the first case. This proves context isolation and output preservation, not an
improved activity-selection rate. Provider rollout evidence shows the exact graph
system instructions plus the existing JSON response contract, complete user text
and original image; coding, repository, personal memory and skill instructions are
absent. Native permission, environment and team-mode metadata remain.

Review additionally reproduced a missed-event window: ordinary telemetry could
replace a body event or an offline/online transition before the next wake read.
The approved Bridge session extension retains the latest attributed event identity
and connection revision independently of current observations. Repeated heartbeat
updates do not advance these revisions. A short transport interruption that never
produces a disconnected observation or stale session remains outside this evidence;
discovery diagnostics are not relabeled as body-state observations.

The application, Active Operator and on-demand Terminal owner were activated on
October 26; model and voice processes retained their existing identities. Live
provider records verify seven completed Full assessments with `gpt-6-sol/high`
and the selected Robot Status call with `gpt-6-sol/none`. No Task or Conversation
call occurred in that observation window; their live performance is not claimed.

The first live qualification ran Full from 16:58:18Z until 17:01:23Z. Nineteen
completed assessments selected one Robot Status update, then zero updates or empty
lists. The status workflow completed and the controller correctly recognized its
result without requesting another status update. The sampled queue contained at
most two items and subsequently drained. The previous Semi setting was restored
after the test. This is working handoff and reasoning selection, but it still fails
the broader companion-initiative qualification: no new conversational, physical
or nonphysical pursuit followed that status update.

Saved context confirms complete persona, four standing goals, twelve attributed
memories, thirteen available operations and current image evidence. The model
cited an unresolved joint warning and absence of a physical/sensing objective.
That does not demonstrate a code prohibition; nonphysical initiative remains
unqualified. Meaningful-result identity advanced only for the status result;
capture bookkeeping was filtered correctly. Repeated wake states instead followed
camera/position measurement freshness and unstable person-presence detection.
The freshness projection now classifies measurement validity as `samples`,
preserving actual hardware readiness as `state`; all evidence remains available. Scene estimates still represent detector claims, not verified identity.

Software evidence before that final freshness correction: the provider owner passed
19 tests, Terminal 34, Model Router 5, Robot Status live 21, activation/workflow 35,
wake 10 and stream freshness 3. Core/Brain/Site checks, all 45 graphs, production
build and compiled-runtime validation passed. The existing five architecture
violations remain, and the compatibility replay assertion at line 961 failed
identically with the pre-repair Bridge writer. These failures were not hidden or
changed into passing assertions.

Final qualification added a failing-before/passing-after measurement-validity test
(11 wake tests pass). The Bridge writer also reproduced an actual partial-file
read returning an empty disconnected default. It now writes the complete snapshot
to a unique same-directory temporary file and atomically renames it at the existing
publication boundary. Repeated cross-process reads and interrupted writes preserve
the committed connection and retained event revisions; all five stream/publication
tests pass. The reader's pre-existing failure behavior is unchanged. The test is
registered in the maintained durable-execution command.

The final build, Core typecheck and compiled-runtime validation passed; all 45
workflows remain valid. The final live check at 17:15–17:16Z completed seven Full
assessments, selecting one status update after a person appeared in the camera
view. The model retained uncertainty about recognition identity and the joint
warning. Across subsequent admissions, the operating-state hash stayed unchanged;
scene estimates changed, and the meaningful-result revision advanced once for the
status result. Those remaining subscribed scene changes continued to request
assessments. The queue reached zero, and Semi was restored after the test. No
self-directed conversation or motion was selected. Thus provider isolation,
reasoning, publication and wake classification are activated and qualified at
their tested boundaries; sustained companion initiative remains unresolved.

## Outcome and scope

MetaHuman already has most of the necessary components. The principal gap is
continuity between them: Full Auto selects operations, while persistent motivation,
plans, execution evidence and learning live behind different interfaces. Calling
more functions does not, by itself, preserve what the companion is trying to
accomplish or what it learned from the last attempt.

This review covers Active Operator admission and decisions, the autonomy-to-Environment
handoff, contextual memory, Agency integration, outcome feedback and the existing
learning paths. It is not a repository-wide audit, a replacement queue design, or
an assessment of physical motion quality. Source was inspected in the current
shared, modified checkout. Earlier observations from this session are identified
separately from source findings; they are not a benchmark of the latest build.

Authority remains with [AGENTS.md](../../AGENTS.md),
[Maintained Surface](../technical/MAINTAINED_SURFACE.md),
[Refactor Blueprint](../technical/REFACTOR_BLUEPRINT.md),
[Node and Workflow Design](../technical/NODE_WORKFLOW_DESIGN.md), and the
[Robot Bible](../robot/ROBOT_BIBLE.md). The implementation contract above records
the owner's subsequent approvals; the findings below retain the inspected
baseline. This report does not authorize unrelated changes or physical actions.

## What already exists and should survive

| Responsibility | Existing owner | Assessment |
| --- | --- | --- |
| Companion identity, enduring aims | Persona; Psychotherapist for autonomous updates | Keep. An aspiration is not an executable command. |
| Specific motivations | `packages/core/src/agency`, public Desire Agent | Keep. Desires already have identity, evidence, relevance, lifecycle and outcome history. |
| Reviewed plans | Agency plan policy and planner/executor graphs | Keep. Plan identity/version, completion criteria and linked execution already exist. |
| Reactive/Semi/Full admission | Mode Controller and `brain/agents/active-operator` | Keep ownership; revise Full continuity within these owners. |
| Choice of autonomous activity | Existing controller graph and Autonomy model category | Extend its decision contract, rather than adding another autonomous agent loop. |
| Routing and concrete task selection | Orchestrator, Task Decisions, Planner categories and Environment graph | Keep distinct responsibilities and widget-owned assignments. |
| Work and results | Work Coordinator and durable Execution Store | Keep. Queue payloads are delivery state, not long-term experience storage. |
| Recall and experience | Buffer, memory storage/index and Memory Router | Reuse. Recent context, retrieved experience and current sensor evidence have different meanings. |
| Learning | Curator, personalization pipeline, Environment specialist trainer and model-registry activation | Reuse. Saved outputs are candidates, not automatically correct training targets. |

The current source includes a separate Autonomy category. The integration should
use the shared executable category catalog, not older descriptions that assign
all higher reasoning to Orchestrator or assume a particular model is active.

## Findings by owner

### A. Full Auto represents function selection, not persistent pursuit

- **Owner:** [activation.ts](../../packages/core/src/active-operator/activation.ts),
  [controller parser](../../packages/core/src/nodes/robot-operator/autonomy-controller-parser.node.ts),
  [dispatch](../../packages/core/src/nodes/robot-operator/activation-dispatch.node.ts).
- **Summary — confirmed design gap:** a decision contains only operation ID,
  activation, reason and instruction. Semi selects updates at 100; Full selects
  the highest positive update. Every dispatch gets a new assessment-derived cycle
  identity. There is no structured selection of an existing desire, plan version
  or execution to continue, revise or conclude.
- **Boundary issue:** Agency already owns persistent pursuits. Its awareness
  projection deliberately prevents a desire summary from becoming an unreviewed
  robot instruction. Simply feeding full desires into Task would bypass that
  ownership rather than fix continuity.
- **Technical debt:** natural-language instructions are carrying relationships
  that should reference existing records. The controller can describe continuing
  something without necessarily selecting the execution that owns it.
- **Security/privacy:** keep all references profile-scoped. Nothing here calls
  for copying private persona or memory into a new global state file.
- **Test gap:** existing graph/dispatch tests do not establish that one selected
  pursuit survives multiple autonomous assessments, revisions and restart.
- **Recommendation:** preserve Semi activation behavior; propose an explicit Full
  decision contract for continuing/revising an identified pursuit, selecting new
  finite work, or remaining inactive. Agency stays the mutation owner for desires;
  execution stays the owner for task progress. Immediate conversation or a finite
  reaction must not require creation of a desire.

### B. Intention and memory lose information at the handoff

- **Owner:** [Environment Dispatch](../../packages/core/src/nodes/robot-operator/environment-dispatch.node.ts)
  and [Robot Operator Input](../../packages/core/src/nodes/robot-operator/input.node.ts).
- **Summary — confirmed source defect:** these helpers collapse whitespace and
  truncate instructions to 1,000 characters, observation/reason to 500, and
  delegated memories to three 800-character strings. Dispatch extracts only
  `memory.content`, losing record identity, speaker, source and time. Input accepts
  only strings. The Reflection graph connects actual sampled memory records to
  this path.
- **Earliest faulty transition:** planner output and selected memory enter the
  dispatch helper; structured evidence becomes shortened un-attributed text.
  Direct Active Operator dispatch restores its complete planner decision, but
  the receiving Input node still shortens it. Fixing only one caller is insufficient.
- **Boundary issue:** the downstream context builder already preserves supplied
  memory objects. It cannot recover information removed upstream.
- **Technical debt/removal:** remove those lossy transformations from semantic
  content; keep legitimate identifier handling separate. Do not substitute larger
  arbitrary limits or a summarizing model call.
- **Security/privacy:** preserve recorded attribution, including robot-authored
  thoughts versus human statements; missing provenance must remain missing.
- **Test gap:** verify full intention and selected records through both direct
  dispatch and Reflection child execution, including long content and identical
  text from different authors.
- **Recommendation:** repair this data flow before attributing failures to model
  size or adding training examples.

### C. Durable outcomes are not the controller's durable activity view

- **Owner:** [Task Catalog](../../packages/core/src/nodes/robot-operator/task-catalog.node.ts),
  [activation history](../../packages/core/src/active-operator/activation-history.ts),
  [activity history node](../../packages/core/src/nodes/robot-operator/autonomy-activity-history.node.ts),
  and [controller graph](../../etc/cognitive-graphs/robot-autonomy-controller-mode.json).
- **Summary — confirmed source gap:** Task Catalog starts from active queue items
  plus the Coordinator's recent history and enriches only their execution IDs.
  Once that temporary receipt window evicts an activity, it no longer appears in
  this view even if canonical execution evidence remains retained. The latest
  activation assessment is durably recovered, but is not a complete outcome view.
- **Related stale path:** Recent Autonomy Activity is absent from shipped graph
  wiring and its recovery branch reads the former `decisionReceipt` parser output;
  the current parser outputs `assessment`. Connecting that node unchanged would
  not restore current controller decisions correctly. Its outcome-projection
  helper is still used, so deleting the entire module is not justified.
- **Additional context gap:** Current Execution is wired to the controller's
  own execution context. Its separate `activeExecutions` output is not connected
  there. Other work is represented indirectly by status and catalog activity.
- **Technical debt/removal:** consolidate current activity projection at the
  existing read owner. Remove the superseded recovery/graph surface only after
  checking registrations, editable graphs and retained execution contracts.
- **Security/privacy:** query only the selected profile and retain source/action
  identities. Do not keep queue payload copies indefinitely to serve this reader.
- **Test gap:** settle work, release queue copies, fill the recent-history window
  with unrelated work, restart, and verify the same pursuit and supported outcome
  remain readable. Exercise realistic retained history volumes and measure the
  actual read path; an all-history scan is not an acceptable assumed solution.

### D. Admission and retrieval do not describe the reason to think again

- **Owner:** [Active Operator service](../../brain/agents/active-operator/index.ts),
  controller graph and its existing context builder.
- **Summary — confirmed source behavior:** Full mode can admit another assessment
  after the previous one ends; queue-directory changes wake its admission check.
  There is no recorded semantic reason distinguishing a new observation, a task
  result, a revised motivation, or completion of the assessment itself. Only one
  controller assessment is admitted at once; independent robot work can overlap.
- **Retrieval behavior:** the graph always supplies `memoryOrder: newest` and
  reads recent records. This provides continuity with recent events but does not
  request older experience relevant to a selected pursuit. Camera acquisition is
  also configured on each assessment rather than selected by its information need.
- **Interpretation:** this can spend repeated calls reassessing much the same
  situation. It does not prove that every repeated call or queue wake is wrong;
  new frames can contain new evidence. Source alone does not establish wasted
  GPU time for a particular run.
- **Recommendation:** make the reason for reconsideration and outstanding
  model-selected work explicit in existing admission/context. Let the model choose
  additional sensing, retrieval or another independent activity. Preserve the
  existing periodic Semi assessment and allow Full to initiate work on entering
  the mode. A quiet decision is valid; it must not become endless empty inference.
- **Technical debt/removal:** replace self-generated assessment churn at its
  producer after the new decision semantics are agreed. Do not add a second
  scheduler, a fixed delay, a quota, keyword deduplication or a blanket wait for
  all robot work. Any change to wake/idle behavior needs explicit approval.
- **Security/privacy/test gap:** retain current authenticated-profile ownership;
  test fresh evidence, unchanged evidence, mode entry, independent in-flight work,
  sleep, disconnection and human interruption without copying all past experience.

### E. Goal evaluation exists, but is split from next-purpose selection

- **Owner:** [Current Execution](../../packages/core/src/nodes/utility/execution-context.node.ts),
  Environment/Goal Review graphs, Agency outcome service and
  [outcome handler](../../packages/core/src/queue/desire-outcome-handler.ts).
- **Summary — existing capability with integration gap:** Environment Goal Review
  is conditional on Intent selecting `needsGoalReview`, an eligible unfinished
  non-Agency goal, and the result state. Agency has a separate outcome-review
  workflow and can return a desire to planning. That separation avoids two owners
  advancing the same Agency plan.
- **Observed earlier in this session:** selected movement intentions produced
  sensing/face actions and spoken movement claims, without a corresponding
  movement command in those executions. One visual behavior sought evidence of
  the wrong subject. These observations establish failures in those decisions,
  not the overall accuracy of a model or the robot's physical motion capability.
- **Boundary issue:** a finite program receipt, a spoken response, a completed
  graph and satisfaction of the original goal are different facts. The next Full
  assessment needs the original purpose, chosen program, actual results and
  outcome assessment attached to the same identity.
- **Recommendation:** complete that feedback connection and qualify both the
  routing decision and semantic task behavior. Do not add unconditional review
  calls to every action or let Goal Review become another autonomous planner.
- **Technical debt/removal:** remove duplicate interpretation only where a prior
  decision already owns it. A path through Controller, a Boredom planner,
  Environment Intent, Task and conversation can involve five model stages before
  optional review; not every stage runs on every path. Measure each stage before
  consolidating, and preserve workflows that have a distinct purpose.
- **Security/privacy/test gap:** preserve action and observation attribution.
  Test action acceptance without completion, completion without goal evidence,
  contradictory evidence, wrong subject, revisions and uncertain outcomes. Do
  not dispatch physical actions during initial qualification.

### F. Learning saves decisions, but autonomy continuity lacks qualification

- **Owner:** [Environment training bank](../../packages/core/src/environment-training-bank.ts),
  manual specialist curator/trainer, personalization dataset and training owners.
- **Summary — existing capability and coverage gap:** specialist candidates store
  exact Intent/Task inputs and outputs with execution/checkpoint identities. The
  evidence reader preserves action IDs, but explicitly warns that evidence from
  the same execution is not automatically attributable to one model decision.
  Its work-result projection contains state/error, not all observation content.
  This bank's specialist contract is `intent | task`; it is not a complete
  controller-to-outcome trajectory contract.
- **Recommendation:** derive ordered learning/evaluation episodes from canonical
  execution evidence, retaining the actual decision, revisions and corresponding
  observations. Reuse existing curation and dataset owners rather than starting a
  second experience recorder. Review targets semantically before fitting.
- **Technical debt/removal:** replace isolated decision-only scoring where it is
  being used to claim long-horizon autonomy success. Keep useful per-call routing
  tests as component tests. Do not label the model's own reassuring narrative as
  proof that its action succeeded.
- **Security/privacy:** preserve Environment assistant-target versus Dual human-target
  training, speaker/mode/source attribution and frozen evaluation separation.
  Private trajectories remain in canonical profile storage, not this audit.
- **Test gap:** measure continuity, actual progress, grounding, appropriate
  inactivity and repeated-question behavior across episodes. Replaying messages
  is not learning; memory updates are not weight updates; a fitted adapter is not
  qualified production behavior.

## Features to borrow from published systems

These are publicly documented patterns, not claims about undisclosed consumer-app
internals. No external framework installation is proposed.

| Source | Useful pattern | Integration here |
| --- | --- | --- |
| [Qwen-Agent](https://github.com/QwenLM/Qwen-Agent) | Tools and their returned results participate in the continuing interaction. | Preserve the ongoing intention and its actual observations through Environment execution. |
| [DeepSeek tool reasoning](https://api-docs.deepseek.com/guides/thinking_mode/) | Continuation must preserve the provider's required message/tool state. | Audit a provider's continuation contract when used; do not substitute a prose summary for required protocol fields or expose them as robot Inner Dialogue. |
| [Google ADK context](https://adk.dev/sessions/) | Session events, working state and long-term memory are distinct. | Reuse Execution Store, current context and Memory Router with explicit references between them. |
| [Anthropic long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) | Persist useful progress and results across context resets. | Restore pursuit and outcome state rather than reconstructing intent from recent chat alone. |
| [Generative Agents](https://arxiv.org/abs/2304.03442) | Experience, retrieval, reflection and planning work together. | Connect attributed reflection to later retrieval and choices. Its simulated social-agent evidence is not robot qualification. |
| [SayCan](https://say-can.github.io/) | Plans need grounding in executable skills and current circumstances. | Keep Task/Body Control capabilities and measured results attached to plans. Do not import a new action veto or scoring policy without approval. |

## Proposed integration sequence

### 1. Repair evidence and handoff first

Repair B and C in their existing owners. Preserve complete intentions and selected
records. Read retained activity from canonical execution state after Coordinator
delivery copies are released. Record the current model/provider/artifact and graph
identity for qualification; do not change assignments as part of this repair.

Acceptance: exact selected content survives both handoff paths; outcome context
survives history eviction and restart; repeated work releases temporary queue
copies; a read at realistic retained volume does not decode unrelated payloads.

### 2. Connect Full Auto to persistent purposes

Extend the existing controller contract so a decision can name the desire/plan or
execution it is working on, and distinguish continuation, revision, new finite
work and inactivity. Keep enduring persona aspirations as context. Use Agency for
persistent motivations and the existing execution owner for immediate objectives.
The controller must not mutate persona or bypass Desire's plan ownership.

Return linked results to subsequent controller decisions. Use the same references
in the existing Active Operator/Agency UI so the owner can see what the robot is
trying to achieve, why it changed its mind and what remains unresolved.

Acceptance: one purpose stays identifiable across multiple decisions and restart;
the model can revise it after contradictory evidence, conclude it with appropriate
evidence, or explicitly abandon it. New human work and independent speech/sensing
can proceed without waiting for that pursuit to finish.

### 3. Make reconsideration and recall purposeful

Implement D within existing admission and Memory Router ownership after agreeing
on exact wake/idle semantics. Supply recent events plus model-selected relevant
experience, preserving which information is historical. A desire or standing goal
is context, not automatically fresh reinforcement. Use the existing sleep,
reflection and Psychotherapist paths for slower development.

Acceptance: an older relevant experience can affect a current decision; an old
image is not treated as current; robot-authored speech is not treated as a human
request; a model-selected quiet period does not generate a self-sustaining series
of empty assessments. Independent activity and important events still progress.

### 4. Qualify the complete loop, then train the demonstrated gaps

Create a frozen episode set using existing evaluation tooling. Include continued
investigation, interruption, no-action decisions, failed/uncertain effects,
relevant recall, conversational follow-up and persistent identity. Accept equivalent
valid plans; do not prescribe a fixed activity sequence or arbitrary direction.

Measure task/goal success separately from structural validity, source grounding,
repeated ineffective selections, redundant questions, inference count, total
model time and event-to-useful-output latency. Compare configured models on the
same episodes and serving conditions before attributing failure to size.

Use corrected development trajectories to improve the responsible adapter only
after the handoffs are sound. Preserve frozen evaluation/regression separation,
complete examples, category assignments and existing promotion ownership.

Acceptance: an independently evaluated improvement across these behaviors, with
remaining failures disclosed. Source tests, model replay, live software activation
and physical robot performance are separate evidence levels.

## First milestone and decisions needed

The first complete milestone is a camera-capable companion that selects a finite
purpose, preserves it across several decisions, obtains relevant evidence, revises
its plan when warranted, and reports a supported outcome. A disassembled robot
can exercise much of this with sensing/conversation and simulated motion receipts;
physical movement remains a later, separately authorized check.

Implementation needs approval of the new Full decision/context contract and exact
model-visible wording, the wake/idle behavior, and any public contract extensions.
Existing category assignments stay under the widget's model-registry owner.
No new node type is assumed necessary. Before touching overlapping files, reconcile
their current owners and diffs. This plan adds no runtime fallbacks, token caps,
mandatory movement, fixed activity rotation, or per-action human-approval stage.

Keep the Bible as product intent, update Maintained Surface for approved owner
changes, and keep this dated review as evidence. One documentation discrepancy also
needs correction in that implementation: Architecture still describes automatic
image-to-Orchestrator substitution, while the maintained category contract does not.

## Original review evidence and limitations

Reviewed current entrypoints, graph wiring, relevant owner implementations,
contracts and focused test coverage. Primary research sources were checked on the
review date. No new model inference, training, service restart or physical command
was performed for this review. No production source, graph, model setting, persona
or runtime state was changed. This document's links and whitespace were checked;
it is not a claim that the proposed behavior already passes runtime acceptance.

## Narrow capability and output repair — 2026-10-26

The next owner-observed Full window completed five assessments from 17:19:38Z to
17:20:09Z and selected no work. It then waited on its selected wake conditions;
the owner returned it to Reactive. Observation did not dispatch commands. The
saved decisions were valid empty selections, not selected work lost by the queue.

Comparison with actual earlier decisions and the prior source did not establish a
new conversational routing block. The existing Environment executor already
supports conversational and delegated computer-tool intentions, but its capability
description advertised only physical/sensing work. Autonomous Intent also omitted
the already-wired tool route from its explanation. The owner approved factual
corrections to those descriptions without requiring action or a response.

Three complete saved Full inputs were replayed before and after the description
correction, retaining images, source history, schema and high-reasoning provider
settings. All six calls selected no work. Two further saved-input calls with the
approved overall assessment reason and recorded previous-mode attribution also
selected no work. Their stated basis was no new need to interrupt the person at
the desk and unresolved movement uncertainty. These are selected diagnostic cases,
not a general model benchmark or a successful companion qualification.

The owner approved a Full-only `assessmentReason` and preservation of actual
assessment mode. Empty selections remain valid with an explanation; Semi is
unchanged, and old unattributed levels are not relabeled. Active Operator exposes
the latest reason and each recorded operation mode. This improves evidence, not
initiative by itself.

An actual full-Environment test exposed a separate lifecycle defect: the
`environment.tools` Coordinator handler demanded completion of the entire result
workflow, including queued speech, after the tool and its reply had completed.
That condition falsely failed successful work. The handler now requires the
existing completed tool result and preserves actual workflow/tool failures,
without requiring pending speech to finish. The durable output owner continues
to retain speech receipts. Seven tool-workflow tests pass, including autonomous
conversation, autonomous tools, late speech success/failure/cancellation, duplicate
receipt delivery and saved execution resumption without repeated tools or replies.
The failing-before test used the real TTS admission; the old fixture had replaced
that node and missed the defect. No model or hardware transport runs in those tests.

Routine successful graph-validation, persona-read, history-count and raw memory
query prints were removed; errors, warnings and durable execution evidence remain.
The graph-loading fixture now injects its invalid edge explicitly instead of
assuming the current controller contains a conditional edge. Its original error
assertion is preserved. All 15 focused loading/context tests pass. The reason/mode
change passes 42 focused tests and Core typechecking. Expanded boredom coverage
still has two pre-existing assertions for old command catalog and token settings;
they were not changed to make this task appear green.

No new scheduler, queue, execution path, behavior rotation, forced activation,
context deletion or inference limit was added. No physical actions were dispatched
by this repair. Useful self-directed activity remains unqualified; successful
software handoff and better explanations do not close that issue.

The owner then approved an isolated comparison of the existing decision-maker
opening with “You are the robot companion described by the supplied persona.”
Both matched calls selected no operation. The experimental opening was not applied
to production; it does not establish a remedy for the initiative failure.

The verified repair was activated using the existing application-only restart and
Active Operator lifecycle. The live API serves both approved capability/tool
wording and the Full assessment explanation. Reactive mode and the empty queue were
preserved, and the observed model/voice process identities were unchanged. Site
checking, all 45 graph validations, the production build and compiled-runtime
verification pass. No new Full assessment or physical action was triggered during
activation. Older assessments have no fabricated overall explanation; the UI will
show that field when a new Full assessment records it.


## Full intention comparison and missing feedback — 2026-10-26

The Owner approved comparing a Full-only nullable intention with the existing
activation contract, conditional on evidence before implementation. The comparison
preserved complete saved input, images, the configured Big Brother model and high
reasoning. Both contracts selected no operation on the two original cases. Removing
the duplicated current activation/threshold fields while retaining historical
assessments, and using the separately approved robot-identity opening, did not
change that result. The additional approved self-directed opening also selected
no work on both cases. These are repeated selected diagnostics, not independent
accuracy samples. None of these experimental instructions or contracts was deployed.

A broader paired comparison used seven original Full controller cases from the
previous initiative experiment; the eighth original case was Semi and excluded.
Both contracts returned valid structure in 7/7 and a grounded next step in 5/7,
including selected memory retrieval followed by immediate reassessment. Activation
selected operations in 4/7 and memory-first reassessment in 1/7; intention selected
operations in 2/7 and memory-first reassessment in 3/7. Both legitimately waited
in two cases involving completed work or a thought already running. This previously
exposed diagnostic cohort did not establish an initiative improvement. No decisions
were dispatched, and no resulting conversation was saved as training data.

The source investigation found a concrete missing-evidence path: the Ainekio
adapter dropped existing servo_feedback stream events, the authenticated Core
telemetry endpoint excluded that field, and the model context projection omitted
the selected robot's retained status. The approved scoped repair forwards the
existing feedback sample through robot.status telemetry and retains complete selected
status plus its recorded robot/epoch identity in model context. It adds no message
kind, store, health verdict, inferred sample time, movement restriction or prompt.
The sample's own scan and device clock remain distinct from later general telemetry.

The projection and real authenticated API-to-persistence-to-context regression fail
before the repair and pass afterward. Repeated samples, unrelated robot/epoch,
later status/IMU updates and absent fields are covered. Three focused Core tests
and two existing API tests pass. All sixty gateway tests were covered successfully;
the camera-dependent case required the configured gateway interpreter. Four broader
Core fixture failures were reproduced on pre-repair source and left unchanged.
Core typechecking, the production build and compiled runtime validation (45 graphs)
pass. The Owner subsequently authorized activation through the existing launchers.

A fresh read at 18:42 UTC found the body unavailable at the gateway, with Bridge
and Active Operator workers still running. The body reconnected before the next
read at 18:46:48 UTC. That connected snapshot retains the actual 18:46:25 cached
image time rather than claiming a newly captured frame. Production remained
Reactive; these reads requested no physical actions. Live companion initiative
remains unqualified until an actual pursuit and its outcome are observed.

The fresh connected-input comparison completed without dispatch. Both current
activation and approved self-directed intention selected Robot Status to correct
recognition of a face displayed on a monitor and retain attributed joint concerns.
This is grounded maintenance, not evidence of a new independent pursuit. Neither
experimental Full contract is qualified for deployment by these results.

The feedback repair was activated at 18:53:41 UTC with the application-only launcher.
The gateway had already restarted at 18:50:11 UTC after its source change, so a
second gateway interruption was unnecessary. Three actual subsequent samples
(scan 23645, 23874, 24107) reached persisted status and matched the model projection
exactly. The latter two arrived with the same originating full observation,
qualifying the incremental telemetry path rather than only a refreshed snapshot.
The unrelated training process retained its identity; no model service or robot
command was started for this verification. These measurements establish delivery,
not physical joint health or autonomous initiative.

Motivation inspection found the last committed Desire evidence review on October15,
with both prior desires archived. A later model-only diagnostic was not mistaken
for a committed review. Current canonical gathering exposes twelve unreviewed user
requests, fifty recent memories and five reflections, with no open desires. The
existing default Desire Agent can create new desires from this state, but its
advertised description omitted creation. The Owner approved a factual catalog
correction and retention of the actually-read empty Desire result in autonomy
context, followed by a complete-input comparison before activation. No recurring
job, forced desire or additional controller model call is part of that correction.

The two matched complete-input comparisons of the Desire capability and checked-empty
context returned valid empty selections in both variants (0/2 selected operations
before and after). This corrects available information but does not establish
initiative. The factual correction was built, checked and activated through the
application-only launcher at 19:04:15 UTC; Reactive mode and model assignments were
preserved. The live operation catalog exposes the approved creation capability.

A diagnostic invocation of the unchanged Desire Generator then failed before
inference: Codex rejected its final user input at the native interactive-input
boundary of 1,048,576 characters. The actual user message was 2,043,295 characters.
Operational context accounted for approximately 98 percent of the input: 32
executions explicitly linked by the selected memories, with 850 distinct events.
No unrelated global execution or duplicate event inclusion was found. The existing
observation deltas and lossless context serializer alone did not reduce that
complete evidence below the boundary. No truncation, new record limit or context
deletion was applied. Desire records and consumed-evidence fingerprints remained
unchanged by the failed diagnostic.

The native `thread/inject_items` interface accepted the exact complete message in
an ephemeral thread without starting inference. The ordinary provider already uses
that interface for prior graph messages but extracts the final user message into
interactive `turn/start.input`. The next scoped correction removes that special
case while preserving supplied roles, content and order. Native acceptance alone
does not demonstrate model context capacity, successful desire generation or useful
autonomy; those boundaries still require verification.

The native final-message correction removes four lines at the existing transport
owner. Its oversized-input regression fails before the correction; all twenty
focused provider and terminal tests pass afterward, as does Core typechecking.
A real unchanged approved body-event fixture returned valid JSON in 4.01 seconds,
retaining the exact user evidence with no compaction. That call reported an
effective context of 258,400 tokens, matching the model's 272,000 default window
at 95 percent. The complete frozen Desire request estimates 683,184 tokens before
transport/tool overhead. It was not retried at the insufficient default. The Owner
approved forwarding the existing Model Registry contextWindow setting into Codex
and comparing at the model's advertised 872,000 maximum before activation.

A separate matched local comparison used the existing 9B Q4_K_M base and its
already-registered initiative adapter with identical complete messages, image,
schema and inference settings. The base completed in 95.03 seconds including cold
loading, selected status and movement, but conflated output_fault=0 with resolution
of the distinct joint-feedback concern and claimed verified identity without that
evidence. Its relative memory timestamp also failed the actual production parser.
More activity did not qualify it as an improvement. The initiative adapter did not
return a final decision after 362 seconds and over 16,000 generated tokens; the
evaluator cancelled that diagnostic. This is an incomplete qualification, not an
invalid-JSON result or a new runtime timeout. No model role changed and no selected
work was dispatched. The temporary 9B service was restored to its prior inactive
state; the separately owned Freestyle service remained running.

The complete frozen Desire input then succeeded through the corrected native
provider at the approved larger context setting: 692,665 native input tokens,
828,400 effective capacity, 14.39 seconds and a literal empty candidate array.
The complete user input and base instructions were verified unchanged; no compaction,
candidate commit or analyzed-input acknowledgment occurred. The Owner separately
approved comparing a definition of a desire as a finite outcome the robot wants
to pursue, rather than an outcome for the user. That single-sentence comparison
also returned an empty array (17.60 seconds), with identical complete evidence and
no compaction. The experimental definition was not activated. These results repair
and qualify delivery capacity, not autonomous motivation.

During this work another task changed the Full Auto wake/continuity contract and
its parser/history owners. The previously successful provider build consequently
failed the source/runtime parity check. Activation and evaluation against that new
controller require ownership coordination and a new matching build. The earlier
quiet-policy comparisons above remain evidence about their frozen original
contract; they must not be presented as qualification of the concurrently revised
continuous-activity contract.

The Owner confirmed that another agent owns that controller repair and reaffirmed
that Full Auto means ongoing self-directed action, not permission to select nothing
and wait. Qualification must demonstrate consecutive useful model-selected
activities and use of their outcomes. Empty decisions do not satisfy Full Auto.
The current [companion qualification](../robot/QUALIFICATION.md#full-auto-engagement)
already states this requirement. This provider task leaves the controller edits
with their confirmed owner and does not deploy a competing intention/quiet policy.

Provider activation handoff: the native history and optional context-window
forwarding changes are source-ready and independently reviewed. The existing
authenticated `PUT /api/model-registry` accepts
`{"modelId":"big-brother.configured","options":{"contextWindow":872000}}`;
that persistent setting has not yet been applied. Coordinate a matching Site build,
compiled-runtime check and application-only restart with the controller owner.
The separate on-demand Terminal service must also load the changed provider code
through its existing lifecycle owner; do not mistake an application restart for
reloading that independent process. Model roles and local model services need no
change. The final check should verify actual native effective context and unchanged
input, then exercise the newly repaired Full Auto loop. The failed experimental
Desire definition remains undeployed.


### October 26: post-daydream activity and selected-input repair

The saved 19:53–19:55 UTC run admitted one Daydreamer, then selected no work in seven subsequent assessments. Actual controller calls contained standing persona goals, twelve recent memories, current imagery/status, thirteen operation capabilities and recent conversation/inner activity. Context availability alone did not produce self-directed activity. The graph still explicitly permitted empty updates; Full-only instructions and its existing schema/parser now require a model-chosen positive activity selection, without a scripted replacement or retry. Semi remains unchanged.

Matched offline replay of four complete saved inputs through configured Big Brother (`gpt-6-sol`, same sampling and high reasoning) selected activity in 0/4 baseline calls and 4/4 repaired calls: Robot Status, Inner Curiosity twice, and Desire. These are exposed diagnostic cases, not a general accuracy benchmark or live companionship proof. All images and user evidence were identical within each pair. The owner clarified that workflow-authorized audio may play even when the model describes a daydream as private; that wording is not a reason to suppress TTS.

Two existing handoffs also violated their contracts. Context assembly discarded every unified-inner record whenever the separate inner input was nonempty: the saved eighteen conversation and three inner inputs became eleven narrative records, losing seven selected records. The merge now reconciles the same saved identity and preserves distinct selected records with attribution. Daydreamer incorrectly treated pending asynchronous output delivery as failed generation after its output had been saved; its finite result now distinguishes a completed generation/save pass from later delivery, preserving actual delivery failures and avoiding regenerated output.

The third repaired handoff: independent controller-selected agent work retained its complete `graphContext.taskBrief` in the parent dispatch, but durable admission inherited that context only when sharing the parent execution. The real Daydreamer child therefore received an empty task brief. The existing runtime now preserves the committed dispatch context while keeping the child’s independent identity and lifecycle; retries use the frozen child admission. Activation and live qualification are pending at this entry.

Validation for this repair: original Full prompt-isolation, selected-inner merge, Daydreamer pending-delivery and independent task-brief regressions failed before their corresponding corrections. Focused activation/result tests pass 18/18, Daydreamer tests 8/8, and independent/shared graph handoff recovery tests 2/2. The combined selected owner suites pass 84/86; two unchanged Boredom fixtures still expect removed gait-description filtering and a former token setting. The full durable-workflow suite is not passing: obsolete Intent outputs and a missing fixture semantic index fail earlier cases, then leave a lease that cascades into later claims (3/33 passed). These fixtures were not rewritten to conceal the failures. Core and Brain typechecks, all 45 graph definitions, the Site build and compiled-source runtime verification pass. These validation results preceded the activation and live observations recorded below.

Separate existing availability limitation found during context tracing: Curiosity has 51 unanswered question records dated July 17–August 25 against its configured maximum of 5, so its outward-question path currently skips. Inner Curiosity is a separate available workflow. Agency currently has two archived zero-strength desires and no open desires; the controller’s empty desire list is accurate. No questions, memories or archived desires were deleted or rewritten. This repair preserves those facts and does not fabricate a motivation or change Curiosity’s configured admission behavior.

Live activation/qualification: application-only restart activated the repaired build at 20:17:32 UTC (PID 335602), then Full ran 20:18:00–20:20:24 UTC and was restored to Reactive as approved. Five successive Full assessments selected Robot Status, Inner Curiosity, Train of Thought, Desire and an Environment source-log lookup. The first four completed. The committed task briefs reached the independent child graphs. Inner Curiosity incorrectly substituted rear-left for rear-right and treated historical disconnection as current; the subsequent controller noticed both errors and selected Train of Thought, whose saved output corrected them. Desire completed normally with no candidates. These demonstrate nonempty self-directed selection, actual execution and outcome-informed continuation; they do not establish general model grounding or sustained companionship.

The fifth activity reached Big Brother tool execution but did not complete the requested lookup. Its diagnostic terminal closed at 20:20:34 UTC, about nine seconds after Reactive was restored; the retained evidence does not identify the caller that closed it. The diagnostic had started read-only searches but produced no completed report. There is no recorded mode-change cancellation of the tool task. Its subsequent ordinary Persona return call was interrupted by a separate whole-system restart at approximately 20:21:30 UTC, when the application and persistent services were replaced and Terminal closed. This agent performed no such restart. Neither interruption establishes a successful lookup. Fresh Daydreamer was not selected during the live session; its delivery repair remains qualified by its regression suite. No locomotion command was sent in the observed session; face-expression receipts alone do not imply movement. Models and speech settings were not changed by this repair.

Final state: the subsequent application process still loads the repaired build; compiled-source verification and all 45 graph definitions passed again after the external restart. Active Operator is Reactive and healthy; the current queue and unfinished execution list are empty. The completed live window selected five activities, four completed and one source lookup failed.


### October 26: finite output completion, Curiosity evidence and terminal closure

The subsequent 20:29–20:32 UTC Full session selected and executed internal activities rather than returning repeated empty decisions. Fresh Daydreamer completed, but Reflector reported failure after its output had already been saved and only independent speech delivery remained. Reflector now uses the same finite-pass distinction: generated and persisted output can succeed while the durable execution retains speech delivery. Interrupted, failed or suspended generation and missing persistence still fail. Repeated work and reopened receipts reuse committed output rather than regenerating it.

Inner Curiosity had three data-flow defects: sampling discarded recorded speaker/source/mode; question and answer formatting discarded IDs, times and types; the answer did not receive the controller’s original task brief. Its related-memory renderer also clipped each record to 500 characters, and the sampler clipped selected content to 4,000 characters. The owner approved attribution and original-brief forwarding plus removal of the obsolete cutoff contract. Both cognition stages now receive the same original purpose and complete selected content with available recorded attribution. Missing attribution remains missing. Record-selection policies are unchanged; old receipt files remain readable without rewriting them.

The recurrent carrier concern contains both real fault observations and historical model error. One sampled assistant remark about a rear-left fault was actually generated from a feedback-restored event, not a new fault report. Separately, a genuine rear-right below-calibration event had been recorded. The repair restores evidence distinctions; it does not erase the concern or assert that physical repair occurred.

One frozen two-call answer replay used the same question and original node settings. The baseline took 12.796 seconds and made four native shell calls, reading repository notes beyond supplied graph evidence. The corrected variant took 5.350 seconds with no shell calls and still referred loosely to historical telemetry as current. This is not a controlled accuracy or latency comparison and does not qualify model grounding. The owner explicitly chose to retain native shell access. Prompts beyond the approved task-brief addition, model roles and provider tool settings remain unchanged.

The delegated lookup’s desktop-terminal closure could not be attributed conclusively. Ordinary provider retirement excludes diagnostic sessions; a real CLI viewer remained alive through concurrent ordinary calls and retirement. One untraced native desktop run closed unexpectedly; subsequent traced runs remained open until explicitly closed. The existing audit owner now records actual viewer input/signal/stream closure, desktop exit code/signal/stderr and incoming request cancellation reason with session/work identity. No reconnect, retry, fallback or closure-policy change was added. The original spontaneous closure remains unresolved pending actual cause evidence.

Validation: four Curiosity data-flow regressions failed before repair; its three suites pass 24/24. Finite-agent unit and real queue/checkpoint/receipt tests pass 17/17, including successful, failed and cancelled speech outcomes and repeated delivery. Terminal tests pass 19/19, including actual PTY viewer lifetime, EOF, signal, stream error and desktop exit evidence; missing-report tests failed before correction. Core, Brain, CLI and root-test typechecks pass. All 45 graphs, the production build and compiled-runtime parity check pass. Eight private-Core imports introduced in the earlier Brain test fixtures were removed by placing cross-layer lifecycle coverage in the root integration suite. The architecture audit still reports five unrelated existing violations: three incomplete agent directory contracts and two other Brain test imports; its baseline was not changed.

The owner restarted MetaHuman at 23:58:36 UTC after the verified 23:57 build, activating these repairs. A short authorized Full verification began at 23:59:55 UTC; its results and restored mode follow below.

Live verification, 23:59:55–00:01:59 UTC: seven completed Full assessments selected Robot Status twice, one Environment inspection with two targeted continuations, Inner Curiosity and Reflector. The robot was restored to Reactive at 00:01:59 UTC. These were actual independent work admissions and results, not only model-generated plans. The selected work remained focused on the failed wave/carrier concern; this does not establish broad activity diversity or physical companion capability.

Inner Curiosity’s original brief was verified unchanged across the controller dispatch, child admission, checkpoint context, visible task-brief node and both cognition input ports. Its generated answer distinguished motion availability, command feedback, servo feedback and observed movement, acknowledged earlier posture overstatement, and was saved to both buffers/memory through the existing graph. This is one successful live grounded case, not a general accuracy score.

The autonomously selected Reflector completed at 00:01:58.667 UTC before its TTS-render receipt at 00:01:59.850; its durable execution subsequently completed. An explicit verification invocation completed at 00:02:28.064 UTC with confirmed reflection persistence while its independent speech segments were still being delivered. Neither reported the former false generation failure. Physical audibility was not observed by this agent.

Final delivery verification: all four explicit Reflector speech segments received `speech_played` receipts, ending at 00:03:26.318 UTC; its durable execution completed at 00:03:26.544. The recorded playback target was `computer`, not robot-speaker audibility. No Reflector work remained stranded. Native shell access stayed enabled as requested, model assignments were unchanged, and the robot was left in Reactive by this verification. The spontaneous terminal-closure cause and broader repetitive concern-focused behavior remain open; neither is claimed fixed by these handoff and reporting repairs.
