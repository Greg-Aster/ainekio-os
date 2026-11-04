# Robot software architecture

This is the canonical software map for **V2** across Ainekio and MetaHuman:
processes, interfaces, execution paths and state owners. V1 work is paused.
Source paths were traced on **2026-10-26**; this is not a claim that every
checkout change is deployed.
The [design core](ROBOT_BIBLE.md) owns product intent; [V2 specifications](../../../Ainekio/docs/v2-12servo/SPECIFICATIONS.md)
own the physical assembly. Read this page before changing robot software.

The Bible links the intended capability contracts; this page owns their software
wiring. The [supervised walkthrough](history/2026-11-03-supervised-walkthrough.md)
retains dated file-review and repair evidence, separate from this map.

## Processes and connections

The diagrams below separate the overview from the implementation details.
Follow the labels on the arrows to see what passes between components. Blue
boxes are interfaces, purple boxes are application code, teal boxes are model
or persistent services, amber boxes are hardware and green boxes are stored data.

- [System overview](#system-overview)
- [User interfaces](#user-interfaces)
- [Engine functions](#engine-functions)
- [Agent scheduling and services](#agent-scheduling-and-services)
- [Agent jobs and robot workflows](#agent-jobs-and-robot-workflows)
- [Body Control and movement](#body-control-and-movement)
- [Voice input and speech output](#voice-input-and-speech-output)
- [Model and embedding services](#model-and-embedding-services)
- [Stored data and training](#stored-data-and-training)

### System overview

Start here. Each box is expanded in a diagram below. Arrows name the information crossing between systems. They do not show live execution.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart TB
  H((Human)):::human
  UI["Browser or terminal"]:::ui
  MH["MetaHuman OS<br/>Conversations, memory and tasks"]:::software
  MODELS["Model services<br/>Text, vision and embeddings"]:::service
  BR["Environment Bridge"]:::software
  BC["Body Control<br/>Python application"]:::software
  DASH["Body Control dashboard"]:::ui
  P4["P4 controller and robot hardware"]:::hardware
  H <-->|"Text, controls and replies"| UI
  UI <-->|"Requests and results"| MH
  MH <-->|"Model input and output"| MODELS
  MH <-->|"Actions, observations and results"| BR
  BR <-->|"Authenticated robot connection"| BC
  H <-->|"Manual controls and feedback"| DASH
  DASH <-->|"Dashboard requests and status"| BC
  BC <-->|"Commands, audio and telemetry"| P4
  H -->|"Voice"| P4
  P4 -->|"Speech, expressions and movement"| H
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### User interfaces

The conversation screen, workflow editor and architecture map run in the browser. Svelte Flow draws the two node canvases; the engine executes workflow graphs.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart TB
  H((Human)):::human
  subgraph BROWSER["Web browser"]
    CHAT["Conversation interface<br/>Messages and replies"]:::ui
    EDIT["Workflow editor<br/>Svelte Flow"]:::ui
    MAP["Architecture map<br/>Svelte Flow"]:::ui
  end
  WEB["Astro web server<br/>Node.js · apps/site/"]:::software
  CLI["mh terminal CLI<br/>Node.js · packages/cli/"]:::ui
  MOBILE["Android app<br/>React Native and WebView"]:::ui
  LOCAL["Android local server<br/>Embedded Node.js"]:::software
  CORE["Shared engine library<br/>packages/core/src/"]:::software
  H <-->|"Messages and replies"| CHAT
  H <-->|"Graph edits and run results"| EDIT
  H <-->|"Diagram selection and descriptions"| MAP
  CHAT <-->|"Chat jobs and response streams"| WEB
  EDIT <-->|"Load, save and execute graphs"| WEB
  MAP <-->|"Page files and read-aloud audio"| WEB
  H <-->|"Commands and text results"| CLI
  H <-->|"Touch controls and device input"| MOBILE
  MOBILE <-->|"App-local HTTP"| LOCAL
  WEB <-->|"Engine calls and results"| CORE
  CLI <-->|"Engine calls and results"| CORE
  LOCAL <-->|"Shared HTTP API adapter"| CORE
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### Engine functions

Core is a TypeScript library used by the server, CLI and workers. The branches below are available functions, not steps that every request must run.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart TB
  ENTRY["API handlers and library exports"]:::software
  ACCESS["Profiles and access<br/>User, session and settings"]:::software
  QUEUE["Tasks and execution records<br/>Queue, progress and results"]:::software
  GRAPH["Workflow execution<br/>Run graph nodes"]:::software
  CONTEXT["Context and persona<br/>Build model input"]:::software
  MEMORY["Memory and recall<br/>Save and retrieve records"]:::data
  AGENCY["Goals and desires<br/>Evidence, plans and outcomes"]:::data
  ROUTER["Model routing<br/>Role, provider and adapter"]:::software
  PROVIDER["Configured model provider"]:::service
  TOOLS["Computer tools and sessions"]:::software
  VOICE["Speech requests and delivery"]:::software
  ROBOT["Robot capabilities and feedback"]:::software
  LEARNING["Learning and model management<br/>Datasets, training and adapters"]:::software
  ENTRY <-->|"Account and profile lookup"| ACCESS
  ENTRY <-->|"Submit work and read results"| QUEUE
  QUEUE <-->|"Run inputs, outputs and cancellation"| GRAPH
  GRAPH <-->|"Selected context"| CONTEXT
  CONTEXT <-->|"Search and matching memories"| MEMORY
  CONTEXT <-->|"Current desires and evidence"| AGENCY
  GRAPH <-->|"Model request and response"| ROUTER
  ROUTER <-->|"Provider protocol"| PROVIDER
  GRAPH <-->|"Tool calls and output"| TOOLS
  GRAPH <-->|"Audio, text and delivery results"| VOICE
  GRAPH <-->|"Actions and observations"| ROBOT
  ENTRY <-->|"Training requests and artifacts"| LEARNING
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### Agent scheduling and services

Individual agent jobs run in workers. Persistent services have their own processes. A trigger submits work; the engine queue executes it.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart TB
  CATALOG["Agent Catalog<br/>List and register agents"]:::software
  CONFIG["Agent and service settings<br/>etc/agents.json · etc/services.json"]:::data
  TRIGGER["Trigger Manager<br/>Time, event or manual request"]:::software
  QUEUE["Engine queue"]:::software
  JOB["Agent job execution<br/>Worker calls an agent module"]:::software
  SLEEP["Sleep Workflow<br/>Submit and track cycle stages"]:::software
  LIFE["Service process lifecycle<br/>Start processes and record exits"]:::software
  MONITOR["Agent Monitor<br/>Status, logs and failures"]:::software
  OP["Active Operator<br/>Assess robot activity"]:::service
  BR["Environment Bridge<br/>Carry body commands and feedback"]:::service
  TERM["Terminal service<br/>Shell and provider sessions"]:::service
  MAINT["Maintenance service<br/>Stale locks and audit retention"]:::service
  CATALOG -->|"Job registrations"| TRIGGER
  CONFIG -->|"Trigger settings"| TRIGGER
  TRIGGER -->|"Due jobs"| QUEUE
  QUEUE <-->|"Job inputs and results"| JOB
  QUEUE <-->|"Sleep stages and outcomes"| SLEEP
  CONFIG -->|"Service settings"| LIFE
  LIFE -->|"Start and stop"| OP & BR & TERM & MAINT
  OP -->|"Selected autonomy work"| QUEUE
  JOB -->|"Job status"| MONITOR
  LIFE -->|"Process status"| MONITOR
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### Agent jobs and robot workflows

The queue selects the required job. These branches are alternatives, not a sequence. Source implementations are in `brain/agents/`; robot workflow nodes are in `packages/core/src/nodes/robot-operator/`.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart LR
  JOB["Selected agent job"]:::software
  MEM["Memory agents<br/>Ingest files and transcripts;<br/>add tags and metadata"]:::software
  TRAIN["Training agents<br/>Curate examples;<br/>train and evaluate adapters"]:::software
  THOUGHT["Thought and dreaming agents<br/>Reflector, Train of Thought,<br/>Daydreamer and Dreamer"]:::software
  CURIOSITY["Curiosity agents<br/>Generate and investigate questions"]:::software
  PERSONA["Persona agents<br/>Psychotherapist and Mood"]:::software
  DESIRE["Desire Agent<br/>Review desires and plans;<br/>call internal Desire Planner"]:::software
  UTILITY["Profile and body-event jobs<br/>Synchronize data or analyze an event"]:::software
  RESULT["Saved result or error"]:::data
  OP["Active Operator"]:::service
  WORKFLOWS["Robot workflows<br/>Robot Status, Autonomy Controller,<br/>Goal Review and boredom workflows"]:::software
  JOB --> MEM & TRAIN & THOUGHT & CURIOSITY & PERSONA & DESIRE & UTILITY
  MEM & TRAIN & THOUGHT & CURIOSITY & PERSONA & DESIRE & UTILITY --> RESULT
  OP <-->|"Context, activation and goal review"| WORKFLOWS
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### Body Control and movement

Body Control runs on the desktop or robot-local host. Its generator is a separate HTTP service. Firmware executes physical commands; returned feedback establishes what happened.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart TB
  BR["MetaHuman Environment Bridge"]:::service
  DASH["Body Control dashboard<br/>Browser · port 8791"]:::ui
  ADAPTER["Environment adapter<br/>/environment · port 8790"]:::software
  GW["GatewayService<br/>Robot sessions and command transport"]:::software
  EXEC["Freestyle executor<br/>Compile and execute a program"]:::software
  GEN["Freestyle generator<br/>HTTP · port 8794"]:::service
  MODEL["Host-local llama.cpp<br/>Shared 0.8B base + Freestyle LoRA"]:::service
  P4["P4 firmware<br/>/robot connection · port 8790"]:::hardware
  OUT["PCA9685 and servos<br/>LCD and speaker"]:::hardware
  SENSORS["Camera, IMU and joint feedback"]:::hardware
  BR <-->|"Actions, observations and receipts"| ADAPTER
  DASH <-->|"Manual controls and status"| GW
  ADAPTER <-->|"Translated commands and results"| GW
  GW <-->|"Movement request / compiled commands and results"| EXEC
  EXEC <-->|"Movement description and program"| GEN
  GEN <-->|"Prompt and generated program"| MODEL
  GW <-->|"Commands, receipts and telemetry"| P4
  P4 -->|"Targets, expressions and audio"| OUT
  SENSORS -->|"Images and measurements"| P4
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### Voice input and speech output

Input and output can overlap other work. Output follows the selected audio destination. These paths share the existing speech clients; they do not require every destination to play.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart TB
  H((Human)):::human
  MIC["Robot microphone"]:::hardware
  BODY["P4, Body Control and Bridge<br/>Transport robot audio"]:::software
  INPUT["MetaHuman STT client"]:::software
  STT["Whisper STT<br/>HTTP · 9883"]:::service
  ENGINE["MetaHuman speech input and workflows"]:::software
  TTS["Kokoro TTS<br/>HTTP · 9882"]:::service
  DELIVERY["Speech delivery<br/>Selected destination"]:::software
  BROWSER["Browser speakers"]:::ui
  HOST["Body Control computer speakers"]:::hardware
  ROBOT["Robot speaker"]:::hardware
  H -->|"Voice"| MIC
  MIC -->|"Captured audio"| BODY
  BODY -->|"Captured utterance"| INPUT
  INPUT -->|"Audio for transcription"| STT
  STT -->|"Transcript"| INPUT
  INPUT -->|"Transcribed message"| ENGINE
  ENGINE -->|"Reply text and voice settings"| TTS
  TTS -->|"Generated audio"| DELIVERY
  DELIVERY -->|"Browser playback"| BROWSER
  DELIVERY -->|"Host audio playback"| HOST
  DELIVERY -->|"Audio via Bridge and P4"| ROBOT
  BROWSER & HOST & ROBOT -->|"Spoken reply"| H
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### Model and embedding services

One llama.cpp service per computer exposes model aliases. Native workers load the selected weights. The installed desktop presets use GPU offload for generation and CPU inference for embeddings; Q6A has its own host settings.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart LR
  ROUTER["MetaHuman model routing"]:::software
  MOTION["Freestyle generator"]:::software
  LLAMA["llama.cpp HTTP API<br/>8080 · native model workers"]:::service
  Q9["Qwen3.5 9B<br/>Text and vision"]:::service
  ENV08["Environment 0.8B<br/>Selected role adapter"]:::service
  ENV2["Environment 2B<br/>Selected role adapter"]:::service
  FQ["Freestyle Qwen<br/>Motion programs"]:::service
  EQ["Qwen3 Embedding 0.6B<br/>CPU · 1024 dimensions"]:::service
  EN["Nomic Embed Text v1.5<br/>CPU · 768 dimensions"]:::service
  CODEX["Codex / Big Brother<br/>App-server session"]:::service
  OLLAMA["Ollama<br/>HTTP · 11434"]:::service
  RUNPOD["RunPod Serverless<br/>Configured remote endpoint"]:::service
  ROUTER <-->|"Text, images or embedding input / output"| LLAMA
  MOTION <-->|"Motion prompt and program"| LLAMA
  LLAMA <--> Q9 & ENV08 & ENV2 & FQ & EQ & EN
  ROUTER <-->|"Selected provider request / result"| CODEX
  ROUTER <-->|"Selected provider request / result"| OLLAMA
  ROUTER <-->|"Selected provider request / result"| RUNPOD
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

### Stored data and training

Boxes for stored data represent files or databases, not servers. Training produces candidates; deployment and model selection determine what runs in inference.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"background":"#0f172a","primaryColor":"#29233e","primaryTextColor":"#ede9fe","primaryBorderColor":"#b39aef","lineColor":"#94a3b8","edgeLabelBackground":"#17202d","clusterBkg":"#151e2c","clusterBorder":"#526176","titleColor":"#e2e8f0","fontSize":"16px"},"flowchart":{"nodeSpacing":20,"rankSpacing":35,"useMaxWidth":true}}}%%
flowchart TB
  CONFIG["Configuration and graph files<br/>Models, agents and workflows"]:::data
  CORE["Engine, workflows and agents"]:::software
  PROFILES["Profile data<br/>Persona, conversations and memories"]:::data
  WORK["Durable work records<br/>Progress and result delivery"]:::data
  INDEX["Recall index<br/>Memory vectors and references"]:::data
  EMBED["Selected embedding model"]:::service
  PERSONAL["Personalization training<br/>Reviewed profile examples"]:::software
  ACTION["Action-selector training<br/>System dataset and held-out cases"]:::software
  ARTIFACTS["Training artifacts<br/>Datasets, evaluations and adapters"]:::data
  SELECT["Deployment and model settings"]:::data
  CONFIG -->|"Settings and saved graph definitions"| CORE
  CORE <-->|"Read and write profile records"| PROFILES
  CORE <-->|"Job state and receipts"| WORK
  CORE <-->|"Search and matching records"| INDEX
  INDEX <-->|"Text and vectors"| EMBED
  PROFILES -->|"Reviewed training examples"| PERSONAL
  PERSONAL -->|"Candidate files and reports"| ARTIFACTS
  ACTION -->|"Candidate files and reports"| ARTIFACTS
  ARTIFACTS -->|"Explicit deployment and selection"| SELECT
  SELECT -->|"Active model and adapter assignment"| CORE
  classDef human fill:#263344,stroke:#cbd5e1,color:#f1f5f9
  classDef ui fill:#172d47,stroke:#60a5fa,color:#dbeafe
  classDef software fill:#29233e,stroke:#b39aef,color:#ede9fe
  classDef service fill:#153638,stroke:#5eead4,color:#ccfbf1
  classDef hardware fill:#382d1b,stroke:#fbbf24,color:#fef3c7
  classDef data fill:#263126,stroke:#86c995,color:#dcfce7
```

The [Svelte Flow map](http://127.0.0.1:4321/architecture) remains available in the
Site application; its [implementation notes](../../apps/site/src/components/architecture-map/README.md)
describe that separate viewer.

The diagrams show configured paths, not live health or deployment status. The
[placement table](#shared-llamacpp-hosting) below explains the desktop/Q6A split.
Desktop loopback addresses refer to the desktop; with Body Control on Q6A, its
generator uses Q6A's own configured llama.cpp service.
Core's speech functions own the Whisper/Kokoro clients. Audio destinations follow
the existing [speech selection](BODY_CAPABILITIES.md#listening-and-speaking).

Sources: the selected profile's `etc/models.json` and `etc/operator.json`, resolved
through the [profile registry](../../packages/core/src/model-resolver.ts);
[backend configuration](../../etc/llm-backend.json),
[voice service configuration](../../etc/voice-servers.json),
the [embedding request owner](../../packages/core/src/embeddings.ts),
the [native llama.cpp provider](../../packages/core/src/providers/llama-cpp.ts),
and [deployment configuration](../../etc/deployment.json). Profile credentials and
RunPod endpoint identifiers are not copied here. The
[Freestyle service definition](../../../Ainekio/experiments/freestyle/ainekio-freestyle-api.service)
owns the motion-model endpoint configuration.

**Body Control is a Python application.** Its [composition root](../../../Ainekio/Master/gateway/server/__main__.py)
creates GatewayService, the environment adapter, camera processing, gait learning
and the dashboard HTTP thread. These responsibilities run inside that
application. Freestyle's generator is a separate HTTP service; its executor is
loaded by the dashboard into the gateway application. The browser does not run
the motion executor.

**MetaHuman OS is a software system, spanning multiple processes and clients.**
Its boundary identifies software ownership, not a single process or computer.
Core is a shared TypeScript library imported by the server, CLI and workers.
Finite agent jobs run in worker subprocesses; persistent services have separate
process lifecycles. The maintained Android app embeds its own Node.js HTTP server
and shared Core API adapter. Configuration, stored state and explicitly launched
training tools are also part of the system.

The browser displays chat, controls,
settings and status, with Svelte providing interactive components. It sends HTTP
requests to the Astro web server running on Node.js, which calls the MetaHuman
engine. The terminal program runs `mh` commands using Node.js and calls the same
engine library in `packages/core/src/`. Hosting the web
server on another computer changes its location, not its Node.js runtime.
Brain supplies finite agent adapters and persistent service entrypoints.
Environment Bridge is a persistent process supervised through the Agent Catalog
and Agent Monitor. Model servers can run locally or remotely; assigning a model
does not move the task's durable state to that server.

| Connection | Endpoint / owner |
| --- | --- |
| Robot → Body Control | Robot initiates authenticated `/robot`, default port **8790**; gateway assigns session epochs and command sequences |
| Operator → Body Control | Dashboard HTTP, default **8791**, independent of MetaHuman's web UI |
| Bridge → Body Control | Authenticated `/environment` on **8790**; gateway accepts loopback peers. Remote SSH/Cloudflare forwarding terminates there |
| Bridge ↔ MetaHuman Core | Authenticated `/api/environment-bridge/*`: observation and result POSTs; `/stream` carries outbound work |
| Freestyle executor → generator | Configured HTTP endpoint, default `127.0.0.1:8794`; generator calls its configured model backend |

These are bidirectional information paths, not a mandatory execution sequence.
Speech, sensing, motion and inference can overlap. For an existing installation,
use the [startup guide](../../../Ainekio/docs/STARTUP.md); Ainekio's root simulator
launcher is not the physical V2 startup path.

## Shared llama.cpp hosting

Each computer needing local llama.cpp inference has one `llama-cpp.service` and
one host-local native model preset, conventionally
`~/.config/llama.cpp/models.ini`. Systemd owns the host service lifetime;
[`bin/llama-cpp-services`](../../bin/llama-cpp-services) is its installation/start
entrypoint. The installed unit executes the native `llama-server` binary directly,
so neither MetaHuman nor Body Control must be running to serve inference. The
binary may be installed anywhere on that computer; a path inside a checkout does
not require that application to run.

Model Resolver/Registry retain role assignments, capabilities, model aliases,
endpoint placement and request-local LoRA selection. The provider bridge and
[`providers/llama-cpp.ts`](../../packages/core/src/providers/llama-cpp.ts) transport
MetaHuman requests. Freestyle's [generator](../../../Ainekio/experiments/freestyle/generator.py)
retains motion input construction and result decoding and calls `/v1` directly.
It remains distinct from its compiler, executor and durable recordings. There is
no additional application-level model router, process supervisor or inference queue.

| Arrangement | MetaHuman client | Freestyle generator client |
| --- | --- | --- |
| Both applications on desktop | Desktop service root, e.g. `http://127.0.0.1:8080` | Same desktop listener plus `/v1`; selects its motion alias |
| MetaHuman on desktop, Body Control on Q6A | Configured desktop service | Q6A's own service plus `/v1`; Q6A loopback refers to Q6A, not the desktop |

The host preset has one section per existing deployment, with absolute artifact
paths, explicit original aliases, `load-on-startup = false`, and all of that
model's existing context, mmproj, KV, GPU, parallelism, reasoning, sampling and
LoRA initialization settings. These settings must not move to global router
arguments where they would override another model. Preserve each model's idle
policy; this installation's MetaHuman models retain native five-minute sleep.
Native demand loading and idle sleep own weight residency. Inventory and health
reads do not load weights; model-qualified properties/adapter reads can load the
selected worker. The service uses `--models-max 0` so consolidation does not add
a model-count eviction limit across previously independent deployments. Actual
hardware memory and native per-model capacities still apply.

One service/API owner does **not** mean one OS PID: native router mode starts
native inference workers. Distinct model weights still consume their own memory;
sharing a listener does not establish a weight-memory saving. The CPU/CUDA repair
and regression for the installed adaptive-KV build are retained in
[`shared-host-kv.patch`](../../external/llama.cpp/shared-host-kv.patch), alongside
the existing native cancellation patch. CUDA demand allocation applies to CUDA
buffers; CPU presets retain normal native CPU allocation.

The native [number-sign schema patch](../../external/llama.cpp/json-schema-number-sign.patch)
enforces positive and negative nonzero numeric schema constraints, including
fractions and exponents. Semi uses these constraints to generate activation
adjustments that can change the retained level; Core's parser applies the
adjustment and checks the resulting transition.

To install the same host service on either computer, prepare its native preset
from that installation's actual model settings, then run the existing installer
from the MetaHuman checkout (the installed service has no application dependency):

```sh
./bin/llama-cpp-services install /absolute/path/to/llama-server \
  --models-preset /absolute/path/to/models.ini \
  --host 127.0.0.1 --port 8080 --models-max 0
systemctl --user start llama-cpp.service
```

Before converting an older installation, transcribe effective unit/drop-in model
settings into that preset. Disable and remove superseded model units and their
launch overrides, then install the shared unit. The removed per-model `serve`
operation is no longer accepted. App startup can idempotently start only the
known host unit for a selected loopback deployment; it does not scan units,
choose a model process or load weights. Remote endpoints are owned by their
configured computer. Freestyle's generator unit uses `Wants=llama-cpp.service`
without ordering, `PartOf` or `BindsTo`; requests follow native loading readiness.

Stopping either application leaves the host service and the other client's
inference intact. Host maintenance explicitly uses
`systemctl --user stop|restart llama-cpp.service` and affects all its clients.
Changing model presets or binary settings is host maintenance, separate from
changing role assignments. Native inventory reload (`/models?reload=1`) can
unload changed presets; do not mistake it for a read-only inventory operation.
Adapter discovery includes `?model=...`; inference carries the selected model
and per-request `lora` list. Clients do not mutate global adapter scales.

### Native embeddings and indexes

The Embedder role calls `/v1/embeddings` through the same native service as text,
vision and motion. The two existing GGUF aliases remain: Qwen3 Embedding 0.6B
(1024 dimensions, last-token pooling) and Nomic Embed Text v1.5 (768 dimensions,
mean pooling). Their host-local presets use `device = none` and `gpu-layers = 0`;
this preserves CPU placement for weights and operation workspaces. Both use
native L2-normalized vectors and native model capacities: 32768 tokens for Qwen
and 2048 for the installed Nomic artifact. There is no application character
truncation or secondary service fallback on this path.

The previous node-llama-cpp package, process manager, launchers, optional generation
branch, management API and duplicate settings/status controls are retired.
Its optional generator had no registered model consumer or installed default
artifact; generation remains with the existing native provider. Mobile Core is
also a client of its configured native endpoint rather than a launcher of that
retired Node host. An actual native mobile deployment is a separate unverified
boundary; no desktop dependency is substituted for a configured local host.

Native vectors can differ numerically from the retired engine. Existing vector
index compatibility checks remain intact. Rebuild affected indexes through
`vector-index.ts`'s existing refresh owner from original memory content; do not
relabel old vectors as new native output. The migration preserves memory files,
model artifacts and unrelated provider indexes. The existing Model Registry
Embedder selector is the configuration surface; native presets own installation
and model serving.

## Follow an operation

### A request to move

1. Human input or an admitted autonomous intention reaches
   [`environment-mode.json`](../../etc/cognitive-graphs/environment-mode.json).
   Intent selects relevant context; Task Decision selects a program. The graph
   can use current execution, conversation, persona, memory and robot observations.
2. [`robot-active-task-mode.json`](../../etc/cognitive-graphs/robot-active-task-mode.json)
   advances that program inside the existing durable execution. Its
   [Active Task node](../../packages/core/src/nodes/environment/active-task.node.ts)
   uses Core's [environment contract/store](../../packages/core/src/environment-interface/)
   to admit actions and retain their identities.
3. [Environment Bridge](../../brain/agents/environment-bridge/core.ts) consumes
   Core's stream and sends the action to the gateway's
   [environment adapter](../../../Ainekio/Master/gateway/environment_adapter/server.py).
   The adapter translates the semantic request and correlates its result.
4. For `requestMotion.description`,
   [`GatewayService.request_motion`](../../../Ainekio/Master/gateway/server/service.py)
   calls the [Freestyle executor](../../../Ainekio/experiments/freestyle/bridge.py).
   Its [generator](../../../Ainekio/experiments/freestyle/generator.py) produces a
   motion program from the request and observations. The executor compiles and
   submits targets through the same gateway connection.
5. P4's [controller](../../../Ainekio/Slave/firmware/esp32p4-wifi6/main/controller.c)
   receives the wire command. Its [body executor](../../../Ainekio/Slave/firmware/esp32p4-wifi6/main/body.c)
   owns motion progress, calibrated output and measured target tracking; the
   [PCA9685 driver](../../../Ainekio/Slave/firmware/esp32p4-wifi6/components/ainekio_pca9685/pca9685.c)
   writes servo signals. LLM token generation does not clock servo frames.
6. Firmware receipts and telemetry return through GatewayService, adapter and
   Bridge to the same Core action/execution. Active Task consumes them; the
   [Goal Review graph](../../etc/cognitive-graphs/robot-goal-review-mode.json)
   assesses an eligible unfinished objective. Submission, execution completion
   and achievement of a physical goal are different results.

**Motion ownership:** Freestyle owns description-based motion, startup/wake and
first-stall correction requests. Inactivity rest/release is body-local, as
defined in [the motion contract](BODY_CAPABILITIES.md#motion-and-posture). The manual Motion Library selector affects
explicit manual controls; it does not redirect MetaHuman requests. Native motion
and low-level manual controls remain available through the same P4 owners.
MetaHuman has no active joint-generation workflow. An unavailable generator is
reported; a library movement is not silently substituted. See the
[Freestyle contract](../../../Ainekio/experiments/freestyle/README.md) for its model,
compiler, training and deployment dependencies.

### Contracts at the handoffs

| Boundary | Responsibility and reason | Behavior a change must preserve |
| --- | --- | --- |
| Graph → Core execution | Graphs compose model-selected behavior; Core owns admission and durable progress, so a second agent cannot independently claim the same objective | Preserve execution/effect/work identities, selected ordering and independent concurrent work; a graph return is not automatically goal completion |
| Core → Bridge → adapter | Core owns the requested action; Bridge transports it; the adapter translates it for the selected body | Preserve action identity, body ownership, admission, cancellation and results across reconnect; transport code does not reinterpret the goal |
| Gateway → Freestyle → P4 | Freestyle turns semantic motion into a program; gateway sends it; P4 owns physical execution and calibration | Generation failure is reported; manual library selection does not redirect semantic requests; generated targets are not measured positions |
| P4 → Core | Device and gateway evidence establishes progress and outcomes; Core correlates it to the originating work | Acceptance, termination, failure, unknown outcome and goal achievement remain distinguishable |
| Core → UI / model context | UI projects state and models receive attributed evidence | Preserve source, speaker, time and uncertainty; displaying success cannot create a receipt |

These boundaries keep body-specific execution out of cognition and task decisions
out of transports. The executable schemas remain in the [protocol](../../../Ainekio/Slave/software/protocol/README.md)
and [Core environment types](../../packages/core/src/environment-interface/types.ts);
do not copy their changing field inventories here. Model joint positions, physical
socket mappings and electrical units come from the [V2 specifications](../../../Ainekio/docs/v2-12servo/SPECIFICATIONS.md#joints-units-and-calibration).

Core's durable execution/effect identity is associated with Coordinator work and
the adapter action. The gateway then records the Freestyle job or robot session
and sequence that actually received it. A reconnect resumes delivery by those
identities; it is not a new movement request. Cancellation and manual takeover
must address the original work even if selection has changed. A successful Stop
command does not retroactively prove an earlier movement's outcome. The
[paired qualification](QUALIFICATION.md#cancellation-and-reconnect) exercises this
boundary with a simulated body.

### Hearing, speaking, seeing and body events

- **Hearing:** P4 microphone capture → gateway audio transport → Environment Bridge
  transcription through Core's STT owner → attributed observation → Environment
  Mode. A transcript and a body sensor event retain different source identities.
- **Speaking:** graph response → Core [robot speech delivery](../../packages/core/src/tts/robot-speech.ts)
  and configured TTS → Bridge → gateway speech transport → selected robot or host
  playback. Playback receipts return to the originating work. Browser audio uses
  the existing browser delivery selection.
- **Seeing:** P4 camera frames → gateway [camera plugin](../../../Ainekio/Master/gateway/plugins.py)
  and configured [perception owner](../../../Ainekio/Master/gateway/perception.py) →
  adapter/Bridge → selected graph image or observation. Acquisition, recognition,
  metric estimates and retained image identity are separate contracts.
- **Body events:** P4 IMU/feedback/device events → gateway event owner → Bridge →
  configured event workflow. The workflow selects the response. Telemetry also
  updates subscribed active tasks without becoming a new user conversation.

## Where a change belongs

Paths below are implementation owners, not proposed replacement services.

| Responsibility | Existing owner |
| --- | --- |
| P4 initialization and peripheral composition | Ainekio [`main/app_main.c`](../../../Ainekio/Slave/firmware/esp32p4-wifi6/main/app_main.c), `board.c`, `controller.c`; `components/ainekio_p4_media/` (including `imu.c`), `main/servo_feedback.c`, `main/display.c` |
| V2 kinematics, postures and native motion mathematics | Ainekio [`Slave/software/models/v2-12servo/`](../../../Ainekio/Slave/software/models/v2-12servo/); P4 `body.c` owns device execution |
| Wire fields, joint order and compatibility | Ainekio [`Slave/software/protocol/`](../../../Ainekio/Slave/software/protocol/), including `joints_v2.py`; MetaHuman [`environment-interface/types.ts`](../../packages/core/src/environment-interface/types.ts) owns its semantic side |
| Connections, authentication, command sequences and body receipts | Ainekio [`Master/gateway/server/`](../../../Ainekio/Master/gateway/server/); adapter `translation.py` and `action_receipts.py` own semantic translation/correlation |
| Host gait recording, scoring and learning lifecycle | Ainekio [`gait_learning_service.py`](../../../Ainekio/Master/gateway/gait_learning_service.py); the gateway entrypoint constructs the service and the dashboard exposes its controls |
| Authenticated robot maintenance HTTP | Ainekio [`robot_learning_transport.py`](../../../Ainekio/Master/gateway/robot_learning_transport.py); gait service owns its supplied persistent transport, while Freestyle owns its supplied sparse transport |
| Learned movement generation and execution | Ainekio [`experiments/freestyle/`](../../../Ainekio/experiments/freestyle/), loaded by `dashboard/server.py`; this is an active runtime dependency despite the directory name |
| Host selection, reconnect and tunnel lifecycle | MetaHuman [connection lifecycle](../../brain/agents/environment-bridge/), [`forwarder.ts`](../../brain/agents/environment-bridge/forwarder.ts) and Bridge `core.ts` |
| Work admission and finite execution | Core [`queue/queue-system.ts`](../../packages/core/src/queue/queue-system.ts), `execution-engine.ts`; other processes submit through `work-submission.ts` |
| Graph execution, suspension, results and recovery | Core [`graph-executor.ts`](../../packages/core/src/graph-executor.ts) and [`durable-execution/`](../../packages/core/src/durable-execution/) |
| Task-selection schema, validation, context and planning-delegation contract | Core [`environment-interface/task-selection.ts`](../../packages/core/src/environment-interface/task-selection.ts); graph nodes and training-evidence readers consume this domain contract |
| Cognitive composition and node behavior | [`etc/cognitive-graphs/`](../../etc/cognitive-graphs/README.md) connects registered [`Core nodes`](../../packages/core/src/nodes/); graph JSON is composition, not a second implementation |
| Model role resolution and transport | Core [`model-router.ts`](../../packages/core/src/model-router.ts), `model-roles.ts`, `llm-backend.ts`, [`providers/bridge.ts`](../../packages/core/src/providers/bridge.ts) |
| Agent registration and process lifecycle | Core [`Agent Catalog`](../../packages/core/src/agent-catalog-definitions.ts), `agent-process-runner.ts`; [`brain/agents/`](../../brain/agents/README.md) supplies adapters |

Site and CLI remain interfaces over Core. A UI fix does not belong in a second
brain implementation. A gateway repair does not create another body connection,
and a motion-model repair does not create a MetaHuman servo controller.

## State, memory and learning

| State | Producer and consumer | Release / retention responsibility |
| --- | --- | --- |
| Device calibration, peripherals and Wi-Fi | P4 configuration/NVS → physical executor and device setup | Device-owned configuration survives host reconnect; replacing a model or clearing a host queue does not erase it |
| Adapter action and delivery receipts | [ActionReceipts](../../../Ainekio/Master/gateway/environment_adapter/action_receipts.py) → Bridge/Core admission and evidence ingestion | Acknowledgement deletes the delivery copy. Action history remains until terminal, its observation is recorded, no delivery refers to it, and the existing age policy permits pruning. [Adapter recovery](../../../Ainekio/Master/gateway/environment_adapter/server.py) invokes that pruning; unresolved outcomes remain recoverable |
| Coordinator work and terminal results | [Queue manager](../../packages/core/src/queue/unified-queue-manager.ts) / [persister](../../packages/core/src/queue/queue-persister.ts) → executor and [durable receipt ingestion](../../packages/core/src/durable-execution/work-results.ts) | A terminal worker releases execution capacity. A durable result remains until its execution owner has committed the correlated receipt and acknowledges delivery; remaining terminal history follows the existing queue history policy |
| Goals, checkpoints, effects and evidence references | [Execution store](../../packages/core/src/durable-execution/store.ts), profile `executions.sqlite` → graph resume, result consumers and history readers | Pending delivery, unresolved effects and live writers prevent retirement. [Checkpointer](../../packages/core/src/durable-execution/checkpointer.ts) retention removes eligible terminal history and then unreferenced observations/blobs; [recovery](../../packages/core/src/durable-execution/recovery.ts) supplies unfinished-work exclusions |
| Conversation, persona and persistent experience | [Buffer admission](../../packages/core/src/buffer-admission.ts), [memory](../../packages/core/src/memory.ts) and profile owners → selected context and learning | Domain retention is independent of worker completion. Execution cleanup does not erase conversation or learned facts; attribution and deduplication belong to these owners |
| Training examples, model artifacts and CAD | Existing Core/Brain training owners, Freestyle dataset/deployment owners and Ainekio hardware owners → evaluation, serving, rollback or manufacturing | A completed training job does not make its dataset, active weights or rollback artifact an orphan. Verify references and intended retention at that owner before removal |

The table describes responsibility and current release paths, not permission to
purge data. An inactive record can still be required delivery evidence. A stored
goal can remain useful without occupying a worker. Missing release behavior must
be repaired at its producing owner and tested through normal consumption; adding
another cleanup process does not establish that the producer is correct. Exact
retention settings remain with their executable owners.

Autonomy, Desire, reflection and sleep initiate work through existing Coordinator
and graph owners. Active Operator assesses which operations to request; Desire
owns reviewed multi-step plans; Active Task executes body programs. Their
[behavior contracts](COMPANION_BEHAVIOR.md) and graph definitions specify the
differences. An agent, a graph, a model role and a persistent service are not
interchangeable names for the same thing.

Active Operator first reads the active persona through its existing Persona Loader
and Persona Formatter. Both the configured Orchestrator and the autonomy activity
model receive identity, background, personality, values and standing goals as
standing context; optional source selection cannot remove or narrow them. The
Orchestrator selects additional evidence through the graph’s visible branches,
and the autonomy model selects activity from the assembled context. The Environment graph retains its own
request routing and execution responsibilities, reusing attributed supplied
context only when its source owners can satisfy the selected scope. Persona,
buffer, memory and camera reads remain with those existing owners; there is no
second autonomy context store. See the [assessment context contract](COMPANION_BEHAVIOR.md#active-operator-execution-contract).

The [Full Auto contract](COMPANION_BEHAVIOR.md#full-auto-continuity--owner-contract)
owns autonomy behavior and assessment requirements. [Models and learning](MODELS_AND_LEARNING.md)
owns the learning workflow and activation contract.

## Intended boundaries and remaining distribution work

P4 owns local physical execution; Body Control owns the selected body and learned
motion execution; MetaHuman owns cognition and durable objectives. Model-backed
behavior selection remains with the relevant models. Transport and UI layers
report observations and outcomes rather than choosing replacement behavior.

One Environment Bridge owns the connection. With **Follow the same robot across
saved hosts** enabled, it watches the configured local host and saved SSH or
Cloudflare route concurrently, and keeps exactly one Body Control action stream.
An authenticated host remains usable without a physical robot, including for
Body Control computer speech. Robot connect/disconnect events update that same
stream rather than replacing it. A host advertising the selected robot takes
precedence over a host without a robot; an active host with that robot remains
selected. When that body moves hosts, the same owner reconnects to its new host.
Select the robot identity to retain that choice across process restarts. Without
an explicit identity, automatic mode follows the first available body for that
process lifetime. It does not switch to another robot when the selected body is
unavailable. Manual mode connects only to the explicitly selected host; manual
Local closes the remote forwarder. Separate Local/Remote bridge agents are retired.
WireGuard remains an independently managed operating-system interface.

Authenticated Body Control availability, physical robot availability, and readiness
of the Core observation/action stream are reported separately. Agent Monitor exposes Environment Bridge connection
and transcription diagnostics. Chat does not subscribe to that monitoring stream
or display a persistent disconnected-robot banner. Body Control reports its bridge
transport and voice commands that could not be forwarded. A firmware listening
indicator proves capture, not delivery. Already admitted work retains correlated
receipts across reconnect; reconnect does not authorize repeating physical actions.
New unsolicited input requires a connected recipient.

Q6A and larger remote hosts may share the compute workload. General migration of
an active goal between MetaHuman installations, replicated durable state and
cross-installation control handoff remain design work in the
[distributed foundation proposal](../../../Ainekio/docs/DISTRIBUTED_ROBOT_FOUNDATION.md).
Configured gateway switching does not implement that migration.

For changes, follow the affected path above and update its owner and consumers.
[Maintained Surface](../technical/MAINTAINED_SURFACE.md) owns detailed runtime
constraints; [Repair Design](../technical/REFACTOR_BLUEPRINT.md) owns the repair
method; [qualification](QUALIFICATION.md) owns observable acceptance. Keep this
page as the wiring and configured API map; role assignments, artifact versions
and repair histories remain with their existing configuration and evidence owners.
