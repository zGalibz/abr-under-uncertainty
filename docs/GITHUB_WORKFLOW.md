# GitHub Collaboration Workflow

## 1. Initial setup for every member

1. Create/fork or clone the repository.
2. Configure Git identity using the member’s own name and verified/noreply GitHub email.
3. Add the main repository as `origin` if the member is a collaborator; when using a fork, use the fork as `origin` and the group repository as `upstream`.
4. Never share passwords, personal-access tokens, SSH private keys, or verification codes.
5. Read the project design and team roles before opening implementation work.

## 2. Branch model

`main` is always the accepted integration state.

There is no permanent `develop` branch. Every task uses a short-lived branch created from updated `main`.

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/m1-media-pipeline
```

Naming:

- `feat/m1-*`, `feat/m2-*`, `feat/m3-*` — new work owned by a member;
- `fix/m1-*`, `fix/m2-*`, `fix/m3-*` — bug fixes;
- `test/*` — cross-cutting test/fixture work;
- `docs/*` — documentation/presentation work;
- `chore/*` — tooling/configuration.

One branch and PR should solve one reviewable concern.

## 3. Commits

Use Conventional Commits:

```text
feat(media): add aligned HLS packaging script
feat(player): emit normalized fragment telemetry
fix(network): share one token bucket across requests
test(analysis): cover startup-only waiting
docs(protocol): define counted-run inclusion rules
```

Commit only files relevant to the task. Do not commit:

- secrets or credentials;
- `node_modules` or Python virtual environments;
- browser profiles/caches;
- unlicensed source video;
- generated large media without an agreed LFS/release plan;
- counted results before the apparatus/protocol gates pass.

## 4. Pull request procedure

Before opening a PR:

1. update branch from `main`;
2. run all relevant formatting, contract, unit, integration, and validator commands;
3. inspect the diff for unrelated files and secrets;
4. update documentation/contracts when behavior changed;
5. include fixtures/sample evidence for a new interface.

Every PR body must state:

- purpose and linked issue;
- owner area and files touched;
- contract impact: none / compatible / breaking;
- exact test commands and observed results;
- evidence or sample artifact;
- handoff inputs/outputs/version;
- limitations or follow-up work.

Use `.github/PULL_REQUEST_TEMPLATE.md`.

## 5. Reviews

- At least one non-author approval is required.
- Contract, data-freeze, and final-presentation PRs require all three approvals.
- Cross-boundary changes require each affected owner:
  - media/server ↔ player: Asadullah + Susmoy;
  - telemetry ↔ reducer: Susmoy + Miraj;
  - scenario anchors ↔ analysis: Asadullah + Miraj;
  - shared contracts: all three for breaking changes.
- Review behavior and integration assumptions, not only formatting.
- Resolve every review thread or create an explicitly accepted follow-up issue.

## 6. Merge rules

- Green required checks and required reviews first.
- Squash merge to keep one coherent change per PR.
- Delete the branch after merge.
- Never force-push `main`.
- Never rewrite a merged/data-freeze commit or release tag.

After merge:

```bash
git switch main
git pull --ff-only origin main
git branch -d <merged-branch>
```

## 7. Contract changes

Shared contracts live in `contracts/` and are authoritative over generated types.

A contract change must update together:

- OpenAPI/JSON Schema;
- examples/fixtures;
- producer implementation/tests;
- consumer implementation/tests;
- `docs/PROJECT_DESIGN.md` or an ADR;
- version/migration note.

Do not merge a producer-only schema change that breaks a downstream member’s branch.

## 8. Milestone tags

Tags mark accepted integration states, not merely dates:

```text
v0.1-contracts
v0.2-media-network
v0.3-player
v0.4-end-to-end
v0.5-data-freeze
v1.0-presentation
```

All three members approve milestone tags. `v0.5-data-freeze` is immutable; later apparatus changes create a new dataset/version.

## 9. Recommended repository settings

- Public repository initially, unless the team requests private visibility.
- Issues and pull requests enabled.
- Delete head branches automatically after merge.
- Squash merge enabled; merge commits/rebase merge optional or disabled for consistency.
- `main` protected/ruleset:
  - pull request required;
  - at least one approval;
  - conversation resolution required;
  - force pushes and deletion blocked;
  - required checks added when CI exists.

Confirmed GitHub mapping: Asadullah Galib = `@zGalibz`, Susmoy L = `@susssm`, and Miraj = `@ahsanullahmiraj`. Invitations were sent with write access on 2026-11-09; each teammate must accept before direct branch pushes and automatic CODEOWNERS review requests work fully.

## 10. Conflict prevention

- Each owner works mainly in their paths.
- Shared files change through small, early PRs.
- Freeze contracts before parallel implementation.
- Use synthetic fixtures so consumers do not wait for providers.
- Rebase/update before final review; do not accumulate weeks-long branches.
- Announce planned shared-file changes in the linked issue.

## 11. Data handling

- Dry-run data stays under `results/dry-run/`.
- Counted raw evidence is append-only under `results/raw/<run_id>/`.
- Invalid attempts remain retained with a reason and replacement run link.
- Summaries/figures are generated from raw evidence, never manually edited measurements.
- Data-freeze PR includes run count, hashes, validation report, regeneration command, and all-three approval.
