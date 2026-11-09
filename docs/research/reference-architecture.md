# Reproducible Adaptive-HLS Experiment Architecture

Status: **design contract; no implementation yet**  
Topic: **Adaptive Video Streaming: Comparing Video Quality and Playback Stalls under Changing Bandwidth**  
Owners: **Member 1 — Media + Networking; Member 2 — Player + Adaptation; Member 3 — Evidence + Presentation**

## 1. Evidence labels and decisions

- **Verified fact** means the statement is directly supported by an official or primary source cited inline.
- **Recommendation** means a project-specific design choice. It is intentionally testable but is not claimed to be required by HLS, FFmpeg, Node.js, or hls.js.
- **Derived value** means a value follows from this design's declared constants; it is not a general standard.

### 1.1 Verified facts that constrain the design

1. An HLS Master Playlist identifies Media Playlists, while each Media Playlist identifies Media Segments; a playlist cannot validly mix the two kinds. `EXT-X-STREAM-INF` requires `BANDWIDTH`, and `EXT-X-INDEPENDENT-SEGMENTS` says every segment can be decoded without information from another segment.[1]
2. For completed VOD, HLS `BANDWIDTH` is the largest peak segment bit rate and `AVERAGE-BANDWIDTH` is the largest average segment bit rate for the playable variant combination. `EXT-X-TARGETDURATION` bounds segment duration and a VOD playlist ends with `EXT-X-ENDLIST`.[1]
3. FFmpeg's HLS muxer supports `hls_time`, `hls_segment_filename`, `hls_playlist_type vod`, `master_pl_name`, `var_stream_map`, and `independent_segments`; when multiple variants are mapped, `%v` is required in variant playlist/segment output patterns.[2]
4. FFmpeg can force a key frame at a periodic expression such as `expr:gte(t,n_forced*2)`.[3] FFprobe can emit selected packet/frame/stream fields as JSON for machine validation.[4]
5. Apple's current authoring guidance says video segment boundaries must align across variants and segments must begin with IDR frames. It recommends two-second IDR spacing, while its general delivery profile recommends nominal six-second segments.[5] This experiment deliberately uses two-second *segments* as a lab choice for faster adaptation observations; it is not presented as Apple's general segment-duration recommendation.
6. Current recommended MIME types include `application/vnd.apple.mpegurl` for HLS playlists and `video/mp2t` for MPEG transport-stream segments.[5] The playlist media type is registered with IANA.[6]
7. hls.js exposes `FRAG_LOADED`, `FRAG_BUFFERED`, `LEVEL_SWITCHING`, `LEVEL_SWITCHED`, and `ERROR` events.[7] Its public `bandwidthEstimate` is in bits per second when available, and otherwise returns `NaN`.[8]
   `FragBufferedData` includes load statistics,[26] and fragments expose level, sequence number, start, and duration.[27]
   Levels expose bitrate, average bitrate, width, height, codecs, and URI data.[28]
8. This foundation pins hls.js `1.7.4`, the current package release found during this research on 2026-11-09.[9] hls.js supports both MPEG-2 TS and fMP4 HLS and relies on MSE/HTML video in Chrome.[10]
9. The HTML media `waiting` event is associated with playback stopping for temporary lack of data; `stalled` instead concerns failure to receive expected data.[11][29]
   `HTMLMediaElement.buffered` exposes current buffered time ranges,[24][30] while `getVideoPlaybackQuality()` exposes frame-quality counters including dropped and total video frames.[12]
10. Node writable streams signal backpressure by returning `false` from `write()` and later emitting `drain`; continuing to write without respecting this can accumulate memory.[13] Node timers do not guarantee exact callback timing.[14]
11. A valid single byte-range response uses status `206` and `Content-Range`; an unsatisfiable range uses `416`. A server may advertise byte support with `Accept-Ranges: bytes`.[16][18]
12. A single `Range` value is CORS-safelisted. Cross-origin JavaScript can read non-safelisted response headers only when the server exposes them, and credentialed CORS cannot use wildcard origins/headers in the same way as non-credentialed requests.[17][18]
13. `Cache-Control: no-store` directs caches not to store a response; `no-cache` still permits storage and requires revalidation.[19]
14. Puppeteer's network emulation defines download/upload speeds in bytes per second and latency in milliseconds, and Puppeteer can disable the page cache.[20][21] It is useful as an independent cross-check, not as a simultaneous second shaper.
15. JSON Schema Draft 2020-12 is the selected contract dialect.[22] UUIDv7 embeds a Unix-millisecond time field and is designed to be sortable.[23]

## 2. Experimental question and controlled variables

### 2.1 Question

Under the same source, HLS ladder, player configuration, browser build, and deterministic bandwidth schedule, how do selected video quality and playback stalls change?

### 2.2 Independent variable

The server-defined downstream media-body rate schedule, expressed as decimal kilobits per second (`1 kbit/s = 1000 bit/s`). Only HLS media bodies are shaped.

### 2.3 Primary outcomes

