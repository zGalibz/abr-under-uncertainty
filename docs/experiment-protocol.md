# Experiment Protocol — `abr-under-uncertainty-v1`

Status: **pre-registered before the counted runs.** This file, `results/run-order.json` and the code that measures the runs were committed and pushed **before** the first counted run. Nothing here may change after the counted runs start without creating a new dataset version (TEAM_ROLES §8.7).

Owner: Miraj (Member 3). Sign-off required from all three members (see the end).

The canonical design is `docs/PROJECT_DESIGN.md`; the metric dictionary and reporting rules come from `docs/research/experiment-and-team-framework.md` §4, §7, §9 and §11. This protocol states exactly how they are implemented, including where the implementation deviates from the design.

## 1. Question and hypotheses

> Under identical deterministic bandwidth traces, how does stock hls.js ABR compare with a simple conservative throughput-aware policy in playback stalls, played rendition bitrate, adaptation reaction time, buffer safety, switching, and completion?

Hypotheses (not findings; copied unchanged from PROJECT_DESIGN §1.2):

- **H1:** the conservative policy may reduce stall count or total stall duration during gradual and volatile bandwidth drops.
- **H2:** any stall reduction may be purchased with lower time-weighted played bitrate or slower quality recovery.
- **H3:** both policies should complete smoothly under stable bandwidth if the apparatus is correct.
- **H4:** bandwidth volatility may cause more switching and lower buffer safety than a stable connection with a similar average rate.

Honest negative or mixed results are valid outcomes. A result that contradicts a hypothesis is reported as the finding; the hypotheses are not rewritten after the data are seen.

## 2. Variables

**Independent variables**

| Variable | Levels |
|---|---|
| ABR policy | `default-hlsjs` (stock hls.js 1.7.4 automatic ABR), `conservative-throughput-v1` (PROJECT_DESIGN §6.3) |
| Bandwidth trace | `stable-v1`, `gradual-v1`, `volatile-v1` (§4 below) |

**Held constant across all 18 runs**

| Item | Frozen value |
|---|---|
| Experiment config | `configs/experiment.v1.json`, SHA-256 `cef527eb5c5c8c8ef8ee9516ec779eee98fe883f696646250d5841881ff6d7ff` (canonical JSON) |
| Media package | `media/package.json`, SHA-256 `a8c65b415d4729f84e1a17f6882623a47e2e3f1b0f24739c07224d7a96201158`; source `assets/source/source.mp4` SHA-256 `fda77d57…5dc1` |
| Traces | `stable.v1.json` `bcf57c79…9447`, `gradual.v1.json` `1a585513…e41c`, `volatile.v1.json` `b0096b6f…0a50` (canonical JSON SHA-256) |
| Player | one build of `apps/player` with hls.js **1.7.4**, built from the counted commit (the runner refuses any other build) |
| Browser | Chrome for Testing **153.0.8010.12** (Linux x86-64), headed, via Playwright 1.64.0 |
| Browser state | a new browser context per run (no cookies, storage or cache), HTTP cache disabled through DevTools, service workers blocked, autoplay allowed, video **muted**, viewport 1280×720 at device scale 1 |
| Host | one Windows machine running WSL2 (Linux kernel 6.18.33.2-microsoft-standard-WSL2), WSLg display, Node.js 22.23.3 |
| Server | `packages/shaper-server` on `127.0.0.1:8080`, one run at a time (`maxConcurrentRuns: 1`); player page on `127.0.0.1:4173` |
| Shaping | per-run aggregate token bucket on media-segment bodies only; 16 KiB burst, 4 KiB writes, 20 ms response-start delay; playlists, API and telemetry unshaped |
| Run limits | stop on `ended` or fatal error; player-side timeout 240 s (`stopPolicy.maxWallDurationMs`); runner watchdog 270 s |

**Excluded** (PROJECT_DESIGN §2): CDN/cloud delivery, DASH, ML prediction, public-network measurement, multi-browser or multi-device comparison, subjective study, the optional `outage-v1` trace.

## 3. Media ladder

Bitrates are measured from the generated segments (`media/package.json`); the peak value is the master playlist `BANDWIDTH`.

| Level | Resolution | Measured average (kbit/s) | Measured peak (kbit/s) |
|---:|---|---:|---:|
| 0 (`v0`) | 640×360 | 637.1 | 806.1 |
| 1 (`v1`) | 854×480 | 1 035.1 | 1 391.2 |
| 2 (`v2`) | 1280×720 | 1 928.2 | 2 704.2 |
| 3 (`v3`) | 1920×1080 | 3 319.4 | 4 790.2 |

