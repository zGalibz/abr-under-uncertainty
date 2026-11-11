# ABR Under Uncertainty

A controlled adaptive-video-streaming experiment for the Computer Networks Principles course.

Teacher topic: **Adaptive Video Streaming: Comparing Video Quality and Playback Stalls under Changing Bandwidth**

## Research question

Under identical changing-bandwidth traces, how does stock hls.js adaptive bitrate selection compare with a simple conservative throughput-aware policy in:

- playback stalls and total rebuffering time;
- delivered video-quality proxy (played rendition bitrate/resolution);
- adaptation reaction time;
- buffer safety and quality stability; and
- playback completion?

Expected outcomes are hypotheses until the complete experiment matrix has been executed and validated.

## Team

| Member | Primary ownership |
|---|---|
| **Asadullah Galib** (`@zGalibz`) | Member 1 — media packaging, HLS validation, local HTTP server, deterministic bandwidth shaping |
| **Susmoy L** (`@susssm`) | Member 2 — hls.js player, default/custom ABR, browser telemetry, live dashboard |
| **Miraj** (`@ahsanullahmiraj`) | Member 3 — experiment orchestration, validation, analysis, charts, presentation |

Ownership identifies the first reviewer and maintainer. It does not prevent another member from contributing through a pull request.

## Planned system

```text
Source video
   │
   ▼
FFmpeg HLS package (360p / 480p / 720p / 1080p, aligned 2 s segments)
   │
   ▼
Node.js experiment server + deterministic per-run bandwidth shaper
   │
   ▼
Chrome + pinned hls.js player
   ├── stock hls.js ABR
   └── conservative-throughput-v1
   │
   ▼
Append-only raw telemetry + server logs
   │
   ▼
Validator → metric reducer → tables/charts → 12-minute presentation
```

The system is local-first so the live demonstration does not depend on public Wi-Fi, YouTube, a cloud service, or a CDN.

## Core experiment

- Policies: `default-hlsjs` and `conservative-throughput-v1`.
- Traces: stable, gradual congestion, and volatile bandwidth.
- Repetitions: three fresh runs per policy × trace cell.
- Core dataset: **18 counted runs**.
- Optional extension: a short outage trace, adding six runs.
- Primary evidence: raw event logs, exact run metadata, validated summaries, and reproducible charts.

## Foundation documents

1. [`docs/PROJECT_DESIGN.md`](docs/PROJECT_DESIGN.md) — canonical end-to-end project design, architecture, policies, metrics, contracts, experiment matrix, and acceptance gates.
2. [`docs/TEAM_ROLES.md`](docs/TEAM_ROLES.md) — exact responsibilities, dependency order, branch plan, handoffs, deliverables, and completion checks for each member.
3. [`docs/GITHUB_WORKFLOW.md`](docs/GITHUB_WORKFLOW.md) — branch, commit, pull-request, review, merge, and integration rules.
4. [`docs/decisions/ADR-001-canonical-scope.md`](docs/decisions/ADR-001-canonical-scope.md) — decisions that resolve differences among the research drafts.
5. [`contracts/openapi.yaml`](contracts/openapi.yaml) and [`contracts/schemas/`](contracts/schemas/) — initial machine-readable integration contracts. These remain **draft contracts** until all three members approve the `v0.1-contracts` milestone.
6. [`docs/research/`](docs/research/) — detailed source-grounded architecture, hls.js/ABR, and evaluation research retained for traceability.
7. [`docs/MEMBER1_IMPLEMENTATION.md`](docs/MEMBER1_IMPLEMENTATION.md) — completed media/networking design, measurements, commands, validation, and rationale.
8. [`docs/MEMBER1_HANDOFF.md`](docs/MEMBER1_HANDOFF.md) — concise player/runner integration instructions.
9. [`docs/MEMBER1_VERIFICATION.md`](docs/MEMBER1_VERIFICATION.md) — exact verification environment, hashes, commands, and observed gate results.

## Repository layout

```text
apps/player/                    Susmoy: browser player and dashboard
packages/media-cli/             Asadullah: encode/package/validate media
packages/shaper-server/         Asadullah: server, run lifecycle, shaping, server logs
packages/contracts/             generated validators/types from shared contracts
packages/runner/                Miraj: controlled run orchestration
packages/analysis/              Miraj: validation, metrics, summaries, charts
contracts/                      shared OpenAPI and JSON Schemas
configs/                        experiment and bandwidth-scenario definitions
assets/                         source/fixture documentation; large media is not normal Git content
media/                          generated HLS package; ignored except documentation/manifests
results/                        dry-run, raw, summary, and figures areas
slides/                         presentation source and fallback-demo notes
tests/                          contract, integration, and end-to-end tests
docs/                           canonical design, roles, workflow, decisions, research
```

Empty `.gitkeep` files preserve the intended structure before implementation begins.

## Development workflow

- `main` is the integration branch; do not develop directly on it after the foundation commit.
- Start short-lived branches from updated `main`:
  - `feat/m1-media-pipeline`
  - `feat/m1-shaper-server`
  - `feat/m2-player-telemetry`
  - `feat/m2-conservative-abr`
  - `feat/m3-validator-analysis`
  - `docs/m3-presentation`
- Open one focused pull request per deliverable.
- Every PR needs at least one non-author review; cross-module contracts require reviews from affected owners.
- Use squash merge and delete merged branches.
- Do not commit secrets, unlicensed media, generated `node_modules`, browser profiles, or uncontrolled large binaries.

See [`docs/GITHUB_WORKFLOW.md`](docs/GITHUB_WORKFLOW.md) for the full procedure.

## Milestones

| Milestone | Meaning |
|---|---|
| `v0.1-contracts` | Design, schemas, API, IDs, events, roles, and metrics approved by all members |
| `v0.2-media-network` | HLS package, validator, server, traces, shaper, and calibration accepted |
| `v0.3-player` | One player build, both policies, instrumentation, dashboard, and tests accepted |
| `v0.4-end-to-end` | Both policies complete clean dry runs and raw-to-summary regeneration works |
| `v0.5-data-freeze` | Exactly 18 valid core outcomes and immutable evidence manifest accepted |
| `v1.0-presentation` | Final charts, claims, slides, live demo, fallback recording, and timed rehearsal ready |

## Current status

Member 1 implementation complete and awaiting team review:

- the four-rendition aligned HLS package is generated and validated;
- source, package, segment, playlist, and scenario hashes are frozen;
- measured peak/average rates replace the placeholder package hash;
- the lifecycle API, telemetry ingestion, secure HLS server, and aggregate bandwidth shaper are implemented;
- stable, gradual, and volatile scenarios are frozen from measured ladder thresholds;
- physical loopback calibration passes every plateau and transition gate;
- contract, media, server, security, concurrency, and calibration tests are automated in CI;
- player, ABR-policy, runner, analysis, counted experiment, and presentation work remain pending;
- no ABR comparison result or presentation conclusion exists yet.

## Sources

The canonical design is grounded in the primary/official references indexed in `docs/research/`, including RFC 8216 (HLS), FFmpeg/FFprobe documentation, Apple HLS authoring guidance, hls.js 1.7.4 source/API documentation, HTML media APIs, Node.js stream/timer documentation, JSON Schema Draft 2020-12, and RFC 9562 UUIDv7.