1. **Rebuffer count:** completed `media.waiting` → `media.playing` intervals after first playback begins, excluding pauses, seeks, and terminal end/error.
2. **Total rebuffer duration (ms):** sum of those completed intervals.
3. **Rebuffer ratio:** total rebuffer duration divided by wall-clock time from first `playing` to `ended` (or the declared stop point).
4. **Quality occupancy:** played media seconds and fraction at each effective hls.js level, based on `LEVEL_SWITCHED` and `data.level`.
5. **Time-weighted selected bitrate:** sum of each played-level bitrate multiplied by its media-time exposure, divided by total played media time.

### 2.4 Secondary outcomes

- startup delay from `media.play_requested` to first `media.playing`;
- level-switch count and up/down direction;
- forward buffer (`bufferedEnd - currentTime`) sampled every 500 ms;
- hls.js bandwidth estimate sampled at `FRAG_BUFFERED`;
- fragment load duration and bytes;
- dropped/total frames at run end;
- server-side achieved goodput and scheduler error versus configured rate.

### 2.5 Controls

- one immutable source asset and SHA-256;
- one packaged VOD asset set reused for every run;
- one Chrome binary/build and a fresh browser context per run;
- hls.js exactly `1.7.4` from the lockfile, never a CDN `latest` URL;
- automatic ABR only: `startLevel: -1`, no manual level changes;
- fixed viewport `1280×720`, device scale factor `1`, visible foreground page;
- playback rate `1`, muted autoplay for automation, no seeking;
- no service worker, no extensions, cache disabled, unique per-run stream URLs;
- control-plane traffic unshaped; media-body traffic shaped;
- identical scenario order generated by a recorded seed;
- at least five repetitions per scenario, with scenario order shuffled by that seed.

## 3. System context and data flow

```text
source.mp4
   │  Member 1: one pinned FFmpeg invocation + validator
   ▼
immutable HLS VOD package ───────────────┐
(master + 3 aligned media playlists)    │
                                        ▼
scenario.json ──► Node shaper/server ── HTTP ──► Chrome + hls.js player
                       │   ▲                         │
                       │   └── unshaped telemetry ──┘
                       ▼
          server-requests.ndjson + run.json
                       │
                       └────────────┐
                                    ▼
                    Member 3 runner + analysis
                                    │
                                    ▼
                  summary.json + CSV + charts + slides
```

### 3.1 Control plane versus data plane

**Recommendation:** Keep both planes on one origin, for example `http://127.0.0.1:8080`.

- **Unshaped control plane:** player HTML/JS/CSS, API calls, telemetry, master/media playlists.
- **Shaped data plane:** successful `GET` bodies for `.ts` (and `.m4s`/`.mp4` only if the media profile is changed later).
- `HEAD`, errors, redirects, API JSON, and playlists are never charged to the bandwidth budget.

This makes the independent variable "available media goodput" rather than "all browser traffic" and prevents telemetry uploads from perturbing media delivery.

## 4. HLS asset profile

### 4.1 Chosen profile

**Recommendation:** Static VOD; H.264/AVC video; AAC-LC stereo audio at 48 kHz; MPEG-2 TS segments; muxed audio duplicated at the same settings in each variant; two-second segments; 30 fps constant frame rate; closed GOP; every segment starts at the same source time with an IDR frame.

Why TS for this project:

- no initialization-segment request complicating the first sample;
- one media object per segment makes shaping logs easy to explain;
- hls.js officially supports TS and transmuxes it for MSE.[10]

The server still implements single byte ranges so the HTTP contract remains correct and the profile can later move to fMP4 without changing APIs.

### 4.2 Nominal ladder

| Level ID | Resolution | Video target | Video max rate | VBV buffer | Audio | Nominal combined |
|---|---:|---:|---:|---:|---:|---:|
| `v0` | 640×360 | 500 kbit/s | 550 kbit/s | 1000 kbit | 96 kbit/s | 596 kbit/s |
| `v1` | 1280×720 | 1500 kbit/s | 1650 kbit/s | 3000 kbit | 96 kbit/s | 1596 kbit/s |
| `v2` | 1920×1080 | 3000 kbit/s | 3300 kbit/s | 6000 kbit | 96 kbit/s | 3096 kbit/s |

These are encoder targets, **not** the final Master Playlist `BANDWIDTH` values. The package validator computes final peak and average rates from the completed segments, then writes or verifies the canonical master playlist according to RFC 8216 semantics.[1]

### 4.3 Exact packaging command template

The source contract requires 1920×1080 progressive video, one audio track, 30 fps or convertible to 30 fps, and at least 65 seconds of content. `$OUT` must be empty.

```bash
ffmpeg -hide_banner -y -i "$INPUT" \
  -filter_complex \
  "[0:v:0]fps=30,split=3[v0in][v1in][v2in];\
   [v0in]scale=640:360:flags=lanczos,setsar=1[v0];\
   [v1in]scale=1280:720:flags=lanczos,setsar=1[v1];\
   [v2in]scale=1920:1080:flags=lanczos,setsar=1[v2]" \
  -map "[v0]" -map 0:a:0 \
  -map "[v1]" -map 0:a:0 \
  -map "[v2]" -map 0:a:0 \
  -c:v libx264 -preset slow -pix_fmt yuv420p -profile:v high \
  -b:v:0 500k  -maxrate:v:0 550k  -bufsize:v:0 1000k \
  -b:v:1 1500k -maxrate:v:1 1650k -bufsize:v:1 3000k \
  -b:v:2 3000k -maxrate:v:2 3300k -bufsize:v:2 6000k \
  -g:v 60 -keyint_min:v 60 -sc_threshold:v 0 -flags:v +cgop \
  -force_key_frames:v "expr:gte(t,n_forced*2)" -threads:v 1 \
  -c:a aac -b:a 96k -ar 48000 -ac 2 \
  -map_metadata -1 -map_chapters -1 \
  -f hls -hls_segment_type mpegts -hls_time 2 -hls_list_size 0 \
  -hls_playlist_type vod -hls_flags independent_segments \
  -master_pl_name master.generated.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  -hls_segment_filename "$OUT/v%v/seg_%05d.ts" \
  "$OUT/v%v/index.m3u8"
```

