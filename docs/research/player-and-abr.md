# Browser player and ABR design (hls.js 1.7.4)

## Decision summary

- Pin **`hls.js` exactly to `1.7.4`** (`"hls.js": "1.7.4"`, not `^1.7.4`) and commit the lockfile. Record `Hls.version` and the Chrome version in every run. The research below was checked against tag `v1.7.4` / commit `142fcab1fd0de99beafb0e1b07102ec674a9ddf9`; the unversioned API site follows the current release and can drift.[21]
- Implement two player modes behind one interface:
  1. `default-hlsjs`: untouched hls.js automatic ABR.
  2. `conservative-v1`: application-owned, fragment-boundary policy using only public events, public level properties, `HTMLMediaElement`, and the public `hls.loadLevel` setter.
- Do **not** read `hls.abrController`, `bwEstimator`, `_stats`, stream-controller fields, or other private/protected internals. Do not replace hls.js's `abrController` for this project; that couples the project to an internal controller contract.
- Use `FRAG_BUFFERED` for completed main-fragment load statistics, `MANIFEST_PARSED` for the ladder, `LEVEL_SWITCHING`/`LEVEL_SWITCHED` for requested/effective quality, `ERROR` for diagnostics, and standard media `waiting`/`playing` plus `video.buffered` for QoE stalls and buffer health.

## Public API/event map

