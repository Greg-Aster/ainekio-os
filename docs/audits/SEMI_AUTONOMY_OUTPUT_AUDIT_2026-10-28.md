# Semi Auto execution and output audit

Read-only audit, 2026-10-28. Scope: Active Operator assessment admission,
context selection, selected-work handoff, Environment decisions, Body Control
motion/speech results and Agency presentation. No production source,
configuration, prompts, assignments or services were changed. No physical
commands or model comparisons were initiated by this audit.

## Observed behavior

In the sampled 16-minute interval there were 13 completed Semi assessments,
13 Robot Status runs and five Boredom Observer admissions. Every assessment
selected Robot Status at 100%; five also selected Boredom Observer at 100%.
None selected Boredom Movement. Assessment context selection plus assessment
generation accounts for 26 model calls; the status runs add 13 more, before
observer planning, execution decisions and conversation generation.

The activation threshold and dispatch handoff worked. This is not evidence that
the selected work was useful or that the companion fulfilled its intentions.
The assessment model repeatedly treated status refresh as mandatory, although
the inspected policy does not require a refresh on each assessment.

The sampled controller requests contained approximately 58,000–84,000 characters
of messages. These are character measurements, not token counts. All 13 context
selections requested conversation, activity history, status and environment;
none requested persona, goals, desires or memory. Relevant-context gating is
implemented, but these model choices produced a narrow and repetitive basis for
companion behavior.

The owner switched to Reactive during the audit. One previously admitted
assessment remained in inference. Its saved input was Full mode, with reasoning
enabled; its final generation produced 4,743 tokens. It completed, selected work
was not dispatched under the current Reactive mode, and the queue drained.
Subsequent inspection found all three model servers idle. Residual GPU activity
was attributed to graphics processes. No cancellation was necessary.

## Assessment admission and selection

Paths: `brain/agents/active-operator/core.ts`,
`packages/core/src/active-operator/activation.ts`,
`packages/core/src/nodes/robot-operator/activation-dispatch.node.ts`.

- Owner: Brain owns assessment admission; Core applies mode selection and stages
  selected work through the existing Coordinator.
- Summary: The installed Semi interval was one minute after the previous
  assessment ends. Returning 100 again requests the operation again; this is
  level selection, not an automatic rising-edge trigger. Independent selected
  work does not globally block subsequent assessment.
- Boundary issues: Repeated status/camera choices are model decisions. Changing
  the threshold semantics or adding a cooldown, duplicate-work suppression or a
  global wait would change the approved behavior rather than establish a repair.
- Technical debt: The model repeatedly interprets monitoring as required work
  despite supplied recent receipts. Frequency amplifies that selection failure.
- Security/privacy notes: Existing authenticated admission and source attribution
  remain in use; private evidence is not reproduced here.
- Test gap: Existing dispatch tests do not qualify varied, useful Semi decisions
  across sequential real assessments and returned outcomes.
- Recommended action: Keep these owners. Qualify the current assessment model
  and context selector on complete saved sequences, separating correct dispatch
  from behavioral usefulness. An interval change is an explicit configuration
  choice, not proof of corrected decisions.

## Context, continuity and Agency activity

Paths: `etc/cognitive-graphs/robot-autonomy-controller-mode.json`,
`packages/core/src/nodes/robot-operator/context-builder.node.ts`,
`packages/core/src/nodes/robot-operator/task-catalog.node.ts`,
`packages/core/src/nodes/robot-operator/autonomy-activity-history.node.ts`,
`packages/core/src/api/handlers/active-operator.ts`,
`apps/site/src/components/ActiveOperatorDashboard.svelte`.

- Owner: Core builds selected context and reads canonical execution/Coordinator
  history. The API projects it for Agency; Site renders it.
- Summary: Recent receipts are present in the separate selected activity-history
  branch. The evidence does not support a blanket claim that continuity history
  is missing. Admission receipts can say completed while their linked execution
  remains waiting; both facts are supplied separately.
