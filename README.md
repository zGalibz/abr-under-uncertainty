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
10. [`docs/experiment-protocol.md`](docs/experiment-protocol.md) — the pre-registered protocol for the counted runs: variables, procedure, inclusion rules, metric definitions, reporting rules.
11. [`docs/results.md`](docs/results.md) — results of dataset v1, hypotheses, pre-registered targets, limitations.
12. [`slides/README.md`](slides/README.md) — presentation running order, speakers, live demo and fallback.

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

## Current status (2026-11-12)

| Milestone | State |
|---|---|
| Media + network (Member 1) | done: validated four-level package, frozen traces, calibrated shaper (PR #2) |
| Player + both policies (Member 2) | done (PR #3), plus a runner-controlled mode for counted runs |
| Runner, validator, metrics, charts (Member 3) | done; real end-to-end dry runs valid and reproducible |
| Counted dataset v1 | **18/18 valid**, frozen in `results/data-freeze.json`; awaiting all three approvals (`v0.5-data-freeze`) |
| Results and presentation | `docs/results.md`, `slides/README.md`; awaiting rehearsal and approval (`v1.0-presentation`) |

**Result in one sentence:** in our lab neither policy stalled in any of the 18 runs, so the conservative policy had nothing to prevent. It played a 3–15 % lower bitrate in every paired run, in exchange for starting about 1 s sooner and keeping about 2 s more minimum buffer (`docs/results.md`).

## Run the experiment end to end

```bash
npm ci && npm test                                                  # 96 tests: contracts, media, server, runner, player
CORS_ALLOWED_ORIGINS=http://127.0.0.1:4173 npm run server           # terminal 1: API + shaped media on :8080
npm run build -w @abr-lab/player && npm run dev -w @abr-lab/player  # terminal 2: player page on :4173
export CHROME_PATH=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
npm run runner -- --mode dry-run --player-url http://127.0.0.1:4173/   # one real run per policy
npm run runner -- --mode counted --player-url http://127.0.0.1:4173/   # the frozen 18-run order (clean checkout)
npm run analyze -- --order results/run-order.json                      # validate, reduce, summarise, chart
npm run freeze                                                          # data-freeze manifest (--verify to check)
```

The media package (`media/`) and source clip are not in git; see `docs/MEMBER1_HANDOFF.md`. The protocol that governs counted runs is `docs/experiment-protocol.md`.

## Sources

The canonical design is grounded in the primary/official references indexed in `docs/research/`, including RFC 8216 (HLS), FFmpeg/FFprobe documentation, Apple HLS authoring guidance, hls.js 1.7.4 source/API documentation, HTML media APIs, Node.js stream/timer documentation, JSON Schema Draft 2020-12, and RFC 9562 UUIDv7.
