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

## Runner ↔ player contract

Implemented by the player's runner-controlled mode (`apps/player/src/automation.js`, wired in `apps/player/src/main.js`). The runner opens:

```text
<player-url>?api=<server base URL>&runId=<runId>&policyId=<policy>&maxWallMs=<n>
```

The player page then, with no user interaction:

1. Validates the URL (a malformed runner URL is refused, never turned into a manual run), locks the form and hides the video controls.
2. `POST /api/v1/runs/{runId}/start` with `clientSendMonoMs` taken from the **same clock as event `clientMonoMs`** (`performance.now()`). Reaction-time charts use it to place player events on the scenario clock. If `/start` fails, the page aborts the run at once instead of waiting for the watchdog.
3. Loads the returned `hlsUrl`, plays **muted**, and posts telemetry batches (≤ 200 events, contiguous `seq` from 0), including `client.visibility_changed`.
4. Finishes with `POST /finish` (`ended`, `fatal_error`, or `timeout` after `maxWallMs`). `client.finished` is always the last event.

The runner only watches the server's run status, so the player needs no other signal.

`src/drivers/stub-player.mjs` is a Node reference implementation of the same protocol (lowest level only, no ABR), used by the tests.

## Full real-run sequence

```bash
CORS_ALLOWED_ORIGINS=http://127.0.0.1:4173 npm run server      # terminal 1: API + shaped media on :8080
npm run build -w @abr-lab/player && npm run dev -w @abr-lab/player   # terminal 2: player page on :4173
export CHROME_PATH=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
npm run runner -- --mode warmup  --player-url http://127.0.0.1:4173/
npm run runner -- --mode dry-run --player-url http://127.0.0.1:4173/
npm run runner -- --mode counted --player-url http://127.0.0.1:4173/   # needs a clean checkout + a player built from it
npm run analyze -- --order results/run-order.json
npm run freeze
```

The server does not serve the player page, so the page runs on its own origin and the server needs the CORS allowlist. For counted runs the player bundle must be rebuilt after the last commit: the runner compares `build-metadata.js` with `git rev-parse HEAD` and refuses a bundle from another commit or a dirty tree. The ledger is the only file the runner itself changes, so it does not count as a dirty checkout and an interrupted counted session can resume.

## Tests

```bash
npm run test:runner
```

These start Galib's real server on a 6 s ffmpeg-generated package and drive it with the stub player. They cover: two valid runs; a crashed browser session that is aborted, marked harness-invalid and rerun with lineage; resume skipping finished cells; stopping on an apparatus mismatch; and the run order being deterministic and frozen. ffmpeg must be on PATH.