| Need | Preferred public surface | What to record | Reliability notes |
|---|---|---|---|
| Rendition ladder | `Hls.Events.MANIFEST_PARSED`; `data.levels` or `hls.levels` | hls index, `bitrate`, `averageBitrate`, `width`, `height`, `frameRate`, codecs/name | `Hls.levels` is a public getter. In 1.7.4 hls.js documents the returned list as sorted by HDCP level, resolution, frame rate, codecs, video range, and bandwidth; do not assume the original playlist order.[1][4][6] |
| Ladder changes | `Hls.Events.LEVELS_UPDATED` | replace the index-to-level snapshot | Mostly relevant if hls.js removes an unsupported/erroring level. Never retain stale indices.[2][7] |
| Requested/loading quality | `Hls.Events.LEVEL_SWITCHING` | `data.level`, bitrate fields, dimensions | Payload includes `bitrate`, `averageBitrate`, `maxBitrate`, `realBitrate`, dimensions and codecs in 1.7.4.[7][25] |
| Effective playback quality | `Hls.Events.LEVEL_SWITCHED` | `data.level` and timestamp/media time | This is the quality actually switched into playback; prefer it over `LEVEL_SWITCHING` for switch/QoE reporting.[2][13] |
| Fragment request completion | `Hls.Events.FRAG_LOADED` | fragment id/level/sn and payload size if needed | The 1.7.4 `FragLoadedData` payload has `frag`, `part`, `payload`, and `networkDetails`—**not a top-level `stats` field**. Stats are reachable as `data.frag.stats`, but `FRAG_BUFFERED` is a cleaner typed surface.[7][22][23] |
| Fragment successfully appended | `Hls.Events.FRAG_BUFFERED` | `data.stats`, `data.frag`, `data.part`, `data.id` | Preferred ABR decision trigger. The public payload directly carries `LoadStats` after a fragment has been buffered.[3][7] |
| Bytes/timing | `data.stats.loaded`, `.total`, `.retry`, `.aborted`, `.loading.{start,first,end}`, `.parsing`, `.buffering` | bytes, total request ms, TTFB ms, transfer ms, retry/abort | `LoaderStats` is public and typed. Timestamps are `performance.now()`-domain milliseconds. Field semantics are clearer in source than in the generated docs, so pin the version.[5][8] |
| hls.js bandwidth estimate | `hls.bandwidthEstimate` | bps, observability only in custom mode | Public in current 1.7.4. The docs say it returns `NaN` when unavailable, but 1.7.4 source returns the configured default until samples exist; therefore do not use `Number.isFinite()` as a “real sample available” test.[1][6] |
| Forward buffer | Standard `video.buffered` + `video.currentTime`; alternatively public `hls.mainForwardBufferInfo` | seconds in the range containing the playhead | `buffered` is a normalized `TimeRanges` snapshot and is browser-standard. Compute the range containing the playhead; subtracting `currentTime` from the final range end can cross a hole and overstate safety.[15] |
| Playback stall start/end | `video` `waiting` / `playing` | episode id, start/end, duration, buffer, quality | `waiting` specifically means playback stopped for temporary lack of data. Gate out startup, pause, seek and ended states. Close on `playing`; also close at `ended` or seek cancellation.[16] |
| Network fetch stalled | `video` `stalled` | diagnostic event only | `stalled` means the user agent is trying to fetch and data is unexpectedly not forthcoming; it is not equivalent to a measured playback rebuffer.[17] |
| hls.js stall signal | `Hls.Events.ERROR` with `data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR` | type, details, fatal, reason, buffer fields | Useful corroboration/emergency input, but may cover holes/nudges and should not be the only QoE stall counter. `ErrorData` fields are public but many are optional.[14][24] |
| hls.js stall recovery | `Hls.Events.STALL_RESOLVED` | diagnostic end marker | Public in 1.7.4, but relatively recent/version-specific. Keep `playing` as the portable primary close signal.[13] |
| Errors | `Hls.Events.ERROR` | `type`, `details`, `fatal`, `error.message`, optional response/status, frag, level, stats | Branch on enums, not strings. Log all events. Fatal recovery remains a player-adapter concern, not an ABR calculation.[14][24] |
| Automatic ceiling | `hls.autoLevelCapping = index`, reset with `-1` | cap and reason | Safe public way to limit default ABR while keeping automatic selection; not suitable as the sole actuator for a clean custom-vs-default comparison because default ABR still chooses below the cap.[1][6] |
| Fully manual, conservative selection | `hls.loadLevel = index`, `-1` returns to auto | desired level and reason | Public setter. It switches without flushing already buffered media, though it may interrupt an active load. Call after `FRAG_BUFFERED` whenever possible.[6] |
| Faster manual selection | `hls.nextLevel = index` | only for deliberate ASAP UI selection | May abort a request and flush buffer outside the playing fragment. Avoid for the conservative policy.[6] |
| Immediate manual selection | `hls.currentLevel = index` | only for an explicit destructive demo/control | Flushes the current buffer and can cause interruption. Do not use in ABR.[6] |
| Non-destructive next segment | `hls.nextLoadLevel = index` | optional one-load experiment | Public, but in auto mode it interacts with hls.js `nextAutoLevel`; it is not as clean as manual `loadLevel` for an independent policy.[6] |
| Manual/auto verification | `hls.autoLevelEnabled`, `hls.manualLevel` | assertion in run metadata | In custom mode assert `autoLevelEnabled === false` and `manualLevel >= 0`; in default mode assert the inverse.[1][6] |

### Throughput sample

Use only completed, non-init, main media fragments:

```ts
function sampleGoodputBps(stats: LoaderStats): number | null {
  const elapsedMs = stats.loading.end - stats.loading.start;
  if (stats.aborted || stats.loaded <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < 50) {
    return null;
  }
  return (8 * stats.loaded * 1000) / elapsedMs;
}
```

This deliberately measures **request goodput**, including TTFB, rather than an idealized transfer-only rate. That is conservative and easy to explain: bytes successfully obtained divided by the wall-clock time the request occupied. Log these additional values but do not use them as substitutes without changing the algorithm version:

```ts
const ttfbMs = stats.loading.first - stats.loading.start;
const transferMs = stats.loading.end - stats.loading.first;
const transferBps = transferMs >= 50 ? 8 * stats.loaded * 1000 / transferMs : null;
const hlsEstimateBps = hls.bandwidthEstimate;
```