- Boundary issues: The status API reuses the graph catalog's
  `includeActivityHistory: false` property. That property avoids a duplicate
  inference read because the graph has a separate history branch, but the API
  has no corresponding branch. Consequently every operation card returns an
  empty `recordedActivity` list even when real work exists.
- Technical debt: An inference data-flow choice incorrectly determines display
  completeness. This makes Agency appear unused and obscures actual outcomes.
- Security/privacy notes: Retain profile ownership and attributed results;
  no new history database is needed.
- Test gap: Status API coverage should exercise a graph with catalog history
  disabled and real retained work, and assert the UI still receives that work.
- Recommended action: Correct the existing API projection using the existing
  canonical reader, independently of inference gating. Preserve model-selected
  context and full receipts. Separately evaluate omissions of persona, goals
  and desires without forcing those sources into every request.

## Environment Task and Freestyle quality

Paths: `etc/cognitive-graphs/environment-mode.json`,
`packages/core/src/nodes/environment/task-planner.node.ts`,
`packages/core/src/nodes/environment/active-task.node.ts`,
`Ainekio/experiments/freestyle/bridge.py` and the existing specialist trainers.

- Owner: Task selects supported execution; Freestyle generates custom motion;
  the gateway and body execute targets and return correlated receipts.
- Summary: Some observer intentions returned `program: null`. Two nudge requests
  did reach Freestyle and completed with verified servo-target receipts. One
  generated two effectively identical whole-body poses with a hold; another
  generated a longer pose/foot sequence. Neither receipt establishes contact
  with the intended person or fulfillment of a nudge goal.
- Boundary issues: A separate conversational input received a Task-selected
  movement copied from older context, even though the saved current instruction
  was intact. Its motion generator then chose a different joint and displacement
  from the selected request. These are distinct selection/generation failures,
  not evidence that the bridge dropped the original instruction.
- Technical debt: Structurally valid programs and verified target execution are
  insufficient semantic qualification of these models. Do not label all recent
  motions rejected: the correlated body records show successful target execution.
- Security/privacy notes: Diagnostic failures are not automatically approved
  training targets. No new motion was dispatched for this audit.
- Test gap: Require held-out request/program alignment, compound relative-motion
  coverage, no-action conversation, and goal evidence distinct from target receipts.
- Recommended action: Keep the existing execution and training owners. Review
  complete failing model inputs and outputs before choosing data/recipe changes.
  Do not add scripted movements, substitute a larger model automatically or
  weaken measured-target completion.

## Speech destination

Paths: `packages/core/src/nodes/output/tts.node.ts`,
`packages/core/src/tts/robot-speech.ts`,
`Ainekio/Master/gateway/environment_adapter/server.py`.

- Owner: MetaHuman TTS sends speech through Body Control; the existing adapter
  owns its selected playback destination.
- Summary: MetaHuman speech was enabled and routed to Body Control. Nine sampled
  completed chunk receipts explicitly reported computer playback. The supplied
  body state also advertised that destination.
- Boundary issues: Successful Body Control delivery does not imply robot-speaker
  output. This configuration explains absent speech from the physical robot
  without establishing a synthesis failure or a competing TTS implementation.
- Technical debt: The two interface selections are easy to conflate.
- Security/privacy notes: No audio destination was changed during the audit.
- Test gap: End-to-end qualification must assert the chosen playback target,
  actual playback receipt and audibility separately.
- Recommended action: Use the existing Body Control destination owner if robot
  playback is desired; show its actual destination clearly in existing status.
  Do not create another speech route.

## Feed and queue interpretation

Paths: `packages/core/src/nodes/robot-operator/activation-dispatch.node.ts`,
`packages/core/src/nodes/output/robot-buffer.node.ts`,
`packages/core/src/nodes/output/tts.node.ts`,
`packages/core/src/api/handlers/unified-queue.ts`.

- Owner: Graph output nodes publish intentions, status, feedback and speech
  through their distinct existing owners; Coordinator reports admitted work.
