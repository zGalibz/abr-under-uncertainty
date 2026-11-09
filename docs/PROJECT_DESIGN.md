# Project Design

Status: **canonical foundation; implementation has not started**

This document defines what the group will build, how the components connect, how the comparison stays fair, what evidence will be collected, and what must be verified before conclusions are allowed.

Detailed research and citations are retained in:

- `docs/research/reference-architecture.md`
- `docs/research/player-and-abr.md`
- `docs/research/experiment-and-team-framework.md`

When a research draft conflicts with this document, the decisions recorded here and in `docs/decisions/ADR-001-canonical-scope.md` are authoritative for the project.

## 1. Project purpose

Adaptive streaming divides a video into segments and offers each segment at several quality/bitrate levels. The client estimates available capacity and chooses the level for upcoming segments. Selecting too aggressively can empty the playback buffer and cause a stall; selecting too conservatively can keep playback smooth but unnecessarily reduce visual quality.

The project will build a complete local experiment that makes this trade-off visible and measurable.

### 1.1 Research question

> Under identical deterministic bandwidth traces, how does stock hls.js ABR compare with a simple conservative throughput-aware policy in playback stalls, played rendition bitrate, adaptation reaction time, buffer safety, switching, and completion?

### 1.2 Hypotheses — not findings

- H1: the conservative policy may reduce stall count or total stall duration during gradual and volatile bandwidth drops.
- H2: any stall reduction may be purchased with lower time-weighted played bitrate or slower quality recovery.
- H3: both policies should complete smoothly under stable bandwidth if the apparatus is correct.
- H4: bandwidth volatility may cause more switching and lower buffer safety than a stable connection with a similar average rate.

The group must report honest negative or mixed results. “Conservative is better” is not an acceptable conclusion unless the measured trade-off is stated.

## 2. Canonical scope

### Included

- HLS VOD streamed over local HTTP.
- One immutable approximately 120-second 1080p/30fps source clip with documented permission/license and SHA-256.
- Four H.264/AAC renditions with aligned two-second MPEG-TS segments.
- A Node.js same-origin server with run lifecycle APIs and deterministic application-layer downstream shaping.
- Chrome with hls.js pinned exactly to version `1.7.4`.
- Two selectable policies in one player build.
- Live telemetry/dashboard and append-only evidence logs.
- Three deterministic core traces and three repetitions per cell.
- Reproducible validation, reduction, tables, and charts.
- A short live demonstration plus a local prerecorded fallback.

### Excluded from the core

- A production CDN or cloud deployment.
- MPEG-DASH as a second protocol.
- Machine-learning bitrate prediction.
- Public cellular/Wi-Fi measurements as primary evidence.
- Multi-device or multi-browser comparisons.
- A subjective user study.
- Claims that the local shaper reproduces Netflix or the full public Internet.

These can become future work only after the complete core passes.

## 3. Architecture

```text
                           ┌──────────────────────────────┐
                           │ contracts/                  │
                           │ OpenAPI + JSON Schemas      │
                           └─────────────┬────────────────┘
                                         │ shared contract
                                         ▼
source video ──► media-cli ──► immutable HLS package
                    │                  │
                    │ package.json     │ master/media playlists + segments
                    ▼                  ▼
              package validator   shaper-server ◄── scenario JSON
                                      │
                  unshaped control ───┼── shaped media bodies
                                      ▼
                              Chrome + hls.js player
                              ├── default-hlsjs
                              ├── conservative-v1
                              └── telemetry/dashboard
                                      │
                                      ▼
                         append-only run artifacts
                                      │
                                      ▼
                         runner + validator + reducer
                                      │
                                      ▼
                            summaries + figures + deck
```

### 3.1 Integration principle

Modules must communicate only through:

- versioned files validated by JSON Schema;
- the HTTP API in `contracts/openapi.yaml`;
- run-scoped HLS URLs;
- normalized telemetry events; and
- documented command-line entry points.

A member must not import another member’s private classes or read undocumented internal files. This prevents independently developed work from becoming tightly coupled.

## 4. Media package

### 4.1 Source requirements