`FRAG_BUFFERED` is preferable to `FRAG_LOADED`: it has direct typed stats, excludes requests that never become usable buffer, and aligns the decision with a segment boundary. hls.js 1.7.4 itself samples only main, non-init fragments, assigns `stats.bwEstimate` in its internal `FRAG_BUFFERED` handler, and bases its sample on request/parsing timing.[10] The custom policy must calculate its own sample rather than rely on `stats.bwEstimate`, because observing that field after hls.js mutates it depends on listener order.

### Correct forward-buffer calculation

```ts
function forwardBufferSeconds(video: HTMLMediaElement, epsilon = 0.05): number {
  const t = video.currentTime;
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (start - epsilon <= t && t <= end + epsilon) {
      return Math.max(0, end - t);
    }
  }
  return 0;
}
```

Also log `video.readyState` (0–4), but do not turn it into a bandwidth estimate. `HAVE_FUTURE_DATA` and `HAVE_ENOUGH_DATA` are browser readiness classifications, not reproducible buffer-duration thresholds.[18]

## What the default hls.js 1.7.4 baseline does

The baseline must be real hls.js ABR, not a reimplementation:

- It maintains fast and slow EWMAs and returns their minimum, so it can move down faster than it moves up.[11]
- The 1.7.4 defaults are fast half-life 3 s, slow half-life 9 s, initial estimate 500 kbit/s, steady/down bandwidth factor 0.95, up-switch factor 0.70, and maximum starvation/loading delay 4 s.[12]
- Selection combines estimated bandwidth with forward-buffer/starvation time, level bitrate/error history, estimated TTFB and segment duration. It can abandon an in-flight fragment when a lower level is predicted to arrive sooner and avert starvation.[10]
- It generally uses a level's peak/max bitrate, but may use average bitrate when at least two fragment durations are buffered and no rebuffer is expected.[9][10]

Baseline construction contract:

```ts
const hls = new Hls({
  // Keep normal 1.7.4 defaults; specify only shared non-ABR settings here.
  startLevel: -1,
  capLevelToPlayerSize: false,
});
// Never write currentLevel, nextLevel, loadLevel, nextLoadLevel,
// nextAutoLevel, bandwidthEstimate, or autoLevelCapping in baseline mode.
```

At run start, serialize the relevant values from `hls.config` so a future library/config change cannot silently alter the baseline. Use a fresh page/session, disable HTTP caching for manifests and segments, and run the exact same media and server trace for both modes.

## Proposed policy: `conservative-throughput-v1`

### Goals

1. Explainable on a whiteboard.
2. React quickly to bandwidth loss.
3. Recover slowly, one rung at a time.
4. Never inspect private hls.js state.
5. Make every decision reproducible from telemetry.

### Inputs and constants

```ts
type PolicyConfig = {
  fastAlpha: 0.50;             // recent response
  slowAlpha: 0.20;             // stable history
  downSafety: 0.85;            // normal eligibility
  upSafety: 0.70;              // stricter upgrade eligibility
  minSampleMs: 50;
  upConfirmFragments: 3;
  minCleanAfterStall: 3;
  minCleanAfterError: 2;
  minFragmentsBetweenUps: 2;
  lowBufferFloorS: 4;
  highBufferFloorS: 8;
};
```

Per decision, inputs are:

- public level ladder (`index`, peak `level.bitrate`, dimensions);
- valid fragment goodput sample;
- fast and slow EWMA estimates;
- forward buffer seconds;
- current desired/manual level and effective playback level;
- last fragment duration, retry/abort status;
- recent `waiting`, hls.js stall and fragment/network-error flags.

Use peak `level.bitrate` (`BANDWIDTH`) for admission. RFC 8216 defines it as the peak segment bit rate and requires it on each variant; `AVERAGE-BANDWIDTH` is optional and inaccurate declarations can cause stalls.[19] For the generated lab ladder, include both tags and verify their measured values; Apple's authoring guidance requires `AVERAGE-BANDWIDTH` and accurate declared/measured bandwidths.[20]

