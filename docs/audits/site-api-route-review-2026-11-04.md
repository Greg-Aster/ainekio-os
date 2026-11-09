# Site API consolidation — 2026-11-04

Core is now the single API registry. Site has one `pages/api/[...path].ts` endpoint exporting `ALL = astroHandler`; it no longer repeats paths and methods in 257 Astro files. Core owns method/policy selection and named parameters. Existing middleware retains session/CORS context; the shared adapters retain JSON, multipart/raw input, cookies, binary responses and SSE cancellation/backpressure. No transport-specific migration handler remains.

This replaces the earlier review conclusion. The earlier “keep—traced” label established a reference, not a working end-to-end path: memory sync pull was shadowed, and the route-file-only inventory missed ProjectDashboard’s absent transport. Both are corrected. The 35 previously unresolved endpoints are retired with the individual reasons below; none remains unresolved. Removing forwarding files and removing operations are counted separately.

## Results and surviving paths

- **Transport:** 257 existing Astro files replaced by one catch-all. Core currently has **298 route registrations for 299 method/pattern combinations**; the unused dynamic registerRoute export is removed.
- **Previously unresolved HTTP operations:** 35 URL patterns / 39 methods removed from Core, along with their unused handlers.
- **Unserved Core-only HTTP residue:** another 68 registrations / 69 methods removed, rather than made live by the catch-all. Their underlying domain libraries/data were not deleted.
- **Earlier cleanup retained:** 20 Astro paths removed in the first pass, of which 15 were already404 and five were functioning but redundant. Eight of the already404 wrappers were local-model consolidation residue. These are not counted as new functioning operation removals.