- Approximately 120 seconds; enough time to complete every declared bandwidth phase and final recovery.
- At least 1920×1080 progressive video.
- 30 fps or safely convertible to 30 fps.
- One audio track.
- Motion and visual detail sufficient to create meaningful bitrate differences.
- Legally usable: self-recorded, public domain, or license documented in `assets/source/README.md`.
- Immutable after apparatus acceptance; record SHA-256.

### 4.2 Initial rendition ladder

| ID | Resolution | Initial video target | Audio target | Purpose |
|---|---:|---:|---:|---|
| `v0` | 640×360 | about 500 kbit/s | 96 kbit/s | survival/lowest quality |
| `v1` | 854×480 | about 900 kbit/s | 96 kbit/s | low/medium quality |
| `v2` | 1280×720 | about 1,800 kbit/s | 96 kbit/s | HD quality |
| `v3` | 1920×1080 | about 3,200 kbit/s | 96 kbit/s | highest quality |

These are encoding targets, not final manifest `BANDWIDTH` values. Member 1 must calculate/validate peak and average rates from the generated segments and publish them in `media/package.json` and the master playlist.

### 4.3 Packaging rules

- H.264/AVC video, `yuv420p`; AAC-LC stereo at 48 kHz.
- Constant 30 fps.
- Two-second target segments.
- Closed, aligned 60-frame GOP at 30 fps.
- Every corresponding rendition segment begins at the same source time with an IDR/key frame.
- Static VOD playlists with `EXT-X-ENDLIST`.
- One master playlist listing the four variants from lowest to highest.
- All playlist and segment references are relative and deterministic.
- FFmpeg invocation and version are recorded and reproducible.

### 4.4 Media acceptance

Member 1’s validator must prove:

1. exactly four variants exist;
2. all media playlists have equal segment count;
3. corresponding segment starts/durations align within one frame;
4. every segment begins with a key/IDR frame;
5. each playlist is complete VOD and target duration is correct;
6. codecs, resolution, frame rate, audio settings, peak rate, and average rate agree with the manifest;
7. every generated file has a SHA-256 in `media/package.json`; and
8. all four levels play and switch in the pinned browser.

Large source/generated media should not enter normal Git history. Use a documented local asset or GitHub release/LFS later, always with hashes.

## 5. Network experiment server

### 5.1 Same-origin design

Default origin: `http://127.0.0.1:8080`.

Unshaped control traffic:

- player HTML/JS/CSS;
- lifecycle API;
- telemetry posts;
- master and media playlists.

Shaped data traffic:

- successful media segment response bodies for the active run.

This isolates the independent variable as media-delivery capacity and avoids telemetry influencing the stream.

### 5.2 Per-run aggregate shaper

The server must use one shared bandwidth budget per run, not one independent limit per HTTP response. Otherwise parallel requests could multiply the configured rate.

Initial contract:

- server monotonic clock defines scenario time;
- half-open phases: `startMs <= t < endMs`;
- one per-run token bucket;
- zero initial tokens;
- maximum 16 KiB burst;
- response writes no larger than 4 KiB;
- FIFO, work-conserving scheduling across eligible media responses;
- respect Node writable-stream backpressure and resume only on `drain`;
- recompute tokens from actual monotonic elapsed time after each timer wake-up;
- log target phase, bytes, write times, request start/end, aborts, and backpressure.

The project describes this honestly as local application-layer goodput shaping, not packet-level Internet emulation.

### 5.3 HTTP correctness

- HLS playlists: `application/vnd.apple.mpegurl`.
- TS segments: `video/mp2t`.
- Experimental HLS responses: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `X-Run-Id`.
- Correct full `GET`, `HEAD`, and exactly one byte range (`206`/`Content-Range`).
- Reject malformed/multiple/unsatisfiable ranges clearly.
- Normalize paths and reject traversal, encoded separator, NUL, absolute-path, and symlink escapes.
- Same-origin is the standard setup; optional CORS must use an explicit allowlist.

### 5.4 Run lifecycle

```text
CREATED → RUNNING → FINALIZING → COMPLETED
   │          │             └──► FAILED
   └──────────┴────────────────► ABORTED
```

