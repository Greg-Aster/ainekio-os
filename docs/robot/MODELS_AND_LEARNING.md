# Models and learning

[Roles and providers](#roles-backends-and-delegated-computer-work) · [Learning](#learning-and-personalization) · [Learned persona](#intended-model-specialization-and-learned-persona) · [Training by mode](#conversational-training-by-cognitive-mode)

[Start with the robot design core](ROBOT_BIBLE.md). Read this for role separation, model selection, learning and persona-review intent.

[Model roles](../../packages/core/src/model-roles.ts) own category definitions;
[specialist training](../../brain/training/environment-action-selector/README.md)
and existing Core training owners retain their executable contracts.

This page states the maintained capability contract. It does not report current
service state, selected weights or installed firmware. Use the linked owners for
configuration and [qualification](QUALIFICATION.md) for proof of behavior.
Dated deployments, comparisons and incidents are retained in the
reference history (retained locally).
A historical success or failure is evidence under its recorded conditions;
refresh those conditions before treating it as the present state.

## Models and learning

### Roles, backends, and delegated computer work

- **Role catalog and assignments:** Category names, IDs and descriptions live in [`packages/core/src/model-roles.ts`](../../packages/core/src/model-roles.ts). Graph nodes select the category they need; the status widget assigns concrete deployments and optional LoRA adapters per profile and cognitive mode through Model Registry/Router. Multiple adapter assignments share one base deployment. `orchestrator` is the single program-wide input-routing category (preserving each mode's Intent assignment, including the trained Environment specialist).
- **Role boundaries:** Complex planning (`planner`), concrete task selection (`environmentActionSelector`), visual planning (`environmentVision`), independent review (`psychotherapist`), autonomous assessment (`autonomy`), fast event reactions (`lightweight`), and conversational expression (`persona`) remain distinct responsibilities. Selecting Persona does not automatically inject the full persona prompt, and selecting Psychotherapist for Desire review does not grant Desire Agent persona-editing authority. Image input stays on the selected category and provider rather than silently falling back to `orchestrator`.
- **Shared llama.cpp residency:** App startup can start this computer's shared `llama-cpp.service` via `bin/llama-cpp-services` without loading weights into memory. Co-located MetaHuman and Freestyle clients share that service (0.8B specialists share one base deployment and select LoRAs per request; Q6A uses its own service when hosting Body Control inference; Embedder demand-loads on CPU per its preset). Inference requests demand-load the assigned deployment and adapter; native llama.cpp unloads idle weights after five minutes. Health checks and opening the model inventory do not load or retain weights, and stopping MetaHuman or Body Control leaves `llama-cpp.service` running. See [shared llama.cpp hosting](SYSTEM_ARCHITECTURE.md#shared-llamacpp-hosting).
- **Big Brother and Codex calls:** Big Brother ([`docs/technical/BIG_BROTHER.md`](../technical/BIG_BROTHER.md)) is both a selectable role deployment and a terminal/tool provider for delegated computer work or diagnostics. Ordinary Codex-backed model calls preserve graph message roles, image positions, and the graph's system instructions without injecting repository coding rules, Codex personal memories or skills; diagnostic and delegated computer-work sessions keep their agent context.
- **Reasoning configuration:** Supported model-calling nodes expose a Reasoning checkbox mapped through Model Router. Full Autonomy assessments request high reasoning via the connected mode input; Semi assessments and ordinary operational calls request none unless explicitly overridden on the node.

### Learning and personalization

The learning loop is **original inputs and outputs + separately attributed outcomes → review/curation and corrections → training data → fitting → independent evaluation → authorized activation → observed behavior**. Saving an example, completing a training run, and activating an evaluated artifact are separate steps.

### Intended model specialization and learned persona

- **Specialist adapters:** Local operation uses trained specialists for Intent and Task decisions alongside larger models for conversation and complex planning. The Environment training evidence reader supplies the original admitted request, ordered execution evidence, current objective state and saved decision identities (using lossless initial-observation/change records with image timestamps) to the Curator workflow. Retraining uses the selected adapter's recorded base and native checkpoint stage through the existing trainer; activation requires independent evaluation and owner approval.
- **Learned persona direction:** Prompt-based persona injection is a bootstrap mechanism. As reviewed Environment conversations accumulate, the personalization pipeline is intended to train and evaluate Ainekio's identity and expression in conversational model weights or a LoRA so the full persona description no longer needs to be injected into every conversational call (while task instructions, memories and robot status remain supplied per operation).

### Conversational training by cognitive mode

The cognitive mode recorded when a conversation occurred determines whose reply personalization learns:

| Recorded cognitive mode | Reply to learn | Purpose |
| --- | --- | --- |
| Dual Consciousness | Greg's human reply | Learn the human's expression and response patterns from their own contributions. |
| Environment | Ainekio's assistant reply | Improve the robot companion's conversational responses from its reviewed interactions. |

- **Provenance and pairing:** Saved conversational records and background-generated memories preserve their originating cognitive mode at work admission, actual speaker/role, and the explicit link between a user message and each asynchronous reply (including separate review acknowledgments). Curation and dataset builders use the exact reviewed request/reply pair and recorded mode rather than reinterpreting earlier records from the currently selected UI mode. Agent and Emulation modes do not infer a training policy from these two mappings.
- **Persona-review subject:** Psychotherapist develops Ainekio's own personality while keeping facts about Greg as separately attributed memories; learning a reply style for a mode never relabels the human's circumstances as the companion's identity.

Sources: [specialist training](../../brain/training/environment-action-selector/README.md), [training configuration](../../packages/core/src/training-config.ts), [training dataset owner](../../packages/core/src/training-dataset.ts), [model router](../../packages/core/src/model-router.ts), [backend owner](../../packages/core/src/llm-backend.ts).