### State update

For each valid fragment sample `x`:

```text
fast = first ? x : 0.50*x + 0.50*fast
slow = first ? x : 0.20*x + 0.80*slow
estimate = min(fast, slow)
```

The minimum provides asymmetric behavior: a sudden drop pulls the fast EWMA down immediately; a rise must pull the slow EWMA up. It is intentionally simpler than hls.js's time-weighted EWMA so students can reproduce a decision from the event log.

Invalid samples (aborted, zero bytes, non-finite timing, under 50 ms, init/audio/subtitle) are logged but do not update the estimator. A retry may update the estimate/downswitch, but it cannot count as positive upgrade evidence.

### Decision cadence

Run the policy:

1. after every successful main media `FRAG_BUFFERED` event;
2. immediately on a qualified `waiting` event;
3. immediately on `BUFFER_STALLED_ERROR`, `FRAG_LOAD_TIMEOUT`, or `FRAG_LOAD_ERROR` affecting the main stream.

No periodic ABR timer is required. UI telemetry may sample player state every 250 ms, but that timer must not make quality decisions.

### Selection algorithm

Define levels in ascending **quality rank**. For this controlled project, the server/encoder contract requires a monotonic ladder (bitrate and resolution increase together, common codec family). Validate this at `MANIFEST_PARSED`. If it fails, abort the custom run with `invalid_ladder` instead of guessing.

1. **Startup:** select the lowest rung. Set custom mode to manual before normal fragment loading (`startLevel: 0` for the controlled monotonic ladder, then `hls.loadLevel = lowestIndex` on `MANIFEST_PARSED`). Do not upgrade until three valid, clean fragment samples exist.
2. **Normal safe set:** `safeDownBps = 0.85 * estimate`. Find the highest rung whose peak bitrate is at most `safeDownBps`; if none fits, choose the lowest.
3. **Immediate downswitch:** switch down by as many rungs as necessary when any is true:
   - current desired rung is above the normal safe set;
   - forward buffer is below `max(4 s, lastFragmentDuration)`;
   - the last fragment retried;
   - a relevant fragment/network error occurred.
   For low-buffer/retry/error cases, use the stricter `0.70 * estimate` safe set. Downswitches have no cooldown.
4. **Stall emergency:** on a qualified `waiting` event or `BUFFER_STALLED_ERROR`, select the lowest rung immediately, clear upgrade evidence, and require three subsequent clean buffered fragments before any upgrade.
5. **Upgrade evidence:** the next rung (only one rung) must satisfy `nextPeakBitrate <= 0.70 * estimate` for three consecutive valid, no-retry samples. Reset the counter on any failed check, retry, error, invalid sample, or downswitch.
6. **Buffer gate:** upgrade only when forward buffer is at least `max(8 s, 2 * lastFragmentDuration)`.
7. **Cooldown:** require at least two clean buffered fragments since the previous upgrade. Upgrade by one rung, then reset the evidence counter.
8. **No change:** retain the current manual level when neither down nor up rules fire.

Actuate with:

```ts
if (targetIndex !== hls.manualLevel) {
  hls.loadLevel = targetIndex;
}
```

At a `FRAG_BUFFERED` callback there normally is no active request to interrupt, which minimizes the documented `loadLevel` side effect. The emergency stall path may interrupt an in-flight load deliberately. Never use `currentLevel` because it flushes buffered media, and do not use `nextLevel` because it can flush/abort as part of an ASAP switch.[6]

Every decision emits the complete arithmetic, including `estimate`, safety factor, resulting budget, candidate level bitrates, buffer gates, evidence count, from/to level and one stable reason code:

- `startup_lowest`
- `hold_no_estimate`
- `hold_safe`
- `down_throughput`
- `down_low_buffer`
- `down_retry_or_error`
- `down_stall_lowest`
- `hold_upgrade_bandwidth`
- `hold_upgrade_buffer`
- `hold_upgrade_evidence`
- `hold_recovery`
- `up_confirmed_one_rung`