Derived value: two seconds × 30 frames/s gives a 60-frame GOP. Both fixed GOP controls and periodic forced keyframes are included; the validator, not the command line, is the final proof of alignment.

### 4.4 Master Playlist contract

The canonical `master.m3u8` must contain:

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=<measured-peak>,AVERAGE-BANDWIDTH=<measured-average>,CODECS="<ffprobe-derived>",RESOLUTION=640x360,FRAME-RATE=30.000
v0/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=<measured-peak>,AVERAGE-BANDWIDTH=<measured-average>,CODECS="<ffprobe-derived>",RESOLUTION=1280x720,FRAME-RATE=30.000
v1/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=<measured-peak>,AVERAGE-BANDWIDTH=<measured-average>,CODECS="<ffprobe-derived>",RESOLUTION=1920x1080,FRAME-RATE=30.000
v2/index.m3u8
```

Rules:

- order is always low → medium → high;
- URI paths are relative and use `/` separators;
- `BANDWIDTH = ceil(max(segment_file_bytes × 8 / EXTINF_seconds))` for the muxed TS variant;
- `AVERAGE-BANDWIDTH = ceil(sum(segment_file_bytes × 8) / sum(EXTINF_seconds))`;
- `CODECS` comes from encoded output inspection, never a copied constant;
- no query strings or run IDs are stored in the immutable package; the server maps it under a run-specific path.

### 4.5 Media Playlist contract

Each `vN/index.m3u8` must contain one complete VOD sequence:

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:<ceil(max EXTINF)>
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:<duration>,
seg_00000.ts
...
#EXT-X-ENDLIST
```

All three playlists must have the same segment count. Corresponding segment start PTS values must differ by at most one frame (`1/30 s`), and corresponding `EXTINF` durations must differ by at most one frame. Every segment's first decoded video frame must be a key frame.

### 4.6 Package manifest

`media/package.json` is generated only after validation and contains:

```json
{
  "schemaVersion": "1.0.0",
  "assetId": "campus-65s-v1",
  "sourceSha256": "<64 lowercase hex>",
  "ffmpegVersion": "<full first version line>",
  "ffmpegCommandSha256": "<64 lowercase hex>",
  "masterSha256": "<64 lowercase hex>",
  "durationSeconds": 65.0,
  "segmentDurationSeconds": 2,
  "frameRate": "30/1",
  "renditions": [
    {"id":"v0","width":640,"height":360,"playlist":"v0/index.m3u8"},
    {"id":"v1","width":1280,"height":720,"playlist":"v1/index.m3u8"},
    {"id":"v2","width":1920,"height":1080,"playlist":"v2/index.m3u8"}
  ],
  "files": {"relative/path":"sha256"}
}
```

## 5. Deterministic scenario model

### 5.1 Scenario clock

The authoritative scenario clock is the server's monotonic clock, with `t = 0` fixed once by the first successful `POST /api/v1/runs/{runId}/start`. A repeated start request is idempotent and does not reset it. A phase interval is half-open: `startMs <= t < endMs`. The final phase has no `endMs` and continues until run termination.

Wall-clock ISO timestamps are recorded for human correlation; they do not drive phase transitions.

### 5.2 Primary scenario

`step-down-up-v1`:

| Phase | Interval | Aggregate media rate | Purpose |
|---|---:|---:|---|
| `high` | 0–15 s | 6000 kbit/s | permit top level and fill buffer |
| `low` | 15–30 s | 700 kbit/s | force down-switch and possibly stall |
| `medium` | 30–45 s | 1800 kbit/s | permit recovery near middle level |
| `high-return` | 45 s onward | 6000 kbit/s | observe up-switch behavior |

All phases use a fixed 20 ms response-start delay. No random loss, jitter, or latency change is added; bandwidth is the only manipulated network variable.

Control scenarios:

- `constant-high-v1`: 6000 kbit/s forever;
- `constant-low-v1`: 700 kbit/s forever.

### 5.3 Shaping scope and scheduling semantics

**Recommendation:** Implement application-layer goodput shaping, not packet-level network emulation.

For every run, one shared scheduler governs the aggregate bytes of all eligible media responses. It must not allocate the configured rate separately to each response, because parallel range/segment requests would then exceed the experimental rate.

Exact semantics:

