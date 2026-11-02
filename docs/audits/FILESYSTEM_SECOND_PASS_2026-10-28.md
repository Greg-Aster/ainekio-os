# Whole-repository filesystem and unused-system review — second pass

This is the requested second review after the removals in the [first coverage report](FILESYSTEM_COVERAGE_2026-10-28.md). It records current findings, not authorization to delete everything listed. The census itself was read-only. The subsequently authorized cleanup is recorded below and in the cleanup diary; model assignments and installed services were not changed.

## Coverage

- Fresh recursive census: **406,330 regular files, 50,920 directories and 4,920 symlinks**, totaling **462,170 entries**, with **zero traversal errors**. It included every exposed root area, hidden/ignored files, dependencies, external checkouts, builds, logs, profiles and Git metadata. The scan took 310 seconds.
- Approximately **112.178 GiB allocated** to regular files, deduplicated by device/inode. The installation remained active; these are observations over the scan, not an atomic snapshot or a promised reclaimable amount.
- Symlinks were recorded rather than followed outside the repository. All 4,920 recorded links resolved when checked. Protected/virtualized session directories were inventoried only as exposed to the session.
- Reference triage covered **1,899 files**: 1,863 maintained tracked files plus 36 untracked files outside the maintained-policy exclusions. Read **1,842 text files**, with zero read failures. This pass did **not** restrict investigation to old timestamps; 329 maintained tracked files were older than 180 days.
- Reviewed package commands, imports/re-exports, Astro routes, dynamic component selection, agent/service catalogs, executable resolution, compiled-agent entrypoints, mobile bindings, model configuration references, and graph artifact readers. No missing literal package-command inputs or registered agent/service source paths were found.
- Inspected readable host process arguments, mapped files, working directories and open files. Twenty-two processes referenced repository paths; 322 process records were not fully readable. Process absence alone was not treated as proof of an orphan.

The complete filesystem catalog and a row for every one of the 1,899 source/configuration/document candidates are saved privately under `/tmp/metahuman-pass2-*`. This establishes whole-tree coverage and specific ownership findings, not line-by-line semantic certification of 406,330 file bodies.

## 1. Unused context assembly implementation

- **Owner:** current registered context nodes and saved graphs; `packages/core/src/index.ts` exposes the obsolete module.
- **Finding:** `packages/core/src/context-builder.ts` is 1,104 lines. Its exported `buildContextPackage`, `formatContextForPrompt`, `validateContextPackage`, and associated exported types have no operational consumers found. It was exposed by both the root Core re-export and a package subpath export; neither had an operational consumer. Adjacent robot/refiner source searches also found no consumers.
- **Why it matters:** this leaves a substantial alternate description and implementation of context assembly, including its own caches and formatting rules, available to future contributors even though current execution uses graph nodes. This is maintenance drift; no claim is made that its unused functions currently execute or slow inference.
- **Completed cleanup:** removed the module, its root/subpath exports, its unconsumed `state.ts` and `recent-tools-cache.ts` dependencies, and four context-policy helpers. Removed the live cache writer from memory capture, its reset flush, and profile directory provisioning. Canonical tool-result persistence remains intact. Keep `nodes/context/context-builder.node.ts`, `nodes/environment/context-builder.node.ts`, their registrations, and saved graph wiring.
- **Checks for removal:** Core and downstream consumer typechecks, architecture, graph validation and focused context/Environment regressions. Do not change the active nodes' prompts, context selection or token behavior.

## 2. Unused Site components, event store and file-operation parser

| Candidate | Evidence | Surviving owner |
| --- | --- | --- |
| `apps/site/src/components/DesireCard.svelte` — 296 lines | No import or dynamic component registration found | `CenterContent.svelte` loads `AgencyDashboard.svelte`; retain the current Agency UI and API |
| `apps/site/src/components/LogStream.svelte` — 289 lines | No import or dynamic component registration found | `/audit` mounts `AuditViewer.svelte`; Core owns audit records |
| `apps/site/src/stores/clear-events.ts` — 17 lines | Only imported by unused LogStream; neither trigger helper has callers, and the chat trigger has no consumer | Existing conversation and audit controls |
| `apps/site/src/lib/server/file_operations.ts` — 171 lines | No imports/callers of its keyword parser or execution wrapper found | `packages/core/src/api/handlers/file-operations.ts`, registered in the current router with authentication/owner checks |