- Server generates opaque `r_<uuidv7>` run IDs.
- `POST /api/v1/runs` captures experiment/scenario/package digests.
- `POST /api/v1/runs/{runId}/start` fixes monotonic run zero once and returns the run-specific manifest URL.
- `POST /api/v1/runs/{runId}/events` idempotently accepts normalized event batches.
- `POST /api/v1/runs/{runId}/finish` stops stream acceptance, validates/flushed logs, and finalizes artifacts.
- Retries must be idempotent; a repeated request must not create a second run or duplicate events.

The draft normative endpoint shapes are in `contracts/openapi.yaml`.

## 6. Player and adaptation policies

### 6.1 One player build

Both modes must use the same page, video element, hls.js version, media package, browser, retry/buffer settings, telemetry system, and dashboard. Runtime configuration selects the policy. Separate builds are prohibited because unrelated code drift would confound the comparison.

### 6.2 Default policy

`default-hlsjs` means hls.js `1.7.4` automatic ABR with normal ABR defaults.

Rules:

- `startLevel: -1`;
- `capLevelToPlayerSize: false`;
- do not write `currentLevel`, `nextLevel`, `loadLevel`, `nextLoadLevel`, `nextAutoLevel`, `bandwidthEstimate`, or `autoLevelCapping` during a default run;
- record `Hls.version` and relevant resolved `hls.config` values in run metadata.

### 6.3 Conservative policy

`conservative-throughput-v1` is deliberately simple enough to explain and replay from logs.

Inputs:

- completed main-fragment bytes and request duration;
- public rendition peak bitrates;
- current/effective level;
- forward buffer from the range containing `video.currentTime`;
- recent retry/error/stall signals.

Goodput sample:

```text
sample_bps = 8 × loaded_bytes / request_seconds
```

Use the complete request interval, including TTFB. Reject aborted, zero-byte, non-finite, or under-50-ms samples.

Estimator:

```text
fast = first ? x : 0.50×x + 0.50×fast
slow = first ? x : 0.20×x + 0.80×slow
estimate = min(fast, slow)
```

Selection rules:

1. Start at the lowest rendition.
2. Normal safe budget: `0.85 × estimate`.
3. Upgrade budget: `0.70 × estimate`.
4. Downswitch immediately and by multiple rungs if current peak bitrate exceeds the safe budget.
5. Low buffer, retry, or relevant network error uses the stricter 0.70 budget.
6. A real playback stall forces the lowest rendition and clears upgrade evidence.
7. Upgrade only one rung after three consecutive qualifying clean fragments.
8. Upgrade only when forward buffer is at least `max(8 s, 2 × last segment duration)`.
9. Require at least two clean buffered fragments after the prior upgrade.
10. Apply normal manual decisions through public `hls.loadLevel`; do not use private controllers or buffer-flushing `currentLevel`.

Every decision emits operands, from/to levels, safety factor, buffer, evidence count, and a stable reason code. The pure policy module must not import hls.js; the browser adapter converts public hls.js events into plain policy inputs.

### 6.4 Browser instrumentation

Preferred hls.js events:

- `MANIFEST_PARSED`, `LEVELS_UPDATED`;
- `FRAG_LOADING`, `FRAG_LOADED`, `FRAG_BUFFERED`, `FRAG_CHANGED`;
- `LEVEL_SWITCHING`, `LEVEL_SWITCHED`;
- `ERROR`.

Preferred browser media signals:

- `play`, `playing`, `waiting`, `pause`, `seeking`, `seeked`, `ended`, `error`;
- `video.buffered`, `currentTime`, `readyState`, `playbackRate`;
- `getVideoPlaybackQuality()` at finalization.

Normalize selected fields only; never serialize complete hls.js objects or depend on private `abrController` state.

## 7. Telemetry and evidence contract

### 7.1 Event envelope

Every event contains:

- schema version;
- run ID;
- monotonically increasing source sequence number;
- event type;
- client monotonic and epoch time;
- media time when applicable;
- normalized event-specific data.

No JSON `NaN` or Infinity. A missing finite estimate becomes `null`.

Events batch at a bounded interval/size, only one batch is in flight, and retries retain the original sequence numbers. Failure to flush before finalization makes the run incomplete/failed rather than silently “valid.”