1. Eligible work is the response body of a successful media `GET` under `/stream/v1/{runId}/...`.
2. Each request becomes eligible for first body byte at `requestAcceptedMono + responseStartDelayMs`.
3. The run scheduler is work-conserving FIFO across eligible responses. One request may be active at a time; aborted requests are removed without refunding bytes already written.
4. `rate(t)` is taken from the authoritative phase schedule in decimal bit/s.
5. The scheduler maintains a continuously refilled token bucket shared by the run: `tokens += elapsedSeconds × rate(t)/8`, integrated across phase boundaries, capped at `maxBurstBytes = 16384`, initialized at `0`.
6. A write may contain at most `maxChunkBytes = 4096` and no more than `floor(tokens)`; written bytes are immediately deducted.
7. When Node's `response.write()` returns `false`, scheduling pauses until `drain`.[13]
8. Timers only request wake-ups. Every wake-up recomputes tokens from actual monotonic elapsed time because Node does not promise exact timer execution.[14]
9. The server logs configured phase, planned wake time, actual write time, bytes written, cumulative bytes, and backpressure waits. The claim is reproducible schedule semantics with measured tolerance—not exact packet timing.
10. A run permits one browser client but any number of its HTTP requests. A second player session using the same run ID is rejected with `409 RUN_ALREADY_CLAIMED`.

### 5.4 Server request log schema

Every media request produces one terminal NDJSON record:

```json
{
  "schemaVersion": "1.0.0",
  "runId": "r_<uuidv7>",
  "requestSeq": 12,
  "method": "GET",
  "path": "v1/seg_00007.ts",
  "range": null,
  "status": 200,
  "phaseAtAccept": "low",
  "acceptedAtRunMs": 17124.42,
  "firstByteAtRunMs": 17146.03,
  "lastByteAtRunMs": 19388.66,
  "representationBytes": 149321,
  "bodyBytesWritten": 149321,
  "aborted": false,
  "backpressureWaitMs": 0.0
}
```

`bodyBytesWritten` is the application-visible write count and must not be labeled TCP goodput or wire throughput.

## 6. HTTP behavior

### 6.1 Run-specific URLs and caching

Immutable package files are exposed as unique run paths:

```text
/stream/v1/{runId}/master.m3u8
/stream/v1/{runId}/v0/index.m3u8
/stream/v1/{runId}/v0/seg_00000.ts
```

The server rewrites playlist URIs into this namespace or resolves relative URIs beneath it. It must normalize/decode once, reject `..`, encoded separators, NUL, absolute paths, and symlink escape, then resolve only against the validated package root.

Response headers for every experimental HLS object:

```http
Cache-Control: no-store
X-Content-Type-Options: nosniff
X-Run-Id: <runId>
```

In addition, automation calls `page.setCacheEnabled(false)` and uses a fresh browser context.[21] The unique URL, response directive, and browser setting are intentionally redundant.

### 6.2 MIME types

| Extension | `Content-Type` | Shaped? |
|---|---|---|
| `.m3u8` | `application/vnd.apple.mpegurl; charset=utf-8` | No |
| `.ts` | `video/mp2t` | Yes for GET body |
| `.m4s` | `video/iso.segment` | Yes if profile later enables it |
| init `.mp4` | `video/mp4` | Yes if profile later enables it |
| `.json` | `application/json; charset=utf-8` | No |
| `.js` | `text/javascript; charset=utf-8` | No |
| `.css` | `text/css; charset=utf-8` | No |

Playlists may use gzip content encoding when the client accepts it; media segments must not be dynamically compressed. Playlist bytes are outside the shaped budget.

### 6.3 Range and HEAD contract

- `HEAD` returns the same selected-representation headers as `GET`, with no body and no shaping charge.
- No `Range`: `200`, full `Content-Length`, `Accept-Ranges: bytes`.
- One satisfiable byte range: `206`, exact `Content-Range: bytes start-end/size`, exact range `Content-Length`, same media type, and only the selected bytes pass through the shaper.
- Unsatisfiable range: `416`, `Content-Range: bytes */size`, JSON or empty error body, unshaped.
- Malformed or multiple ranges: `400 RANGE_UNSUPPORTED`; this project intentionally supports exactly one byte range.
- `If-Range` is not supported in v1; a request containing it receives `400 IF_RANGE_UNSUPPORTED` rather than ambiguous behavior.

### 6.4 CORS

Default deployment is same-origin and needs no CORS permission. Optional development CORS is explicit, never reflective:

```http
Access-Control-Allow-Origin: http://127.0.0.1:8080
Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, X-Run-Id, X-Scenario-Phase
```

Media identity is in the URL, not a custom request header, so media GETs remain simple. Credentials are disabled. If origins are split later, update the allowlist contract and integration tests before code changes.

## 7. Run lifecycle and IDs

### 7.1 Run ID

Format: `r_<lowercase UUIDv7>`, for example `r_017f22e2-79b0-7cc3-98c4-dc0c0c07398f`.

The ID is an opaque identifier; scenario, repetition, or participant meaning must never be parsed from it. The server generates it. Uniqueness is enforced by atomic run-directory creation.

### 7.2 State machine

```text
CREATED ──start──► RUNNING ──finish──► FINALIZING ──atomic close──► COMPLETED
   │                   │                     └────────────────────► FAILED
   └────abort──────────┴──────────────────────────────────────────► ABORTED
```

