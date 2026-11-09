# Team Roles and Step-by-Step Work Plan

This file is the operational agreement for the three members. It defines ownership, exact outputs, dependencies, handoffs, review requirements, and the point at which each part is safe to integrate.

## 1. Team-wide rules

1. Read `README.md`, `docs/PROJECT_DESIGN.md`, and this file before implementation.
2. Approve the shared contracts before writing production modules.
3. Develop through short-lived branches and pull requests; do not develop directly on `main` after the foundation commit.
4. A member may work outside their primary area, but the area owner must review the change.
5. Never silently change a shared schema, endpoint, event meaning, metric, HLS ladder, trace, or policy constant.
6. Every handoff must contain machine-readable artifacts, exact commands, observed validation output, and known limitations.
7. Do not delete unfavorable experiment outcomes. Only harness-invalid runs may be rerun, and the original remains archived with lineage.
8. Everyone must understand the whole system well enough to answer presentation questions, even though each person owns a different module.

## 2. Ownership map

| Area | Primary owner | Required cross-review |
|---|---|---|
| HLS source, packaging, validation | Asadullah | Susmoy verifies browser playback; Miraj verifies metadata usability |
| HTTP server, lifecycle, shaping, server logs | Asadullah | Susmoy reviews player-facing behavior; Miraj reviews run/evidence fields |
| Browser player and dashboard | Susmoy | Asadullah reviews stream/API assumptions; Miraj reviews telemetry |
| Default/custom ABR | Susmoy | Asadullah and Miraj review algorithm contract/observability |
| Schemas and telemetry meanings | Susmoy + Miraj | Asadullah reviews server/provider impact |
| Runner, validator, metrics, summaries, charts | Miraj | Asadullah and Susmoy review technical interpretation |
| Slides and presentation integration | Miraj coordinates | All three approve claims and rehearse |
| `.github/`, contract versions, data freeze | Shared | All three approve |

Ownership means responsibility and first review, not exclusive access.

## 3. Integration sequence

```text
M0: Contracts approved
      ├── Asadullah builds media/server against contracts
      ├── Susmoy builds player/policy against fixtures/contracts
      └── Miraj builds validator/analysis against synthetic events
                         │
                         ▼
M1 media/network + M2 player are both accepted
                         │
                         ▼
M3 two-policy end-to-end dry runs
                         │
                         ▼
M4 fixed 18-run matrix and data freeze
                         │
                         ▼
M5 results, demo, slides, rehearsal
```

No one needs to remain idle:

- Susmoy can use a tiny fixture stream and mock API before final media exists.
- Miraj can use synthetic raw events before the real player exists.
- Asadullah can build the media validator/server while event reducers are developed.

Final acceptance always uses the actual integrated components, not only mocks.

# 4. Member 1 — Asadullah Galib

Primary responsibility: **Media + Networking**

Primary paths:

```text
assets/source/
assets/fixtures/
media/
packages/media-cli/
packages/shaper-server/
configs/scenarios/
tests/integration/server-*
tests/e2e/network-*
```

Recommended branches:

```text
feat/m1-media-pipeline
feat/m1-media-validator
feat/m1-shaper-server
feat/m1-scenario-compiler
fix/m1-<short-description>
```

## Phase A — contract review

### A1. Review shared assumptions

Read:

- `docs/PROJECT_DESIGN.md` sections 3–10;
- `contracts/openapi.yaml`;
- all schemas and examples;
- Susmoy’s event needs and Miraj’s raw-data needs in this file.

Output:

- comments or a PR that resolves contradictions before production work;
- approval of API v1, run ID, scenario clock, stream path, server-log fields, and lifecycle.

Done when all three approve milestone `v0.1-contracts`.

### A2. Create media/network issues and ADRs

Create separate issues for:

1. source clip/license;
2. FFmpeg HLS packaging;
3. media validation;
4. HTTP server/lifecycle;
5. aggregate bandwidth shaper;
6. scenario compiler/calibration.

Record irreversible choices in `docs/decisions/`.

## Phase B — media pipeline

### B1. Select the source

Actions:

1. Choose one lawful approximately 120-second motion/detail-rich 1080p clip.
2. Place or fetch it outside normal Git history.
3. Create `assets/source/README.md` containing source, license/permission, fetch instructions if applicable, duration, resolution, frame rate, audio, and SHA-256.
4. Freeze the choice before ABR results are observed.