### 7.2 Stall state machine

- Startup waiting is not rebuffering.
- Open a candidate on post-start `waiting` only while playback is intended and not paused/seeking/ended.
- Count it only if it lasts at least 250 ms; preserve the original start time.
- Close it on confirmed resumed `playing`.
- Duplicate `waiting` signals while open do not add events.
- `stalled` and hls.js buffer errors are diagnostics, not separate primary stall counts.
- A terminal event can close an interval as censored; it remains clearly labeled.

### 7.3 Raw run directory

```text
results/raw/<run_id>/
  run.json
  events.ndjson
  samples.csv
  fragments.csv
  network.csv
  server-requests.ndjson
  scheduler-writes.ndjson
  console.log
```

Raw evidence is append-only. Summaries and figures are derived and regenerable.

## 8. Network traces

Final rates are resolved only after the measured four-level ladder is frozen.

Core trace intentions:

1. `stable-v1`: capacity safely supports the highest level for the full run.
2. `gradual-v1`: high capacity progressively falls through upper, middle, and lower safe levels, then optionally recovers.
3. `volatile-v1`: repeated plateaus alternate around rendition boundaries, including one severe low interval.
4. `outage-v1` (optional, declared before execution): short near-zero interval, low recovery, then high recovery.

Member 1 must compile final integer rates, record reaction anchors, validate contiguous phases, hash the files, and calibrate target versus achieved rate before counted runs.

Calibration gate:

- nonzero plateau one-second median achieved throughput within ±10% of target after settling;
- transition timing within ±0.5 s;
- target and achieved rate plotted/logged separately.

Configured capacity must never be mislabeled as measured throughput.

## 9. Experiment matrix

Core matrix:

| Trace | Default | Conservative | Total |
|---|---:|---:|---:|
| Stable | 3 | 3 | 6 |
| Gradual | 3 | 3 | 6 |
| Volatile | 3 | 3 | 6 |
| **Total** | **9** | **9** | **18** |

Each repeat uses a fresh browser context, new run ID, disabled cache/service workers, clean player instance, restarted trace, and identical apparatus.

Before counted runs:

- one unshaped warm-up per policy, discarded;
- one dry run per policy, stored under `results/dry-run/`;
- all contract, fixture, calibration, and end-to-end acceptance tests pass;
- policy constants, media hashes, scenario hashes, browser/hls.js versions, and run order are frozen.

Valid poor outcomes are never replaced. Harness-invalid runs are retained and point to a documented rerun.

## 10. Metrics

### 10.1 Primary

- Startup delay: Play request to first confirmed playback.
- Rebuffer count: retained post-start `waiting → playing` intervals.
- Total rebuffer duration.
- Rebuffer ratio.
- Time-weighted played rendition bitrate.
- Effective quality-switch count/direction/magnitude based on played fragments.
- Forward-buffer mean, fifth percentile, and low-buffer fraction.
- Reaction time after adverse trace anchors.
- Completion with exact terminal reason.

### 10.2 Reporting with three repetitions

- Show every run-level point.
- Primary cell summary: median and full `[min, max]` range.
- Secondary: mean and sample standard deviation, clearly labeled.
- Compare matching repeat IDs using paired deltas.
- Say `3/3`, `2/3`, etc. for direction consistency and completion.
- Do not claim statistical significance from three repetitions.
- Do not calculate percentage improvement when the baseline value is zero.
- Keep incomplete-run bitrate as prefix-only rather than pooling it with complete runs.

## 11. Dashboard and charts

Live dashboard:

- current scenario phase and configured cap;
- selected/effective level, resolution, and bitrate;
- measured fragment goodput and hls.js estimate;
- forward buffer;
- quality switches and stalls;
- active policy and run ID.

Final evidence set:

1. architecture and trace diagram;
2. synchronized time series of configured rate, achieved throughput, played level, buffer, and stalls;
3. paired rebuffer-duration/count plots;
4. paired time-weighted bitrate plot;
5. startup and reaction-time plots;
6. switch count/magnitude panel;
7. buffer-safety panel;
8. quality-versus-stall trade-off scatter;
9. exact completion table.

