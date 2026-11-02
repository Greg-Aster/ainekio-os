# Maintained Source Audit Protocol

This protocol applies when the user requests a maintained-source architecture
audit. Review the requested files or owner groups line by line; it does not turn
a routine question, small edit, or behavior repair into a repository-wide audit.
Root `AGENTS.md` defines the bounded workflow for those tasks. Audit findings do
not authorize implementation.

## Audit Inputs

- `docs/technical/MAINTAINED_SURFACE.md`
- `docs/technical/REFACTOR_BLUEPRINT.md`
- `docs/technical/ARCHITECTURE.md`
- `scripts/check-architecture.ts`
- `docs/technical/architecture-guardrail-baseline.json`

## Per-File Checklist

For each maintained file in the requested scope, record the applicable findings
below. Small owner groups may share one record; do not duplicate unchanged
inventory details or create boilerplate records for unrelated files.

- Purpose: the responsibility it owns and the real callers/entrypoints that use it.
- Layer: core engine, interface, CLI, agent, service, training, script, test, or doc.
- Imports: whether dependency direction follows the blueprint.
- Exports: whether public exports are intentional and stable.
- Data lifecycle: producer, persisted facts, actual consumers, and the transition
  that releases temporary state; distinguish required evidence from duplicate copies.
- Data access: path/profile/storage APIs used, hardcoded runtime paths, and whether
  active work reads unrelated history or decodes unused payloads.
- Side effects: filesystem, child process, network, model, or shell behavior.
- Security/privacy: auth checks, secret handling, path traversal risk, user data exposure.
- Complexity: duplicate responsibilities, unnecessary mechanisms and coupling;
  file length alone does not justify splitting an owner into more abstractions.
- Tests: whether they reproduce the user-visible defect across the actual owner
  boundary, whether assertions preserve a known bug, and whether maintained scripts
  run them. Include lifecycle/repeated-operation evidence when relevant.
- Disposition: keep, move, split, merge, delete, or defer.

## Audit Output

Write remote-safe findings under `docs/audits/`.

Do not paste personal data, secrets, full logs, runtime memory content, or local profile values into audit output.

Use one record per file or small owner group. Each record should include:

```md
## path/to/file.ts
- Owner:
- Summary:
- Boundary issues:
- Technical debt:
- Security/privacy notes:
- Test gap:
- Recommended action:
```

For a proposed repair, identify the earliest faulty transition and the simpler
surviving design. Distinguish correction from a compensating mechanism: a cleanup
query, retry, filter or new flag can leave the original producer defective. Record
the expected removal set and the behavior that would detect recurrence. Do not
infer that passing compilation or an existing test suite establishes that behavior.

## Execution Rules

- Write the requested findings, but do not edit production source unless the user
  explicitly starts an implementation phase.
- Reuse relevant evidence after checking its scope and source/environment state.
  Expand discovery only to resolve a concrete boundary or missing proof; record
  the reason. Finish when the requested coverage and findings are complete.
- Do not use stale blanket instructions that require adding logging or return types to every file.
- Do not commit per-file churn from audit agents.
- If a file is likely orphaned, confirm with static references and runtime route/entrypoint discovery before deleting it.