Clip: 128.57 s, 65 aligned 2-second MPEG-TS segments per level (the last one shorter).

## 4. Traces

Capacity is **configured** downstream goodput for media bodies (kbit/s). It is a target, not a measurement. Calibration (`results/calibration/`) measured every plateau within 0.5 % of target (tolerance ±10 %) and every transition within 0.1 ms (tolerance ±0.5 s).

| Trace | Phases (scenario time → configured kbit/s) |
|---|---|
| `stable-v1` | 0 s → 7 045 for the whole run |
| `gradual-v1` | 0–20 s 7 045 · 20–40 s 4 408 · 40–60 s 2 409 · 60–80 s 1 292 · 80–100 s 711 · 100 s → 7 045 |
| `volatile-v1` | 0–12 s 7 045 · 12–24 s 1 292 · 24–36 s 4 408 · 36–48 s 711 · 48–60 s 7 045 · 60–72 s 1 292 · 72–84 s 4 408 · 84–96 s 711 · 96 s → 7 045 |

Scenario time zero is fixed by the server when the player calls `POST /start`.

Reaction anchors are read from `configs/scenarios/manifest.json`. Only `adverse` anchors where the highest **safe** level drops are scored; a level is safe when its measured peak ≤ 0.85 × configured capacity. Scored anchors: `gradual-v1` 20, 40, 60, 80 s; `volatile-v1` 12, 36, 60, 84 s. `stable-v1` has none.

## 5. Run matrix and order

2 policies × 3 traces × 3 repeats = **18 counted runs**. The order is a Fisher–Yates shuffle seeded with `orderSeed = 20261109` (mulberry32), written once to `results/run-order.json` (SHA-256 `628908f2…7e12`) by `npm run runner:order` and committed before the first counted run. The runner refuses to start if the file changes.

| # | Trace | Policy | Repeat | | # | Trace | Policy | Repeat |
|---:|---|---|---:|---|---:|---|---|---:|
| 1 | volatile | conservative | 3 | | 10 | volatile | default | 1 |
| 2 | stable | default | 2 | | 11 | gradual | default | 2 |
| 3 | gradual | default | 3 | | 12 | stable | default | 1 |
| 4 | volatile | default | 3 | | 13 | gradual | conservative | 1 |
| 5 | volatile | default | 2 | | 14 | stable | conservative | 3 |
| 6 | volatile | conservative | 1 | | 15 | stable | conservative | 2 |
| 7 | stable | default | 3 | | 16 | gradual | conservative | 3 |
| 8 | gradual | default | 1 | | 17 | stable | conservative | 1 |
| 9 | volatile | conservative | 2 | | 18 | gradual | conservative | 2 |

Before the counted runs:

1. **Warm-up:** one run per policy on `stable-v1`, label `runner-warmup`, discarded. (The design asks for an *unshaped* warm-up; the frozen apparatus has no unshaped scenario, so the highest-capacity trace is used. Warm-ups are never analysed.)
2. **Dry run:** one full run per policy on `volatile-v1`, label `runner-dry-run`, analysed separately into `results/dry-run/` to prove the end-to-end chain.

## 6. Procedure for one run (runner, no human interaction)

`npm run runner -- --mode counted --player-url http://127.0.0.1:4173/` performs, for each cell in the frozen order:

1. Refuse to start unless the git checkout is clean, `results/run-order.json` is unchanged, and the player bundle was built from this exact clean commit.
2. `POST /api/v1/runs` with the cell's policy, trace and repeat, label `runner-counted`, and the git commit.
3. Compare the server's experiment, scenario and package hashes with this checkout. Any mismatch aborts the run and stops the session.
4. Open the player page in a fresh browser context: `?api=…&runId=…&policyId=…&maxWallMs=240000`.
5. The page calls `/start`, plays muted, posts telemetry in batches of at most 200 events with contiguous sequence numbers, and calls `/finish` on `ended`, fatal error or the 240 s timeout.
6. The runner only polls the server's run state. It aborts the run if the page crashes or nothing is terminal after 270 s.
7. The raw evidence is validated immediately (§7) and every attempt is appended to `results/runner-ledger.ndjson` (cell, attempt, `rerunOf`, run ID, server status, validation, Chrome version, player build commit).
8. Only a **harness-invalid** attempt is rerun (at most 3 attempts per cell). A **rejected** run stops the session. A valid run is never rerun, however bad its outcome.

