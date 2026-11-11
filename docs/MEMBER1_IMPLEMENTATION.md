# Member 1 — Media and Networking Implementation

This document records the completed Member 1 contribution, the reason for each engineering choice, the reproducible commands, the measured package properties, and the interfaces handed to Members 2 and 3.

## 1. Scope delivered

Member 1 now provides:

- a frozen source-video fingerprint and technical probe;
- a reproducible four-rendition FFmpeg HLS packaging command;
- strict playlist, stream, hash, keyframe, decode, and alignment validation;
- measured peak and average muxed bitrates derived from segment bytes;
- a same-origin Node.js experiment server;
- persistent run lifecycle and idempotent telemetry ingestion;
- secure run-scoped HLS URL rewriting and byte-range support;
- one aggregate FIFO token bucket per run;
- frozen stable, gradual, and volatile scenarios derived from the measured ladder;
- physical loopback calibration evidence;
- JSON Schemas, OpenAPI, tests, CI gates, and downstream handoff instructions.

The player, ABR policies, experiment runner, analysis, charts, and presentation remain owned by Members 2 and 3.

## 2. Source preparation

Frozen local input:

```text
assets/source/source.mp4
SHA-256: fda77d579859928e9c4134dc7a66eacc69cbeaed2860668130bfce05ac995dc1
Size: 57,252,365 bytes
Duration: 128.568889 seconds
Video: H.264, 1920×1080, yuv420p, 25 fps
Audio: AAC, stereo, 44.1 kHz
```

The project owner states that the selected source is public domain. No source URL or independent license record was supplied, so the repository deliberately records this as a user-provided claim rather than independent verification. The 55 MB input remains outside normal Git history.

Why: a frozen hash prevents a silent media replacement from changing the experiment. Recording the provenance limitation avoids making a stronger licensing claim than the available evidence supports.

## 3. HLS packaging

Run from the repository root:

```bash
npm ci
npm run media:package -- \
  --source assets/source/source.mp4 \
  --output media \
  --preset medium \
  --license "public domain (user-provided claim)"
```

The implementation normalizes the source to:

- constant 30 fps;
- closed 60-frame GOPs;
- forced keyframes every two seconds;
- scene-cut keyframes disabled;
- H.264 High Profile, `yuv420p`;
- AAC-LC stereo at 48 kHz and 96 kbit/s;
- MPEG-TS media segments;
- VOD playlists with deterministic relative paths.

The four video targets are:

| ID | Resolution | Target | Max rate | VBV buffer |
|---|---:|---:|---:|---:|
| `v0` | 640×360 | 500 kbit/s | 550 kbit/s | 1,000 kbit |
| `v1` | 854×480 | 900 kbit/s | 990 kbit/s | 1,800 kbit |
| `v2` | 1280×720 | 1,800 kbit/s | 1,980 kbit/s | 3,600 kbit |
| `v3` | 1920×1080 | 3,200 kbit/s | 3,520 kbit/s | 6,400 kbit |

Why normalize from 25 to 30 fps: it freezes one simple timing model for the whole group—60 frames per two-second GOP—and matches the project design already shared with the player and analysis owners.

Why force closed GOP boundaries: every rendition must expose the same safe switching points. A player can then change quality at corresponding segment boundaries without depending on frames from another segment.

Why generate the canonical master after encoding: FFmpeg's advertised `BANDWIDTH` can be rounded down. The implementation calculates bandwidth from actual complete MPEG-TS files and `EXTINF` durations, then rounds upward so the manifest never understates measured demand.

## 4. Measured package

The validated package contains 65 segments in every rendition:

| ID | Resolution | Segments | Measured peak | Measured average |
|---|---:|---:|---:|---:|
| `v0` | 640×360 | 65 | 806,144 bit/s | 637,086 bit/s |
| `v1` | 854×480 | 65 | 1,391,200 bit/s | 1,035,116 bit/s |
| `v2` | 1280×720 | 65 | 2,704,192 bit/s | 1,928,178 bit/s |
| `v3` | 1920×1080 | 65 | 4,790,240 bit/s | 3,319,421 bit/s |

Exact formulas:

```text
segment rate = 8 × segment bytes ÷ EXTINF seconds
BANDWIDTH = ceil(maximum segment rate)
AVERAGE-BANDWIDTH = ceil(8 × all segment bytes ÷ all EXTINF seconds)
```

Audio, container, PAT/PMT, PES, and transport-stream overhead are included because they all consume network capacity.

Small metadata committed to Git:

- `media/package.json` — source, toolchain, command vector, rendition, segment, file-hash, and bitrate evidence;
- `media/validation-report.json` — validation result and package-manifest digest.

Large `.ts` files and the source MP4 remain ignored.

## 5. Media validation

Run:

```bash
npm run media:validate -- --output media
```

The validator checks:

1. the package manifest and every declared payload hash;
2. exactly four ordered variants;
3. equal segment count and aligned `EXTINF` values;
4. deterministic, local, traversal-free segment URIs;
5. VOD and end-list tags;
6. target duration and independent-segment declarations;
7. one H.264 video and one AAC audio stream per rendition;
8. exact resolution, `yuv420p`, 30 fps, 48 kHz stereo audio;
9. complete rendition decoding with FFmpeg `-xerror`;
10. a key packet, I frame, and H.264 IDR at every segment start;
11. 60 video frames in every normal two-second segment;
12. first-video-PTS alignment across all renditions within one frame;
13. exact measured peak and weighted-average bandwidth;
14. no unexpected package payload files.

Why validate the first VCL NAL type: `key_frame=1` or an I picture alone is weaker evidence. Requiring NAL type 5 proves that each segment starts with an IDR access point.

## 6. Server lifecycle and persistence

Start the server:

```bash
npm run server
```

Default address:

```text
http://127.0.0.1:8080
```

Operational endpoints:

```text
GET /healthz
GET /readyz
```

Run lifecycle:

```text
POST /api/v1/runs
POST /api/v1/runs/{runId}/start
POST /api/v1/runs/{runId}/events
POST /api/v1/runs/{runId}/finish
POST /api/v1/runs/{runId}/abort
GET  /api/v1/runs/{runId}
```

Run-scoped HLS:

```text
GET /stream/v1/{runId}/master.m3u8
GET /stream/v1/{runId}/v0/index.m3u8
GET /stream/v1/{runId}/v0/seg_00000.ts
```

The server creates opaque `r_<uuidv7>` identifiers, persists run state atomically, stores telemetry as append-only NDJSON, and recognizes duplicate event identity as `(runId, source, seq)`.

Idempotency rules:

- the same creation `requestId` and body returns the same run;
- the same `requestId` with another body returns `409`;
- an identical event replay is counted as a duplicate and stored once;
- the same event identity with different content returns `409`;
- repeated start, finish, or abort calls are safe only when their payload is identical.
- finish is rejected with `TELEMETRY_INCOMPLETE` until player sequences are exactly contiguous from zero through the declared `lastSeq`; the run remains `RUNNING` so missing events can be retried.

If the process restarts while a run is `RUNNING` or `FINALIZING`, initialization preserves the original run-zero timestamps and deterministically changes the run to `FAILED` with `failureCode: SERVER_RESTART`. Media is no longer served for that run. The runner must archive it as harness-invalid and create a new run with lineage; it must never continue a counted run against a reset scenario clock.

Why: browser retries or runner retries must not create duplicate runs or duplicate evidence. A conflicting retry must be visible rather than silently accepted.

## 7. HTTP and filesystem behavior

HLS responses provide:

- `Cache-Control: no-store`;
- `X-Content-Type-Options: nosniff`;
- `X-Run-Id`;
- `application/vnd.apple.mpegurl` for playlists;
- `video/mp2t` for MPEG-TS;
- correct `Content-Length`, `Accept-Ranges`, `Content-Range`, `206`, and `416` semantics.

`HEAD` returns headers without a body and consumes no shaping tokens. Playlists, lifecycle API traffic, telemetry, and error responses are not shaped. Only successful media bodies enter the bandwidth scheduler.

The asset resolver rejects absolute paths, traversal, encoded separators, backslashes, NUL bytes, query/fragment references, malformed encoding, and symlink escape from the package root. Readiness also re-hashes every manifest payload; `/readyz` returns `503` and experiment routes remain unavailable when media is absent or corrupt.

Why: run-scoped URLs are partly supplied by clients. Lexical normalization alone is insufficient because a symlink can still resolve outside the package; both lexical and real-path containment are enforced.

## 8. Aggregate shaping algorithm

Every started run owns exactly one token ledger and one FIFO scheduler.

Fixed controls:

```text
initial tokens: 0 bytes
maximum burst: 16,384 bytes
maximum write: 4,096 bytes
rate unit: decimal kbit/s
phase intervals: half-open [startMs, endMs)
clock: server monotonic time since run start
```

Capacity earned over an interval is integrated across every phase boundary:

```text
bytes earned = downlinkKbps × elapsedMs ÷ 8
```

The ledger caps accumulated credit at 16 KiB. Concurrent segment responses share the same ledger, so opening two connections does not double the configured bandwidth. Writes are FIFO and work-conserving; Node stream backpressure and client aborts are handled without refunding bytes already written. Aborting a run terminates active and queued media transfers.

Why one ledger per run: a separate limiter per HTTP request would let parallel HLS requests multiply the available bandwidth and invalidate the controlled experiment.

Why monotonic time: wall-clock corrections must not move the trace backward or forward.

## 9. Frozen scenarios

The compiler derives thresholds from the measured package using the conservative-policy safety factor `0.85` rather than copying nominal encoder targets.

Compile again after a package change:

```bash
npm run scenarios:compile
```

Current rates:

| Label | Rate | Meaning |
|---|---:|---|
| `high` | 7,045 kbit/s | headroom above measured `v3` peak |
| `v2-safe` | 4,408 kbit/s | safely supports `v2`, not `v3` |
| `v1-safe` | 2,409 kbit/s | safely supports `v1`, not `v2` |
| `v0-safe` | 1,292 kbit/s | safely supports `v0`, not `v1` |
| `severe` | 711 kbit/s | below the safe `v0` threshold |

The compiler writes:

- `stable.v1.json` — constant high capacity;
- `gradual.v1.json` — descending ladder-relative plateaus, a severe interval, then recovery;
- `volatile.v1.json` — repeated high/low/medium/severe oscillations and recovery;
- `manifest.json` — canonical scenario hashes and preregistered adverse/recovery anchors.

Why measured thresholds: ABR behavior should be interpreted against what the actual muxed package requires, not what the FFmpeg target bitrate suggested before encoding.

## 10. Physical calibration

Run:

```bash
npm run calibrate:scenarios
```

The calibration uses the real loopback HTTP server, run lifecycle, HLS route, aggregate scheduler, streaming response reads, and scheduler logs. It compresses each plateau to four seconds only for calibration speed; it does not change the frozen experiment schedules.

Observed gate summary:

```text
stable:   1/1 plateau, 0/0 transitions — PASS
gradual:  6/6 plateaus, 5/5 transitions — PASS
volatile: 9/9 plateaus, 8/8 transitions — PASS
```

Acceptance limits:

- settled one-second median throughput within ±10% of each target;
- first scheduler write in the new phase within 500 ms of each boundary.

The measured medians were within approximately 0.5% of target, and all phase transitions occurred within approximately 0.06 ms in this local run. Full values are preserved in `results/calibration/calibration-report.json`.

Calibration is evidence about the shaper mechanism, not evidence that either ABR policy is better. Policy results remain unknown until the controlled 18-run matrix is completed.

## 11. Tests and CI

Local gates:

```bash
npm ci
npm run check:foundation
npx --yes @redocly/cli@2.77.0 lint contracts/openapi.yaml
npm test
npm audit --audit-level=moderate
git diff --check
```

The test suite covers:

- strict playlist parsing and exact bandwidth arithmetic;
- FFmpeg command construction and master-manifest rendering;
- Annex-B IDR detection;
- synthetic-source packaging and complete validation;
- UUIDv7 and canonical hashing;
- byte ranges and scenario boundary integration;
- traversal and symlink escape;
- playlist rewriting;
- run-wide token accounting and concurrent FIFO transfers;
- lifecycle, idempotency, telemetry conflict, MIME, cache, range, and HLS integration;
- measured-ladder scenario compilation;
- calibration gate evaluation;
- machine-readable contract presence.

`.github/workflows/quality.yml` repeats the reproducible gates on pull requests. Its media/server integration fixtures are generated during the job, so CI does not depend on the local copyrighted/large source file.

## 12. Downstream handoff

Member 2 should:

1. create a run with an immutable `policyId`;
2. start the run and use returned clock data;
3. load `hlsUrl`, which is `/stream/v1/{runId}/master.m3u8`;
4. send schema-valid event batches to `/events`;
5. use a fresh browser context and disabled cache for each run;
6. finish only after `ended` or send abort on harness failure.

Member 3 should:

1. treat `run.json`, `events.ndjson`, `server-requests.ndjson`, and `scheduler-writes.ndjson` as raw evidence;
2. verify package, experiment, scenario, policy, commit, and browser provenance;
3. reject sequence conflicts or invalid harness timing;
4. use anchors from `configs/scenarios/manifest.json` for reaction metrics;
5. never alter raw NDJSON during reduction.

The normative request/response shapes are in `contracts/openapi.yaml`; persistent artifact schemas are under `contracts/schemas/`.

## 13. Reproduction order

From a fresh checkout with Node.js 22+ and FFmpeg/FFprobe installed:

```bash
npm ci
npm run check:foundation
npm test
npm run media:package -- \
  --source /absolute/path/to/source.mp4 \
  --output media \
  --preset medium \
  --license "public domain (user-provided claim)"
npm run media:validate -- --output media
npm run scenarios:compile
npm run calibrate:scenarios
npm run server
```

A reproduced source must match the frozen SHA-256 before counted runs. Different FFmpeg/libx264 builds can produce different compressed bytes even when they pass every structural invariant; therefore exact package-byte reproduction and independent package validation are treated as separate checks.

## 14. Known limitations

- The public-domain claim lacks an independent source URL or license page.
- The large source and generated MPEG-TS payload are not stored in normal Git history; teammates need a separately transferred copy and must verify hashes.
- Persistence is local filesystem based and intended for one controlled run at a time.
- The server intentionally binds to loopback by default and does not implement remote deployment, TLS, CDN behavior, or packet-level loss/jitter.
- Physical calibration was performed on one macOS host; CI verifies functional behavior with generated fixtures, not identical local throughput values.
- No policy comparison result exists yet.