Deliverable:

- documented and checksummed source.

Acceptance:

- Susmoy and Miraj can independently identify the exact source and permission.

### B2. Implement reproducible HLS packaging

Actions:

1. Create the media CLI/package structure.
2. Encode four variants: 360p, 480p, 720p, 1080p.
3. Use common H.264/AAC settings, 30 fps, aligned two-second segments, closed 60-frame GOP, and forced aligned keyframes.
4. Generate complete VOD media playlists and one master playlist.
5. Record exact FFmpeg command/config and FFmpeg version.
6. Never hand-edit generated playlists without a script that records the transformation.

Deliverables:

- repeatable packaging command;
- generated local package;
- packaging documentation.

### B3. Build media validation

Validator checks:

- master/media playlist structure;
- four variants in ascending quality;
- equal segment count and aligned times;
- first frame of every segment is key/IDR;
- codecs/resolutions/frame/audio parameters;
- measured peak and average rate versus manifest values;
- SHA-256 of every package file;
- decoding and browser playback.

Deliverables:

```text
media/package.json
media/master.m3u8
media/v0/ ... media/v3/
media/validation-report.json
```

The large generated package may be excluded from Git; if so, commit the manifest, source instructions, validation report, and distribution method.

Handoff to Susmoy:

- run/serve command;
- manifest URL/path;
- `ladder.json` or equivalent measured metadata;
- exact level IDs and attributes;
- cache/MIME behavior.

Handoff to Miraj:

- duration, segment metadata, ladder metadata, source/package hashes;
- machine-readable fields sufficient to compute played bitrate.

### B4. Open the media PR

PR title example:

```text
feat(media): add reproducible four-level HLS pipeline
```

PR evidence:

- exact packaging/validation commands;
- validator output summary;
- sample manifest and package metadata;
- license/source note;
- limitations.

Required reviewers: Susmoy and Miraj.

## Phase C — server and bandwidth shaping

### C1. Implement local HTTP server

Actions:

1. Serve UI/API/playlists/segments from one origin.
2. Implement correct MIME, `no-store`, `nosniff`, and run ID headers.
3. Implement full GET, HEAD, and one-byte-range behavior.
4. Reject traversal and unsupported ranges safely.
5. Add health/readiness endpoint.
6. Document exact start/stop commands.

Acceptance tests:

- byte equality for full/range requests;
- correct statuses/headers;
- traversal probes fail;
- playlists and API remain unshaped.

### C2. Implement lifecycle APIs

Implement the OpenAPI contract:

- create run;
- read run;
- start run;
- append idempotent event batches;
- finish;
- abort;
- run-scoped HLS paths.

Required behavior:

- server-generated UUIDv7 run ID;
- persisted state transitions;
- idempotency;
- unique per-run URLs;
- append-only raw logs;
- no reset of a started clock after process restart.

### C3. Implement aggregate shaper

Actions:

1. Use one token bucket shared by all media responses in a run.
2. Use server monotonic elapsed time.
3. Implement phase boundary integration.
4. Start with zero tokens, 16 KiB maximum burst, and 4 KiB maximum writes.
5. Respect `write()` backpressure/`drain`.
6. Log scheduler and request data required by Miraj.
7. Correctly remove aborted requests and finalize logs.

Tests:

- a 1 MiB fixture under multiple rates;
- two simultaneous requests share one aggregate budget;
- step transition occurs by scenario time, not request boundary;
- backpressure resumes correctly;
- abort/restart behavior is explicit.

### C4. Resolve scenarios after ladder freeze

Actions:

1. Read measured rendition peak/average rates.
2. Produce stable, gradual, and volatile scenario JSON with final integer rates.
3. Generate adverse-change reaction anchors.
4. Validate phase continuity and hashes.
5. Do not expose future scheduled capacity to the player policy.

Deliverables:

```text
configs/scenarios/stable.v1.json
configs/scenarios/gradual.v1.json
configs/scenarios/volatile.v1.json
configs/scenarios/manifest.json
```

### C5. Calibrate every trace

Actions:

