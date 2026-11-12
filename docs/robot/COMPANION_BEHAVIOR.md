# Companion behavior and lifecycle

[Companion guidelines](#companion-design-guidelines) · [Modes and sleep](#modes-and-lifecycle) · [Memory and persona](#memory-persona-and-inner-dialogue) · [Goals and autonomy](#goals-desires-and-autonomy) · [Interaction flow](#workflows-and-interaction-examples)

[Start with the robot design core](ROBOT_BIBLE.md). Read the relevant subsection for modes, memory, identity, goals, autonomy or interaction flow.

The existing Core, agent and graph owners implement these behaviors;
[Maintained Surface](../technical/MAINTAINED_SURFACE.md#critical-runtime-ownership-boundaries)
owns their detailed execution boundaries.

This page states the maintained capability contract. It does not report current
service state, selected weights or installed firmware. Use the linked owners for
configuration and [qualification](QUALIFICATION.md) for proof of behavior.
Dated deployments, comparisons and incidents are retained in the
reference history (retained locally).
A historical success or failure is evidence under its recorded conditions;
refresh those conditions before treating it as the present state.

## Companion design guidelines

The [design core](ROBOT_BIBLE.md#purpose) defines Ainekio as a companion, friend,
familiar and assistant. These guidelines describe the qualities that make those
roles observable in everyday life. Conversation, shared exploration, play,
practical assistance and a continuing familiar presence can all have value.
Evaluate the developing interaction and relationship as well as individual tasks.

These are product design and review criteria, synthesized from the research below.
They are not a validated universal standard, a runtime prompt or an activity
script. The models retain interpretation, personality expression, context
selection and behavior choices through the existing workflows and owners.

| Principle | Design expectation | Observable evidence |
| --- | --- | --- |
| Responsiveness | Current human input and relevant events can meaningfully influence the next contribution. Interaction uses the supplied evidence and acknowledges uncertainty. | A correction, answer or changed situation affects what follows; the exchange develops rather than repeating a generic contribution. |
| Shared context | The companion can participate in the situation shared with the person, drawing on selected observations, conversation and memories with their source and time. | It can discuss a shared object or project using relevant evidence, distinguish what it observed from what it inferred, and use the person's explanation. |
| Continuity | Persistent identity and shared experience support familiarity across encounters. Remembering is useful when retrieved experience appropriately informs later behavior. | An earlier topic, preference or unfinished pursuit can be resumed with accurate attribution; a correction remains useful in a later encounter. |
| Initiative | Within the selected autonomy mode, the companion can originate and pursue model-chosen interests, questions, play or assistance through its available capabilities. | It contributes a relevant pursuit without a person supplying every next step, and subsequent choices reflect actual progress or outcomes. |
| Reciprocity | Both person and companion can contribute direction. Responses and feedback influence how an exchange or shared activity develops. | Turn-taking, elaboration, questions and changes of direction form a connected interaction; the person can steer, correct or end the activity through the existing controls. |
| Coherence | Speech, expression, action, identity and remembered experience support a consistent account of what is happening and what the companion can do. | Its statements agree with observed actions and known capabilities; attempted work, completed execution and achieved outcomes remain distinguishable. |
| Personal fit | Participation develops around the individual person's preferences, attention and situation while preserving the companion's identity and model-selected choices. | Across encounters, timing and contributions become more appropriate for the person; the person reports feeling understood, enjoying the interaction or receiving worthwhile support. |

These principles apply through the existing mode contracts. Reactive behavior
remains responsive to admitted inputs and events; Semi and Full retain their
defined initiative. Full Auto's meaningful self-directed work can include
reasoning, curiosity or an ongoing pursuit without every assessment producing
outward speech or movement. Its activity requirement and approved scheduling
remain as defined in the [Full Auto contract](#full-auto-continuity--owner-contract).

Examples illustrate acceptance rather than prescribe behavior. While the person
works on a project, the companion might relate an observation to an earlier
conversation, ask a relevant question, and use the answer in a later contribution.
Another appropriate interaction could develop through play or shared exploration.
The evidence is the connected exchange and its value to the person. No particular
line, gesture, emotion, fixed task rotation or frequency of interruption follows
from these examples. Assess the relevant qualities through
[everyday companion evaluation](QUALIFICATION.md#everyday-companion-evaluation).

### Research basis and limits

| Reference | Contribution to these guidelines | Evidence boundary |
| --- | --- | --- |
| Kerstin Dautenhahn, [Socially intelligent robots: dimensions of human–robot interaction](https://pmc.ncbi.nlm.nih.gov/articles/PMC2346526/) (2007) | Personalized domestic companions combine useful capabilities, socially appropriate conduct, consistency and adaptation over repeated encounters; the paper discusses household "robotiquette." | An HRI design reference and account of companion research, rather than a complete recipe or qualification of Ainekio. |
| Timothy Bickmore and Rosalind Picard, [Establishing and maintaining long-term human-computer relationships](https://doi.org/10.1145/1067860.1067867) (2005; [authors' summary and preprint](https://www.media.mit.edu/publications/establishing-and-maintaining-long-term-human-computer-relationships/)) | Relational agents support relationship development across interactions. In a month-long study with 101 participants, the relational agent received better relationship evaluations than a task-oriented comparison. | A screen-based exercise agent and a bounded study; this does not establish lifelong relationships or physical robot performance. |
| Cynthia Breazeal, [Toward sociable robots](https://www.sciencedirect.com/science/article/pii/S0921889002003731) (2003) | Sociable robotics treats embodied social exchange as a design concern; Kismet's vocal turn-taking provides a concrete case. | Evidence about particular social interaction mechanisms, rather than proof of a complete companion architecture. |
| Eric Horvitz, [Principles of mixed-initiative user interfaces](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/) (1999) | Initiative considers human attention, uncertain intentions, the value of contributions and opportunities for direct steering and correction. | An interface design framework. Its application here is a design interpretation, not a replacement for the approved autonomy contracts. |
| Richard Ryan and Edward Deci, [Self-determination theory and the facilitation of intrinsic motivation, social development, and well-being](https://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf) (2000) | Human autonomy, competence and relatedness offer questions for personal fit: can the person steer the exchange, receive useful support and feel understood or connected? | A theory of human motivation. Applying it to companion evaluation is our synthesis; it does not establish psychological needs or subjective experience in the robot. |

Apply these criteria through the existing context, memory, decision, execution
and delivery owners in the [software architecture](SYSTEM_ARCHITECTURE.md).
Future implementation follows the repository's change-authorization rules and
qualification paths. Source, software tests, model decisions and observed
companionship retain their separate [evidence levels](QUALIFICATION.md#evidence-levels).

## Modes and lifecycle

Three separate controls govern operation:

| Control | Choices / function | Distinction |
| --- | --- | --- |
| Ainekio OS cognitive mode | Dual Consciousness, Agent, Emulation, Environment | Selects the kind of cognitive operation and its associated policies/graphs |
| Robot autonomy mode | Reactive, Semi, Full | Selects how new embodied work is initiated and continued |
| Lifecycle | Ainekio OS Sleep Workflow; body Idle/Doze/sleep states | Cognitive maintenance and physical power/peripheral states are separate |

[The cognitive-mode source](../../packages/core/src/cognitive-mode.ts) defines Dual for deep identity/memory-oriented operation, Agent for command/task assistance, Emulation for use of an existing persona with read-only defaults, and Environment for embodied interaction. Environment Mode is the robot workflow covered throughout this reference. Cognitive mode also determines whose conversational replies personalization learns; see [Conversational training by cognitive mode](MODELS_AND_LEARNING.md#conversational-training-by-cognitive-mode).

### Robot autonomy modes — owner-defined behavior

These are the robot's three autonomy modes within the embodied system. Body power states and the Sleep Workflow are separate features.

| Mode | Intended function | End-to-end acceptance |
| --- | --- | --- |
| Reactive | Respond to user input and physical events; do not initiate self-directed activities. | Human input and configured boot/wake, tipping, rapid-movement and motor-stall events reach their existing response owners with continuity and accurate outcomes. |
| Semi-autonomous | Reactive interaction plus selected self-directed work, managed through Active Operator in Agency. Periodic assessments add or subtract model-selected amounts from operation percentages; a function reaching 100% is triggered. | Both ongoing interaction and inactivity inform model-selected activation. Context produces relevant, varied activity without independent per-task timers or a permanently filled task queue. |
| Fully autonomous | Continuously choose and carry out meaningful self-directed activity: musing, reasoning, tasks, agents, movement or the Sleep workflow. | The robot originates and pursues activity without a person supplying its next step. No-operation decisions, idle assessment loops, event-only suspension, repeated commands without progress and repeated fault commentary do not satisfy Full Auto. Selected work remains independent of subsequent assessments. |

The LLM owns high-level choices. Implementing Full autonomy means making the decision, execution, evidence, memory and review paths work together—not adding a fixed task rotation, keyword behaviors, mandatory activity quotas or an imposed personality. Reactive retains physical-event reactions (boot/wake, tipping, rapid movement, motor stall) through the existing body-event owners while excluding self-directed activities.

### Sleep, wake, and maintenance

Ainekio OS's [Sleep Workflow](../../packages/core/src/queue/sleep-workflow.ts) sequences Organizer → memory Curator → Environment decision-review proposals → eligible personalization training → Desire Agent → Dreamer → persona review → memory-index refresh. The Environment Training Curator uses its existing agent and proposal store for recorded Intent and Task decisions (controlled by its Agent Catalog enable switch); proposals retain separate human review and specialist training without fitting or activating models or reviewing Freestyle motions during Sleep. User activity ends the remaining sleep chain through its lifecycle owner, coordinated with awake automation and robot operator scheduling.

Sleep organizes experience, supports reviewed learning and persona development, and produces internal material for later cognition. It is separate from body low-power states, and a body boot/wake event does not imply an Ainekio OS sleep session occurred.

## Memory, persona, and inner dialogue

The companion's continuity comes from distinct state owners rather than a language model automatically remembering every earlier request:

| Information | Purpose | What it is not |
| --- | --- | --- |
| Persona | Persistent identity, background, personality, values and goals; relevant facets can be selected for a call | Evidence that an imagined event physically occurred |
| Recent buffers | Attributed conversation, internal activity, system and robot events available to later context assembly | An instruction to load every item into every call |
| Persistent memory | Saved experiences and records available beyond recent buffers | Proof that a record was indexed, retrieved, or used |
| Search/index | Find relevant stored records for the selected task or conversation | A guarantee that similarity ranking answers chronological questions |
| Robot Status | Projection of selected-body condition, current task, action outcomes, and dated observations | A separate goal executor or an independent replacement for receipts |
| Durable execution | Original objective, corrections, selected work, progress, results and continuation state | A second persona or general conversational memory |
| Model weights / LoRAs | Learned behavior and tendencies following training | Live storage of the current conversation |
| Inference context / cache | Input and working state for generation, with backend-dependent reuse | The authoritative persistent memory store |

The interface can merge feeds visually while their records retain separate speaker, source, type, identity and time (originating turn time, acquisition time and receipt time can differ). Semantic memory search includes both the person's messages and Ainekio's saved replies (`indexContentMode: all`), with speaker attribution attached so a retrieved assistant statement establishes what was said rather than whether its factual claims were true. Retrieval eligibility is separate from mode-aware training and Curator policies in [Models and learning](MODELS_AND_LEARNING.md#models-and-learning). Memory selection supports relevance or newest ordering, explicit time ranges and latest-sleep-cycle scope through the memory owner; the current input record is excluded from its own recall by saved identity while earlier records remain eligible.

Robot Status uses the [live projection owner](../../packages/core/src/robot-status-live.ts) to expose current execution and command evidence to the interface and workflow context. It preserves motion parameters (`continuous`, `units`, `durationMs`), command work state/start time, correlated receipts, overall objective criteria, and behavior-step criteria (plain actions have no behavior-step criteria). It also separates the current running/waiting task from `parkedGoals` (unfinished idle objectives retaining their identity, source, decision and timestamps). Each saved summary, environment description, user-context field and uncertainty list retains optional `situationEvidence` (producer recording time, source timestamps and frame references); receipt updates do not renew retained prose. Robot Status admits no actions and creates no independent goal store.

Reflection, Dreamer, Daydreamer, Inner Curiosity, Train of Thought and mood review provide internal activities:
- **Dreams and daydreams** are generated surreal or imaginative stories derived from remembered events, saved and recalled with dream attribution rather than treated as physical events.
- **Reflection** examines supplied experience; **associative thought** continues from a persisted seed.
- **Inner Curiosity** carries the original delegated purpose into both question and answer stages and presents selected memories with their recorded identity, time, type and speaker/source/mode.
- Workflow-connected TTS is independent of generation: a saved reflection or daydream completes its finite agent task while speech delivery settles separately.

References: [buffer owner](../../packages/core/src/conversation-buffer.ts), [memory owner](../../packages/core/src/memory.ts), [Robot Status](../../packages/core/src/robot-status.ts), [Inner Curiosity graph](../../etc/cognitive-graphs/inner-curiosity.json), [Dreamer graph](../../etc/cognitive-graphs/dreamer-mode.json), [Daydreamer graph](../../etc/cognitive-graphs/daydreamer-mode.json), [Train of Thought](../../etc/cognitive-graphs/train-of-thought.json), [persona learning](../../packages/core/src/persona-learning.ts).

## Goals, desires, and autonomy

| Concept | Meaning and existing responsibility |
| --- | --- |
| Persona goal | A longer-term architectural, developmental or aspirational direction represented in persona; it guides the companion without becoming an automatically running command |
| Desire | A specific desired outcome represented in Agency, with motivation, evidence, relevance and lifecycle; it can be considered, planned, executed and reviewed |
| Robot execution objective | The current requested outcome retained by durable execution, with corrections and evidence |
| Program / action | Selected work toward that outcome; a receipt describes execution, not necessarily fulfillment |
| Robot Goal Review | Assessment of an unfinished non-Agency objective after selected work/results, before final conversation |
| Agency outcome review | Review of Agency-owned plans and steps through their own lifecycle |
| Weekly Goal Review | Separate project-progress/insight workflow; not the robot's per-objective continuation owner |

**Persona goals vs. Agency desires:**
- **Psychotherapist** (internally `psychoanalyzer`, using the `psychotherapist` role) is the sole autonomous editor of persona and persona goals through the persona-learning owner. Human statements remain attributed to the speaker and do not automatically become Ainekio's traits.
- **Desire Agent** is the public controller for Agency work (invocable manually, by Sleep, or by Robot Autonomy) covering generation, planning, execution, outcome review and check-in. It reads standing persona goals as context (via Persona Formatter's standing-goal selection) but never creates or edits persona fields. Agency-owned steps use Agency outcome review rather than Robot Goal Review.
- **Desire nurturing** reassesses all open desires (including those in planning or execution) against enabled conversation, episodic memory, task, goal, curiosity, reflection and dream sources, standing persona goals, and actual robot state/capabilities. The model selects an exact target strength in `[0, 1]` with a reason and supporting evidence references for changes (distinct from elapsed-time decay). Unchanged evidence or repeated reads of the same event do not count as new reinforcement. Generation receives the current review's proposed relevance changes before persistence. At strength `0`, the Agency storage owner archives the desire (retaining history) and requests Coordinator cancellation of its remaining work; late receipts do not reopen an archived desire.
- Desire generation and nurturing select the `psychotherapist` model role with the per-node Reasoning checkbox off; only Full Autonomy assessments request high reasoning through the connected mode input.

**Environment Mode execution and Goal Review:**
- In [`environment-mode.json`](../../etc/cognitive-graphs/environment-mode.json), Intent (`orchestrator` role) selects whether a response is needed (`needsResponse`) and which routes/context to run. Task (`environmentActionSelector` or `environmentVision`) selects executable actions, sensing and behaviors; it does not author speech. Persona is the single outward speech author for that execution path.
- Conversational exchanges do not require inventing a goal. Finite `action_result` objectives with no selected continuation settle directly from their receipts (success completes the objective; terminal failure ends the one-off task as failed and supplies the evidence to Persona).
- **Goal Review** ([`robot-goal-review-mode.json`](../../etc/cognitive-graphs/robot-goal-review-mode.json)) runs only for an unfinished non-Agency objective selected for review after selected work returns (an explicit wait for new input does not trigger immediate review). Completion bases are `action_result`, `visual_observation`, `environment_state` and `user_input`. Review returns assessment data—it may revise the objective and completion criteria, mark it complete, retain it as a parked goal pending input, or abandon it—without starting new planning/actions or publishing speech.
- Active Task's correlated results always reach the Current Execution reader for Persona, whether or not Goal Review ran.
- **Objective completion vs. step completion:** `taskDecision.completionCriteria` defines success for the overall request and does not terminate an open-ended action; a visual behavior step's own `completionCriteria` governs when that step requests gait Finish.

### Active Operator execution contract

The editable [Active Operator graph](../../etc/cognitive-graphs/robot-autonomy-controller-mode.json) ([`brain/agents/active-operator/`](../../brain/agents/active-operator/)) is shared by Semi and Full modes to assess relevance and select activity; the shared Environment Mode graph executes admitted intentions.

- **Scheduling and activation rules:**
  - **Semi mode** runs the assessment workflow periodically using `semiAssessmentMinutes` (default 5 minutes) measured from entering Semi or finishing the last assessment; conversation does not reset the timer. Every Semi assessment must return one or more nonzero signed `delta` adjustments applied to retained operation percentages in `[0, 100]`, triggering any function that reaches `100%`. Empty decisions, zero adjustments, or adjustments that leave levels unchanged without triggering are invalid. Elapsed time never mechanically increments activation.
  - **Full mode** requests its next assessment immediately when the current assessment finishes—without a waiting interval, event-only wake condition, `reconsider` pause, or waiting for selected work to finish. Full updates absolute activation levels and dispatches the highest positive activation (even below 100, with returned order breaking ties) or targets an existing execution or Desire lifecycle operation. Empty or all-zero Full decisions are invalid.
  - Omitted operations retain their previous levels without re-triggering. Sleep Workflow is an available model-selected operation governed by its enabled, sleep-window and inactivity settings.
- **Standing persona and selected context:**
  - The graph first loads the active persona through Persona Loader and Persona Formatter (including standing proposed, planning, aspirational and active goals). Identity, background, personality, values and standing goals are supplied as standing context to both the Orchestrator context-selection call and the Autonomy activity assessment; optional source selection cannot omit or narrow them.
  - The Orchestrator selects additional sources via `taskContext` (conversation, private thoughts, robot actions, memory via Memory Router query/scope, status, environment, camera evidence, execution, activity, observation history and desires). Complete records retain speaker, source, identity and time, using lossless JSON Pointer references for repeated data.
  - Already-read context is handed to Environment Mode with the originating intention; source owners reuse only matching retrieval scopes and camera session evidence while human input clears unrelated autonomous context.

### Full Auto continuity — owner contract

Full Auto requires sustained, meaningful self-directed activity with progress and accurate outcomes. Every successful Full assessment must select or continue meaningful activity—musing, reasoning, tasks, agents, movement or the Sleep workflow. Doing nothing, returning all-zero activations, or running idle assessment loops is invalid, and code must never substitute a scripted fallback, forced movement or fixed task rotation.

- **Independent execution and continuation:** Selected operations run through independent Work Coordinator admissions so their duration does not block subsequent assessments. Full can initiate new work, continue an existing execution by ID through the durable autonomy event owner (preserving original objective, autonomous authorship and prior results), or invoke a Desire lifecycle stage through Desire Agent. Delegated computer-tool work through Big Brother Terminal (`claude-code`, `codex`, or `gemini`) settles independently while speech rendering is pending.
- **Canonical activity and connection state:**
  - Activity context reads canonical execution outcomes (up to Task Receipt Limit for completed activities, plus all linked running, waiting and idle objectives), pairing each selected action ID with its correlated receipt so later speech playback cannot overwrite action evidence.
  - Core's Robot Operator body-connection reader supplies actual selected-body connectivity (`bodyConnection`) in model-visible `activationState` (a gateway connection alone is insufficient). When no robot session is connected, downstream trigger handling skips embodied `boredom-*` stimulus workflows (`no_connected_robot_session`), while `environment-mode.json` remains usable for non-embodied activity (reasoning, memory, inner dialogue, agents, delegated computer tasks, and Sleep).
  - Disconnected finite camera reads resolve immediately with their actual failure across Bridge teardown and Coordinator recovery without leaving stranded subscribers.
- **Inner Dialogue recording:** Autonomous intentions dispatched to Environment execution in both Semi and Full Auto modes (including Observer, Movement, Reflection and direct Controller handoffs via `active_operator_dispatch`) are published to Inner Dialogue Buffer and saved by Inner Dialogue Memory Saver with the selected instruction, stated reason, observed context and provenance metadata (`autonomy`, `autonomy-intention`). This records the declared intention without claiming physical completion or adding spoken output.

References: [autonomy controller](../../etc/cognitive-graphs/robot-autonomy-controller-mode.json), [shared human/autonomy executor](../../etc/cognitive-graphs/environment-mode.json), [Active Operator](../../brain/agents/active-operator/), [Robot Goal Review](../../etc/cognitive-graphs/robot-goal-review-mode.json), [Weekly Goal Review](../../etc/cognitive-graphs/goal-review.json), [Agency owners](../../packages/core/src/agency), [remaining-objective routing](../../packages/core/src/nodes/utility/execution-context.node.ts).

## Workflows and interaction examples

Connections and the existing execution owners determine scheduling. This describes responsibility and information flow, not a mandatory serial sequence:

1. User/event input enters the graph with originating instruction and attribution.
2. Intent Orchestrator selects needed routes and context.
3. Persona, history, memory, Robot Status, current execution, available capabilities and camera evidence feed the relevant context builders.
4. Task Decision selects an executable plan or delegation. Visual Planning and the plan resolver contribute when selected.
5. The active-task executor dispatches selected operations and records progress and outcomes.
6. Remaining-objective routing conditionally invokes Goal Review for an unfinished owned objective; its assessment returns as data.
7. When Intent selects `needsResponse`, the final context builder waits on selected graph branches, combines selected sources, returned execution/image evidence and applicable goal assessment, and passes them to Persona. Conversation Out records and speaks the reply.
8. `environment_training_output` nodes (`save-intent-decision` and `save-task-decision`) record Intent and Task decisions to the Environment Training review bank for later curation.

Core distinction: **request → selected plan → dispatched operation → operation receipt → evidence about the objective**. Receiving command completion does not by itself prove that an object was found, tracking is active, or a clearer image was obtained. Conversation inference or delivery failure remains a failure rather than an empty successful reply.

Sources: [Environment graph](../../etc/cognitive-graphs/environment-mode.json), [autonomy controller](../../etc/cognitive-graphs/robot-autonomy-controller-mode.json), [Goal Review](../../etc/cognitive-graphs/robot-goal-review-mode.json).

### Illustrative request paths

These examples explain intended information flow. They are not runtime prompts, forced action sequences, or claims that every case currently passes. Intent selects routes; the task/conversation models decide the actual response and actions from the supplied evidence.

| Request or trigger | Relevant path and expected evidence |
| --- | --- |
| “How are you?” | Intent may select conversation and relevant context. A generated reply is delivered to text and the selected speech output. No body action or goal review is inherently required. |
| “What do you see?” | Selected vision context supplies a dated image through cached read or selected capture. Visual interpretation and returned evidence reach conversation. A capture receipt without the image does not establish what was seen. |
| “Walk forward,” then “Please stop” | The first turn selects goal-bearing locomotion with an endpoint or continuing condition; bare gait starts are not exposed to the model. The later turn reaches the existing execution for interpretation and cancellation/control. Results distinguish endpoint evidence from gait termination. Stop, detach and Finish remain distinct. |
| “Tell me what you see, a fact about cats, and bow” | Context selection and planning cover the visual, conversational and physical parts. Independent work can overlap where supported. The response receives relevant completed results; independent specialist roles are not assumed to run simultaneously when one needs another's output. |
| “Help me find my wallet” | A selected objective persists with the request and corrections. Model-selected searches/actions produce evidence; review assesses fulfillment or the next step rather than discarding the goal at the end of one graph pass. |
| Full-auto activity | Context and available capabilities inform a controller choice. Execution or agent work returns attributed results; later decisions receive that history instead of repeatedly seeing only the original situation. |
| “What did you dream about last night?” | Routing selects memory/inner evidence as relevant; retrieval must distinguish dated dreams from older questions and physical experiences. Missing evidence is not supplied by inventing a remembered event. |

### Dependencies and concurrency

Intent context selection precedes the planning that consumes it. A description of a newly captured picture depends on the returned image. These are necessary data dependencies. Independent speech, motion, sensing and delegated computer work can overlap through their existing owners; one shared graph is not a requirement that the entire robot perform only one activity at a time. Hardware, speaker ordering, configured inference capacity and real requested ordering still affect concurrency.

Build Conversation Context assembles the selected inputs and available task results for the conversation model. It does not execute commands or magically receive evidence after a model call has already started. Correct result handoff and continuation are therefore part of the functional contract, not optional reporting details.

Execution recovery services outstanding work: interrupted execution, pending delivery, unfinished cancellation, and results belonging to current jobs. It does not repeatedly process completed history or dormant goals. An arriving result retains the identity of its originating execution; separate live requests can progress independently. Historical evidence and goals can remain available to selected context without entering the recovery loop. Cleanup selects records due under the existing retention policy separately. This distinction does not change the existing application-restart policy or the preservation of admitted work through a Body Control disconnection.

Active Operator reads the Coordinator's active-item membership, not its retained receipt payloads. Receipt recovery resumes unacknowledged handoffs, including a result recorded just before its queue acknowledgement was interrupted; it does not repeat the original action. The queue retains unfinished work, undelivered results or failure notices, and the existing recent-activity window used by autonomy. After the execution owner records a result, the same delivery handoff acknowledges it to the Coordinator. Normal queue lifecycle removes the copy when it leaves that activity window; no later cleanup sweep or parent-goal completion is needed. The execution outbox and events retain the original admission and result identities; a settled outbox does not resubmit work on reconnect. Terminal-execution history has its separate configured retention period, measured from the execution's last update. That period does not extend the lifetime of unused queue payloads.

### Active Operator activation display and evidence

Agency → Active Operator displays the configured operation list, current activation percentages, recent assessment trends, reasons, instructions and work states. The operation selection is editable in the graph's Available Autonomy Tasks node; per-mode model role assignments live in the right-sidebar **Server Status** (`Servers & Placement`) panel while graph `Model Router` nodes select the role category. Assessment records remain in durable executions and are projected into the next decision; there is no separate accumulating queue history. Initial unassessed operations have level zero and no assessment date. Semi levels accumulate the model-selected signed adjustments; levels are not automatically raised or reset. Goal Review is still tied to goals and returned evidence, not an idle polling operation. Reflection, daydream and curiosity timers migrated to this owner are removed; Sleep and explicit manual invocation retain their existing owners.
