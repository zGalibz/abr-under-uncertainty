# Browser player and dashboard

This is Member 2's one-build HLS player. At runtime it selects either
`default-hlsjs` or `conservative-throughput-v1`; the page, video element,
telemetry, dashboard, and non-ABR configuration are shared.

## Run locally

From the repository root:

```sh
npm ci
npm --workspace @abr-lab/player test
npm --workspace @abr-lab/player run build
npm --workspace @abr-lab/player run dev
```

Open the URL printed by the final command (normally
`http://127.0.0.1:4173`). Use Chrome for a measured run. The development
server is only a static-file server; Member 1's experiment server must serve
the lifecycle API and run-scoped HLS assets.

## How a real run works

1. The operator selects a policy and draft scenario, then presses **Start
   run**.
2. `HttpRunApi` creates a run and calls `POST /api/v1/runs/{runId}/start`.
3. Only after the start response returns its `hlsUrl` does `PlayerController`
   create hls.js, load the manifest, and call `video.play()`.
4. The controller converts public hls.js and HTML media events into the
   existing `1.0.0` telemetry schema. `TelemetryClient` numbers events from
   zero, samples player state every 250 ms, sends at most 200 events at once,
   and retries the same event sequence numbers after a failed submission.
5. On `ended`, fatal error, or Reset, the controller emits `client.finished`.
   Telemetry is flushed successfully before `finish` is requested. A flush or
   finalization failure is reported as an incomplete run.

The dashboard receives the very same emitted events. It shows the requested
level (`LEVEL_SWITCHING`) separately from the effective level
(`LEVEL_SWITCHED`), so a requested switch is never presented as already
played quality.

## ABR policies

### `default-hlsjs`

The baseline creates hls.js 1.7.4 with:

```js
new Hls({ startLevel: -1, capLevelToPlayerSize: false })
```

It never writes `currentLevel`, `nextLevel`, `loadLevel`, `nextLoadLevel`,
`nextAutoLevel`, `bandwidthEstimate`, or `autoLevelCapping`. An adapter test
places setters on every one of those fields and fails if baseline code writes
any of them.

### `conservative-throughput-v1`

`src/policy/conservative.js` has no hls.js import. It uses completed main
fragment request goodput:

```text
goodput = 8 × bytes / full request seconds
estimate = min(fast EWMA, slow EWMA)
```

The fast EWMA uses `0.50`; the slow EWMA uses `0.20`. Normal choices use 85%
of the estimate. Low buffer, retry, and relevant errors use 70%. A stall
immediately chooses the lowest rung, upgrades require three clean qualifying
fragments and a high-buffer gate, and recovery moves only one rung upward.
The browser adapter applies normal custom decisions with public
`hls.loadLevel`; it does not use hls.js private controllers or `currentLevel`.

While a `loadLevel` change is pending, the policy treats its own `desiredLevel`
as the control target ahead of the adapter's requested/effective-level
telemetry. This prevents a delayed hls.js switch from being mistaken for a
cancelled request and avoids issuing another decision from the old rendition.
Only clean, successfully buffered main-media fragments count toward the
between-upgrade spacing gate. A new manifest clears throughput estimates,
upgrade evidence, recovery state, and fragment spacing before selecting its
lowest bitrate rendition.

## Mocks and fixtures

`src/mocks/mock-run-api.js` is a clearly marked **MOCK** lifecycle adapter.
It implements create/start/append/finish in memory, deduplicates event
sequence numbers, and labels every result as mock. The **MOCK dashboard
preview** option generates synthetic telemetry only. It is useful for UI and
batching development; it is never a video playback or experiment result.

No HLS media fixture is included because Member 1's package has not been
provided and this workspace has no encoder/source asset. Replace the mock by:

1. Start Member 1's server at the selected URL (or use same origin).
2. Select **Experiment server** in the player.
3. Ensure `POST /api/v1/runs`, `/start`, `/events`, and `/finish` implement
   [`contracts/openapi.yaml`](../../contracts/openapi.yaml).
4. Ensure `start` returns a run-scoped `/stream/v1/<runId>/master.m3u8` URL
   whose four variants are 360p, 480p, 720p, and 1080p with aligned 2-second
   segments.

The policy has no scenario input. A server-supplied configured capacity may be
shown later as explanation, but no future schedule is passed into the player
or policy.

## Contract notes for integration review

The shared contract is still marked draft. I did not modify it. Two existing
fields need a joint decision by Susmoy and Miraj before counted runs:

- The event schema can record `waiting`, `playing`, terminal timestamps, and
  `media.stalled`, but has no episode ID, duration, or `censored` field. The
  `StallTracker` retains this locally; the reducer can infer a terminal-open
  interval from the permitted timestamped events, but cannot receive an
  explicit censored label.
- `FinishRunRequest.clientSummary.startupDelayMs` requires a non-negative
  number even when a fatal error occurs before first playback. The current
  adapter sends `0` in that unmeasured case and raw events identify the fatal
  terminal path. A nullable or status-bearing field would be clearer.

`resolvedConfig` (hls.js version, start level, and player-size cap) is exposed
to the local dashboard. The current create/start API has no metadata field for
persisting it into server `run.json`; that is another handoff requirement for
Member 1 and Member 3, rather than a silent contract extension here.

## Tests

`npm --workspace @abr-lab/player test` covers:

- conservative goodput, invalid samples, EWMA response, multi-rung downshift,
  safety margins, upgrade evidence, recovery, and deterministic ladder rules;
- startup, short, duplicate, pause/seek, resumed, and censored stall cases;
- telemetry schema validation, sequence/timestamp ordering, bounded batching,
  retry behavior, and mock idempotency;
- manifest/level handling, default-policy forbidden-control writes, custom
  `loadLevel`, cleanup, fatal terminal handling; and
- dashboard rendering from controller data.

The player build copies the installed, pinned local `hls.js/dist/hls.min.js`
into `apps/player/dist`; it does not fetch a CDN script at runtime.