Every chart includes units, run IDs or `n`, policy, trace, aggregation, and complete/prefix-only status.

## 12. Acceptance gates

### Contract gate (`v0.1-contracts`)

- All three members approve design, role split, OpenAPI, schemas, event meanings, run IDs, metrics, and change process.
- Examples validate and contract conflicts are resolved before implementation.

### Media/network gate (`v0.2-media-network`)

- Four-level package and hashes pass all media checks.
- Server passes MIME, range, cache, traversal, lifecycle, and idempotency tests.
- Parallel requests share one aggregate budget.
- Core traces pass calibration.

### Player gate (`v0.3-player`)

- One pinned build supports both policies.
- Default mode does not write manual ABR controls.
- Conservative policy replay tests are deterministic.
- Event fixtures cover startup, stalls, duplicates, retry, switch, errors, and completion.
- Dashboard data matches emitted telemetry.

### End-to-end gate (`v0.4-end-to-end`)

- One valid dry run per policy.
- Raw logs pass schemas, sequence, timing, and hash checks.
- Summaries and charts regenerate from raw data with one command.

### Data-freeze gate (`v0.5-data-freeze`)

- Exactly 18 accepted core outcomes.
- Invalid attempts retained with lineage.
- Validation report has no unexplained schema/hash/matrix errors.
- Every conclusion traces to a summary row and raw files.
- All three approve and tag the data-freeze commit.

## 13. Presentation plan

The 12-minute presentation should tell a research story, not tour every source file:

1. Question and stakes — 45 s.
2. HLS/ABR concept and quality–stall trade-off — 75 s.
3. Architecture and controlled experiment — 90 s.
4. Measurement rules — 75 s.
5. Short live volatile-trace demonstration — 120 s.
6. Main measured outcomes — 120 s.
7. Adaptation mechanism, reaction, switching, buffer — 90 s.
8. Trade-offs and limitations — 75 s.
9. One-sentence answer and future work — 30 s.

Use the local live demo, but always keep a prerecorded local fallback and saved charts.

## 14. Risks and protections

| Risk | Protection |
|---|---|
| Misaligned HLS segments | One reproducible packaging script and per-segment FFprobe validation |
| Wrong manifest bandwidth | Calculate from generated segments; verify before experiments |
| Parallel requests multiply rate | One per-run aggregate token bucket and concurrency test |
| Browser cache invalidates traces | Run-specific URLs, `no-store`, fresh context, cache disabled |
| Telemetry affects media | Unshaped control plane and bounded batches |
| Event-loop timing differs from target | Monotonic clock, small chunks, backpressure, actual write logs, calibration |
| False stall counts | Explicit startup/pause/seek/terminal-aware state machine |
| Version drift | Exact hls.js lock, browser/version metadata, hashed apparatus |
| Contract drift between members | Contracts first, examples/fixtures, affected-owner reviews, version bump |
| Cherry-picked outcomes | Fixed matrix/order, retain failures, data-freeze manifest |
| Overclaiming | Separate hypothesis, observation, and interpretation; state local-emulation limits |

## 15. Primary technical sources

- RFC 8216 — HTTP Live Streaming: https://datatracker.ietf.org/doc/html/rfc8216
- FFmpeg formats/HLS muxer: https://www.ffmpeg.org/ffmpeg-formats.html
- FFmpeg and FFprobe: https://ffmpeg.org/ffmpeg-doc.html and https://www.ffmpeg.org/ffprobe.html
- Apple HLS authoring specification: https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices
- hls.js 1.7.4 source/API: https://github.com/video-dev/hls.js/tree/v1.7.4 and https://hlsjs.video-dev.org/api-docs/hls.js.hls
- HTML media behavior: https://html.spec.whatwg.org/multipage/media.html
- Node.js streams/timers: https://nodejs.org/api/stream.html and https://nodejs.org/api/timers.html
- HTTP ranges/cache/CORS: https://datatracker.ietf.org/doc/html/rfc9110 and MDN HTTP documentation
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12
- UUIDv7: https://datatracker.ietf.org/doc/rfc9562
