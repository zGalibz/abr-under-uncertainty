# Contributing

Read `docs/PROJECT_DESIGN.md`, `docs/TEAM_ROLES.md`, and `docs/GITHUB_WORKFLOW.md` before contributing.

## Required workflow

1. Open or select one issue with a clear owner and acceptance checklist.
2. Create a short-lived branch from updated `main`.
3. Make one coherent change.
4. Run the relevant validation/tests and record observed output.
5. Open a pull request using the repository template.
6. Obtain the required non-author and affected-owner reviews.
7. Squash merge after required checks pass.

## Shared-contract rule

Changes under `contracts/`, experiment metric definitions, scenario timing, media ladder, policy constants, and raw-data semantics affect multiple modules. They require a version decision, updated fixtures/tests, and reviews from all affected owners. Breaking contract changes require all three members.

## Evidence integrity

- Do not fabricate logs, metrics, charts, or command output.
- Do not remove an unfavorable valid run.
- Do not manually type measured values into final charts.
- Keep hypotheses separate from measured results.
- Treat raw counted-run artifacts as append-only after data freeze.

## Commit style

Use Conventional Commits, for example:

```text
feat(media): add aligned HLS package validator
feat(player): log effective quality changes
fix(network): enforce aggregate run bandwidth
feat(analysis): compute paired rebuffer deltas
docs(protocol): clarify invalid-run rules
```