All four files were removed in the authorized cleanup. The two Svelte components had prior type-only edits; their exact pre-removal contents were preserved in the private task snapshot. Agency, audit and file-writing capabilities remain with the surviving owners. The old keyword parser is not the active file-operation API. Retaining it invites a second interpretation/execution path if reused.

Validation should exercise current UI entrypoints and their owners, plus Site typecheck/build. Do not add replacement components or another event store.

## 3. Nine unconsumed finite-agent adapter modules

The following `brain/agents/<name>/index.ts` modules total 192 lines:

- `audio-organizer`
- `body-event-trigger`
- `curator`
- `curiosity-researcher`
- `desire-planner`
- `environment-training-curator`
- `environment-training-trainer`
- `mood`
- `train-of-thought`

No imports, literal source references or inspected root/profile configuration references target these modules. Each directory has a `cli.ts`; the current executable resolver selects that CLI first, and the compiled-agent builder uses that same resolver. `brain/mobile-agents.ts` does not register these nine adapters. Some comments still claim registration through agent-runtime, whose current responsibility is shared contracts rather than agent loading.

**Retained after validation:** the architecture checker requires `core.ts`, `cli.ts`, and `index.ts` for every agent directory. These nine modules were restored byte-for-byte after that check exposed the contract dependency. Absence of a current direct caller does not make a required agent adapter removable. The earlier removal recommendation was incomplete; no checker rule or baseline was relaxed.

Other `index.ts` modules are **not** covered by this removal set: nine are current mobile bindings; the Environment Bridge has a service entrypoint; Active Operator and Daydreamer have current configuration/test boundaries. Do not apply a blanket deletion of agent index files.

The initial findings 1–3 identified 14 candidates; nine remain contract-required. Including the deeper orphan dependencies and graph-copy script, the completed cleanup removed **8 source files / 2,499 lines**, plus obsolete wiring and helpers.

## 4. Public graph artifacts retain retired and divergent workflows

- **Owners:** `etc/cognitive-graphs/` owns canonical workflows. Core's template/graph handlers read that directory; the editor uses those APIs. The removed `scripts/sync-cognitive-graph-artifacts.ts` manually copied named graphs into `apps/site/public/cognitive-graphs/`.
- **Inventory:** 45 canonical graphs and 21 public copies.
- **Retired public copies with no canonical counterpart:** `environment-freestyle-mode.json`, `robot-action-result-mode.json`.
- **Semantic drift:** `robot-status-mode.json` and `body-event-trigger-mode.json`. The public Robot Status graph has 10 nodes versus 12 in the canonical graph and lacks the `autonomy-input` and `camera-evidence` nodes. The body-event graph differs in event-node properties.
- **Not drift:** 17 public copies remain semantically equal; four of these differ only in JSON formatting. Raw byte differences were not counted as behavioral divergence.
- **Validation gap:** `pnpm validate:graphs` passes all 45 canonical graphs. It compares public/canonical content only for `dual-mode.json`, so this passing result does not detect the retired or divergent public files.

No current application consumer of the public `/cognitive-graphs/*.json` URLs was found. The authorized cleanup removed all 21 public copies, the manual copy script and package command, and the Dual mirror validator. Core APIs and mobile packaging continue using the canonical directory. The existing Environment prompt-contract regression now reads that canonical graph and retains its prompt-definition and wiring assertions. All 45 canonical JSON files remain byte-for-byte unchanged. These retired static URLs are no longer included in new Site builds.

## 5. Regression files exist outside maintained test commands

Checked all **329 TypeScript/JavaScript test files**, including `.ts`, `.tsx`, `.mts`, `.mjs` and `.js`. Of these, **152** are named by package scripts, matched by their explicit test globs, or covered by the React Native Jest discovery configuration. **177** have no package-command registration; no import path from a registered test reaches them. The current CI workflow names tests already in the registered group.

Examples include `apps/site/src/lib/client/server-health.spec.ts`, numerous flow-editor regressions, Environment Bridge audio/speech tests, agent-core regressions and Core lifecycle tests. `apps/react-native/nodejs-assets/nodejs-project/mobile-agent-lifecycle.spec.js` is also explicitly excluded by Jest's `nodejs-assets` ignore rule. Some suites have documented manual invocations, which do not make them part of `pnpm verify`.

