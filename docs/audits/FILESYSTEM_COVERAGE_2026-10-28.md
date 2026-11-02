# Filesystem coverage and old-file investigation — 2026-10-28

This extends the earlier root-entry cleanup. It is a complete metadata census of the repository filesystem exposed to this session, plus ownership/reference investigations of the groups below. It is not a claim that every dependency file has received a line-by-line source review or that every unreferenced path is disposable. The original investigation was read-only. The subsequently authorized cleanup is recorded below; census counts remain the pre-cleanup snapshot.

## Coverage and measurement limits

- Enumerated **493,604 regular files, 63,034 directories and 4,937 symlinks**: 561,575 entries, with zero traversal errors, in approximately five minutes.
- Included hidden and ignored entries, Git internals, external checkouts, Python environments, node_modules, build/cache folders, models, logs, profiles and output/history folders. Excluded application names were not used to prune the filesystem walk.
- Symlinks were recorded, not followed into other repositories, mounted profile stores or global model/dependency stores. Protected session surfaces can be virtualized; this is not an inventory of inaccessible host contents behind those surfaces.
- Approximately **132.805 GiB allocated**, counting each device/inode once. Tables below use logical file sizes, which differ from allocated disk space and are not promises of reclaimable space.
- **279,365 files** have modification times older than 90 days; **276,282** older than 180 days; **5,816** older than a year, relative to 2026-10-28 UTC. Imported dependencies retain upstream dates. Modification time is neither creation time nor last-use evidence.
- **1,292 empty directories** and **seven dangling symlinks** were enumerated. Empty package/build directories are not automatically cleanup candidates.
- The workspace remained live. Site releases changed during the walk, and an older release was running while a newer release was selected. These are timestamped observations, not an atomic filesystem snapshot; recheck candidate identities and live use immediately before deletion.
- Readable host process command paths, mapped files, working directories and open files were inspected. Nineteen processes referenced repository paths; 314 process records were not fully readable. Absence from this check is qualified evidence, not proof of no possible consumer. No service was started, stopped or queried through model inference.

## Every root area

Counts below cover all observed root areas. The root-files row combines individual root files; private file names and profile paths are omitted from this repository report.

| Area | Files | Directories | Symlinks | Logical GiB | Files older than 180 days |
| --- | ---: | ---: | ---: | ---: | ---: |
| `(root files)` | 23 | 0 | 0 | 1.451 | 5 |
| `.agents` | 0 | 1 | 0 | 0.000 | 0 |
| `.aws` | 0 | 1 | 0 | 0.000 | 0 |
| `.claude` | 2 | 1 | 0 | 0.000 | 2 |
| `.codex` | 0 | 1 | 0 | 0.000 | 0 |
| `.git` | 17,762 | 900 | 0 | 2.041 | 7,969 |
| `.github` | 1 | 2 | 0 | 0.000 | 0 |
| `.obsidian` | 4 | 1 | 0 | 0.000 | 0 |
| `apps` | 49,455 | 8,298 | 52 | 4.570 | 12,476 |
| `bin` | 381 | 40 | 5 | 0.049 | 363 |
| `brain` | 167 | 36 | 7 | 0.266 | 0 |
| `data` | 1 | 2 | 0 | 0.368 | 1 |
| `docker` | 7 | 3 | 0 | 0.000 | 1 |
| `docs` | 382 | 41 | 0 | 0.006 | 255 |
| `etc` | 91 | 7 | 0 | 0.000 | 12 |
| `external` | 200,849 | 21,116 | 176 | 43.988 | 142,734 |
| `logs` | 18,729 | 3,995 | 3 | 0.995 | 507 |
| `memory` | 4 | 5 | 0 | 0.000 | 4 |
| `metahuman-runs` | 100 | 26 | 0 | 0.022 | 73 |
| `models` | 10 | 6 | 0 | 7.696 | 7 |
| `node_modules` | 103,748 | 19,434 | 4,647 | 2.348 | 38,630 |
| `out` | 11,785 | 1,708 | 0 | 49.640 | 1,078 |
| `packages` | 1,060 | 119 | 43 | 0.465 | 176 |
| `persona` | 48 | 8 | 0 | 0.001 | 47 |
| `profiles` | 33,086 | 974 | 0 | 5.926 | 27,105 |
| `scripts` | 25 | 2 | 0 | 0.000 | 5 |
| `tests` | 10 | 2 | 0 | 0.000 | 0 |
| `unsloth_compiled_cache` | 125 | 3 | 0 | 0.004 | 0 |
| `vendor` | 4,947 | 762 | 0 | 0.173 | 4,941 |
| `venv` | 50,802 | 5,540 | 4 | 8.253 | 39,891 |

## Ownership categories

These categories account for every regular file. They are inventory classifications, not deletion decisions. Maintained-tracked uses the existing Maintained Surface policy. Source that is still untracked is included in local categories and was included where applicable in the reference scan.

