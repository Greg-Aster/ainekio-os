# Ainekio Robot Bible

This is the shared starting point for understanding Ainekio as a companion.
It defines product intent and links to the capability contracts and the
[software architecture](SYSTEM_ARCHITECTURE.md). Software wiring, implementation
owners and state lifetimes are maintained in that architecture document.
This reference is not a runtime prompt or an instruction to operate the robot.

Navigate: [Purpose](#purpose) · [Functions](#robot-functions) ·
[Design priorities](#design-priorities) · [System map](#system-map) ·
[Maintenance](#working-on-the-robot) · [Evidence](#qualification-and-history).

## Purpose

**Ainekio is a quadruped companion, friend, familiar and assistant who can see,
hear, process experience, respond and learn.** Its identity and relationships
persist across interactions. It should converse, perceive, move and express
itself, explore, play, pursue goals, remember experiences and improve through
reviewed learning.

The owner's acceptance criterion is: “When I say the robot isn't functioning it
means I turn it on and it doesn't act like a companion.” Successful individual
nodes, model calls, services or firmware commands support that outcome; they do
not establish it.

Companionship means participation in a shared life: noticing and responding to
one another, carrying shared experience forward, and contributing initiative
that develops the relationship over time. The
[companion design guidelines](COMPANION_BEHAVIOR.md#companion-design-guidelines)
make this purpose observable through responsiveness, shared context, continuity,
initiative, reciprocity, coherence and personal fit. They guide design and review;
[everyday companion evaluation](QUALIFICATION.md#everyday-companion-evaluation)
connects them to observed interactions across repeated encounters.

The active development scope is **V2: twelve servos, ESP32-P4 and PCA9685 servo
output**. V1 work is paused; its separate eight-servo ESP32-S3 implementation
is retained. The selected body's identity, advertised capabilities and installed
calibration determine what can actually be requested. A session name or an old hardware inventory is
insufficient evidence. See [Ainekio's model boundaries](https://github.com/Greg-Aster/Ainekio-bot/blob/dev/docs/ROBOT_MODELS.md).

## Robot functions

These are intended functions from the existing design, not a claim that each
function has been demonstrated on the current installation.

| Function | What it means for the companion | Existing detail |
| --- | --- | --- |
| Perceive | Hear people, see its surroundings, and receive body and motion measurements with their source and uncertainty | [Body capabilities](BODY_CAPABILITIES.md) |
| Converse and express | Understand attributed input, respond through speech and other supported expression, and retain conversational context | [Companion behavior](COMPANION_BEHAVIOR.md), [body capabilities](BODY_CAPABILITIES.md) |
| Move and interact | Carry out selected physical actions through the selected body's supported capabilities and report observed progress and outcomes | [Body capabilities](BODY_CAPABILITIES.md), [system architecture](SYSTEM_ARCHITECTURE.md) |
| Pursue goals and take initiative | Interpret requests, select meaningful self-directed activity when enabled, and assess outcomes without confusing command acceptance with success | [Companion behavior](COMPANION_BEHAVIOR.md) |
| Remember and maintain continuity | Preserve identity, relationships and attributed experience, then retrieve relevant context in later interactions | [Companion behavior](COMPANION_BEHAVIOR.md) |
| Learn | Turn reviewed experience into evaluated learning artifacts, with activation distinct from recording memories or training | [Models and learning](MODELS_AND_LEARNING.md) |
| Support owner supervision | Expose configuration, manual control, status and evidence through existing interfaces so the owner can understand and direct the system | [System architecture](SYSTEM_ARCHITECTURE.md), [qualification](QUALIFICATION.md) |

## Design priorities

- Models interpret requests and evidence, select relevant context, choose behavior
  and assess outcomes. Code exposes capabilities, executes selections and preserves
  accurate attribution and results.
- Model-backed functions use visible, editable node workflows. Model roles describe
  inference responsibilities; concrete deployments and adapters are configuration.
- Speech, sensing, movement and independent work can overlap where the body and
  providers support it. Requested ordering and actual data dependencies remain
  meaningful; a reply about an action needs that action's evidence.
- **Full Auto continuously chooses and carries out meaningful self-directed
  activity while enabled.** It can muse, reason, pursue tasks, trigger agents,
  move, or run the Sleep workflow. Doing nothing, returning no operation,
  repeatedly assessing without activity, and waiting for an external event to
  resume are not valid Full Auto behavior. The model chooses the activity;
  selected work progresses independently of subsequent assessments. See the
  [Full Auto contract](COMPANION_BEHAVIOR.md#full-auto-continuity--owner-contract).
- Conversation can be valuable without creating a physical task or a durable goal.
- Persona, recent buffers, persistent memories and learned parameters have distinct
  roles. Relevant selected context retains speaker, source, time and uncertainty;
  imagined material does not become an observed event.
- Each responsibility has one implementation owner. Repairs correct that owner and
  affected consumers, including removal of superseded paths. Repository instructions
  govern changes to prompts, contracts, runtime restrictions and physical behavior.
- Responsiveness and useful learning require measured outcomes. Local Body Control,
  Q6A and remote compute placement depend on actual capacity and latency. The owner
  can inspect and steer the system through its existing interfaces and diagnostics.

## System map

[Robot software architecture](SYSTEM_ARCHITECTURE.md) is the current software map
across Ainekio OS, Body Control and the V2 body. It owns the diagrams, process and
interface descriptions, execution paths, implementation owners and state lifetimes.
Its [distribution section](SYSTEM_ARCHITECTURE.md#intended-boundaries-and-remaining-distribution-work)
links to the separate proposals for work across multiple computers.

## Working on the robot

Use the affected capability contract linked in [Robot functions](#robot-functions),
then follow its implementation in the [architecture](SYSTEM_ARCHITECTURE.md).
[Ainekio's authority map](https://github.com/Greg-Aster/Ainekio-bot/blob/dev/docs/README.md) links the selected body's
hardware and protocol specifications. The [repair design](../technical/REFACTOR_BLUEPRINT.md#repair-design)
owns the change method; [qualification walkthroughs](QUALIFICATION.md#maintenance-walkthroughs)
connect each repair to its existing checks.

## Keeping the reference coherent

Update companion purpose here, software wiring in the architecture, and a
capability's behavior at its linked contract. Reference those owners rather than
copying their diagrams, source inventories or maintenance procedures into this page.
Keep review checkpoints, measurements and repair history in dated evidence.

## Qualification and history

[Qualification](QUALIFICATION.md) distinguishes source implementation, software
tests, live model decisions and physical outcomes, and defines observable
companion acceptance. Documentation changes do not establish robot functionality.

The [supervised walkthrough and repair record](history/2026-11-03-supervised-walkthrough.md)
retains the existing file explanations, decisions, unresolved questions and review
coverage. The [October reference](history/2026-10-26-robot-reference.md) retains the
earlier design and troubleshooting record. These are dated evidence; the
architecture and linked capability contracts describe the maintained system.