## Stall measurement contract

Use one deduplicated application stall episode state machine:

- Open on `video.waiting` only if playback has previously emitted `playing`, and `!paused && !seeking && !ended`.
- Do not count initial startup waiting as rebuffering. Report startup delay separately (`play_requested` to first `playing`).
- Ignore waiting during an explicit user seek; close/cancel any episode on `seeking` and resume eligibility after `seeked`/`playing`.
- Close on `playing`; also close at `ended` and mark the reason.
- A second `waiting` while an episode is open is a duplicate, not a new stall.
- Log hls.js `BUFFER_STALLED_ERROR` and `STALL_RESOLVED` into the same episode as diagnostic markers but do not double count.
- Log HTML `stalled` separately as `network_fetch_stalled`; it does not by itself increment playback-stall count.[16][17]

Primary QoE metrics:

- startup delay (ms);
- rebuffer count and total rebuffer duration (ms);
- rebuffer ratio = rebuffer duration / (playing + rebuffer duration);
- time-weighted effective bitrate and resolution (sample effective `LEVEL_SWITCHED` state at 250 ms or integrate state intervals);
- number of effective quality switches;
- optional instability = sum of absolute adjacent bitrate changes / played seconds.

## Telemetry schema and module contract

All player events use a single append-only envelope:

```ts
type PlayerTelemetry = {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  sequence: number;
  mode: "default-hlsjs" | "conservative-throughput-v1";
  hlsVersion: string;
  browser: string;
  event: string;
  monoMs: number;               // performance.now(), client-local
  wallTime: string;             // ISO timestamp
  mediaTimeS: number;
  player: {
    paused: boolean;
    seeking: boolean;
    readyState: number;
    bufferS: number;
    effectiveLevel: number;
    loadLevel: number;
    manualLevel: number;
  };
  fragment?: {
    sn: number | "initSegment";
    level: number;
    durationS: number;
    url: string;
    bytes: number;
    retry: number;
    aborted: boolean;
    requestMs: number;
    ttfbMs: number;
    transferMs: number;
    sampleGoodputBps: number | null;
  };
  abr?: {
    validSamples: number;
    fastBps: number | null;
    slowBps: number | null;
    estimateBps: number | null;
    hlsEstimateBps: number | null;
    safetyFactor: number | null;
    safeBudgetBps: number | null;
    upEvidence: number;
    cleanAfterRecovery: number;
    fromLevel: number;
    toLevel: number;
    reason: string;
  };
  error?: {
    type: string;
    details: string;
    fatal: boolean;
    message: string;
    status?: number;
  };
};
```

### Player module interface

```ts
interface PlayerAdapter {
  start(input: { video: HTMLVideoElement; manifestUrl: string; run: RunInfo; mode: Mode }): Promise<void>;
  snapshot(): PlayerSnapshot;
  destroy(): void; // remove every Hls/video listener and call hls.destroy()
}

interface AbrPolicy {
  onManifest(levels: PublicLevel[]): AbrDecision;
  onFragment(sample: FragmentSample, player: PlayerSnapshot): AbrDecision;
  onRisk(signal: "waiting" | "buffer_stall" | "frag_error", player: PlayerSnapshot): AbrDecision;
  snapshot(): AbrPolicySnapshot;
}
```

The policy is a pure state machine and must not import hls.js. The adapter translates public hls.js payloads into plain `FragmentSample`/`PlayerSnapshot`, applies the returned level via `hls.loadLevel`, and emits telemetry. This separation makes policy unit tests independent of the browser.

### Server/shaper contract

