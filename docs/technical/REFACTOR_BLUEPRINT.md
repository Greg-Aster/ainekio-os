# Architecture and Repair Design

This is the design authority for repairs and consolidation in MetaHuman OS.
[AGENTS.md](../../AGENTS.md) owns scope and approval; [Maintained Surface](MAINTAINED_SURFACE.md)
owns executable-source policy and live runtime boundaries. Use [Audit Protocol](AUDIT_PROTOCOL.md)
for an explicitly requested audit. Dated baseline plans and the consolidation ledger
are historical evidence, not an instruction to begin another repository-wide rewrite.

## Repair Design

A repair changes the implementation that violates the intended contract. It may
require coordinated edits across an owner and its callers; minimizing the number
of touched files is not the same as minimizing system complexity. Preserving a
faulty producer and adding a consumer-side workaround is usually a smaller patch
but leaves more responsibilities and failure modes behind.

For robot work, begin with the affected capability in the shared
[design core](../robot/ROBOT_BIBLE.md). Trace the concrete path from admission
to result, including persisted state and both sides of any Ainekio/MetaHuman
handoff. Select the relevant [qualification scenario](../robot/QUALIFICATION.md);
a local repair must preserve the interacting companion capabilities. The
[maintenance walkthroughs](../robot/QUALIFICATION.md#maintenance-walkthroughs)
show concrete owner paths and focused commands for common cross-repository changes.
Use the existing code and failing behavior to answer these questions in the task's
short plan; do not create a separate registry or document for each repair:

| Design question | Evidence needed |
| --- | --- |
| What should the user or caller observe? | Requested behavior and existing public/capability contract |
| Where does actual behavior first diverge? | Failing test, correlated trace, or producer/transition source evidence |
| Who owns that responsibility, and who consumes its result? | Existing entrypoint, callers, registration and maintained owner on each affected side of the handoff |
| What changes, and what becomes unnecessary? | Before/after transition and removal of obsolete paths and consumers |
| Why is each retained piece of state needed? | Identified reader/delivery obligation and release transition |
| How can the original defect be detected again? | Regression exercised through the real failing boundary |

Prefer correction within the owner, then consolidation of competing implementations.
New infrastructure is a design change requiring the Owner's explicit authorization,
not an automatic consequence of a bug. A helper that completes the owner's existing
responsibility is ordinary implementation. An independent sweep, retry service,
registry, or second execution route is another mechanism regardless of its filename.
Do not use line-count quotas, arbitrary function-size splits, or generic abstractions
as substitutes for understanding responsibility.

## State and Lifecycle

Treat creation, transition, consumption and release as one owner's responsibility.
Persist only the facts that an identified consumer needs; distinguish these cases:

| Kind of state | Lifetime and access |
| --- | --- |
| Active operation | Until its real work and result handoff are resolved |
| Undelivered result | Until its consumer durably records it; replay preserves identity |
| Domain memory or evidence | Its domain's deliberate retention policy, queried when needed |
| Derived view/index/cache | Rebuildable projection of its canonical source, not another decision owner |

One result may cross several owners, but each handoff needs an explicit transfer
of responsibility. Commit the receiving fact before releasing the sender's temporary
copy. If interrupted between those steps, recover that same delivery by identity;
do not rerun the action or manufacture a successful result. Do not retain full
payloads merely to keep an identifier. Durable goals, conversation context and finite
worker jobs have different lifetimes; one being unfinished does not make all of them
active work or block independent speech, sensing, movement or new admission.

For storage/performance failures, inspect both the write path and the read path.
An index can repair a necessary query; it cannot justify retaining unnecessary
records. A faster sweep cannot repair a missing release transition. Migration of
old debris is finite deployment work, separate from steady-state behavior. Preserve
intentional domain evidence rather than relabeling it as unwanted queue history.

## Target Architecture

MetaHuman is a pnpm monorepo with interface packages on top of a behind-the-scenes
engine.

```text
apps/* and packages/cli
  -> API adapters, UI, shell commands
  -> call public engine and agent-runtime interfaces

brain/*
  -> finite agents, persistent service entrypoints, training jobs
  -> call public engine interfaces

packages/agent-runtime
  -> shared finite-agent execution interfaces only
  -> does not load, register, execute, or supervise agents

packages/core
  -> engine/domain logic, storage abstraction, auth, policy, memory,
     model routing, graph execution, process supervision, shared API handlers
```

## Dependency Rules

- `packages/core` must not import from `apps`, `brain`, Astro, Svelte, or UI code.
- `apps/site` client code must not import runtime-heavy core modules. Browser-safe
  types and schemas are allowed through explicit exports only.
- `apps/site/src/pages/api` is transport-only. Business logic belongs in
  `packages/core/src/api/handlers` or an explicitly documented service owner.
- `brain/*` calls public `@metahuman/core` exports, not deep
  `packages/core/src/...` paths.
- CLI commands parse and delegate. Durable behavior belongs in core or an
  explicitly documented agent/service owner.
- Runtime data is resolved through profile, path, and storage owners. Do not
  hardcode profile, persona, memory, or user paths.

## Contracts and Consolidation

A maintained component contract states the observable purpose, owning entrypoint,
input/output meaning (including units and identity), failure/cancellation behavior,
state creation/consumption/release, and the relevant checks. Record why a significant
boundary exists and what was replaced. Put missing details in that owner's existing
reference, not in another master inventory. Link executable schemas and settings
instead of transcribing their values. Label intended behavior, inspected source and
deployed/physical evidence separately.

During review, follow one affected input through every producer/consumer handoff
and its interacting capability. Confirm that each necessary responsibility still
exists exactly once and every retired route is gone from callers and registrations.
Changing a file count or passing import checks alone does not answer that question.

- Keep policy, state transitions and side effects behind the canonical owner.
  Adapters translate transport; graph nodes compose functions; UI projects state.
  A second layer must not independently reinterpret the same lifecycle.
- Use typed inputs/results that distinguish requested, admitted, running, observed,
  failed and unknown outcomes. Preserve source, time, speaker and correlation across
  handoffs. A transport acknowledgement does not prove physical completion.
- Existing tests and comments can preserve mistakes. Compare them with the user
  contract and evidence before preserving an assertion or copying a pattern.
- Delete the replaced path, callers, exports, registrations, settings, tests and
  docs together after confirming real references/entrypoints. Preserve useful test
  coverage by moving its behavioral assertions to the surviving owner.
- Prefer the current library/owner contract over a local framework. Add configuration
  only for an actual user decision; do not create flags for abandoned designs.
- Record the reason for a significant cross-owner choice alongside its existing
  maintained contract: which owner survives, why, and which path was retired.
  Do not create a parallel architecture catalog, approval service or recurring audit
  process. An accepted temporary coexistence needs its explicit removal condition.

## Executable Evidence

Behavior tests belong beside the owner; their maintained commands belong in existing
package scripts. Structural dependency rules belong in the existing architecture
checker. Neither is a runtime limiter or an instruction to add another framework.

For each changed contract, choose the smallest evidence that distinguishes correct
behavior from the actual defect. Exercise the real producer/consumer boundary;
mock external models or actuators when necessary, not the transition under test.
Verify that the regression fails before the repair when practical. If only a
counterfactual or source trace is possible, state that limitation.

Persistence tests inspect actual stored rows after normal consumption, then reopen
the store. Lifecycle tests repeat operations and cover interruption on either side
of the handoff, delayed results, cancellation and replay where relevant. Assert
both that required evidence survives and that unnecessary copies do not accumulate.
A fixture that calls a cleanup method explicitly does not prove ordinary operation
releases state. Performance evidence uses representative records/payloads and the
actual query/handoff; cheap synthetic happy paths alone do not qualify a latency fix.

Use existing structural checks for deterministic boundaries. Design review examines
whether a responsibility belongs here at all, whether a dependency is justified,
and whether the old cause has been removed. Do not replace that judgment with
keyword bans, a blanket ban on new lines, or tests that merely search for a newly
chosen function name. Do not weaken a failing expectation simply to make a repair
pass; changing an obsolete assertion requires the explicit intended contract and
replacement behavioral proof.

## Why This Approach

Research does not establish that longer agent instructions produce better repairs.
[Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) found no general success
improvement and higher inference cost in its evaluated settings; [another study](https://arxiv.org/abs/2601.20404)
found efficiency improvements on a different sample. These results support testing
repository-specific outcomes, not treating more prose as a proven remedy.

[OpenAI's engineering account](https://openai.com/index/harness-engineering/) describes
using a short instruction map, maintained design knowledge, and executable
architecture checks. [Google's review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
prioritizes overall design, present needs, complexity and useful tests.
[Its testing guidance](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html)
explains why behavior-based assertions survive implementation changes better.

Applied here: keep repository instructions focused, maintain one contract per owner,
use the existing test/check commands to detect demonstrated regressions, and review
whether each change removes the cause. These are development practices; they do
not authorize runtime restrictions, additional background services or autonomous
cleanup work.