- `CREATED`: immutable config/scenario/package digests captured; no stream allowed.
- `RUNNING`: clock fixed, stream enabled, logs append-only.
- `FINALIZING`: no new media requests; flush and validate event/request logs.
- `COMPLETED`: all required artifacts closed and summary generated.
- `FAILED`: fatal player/server/validation error, with reason retained.
- `ABORTED`: explicit operator/runner cancellation.

Transitions are server-owned, persisted atomically, and idempotent. A process restart reads state; it never invents a new `t0` for a previously started run.

### 7.3 Lifecycle sequence

1. Runner performs preflight: config/schema validity, package hashes, port availability, Chrome path/version, Node/FFmpeg versions, and no stale server.
2. Runner creates a fresh browser context and disables cache/service workers.
3. `POST /api/v1/runs` captures all digests and creates `CREATED`.
4. Player page loads unshaped, constructs `new Hls({startLevel: -1, capLevelToPlayerSize: false, debug: false})`, attaches it to the `<video>` element, waits for `MEDIA_ATTACHED`, and reports `client.ready`. No other hls.js configuration override is allowed in contract `1.0.0`.
5. Only after `MEDIA_ATTACHED`, player calls `start`; server atomically fixes run `t0`; player immediately calls `loadSource()` with the returned master URL. After `MANIFEST_PARSED`, it issues the muted `video.play()` request.
6. Player emits ordered telemetry; server independently logs all HLS requests and shaping writes.
7. Run stops on media `ended`, fatal error, explicit abort, or `maxWallDurationMs`.
8. Player flushes telemetry and posts `finish`; server finalizes logs and run metadata.
9. Member 3 analysis reads only `COMPLETED` runs and writes a separate derived summary.

## 8. HTTP API contract

The normative machine contract is `contracts/openapi.yaml`. The required behavior is summarized here.

### 8.1 Create run

`POST /api/v1/runs`

```json
{
  "requestId": "7b135560-1dd2-4a16-9b8f-3fc8191ec0ea",
  "experimentId": "abr-hls-v1",
  "scenarioId": "step-down-up-v1",
  "repetition": 1,
  "orderSeed": 20261109,
  "clientLabel": "chrome-local"
}
```

- `201` for first creation; `200` with the same run for a retry of the same `requestId` and identical body.
- Reusing `requestId` with a different body returns `409 IDEMPOTENCY_CONFLICT`.

### 8.2 Start run

`POST /api/v1/runs/{runId}/start`

Request includes client clock-send sample:

```json
{"clientSendEpochMs": 1794196800123.25, "clientSendMonoMs": 122.40}
```

Response:

```json
{
  "runId": "r_<uuidv7>",
  "status": "RUNNING",
  "hlsUrl": "/stream/v1/r_<uuidv7>/master.m3u8",
  "serverRunStartEpochMs": 1794196800124,
  "serverReceiveEpochMs": 1794196800124,
  "serverSendEpochMs": 1794196800125,
  "scenarioId": "step-down-up-v1",
  "scenarioSha256": "<64 lowercase hex>"
}
```

The browser records receive epoch/monotonic times and RTT. The analysis uses server run-relative timestamps for phase truth and browser monotonic timestamps for player ordering; wall-clock correlation is descriptive, not assumed exact.

### 8.3 Append telemetry

`POST /api/v1/runs/{runId}/events`

```json
{"events":[/* 1..200 telemetry-event objects */]}
```

- Event identity is `(runId, source, seq)`.
- Server accepts replayed batches, stores each identity once, and reports duplicate count.
- Gaps are accepted during running but become a finalization warning.
- Maximum request body is 1 MiB.
- `202` response: `{"accepted":42,"duplicates":0,"highestSeqBySource":{"player":41}}`.

### 8.4 Finish or abort

`POST /api/v1/runs/{runId}/finish`

```json
{
  "reason": "ended",
  "lastSeq": 481,
  "clientSummary": {
    "startupDelayMs": 820.3,
    "rebufferCount": 2,
    "rebufferDurationMs": 3110.4,
    "droppedVideoFrames": 4,
    "totalVideoFrames": 1881
  }
}
```

The server recomputes authoritative summary values from stored events; client summary is a cross-check. Mismatch is a warning/failure under configured tolerance, never silently accepted.

`POST /api/v1/runs/{runId}/abort` takes `{"reason":"operator_cancelled"}`.

## 9. Telemetry event contract

The normative schema is `contracts/schemas/telemetry-event.schema.json`.

### 9.1 Envelope

```json
{
  "schemaVersion": "1.0.0",
  "runId": "r_<uuidv7>",
  "source": "player",
  "seq": 37,
  "type": "hls.level_switched",
  "clientMonoMs": 18344.57,
  "clientEpochMs": 1794196818468.6,
  "mediaTimeSec": 16.043,
  "data": {"level": 0, "width": 640, "height": 360, "bitrateBps": 596000}
}
```

Rules:

- `seq` starts at `0` per source and increases by one; retries keep the same sequence.
- `clientMonoMs = performance.now() - clientRunOriginMono`; it controls event ordering.[25]
- `clientEpochMs = performance.timeOrigin + performance.now()` is for correlation only.
- `mediaTimeSec` is included whenever media metadata exists.
- Unknown event types are rejected under schema `1.0.0`; schema evolution requires a version bump.
- `NaN` and `Infinity` are not JSON. Missing hls.js bandwidth estimates are represented as `null`.