- `POST /api/runs` creates `{runId, scenarioId, mode, startedAt, mediaId, hlsVersion, policyConfig}`. The server rejects an unknown mode/config version.
- Every manifest/segment request carries `X-Run-Id`. Configure both public hls.js loader hooks (`xhrSetup` and `fetchSetup`) if the project may switch loaders; same-origin hosting avoids CORS preflights. The shaper must never expose the scheduled bandwidth to the ABR policy.
- Server request log fields: `runId`, `requestId`, URL/path, response bytes, scenario phase/bandwidth at request start, server receive/first-byte/end wall times, status, aborted flag.
- Client events are batched to `POST /api/runs/:runId/events`. Posting is non-blocking, bounded, and outside the ABR callback's critical path. Flush with `sendBeacon` on page hide; report a `telemetry_dropped` count if the bounded queue overflows.
- Correlate browser fragment and server request using `runId + normalized segment path + occurrence number`; a response `X-Request-Id` may be added for diagnostics, but the policy must not depend on obtaining it through `networkDetails`.
- `POST /api/runs/:runId/finish` stores aggregate metrics plus raw-event/server-log locations. The evidence module recomputes aggregates from raw events and fails if recomputation differs.
- Scenario definitions are immutable JSON containing ordered `{atMs, bandwidthKbps, latencyMs?, loss?}` phases. Save the exact scenario object/hash with the run.

## Test plan

### Pure unit tests (fake clock, no browser)

1. **Goodput:** 1,000,000 bytes over 2,000 ms produces 4,000,000 bps; start/end includes TTFB.
2. Reject aborted, zero-byte, negative/non-finite, and under-50-ms samples.
3. First sample initializes both EWMAs; a sudden low sample makes fast fall below slow and therefore controls the estimate.
4. Sustained high samples recover slowly through the slow EWMA.
5. Forward buffer selects the range containing `currentTime`, returns zero in a hole, and never uses a later range.
6. Ladder validation accepts the controlled monotonic ladder and rejects non-increasing bitrate/resolution or mixed codec family.
7. Startup chooses lowest with no estimate.
8. Throughput drop can downswitch multiple rungs in one decision.
9. Low buffer uses 0.70 safety even when 0.85 would hold the current level.
10. Upgrade requires three consecutive qualifying samples, high buffer, clean recovery and cooldown.
11. Upgrade advances exactly one rung.
12. A non-qualifying/invalid/retried sample resets upgrade evidence.
13. Stall selects lowest and blocks upgrade for three clean fragments.
14. Relevant error blocks recovery; unrelated subtitle errors are logged but do not force main-video quality down.
15. No level fits budget => lowest; top level affordable => top after normal one-rung recovery.
16. Decision event contains all operands and a stable reason code.

### Adapter tests (mock Hls event emitter and video)

- `MANIFEST_PARSED` snapshots the public ladder and enters manual mode only for custom mode.
- `FRAG_BUFFERED` filters `frag.type !== "main"` and `sn === "initSegment"`.
- A custom decision writes only `loadLevel`; baseline writes none of the level/ABR setters.
- `LEVEL_SWITCHING` and `LEVEL_SWITCHED` are recorded distinctly.
- `waiting` is deduplicated and startup/pause/seek events are not counted as rebuffers.
- `ERROR` serializes optional fields safely and fatal errors terminate the run once.
- `LEVELS_UPDATED` refreshes index mapping or terminates a custom static-VOD run if its monotonic contract no longer holds.
- `destroy()` unregisters all listeners.

### Real-browser integration scenarios

Run each mode against the same local VOD and deterministic shaper trace, with browser cache disabled:

1. constant high bandwidth;
2. high → below-current-rendition bandwidth;
3. low → high bandwidth;
4. high → low → high recovery;
5. alternating/sawtooth bandwidth around a rendition threshold;
6. bandwidth below the lowest rendition;
7. one injected fragment timeout/HTTP error.

Assertions should focus on invariants (telemetry completeness, no private access, valid selected indices, no duplicate stalls, deterministic decisions from replay). Treat “custom has fewer stalls” and “default has higher quality” as measured hypotheses, not hard-coded test expectations.