- Summary: Intention cards are published at selection. Status and robot-feedback
  entries are additional feed content, not outward speech commands. The sampled
  interval included 32 Robot Buffer Admission executions as well as assessment,
  planner and status output. Counting feed entries overstates companion activity.
- Boundary issues: Switching to Reactive stops new assessments, not an already
  admitted provider request. A waiting/interrupted execution label also did not
  establish that inference had stopped: the associated resume work was running.
- Technical debt: Current presentation makes selection, admission, generation,
  execution and achievement difficult to distinguish at a glance.
- Security/privacy notes: Existing cancellation was offered for the specific
  active assessment; it finished before approval arrived. No work was cancelled.
- Test gap: Mode-transition checks should assert new admission, in-flight
  inference, current-mode dispatch and final queue state separately.
- Recommended action: Preserve real receipts and asynchronous operation. Correct
  misleading projections at their existing owners; do not hide errors, add a
  second queue, impose inference cutoffs or make mode changes cancel unrelated work.

## Disposition

Keep the existing graph, Coordinator, bridge, body execution, TTS and persistence
owners. The demonstrated source correction is the Agency history projection.
Other demonstrated problems require model/context qualification and an explicit
speech-destination choice. The long in-flight inference ended normally; this
audit did not reproduce a permanently stranded queue item. No production repair
or behavioral change is claimed by this report.

## Authorized follow-up

The owner subsequently authorized repair. The Agency API now explicitly includes
canonical recorded activity independently of the inference graph's catalog
setting. Its real-persistence regression fails before and passes after the
correction. All 11 continuity tests, Core typecheck and Site build pass; the
activated API returned 13 linked executions. Reactive mode was preserved.
The owner explicitly chose to retain computer speech playback.

Unchanged-input replays reproduced the small Intent model's fixed context list
and Task's historical-action substitution. A larger-model diagnostic did not
complete and was stopped; it does not qualify a replacement. Inspection then
found that the existing context curriculum explicitly supervised the same four
sources in every Semi case. That is a training-target defect, not evidence that
the runtime should force those sources or force physical activity.

The owner approved one corrected Intent fit and qualification. Corpus version
22 replaces the mode shortcut with four recorded-operation situations in both
modes, retaining the same runtime prompt/schema and existing scoring of allowed
alternatives. Its 256 development and 128 evaluation context records remain
separate; no private runtime request enters fitting. The existing specialist
validation command passes all 73 tests, including regressions for the curriculum
defect, and Brain typecheck passes. Candidate quality, serving comparison and any
production adapter activation require their own results; none is established by
the curriculum or the Agency repair.

The single three-epoch fit completed and was compared with the deployed adapter
through the same Q8 llama.cpp base, sampling, schema constraints and GPU. Combined
acceptable routing improved from 303/485 to 421/485; the corrected context
variants improved from 0/128 to 125/128. Previous routing skills fell from 303/357
to 296/357 and regression routing fell from 36/46 to 35/46. Both produced valid
Core structures on all 531 evaluation/regression requests. Median native request
latency was approximately 364 versus 360 ms, with p95 approximately 522 versus
478 ms. These are provider-request measurements, not whole-workflow latency.

The recorded Semi requests still omitted persona goals and desires. The recorded
conversational statement still selected action, and the candidate additionally
selected tools. Thus aggregate improvement did not establish repair of those
live failures. The owner was told about the regressions and unresolved failures
and explicitly requested production activation for the overall improvement.
Activation used the existing shared-service and model-registry owners and records
that acceptance. The selected Environment Orchestrator role, loaded artifact and
applied adapter scale were verified through a production Intent-node call. Task,
Freestyle and other assignments were preserved. Reactive mode and the owner's
chosen computer playback remained unchanged; the application queue was empty.
No physical command was sent by training or qualification. This is an accepted
model tradeoff, not a declaration that Semi companionship is fully repaired.