**These are not 177 files to delete.** Classify them against current behavior: wire useful regressions into existing owner commands, and retire tests only with the implementation/contract they supersede. The exact original list is in `/tmp/metahuman-pass2-test-registration.json`. The cleanup registered the existing memory-attribution and profile-reset suites in their existing Environment and durable-execution commands; the new cache regression lives in the memory suite. A file count or a passing subset does not establish their correctness; the unregistered suites were not executed during this read-only audit.

## 6. Mobile staging and duplicate APKs

- `apps/react-native/generated/` contains 97 files / approximately **239.28 MiB**, including a 236.90 MiB APK under `www/downloads/`.
- SHA-256 verified that this APK, `android/app/build/outputs/apk/debug/app-debug.apk`, and `out/releases/mobile/metahuman-1.0.0.apk` are identical.
- The current build owner explicitly removes `generated/` before building and after copying the UI, and removes `downloads/` from the runtime UI copy. The leftover staging tree is not the mobile delivery owner. No current process usage was observed.
- **Completed cleanup:** removed all 97 files (250,902,722 bytes) after a fresh process check and APK hash comparison. Preserved the published release manifest/APK used by the mobile download API. The Android build APK/intermediates are rebuildable development output, not evidence that the mobile application is unused.
- The existing successful-build cleanup is present. The audit did not reproduce an interrupted build, so it does not establish which previous command left this tree or authorize inventing another cleanup service.

## 7. Older llama.cpp installations and a root model artifact

| Area | Size / evidence | Disposition |
| --- | --- | --- |
| `external/llama.cpp/dynamic-kv-05c0a5e/` | 428.52 MiB; no observed process/configuration consumer; 8 of 9 regular binaries/libraries match r2 by SHA-256, but `libllama.so.0.1.0` differs | Old-build retirement candidate; not a wholly identical duplicate |
| `external/llama.cpp/adaptive-kv-05c0a5e/` | 428.50 MiB; build provenance present; no observed process/configuration consumer | Retirement candidate after deciding whether the older build is required for benchmark recovery |
| `external/llama.cpp/b11429/` | 1,041.01 MiB; downloaded engine/CUDA runtime; no observed process/configuration consumer | Retirement candidate; preserve any required comparison baseline explicitly |
| `external/llama.cpp/speck-2e88c49/` | 16.34 MiB; an installed user service still references it | Not cleared for removal; resolve the service/model capability together |
| r2 and r3 vision-demand | Both have running consumers; r3 also has about 1,543.87 MiB of build intermediates and its source/patch/build recipe | Keep running artifacts and source. Build intermediates need an explicit regeneration/qualification decision |
| Root `Qwen3.5-0.8B.BF16.gguf` | 1,485.50 MiB; no equal-sized file in the census and no inspected configuration reference | Unresolved provenance; do not describe it as a verified duplicate |

The configuration search covered 424 root/profile JSON and system/user service configuration files, without copying private contents into this report. No negative search result overrides a recovery requirement or an uninspected external consumer.

## 8. Active data, retained evidence and misleading cleanup candidates

- `out/environment-action-selector/` is about 34.30 GiB and has current model consumers. Several large old run groups remain, including a 9.18 GiB specialist run. Per-run artifact/serving/recovery review is still required; the entire training tree is not disposable.
- `out/environment-classifier/` is about 6.08 GiB. The current training corpus reads its frozen evaluation receipt, and training documentation preserves historical scores/artifacts as provenance. Retired classifier registration does not erase that obligation. Weight retirement must distinguish fitted artifacts from locked evidence.
- The 106.68 MiB `out/autonomy-spike-review-*` and 1.57 MiB `out/durable-execution-review-*` folders contain explicitly preserved review/source archives and reproduction receipts. They are not temporary junk merely because their names resemble temporary directories.
- Root approval-queue data still has readers in Core Skills. Root voice cache still has an STT producer. Unique voice/training data, identity/memory history, current mobile releases, explicit repository/deployment backups and live logs remain retained.
- Piper, Kokoro, Whisper, RVC, PM2 startup, the mobile application and personalization training entrypoints have current code/registration owners. No wholesale retirement of these systems is supported by this review.
- The 51-byte `:memory:.ses` root artifact has no established producer. Its name alone is insufficient evidence to remove it or invent a storage fix.
- Fourteen missing relative document links were found, all in dated audit reports referencing removed historical files. Current web links such as `/user-guide?...` are application routes, not missing filesystem files. Historical references are not standing repair instructions.