Runs are collected in one session on an otherwise idle machine. Per the framework runbook, no comparative results are inspected until all 18 cells are filled; only validation status is watched.

## 7. Run inclusion rules

Applied in this order by `packages/analysis/src/evaluate.mjs` (the same function the runner and the analysis use):

1. **Server status.** `FAILED`, `ABORTED` or never finalized → **harness-invalid**.
2. **Structure and provenance** → **rejected** on any failure: `run.json` and every event and server-request line match their JSON Schemas; folder name equals `runId`; experiment, scenario and package hashes equal the frozen apparatus; every raw artifact still has the SHA-256 the server recorded at finish; sequence numbers are contiguous from 0 with no duplicates; `clientMonoMs` never decreases; `client.ready`, `hls.manifest_parsed`, `media.play_requested` and `client.finished` are present and `client.finished` is last; every `abr.decision` names the run's policy; the ladder the player saw equals the package ladder.
3. **Harness checks** (between first confirmed playback and the terminal event) → **harness-invalid**: a pause other than end-of-stream, a seek, a playback-rate change, the tab becoming hidden, or 4 Hz sample coverage below 95 %.

Only `runner-counted` runs enter the counted dataset (`COUNTED_LABELS`); warm-up, dry-run, demo and manual player-page runs share `results/raw/` but are never counted.

## 8. Metric definitions

All metrics are recomputed from raw events by `packages/analysis/src/reduce.mjs`. The player's own `clientSummary` is a cross-check only. `NA` means not applicable or not observed, never zero.

| Metric | Definition | Better |
|---|---|---|
| `startup_delay_s` | `media.play_requested` → first **confirmed** `media.playing` (media time advances ≥ 0.05 s within 500 ms, not paused or seeking) | lower |
| `rebuffer_count` | post-start `waiting` → confirmed `playing` intervals ≥ 250 ms; duplicate `waiting` while open ignored; waiting while paused/seeking ignored; an interval still open at the terminal event is kept and marked censored | lower |
| `rebuffer_duration_s` | sum of those intervals | lower |
| `rebuffer_ratio` | rebuffer duration ÷ (terminal − first playback) | lower |
| `tw_bitrate_kbps` | played-fragment bitrate weighted by seconds of media played, using each level's **measured average** bitrate; fragments come from `hls.frag_changed` (what was shown, not what was requested). Complete runs only; an incomplete run reports `tw_bitrate_prefix_kbps` instead | higher |
| `switch_count` (+ up/down, `switch_magnitude_kbps`, `switches_per_min`) | changes of level between consecutive played fragments; magnitude = sum of absolute average-bitrate differences | lower = smoother |
| `buffer_mean_s` | time-weighted mean forward buffer (range containing `currentTime`) over 4 Hz samples from first playback to the terminal event | higher = safer |
| `buffer_p05_s` | 5th percentile of the buffer samples | higher |
| `low_buffer_fraction` | fraction of that time with forward buffer < 0.5 s | lower |
| `reaction_s` (per anchor), `reaction_median_s`, `reaction_worst_s` | from the anchor time to the first media-segment request (server log, scenario clock) at or below the new safe level that completed and was buffered. 0 s and flagged "already safe" if the last request before the anchor was already at or below it. **Censored** if requests were made during the low plateau but none reached the safe level before it ended. **Not exposed** if no media request at all was made during the plateau (buffer full, or the whole clip already downloaded): the policy never had to choose a level under the drop, so the anchor is counted (`reaction_not_exposed_n`) but not scored. `reaction_anchor_n` counts scored anchors only | lower |
| `completed`, `terminal_reason` | `media.ended` observed and `client.finished.reason = ended`; otherwise the exact reason (`timeout`, `fatal_error`, `aborted`) | — |

## 9. Reporting rules (framework §9)

