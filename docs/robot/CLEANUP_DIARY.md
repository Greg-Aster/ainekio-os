# Robot cleanup diary

Shared record of the owner-requested cleanup across MetaHuman and Ainekio.
The [Robot Bible](ROBOT_BIBLE.md) owns design intent;
[System architecture](SYSTEM_ARCHITECTURE.md) owns the system explanation;
[Qualification](QUALIFICATION.md) distinguishes source, test, live and physical
evidence. This diary records dated work and does not override those authorities.

Keep one concise entry per cleanup task: scope and status, confirmed findings,
changes/removals, and verification with remaining work. Update the entry as work
progresses. Link source and existing evidence instead of copying logs, code or
inventories. Record proposed changes separately from completed repairs; include
no credentials, private profile data or captured media.

## 2026-10-27 — Startup and shutdown foundation

**Status:** Reported startup/shutdown ownership defects repaired. The existing
build check remains: rebuild after required inputs change, not on every launch.
This entry concerns MetaHuman; Ainekio's root launcher starts its simulator, while
its [physical gateway launcher](../../../Ainekio/Master/start-physical-gateway.sh)
starts Body Control separately.

### Startup: retained owners and removed work

[`start.sh`](../../start.sh) loads installation settings, checks Node and the
existing compiled runtime, and starts the prebuilt Site. Its
[dispatcher](../../bin/start-services) launches five branches concurrently:
event bus, configured agents, public web tunnel, voice services and local models.
The web process does not wait for those branches. Failed launchers report their
exit status and log location. Corrected agent CLI and tunnel boot callers that
discarded their owners' startup failures and reported success. Exit cancels unfinished launch commands before
stopping their services, preventing a late launch from undoing shutdown.