### 9.2 Required event types

| Type | Required data |
|---|---|
| `client.ready` | user agent, viewport, hls.js version |
| `media.play_requested` | muted, autoplay |
| `media.playing` | readyState, forwardBufferSec |
| `media.waiting` | readyState, forwardBufferSec |
| `media.pause` | reason (`user`, `ended`, `unknown`) |
| `media.ended` | durationSec |
| `media.error` | media error code/message |
| `media.sample` | currentTime, readyState, forwardBufferSec, paused, playbackRate |
| `hls.manifest_parsed` | normalized level array |
| `hls.level_switching` | requested level and level metadata |
| `hls.level_switched` | effective level and level metadata |
| `hls.frag_loading` | level, sn, startSec, durationSec, URL path |
| `hls.frag_loaded` | level, sn, bytes, loadStart/firstByte/end relative timing |
| `hls.frag_buffered` | level, sn, bytes, bandwidthEstimateBps or null |
| `hls.error` | fatal, type, details, HTTP status if available |
| `client.finished` | reason and final playback-quality counters |

Never serialize the complete hls.js event object: it can contain unstable, circular, private, or version-specific fields. Normalize only the listed fields at the player boundary.

Normalization rules:

- For `LEVEL_SWITCHING`/`LEVEL_SWITCHED`, take the effective index from `data.level`, then copy width, height, bitrate, average bitrate, and codecs from `hls.levels[data.level]` at capture time.
- For fragment events, store only main media fragments with integer `sn`; ignore init, audio-only, subtitle, and part events in contract `1.0.0`.
- `bytes` is the normalized loaded-body byte count. `loadStartMs`, `firstByteMs`, and `loadEndMs` are converted to the client run-relative monotonic clock before serialization.
- Capture `hls.bandwidthEstimate` at `FRAG_BUFFERED`; serialize `null` when it is not finite.
- Strip origin/query data from fragment URLs and keep only the run-scoped path.

Telemetry transport is serial and nonblocking: enqueue events synchronously, POST a batch at 50 events or 250 ms (whichever comes first), permit only one batch in flight, and retry the identical batch with unchanged `seq` values. Before `finish`, drain the queue and obtain a successful `202`; if flushing cannot complete within 5 seconds, finish as `fatal_error`/`telemetry_flush_failed` rather than claiming a complete run.

### 9.3 Forward buffer calculation

At a sample time, find the buffered range satisfying `start <= currentTime < end`; `forwardBufferSec = max(0, end - currentTime)`. If none exists, it is `0`. Store all normalized ranges only when debugging; the primary stream stores the scalar.

### 9.4 Stall state machine

```text
BEFORE_FIRST_PLAY
  media.playing -> PLAYING (startup delay closes)
PLAYING
  media.waiting and !paused and !seeking and !ended -> REBUFFERING
REBUFFERING
  media.playing -> PLAYING (one stall closes)
  media.ended/error -> close as censored, do not count as completed stall
```

Duplicate `waiting` events while already rebuffering do not create new stalls. `stalled` is logged diagnostically but is not a primary stall boundary because its browser meaning differs from playback waiting.[11][29]

## 10. File and module boundaries

```text
adaptive-hls-experiment/
├── README.md
├── docs/
│   └── architecture.md                    # this normative prose
├── contracts/                             # frozen before parallel implementation
│   ├── openapi.yaml
│   └── schemas/
│       ├── experiment-config.schema.json
│       ├── scenario.schema.json
│       └── telemetry-event.schema.json
├── configs/
│   ├── experiment.v1.json
│   └── scenarios/
│       ├── constant-high.v1.json
│       ├── constant-low.v1.json
│       └── step-down-up.v1.json
├── assets/
│   ├── source/                            # source or fetch manifest + checksum
│   └── fixtures/                          # tiny deterministic test asset
├── media/                                 # generated immutable HLS package
│   ├── package.json
│   ├── master.m3u8
│   └── v0|v1|v2/
├── packages/
│   ├── media-cli/                         # Member 1: package + validate
│   ├── shaper-server/                     # Member 1: HTTP + lifecycle + logs
│   ├── contracts/                         # generated types/validators only
│   ├── runner/                            # Member 3: Chrome orchestration
│   └── analysis/                          # Member 3: metrics/charts
├── apps/
│   └── player/                            # Member 2: hls.js + telemetry producer
├── tests/
│   ├── contract/
│   ├── integration/
│   └── e2e/
└── runs/                                  # ignored; one immutable directory/run
    └── r_<uuidv7>/
        ├── run.json
        ├── client-events.ndjson
        ├── server-requests.ndjson
        ├── scheduler-writes.ndjson
        ├── summary.json
        └── charts/
```

### 10.1 Ownership rules

**Member 1 — Media + Networking**

- may write `packages/media-cli`, `packages/shaper-server`, `media`, and server tests;
- must not interpret player stalls or change telemetry fields;
- publishes only validated `package.json`, stream URLs, API responses, and server NDJSON.

**Member 2 — Player + Adaptation**