1. Run a backlogged transfer through each plateau.
2. Record target and measured one-second throughput separately.
3. Check ±10% rate and ±0.5 s transition tolerance.
4. Fix failures; do not merely waive unexplained error.
5. Produce a machine-readable and human-readable calibration report.

### C6. Open the server/shaper PR

PR title example:

```text
feat(network): add deterministic run-scoped HLS shaper
```

Required reviewers: Susmoy and Miraj.

Handoff to Susmoy:

- exact run/create/start/finish sequence;
- sample valid responses;
- manifest URL returned by start;
- known error codes;
- how to verify traffic is shaped.

Handoff to Miraj:

- scenario files/hashes/anchors;
- request/scheduler log formats;
- start-clock truth;
- calibration evidence.

## Phase D — integration, data freeze, and presentation

1. Verify the player requests only the run-scoped media path.
2. Diagnose network/server anomalies during dry runs without changing evidence rules.
3. Freeze media and trace hashes before counted runs.
4. Do not change the apparatus during the matrix without creating a new dataset version.
5. Review Miraj’s chart labels to ensure configured rate is not mislabeled measured throughput.
6. Explain media pipeline, architecture, shaping, calibration, and limitations during presentation.

Member 1 exit gate:

- `v0.2-media-network` accepted;
- all media/server/shaper tests and calibration pass;
- exact handoff artifacts are approved by Susmoy and Miraj.

# 5. Member 2 — Susmoy L

Primary responsibility: **Player + Adaptation**

Primary paths:

```text
apps/player/
packages/contracts/ (generated client validators/types with shared approval)
contracts/schemas/telemetry-event.schema.json (co-owned with Miraj)
tests/contract/player-*
tests/integration/player-*
```

Recommended branches:

```text
feat/m2-player-shell
feat/m2-telemetry-dashboard
feat/m2-conservative-abr
fix/m2-stall-state
```

## Phase A — contract and player foundation

### A1. Review contracts

Confirm with Asadullah and Miraj:

- run creation/start/finish sequence;
- run-specific manifest URL;
- exact normalized event fields;
- error/terminal behavior;
- how policy ID/config are persisted;
- what the reducer requires for played-fragment bitrate.

Done when `v0.1-contracts` is approved.

### A2. Pin the player toolchain

Actions:

1. Use hls.js exactly `1.7.4`; commit lockfile.
2. Define supported Chrome version/process and record runtime versions.
3. Bundle locally; no CDN `latest` dependency.
4. Create one player build with runtime policy selection.

Deliverable:

- player build/run command;
- version/config snapshot visible in `run.json` and telemetry.

### A3. Build basic player shell

UI includes:

- video element;
- policy/scenario selection for dry/demo mode;
- Start/Reset controls;
- run ID and state;
- current level/resolution/bitrate;
- buffer and throughput;
- event/status panel.

Measured runs must be controllable by Miraj’s runner and must not prefetch the source before run start.

## Phase B — baseline and instrumentation

### B1. Implement untouched default baseline

- instantiate stock hls.js auto ABR;
- preserve the shared non-ABR configuration;
- do not write manual quality setters in default mode;
- serialize relevant resolved hls.js config for audit.

Test:

- adapter test fails if default mode writes a forbidden ABR control.

### B2. Implement normalized telemetry

Capture:

- DOM play/playing/waiting/pause/seek/end/error;
- hls.js manifest, level, fragment, and error events;
- 4 Hz/250 ms buffer/player samples;
- fragment bytes/timings;
- level metadata and hls.js estimate;
- final playback-quality counters.

Rules:

- contiguous sequence numbers;
- monotonic timestamps;
- normalized plain data only;
- bounded batches and idempotent retries;
- no complete hls.js objects;
- flush success before final completion.

### B3. Implement stall state machine

Fixture cases:

1. startup-only waiting — zero rebuffer events;
2. under-250 ms wait — ignored;
3. one valid stall;
4. duplicate waiting during one stall — one event;
5. pause/seek waiting — harness invalid or excluded as specified;
6. terminal while stall open — censored;
7. resumed playing — closes correctly.

### B4. Implement live dashboard

The dashboard visualizes the exact telemetry stream; it must not invent values. It should show configured cap as server-supplied explanatory data but must not pass future bandwidth schedule information into the ABR policy.

## Phase C — conservative policy