| Component | Disposition and implementation evidence |
| --- | --- |
| Existing build check and Site | Retained. Site owns UI/API and starts the existing Core work coordinator and configured mode. The launcher does not build. |
| Event bus | Retained: queue triggers, authenticated selection changes and conversation delivery consume it. [Core's existing server module](../../packages/core/src/infrastructure/event-bus/server.ts) now owns shell/API process start, readiness, PID and stop. Removed the duplicate shell/API spawn and kill implementations. |
| Assigned LLM services | Retained, moved off unauthenticated boot. [Backend owner](../../packages/core/src/llm-backend.ts) follows the committed, storage-ready [authentication selection](../../packages/core/src/sessions.ts), including session restoration. No locked default profile is selected. llama.cpp retains native unloaded startup and model selection. |
| Active Operator, Maintenance Service and Environment Bridge | Retained through Agent Catalog and Agent Monitor. They respectively own autonomous assessment, existing maintenance duties and the robot transport. Removed the stale embedding-preload claim from maintenance configuration. Bridge does not start the remote Body Control application. |
| Public web tunnel | Retained as an explicitly configured remote-access capability. It is separate from the robot transport. |
| Kokoro and Whisper | Retained: real TTS/STT consumers and shared service ownership exist. |
| Local model service | Retained for embedding and optional generation consumers. [Existing Core manager](../../packages/core/src/local-model-service-manager.ts) now owns shell/API process creation, PID/log files, cancellation, readiness and stop. Removed shell JSON parsing, duplicate spawning/killing, in-memory-only ownership and delayed global-child termination. Startup leaves model weights unloaded. |

The initial read-only installation snapshot found healthy event-bus, Kokoro and
Whisper endpoints, a loaded embedding model, and the configured public tunnel.
Those observations establish consumers/installation state at that time, not
qualification of the repaired launch sequence.

### Shutdown: every dispatched call reviewed

[`stop.sh`](../../stop.sh) is the service-shutdown dispatcher. Normal launcher
exit calls its `--services-only` mode. Full stop asks the launcher to cancel its
unfinished starts and release its web child **without dispatching service stop
again**, then stops the installation services once. The internal `USR2` handoff
uses the launcher's existing application-only cleanup. `--app-only` still leaves
services running. The then-present `bin/stop-pm2` wrapper delegated to the same
full stop instead of separately deleting PM2 first.

| Stop target | Why it remains / surviving owner |
| --- | --- |
| Application and optional PM2 registration | At this review, production/dev entrypoints and the PM2 wrapper were supported. Only the application's own matching processes were handled here; arbitrary port listeners were not killed. |
| Terminal sessions | [Terminal client](../../packages/core/src/terminal/client.ts) asks the terminal service to close its shell/provider children and release ownership before the generic agent stop. |
| Registered agents | [Agent registry owner](../../packages/core/src/agent-monitor-registry.ts) now confirms process termination and removes only the matching registration. CLI, API, restart and bulk-stop consumers await that same operation. Graceful stop retains a non-exiting process and reports failure; `--force` remains explicit. Removed the duplicate API/CLI exit-wait implementations. |
| llama.cpp | [Existing systemd owner](../../bin/llama-cpp-services) stops this installation's managed units, including manually started ones. Model selection limits startup, not installation-wide shutdown. |
| Local models | Same Core lifecycle owner as startup/API; no separate shell kill path. |
| Kokoro and Whisper | [Voice owner](../../packages/core/src/voice-service-manager.ts) owns both managed processes. The [wrapper](../../bin/stop-voice-server) reports owner failures. |
| Public tunnel | [Tunnel owner](../../packages/core/src/cloudflare-tunnel.ts) confirms its process stopped before releasing its PID and exposure state. No blanket `cloudflared` process kill. |
| Event bus | Stopped last, through the same Core owner used by startup/API. Its managed process and connections are stopped; missing ownership is reported rather than replaced with a port kill. |

Removed the special `audio-organizer` and maintenance process-name kills, generic
`brain/agents`/bootstrap/launcher searches, port-kill helper, shell registry rewrite,
and shell PID/lock sweeps. Finite audio work remains catalogued; its separate stop
pattern duplicated the agent owner. Removed generic timeout wrappers that hid
owner errors. A failed owner is reported, subsequent stops still run, and the
full command exits unsuccessfully instead of claiming everything stopped.

### Other reported architecture violations

Split Active Operator, Environment Training Curator and Environment Training
Trainer into their required core/CLI/barrel entrypoints, preserving their logic
and updating the real catalog entry. Moved the two cross-layer integration tests
out of Brain into the existing root test suite and registered their maintained
commands; no new public Core exports were added for tests. Corrected affected
source references. The architecture baseline and checker were not changed.

### Verification and limits

The local-model stop regression, duplicate full-stop dispatch, and voice/vLLM
replacement-PID regressions failed on the faulty behavior. Fixture coverage checks
shell/API handoffs, repeated operations, cancellation, replacement, signal failure,
forced termination, startup failure reporting, build checks, app-only/restart,
selected llama.cpp units and unloaded startup. Authentication tests exercise real
session persistence and selected-profile model handoff without requesting models.

**Passing checks:** 43 maintained launcher tests; 12 voice lifecycle/device tests
and the voice ownership validator; 50 authentication/model tests; the relocated
desire/reviewed-training integration tests and trainer source test; Core, CLI,
Brain and root-test typechecks; strict architecture checking with **zero
violations** and no baseline change; Site build; compiled-runtime verification
with 45 workflows; and all three compiled-worker tests. Shell syntax, affected
documentation links and task-file whitespace checks pass. Build output retains
existing module chunking/circular-import warnings; the full workspace verification
command was not run. Rebuilds followed source edits, never normal launch.

No installed services were restarted and no robot commands, training or inference
were requested. Test services/processes use temporary fixtures. A rebuilt bundle
is not live qualification: installed startup/shutdown, optional PM2 supervision,
locked-profile login on this installation and physical robot behavior still need
separate live evidence. This review addresses the reported foundation defects;
it is not a whole-repository correctness claim.

## 2026-10-27 — Retire unused provider integrations

The Installation Owner approved complete removal of vLLM, Kitten and GPT-SoVITS.
Their CLI/API handlers, Astro routes, settings/status controls, startup/shutdown
calls, configuration entries, installers and provider-only tests were removed.
The earlier review established that these integrations had callers; that did not
establish that this installation needed them. They are no longer optional runtime
capabilities. Historical benchmark and audit records retain their original facts.

`stop.sh` remains the dispatcher. Voice shutdown now invokes only the existing
Kokoro/Whisper lifecycle owner. Group messages say “shutdown checked”; the actual
owner reports whether a service stopped or was already absent. Owner failures
still propagate and do not prevent subsequent owners from receiving shutdown.
A temporary before/after fixture recorded `mh vllm stop` and `mh sovits stop`
before the edit and no retired-provider calls afterward.

RVC source recording and selection now use `/api/voice-profile/upload` and
`/api/voice-training?action=samples`; copying and training retain `/api/rvc-training`.
The removed SoVITS reference workflow no longer intercepts RVC recording.
Ollama's existing safetensors adapter discovery moved from the deleted vLLM
module into `ollama-lora.ts`. New personalization runs target Ollama/GGUF;
full fine-tuning keeps its existing model default. Historical training receipts
remain readable, including their original provider, and their files are retained.
Retired serving targets cannot be prepared through a removed integration.

Validation: 41 launcher tests, 71 model-routing/default tests, remaining voice
lifecycle tests, 26 TTS tests, browser streaming checks, training/adapter checks,
Core/CLI/Brain/root-test typechecks, and architecture checking passed. The RVC
regression uses real temporary persistence and repeated export, confirming the
original recording survives. Site build, compiled-runtime verification of all
45 workflows, and three compiled-worker tests passed. No live service, model, training
job, or robot was activated. Installed environments, weights, recordings and
personal training artifacts were not deleted.

Limits: the broader Svelte check reports 160 errors, including unchanged Voice
Settings and sidebar typing issues. The separate multimodal suite fails its
Environment Context Builder image-message assertion (`providers/multimodal.spec.ts`);
that environment construction path was not changed by this retirement. Neither
check is counted as passing. These findings are recorded for their existing owners,
not treated as permission to expand this provider retirement into another repair.

The security-route validator also reports pre-existing authentication/allowlist
findings on `/api/execute-graph-stream`, `/api/environment-bridge/behavior-settings`
and `/api/environment-bridge/visual-result`. All three registrations match the
pre-retirement snapshot. The removed-provider route check passes; the full
security-route validator does not.

## 2026-10-27 — Portal initialization and status repair

The five findings from the portal startup review are repaired. Core's existing
status handler includes healthy llama.cpp deployments in model-role availability;
its offline and recovery behavior is covered alongside Ollama and remote roles.
ChatLayout remains the initial status producer for the authenticated application.
The competing page prefetch and one-shot bootstrap global were removed, so late
responses now reach the shared status store through the same fetch as prompt ones.

AuthGate publishes its verified user through the existing UI stores. ChatLayout
and message-card names consume that session; the layout's duplicate auth/policy
requests and the sidebar's unread user request/state were removed. Expiry and
logout clear the published session. The unused UserMenu component and its sole,
unused import were deleted. The locked-profile message now writes the actual
error field instead of an undefined variable.

Both page shells use ThemeInit for the existing metahuman-theme preference;
ThemeToggle only changes/persists that preference. Three competing initialization
scripts were replaced by that shared head component. LeftSidebar uses Svelte's
automatic YOLO-store subscription lifecycle; its status unsubscribe declaration
is also typed. No service scheduling or robot behavior changed.

Evidence: the status and session regressions failed before their repairs. Six
focused tests now pass, including delayed status delivery, failed refresh and
recovery, session expiry/guest restoration, listener teardown and saved/OS theme
selection. They run through the existing model-defaults and stream validation
commands. The model-defaults suite passes 73 tests plus its contract script.
Core typechecking, the Site build and the compiled-runtime check pass (45
workflows). Svelte compilation emits owned subscription cleanup. The full Svelte
check still reports 154 errors elsewhere, with no errors in affected files and no
new error signatures compared with the earlier provider-retirement check.

The broader stream suite passes 38 tests but fails in the untouched
packages/core/src/api/handlers/graph-outcome.spec.ts fixture at line 64: conflicting
receipt content yields a completed execution where the test expects failed.
This is a separate result-delivery finding; the portal repair does not change
that path or weaken its assertion. Temporary HTTP/event-bus fixtures required an
unsandboxed test run; no installed services were restarted or robot commands sent.
The new release is built, but live browser and physical behavior are unverified.

## 2026-10-27 — Main conversation layout lifecycle

The header now projects persona identity from the shared status store and the
active mode from the shared security policy. Removing an icon removes it from
the header, and a policy refresh updates its mode label. Missing policy is shown
as unavailable instead of naming a default mode as active. The private identity
copy, unused loading/disabled-mode fields, unread left-sidebar context store and
duplicate click-listener teardown were removed.

Collapsed sidebars are inert and excluded from the accessibility tree. The right
panel retains its selected tab while unmounting the hidden tab content, allowing
Agent Monitor and QueuePanel to release their existing display subscriptions.
This does not stop agents, cancel tasks or pause the Work Coordinator. The shared
stream lifecycle tests verify that releasing one consumer preserves other users.

Resize cleanup now handles touch cancellation, window blur, panel closure,
transition to mobile layout and component destruction. It removes every resize
listener and restores the prior document styles. Keyboard and pointer resizing
share width persistence. The existing navigation menu moved into the navigation
owner and is also used to recognize restored views; invalid URL or saved values
return to Chat. The existing training-view restoration behavior is preserved.

Four new regression groups fail against the pre-repair snapshot and pass against
the repair. Checks cover rendered header/sidebar output, closed-panel consumer
admission, repeated resize/cancellation and teardown, keyboard persistence, valid
and invalid restored views, history changes and HMR store reuse. The existing
portal-load/theme, authentication, shared-stream and graph-editor-location checks
also pass. The Site build and compiled-runtime check pass with 45 workflows.
The Svelte check retains 154 existing errors elsewhere, with no errors
in affected files and no new error signatures. The browser connection exposed no
open browser, so these are compiled-render and source-lifecycle checks rather
than live visual/keyboard qualification. No installed service or robot was operated.


## 2026-10-27 — Site Svelte error repair

The reproduced Svelte baseline was 154 errors: 109 in application source and
45 in dependency/generated declarations. Application repairs correct graph-node
data types, nullable form callbacks, response DTO fields and card-component
signatures. Persona bindings still invalidate the original state; voice VAD
normalization retains its existing values. Removed unused card/onboarding props,
unreachable object-spread fallbacks and the nonexistent curiosity message ID;
curiosity dismissal uses the same metadata question identity as chat selection.

The graph editor now uses the installed XYFlow callbacks and keyboard props.
XYFlow remains the owner of canvas mutations; the editor records history before
connect/reconnect/delete and publishes the changed graph afterward. Removed the
obsolete deletion callbacks and duplicate edge/node mutation handlers. A regression
reproduced the missed save notification before repair and now covers connection,
reconnection, combined deletion and undo/redo. User Guide registers synchronous
mount cleanup; tests reproduce the old missing teardown and cover successful and
failed loading, repeated mounting and unmounting during a pending initial request.
Both regressions are registered in the existing `validate:streams` command.

`typecheck:site` previously ran only Astro checks and missed Svelte failures. It
now runs both checkers. Site extends the installed Astro strict preset and uses
explicit source globs so Svelte files remain included. Its standard `skipLibCheck`
excludes dependency/generated declarations; those 45 declarations were not patched
or presented as application fixes. Application strictness remains enabled.

Validation: Astro and Svelte checks pass with zero errors; 321 pre-existing Svelte
warnings remain. All 15 focused UI/graph test files pass, and architecture checking
reports zero violations without baseline changes. The Site release build passes;
its compiled runtime matches source and validates 45 workflows.
These are source, component-handler and build checks, not live browser or physical
qualification. No service was restarted and no model or robot action was requested.


## 2026-10-28 — Old filesystem entries, first investigation

Read-only investigation of the MetaHuman checkout's old root folders and files.
Dates are filesystem modification times, not creation dates or proof of disuse.
Source/reference checks used current workspace manifests, launchers, path/storage
owners and readable process command/mapping paths. Dependencies and excluded apps
were not subjected to a source audit. No source, data or directories were removed.

- `.venv-vllm/`: approximately 12 GiB allocated, with files dated December 2025
  through July 2026. It contains the retired vLLM installation. No maintained
  launcher/configuration reference or visible process mapping was found. This is
  the largest removal candidate in the inspected old root entries; deletion still
  requires checking the exact environment contents and references at removal time.
- Root `src/env.d.ts` and `.astro/`: leftover root Astro declaration/cache chain.
  Current Site configuration/build/launcher use `apps/site/`, and workspace
  typechecks do not include root `src/`. Candidate for removal together, after
  verifying no external invocation relies on the old root layout.
- Root `dist/`, `plans/`, `plugins/examples/`, and `.pnpm-store/v10/`: empty in
  this inspection. Workspace membership does not include the root plugin directory.
  Both pnpm's resolved store and installed dependency metadata point to `/tmp/pnpm/v10`.
- `report.json`, `audit-state.json`, `audit-state.json.bak` and
  `tmp/desire-review-prompt.txt`: old report/scratch candidates, with no current
  producer/consumer found in the maintained commands searched. Historical evidence
  and scratch prompt contents were not treated as disposable solely from that result.
- `bin/whisper`: old native binary with no current runtime reference found. The
  maintained Whisper owner uses the managed server or `venv/bin/python3` with
  faster-whisper. This does not justify deleting `vendor/whisper.cpp`: a current
  multimodal regression uses an image fixture inside that checkout.
- `packages/core/src/fs-glob.ts`: old helper with no in-repo call to `listGlob`
  found, but still exported by Core. Investigate export/dependency consumers before
  removing source; an unused internal search result is not a complete API review.

Keep the old `bin/piper/` installation (current voice config and TTS owner use it),
`.start-config` (read by `start.sh`), and root `venv/` (training and Whisper use it).
Root `persona/` mixes old identity/history files with the live `users.json` account
store; do not remove the directory. Root `memory/` contains four December 2025
curated-document files. Current memory ownership is profile-scoped; establish
migration, duplication and retention before touching this historical data.

This is the first bounded filesystem pass, not a claim that every old file,
external checkout, model, profile or generated artifact has been qualified for
removal. No tests/build were needed because executable files were unchanged.


## 2026-10-28 — Remove confirmed old filesystem leftovers

Owner authorized cleanup of the preceding investigation's candidates. Removed
approximately 11.904 GiB of allocated files after recording and rechecking each
candidate's inode, type, size and modification metadata. No candidate process use
was visible in the command, mapped-file and open-file checks.

Removed `.venv-vllm/`, root `.astro/`, root `src/` (only the unused Astro declaration),
root `.pnpm-store/`, root `dist/`, `plans/`, `plugins/` (empty examples), `report.json`,
`audit-state.json`, `audit-state.json.bak`, `tmp/desire-review-prompt.txt`, the now-empty
root `tmp/`, and `bin/whisper`. The retired environment contained installed packages
and ordinary virtual-environment files; its only external symlink target was the
system Python executable, which was preserved. No active model directory was removed.

Removed `packages/core/src/fs-glob.ts`, its root Core export, and Core's `fast-glob`
dependency/importer lock entry. No `listGlob` or `GlobOptions` consumers were found
in maintained source or the adjacent robot/refiner sources checked. Core is a private
workspace package. The CLI directly uses `fast-glob` and retains its dependency,
lock entry and installed link. An offline frozen-lockfile install reconciled the
installed Core link without installing new dependencies or running install scripts.
Existing unrelated changes to Core's manifest and barrel were preserved.

Preserved all unique legacy persona history and memory metadata. Byte comparisons
found copies of the old curated document in profiles, but its metadata did not have
an identical profile copy; many persona archives were also unique. Neither data set
was erased or silently reassigned to a profile. The root account store, Piper,
ordinary training/Whisper `venv/`, startup preferences and referenced vendor fixture
remain. All 510 protected files matched their pre-removal hashes after cleanup.

Validation: Core and CLI typechecks pass; offline frozen lock checks pass;
architecture has zero violations; all 41 launcher tests pass outside the sandbox
(the sandbox run stalled on subprocess fixtures and was stopped). The Site build
passes, and the compiled-runtime check validates source identity and 45 workflows.
No installed service was restarted and no physical or model action was issued.
All removal targets were checked absent. No unique-history deletion was included.


## 2026-10-28 — Expand filesystem coverage to the entire repository

The earlier root cleanup was not a whole-repository usage audit. The expanded
metadata census enumerated 493,604 files, 63,034 directories and 4,937 symlinks
across all exposed root areas, including ignored/dependency/generated content,
with no traversal errors. Symlink targets outside the tree were not traversed.
A 2,090-text-file reference scan produced a complete checklist for all 337
maintained files older than 180 days; six remain unresolved after entrypoint
classification. Full metadata coverage is distinct from semantic retention review.

The [coverage report](../audits/FILESYSTEM_COVERAGE_2026-10-28.md) records every
root area, ownership counts, exact stale-link and source candidates, duplicate
embedding hashes, active older releases, training-receipt consumers, and the
remaining boundaries for model/data/history retention. Complete local CSV evidence
includes every observed filesystem entry and all 337 older maintained files.
No production files were edited or removed, and no services or models were operated.


## 2026-10-28 — Remove qualified filesystem leftovers and repair model storage paths

Completed the authorized removals from the [expanded coverage report](../audits/FILESYSTEM_COVERAGE_2026-10-28.md): 88,372 regular files plus obsolete links/directories, approximately 19.019 GiB of allocated file data with all hard links removed. This measures removed allocation, not an exact change in free space on the live filesystem. Removed the retired GPT-SoVITS install and Kitten bytecode, React Native's displaced dependency copies, the empty server package and its obsolete workspace alias, all seven originally broken links, five duplicate embedding weights, 33 unowned Site releases, and abandoned temporary Site outputs. No personal GPT voice/training material was found.

The old cloud pilot's 26 model/library artifacts matched both its manifest and retained root-model/r2-binary hashes. Removed those duplicate artifacts while preserving all 54 evidence/source/archive files byte-for-byte. Retained both releases used by running processes, active training/model trees, mobile release delivery, unique voice/history data, logs, and explicit deployment/repository recovery backups. The recorded pilot cleanup established prior retirement; this task performed no remote operation. Restaging the cloud build requires copying its manifest-matched artifacts from the retained originals.

Removed nine unused source/configuration/diagnostic files: Site-local runtime config, timeout wrapper, cognitive-mode wrappers, duplicate node-pipeline utility, Core memory-cleanup helper, unused operator barrel, unused context-window and training-cleanup libraries and exports, and the unregistered direct embedding diagnostic. Current Core authorization, node-pipeline handling, memory validation and observation formatting retain their existing owners and callers. Workspace and adjacent robot/refiner searches found no consumers of the removed libraries.

Repaired the existing local-model service's directory selection. Standalone startup now resolves repository-root models independently of cwd, honors METAHUMAN_ROOT, and resolves MODELS_DIR consistently with managed startup. The actual service inventory endpoint now reads the same directory passed to model loading, instead of an unrelated config value. The regression tests first failed on the original directory mismatch and false missing-model report; both pass after repair, including repeated fixture-file removal/recreation. These tests are part of the existing launcher suite and do not load model weights.

Validation: all 43 launcher tests pass; Core, Brain, CLI, scripts, tests, mobile and Site typechecks pass; the local-model-service build passes; architecture reports zero violations. Site checks still report warnings (321 from svelte-check), not errors. The Site production build passes, and its compiled-runtime check validates source identity and 45 saved workflows. Both retained model hashes and removal targets were verified. Existing unrelated working-tree changes were preserved. No installed service was restarted, and no inference or physical operation was issued. The newly built release is selected for the next launch; running services retain their original releases.


## 2026-10-28 — Second whole-repository unused-file/system review

The [second-pass report](../audits/FILESYSTEM_SECOND_PASS_2026-10-28.md) records a fresh full-tree census: 406,330 regular files, 50,920 directories, 4,920 links, zero traversal errors, and approximately 112.178 GiB allocated. All exposed root areas, hidden/ignored content and dependencies were included; symlinks were recorded without traversing external targets. All recorded link targets resolved. The installation remained live during the scan.

Extended source triage to every age: 1,899 maintained tracked/untracked candidates, including 1,842 readable text files. Initially identified 14 source candidates (2,069 lines), nine later retained because of the agent entrypoint contract: the legacy Core context builder and re-export, two old UI components, their unused clear-event store, the unused Site keyword file-operation parser, and nine unregistered agent adapter modules. Current context nodes, Agency/audit/file-operation owners, agent CLI/core implementations and actual mobile bindings remain the surviving owners. Two candidate components already contain unrelated working-tree edits.

Found two retired public workflow files and two semantically divergent public copies; 17 other public copies are equivalent to their canonical graphs. The existing validator passes all 45 canonical workflows because only the Dual public copy is checked. Also identified 177 of 329 JS/TS test files with no package-command or registered-test import path; these require owner-level registration/classification, not blanket deletion. No registered agent/service input or literal package-command source path was missing.

Verified identical staged/build/release APKs; the 239.28 MiB mobile staging directory is a generated cleanup candidate while the published release remains needed. Three older llama.cpp installations (about 1.85 GiB combined) have no observed process or inspected configuration consumer, but historical-build recovery boundaries remain. Eight of nine files in the old dynamic build match r2; its libllama differs. Speck still has an installed service reference; r2/r3 and training artifacts have live consumers. Unique root model provenance, training evidence, explicit review/recovery archives and identity/voice/history data remain unresolved or intentionally retained.

This pass changed only audit documentation and this diary within the repository. It did not delete or modify production source, run the unregistered tests, rebuild, restart services, call models or operate the robot. Exact file lists, hashes, entrypoint checks and full-tree metadata are private `/tmp/metahuman-pass2-*` evidence.


## 2026-10-28 — Deeper cleanup of verified unused owners

Removed eight unused source files (2,499 lines): the legacy standalone Core context builder, short-term state module, recent-tools cache, DesireCard, LogStream, clear-events store, Site keyword file-operation parser, and graph-copy script. Removed their exports, package subpath, copy command, and four orphan context-policy helpers. Current graph nodes, AgencyDashboard, AuditViewer, and the authenticated Core file-operation API remain the owners.

The deeper trace found memory capture actively writing the unused tool cache. Removed that producer, reset flush, and profile-directory provisioning; canonical tool outputs, synchronization and index submission remain. The regression uses real fixture persistence, captures twice, checks complete saved outputs, and confirms no cache writes. It failed before the repair and passes afterward. Registered the memory-attribution and profile-reset suites in existing owner commands. Legacy reset deletion remains for historical cache directories.

Removed all 21 public graph mirrors; Site APIs and mobile packaging use the 45 canonical graphs, whose hashes are unchanged. Kept the existing prompt-definition/wiring regression against canonical Environment Mode. Removed 97 stale mobile staging files (239.28 MiB), after confirming no live consumer and byte-identical published APK retention. Restored nine candidate agent index adapters byte-for-byte when architecture validation established that the entrypoint contract still requires them; no rule or baseline was weakened.

Validation: affected Core/Brain/CLI/scripts/tests/mobile/Site typechecks pass; Core was checked again after orphan export removal. Graph validation passes 45/45, architecture reports zero violations, all 43 launcher tests pass, and Site production build passes. The compiled runtime matches source and validates 45 workflows; all three compiled-agent checks pass. Svelte retains 313 warnings. Environment plus profile-reset tests pass 164/184, with the same 20 failure names reproduced against isolated pre-cleanup source (163/183); the additional passing test is the cache regression. Agent Monitor's API-contract assertion and Agent Catalog's trigger-count assertion also fail on pre-cleanup source. These are existing failures, not proof that the whole application passes.

Retained old custom inference builds and other unique/recovery artifacts whose retention obligations remain unresolved. Existing profile cache data was not purged: already-running releases can still write it, and equivalence to canonical history is not established. No installed services were restarted, model instructions changed, inference issued, or robot operated. See the second-pass report for exact scope and retained boundaries.


## 2026-10-29 — Retire training outputs while preserving future training inputs

Removed 2,258 files from the authorized `out/` cleanup targets: retired
EnvironmentClassifier model/tokenizer/optimizer artifacts, the five failed-start
attempts, redundant historical base weights, and disposable intermediate
checkpoints. Removed 259 checkpoint directories and the five failed-attempt
directories. Accounting for existing hard links and retained evidence, this
released approximately 14.069 GiB of allocated file data; this is not a measurement
of free-space change on the live filesystem.

Preserved all 721 JSONL contents found under `out/`: 710 remain at their original
paths, and the 11 removed failed-attempt copies have SHA-256-identical counterparts
in retained runs. Current source corpora, manifests, held-out splits, classifier
evaluation receipt, native final adapters, configured/selectable model artifacts,
selection evidence, voice data and recovery archives remain. Retained 15 checkpoint
directories: 14 selected development checkpoints whose weights differ from the
saved final adapters, and one failed fold's only surviving native adapter.
Required independent dataset/tokenizer copies were not replaced with shared links.

The ignored `out/training-cleanup-20261029.json` records every removal, preserved
hash, duplicate counterpart and retained checkpoint. Its 2.88 MiB companion
`out/training-cleanup-20261029-evidence.tar.gz` preserves 1,212 small checkpoint and
failed-attempt records at their original relative archive paths. Deleted epoch
weights/optimizer states cannot resume old jobs or support their epoch-specific
reevaluation. The training owner's README now explicitly protects successive-run
inputs and explains this retirement boundary and direct evaluation of retained
checkpoints; no automatic cleanup mechanism was added.

Validation: 7,531 retained original-path files and all archived records match their
pre-cleanup SHA-256 hashes; all 12 duplicate mappings match their surviving copies.
All removal targets are absent and 149 previously existing source/configuration
references remain accessible. Both real training entrypoint dry runs pass before
and after cleanup: 1,803 Intent and 5,334 Task development records, with retained
recipe selection and held-out provenance. The manual trainer's actual native-source
resolver accepts both currently selected adapters and their base provenance; their
native weights and serving exports remain accessible. No fit, model inference,
service restart, profile edit or robot operation was performed.
