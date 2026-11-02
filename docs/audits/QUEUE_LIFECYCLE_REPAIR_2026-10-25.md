# Queue lifecycle review and repair

Scope: Coordinator admission, priority, finite execution, cancellation, persistence,
durable continuation and their queue projection. This is not a repository-wide
audit. The owner requested repair and removal of superseded queue systems.

## `packages/core/src/queue/{execution-engine,unified-queue-manager,queue-system}.ts`

- Owner: Core Work Coordinator; one task ledger and executor registry.
- Summary: priority-first selection, independent resource execution and advancement
  after completion already work. Isolated execution reproduced all three.
- Boundary issues: the executor silently skipped unknown handlers, leaving admitted
  jobs queued indefinitely. The detached remote dispatcher returned before work
  finished, losing normal cancellation tracking. Its callback could admit new work
  after cancellation; an isolated reproduction admitted one such follow-up.
- Technical debt: two RemoteDispatcher instances, a second in-flight map, a detached
  completion sentinel, unused `needs_review`, obsolete Sleep/Desire startup sweeps.
- Security/privacy notes: tests use temporary state, synthetic inputs and no network.
  Bridge physical receipts and profile admission remain with their existing owners.
- Recommended action / implementation: removed the detached dispatcher and its
  exports, registrations, callbacks, map and sentinel. Existing workflow/provider
  calls remain. Unknown internal handlers fail through normal completion and durable
  receipt delivery; Bridge-owned command and visual work are not claimed by the
  internal executor. Current Sleep and Desire admission owners remain.
- Acceptance: priority, parallel resources, automatic advancement, missing executor,
  cancellation, durable receipt delivery and restart tests.

## `packages/core/src/durable-execution/{runtime,store,coordinator-outbox,types}.ts`

- Owner: Core checkpoint, execution context and committed dispatch intents. It is
  distinct from the Coordinator's finite jobs, not a second runnable-task queue.
- Boundary issues: an unanswered question retained `waiting` processing status
  indefinitely after delivering its response. Every resume hardcoded high priority,
  while conversation and speech child jobs fell back to normal priority.
- Data access: existing profile storage, encrypted document codec and SQLite owner;
  no new store or profile path. Origin priority is stored as execution metadata,
  outside model-visible instructions.
- Implementation: input-only continuations settle to `idle` once no effects or new
  input remain. Context remains available; actual input transactionally reactivates
  the execution and schedules its existing resume. The schema upgrade classifies
  corresponding old input-only waits without modifying goals, checkpoints or receipts.
  New admissions retain originating priority; child jobs inherit it unless explicitly
  overridden. Subprocess admission carries the same value. Old records without
  recorded priority use the Coordinator's existing task defaults.
- Security/privacy notes: no invented goal completion, reconstructed model decisions,
  input truncation, new timeouts or new model instructions. Existing executable
  compatibility checks still apply when attempting to resume saved graphs.
- Acceptance: retained question context across restart, one wake for repeated input
  delivery, selective recovery, explicit priority preservation and ordinary speech
  priority inheritance.

## `packages/core/src/queue/queue-persister.ts`

- Owner: one Coordinator SQLite ledger with atomic changed-record commits.
- Summary: the running installation already uses SQLite; no legacy JSON ledger was
  present during inspection. The old importer and its snapshot cleanup were still
  active in ordinary reads.
- Implementation: removed obsolete JSON import/cleanup and its migration-only tests.
  SQLite persistence, rollback, receipts, incremental writes and consistent snapshot
  reads remain. No historical production records were deleted.
- Acceptance: SQLite restoration, empty-installation reads, speech-artifact selection,
  incremental updates, rejected-write rollback and concurrent-reader consistency.

## Queue API and presentation

- Owner: Core queue snapshot handler; Site Queue Panel is a reader.
- Finding: the interface listed every nonterminal execution as unfinished work,
  including question-only continuations. This made retained conversation context
  look like stalled queue processing.
- Implementation: the execution owner now distinguishes idle context from pending
  processing. Existing pending summaries consequently omit idle continuations; their
  records remain available to context/history. Removed the unused remote-flight
  projection with its deleted lifecycle. No downstream duplicate suppression or
  age-based hiding was added.

## Qualification

- Five initial focused repair tests passed, covering actual engine transitions,
  restart, input delivery and inherited priority.
- The first broader run passed 109 of 134 tests. Twenty-four Goal Continuation tests
  failed in both the changed tree and an isolated pre-repair source copy: the fixture
  does not supply the current required Intent fields, with additional stale review
  expectations. They are not passing end-to-end evidence for this repair.
- The remaining failure intentionally unregistered `graph.resume` to leave work
  queued. Updated worker-boundary fixtures use an explicit finite test receiver;
  the recovery/cancellation rerun passed 29 of 29 tests.
- Final focused repair/persistence/admission run: 24/24 passed. Recovery and
  interpretation cancellation: 29/29 passed. Core, Brain and Site typechecks passed;
  Site reported no errors or warnings. Production build passed; compiled runtime
  matched the current source and validated all 45 workflows.
- Broader qualification remains limited: 24 Goal Continuation cases and two older
  owner/configuration tests reproduce failures in the isolated pre-repair tree.
  Architecture checking reports five existing violations in unrelated agent layout
  and Brain test imports. No assertion or architecture baseline was weakened.
- Activated through the existing application-only launcher restart. The authenticated
  live queue endpoint reports running, not paused, not degraded, zero jobs and zero
  unfinished processing workflows. Model service processes were retained.
- The three previously reported conversation records had already been cancelled
  before this activation by another actor. Their disappearance is not evidence of
  this repair; idle classification, restart and resumption are independently covered
  by the new tests. No live movement, camera or speech command was sent for qualification.
- Changes are local; no commit or publication was performed.