## Coverage by root area

Counts are the second-pass census. Root filenames are aggregated to avoid exposing private local names. Sizes are logical bytes; they are not reclaimable-space estimates.

| Area | Regular files | Directories | Links | Logical GiB |
| --- | ---: | ---: | ---: | ---: |
| `(root files)` | 23 | 0 | 0 | 1.451 |
| `.agents` | 0 | 1 | 0 | 0.000 |
| `.aws` | 0 | 1 | 0 | 0.000 |
| `.claude` | 2 | 1 | 0 | 0.000 |
| `.codex` | 0 | 1 | 0 | 0.000 |
| `.git` | 17,762 | 900 | 0 | 2.041 |
| `.github` | 1 | 2 | 0 | 0.000 |
| `.obsidian` | 4 | 1 | 0 | 0.000 |
| `apps` | 24,152 | 3,626 | 48 | 2.561 |
| `bin` | 381 | 40 | 5 | 0.049 |
| `brain` | 167 | 36 | 7 | 0.266 |
| `data` | 0 | 1 | 0 | 0.000 |
| `docker` | 7 | 3 | 0 | 0.000 |
| `docs` | 383 | 41 | 0 | 0.006 |
| `etc` | 91 | 7 | 0 | 0.000 |
| `external` | 140,883 | 13,953 | 172 | 34.768 |
| `logs` | 18,729 | 3,995 | 3 | 0.998 |
| `memory` | 4 | 5 | 0 | 0.000 |
| `metahuman-runs` | 100 | 26 | 0 | 0.022 |
| `models` | 10 | 6 | 0 | 7.696 |
| `node_modules` | 103,748 | 19,434 | 4,643 | 2.348 |
| `out` | 9,712 | 1,441 | 0 | 42.166 |
| `packages` | 1,049 | 107 | 38 | 0.020 |
| `persona` | 48 | 8 | 0 | 0.001 |
| `profiles` | 33,165 | 975 | 0 | 5.983 |
| `scripts` | 25 | 2 | 0 | 0.000 |
| `tests` | 10 | 2 | 0 | 0.000 |
| `unsloth_compiled_cache` | 125 | 3 | 0 | 0.004 |
| `vendor` | 4,947 | 762 | 0 | 0.173 |
| `venv` | 50,802 | 5,540 | 4 | 8.253 |

## Local evidence and checks

The `/tmp/metahuman-pass2-*` SQLite/CSV/JSON evidence includes the complete tree, every inspected source path, all test registrations, graph comparisons, duplicate hashes, missing-entrypoint checks, private configuration-reference results and root-area counts. Do not commit this raw inventory: it contains local filenames.

The existing graph validator passed 45/45 while the independent JSON comparison demonstrated its public-artifact coverage gap. All recorded symlink targets resolved. Read-only entrypoint and caller checks found no missing package-command or registered agent/service inputs. No full test/build run, installed-service operation, model inference or physical qualification was performed for this audit.

The authorized source/graph/staging cleanup is complete. Validation: 43/43 launcher tests, affected workspace typechecks, 45/45 graph validation, zero architecture violations, and a successful Site production build. The compiled runtime matches source and validates all 45 workflows; all three compiled-agent checks pass. The affected Environment plus profile-reset run is 164/184 passing; its 20 failing test names exactly match the isolated pre-cleanup run (163/183). Agent Monitor and Agent Catalog failures also reproduce before cleanup. These failures remain recorded rather than hidden by relaxed assertions or baselines. The new real-persistence cache regression fails before removal and passes afterward. Site still reports 313 Svelte warnings.

Retained boundaries: the three old inference distributions still lack an established recovery-retention decision; two contain distinct custom binaries. Speck has an installed service reference; r2/r3 are active. Existing profile tool-cache artifacts may still be written by already-running old releases and have not been proven redundant with canonical history; their source producer is removed for the next launch. No broad profile/history purge, installed service restart, inference, or physical action was performed.
