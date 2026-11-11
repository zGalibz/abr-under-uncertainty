# @abr-lab/runner

Controlled run orchestration (Member 3). The runner creates runs on the experiment server, opens the player in a fresh Chrome context, waits without interacting, aborts broken sessions, validates each run's raw evidence immediately with the analysis rules, and records every attempt in an append-only ledger.

## Commands

```bash
npm run runner:order                 # write results/run-order.json once (or verify it is unchanged)
npm run server                       # Galib's server, in another terminal

npm run runner -- --mode warmup  --player-url <url>   # 1 discarded run per policy (stable trace)
npm run runner -- --mode dry-run --player-url <url>   # 1 full run per policy (--trace, default volatile-v1)
npm run runner -- --mode counted --player-url <url>   # the frozen 18-run order; needs a clean git checkout
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--server` | `http://127.0.0.1:8080` | experiment server |
| `--raw` | `results/raw` | where the server writes runs |
| `--driver` | `playwright` | `stub` = Node stand-in player, for testing only (never counted) |
| `--chrome` | `CHROME_PATH`, then `experiment.browser.executablePath` | Chrome executable |
| `--headless` | `experiment.browser.headless` | |
| `--limit` | all | counted mode: stop after n cells (resumable) |
| `--max-attempts` | 3 | attempts per cell before stopping |

## Rules the runner enforces

- **Apparatus.** After creating each run, the server's experiment, scenario and package hashes must equal this checkout's; otherwise the run is aborted and the session stops.
- **Fresh session.** Every run gets a new browser context, with the HTTP cache disabled and service workers blocked.
- **Watchdog.** If the browser crashes, or the run is not terminal within `stopPolicy.maxWallDurationMs` + 30 s, the run is aborted on the server.
- **Reruns.** Only a harness-invalid attempt is rerun, and the ledger records `rerunOf`. A rejected run stops the session, because that means a logging or apparatus bug. A valid run is never rerun, whatever its outcome.
- **Counted runs.** These require a clean git checkout and an unchanged `results/run-order.json`. They are resumable: cells with a valid counted run are skipped.
- **Labels.** Each run's `clientLabel` is `runner-warmup`, `runner-dry-run` or `runner-counted`. The analysis excludes the first two by default (`--labels runner-dry-run` analyses dry runs only).

Ledger: `results/runner-ledger.ndjson`. Console output of each player page: `results/raw/<runId>/console.log`.

## Runner ↔ player contract (DRAFT, needs Susmoy's approval)

The runner opens:

```text
<player-url>?api=<server base URL>&runId=<runId>&policyId=<policy>&maxWallMs=<n>
```

The player page must, with no user interaction:

1. Read `runId` and `policyId` from the URL and use that policy.
2. `POST /api/v1/runs/{runId}/start` with `clientSendMonoMs` taken from the **same clock as event `clientMonoMs`** (`performance.now()`). Reaction-time charts use it to place player events on the scenario clock.
3. Load the returned `hlsUrl`, play muted, and post telemetry batches (≤ 200 events, contiguous `seq` from 0).
4. Finish with `POST /finish` (`ended` / `timeout` after `maxWallMs` / `fatal_error`).

The runner only watches the server's run status, so the player needs no other signal.

`src/drivers/stub-player.mjs` is a working reference implementation of this protocol (lowest level only, no ABR).

## Tests

```bash
npm run test:runner
```

These start Galib's real server on a 6 s ffmpeg-generated package and drive it with the stub player. They cover: two valid runs; a crashed browser session that is aborted, marked harness-invalid and rerun with lineage; resume skipping finished cells; stopping on an apparatus mismatch; and the run order being deterministic and frozen. ffmpeg must be on PATH.