| Category | Files | Logical GiB |
| --- | ---: | ---: |
| documentation-evidence | 298 | 0.003 |
| external-model-toolchain | 26,701 | 29.726 |
| generated-runtime-build | 50,251 | 52.902 |
| git-metadata | 17,762 | 2.041 |
| installed-dependency | 362,886 | 34.385 |
| maintained-tracked | 1,872 | 0.280 |
| other-untracked-local | 697 | 2.999 |
| user-data-history | 33,137 | 5.927 |

## Cleanup dispositions after authorization

| Group | Files / logical size | Current evidence and disposition |
| --- | --- | --- |
| `external/gpt-sovits/` | 59,964 / 9.219 GiB | Removed the complete retired install: tracked checkout had no changes; the only nontracked material outside the environment/cache was the upstream pretrained weights. No personal voice/training material or observed process consumer was found. |
| `external/kitten/` | 2 bytecode files | Removed both remaining bytecode files and the empty retired installation. |
| `apps/react-native/node_modules/.ignored/` | 8,929 / 1.307 GiB | Removed 8,929 displaced dependency files. No incoming repository links targeted them; React, React Native, Metro and TypeScript resolve to the current pnpm store. Mobile typecheck passes. |
| Qwen embedding copies | 4 files, each 394,704,832 bytes | Retained repository-root `models/`; removed the other three byte-identical copies after fixing standalone startup to resolve the same root as managed startup. Explicit model-directory configuration remains supported. |
| Nomic embedding copies | 3 files, each 84,106,624 bytes | Retained repository-root `models/`; removed the other two byte-identical copies. Retained Qwen/Nomic hashes were verified after deletion. The inventory endpoint now uses the same selected directory as model loading. |
| `packages/server/` | 4 files plus stale links/empty source directories | Removed the obsolete package directory, four installed leftovers and stale links. The architecture assertion that the old queue entry must remain absent is retained. |
| `apps/site/build/releases/` | 17,438 / 0.273 GiB at census | Removed 33 completed, unowned releases. Kept both process-owned releases, including the selected one; the validation build creates a new release without restarting either running server. Existing build/lifecycle ownership is unchanged. |
| `apps/site/.astro/visual-observation-build.*` | 457 / 7.11 MiB | Removed the 457-file abandoned temporary build after checking references and process ownership. |
| Four dated Site output directories plus `out/deployment-backups/` | 2,555 / about 40 MiB | Removed the four obsolete Site output trees (2,047 files). Kept the explicit deployment backup: it is recovery material, with no proven equivalent snapshot. |
| `out/cloud-serverless-20261016/` | 80 / 7.441 GiB | Removed 26 duplicate model/library artifacts (7.441 GiB logical). Every hash matched both the original manifest and retained root models/r2 binaries. Preserved all 54 evidence/source/archive files unchanged. The recorded pilot cleanup reports the endpoint deleted; no remote operation was performed. Reusing this build context requires restaging artifacts from the retained originals. |
| `out/environment-action-selector/` | 6,711 / 34.298 GiB | Current process maps use artifacts in this tree. Contains many experiment/checkpoint groups, including one approximately 9.18 GiB group. Needs per-run serving, recovery and evaluation-retention checks; the directory as a whole is active. |
| `out/environment-classifier/` | 714 / 6.084 GiB | Model registry rejects retired classifier IDs, but `brain/training/environment-action-selector/corpus.ts` still reads the locked evaluation receipt from this tree. Preserve that evidence. Weight/checkpoint retirement requires narrower review. |
| `out/repo-backups/` | 3 / 0.146 GiB | Git bundle, working-tree patch and untracked-source archive. They can contain unrepeated work; compare recoverability before removal. |
| `out/releases/mobile/` | 2 / 0.231 GiB | Current mobile download/update owner reads the release manifest and APK. Keep. |
| Root `out/voices`, `out/voice-training`, `out/voice-cache` | 1,020 / about 0.540 GiB | Older voice material. The current voice-training owner and profile path rules must distinguish source recordings, trained voices and disposable synthesis copies. Unique voice/training data is not classified as junk. |
| `logs/benchmarks`, `logs/diagnostics`, `logs/run` | 18,578 / about 0.883 GiB | Significant evidence/log populations. Live processes still write run logs. Review benchmark/diagnostic evidence separately from active logs and pending-delivery records; no age purge performed. |
| `apps/react-native/android/` and generated bundles | More than 2 GiB of build outputs | Gradle/native outputs and bundled mobile runtime are generated, but remain owned by the maintained mobile build. Regeneration/installed-release obligations need checking before removal. |
| `external/llama.cpp/` | 57,195 / 4.543 GiB | Multiple builds. Both r2 and r3 vision-demand binaries were running, and a service unit references r2. The other builds require configuration and rollback review; none were declared unused by date. |
| `external/applio-rvc`, `external/kokoro`, root `venv/` | 47,632; 36,052; 50,802 files | Live process mappings show current use. Retain these installations; separately review generated caches or training artifacts at their owners. |
| `packages/agent-runtime/dist`, `packages/local-model-service/dist` | Package build outputs | Their package manifests export `dist`; the local-model-service process executes its built entry. These are active artifacts, not obsolete just because source lives elsewhere. |
| `profiles`, root `persona`, root `memory`, `metahuman-runs` | User/history and training records | Global account storage, unique historical identity/memory and profile-scoped runtime/training data. Retain pending lifecycle/retention review. The preceding root cleanup already verified unique history rather than deleting it. |
| `.git`, installed `node_modules`, `vendor`, maintained docs/assets | Ownership retained | Git history and dependency/package registration are their owners. Vendor Whisper includes a test fixture consumed by current regression coverage. Dated docs are evidence, not executable registrations. No blanket deletion from old timestamps. |