- may write `apps/player` and player tests;
- must use hls.js automatic ABR and normalize events to the shared schema;
- must not alter scenario timing, inject throttling, or compute authoritative final evidence.

**Member 3 — Evidence + Presentation**

- may write `packages/runner`, `packages/analysis`, run orchestration, charts, and slides;
- treats raw logs as append-only inputs;
- must not change encoder/server/player behavior to make graphs look cleaner.

**Shared contracts**

- changes require review by all three members;
- schemas and OpenAPI are versioned and `additionalProperties: false` where practical;
- generated TypeScript types are build artifacts; the JSON Schema/OpenAPI files are authoritative.

## 11. Configuration contracts

### 11.1 Experiment configuration

`experiment.v1.json` selects exactly one asset package, player profile, scenario set, repetition count, run order seed, and stop policy. It contains IDs and hashes, not duplicated scenario phase arrays.

Important invariants beyond JSON Schema:

- every referenced ID resolves to exactly one local file;
- every referenced SHA-256 matches canonical bytes;
- player hls.js version equals the lockfile version;
- `repetitionsPerScenario >= 5` for the final dataset;
- `maxWallDurationMs` exceeds media duration plus a declared stall allowance;
- viewport and Chrome executable are constant across compared runs.

### 11.2 Scenario configuration

`scenario.schema.json` enforces field types. Semantic validation additionally requires:

- first phase starts at `0`;
- phase IDs are unique;
- finite phases are strictly contiguous with no overlap/gap;
- only the final phase omits `endMs`;
- all rates are positive integers;
- scenario JSON is canonicalized before SHA-256 (UTF-8, sorted keys, no insignificant whitespace).

## 12. Integration-test plan

### 12.1 Contract tests (fast, every change)

1. Every JSON example validates against Draft 2020-12 schemas.
2. OpenAPI parses and every documented response has a schema.
3. Run ID regex accepts UUIDv7 only.
4. Telemetry rejects unknown fields/types, `NaN`, negative clocks, wrong event payloads, and sequence values below zero.
5. Scenario semantic validator rejects gaps, overlaps, nonzero first phase, or a non-final infinite phase.

### 12.2 Media-package tests

1. Master has exactly three variants in low-to-high order and required attributes.
2. All media playlists are VOD, start at sequence zero, end with `ENDLIST`, and have equal segment counts.
3. `TARGETDURATION == ceil(max EXTINF)` for each playlist.
4. Resolutions, frame rate, AVC/AAC codecs, channel count, and sample rate match the package manifest.
5. Corresponding start PTS and durations align within `1/30 s`.
6. The first video frame of every TS segment is key/IDR.
7. Recomputed peak/average rates equal Master Playlist attributes.
8. Every file SHA-256 matches `media/package.json`.

### 12.3 HTTP tests

1. Correct MIME, `nosniff`, no-store, and run headers for each object.
2. Full GET, HEAD, open-ended range, bounded range, suffix range, unsatisfiable range, malformed range, and multiple-range behavior.
3. Exact byte equality between selected range and package file.
4. Traversal probes (`..`, `%2e%2e`, encoded slash, NUL, absolute path, symlink) fail outside the root.
5. Optional CORS preflight and exposed headers match the allowlist.
6. APIs and playlists remain unshaped.

### 12.4 Shaper tests

Use a generated 1 MiB fixture and the server's own timestamps:

1. Constant-rate single GET achieves configured body duration within ±5% after excluding fixed response-start delay and timer warm-up.
2. Two concurrent GETs share one aggregate budget; their combined bytes never receive two independent rate allocations.
3. A step schedule crosses at the configured server monotonic time, not at a request boundary.
4. Initial token count is zero; burst never exceeds 16 KiB.
5. Backpressure pauses writes and resumes only on `drain`.
6. Aborted request closes cleanly and later requests continue with the same run clock.
7. Restart does not reset a persisted RUNNING run; policy marks it FAILED if exact scheduler restoration is not supported.

### 12.5 Player tests

1. Uses bundled/pinned hls.js `1.7.4`, not network CDN code.
2. Loads the returned run-specific master and reports exactly three normalized levels.
3. Emits `LEVEL_SWITCHED` with `data.level` and matching level metadata.
4. Emits 500 ms samples without blocking playback.
5. Stall state machine ignores startup, pause, seek, duplicate waiting, and terminal events correctly.
6. Fatal hls.js/media errors finish the run as failed and preserve logs.
7. Final playback-quality counters are present.

### 12.6 End-to-end acceptance test

For each scenario, execute one short fixture run in a fresh browser context:

- `constant-high-v1`: completes without fatal error and can reach `v2`;
- `constant-low-v1`: does not remain at `v2` throughout;
- `step-down-up-v1`: records server phase transitions and at least one effective level change under a sufficiently complex fixture.

Do not assert exact switch timestamps or exact stall counts in CI; hls.js/browser scheduling can change while the interface remains correct. Assert invariants, valid logs, and qualitative direction. Final experimental results come from pinned environment runs with repetitions.

## 13. Run artifacts and analysis contract

`run.json` must include:

- run ID/status/reason and create/start/finish times;
- exact experiment/scenario/package SHA-256 values;
- Git commit and dirty flag;
- Node, FFmpeg, hls.js, Chrome, OS, CPU architecture versions;
- browser user agent, viewport, cache/service-worker settings;
- start clock-sync samples and RTT;
- API/schema versions;
- artifact filenames and SHA-256 values after finalization.