1. Every run-level point is shown; no bar-only charts.
2. Primary cell summary: **median and full [min, max]**. Secondary: mean and sample SD (n − 1), labelled as such; no confidence intervals from n = 3.
3. The primary comparison is **paired deltas** on matching trace and repeat (`paired_deltas.csv`); `improvement_signed > 0` always means the conservative policy did better.
4. Direction consistency is stated as `3/3`, `2/3`, …; nothing is called statistically significant.
5. Completion is exact `x/3`; prefix-only bitrate is never pooled with complete runs.
6. No percentage improvement when the default value is zero.
7. No composite "winner" score: stalls, bitrate, startup, switches, reaction and completion stay separate.
8. **Representative run** for the time-series figures (decided before data): the run whose total rebuffer duration is the cell median; ties broken by closeness to the median time-weighted bitrate, then the lowest repeat.
9. Hypothesis, observation and interpretation are written as separate sentences, using "observed in these three runs" language.

## 10. Pre-registered conservative-policy targets

Engineering targets from framework §11.3. Missing them is a valid, reportable result, not a project failure:

- no lower completion count on any trace;
- positive median paired improvement in rebuffer duration on both `gradual-v1` and `volatile-v1`;
- no more than 20 % lower median time-weighted bitrate on `stable-v1`;
- no more than +0.5 s median startup-delay penalty;
- no slower median reaction time at adverse anchors;
- at least 2/3 paired runs in the expected direction for each claimed benefit.

**Known risk, stated before the data:** the conservative policy only upgrades when the next level's peak ≤ 0.70 × estimate. Reaching 1080p (peak 4 790 kbit/s) needs an estimate ≥ 6 843 kbit/s, 97 % of the 7 045 kbit/s stable cap, and request goodput includes time to first byte. In the discarded `stable-v1` warm-up the estimate peaked at 6 988 kbit/s and the policy did reach 1080p, but with only about 2 % margin. If counted runs reach 1080p late or not at all, the stable-trace bitrate gap is a consequence of the 0.70 constant and the cap, and will be reported that way.

## 11. Deviations from the design

| Design | This protocol | Why |
|---|---|---|
| Same-origin player (PROJECT_DESIGN §5.1) | player page on `127.0.0.1:4173`, server on `:8080` with an explicit CORS allowlist | the server does not serve the player page; §5.3 permits CORS with an allowlist. Same for both policies. |
| Unshaped warm-up (§9) | warm-up on `stable-v1` | no unshaped scenario exists in the frozen apparatus |
| Raw `samples.csv`, `fragments.csv`, `network.csv` (§7.3) | not produced | the same data is in `events.ndjson` and the server logs; the reducer reads those directly |
| `start_skew_ms` | `NA` | not computed in v1 |
| Reaction anchor statuses: ok or censored (framework §4.6) | adds **not exposed** for anchors with no media request during the plateau | found in the dry runs: framework §4.6 assumes the player is downloading at every anchor (see §11.1) |

### 11.1 Dry-run observations that shaped this protocol

Both dry runs (`volatile-v1`, one per policy) were valid and complete, with 100 % sample coverage. They showed:

- **The whole clip is downloaded early.** With stock hls.js buffer settings (shared by both policies: the forward-buffer goal grows to 60 MB ÷ level bitrate, far more than the 128 s clip), each player fetched all 65 segments within about 70–73 s. Trace phases after that cannot affect playback, so the volatile trace's last drop (84 s) happened while nothing was being downloaded. This is why the *not exposed* status was added. It is a property of the frozen apparatus (short clip, default buffer goal), applies equally to both policies, and is reported as a limitation, not changed.
- **Startup differs by design.** Stock hls.js first fetches fragment 0 at the lowest level to measure bandwidth and then fetches it again at the chosen level; the conservative policy starts at the lowest level and keeps it. Startup was 1.41 s versus 0.29 s.
- **Benign non-fatal hls.js errors** occurred in both runs: `bufferSeekOverHole` before first play (the segments' first frame is at 0.167 s, so hls.js skips that gap), `bufferAppendNoProgress` once (an append that did not grow the buffered range; hls.js takes no action), and, for the conservative policy, a few `aborted` fragment loads when it changed level. None is terminal or a validity problem.

## 12. Data freeze

After the 18 cells are filled: `npm run analyze -- --order results/run-order.json` twice (outputs must be byte-identical), then `npm run freeze` writes `results/data-freeze.json` (SHA-256 of every raw file, run count, validation counts, apparatus hashes, git commit). The raw folders are archived read-only outside git (they are git-ignored). The freeze commit is tagged `v0.5-data-freeze` after all three members approve.

## Sign-off

| Member | Role | Approved |
|---|---|---|
| Asadullah Galib | media + network | pending |
| Susmoy L | player + ABR | pending |
| Miraj | evidence + analysis | yes |