| Capability and current caller | Surviving path and owner | Evidence |
| --- | --- | --- |
| Memory sync client | GET memory/sync/pull and dynamic memory/sync/:id → memory-sync / memory-sync-item | Real adapter/router test persists one memory; pull returns it instead of exists:false, while item lookup still returns exists:true. Literal paths precede regex patterns. |
| ProjectDashboard | GET/POST projects, GET projects/:id, GET tasks/actionable and tasks/blocked → projects.ts → memory.ts | Actual Astro/Core adapter requests create/list a project and read persisted ready/blocked tasks and project details. Previously live GET projects returned404. |
| CuriosityCard | POST curiosity/questions/skip → curiosity-questions.ts | Existing client request now reaches the same Core registry through Site transport. |
| ProfileLocation | POST profile-path → profile-path.ts → profile-migration.ts | Two isolated real profile moves streamed completion and updated the fixture user store. Source data remained. Validation/password checks and occupied-destination failure passed. No live profile was migrated. |
| Flow editor / Agency | execute-graph-stream; desire generate-plan-stream, run-stream and outcome-review-stream → existing graph/Desire/Coordinator owners | Existing stream lifecycle coverage preserves disconnect semantics and admitted work. Duplicate nonstream gateways were removed. |
| Browser authentication / sync | auth/*; profile-sync bundle/config/memory routes → sessions/users/profile-sync | Middleware and route authentication unchanged; migration is explicitly authenticated in Core. Logout cookie transport and protected requests are checked. |
| Voice samples | GET voice-samples/:sampleId → voice-samples.ts → storage-client | Core supplies sampleId without Astro file params; actual fixture WAV bytes and audio Content-Type survive the adapter. |
| Agent/Trigger Manager / Terminal | Existing Core routes and handlers → their existing owners | Their structural tests now check the Core registration and single transport, rather than require duplicate forwarding files. |

## Remaining browser request corrections

A scan across browser components, libraries and stores found six references to five additional missing paths; the maintained registry regression now checks all **277 literal browser API references** and finds no missing registration. Dynamic path behavior is covered separately by the memory, project and voice-sample tests.

| Previous request | Final disposition and owner |
| --- | --- |
| TrainingWizard → session | Uses existing auth/me and its user.username response. No session alias was added. |
| TaskManager → task-lists GET/POST | Retired the nonfunctional list creation/filter/edit controls and unused listId HTTP update option. No list storage owner existed. Ordinary tasks, search, status, calendar and stored task records remain. |
| NetworkServerSettings → network-info/network-settings | Removed the obsolete mobile Wi-Fi broadcast panel, state, polling and toggle requests. There was no maintained implementation behind either URL. Current server information, remote connection selection and tunnel controls remain. |
| Onboarding Context → ingest POST multipart | Registered the already-requested upload in Core's onboarding handler. It writes through storageClient to the existing authenticated profile inbox, retaining originals under distinct names. The existing Inbox Ingestor owns later processing. The UI says stored, no longer falsely increments filesIngested or promises local-only processing when a remote server may be selected. |

Actual multipart adapter/storage tests prove byte preservation and repeated uploads without overwriting either original; no ingestor, model or training operation is started by upload. No replacement task-list or network manager was introduced.

## Disposition of all 35 previously unresolved endpoints

Consumer tracing covered Site UI/stores, React Native packaging, CLI, Brain/services, scripts/tests, current configuration, Ainekio and ainekio-refiner integrations. No maintained executable caller was found for these retired methods. The reasons below also inspect their operation and surviving owner; an absent text reference alone was not used to classify a domain library or stored data as disposable.

| Retired path | Methods | Operation removed and surviving boundary |
| --- | --- | --- |
| `/api/active-operator/approvals` | GET, POST | Remove uncalled critic-specific HTTP list/resolve wrappers. No maintained producer calls submitForReview or queueForApproval in that critic. Desire approvals retain their Agency owner. The unused operator-proposal stream and decision/feedback APIs are retired with their card and store, preserving history and the System Code Review trust policy. The separate legacy skill /api/approvals route and Dashboard screen are retired; records are preserved, not migrated into another queue. |
| `/api/active-operator/proposals` | GET, POST | Remove uncalled scan/status wrappers around self-healing. Current code review uses the Terminal/Big Brother and system-code-review owners. Existing code-proposals records and self-healing library are retained. |
| `/api/agency/desires/:id/generate-plan` | POST | Remove alternate JSON admission; AgencyDashboard uses generate-plan-stream and the same submitDesireAgent plan owner. |
| `/api/agency/desires/:id/outcome-review` | POST | Remove alternate JSON admission; outcome-review-stream delegates to the existing Desire/Coordinator review owner. |
| `/api/agency/desires/:id/retry` | POST | Remove unused retry transition/admission wrapper. Active Agency controls use reset, revise, ready-to-plan and streaming planning; Agency history and library lifecycle remain. |
| `/api/agency/desires/:id/run` | POST | Remove alternate JSON admission; AgencyDashboard uses run-stream and the same Desire/Coordinator execution owner. |
| `/api/audit/clear` | DELETE | Remove unused bulk deletion gateway. AuditViewer uses audit-control and its existing retention purge. No audit logs were deleted. |
| `/api/big-brother-escalate` | POST | Remove unused node-editor escalation gateway. The editor uses execute-graph-stream; selected graph nodes and the existing Big Brother/Terminal owners retain execution. |
| `/api/curiosity-config` | GET, POST | Remove unused HTTP config wrapper. Existing config load/parse/save and Inner Curiosity lifecycle remain; no settings or behavior were changed. |
| `/api/encryption` | GET | Remove unused status/capabilities HTTP wrapper. ProfileLocation uses profile-path and veracrypt/status; encryption-manager remains the underlying owner. |
| `/api/encryption/lock` | POST | Remove unused manual HTTP wrapper. Authentication logout retains lockProfile at its existing owner; encrypted data/configuration are untouched. |
| `/api/encryption/setup` | POST | Remove unused alternate setup gateway. ProfileLocation uses profile-path/encrypt and migration; the existing encryption-manager remains. |
| `/api/encryption/unlock` | POST | Remove unused manual HTTP wrapper. Authentication login retains unlockProfile and authenticated-session selection. |
| `/api/environment-bridge/control` | POST | Remove uncalled enabled-only gateway. Body Control uses behavior-settings with the existing Coordinator cancellation owner; no new control behavior was added. |
| `/api/environment-bridge/diagnostics` | GET | Remove duplicate snapshot gateway. Agent Monitor publishes this same diagnostics snapshot in its agent data panel. Diagnostic media/audio and telemetry routes remain. |
| `/api/execute-graph` | POST | Remove unused synchronous graph gateway. FlowEditorLayout uses execute-graph-stream over the same graph runtime. Its failure/waiting tests remain on the surviving streaming path. |
| `/api/execute` | POST | Remove uncalled HTTP gateway that spawns tsx/CLI. CLI entry.ts and its commands remain directly executable. |
| `/api/export/conversations` | POST | Remove unused exporter that copied conversation text into the inbox. Memory data, profile sync/export and training-data owners remain; no files were exported or purged. |
| `/api/file_operations` | GET, POST | Remove unused HTTP skills wrapper and status projection. Existing fs_read/fs_write skills, policy and CLI/node callers remain. |
| `/api/fine-tune/models` | GET | Remove duplicate candidate projection. TrainingHistory uses training/history, owned by training-process and adapters; model role assignments and artifacts are unchanged. |
| `/api/llm-backend/switch` | POST | Remove unused alternate backend mutation. BackendSettings uses llm-backend/config and model-registry; provider/backend libraries remain. |
| `/api/memories` | GET | Remove unused flat-directory memory projection. CenterContent uses memories_all; sync uses memory/sync/pull and profile-sync/memories. Memory persistence remains in memory.ts. |
| `/api/memories/search` | GET | Remove unused keyword-search HTTP wrapper. Existing searchMemory/library and vector-index owners remain. No replacement HTTP search was invented. |
| `/api/memory-metrics` | GET | Remove unused metrics projection. Dashboard/status and existing memory-metrics cache remain; no metrics data or cache was deleted. |
| `/api/operator-proposals` | GET | Remove unused polling snapshot. The mounted proposals store uses operator-proposals/stream, respond and post-feedback against the same proposal owner. |
| `/api/operator-proposals/review` | POST | Remove uncalled manual review gateway. Underlying Big Brother review and proposal lifecycle remain; no pending proposal/history files were deleted. |
| `/api/persona-decision-rules` | GET | Remove unused raw component-file getter. Current persona editing uses persona-core-manage/persona-facets-manage; profile sync owns bundle transfer. Stored persona components remain. |
| `/api/persona-relationships` | GET | Remove unused raw component-file getter. Persona editor/facets and profile sync retain their existing owners; stored relationships are untouched. |
| `/api/persona-routines` | GET | Remove unused raw component-file getter. Persona editor/facets and profile sync retain their existing owners; stored routines are untouched. |
| `/api/persona` | GET | Remove duplicate core.json getter. AuthGate/onboarding continue using persona-core; PersonaEditor uses persona-core-manage. |
| `/api/persona/summary` | GET | Remove unused identity summary HTTP projection. Identity library and current persona/status owners remain; no persona contents were changed. |
| `/api/profile-sync/user` | GET | Remove unused account projection. AuthGate uses auth/me and auth/sync-user; profile-sync configuration, bundle and memory transfer remain. |
| `/api/remote-server/models` | GET | Remove unused model-discovery gateway. BackendSettings uses remote-server/test/connect, which retain fetchRemoteModels; model registry and remote session persistence remain. |
| `/api/template-watch` | GET | Remove uncalled fs.watch SSE implementation. Graph editor loads/saves via cognitive-graphs/cognitive-graph; no template watcher or keepalive remains. |
| `/api/template/:name` | GET | Remove unused raw graph JSON getter. Graph editor uses cognitive-graph; graph files and graph-loading libraries remain. |

## Additional unserved registry residue

The old Astro registry did not serve these wrappers and no current maintained client called them. Core-only routes were therefore not treated as permission to expose new HTTP operations.

| Retired Core handler module | Methods removed | Underlying owner retained |
| --- | --- | --- |
| goal-reviews.ts | 8 | Existing review/goal libraries and history |
| system-operator.ts | 18 | Existing backup, maintenance, rollback and ingestion-QA libraries and their stored history |
| voice.ts | 10 | Existing voice library; active browser microphone/STT/TTS and robot voice paths are unchanged. The unused HTTP-owned activeVoiceLoops map is gone. |
| photo-ingestion.ts | 3 | connectors/photo-ingestor.ts |
| document-ingestion.ts | 3 | connectors/document-ingestor.ts |
| calendar.ts | 8 | Existing calendar connector/configuration |
| chat-ingestion.ts | 4 | Existing chat connector/parser |
| clip-tagging.ts | 4 | Existing CLIP/image-tagging library |

The remaining 11 unserved methods were unused task URL mutations/dependency endpoints, project update/archive/assignment/graph projections, and persona_chat/cancel. Their unused handler functions and the HTTP-only critical-path helper were removed. TaskManager retains GET/POST/PATCH tasks, ProjectDashboard retains its five used methods, memory.ts retains task/project/dependency operations, and ChatInterface retains its used cancel-chat endpoint. There is no redirect or added compatibility endpoint.

## Removed source and retained data

Entire Core handler modules removed in this deeper pass: `audit-clear.ts`, `big-brother-escalate.ts`, `config.ts`, `encryption.ts`, `encryption-profile.ts`, `execute-graph.ts`, `execute.ts`, `export-conversations.ts`, `file-operations.ts`, `fine-tune-models.ts`, `llm-backend-switch.ts`, `memory-metrics.ts`, `template-watch.ts`, `templates.ts`, `goal-reviews.ts`, `system-operator.ts`, `voice.ts`, `photo-ingestion.ts`, `document-ingestion.ts`, `calendar.ts`, `chat-ingestion.ts`, `clip-tagging.ts`.

Partial handler removals are in active-operator.ts, agency-workflows.ts, agency.ts, persona.ts, auth.ts, operator-proposals.ts, remote-server.ts, memories.ts, environment-bridge.ts, tasks.ts, projects.ts and persona-chat.ts. Router imports/registrations and handler barrel exports were removed with them. Obsolete direct-graph tests were removed; useful streaming outcome tests remain. Diagnostic ingestion/media coverage now reads the existing diagnostics owner rather than the deleted duplicate HTTP getter. No new manager, runtime guard, fallback, model or dependency was added; surviving model-visible instructions were not changed.

All profile memories, persona/component files, approval/code-proposal records, training runs/candidates/artifacts, recordings, domain history, general logs and underlying CLI/library capabilities are retained. This task removes unused HTTP access and handlers, not those domain libraries. Dated audits/inventories/consolidation ledgers retain their historical before-state paths. Old immutable Site releases remain because a running process can still own their chunks; this task does not delete release history or shared caches.

## Validation

New registry regression tests and profile migration tests are registered in validate:streams. Focused checks cover actual persisted memory/project/task data, literal versus dynamic routing, binary voice samples, logout cookies, retired-route404s, profile migration SSE, adapter backpressure/cancellation, Agent Catalog and Trigger Manager transport contracts, and diagnostics ingestion/media.

Core TypeScript, Site Astro checks and git diff --check passed. The architecture guardrail passed earlier; its final run currently flags an unrelated concurrently edited AgencyDashboard type import from @metahuman/core. That file was preserved. Broader validation is not fully green: graph-outcome’s pre-existing real-output fixture returns completed where it expects failed, conversation-transport lacks showChatError in its VM fixture, and existing work-owner/TTS ownership assertions fail on unrelated current source. Original HEAD test bodies reproduce the graph/work/TTS failures (the old TTS stub text is supplied only in the disposable baseline fixture). No assertion was weakened to hide them.

Security validation retains the existing execute-graph-stream policy-metadata failures and behavior-settings/visual-result bootstrap-allowlist discrepancy. Making conversation-buffer an exact literal also reveals the existing mismatch between its intentionally empty anonymous response and the checker’s blanket authenticated-read expectation. Anonymous behavior and policy were not changed to manufacture a pass.

The final active Site release is `1e928688-947c-490b-b052-3c9888fc9938`, running on the existing port4321 through `start.sh --app-only`. Its startup check confirmed that compiled Core matched source and validated47 workflows. Concurrent Core edits invalidated intermediate build hashes; those stale builds were rejected by the existing check, which was not bypassed. Other sessions may select a newer immutable build without changing this running process.

All **138 retired/stale method/path probes returned404 with no redirect**: 39 from the35 dispositions, 25 from the earlier20 paths,69 formerly unserved Core methods and five methods from the later-discovered stale UI paths. Fifteen additional probes, including authenticated upload/migration entrypoints returning401 without a session, matched their expected statuses. Same-origin CORS preflight returned204 with the expected origin. All153 ordinary HTTP requests had the expected result.

**Activation interruption:** the earlier activation passed its process-continuity check, but the later existing launcher exited during activation and ran full-service cleanup at15:50. Process continuity therefore failed; it is not reported as a passing check. Greg explicitly authorized restoration. Site was restored using the existing app-only owner, then event bus, Robot Operator, Environment Bridge, maintenance, Kokoro, Whisper and the previously running Cloudflare tunnel were restored through their existing launchers. Voice-service status reports both servers ready; the agent registry reports the three restored services running, and the app reconnected to the event bus. The main native llama.cpp hosting PID remained running. Six tracked voice/Bridge/maintenance processes have replacement PIDs; one sampled native model worker exited and another is running under the existing host; its exit cause was not established. Four of the original11 sampled PIDs remain. No model-host restart or replacement serving path was introduced. The exact cause of the prior launcher's exit has not been established; no launcher policy or lifecycle code was changed in this API task.

The live ProjectDashboard URLs now return401 when unauthenticated, rather than Astro404. Actual authenticated values were proved with isolated real persisted project/task fixtures through the shared Astro/Core path; no production account or task data was changed by these checks. Memory sync’s actual one-memory response is similarly covered by the router regression. The live migration POST remains401 without authentication; only isolated test profiles were migrated.

The maintained validate:streams command ran outside the sandbox for its isolated socket test: **110/112 tests pass**. The two remaining failures are graph-outcome’s unchanged initial fixture and conversation-transport’s missing showChatError helper. Terminal, the new registry/migration tests, adapters, middleware and stream lifecycle checks pass. Separately selected work-owner and TTS ownership assertions retain their documented baseline failures. Security checks are10/14 with the discrepancies described above; this is not a full verification pass. Core TypeScript, Site Astro checks (zero errors/warnings), Site build and git diff --check pass. Architecture currently reports the concurrent AgencyDashboard import described above.

No source commit or publication was made. Tests requested no robot motion, training, model inference or firmware operation. The authorized service restoration is recorded above; restoring Robot Operator permits its ordinary configured work to resume. No unresolved endpoint disposition remains in the35-item set. The separate launcher-exit cause and the listed test/policy discrepancies remain unresolved; the API and restored services are running.

## Original per-file inventory and final disposition

This is the historical 277-file starting list, not a current file listing. Every listed Astro source file has been removed. “Core transport” means the operation survives in the single Core registry; “HTTP retired” means its operation was removed too. Previous unregistered404 wrappers are identified separately.

| Original file below pages/api | Methods | Final disposition | Core handler owner | Source caller before consolidation |
| --- | --- | --- | --- | --- |
| `active-operator/approvals.ts` | GET, POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `active-operator/config.ts` | GET, POST | Core transport | `active-operator.ts` | `scripts/validate-security-routes.ts:55`<br>`scripts/validate-security-routes.ts:76` |
| `active-operator/control.ts` | POST | Core transport | `active-operator.ts` | `scripts/validate-security-routes.ts:56`<br>`apps/site/src/lib/stores/trigger-manager.ts:199` |
| `active-operator/proposals.ts` | GET, POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `active-operator/status.ts` | GET | Core transport | `active-operator.ts` | `apps/site/src/components/ActiveOperatorDashboard.svelte:92` |
| `activity-ping.ts` | POST | Core transport | `activity-ping.ts` | `apps/site/src/lib/client/composables/useMessages.ts:265`<br>`apps/site/src/lib/client/composables/useMicrophone.ts:126` |
| `addons.ts` | GET | Core transport | `addons.ts` | `apps/site/src/components/AddonsManager.svelte:47` |
| `addons/install-stream.ts` | POST | Core transport | `addons.ts` | `apps/site/src/components/AddonsManager.svelte:73` |
| `addons/uninstall.ts` | POST | Core transport | `addons.ts` | `apps/site/src/components/AddonsManager.svelte:164` |
| `agency/config.ts` | GET, PUT | Core transport | `agency-config.ts` | `apps/site/src/components/AgencyDashboard.svelte:681`<br>`apps/site/src/components/AgencyDashboard.svelte:717` |
| `agency/desires.ts` | GET, POST | Core transport | `agency.ts` | `apps/site/src/components/ApprovalPrompt.svelte:142`<br>`apps/site/src/components/AgencyDashboard.svelte:654` |
| `agency/desires/[id].ts` | GET, PUT, DELETE | Core transport | `agency.ts` | `apps/site/src/components/AgencyDashboard.svelte` |
| `agency/desires/[id]/advance.ts` | POST | Core transport | `agency.ts` | `apps/site/src/components/AgencyDashboard.svelte:982`<br>`apps/site/src/components/AgencyDashboard.svelte:1002` |
| `agency/desires/[id]/answer.ts` | POST | Core transport | `agency.ts` | `apps/site/src/components/AgencyDashboard.svelte:1036` |
| `agency/desires/[id]/approve.ts` | POST | Core transport | `agency.ts` | `apps/site/src/components/ApprovalPrompt.svelte`<br>`apps/site/src/components/AgencyDashboard.svelte` |
| `agency/desires/[id]/checkin.ts` | POST | Core transport | `agency.ts` | `apps/site/src/components/AgencyDashboard.svelte:934` |
| `agency/desires/[id]/confirm-complete.ts` | POST | Core transport | `agency.ts` | No maintained UI caller; public API retained. |
| `agency/desires/[id]/execute.ts` | POST | Core transport | `agency.ts` | No maintained UI caller; public API retained. |
| `agency/desires/[id]/executions.ts` | GET | Core transport | `agency.ts` | `apps/site/src/components/AgencyDashboard.svelte:835` |
| `agency/desires/[id]/feedback.ts` | POST | Core transport | `agency.ts` | No maintained UI caller; public API retained. |
| `agency/desires/[id]/generate-plan-stream.ts` | POST | Core transport | `agency-workflows.ts` | `apps/site/src/components/AgencyDashboard.svelte:1127` |
| `agency/desires/[id]/generate-plan.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `agency/desires/[id]/outcome-review-stream.ts` | GET | Core transport | `agency-workflows.ts` | `apps/site/src/components/AgencyDashboard.svelte:1290` |
| `agency/desires/[id]/outcome-review.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `agency/desires/[id]/ready-to-plan.ts` | POST | Core transport | `agency.ts` | No maintained UI caller; public API retained. |
| `agency/desires/[id]/reject.ts` | POST | Core transport | `agency.ts` | `apps/site/src/components/ApprovalPrompt.svelte`<br>`apps/site/src/components/AgencyDashboard.svelte` |
| `agency/desires/[id]/request-revision.ts` | POST | Core transport | `agency.ts` | No maintained UI caller; public API retained. |
| `agency/desires/[id]/reset.ts` | POST | Core transport | `agency.ts` | `apps/site/src/components/AgencyDashboard.svelte:960` |
| `agency/desires/[id]/retry.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `agency/desires/[id]/revise.ts` | POST | Core transport | `agency.ts` | `apps/site/src/components/AgencyDashboard.svelte:1358` |
| `agency/desires/[id]/run-stream.ts` | POST | Core transport | `agency-workflows.ts` | `apps/site/src/components/AgencyDashboard.svelte:1203` |
| `agency/desires/[id]/run.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `agency/metrics.ts` | GET | Core transport | `agency-metrics.ts` | `apps/site/src/components/AgencyDashboard.svelte:668` |
| `agency/plans.ts` | GET, PUT | Core transport | `agency-plans.ts` | `apps/site/src/components/AgencyDashboard.svelte:794`<br>`apps/site/src/components/AgencyDashboard.svelte:812` |
| `agency/scratchpad.ts` | GET | Core transport | `agency-scratchpad.ts` | `apps/site/src/components/AgencyDashboard.svelte:745`<br>`apps/site/src/components/AgencyDashboard.svelte:776` |
| `agent-catalog/control.ts` | POST | Core transport | `agent-catalog.ts` | `apps/site/src/lib/stores/agent-catalog.ts:106` |
| `agent-catalog/index.ts` | GET | Core transport | `agent-catalog.ts` | `apps/site/src/lib/stores/agent-catalog.ts:64` |
| `agent-config.ts` | GET, POST | Core transport | `agent-config.ts` | `apps/site/src/components/SecuritySettings.svelte:399`<br>`apps/site/src/components/SecuritySettings.svelte:417` |
| `agent.ts` | POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `agents/control.ts` | POST | Core transport | `agent.ts` | `apps/site/src/components/AgentMonitor.svelte:276`<br>`apps/site/src/components/AgentMonitor.svelte:358` |
| `agents/run.ts` | POST | Core transport | `agent.ts` | `apps/site/src/components/AgentMonitor.svelte:244`<br>`apps/site/src/components/AgentCatalogSettings.svelte:116` |
| `app-info.ts` | GET | Core transport | `app-info.ts` | `apps/site/src/lib/client/app-updater.ts:167`<br>`apps/site/src/lib/client/api-config.ts:136` |
| `approvals.ts` | GET, POST | Core transport | `approvals.ts` | `apps/site/src/stores/approvals.ts:64`<br>`apps/site/src/stores/approvals.ts:87` |
| `astro-servers.ts` | GET, POST | Core transport | `astro-servers.ts` | `scripts/validate-security-routes.ts:73`<br>`apps/site/src/components/ServerStatus.svelte:215` |
| `audit-control.ts` | GET, POST | Core transport | `audit-control.ts` | `apps/site/src/components/SystemSettings.svelte:216`<br>`apps/site/src/components/SystemSettings.svelte:238` |
| `audit.ts` | GET | Core transport | `audit.ts` | `scripts/validate-security-routes.ts:84`<br>`apps/site/src/components/AuditViewer.svelte:39` |
| `audit/clear.ts` | DELETE | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `auth/change-password.ts` | POST | Core transport | `auth.ts` | `apps/site/src/components/SecuritySettings.svelte:161` |
| `auth/change-username.ts` | POST | Core transport | `auth.ts` | `apps/site/src/components/SecuritySettings.svelte:116` |
| `auth/guest.ts` | POST | Core transport | `auth.ts` | `scripts/validate-security-routes.ts:41`<br>`apps/site/src/lib/client/api-config.ts:198` |
| `auth/login.ts` | POST | Core transport | `auth.ts` | `scripts/validate-security-routes.ts:38`<br>`brain/agents/profile-sync/core.ts:167` |
| `auth/logout.ts` | POST | Core transport | `auth.ts` | `scripts/validate-security-routes.ts:39`<br>`apps/site/src/lib/client/api-config.ts:202` |
| `auth/me.ts` | GET | Core transport | `auth.ts` | `apps/site/src/lib/client/server-health.ts:81`<br>`apps/site/src/lib/client/server-health.ts:82` |
| `auth/register.ts` | POST | Core transport | `auth.ts` | `scripts/validate-security-routes.ts:40`<br>`apps/site/src/lib/client/api-config.ts:197` |
| `auth/reset-password.ts` | POST | Core transport | `auth.ts` | `scripts/validate-security-routes.ts:43`<br>`apps/site/src/lib/client/api-config.ts:201` |
| `auth/sync-user.ts` | POST | Core transport | `auth.ts` | `scripts/validate-security-routes.ts:42`<br>`apps/site/src/lib/client/api-config.ts:199` |
| `auth/update-profile.ts` | PUT | Core transport | `auth.ts` | `apps/site/src/components/SecuritySettings.svelte:192` |
| `auth/users.ts` | GET | Core transport | `auth.ts` | `apps/site/src/lib/client/api-config.ts:200` |
| `big-brother-config.ts` | GET, POST | Core transport | `big-brother-config.ts` | `scripts/validate-security-routes.ts:90`<br>`apps/site/src/components/BackendSettings.svelte:478` |
| `big-brother-escalate.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `big-brother-status.ts` | GET, POST | Core transport | `big-brother-terminal.ts` | `apps/site/src/components/ServerStatus.svelte:135`<br>`apps/site/src/components/ServerStatus.svelte:244` |
| `buffer-stream.ts` | GET | Core transport | `buffer-stream.ts` | `apps/site/src/components/ChatInterface.svelte:1711` |
| `buffer.ts` | GET | Earlier HTTP retirement | Retired | Individual disposition above |
| `cancel-chat.ts` | POST | Core transport | `persona-chat.ts` | `apps/site/src/components/ChatInterface.svelte:1646` |
| `capture.ts` | POST | Core transport | `memories.ts` | `apps/site/src/components/OnboardingWizard.svelte:220`<br>`packages/core/src/api/handlers/onboarding.ts:116` |
| `chat-settings.ts` | GET, PUT, POST | Core transport | `chat-settings.ts` | `apps/site/src/components/ChatSettings.svelte:33`<br>`apps/site/src/components/ChatSettings.svelte:79` |
| `chat.ts` | POST, DELETE | Earlier unregistered404 residue | Retired | Individual disposition above |
| `chat/history.ts` | GET | Earlier HTTP retirement | Retired | Individual disposition above |
| `cloudflare/start.ts` | POST | Core transport | `cloudflare.ts` | `apps/site/src/components/NetworkServerSettings.svelte:347` |
| `cloudflare/status.ts` | GET | Core transport | `cloudflare.ts` | `scripts/validate-security-routes.ts:98`<br>`scripts/validate-security-routes.ts:137` |
| `cloudflare/stop.ts` | POST | Core transport | `cloudflare.ts` | `apps/site/src/components/NetworkServerSettings.svelte:368` |
| `cloudflare/toggle.ts` | POST | Core transport | `cloudflare.ts` | `apps/site/src/components/SecuritySettings.svelte:306`<br>`apps/site/src/components/NetworkServerSettings.svelte:319` |
| `cognitive-graph.ts` | GET, POST, DELETE | Core transport | `cognitive-graph.ts` | `scripts/validate-security-routes.ts:95`<br>`scripts/smoke-autonomy-vision.mjs:18` |
| `cognitive-graphs.ts` | GET | Core transport | `cognitive-graphs.ts` | `apps/site/src/components/flow-editor/FlowEditorLayout.svelte:107` |
| `cognitive-mode.ts` | GET, POST | Core transport | `cognitive-mode.ts` | `apps/site/src/components/ChatLayout.svelte:132`<br>`apps/site/src/components/ChatLayout.svelte:148` |
| `conversation-buffer.ts` | GET, DELETE | Core transport | `conversation.ts` | `scripts/validate-security-routes.ts:78`<br>`apps/site/src/lib/client/composables/useMessages.ts:97` |
| `curiosity-config.ts` | GET, POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `embeddings.ts` | GET, POST | Core transport | `embeddings.ts` | `apps/site/src/components/SystemSettings.svelte:390`<br>`apps/site/src/components/SystemSettings.svelte:413` |
| `encryption/index.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `encryption/lock.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `encryption/setup.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `encryption/unlock.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `environment-bridge/action-result.ts` | POST | Core transport | `environment-bridge.ts` | `scripts/validate-security-routes.ts:47`<br>`brain/agents/environment-bridge/core.ts:397` |
| `environment-bridge/behavior-settings.ts` | POST | Core transport | `environment-bridge.ts` | `brain/agents/environment-bridge/core.ts:806` |
| `environment-bridge/control.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `environment-bridge/diagnostics.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `environment-bridge/diagnostics/audio.ts` | POST | Core transport | `environment-bridge.ts` | `scripts/validate-security-routes.ts:48`<br>`brain/agents/environment-bridge/core.ts:210` |
| `environment-bridge/diagnostics/media.ts` | GET | Core transport | `environment-bridge.ts` | `apps/site/src/components/EnvironmentBridgeDiagnostics.svelte:45` |
| `environment-bridge/observation.ts` | POST | Core transport | `environment-bridge.ts` | `scripts/validate-security-routes.ts:46`<br>`brain/agents/environment-bridge/core.ts:698` |
| `environment-bridge/status.ts` | GET | Core transport | `environment-bridge.ts` | `apps/site/src/lib/client/flow-editor/property-suggestions.ts:39`<br>`apps/site/src/lib/client/flow-editor/property-suggestions.ts:45` |
| `environment-bridge/stream.ts` | GET | Core transport | `environment-bridge.ts` | `brain/agents/environment-bridge/core.ts:239` |
| `environment-bridge/telemetry.ts` | POST | Core transport | `environment-bridge.ts` | `scripts/validate-security-routes.ts:49`<br>`brain/agents/environment-bridge/core.ts:351` |
| `environment-bridge/visual-result.ts` | POST | Core transport | `environment-bridge.ts` | `brain/agents/environment-bridge/core.ts:844` |
| `environment-training.ts` | GET | Core transport | `environment-training.ts` | `apps/site/src/components/EnvironmentTrainingMemory.svelte:27`<br>`apps/site/src/components/EnvironmentTrainingMemory.svelte:39` |
| `environment-training/review.ts` | POST | Core transport | `environment-training.ts` | `apps/site/src/components/EnvironmentTrainingMemory.svelte:59` |
| `event-bus-status.ts` | GET, POST | Core transport | `event-bus-status.ts` | `apps/site/src/components/ServerStatus.svelte:152`<br>`apps/site/src/components/ServerStatus.svelte:265` |
| `execute-graph-stream.ts` | POST | Core transport | `execute-graph-stream.ts` | `scripts/smoke-autonomy-vision.mjs:21`<br>`apps/site/src/components/flow-editor/FlowEditorLayout.svelte:331` |
| `execute-graph.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `execute.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `export/conversations.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `feedback.ts` | POST | Core transport | `feedback.ts` | `apps/site/src/components/chat/FeedbackButtons.svelte:53` |
| `file_operations.ts` | GET, POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `fine-tune/models.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `functions.ts` | GET | Retired with Function Memory | Retired | Learning and dedicated retrieval callers were removed with the legacy operator/context builder. Functions UI, API, module and public exports retired; stored records and generic memory-index history reader retained. |
| `gpu-status.ts` | GET | Core transport | `gpu-status.ts` | `apps/site/src/components/GPUMonitor.svelte:94` |
| `graph-traces.ts` | GET | Core transport | `graph-traces.ts` | `scripts/validate-security-routes.ts:96`<br>`apps/site/src/components/flow-editor/ExecutionPanel.svelte:46` |
| `index/index.ts` | GET, POST | Core transport | `vector-index.ts` | `apps/site/src/components/MemoryControls.svelte:32`<br>`apps/site/src/components/MemoryControls.svelte:46` |
| `internal/work-coordinator/enqueue.ts` | POST | Core transport | `unified-queue.ts` | `scripts/validate-security-routes.ts:50`<br>`packages/core/src/queue/work-submission.ts:18` |
| `kokoro-server.ts` | GET, POST | Core transport | `tts-service-routes.ts` | `apps/site/src/components/ServerStatus.svelte:80`<br>`apps/site/src/components/VoiceSettings.svelte:713` |
| `llm-backend/config.ts` | GET, PUT | Core transport | `llm-backend-config.ts` | `scripts/validate-security-routes.ts:97`<br>`apps/site/src/components/BackendSettings.svelte:298` |
| `llm-backend/ollama.ts` | POST | Core transport | `llm-backend-ollama.ts` | `apps/site/src/components/BackendSettings.svelte:457` |
| `llm-backend/status.ts` | GET | Core transport | `llm-backend-status.ts` | `apps/site/src/components/ServerStatus.svelte:116`<br>`apps/site/src/components/BackendSettings.svelte:317` |
| `llm-backend/switch.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `llm/chat.ts` | POST | Core transport | `llm-proxy.ts` | `packages/core/src/providers/bridge.ts:338` |
| `local-models/config.ts` | GET, PUT | Earlier unregistered404 residue | Retired | Individual disposition above |
| `local-models/download.ts` | POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `local-models/load.ts` | POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `local-models/models.ts` | GET | Earlier unregistered404 residue | Retired | Individual disposition above |
| `local-models/start.ts` | POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `local-models/status.ts` | GET | Earlier unregistered404 residue | Retired | Individual disposition above |
| `local-models/stop.ts` | POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `local-models/unload.ts` | POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `logging-config.ts` | GET, POST | Core transport | `logging-config.ts` | `apps/site/src/components/SystemSettings.svelte:299`<br>`apps/site/src/components/SystemSettings.svelte:311` |
| `memories.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `memories/delete.ts` | POST | Core transport | `memories-delete.ts` | `apps/site/src/lib/client/composables/useMessages.ts:119`<br>`apps/site/src/components/CenterContent.svelte:475` |
| `memories/search.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `memories/validate.ts` | POST | Core transport | `memories-validate.ts` | `apps/site/src/components/CenterContent.svelte:454`<br>`apps/site/src/components/ChatInterface.svelte:1750` |
| `memories_all.ts` | GET | Core transport | `memories-all.ts` | `apps/site/src/components/CenterContent.svelte:215` |
| `memory-content.ts` | GET, PUT | Core transport | `memory-content.ts` | `scripts/validate-security-routes.ts:94`<br>`apps/site/src/components/MemoryEditor.svelte:29` |
| `memory-metrics.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `memory/sync/[id].ts` | GET, DELETE | Core transport | `memory-sync-item.ts` | `apps/site/src/lib/client/memory-sync.ts:299`<br>`apps/site/src/lib/client/memory-sync.ts:304` |
| `memory/sync/pull.ts` | GET | Core transport | `memory-sync-item.ts`, `memory-sync.ts` | ProfileLocation / shared owner trace |
| `memory/sync/push.ts` | POST, PUT | Core transport | `memory-sync-item.ts`, `memory-sync.ts` | `apps/site/src/lib/client/memory-sync.ts:299`<br>`apps/site/src/lib/client/memory-sync.ts:304` |
| `mobile/download.ts` | GET | Core transport | `mobile-download.ts` | `apps/site/src/lib/client/app-updater.ts:101`<br>`apps/react-native/App.tsx:232` |
| `mobile/version.ts` | GET | Core transport | `mobile-version.ts` | `apps/site/src/lib/client/app-updater.ts:217` |
| `model-info.ts` | GET | Core transport | `model-info.ts` | `apps/site/src/components/SystemSettings.svelte:288` |
| `model-registry.ts` | GET, POST, PUT | Core transport | `model-registry.ts` | `apps/site/src/components/ModelRegistrySettings.svelte:62`<br>`apps/site/src/components/ModelRegistrySettings.svelte:88` |
| `monitor.ts` | GET | Core transport | `monitor.ts` | `scripts/validate-security-routes.ts:87`<br>`scripts/validate-agent-monitor.ts:222` |
| `monitor/agent-variable.ts` | POST | Core transport | `monitor.ts` | `scripts/validate-agent-monitor.ts:88`<br>`scripts/validate-agent-monitor.ts:107` |
| `monitor/stream.ts` | GET | Core transport | `monitor-stream.ts` | `apps/site/src/components/AgentMonitor.svelte:378` |
| `mood-settings.ts` | GET, PUT | Core transport | `mood-settings.ts` | `apps/site/src/components/MoodAgentSettings.svelte:32`<br>`apps/site/src/components/MoodAgentSettings.svelte:49` |
| `node-pipeline.ts` | GET, POST | Core transport | `node-pipeline.ts` | `scripts/validate-security-routes.ts:74`<br>`apps/site/src/components/SystemSettings.svelte:168` |
| `node-schemas.ts` | GET | Core transport | `node-schemas.ts` | `apps/site/src/lib/client/flow-editor/template-converter.ts:115`<br>`apps/site/src/components/NodePalette.svelte:20` |
| `ollama/loras.ts` | GET, PUT | Core transport | `ollama-loras.ts` | `apps/site/src/components/BackendSettings.svelte:247`<br>`apps/site/src/components/BackendSettings.svelte:268` |
| `onboarding/complete.ts` | POST | Core transport | `onboarding.ts` | `apps/site/src/components/onboarding/Step6_Complete.svelte:51`<br>`apps/site/src/components/OnboardingWizard.svelte:108` |
| `onboarding/extract-persona.ts` | POST | Core transport | `onboarding-persona.ts` | `apps/site/src/components/onboarding/Step3_Personality.svelte:93` |
| `onboarding/skip.ts` | POST | Core transport | `onboarding.ts` | `apps/site/src/components/OnboardingWizard.svelte:128` |
| `onboarding/state.ts` | GET, POST | Core transport | `onboarding.ts` | `apps/site/src/components/onboarding/Step4_Context.svelte:112`<br>`apps/site/src/components/onboarding/Step5_Goals.svelte:110` |
| `operator-proposals/improve.ts` | POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `operator-proposals/index.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `operator-proposals/post-feedback.ts` | POST | Core transport | `operator-proposals.ts` | `apps/site/src/stores/proposals.ts:237` |
| `operator-proposals/respond.ts` | POST | Core transport | `operator-proposals.ts` | `apps/site/src/stores/proposals.ts:211` |
| `operator-proposals/review.ts` | POST | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `operator-proposals/stream.ts` | GET | Core transport | `operator-proposals.ts` | `apps/site/src/stores/proposals.ts:99` |
| `pause-state.ts` | GET, POST | Core transport | `pause-state.ts` | `apps/site/src/lib/client/composables/useTTS.ts:119` |
| `persona-archives.ts` | GET, POST | Core transport | `persona-archives.ts` | `apps/site/src/components/PersonaEditor.svelte:369`<br>`apps/site/src/components/PersonaEditor.svelte:391` |
| `persona-core-manage.ts` | GET, POST | Core transport | `persona-core-manage.ts` | `apps/site/src/components/PersonaEditor.svelte:145`<br>`apps/site/src/components/PersonaEditor.svelte:168` |
| `persona-core.ts` | GET, POST | Core transport | `persona.ts` | `apps/site/src/components/onboarding/Step5_Goals.svelte:78`<br>`apps/site/src/components/AuthGate.svelte:227` |
| `persona-decision-rules.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `persona-facet.ts` | GET, POST | Core transport | `persona-facet.ts` | `apps/site/src/components/LeftSidebar.svelte:303`<br>`apps/site/src/components/LeftSidebar.svelte:338` |
| `persona-facets-manage.ts` | GET, POST | Core transport | `persona-facets-manage.ts` | `apps/site/src/components/PersonaEditor.svelte:150`<br>`apps/site/src/components/PersonaEditor.svelte:190` |
| `persona-icon.ts` | GET | Core transport | `persona-icon.ts` | `apps/site/src/components/ChatLayout.svelte:416` |
| `persona-insights.ts` | GET | Core transport | `persona-insights.ts` | `apps/site/src/components/PersonaEditor.svelte:310` |
| `persona-relationships.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `persona-routines.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `persona-toggle.ts` | GET, POST | Core transport | `persona-toggle.ts` | `apps/site/src/components/LeftSidebar.svelte:277` |
| `persona.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `persona/generator/add-notes.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/PersonaGenerator.svelte:422` |
| `persona/generator/answer.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/onboarding/PersonaGeneratorEmbed.svelte:82`<br>`apps/site/src/components/PersonaGenerator.svelte:261` |
| `persona/generator/apply.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/onboarding/PersonaGeneratorEmbed.svelte:168`<br>`apps/site/src/components/PersonaGenerator.svelte:347` |
| `persona/generator/discard.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/PersonaGenerator.svelte:387` |
| `persona/generator/finalize.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/onboarding/PersonaGeneratorEmbed.svelte:141`<br>`apps/site/src/components/PersonaGenerator.svelte:317` |
| `persona/generator/load.ts` | GET | Core transport | `persona-generator.ts` | `apps/site/src/components/PersonaGenerator.svelte:122`<br>`apps/site/src/components/PersonaGenerator.svelte:172` |
| `persona/generator/purge-sessions.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/PersonaGenerator.svelte:453` |
| `persona/generator/reset-persona.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/PersonaGenerator.svelte:484` |
| `persona/generator/start.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/onboarding/PersonaGeneratorEmbed.svelte:45`<br>`apps/site/src/components/PersonaGenerator.svelte:137` |
| `persona/generator/update-answer.ts` | POST | Core transport | `persona-generator.ts` | `apps/site/src/components/PersonaGenerator.svelte:221` |
| `persona/summary.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `persona_chat.ts` | DELETE | Core transport | `persona-chat.ts` | `apps/site/src/lib/client/api-config.ts:225`<br>`packages/core/src/queue/chat-work-handler.ts:41` |
| `profile-path.ts` | GET, PUT, DELETE, POST | Core transport; migration POST moved to Core | `profile-path.ts` | `apps/site/src/components/ProfileLocation.svelte:172`<br>`apps/site/src/components/ProfileLocation.svelte:288` |
| `profile-path/decrypt.ts` | POST | Core transport | `profile-encryption.ts` | `apps/site/src/components/ProfileLocation.svelte:499` |
| `profile-path/devices.ts` | GET | Core transport | `storage-devices.ts` | `apps/site/src/components/ProfileLocation.svelte:190` |
| `profile-path/encrypt.ts` | POST | Core transport | `profile-encryption.ts` | `apps/site/src/components/ProfileLocation.svelte:417` |
| `profile-path/validate.ts` | POST | Core transport | `profile-path.ts` | `apps/site/src/components/ProfileLocation.svelte:228` |
| `profile-sync/config.ts` | GET, PUT, DELETE | Core transport | `profile-sync-config.ts` | `apps/site/src/lib/client/profile-sync.ts:38`<br>`apps/site/src/lib/client/profile-sync.ts:51` |
| `profile-sync/credentials.ts` | GET, POST | Core transport | `credentials-sync.ts` | `brain/agents/profile-sync/core.ts:209` |
| `profile-sync/export-priority.ts` | GET, POST | Core transport | `profile-sync.ts` | `scripts/validate-security-routes.ts:44`<br>`brain/agents/profile-sync/core.ts:190` |
| `profile-sync/import.ts` | POST | Core transport | `profile-sync.ts` | `apps/site/src/lib/client/api-config.ts:228` |
| `profile-sync/memories.ts` | GET, POST | Core transport | `profile-sync.ts` | `scripts/validate-security-routes.ts:45`<br>`brain/agents/profile-sync/core.ts:231` |
| `profile-sync/user.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `profiles/create.ts` | POST | Core transport | `profiles-manage.ts` | `apps/site/src/components/ProfileCreation.svelte:55` |
| `profiles/delete.ts` | POST | Core transport | `profiles-manage.ts` | `apps/site/src/components/ProfileDangerZone.svelte:115` |
| `profiles/list.ts` | GET | Core transport | `profiles.ts` | `scripts/validate-security-routes.ts:82`<br>`apps/site/src/components/ProfileDangerZone.svelte:60` |
| `profiles/select.ts` | POST | Core transport | `profiles-manage.ts` | `apps/site/src/components/ProfileSelector.svelte:48` |
| `profiles/visibility.ts` | GET, POST | Core transport | `profiles.ts` | `apps/site/src/components/SecuritySettings.svelte:244`<br>`apps/site/src/components/SecuritySettings.svelte:261` |
| `psychoanalyzer-config.ts` | GET, POST | Core transport | `psychoanalyzer-config.ts` | `apps/site/src/components/AgentCatalogSettings.svelte:137`<br>`apps/site/src/components/AgentCatalogSettings.svelte:154` |
| `queue-stream.ts` | GET | Core transport | `unified-queue.ts` | `apps/site/src/lib/stores/work-coordinator.ts:61` |
| `queue/lane-control.ts` | GET, POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `queue/metrics.ts` | GET | Earlier unregistered404 residue | Retired | Individual disposition above |
| `recovery-codes.ts` | GET, POST | Core transport | `recovery-codes.ts` | `apps/site/src/components/SecuritySettings.svelte:488`<br>`apps/site/src/components/SecuritySettings.svelte:506` |
| `remote-server/connect.ts` | POST | Core transport | `remote-server.ts` | `apps/site/src/components/BackendSettings.svelte:574` |
| `remote-server/disconnect.ts` | DELETE | Core transport | `remote-server.ts` | `apps/site/src/components/BackendSettings.svelte:605` |
| `remote-server/health.ts` | GET | Core transport | `remote-server.ts` | `apps/site/src/components/LeftSidebar.svelte:156` |
| `remote-server/models.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `remote-server/test.ts` | POST | Core transport | `remote-server.ts` | `apps/site/src/components/BackendSettings.svelte:542` |
| `reset-factory.ts` | GET, POST | Core transport | `reset-factory.ts` | `apps/site/src/components/SecuritySettings.svelte:546` |
| `response-pipeline.ts` | POST | Core transport | `response-pipeline.ts` | `packages/core/src/queue/chat-work-handler.ts:41` |
| `runpod/config.ts` | GET | Core transport | `runpod-config.ts` | `apps/site/src/components/TrainingWizard.svelte:285` |
| `runpod/validate.ts` | POST | Core transport | `runpod-validate.ts` | `apps/site/src/components/TrainingWizard.svelte:413` |
| `runtime/mode.ts` | GET, POST | Core transport | `runtime-mode.ts` | `scripts/validate-security-routes.ts:88`<br>`apps/site/src/components/HeadlessClaimBanner.svelte:24` |
| `rvc-server.ts` | GET, POST | Earlier unregistered404 residue | Retired | Individual disposition above |
| `rvc-training.ts` | GET, POST | Core transport | `voice-training-routes.ts` | `scripts/validate-security-routes.ts:81`<br>`apps/site/src/components/VoiceTrainingWidget.svelte:89` |
| `scheduler-config.ts` | GET, POST | Earlier HTTP retirement | Retired | Individual disposition above |
| `security/policy.ts` | GET | Core transport | `security-policy.ts` | `apps/site/src/stores/security-policy.ts:83` |
| `semantic-turn.ts` | POST | Core transport | `semantic-turn.ts` | `apps/site/src/lib/client/api-config.ts:226` |
| `server-info.ts` | GET | Core transport | `server-info.ts` | `apps/site/src/components/NetworkServerSettings.svelte:239` |
| `server-update.ts` | GET, POST | Core transport | `server-update.ts` | `apps/site/src/lib/client/app-updater.ts:255`<br>`apps/site/src/lib/client/app-updater.ts:359` |
| `server-update/restart.ts` | POST | Core transport | `server-update.ts` | `apps/site/src/lib/client/app-updater.ts:413` |
| `sleep-status.ts` | GET | Core transport | `sleep-status.ts` | `apps/site/src/lib/stores/sleep-status.ts:57` |
| `status.ts` | GET | Core transport | `status.ts` | `apps/site/src/components/LeftSidebar.svelte:582`<br>`apps/site/src/components/Dashboard.svelte:93` |
| `storage-status.ts` | GET | Core transport | `storage-status.ts` | `scripts/validate-security-routes.ts:91`<br>`apps/site/src/components/SystemSettings.svelte:322` |
| `stt.ts` | POST | Core transport | `stt.ts` | `apps/site/src/lib/client/composables/useMicrophone.ts:1520`<br>`apps/site/src/components/VoiceSettings.svelte:474` |
| `system-error.ts` | POST | Core transport | `system-error.ts` | `apps/site/src/lib/client/system-errors.ts:5` |
| `system-status.ts` | GET | Core transport | `system-status.ts` | `apps/site/src/components/ChatLayout.svelte:181` |
| `system/gpu-info.ts` | GET | Core transport | `gpu-info.ts` | `apps/site/src/components/TrainingWizard.svelte:260`<br>`apps/site/src/components/AutomaticTraining.svelte:211` |
| `tasks.ts` | GET, POST, PATCH | Core transport | `tasks.ts` | `apps/site/src/components/onboarding/Step5_Goals.svelte:93`<br>`apps/site/src/components/TaskManager.svelte:135` |
| `template-watch.ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `template/[name].ts` | GET | HTTP retired; individual disposition above | Retired | Individual disposition above |
| `terminal/events.ts` | GET | Core transport | `terminal.ts` | `apps/site/src/components/terminal/controller.ts:59` |
| `terminal/message.ts` | POST | Core transport | `terminal.ts` | ProfileLocation / shared owner trace |
| `terminal/sessions.ts` | POST | Core transport | `terminal.ts` | ProfileLocation / shared owner trace |
| `terminal/state.ts` | GET | Core transport | `terminal.ts` | ProfileLocation / shared owner trace |
| `training-config.ts` | GET, POST | Core transport | `training.ts` | `scripts/validate-security-routes.ts:79`<br>`apps/site/src/components/TrainingWizard.svelte:224` |
| `training-data.ts` | GET, POST | Core transport | `training.ts` | `apps/site/src/components/TrainingWizard.svelte:367`<br>`apps/site/src/components/TrainingWizard.svelte:382` |
| `training-models.ts` | GET | Core transport | `training-models.ts` | `apps/site/src/components/TrainingWizard.svelte:227` |
| `training/[operation].ts` | GET | Core transport | `training.ts` | `scripts/validate-security-routes.ts:64`<br>`scripts/validate-security-routes.ts:65` |
| `training/automatic.ts` | GET, POST | Core transport | `training-automation.ts`, `training.ts` | `apps/site/src/components/AutomaticTraining.svelte:197`<br>`apps/site/src/components/AutomaticTraining.svelte:249` |
| `training/cancel.ts` | POST | Core transport | `training.ts` | `scripts/validate-security-routes.ts:65`<br>`apps/site/src/components/TrainingWizard.svelte:551` |
| `training/console-logs.ts` | GET | Core transport | `training-console-logs.ts`, `training.ts` | `apps/site/src/components/TrainingWizard.svelte:488`<br>`apps/site/src/components/TrainingHistory.svelte:165` |
| `training/dataset-stats.ts` | GET | Core transport | `training-dataset-stats.ts`, `training.ts` | `apps/site/src/components/TrainingWizard.svelte:351` |
| `training/history.ts` | GET, POST | Core transport | `training-history.ts`, `training.ts` | `apps/site/src/components/TrainingWizard.svelte:504`<br>`apps/site/src/components/TrainingHistory.svelte:25` |
| `training/launch.ts` | POST | Core transport | `training.ts` | `scripts/validate-security-routes.ts:64`<br>`apps/site/src/components/TrainingWizard.svelte:594` |
| `training/log-file.ts` | GET | Core transport | `training-log-file.ts`, `training.ts` | `apps/site/src/components/TrainingHistory.svelte:255` |
| `training/logs.ts` | GET | Core transport | `training-logs.ts`, `training.ts` | `apps/site/src/components/TrainingWizard.svelte:480`<br>`apps/site/src/components/TrainingHistory.svelte:99` |
| `training/running.ts` | GET | Core transport | `training-running.ts`, `training.ts` | `apps/site/src/components/TrainingWizard.svelte:497`<br>`apps/site/src/components/TrainingWizard.svelte:639` |
| `training/status.ts` | GET | Core transport | `training-status.ts`, `training.ts` | `apps/site/src/components/TrainingMonitor.svelte:36` |
| `trigger-manager/config.ts` | PATCH | Core transport | `trigger-manager.ts` | `apps/site/src/lib/stores/trigger-manager.ts:176`<br>`apps/site/src/components/SystemSettings.svelte:363` |
| `trigger-manager/control.ts` | POST | Core transport | `trigger-manager.ts` | `apps/site/src/lib/stores/trigger-manager.ts:135` |
| `trigger-manager/index.ts` | GET | Core transport | `trigger-manager.ts` | `apps/site/src/lib/stores/trigger-manager.ts:98`<br>`apps/site/src/components/SystemSettings.svelte:340` |
| `trust-coupling.ts` | GET, POST | Core transport | `trust-coupling.ts` | `apps/site/src/components/SecuritySettings.svelte:442`<br>`apps/site/src/components/SecuritySettings.svelte:460` |
| `trust.ts` | GET, POST | Core transport | `trust.ts` | `scripts/validate-security-routes.ts:83`<br>`apps/site/src/components/ApprovalPrompt.svelte:155` |
| `tts-queue-delivery.ts` | POST | Core transport | `tts-queue-stream.ts` | `apps/site/src/components/TTSQueueConsumer.svelte:34` |
| `tts-queue-interrupt.ts` | POST | Core transport | `tts-queue-stream.ts` | `apps/site/src/components/ChatInterface.svelte:318` |
| `tts-queue-stream.ts` | GET | Core transport | `tts-queue-stream.ts` | `apps/site/src/components/TTSQueueConsumer.svelte:165` |
| `tts-stream.ts` | POST | Core transport | `tts-stream.ts` | `apps/site/src/lib/client/composables/useTTS.ts:468` |
| `tts.ts` | POST, GET | Core transport | `tts.ts` | `apps/site/src/lib/client/composables/useTTS.ts:457`<br>`apps/site/src/components/VoiceSettings.svelte:326` |
| `unified-queue/activity.ts` | POST | Earlier HTTP retirement | Retired | Individual disposition above |
| `unified-queue/clear.ts` | POST | Core transport | `unified-queue.ts` | `scripts/validate-security-routes.ts:60`<br>`apps/site/src/components/QueuePanel.svelte:64` |
| `unified-queue/control.ts` | POST | Core transport | `unified-queue.ts` | `scripts/validate-security-routes.ts:59`<br>`apps/site/src/components/QueuePanel.svelte:91` |
| `unified-queue/executions/[id].ts` | DELETE, POST | Core transport | `unified-queue.ts` | `apps/site/src/components/QueuePanel.svelte:68`<br>`apps/site/src/components/QueuePanel.svelte:77` |
| `unified-queue/index.ts` | GET, POST | Core transport | `unified-queue.ts` | `scripts/validate-security-routes.ts:92`<br>`apps/site/src/components/architecture-map/architecture.json:1513` |
| `unified-queue/tasks/[id].ts` | GET, DELETE | Core transport | `unified-queue.ts` | `apps/site/src/components/QueuePanel.svelte:60`<br>`apps/site/src/components/QueuePanel.svelte:85` |
| `unified-queue/tasks/[id]/stream.ts` | GET | Core transport | `unified-queue.ts` | `apps/site/src/lib/client/profile-sync.ts:83`<br>`apps/site/src/components/ChatInterface.svelte:590` |
| `unified-queue/trigger/[agentId].ts` | POST | Core transport | `unified-queue.ts` | `apps/site/src/lib/client/profile-sync.ts:71`<br>`apps/site/src/components/AuthGate.svelte:250` |
| `unified-queue/triggers.ts` | GET | Earlier HTTP retirement | Retired | Individual disposition above |
| `update-state.ts` | GET | Earlier unregistered404 residue | Retired | Individual disposition above |
| `user-guide/[id].ts` | GET | Core transport | `user-guide.ts` | `apps/site/src/components/UserGuide.svelte:83`<br>`apps/site/src/components/UserGuide.svelte:128` |
| `user-guide/index.ts` | GET | Core transport | `user-guide.ts` | `apps/site/src/components/UserGuide.svelte:50` |
| `user-guide/search.ts` | GET | Core transport | `user-guide.ts` | `apps/site/src/components/UserGuide.svelte:128` |
| `veracrypt/status.ts` | GET | Core transport | `veracrypt-status.ts` | `apps/site/src/components/ProfileLocation.svelte:155` |
| `voice-models.ts` | GET | Core transport | `voice-models.ts` | `apps/site/src/lib/client/composables/useTTS.ts:372` |
| `voice-profile/upload.ts` | POST | Core transport | `audio-uploads.ts` | `apps/site/src/components/DirectVoiceRecorder.svelte:181` |
| `voice-samples/[sampleId].ts` | GET | Core transport | `voice-samples.ts` | `apps/site/src/components/ReferenceAudioSelector.svelte:128` |
| `voice-settings.ts` | GET, POST | Core transport | `voice-settings.ts` | `apps/site/src/lib/client/composables/useMicrophone.ts:468`<br>`apps/site/src/lib/client/composables/useTTS.ts:400` |
| `voice-status.ts` | GET | Core transport | `voice-status.ts` | `apps/site/src/components/Dashboard.svelte:94` |
| `voice-training.ts` | GET, POST | Core transport | `voice-training-routes.ts` | `scripts/validate-security-routes.ts:80`<br>`apps/site/src/components/ReferenceAudioSelector.svelte:42` |
| `whisper-server.ts` | GET, POST | Core transport | `whisper-server.ts` | `apps/site/src/components/ServerStatus.svelte:79`<br>`apps/site/src/components/VoiceSettings.svelte:915` |