Raw `.ndjson` files are append-only. `summary.json`, CSV, and charts are derived and may be regenerated. A chart must name the run IDs, scenario hash, number of repetitions, aggregation method, and uncertainty display.

Recommended final plots:

1. server configured rate, achieved media goodput, selected level, and forward buffer over time for one representative run;
2. rebuffer duration/count by scenario across repetitions;
3. quality occupancy stacked bars by scenario;
4. startup delay and dropped-frame sanity checks.

## 14. Risks and mitigations

| Risk | Consequence | Mitigation / evidence |
|---|---|---|
| Misaligned segments/keyframes | switch failures or hidden decode discontinuity | one FFmpeg invocation; fixed GOP; forced keys; ffprobe validation on every segment |
| Inaccurate Master bandwidth | hls.js chooses inappropriate levels | derive peak/average from final VOD segments; verify master before runs |
| Per-response throttles | aggregate bandwidth multiplies with concurrency | one run-level shared scheduler and parallel-request integration test |
| Event-loop/TCP buffering | configured rate differs from observed | 4 KiB writes, 16 KiB burst cap, backpressure, actual write logs, ±5% calibration; describe as app-layer shaping |
| Browser cache | second run appears faster | unique run URLs + `no-store` + fresh context + cache disabled |
| Telemetry perturbs media | invalid independent variable | unshaped control plane; batched small telemetry posts |
| CORS/range mismatch | opaque player failures | same-origin default; exact headers; HTTP matrix tests |
| Autoplay policy | startup never begins | muted automation; explicit play request/event and timeout |
| `waiting` misclassification | false stall counts | state machine excludes startup/pause/seek/end; pair with `playing` and sample buffer |
| Wall-clock drift | wrong phase overlay | server monotonic phase truth; player monotonic event order; handshake only for correlation |
| Version drift | irreproducible ABR | exact lockfile, local bundle, Chrome path/build and all versions in run manifest |
| FFmpeg cross-platform drift | different segments/bitrates | package once, hash every artifact; repackage only in pinned environment and revalidate |
| Source too simple | ABR results uninformative | choose motion/texture-rich source; retain immutable fixture and checksum |
| Overfitting one run | misleading conclusion | at least five repetitions, seeded randomized order, report all runs and uncertainty |
| User-space shaper mistaken for real network | overstated conclusions | explicitly scope claim to local application-layer downstream goodput; use Puppeteer shaping only as separate sensitivity check |
| Run crash/partial logs | silent biased dataset | lifecycle states; atomic finalize; analyze `COMPLETED` only; report failed/aborted counts |
| Contract drift across members | modules compile but disagree at runtime | freeze schemas/OpenAPI first; generated types; provider and consumer contract tests in CI |

## 15. Implementation order and interface freeze

1. All members review this document, schemas, scenario examples, and OpenAPI.
2. Freeze contract version `1.0.0` and tag it before module implementation.
3. Member 1 produces a validated fixture package and mock API responses.
4. Member 2 develops against fixture HLS and recorded API/event examples.
5. Member 3 develops runner/analysis against synthetic valid NDJSON fixtures.
6. Integrate through contract tests before a live end-to-end run.
7. Calibrate shaper, execute pilot repetitions, freeze environment, then collect the final dataset.

A module is integration-ready only when it passes both its own tests and the shared provider/consumer contract tests. No module may depend on another module's private classes or file internals; integration occurs only through validated files, HTTP, and the event schemas.

## Sources

[1] https://datatracker.ietf.org/doc/html/rfc8216
[2] https://www.ffmpeg.org/ffmpeg-formats.html
[3] https://ffmpeg.org/ffmpeg-doc.html
[4] https://www.ffmpeg.org/ffprobe.html
[5] https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices
[6] https://iana.org/assignments/media-types/application/vnd.apple.mpegurl
[7] https://hlsjs.video-dev.org/api-docs/hls.js.events
[8] https://hlsjs.video-dev.org/api-docs/hls.js.hls
[9] https://npmjs.com/package/hls.js
[10] https://github.com/video-dev/hls.js/blob/v1.7.4/README.md
[11] https://html.spec.whatwg.org/multipage/media.html
[12] https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality
[13] https://nodejs.org/api/stream.html
[14] https://nodejs.org/api/timers.html
[16] https://datatracker.ietf.org/doc/html/rfc9110
[17] https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
[18] https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range
[19] https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
[20] https://pptr.dev/api/puppeteer.page.emulatenetworkconditions
[21] https://pptr.dev/api/puppeteer.page.setcacheenabled
[22] https://json-schema.org/draft/2020-12
[23] https://datatracker.ietf.org/doc/rfc9562
[24] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement
[25] https://developer.mozilla.org/en-US/docs/Web/API/Performance
[26] https://hlsjs.video-dev.org/api-docs/hls.js.fragbuffereddata.html
[27] https://hlsjs.video-dev.org/api-docs/hls.js.fragment
[28] https://hlsjs.video-dev.org/api-docs/hls.js.level
[29] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/waiting_event
[30] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/buffered