## All 337 older maintained files

An import/re-export and literal-path reference scan examined 2,090 current text files with zero text-read failures. The complete 337-row checklist is local, including paths, modification times, size, triage status, resolved module references and literal path mentions. This is static triage: imports through a barrel do not prove execution, filesystem routes can be registered without recent traffic, and dynamically constructed reads require owner tracing.

| Static triage | Files |
| --- | ---: |
| tooling/package metadata | 9 |
| native build/packaging entry; retain | 29 |
| explicit import or re-export | 121 |
| no explicit import found; unresolved, not proven unused | 6 |
| static asset; URL consumer review | 1 |
| Astro filesystem route | 154 |
| command or automation entry; invocation review | 6 |
| container build/entry; invocation review | 1 |
| documentation; historical/current authority review | 4 |
| configuration/template; dynamic reader review | 6 |

### Six source/configuration candidates resolved and removed

| Path | Finding / surviving owner to verify |
| --- | --- |
| `apps/site/etc/runtime.json` | Removed the unused Site-local copy. `path-builder.ts` resolves repository/profile roots independently of cwd; `config.ts` reads their `etc` directories. |
| `apps/site/src/lib/client/utils/fetch-timeout.ts` | Removed the unimported wrapper. The profile-sync helper remains a separate active local implementation. |
| `apps/site/src/middleware/cognitiveModeGuard.ts` | Removed the unimported Astro wrappers. Current Core router authorization and policy checks remain in place. |
| `apps/site/src/utils/node-pipeline.ts` | Removed the unused duplicate; the API continues importing Core `node-pipeline-runtime.ts`. |
| `packages/core/src/memory-cleanup.ts` | Removed the uncalled scan/purge/repair helper. `memory.ts` still imports and uses `memory-validation.ts`. |
| `packages/core/src/operator/index.ts` | Removed the orphan barrel. The active observation node still imports `operator/observation-formatter.ts` directly. |

Also removed `context-window.ts`, `training-cleanup.ts` and their root Core re-exports after checking workspace and adjacent robot/refiner consumers. No operational callers were found. Removed the unregistered `packages/local-model-service/test-embed-direct.mjs` diagnostic, which had no callers or maintained test command; real launcher coverage remains registered. Together these are nine removed source/configuration/diagnostic files.

## Obsolete links removed

| Link | Target |
| --- | --- |
| `apps/site/node_modules/.bin/node` | `../@astrojs/node/bin/node` |
| `node_modules/code-oss-dev` | `../apps/code-oss` |
| `node_modules/@metahuman/electron` | `../../apps/electron` |
| `node_modules/@metahuman/robot-friend` | `../../apps/robot-friend` |
| `node_modules/@metahuman/server` | `../../packages/server` |
| `packages/server/node_modules/.bin/node` | `../@types/node/bin/node` |
| `packages/server/node_modules/@types/node` | `../../../../node_modules/.pnpm/@types+node@20.19.25/node_modules/@types/node` |
| `packages/local-model-service/node_modules/.bin/node` | `../@types/node/bin/node` |

Removed the seven originally dangling links plus the obsolete `@metahuman/server` workspace alias exposed by removing its empty package directory. Current manifests/lock metadata did not register these paths. The final directory-entry sweep checked 50,921 directories and 4,921 links; its sole remaining dangling alias was `@metahuman/server`, which was then removed. Package commands continue using the installed Node runtime and current pnpm dependencies; no replacement aliases were introduced.

## Local evidence and next boundary

The full compressed file catalog, folder coverage CSV, 337-row maintained-file checklist, empty-directory list, dangling-link list and private process-path evidence remain under `/tmp/metahuman-*`. They contain local filenames and must not be committed or published. This report intentionally omits private profile identifiers, content, credentials and captured command payloads.

The census covered the entire exposed repository tree. Detailed semantic usage/retention qualification covers the stated findings, not every file body. The authorized cleanup removed 88,372 regular files, plus links/directories, accounting for approximately 19.019 GiB of allocated file data whose final hard links were removed (filesystem snapshots, compression and concurrent writes can affect observed free space). Private removal receipts and retained-artifact hashes are under `/tmp/metahuman-expanded-*`. Active training/model trees, voice/history data, mobile releases, explicit recovery backups and live logs remain; they are not proven orphaned. No new cleanup service, retention policy, dependency, service restart, inference or physical action was introduced.