## Version-specific and uncertain points to flag in the report/presentation

1. **Generated docs are unversioned.** Use exact-tag GitHub links for implementation claims and pin npm `1.7.4`; re-audit on any upgrade.[21]
2. **`bandwidthEstimate` availability mismatch.** The current docs describe `NaN` when unavailable, while 1.7.4 source returns the default estimator value before samples. Maintain the custom `validSamples` counter.[1][6]
3. **LoadStats naming/semantics have changed across older hls.js releases.** Current 1.7.4 uses nested `loading.start/first/end`; old tutorials may show `trequest/tfirst/tload`. Compile against pinned TypeScript types and add a runtime shape assertion in development.[5][8]
4. **`stats.bwEstimate` event timing.** It is public in `LoadStats`, but hls.js populates it in an internal `FRAG_BUFFERED` listener. Depending on it in another listener risks event-order coupling. Compute the custom sample and read `hls.bandwidthEstimate` only for side-by-side telemetry.[8][10]
5. **`STALL_RESOLVED` may not exist in older versions.** Standard media `playing` remains the primary end-of-stall signal.[13][16]
6. **`LEVEL_SWITCHING` is requested, `LEVEL_SWITCHED` is effective.** Mixing them inflates or mistimes switch metrics.[13]
7. **Level indices can change.** `LEVELS_UPDATED` can follow level removal; refresh the full mapping and never persist a naked index without bitrate/resolution metadata.[7]
8. **Native Safari HLS bypasses hls.js.** The experiment target is pinned Chrome with MSE/hls.js; do not silently fall back to native HLS for measured runs.
9. **OS/browser buffering can distort very short local transfers.** The 50-ms sample floor and server-side chunk pacing are required; log both browser and server timings.
10. **Manual mode loses hls.js automatic in-flight emergency abandonment.** The custom policy compensates only after `waiting`/error and at completed fragments. This is a deliberate, reportable algorithm difference, not an implementation bug.

## Sources

[1] https://hlsjs.video-dev.org/api-docs/hls.js.hls
[2] https://hlsjs.video-dev.org/api-docs/hls.js.events
[3] https://hlsjs.video-dev.org/api-docs/hls.js.hlslisteners
[4] https://hlsjs.video-dev.org/api-docs/hls.js.level
[5] https://hlsjs.video-dev.org/api-docs/hls.js.loadstats
[6] https://github.com/video-dev/hls.js/blob/v1.7.4/src/hls.ts
[7] https://github.com/video-dev/hls.js/blob/v1.7.4/src/types/events.ts
[8] https://github.com/video-dev/hls.js/blob/v1.7.4/src/types/loader.ts
[9] https://github.com/video-dev/hls.js/blob/v1.7.4/src/types/level.ts
[10] https://github.com/video-dev/hls.js/blob/v1.7.4/src/controller/abr-controller.ts
[11] https://github.com/video-dev/hls.js/blob/v1.7.4/src/utils/ewma-bandwidth-estimator.ts
[12] https://github.com/video-dev/hls.js/blob/v1.7.4/src/config.ts
[13] https://github.com/video-dev/hls.js/blob/v1.7.4/src/events.ts
[14] https://github.com/video-dev/hls.js/blob/v1.7.4/src/errors.ts
[15] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/buffered
[16] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/waiting_event
[17] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/stalled_event
[18] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState
[19] https://www.rfc-editor.org/rfc/rfc8216.html
[20] https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices
[21] https://github.com/video-dev/hls.js/releases/tag/v1.7.4
[22] https://hlsjs.video-dev.org/api-docs/hls.js.fragment
[23] https://github.com/video-dev/hls.js/blob/v1.7.4/src/loader/fragment.ts
[24] https://hlsjs.video-dev.org/api-docs/hls.js.errordata
[25] https://hlsjs.video-dev.org/api-docs/hls.js.levelswitchingdata
