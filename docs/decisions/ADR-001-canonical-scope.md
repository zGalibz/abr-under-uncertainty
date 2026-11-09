# ADR-001: Canonical Initial Scope

- Status: Accepted for repository foundation
- Date: 2026-11-09
- Decision owners: Asadullah Galib, Susmoy L, Miraj (team approval still required at `v0.1-contracts`)

## Context

Independent research produced compatible overall designs but different suggested media ladders, segment lengths, and repetition counts. Parallel implementation requires one canonical starting point.

## Decisions

1. Use **four** renditions: 360p, 480p, 720p, and 1080p. This gives the adaptation policies more observable choices while remaining feasible for a three-person group.
2. Use aligned **two-second** MPEG-TS HLS segments. Two seconds improves observability of adaptation during a short controlled experiment. Segment duration is not an experimental variable in the core.
3. Use an **approximately 120-second** source clip, subject to license and source validation.
4. Pin **hls.js 1.7.4** exactly and use Chrome/hls.js for all measured runs.
5. Compare `default-hlsjs` with `conservative-throughput-v1` in one player build.
6. Use three core traces: stable, gradual congestion, and volatile bandwidth. Final rates are compiled only after measured rendition rates are frozen.
7. Run **three repetitions** per policy × trace cell: 18 counted core runs. Report all points, median/range, and paired deltas without significance claims.
8. Keep outage as a declared optional extension only after the 18-run core is complete.
9. Use local application-layer aggregate media-body shaping; do not claim packet-level or real-Internet equivalence.
10. Treat `docs/PROJECT_DESIGN.md` and `docs/TEAM_ROLES.md` as canonical prose. Documents under `docs/research/` preserve research detail and may contain alternative recommendations.

## Consequences

- Media packaging and validation must support four aligned variants.
- Scenario files included during foundation are drafts/examples until the measured ladder is available.
- Existing draft schemas/OpenAPI must be reviewed and may need compatible updates before `v0.1-contracts` is tagged.
- Counted experiments cannot begin until media, traces, policies, metrics, and versions are frozen.

## Reconsideration trigger

Change this ADR only through an all-member pull request that documents implementation impact, contract migration, experiment validity impact, and whether previous runs must be discarded/versioned.