### C1. Create pure policy module

The policy must not import hls.js. Inputs and outputs are plain objects.

Implement:

- valid request-goodput samples;
- fast/slow EWMA;
- 0.85 normal and 0.70 upgrade/emergency margins;
- immediate multi-rung downswitch;
- stall-to-lowest behavior;
- three-fragment upgrade confirmation;
- high-buffer upgrade gate;
- one-rung recovery;
- stable reason codes and complete decision telemetry.

### C2. Unit-test policy behavior

Required cases:

- exact goodput arithmetic;
- invalid sample rejection;
- sudden decrease and slow recovery;
- safe set selection;
- multi-rung downshift;
- low-buffer strict margin;
- upgrade confirmation reset;
- one-rung upgrade;
- stall hold-down;
- no-fitting-level fallback;
- deterministic replay gives identical decisions.

### C3. Connect policy through public hls.js APIs

- use `FRAG_BUFFERED` as the normal fragment-boundary decision trigger;
- use standard media events/errors for emergency signals;
- apply through public `hls.loadLevel`;
- avoid private controllers and buffer-flushing `currentLevel`;
- log requested and effective switches separately;
- refresh ladder mapping on `LEVELS_UPDATED`.

### C4. Open player/ABR PRs

Suggested PRs:

```text
feat(player): add pinned HLS player and normalized telemetry
feat(abr): add conservative throughput policy
```

Required reviewers: Asadullah and Miraj.

Handoff to Asadullah:

- player launch URL/command;
- required API/headers;
- stream-path behavior;
- readiness signal;
- error cases involving media/server.

Handoff to Miraj:

- schema-valid event examples;
- expected fixture summaries;
- policy/config/version metadata;
- sample raw files from both policies;
- terminal reason behavior.

## Phase D — integrated runs and presentation

1. Verify all four frozen levels and manifest hash.
2. Verify cache/service worker controls.
3. Complete one dry run per policy.
4. During counted runs, do not tune constants in response to results.
5. If a defect requires policy changes, version the policy/dataset and restart the matrix.
6. Review metrics/figures for correct requested-versus-played level interpretation.
7. Explain default ABR, custom pseudocode, buffer/throughput trade-off, and observed reactions during presentation.

Member 2 exit gate:

- `v0.3-player` accepted;
- one build supports both policies;
- policy/telemetry/dashboard tests pass;
- Asadullah and Miraj accept the handoff artifacts.

# 6. Member 3 — Miraj

Primary responsibility: **Evidence + Analysis + Presentation**

Primary paths:

```text
packages/runner/
packages/analysis/
results/
slides/
docs/experiment-protocol.md
docs/results.md
contracts/schemas/telemetry-event.schema.json (co-owned with Susmoy)
tests/contract/analysis-*
tests/e2e/*
```

Recommended branches:

```text
feat/m3-schemas-fixtures
feat/m3-validator-reducer
feat/m3-runner
feat/m3-charts
docs/m3-presentation
```

## Phase A — protocol and synthetic evidence

### A1. Freeze terminology and metrics

Create `docs/experiment-protocol.md` from the canonical design, including:

- hypotheses;
- included/excluded variables;
- startup/stall/switch/buffer/reaction/completion definitions;
- run inclusion/rerun rules;
- 18-run matrix and fixed order;
- statistical reporting rules;
- chart selection rule.

All three approve before counted runs.

### A2. Co-own schemas with Susmoy

Specify:

- event types and units;
- required/optional fields;
- NA/null behavior;
- sequence/timing rules;
- `run.json` provenance;
- raw/summary CSV columns;
- version/migration behavior.

Any breaking schema change needs fixture migration and affected-owner approval.

### A3. Create synthetic fixtures

Create known raw cases for:

- clean startup/finish;
- startup waiting only;
- one and two stalls;
- duplicate waiting;
- fragment retry/abort;
- requested level that never plays;
- played quality switch;
- buffer holes;
- proactive/already-safe reaction;
- censored reaction;
- premature end/fatal/timeout.

Each fixture includes expected metrics.

## Phase B — validation and analysis

### B1. Implement raw validator

Reject or flag:

- duplicate run IDs;
- unknown schemas/events;
- sequence gaps/reversal;
- non-monotonic timestamps;
- missing hashes/provenance;
- wrong policy/trace/repetition matrix;
- cache/version/media/trace mismatches;
- insufficient sample coverage;
- start-skew violations;
- post-freeze mutation.

### B2. Implement metric reducer

Compute from raw evidence:

- startup delay;
- rebuffer events/duration/ratio;
- played-fragment time-weighted bitrate;
- effective switches;
- buffer integral/percentile/low fraction;
- reaction anchors;
- completion and terminal reason.

The server/client summary is only a cross-check; Miraj’s reducer recomputes authoritative final metrics from raw events.

### B3. Implement summary tables

Produce:

```text
results/summary/runs.csv
results/summary/cells.csv
results/summary/paired_deltas.csv
results/summary/reaction_anchors.csv
results/summary/validation_report.json
```

Rules:

- all three points shown;
- median and full range primary;
- mean/sample SD secondary;
- paired deltas matched by trace/repeat;
- no significance claims;
- prefix-only quality kept separate.

### B4. Implement deterministic charts

Charts must be generated by command from validated summaries/raw logs, not edited values. Fixed policy colors, units, `n`, hashes/run IDs, and representative-run rule are required.

## Phase C — orchestration and data collection

### C1. Build runner

Runner responsibilities:

1. verify clean/pinned apparatus;
2. create fresh browser context;
3. create run through API;
4. coordinate ready/start handshake;
5. disable cache/service workers;
6. avoid human interaction;
7. monitor validity-only signals;
8. finalize/abort and collect artifacts;
9. run validation immediately;
10. preserve invalid attempts and rerun lineage.

### C2. Freeze run matrix

Core: 2 policies × 3 traces × 3 repeats = 18 runs.

Create and commit a fixed randomized order before execution. Do not reorder after seeing outcomes.

### C3. Perform dry runs

- one discarded unshaped warm-up per policy;
- one full dry run per policy in `results/dry-run/`;
- resolve contract defects through issues/PRs;
- obtain Asadullah/Susmoy approval before counted runs.

### C4. Run counted matrix

- execute exact matrix;
- accept valid bad outcomes;
- rerun only documented harness-invalid attempts;
- back up raw blocks read-only;
- do not tune policies/traces between cells.

### C5. Freeze data

Generate:

- artifact/hash manifest;
- clean validation report;
- exact run count;
- summary regeneration log;
- data-freeze PR and tag.

Required approvals: all three.

## Phase D — interpretation and presentation

1. Separate hypothesis, observation, and interpretation.
2. Trace every sentence to a metric/table/figure.
3. Build the timed nine-slide story defined in `docs/PROJECT_DESIGN.md`.
4. Assign each member a technical speaking section and smooth handoff.
5. Prepare a 20–40 second local demo trace and prerecorded fallback.
6. Run at least two full rehearsals and fit within 12 minutes.
7. Keep backup/technical charts outside the main slide flow.

Member 3 exit gate:

- `v0.5-data-freeze` and `v1.0-presentation` accepted;
- all results regenerate from raw data;
- all three approve claims and presentation.

# 7. Shared handoff checklist

A handoff PR is incomplete unless it contains:

- input contract/version;
- output files/endpoints/events;
- exact setup/run/test command;
- observed result, not only “works”;
- schema/hash/version metadata;
- sample artifact or fixture;
- failure behavior;
- known limitations;
- affected downstream member sign-off.

# 8. Contract-change procedure

1. Open a `contract` issue explaining why the current interface fails.
2. List every affected producer, consumer, test, fixture, and existing dataset.
3. Propose backward-compatible change when possible.
4. Update schema/OpenAPI, prose, examples, and tests in one PR.
5. Require all affected owners; breaking changes require all three.
6. Increment contract version.
7. After data freeze, create a new dataset version rather than silently changing old evidence.

# 9. Presentation ownership

- Asadullah: media ladder, system/server architecture, shaping, calibration, and emulation limitations.
- Susmoy: hls.js baseline, conservative policy, telemetry/dashboard, and adaptation mechanism.
- Miraj: protocol, metrics, run matrix, measured results, charts, limitations, and conclusion.

All members:

- understand the full diagram and experiment;
- know the policy comparison and primary metrics;
- review every final claim;
- can answer why the experiment is fair and reproducible.
