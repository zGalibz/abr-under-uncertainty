# Adaptive Video Streaming: Experimental, Evaluation, and Team-Integration Framework

**Project question:** How do stock hls.js ABR and a conservative throughput-aware policy differ in video quality, playback stalls, and adaptation behavior when bandwidth changes?

**Team:**
- **Member 1 — Asadullah Galib:** media pipeline + networking
- **Member 2 — Susmoy L:** player + adaptation
- **Member 3 — Miraj:** evidence + analysis + presentation

**Protocol status:** This document is a preregistered method. Anything in the hypotheses section is a prediction, not a result. Fill the result tables only after the run matrix is complete and the data-freeze commit is tagged.

## 1. Research basis and scope

Startup delay, rebuffering, delivered video quality, and quality variation are established dimensions for evaluating adaptive streaming systems.[1][10] ITU-T P.1203 specifically distinguishes initial loading delay from later stalls and defines media adaptation as switching among known quality levels.[1] This project will measure those dimensions directly rather than collapse them into a single subjective “QoE score.” A P.1203 score is optional; it is not a primary metric because the project can answer its networking question with directly observed player behavior.

hls.js exposes the fragment, buffering, level, error, and manifest events needed for instrumentation.[2] Its fragment-buffered payload includes the fragment and loading statistics,[3] and level objects expose nominal/average bitrate, resolution, and related representation metadata.[4] The stock comparison must therefore mean **the pinned hls.js build with its default ABR controller and default ABR parameters**, not a reimplementation that merely resembles it.

### 1.1 Independent and controlled variables

- **Independent variable A — policy:** `default` versus `conservative`.
- **Independent variable B — bandwidth trace:** `stable`, `gradual`, `volatile`; `outage` is an optional extension.
- **Repeated factor:** three counted runs of every policy × trace cell.
- **Controlled:** media bytes and ladder, segment boundaries, player build, hls.js version, browser version/profile, startup procedure, buffer/loading/retry settings, trace file, cache behavior, machine, display/viewport, server, and metric code.
- **Unit of analysis:** one complete playback attempt under one policy and one trace.

### 1.2 Preregistered hypotheses — not findings

| ID | Prediction | What would support it | What could falsify it |
|---|---|---|---|
| H1 | The conservative policy will reduce total rebuffer duration and/or event count under `gradual` and `volatile`. | Positive paired improvement in at least 2 of 3 repeats for each stressed trace; all raw points shown. | No reduction, or worse stalls/completion. |
| H2 | Conservatism will trade some video bitrate for stall protection. | Lower time-weighted bitrate together with lower stalls in stressed traces. | Lower bitrate without stall benefit, or equal/higher stalls. |
| H3 | The conservative policy will react to adverse capacity changes at least as quickly as stock hls.js. | Lower or equal downshift reaction time at labelled trace anchors. | Slower or censored reaction. |
| H4 | Under `stable`, both policies should complete with no rebuffer and should converge near the highest safe representation. | 3/3 completions, zero post-start stalls, and similar time-weighted bitrate. | Any reproducible stall/failure or a persistent unexplained quality gap. |

Do not write “the conservative policy is better” unless the measured trade-off is stated. A lower bitrate can explain fewer stalls; it is not automatically an overall win.

## 2. Canonical timing and run lifecycle

### 2.1 Two clocks, one run zero

Every record has:

- `t_rel_ms`: monotonic elapsed time from run zero; use `performance.now()` in the browser. `performance.now()` is monotonic and is not subject to wall-clock adjustment.[9]
- `epoch_ms`: `performance.timeOrigin + performance.now()` for cross-process alignment on one machine.
- `media_s`: `video.currentTime`; this is media position, not elapsed experiment time.

The orchestrator chooses a future `run_zero_epoch_ms` (recommended: current time + 2 s), arms both the shaper and player with it, and starts both at run zero. The browser records `play_request` at run zero; the source must not be loaded or prefetched before that event. The trace-start/play-request skew must be at most 100 ms or the run is harness-invalid.

### 2.2 Run state machine

`CREATED → ARMED → STARTING → PLAYING ↔ REBUFFERING → ENDED`

Terminal alternatives are `FATAL_ERROR`, `TIMEOUT`, or `HARNESS_INVALID`.

At `STARTING`, the player, from a fresh page/context:

1. logs `play_request`;
2. instantiates the selected policy;
3. attaches the media element and loads the fixed manifest;
4. calls `video.play()` (muted playback is allowed, but must be identical in both policies);
5. makes no manual pause, seek, or quality selection.

Hard timeout: `max(2 × media_duration_s + 30 s, media_duration_s + 60 s)`. Store the exact resolved value in `run.json`.

## 3. Network trace specification

### 3.1 Resolve traces from the final bitrate ladder

Let the sorted video representation bitrates be `r₀ < … < r_(N−1)`, with `N ≥ 4`. Define a target capacity for a level as `C(i) = 1.25 × r_i`. The 25% headroom makes that level nominally sustainable while still leaving the policy a real choice. After Member 1 freezes the ladder, the trace compiler must resolve every expression to integer `capacity_bps` values and commit the resolved JSON. No expression may remain in the data used for runs.

Use a VOD clip of at least 90 s; 120–180 s is preferable. Use aligned segments of one fixed target duration (recommended 4 s). If the chosen clip is shorter, scale the trace epochs proportionally but keep every volatile plateau at least two segment durations.

| Trace | Required profile | Purpose |
|---|---|---|
| `stable` | `C(N−1)` from 0 s to end | Ceiling/convergence control; should not force stalls. |
| `gradual` | `C(N−1)` for first 20%; linear decline to `C(1)` during the middle 50%; hold `C(1)` for final 30% | Tests delayed recognition and orderly downshifts. |
| `volatile` | Plateaus of at least 2 segment durations with safe-level pattern `[N−1, 1, N−2, 0, N−1, 1, N−2, 0, …]` until end | Tests estimation error, oscillation, buffer use, and repeated reactions. |
| `outage` (optional) | High for first 35%; zero capacity for 6–8 s; `C(1)` for 10–12 s; then high to end | Tests outage recovery separately from ordinary congestion. |

The trace compiler adds **reaction anchors** whenever the evaluation-safe level decreases and remains lower for at least one full segment. With evaluator safety factor `γ_eval = 0.85`, the safe level at time `t` is:

`L_safe(t) = max { i : r_i ≤ γ_eval × C(t) }`, or `−1` if even `r₀` is unsafe.

Each anchor stores `anchor_id`, `t_rel_ms`, `capacity_before_bps`, `capacity_after_bps`, `safe_level_before`, `safe_level_after`, and `plateau_end_ms`. Anchors are evaluator metadata, not hints passed to either ABR policy.

### 3.2 Trace file contract

```json
{
  "schema_version": "1.0",
  "trace_id": "volatile-v1",
  "duration_ms": 120000,
  "source_ladder_sha256": "...",
  "epochs": [
    {"start_ms": 0, "end_ms": 10000, "capacity_bps": 3750000, "delay_ms": 20, "loss_pct": 0}
  ],
  "reaction_anchors": [
    {"anchor_id": "v-a1", "t_rel_ms": 10000, "safe_level_before": 3, "safe_level_after": 1, "plateau_end_ms": 20000}
  ]
}
```

The shaper must log target changes and measured application/bulk-transfer throughput. Linux `netem` can emulate delay, loss, and rate and can seed random impairments, but its manual warns that kernel timer granularity can cause rate artifacts and bursts.[11] Consequently, configured capacity is not treated as achieved capacity; calibration is mandatory.

## 4. Metric dictionary

All durations use monotonic wall time. Primary quality metrics use actually played video segments, not requested levels, not `nextAutoLevel`, and not network throughput.

### 4.1 Startup delay (`startup_delay_s`, lower is better)

ITU-T defines initial loading delay as the time between user initiation and actual playback start.[1]

- `t_request`: timestamp of `play_request`.
- `t_first_play`: timestamp of the first valid `playing` event after `play_request`.
- Validity gate: `video.paused == false`, `video.seeking == false`, and media time advances by at least 0.05 s within the next 500 ms.
- Formula: `startup_delay_s = (t_first_play − t_request) / 1000`.
- If the run never starts, value is `NA`, `started = 0`, and completion is 0.
- Any `waiting` before `t_first_play` belongs to startup and is never counted as a rebuffer event.

The browser’s `playing` event fires on first start and on restart after lack of data,[6] so first occurrence and later occurrences have different roles in the reducer.

### 4.2 Rebuffer event count and duration (`rebuffer_count`, `rebuffer_duration_s`, lower is better)

The `waiting` event means playback stopped for temporary lack of data.[5]

**Candidate start:** a `waiting` event after first valid playback and before valid completion, while playback is intended (`paused == false`, `seeking == false`, `playbackRate > 0`) and there is no user action.

**Debounce:** retain the candidate only if it lasts at least 250 ms. If retained, its start remains the original `waiting` timestamp.

**End:** the first later `playing` timestamp that passes the same media-progress confirmation used for startup.

**Rules:**

- Ignore duplicate `waiting` events while a stall is open.
- Do not use DOM `stalled` as a rebuffer start; it is logged only as a fetch diagnostic.
- A pause, seek, visibility suspension, or playback-rate change during a counted run is harness-invalid unless the protocol explicitly caused it.
- If fatal error/timeout occurs while a stall is open, close it at terminal time with `censored = 1`. Include its observed duration in the raw run record, but clearly mark it censored.
- `rebuffer_count` is the number of retained post-start events.
- `rebuffer_duration_s = Σ(end − start) / 1000`.
- Secondary: `rebuffer_ratio = rebuffer_duration_s / (wall time from first play to terminal)`.

### 4.3 Time-weighted played bitrate (`tw_bitrate_kbps`, higher is better, conditional on stalls/completion)

For every unique played **main video** fragment `i`, derive its played media interval by intersecting `[frag.start, frag.start + frag.duration)` with the media interval actually reached by the run. Let `d_i` be that intersection duration and `b_i` the representation’s `averageBitrate` if available, otherwise its manifest `bitrate`.[4]

`tw_bitrate_kbps = [Σ(b_i × d_i) / Σ d_i] / 1000`

Rules:

- Build played-fragment order from `FRAG_CHANGED`; use `FRAG_BUFFERED` only for request/load metadata. Both are explicit hls.js events.[2]
- Exclude init segments, audio-only fragments, subtitles, aborted attempts, and duplicate/retried copies of the same media interval.
- Do not weight by download time or stall time; this is media-time-weighted encoding bitrate.
- A complete run covers `[0, duration]`. An incomplete run receives `tw_bitrate_prefix_kbps`, is marked `prefix_only = 1`, and is excluded from the primary cross-policy bitrate summary.
- Treat this as a quality proxy, not a perceptual score; bitrate may not map linearly to visual quality.[10]

### 4.4 Quality switches (`switch_count`, lower is smoother; direction and magnitude are secondary)

Sort unique played main fragments by media start. For every consecutive pair, count one switch when the played representation identity changes (level plus bitrate/resolution), regardless of whether hls.js requested intermediate levels.

Report:

- `switch_count`
- `up_switch_count`
- `down_switch_count`
- `switches_per_min = 60 × switch_count / played_media_s`
- `switch_magnitude_kbps = Σ |b_i − b_(i−1)| / 1000`

`LEVEL_SWITCHING` and `LEVEL_SWITCHED` are diagnostics; they do not replace the played-fragment rule.[2]

### 4.5 Forward buffer occupancy (`buffer_mean_s`, `buffer_p05_s`, higher is safer but not automatically better)

At 4 Hz and at every important player event, read the static `video.buffered` ranges. The property reports buffered media ranges at the moment it is read.[7]

For sample `j`, find the range containing `currentTime` with ±0.05 s tolerance. Then:

- `B_j = max(0, range.end − currentTime)` if a containing range exists;
- otherwise `B_j = 0`.

From first valid playback to terminal:

- `buffer_mean_s = Σ(B_j × Δt_j) / ΣΔt_j` using a left-constant integral;
- `buffer_p05_s` = fifth percentile of occupancy samples;
- `low_buffer_fraction = ΣΔt_j where B_j < 0.5 s / ΣΔt_j`.

Do not use the absolute minimum as a headline metric because normal end-of-media drainage drives it toward zero. Any sample gap greater than 500 ms is a logging-quality violation; if samples cover less than 95% of the measurement window, the run is harness-invalid.

### 4.6 Adverse-change reaction time (`reaction_decision_s`, lower is better)

For each committed reaction anchor:

1. Determine the last main-video request that began before the anchor and its level `L_pre`.
2. If `L_pre ≤ safe_level_after`, record `0.000 s` with `proactive_or_already_safe = 1`.
3. Otherwise, find the first main-video `FRAG_LOADING` after the anchor whose requested level is at or below `safe_level_after` **and whose request later reaches `FRAG_BUFFERED`**.[2][3]
4. `reaction_decision_s = (t_qualifying_request − t_anchor) / 1000`.
5. If no qualifying request is buffered before the anchor plateau ends, mark the anchor `censored = 1`; do not silently use the next unrelated drop.

Per run, report the anchor-level values plus `reaction_median_s` and `reaction_worst_s`. Stable has `NA`. Secondary `reaction_playout_s` uses first qualifying `FRAG_CHANGED`; it includes already-buffered playout latency and must be labelled separately.

### 4.7 Completion (`completed`, primary reliability outcome)

The DOM `ended` event can signal that playback reached the end or that no further data is available,[8] so event presence alone is insufficient.

`completed = 1` only if all are true:

- an `ended` event occurred before hard timeout;
- `currentTime ≥ duration − max(0.25 s, one video frame)`;
- no fatal hls.js or media error occurred;
- no harness-invalid condition occurred.

Otherwise `completed = 0`, with exactly one `terminal_reason`: `never_started`, `fatal_hls`, `media_error`, `timeout`, `premature_ended`, or `harness_invalid`. Report cell completion as an exact fraction such as `3/3`, never only as a rounded percentage.

## 5. Event-to-metric mapping

| Raw event/source | Required fields | Metric use | Reducer rule |
|---|---|---|---|
| experiment `play_request` | `t_rel_ms`, policy, trace | startup origin | Exactly one per run. |
| DOM `playing` | time, media time, paused/seeking/ready state | startup end; stall end | Confirm ≥0.05 s media advance in 500 ms. |
| DOM `waiting` | time, media time, state | stall start | Post-start only; 250 ms debounce. |
| DOM `pause`, `seeking`, `ratechange`, `visibilitychange` | state/reason | validity | Unexpected occurrence invalidates harness run. |
| DOM `ended` | time, media time, duration | completion | Must pass end-position/error gates. |
| DOM/media `error` | code/message | completion | Terminal unless explicitly recovered and protocol allows it. |
| hls.js `MANIFEST_PARSED` | levels/bitrates/resolution | ladder verification | Must equal frozen `ladder.json`. |
| `FRAG_LOADING` | request id, type, SN, level, start, duration | requested level; reaction | Main media only. |
| `FRAG_LOADED` | byte count, timing stats | achieved request throughput | Keep failed/retried attempts separately. |
| `FRAG_BUFFERED` | fragment, level, stats | successful reaction; fragment table | hls.js supplies fragment + load stats.[3] |
| `FRAG_CHANGED` | fragment/level | played bitrate and switches | Deduplicate by media interval/representation. |
| `LEVEL_SWITCHING`, `LEVEL_SWITCHED` | old/new level | diagnostics | Never count as played switch by itself. |
| hls.js `ERROR` | fatal, type, details, level/SN | terminal/diagnostics | Fatal sets terminal; nonfatal remains raw. |
| 4 Hz `sample` | media time, ranges, buffer ahead, state, hls estimate | buffer metrics | Coverage and gap gates apply. |
| shaper `trace_change` | target capacity, anchor id | reaction origin | Align to shared run zero. |

hls.js also exposes a runtime bandwidth estimate; log it for explanation, but never substitute it for achieved throughput or played bitrate.[12]

## 6. Repeated-run matrix and order

### 6.1 Counted matrix

| Trace | Default | Conservative | Total |
|---|---:|---:|---:|
| Stable | 3 | 3 | 6 |
| Gradual | 3 | 3 | 6 |
| Volatile | 3 | 3 | 6 |
| **Core** | **9** | **9** | **18** |
| Outage extension | +3 | +3 | +6 |
| **With outage** | **12** | **12** | **24** |

Use repeat IDs `r1`, `r2`, `r3`. “Repeat” means a fresh browser context/player instance and restarted trace, not replaying the same in-memory player.

### 6.2 Fixed randomized order

Generated once with seed `20261109`, then frozen:

- Block r1: `C-G, D-V, C-V, D-S, C-S, D-G`
- Block r2: `C-V, D-G, C-S, D-V, C-G, D-S`
- Block r3: `C-S, D-S, C-G, D-G, C-V, D-V`

`D` = default, `C` = conservative, `S/G/V` = trace. If outage is included, insert `C-O,D-O` after r1, `D-O,C-O` after r2, and `C-O,D-O` after r3. The outage extension must be identified as planned-before-running or exploratory; do not add it only after seeing favorable core results.

Before counted runs, perform one discarded unshaped warm-up for each policy and one full dry-run cell per policy. Dry runs must go into `results/dry-run/`, never the counted data directory.

## 7. Validity and reproducibility controls

### 7.1 Media and player controls

1. Same exact master manifest and segment bytes for both policies; store SHA-256 hashes.
2. Four or more aligned video levels, same codec/audio, same keyframe and segment boundaries. Verify with `ffprobe`/playlist checks.
3. Pin hls.js version/commit and dependency lockfile. Record browser binary/version and repository commit in every run.
4. The only intentional player difference is ABR selection. Buffer sizes, startup, retry, timeout, level caps, worker setting, and error recovery stay equal.
5. Log resolved hls.js configuration for both policies and diff it automatically. An allowed-difference list contains only policy/controller parameters.
6. Disable service workers and browser HTTP cache; serve media with `Cache-Control: no-store`; use a fresh browser context per counted run.
7. No manual input, seek, pause, tab hiding, sleep, or quality selection. Keep machine on AC power, disable sleep, close background transfers, and use the same host/interface.

### 7.2 Network controls

1. Commit resolved trace JSON and SHA-256; never edit a trace after counted runs begin.
2. Start shaper and `play_request` on shared run zero; require ≤100 ms skew.
3. Before the matrix, run a backlogged calibration transfer through every trace. For nonzero plateaus, achieved one-second median throughput must be within ±10% of target after a one-second settling allowance; transition timing must be within ±0.5 s. Otherwise fix the shaper and recalibrate.
4. Log shaper target, counters, and achieved segment throughput. Do not claim target capacity was achieved merely because a command succeeded.
5. Shape only the media path (or prove all policies see the same shaped path). Control/UI traffic must not unexpectedly consume the shaped link.
6. Fix delay and loss at the trace values. The core comparison should use zero random loss; if random impairments are added, seed them and create a separate experiment.

### 7.3 Run inclusion rules

- **Harness-invalid, rerun and retain original:** trace not applied, start skew >100 ms, logger coverage <95%, browser automation crash, manual action, wrong build/hash, missing core event table.
- **Valid experimental outcome, do not replace:** player never starts under the correctly applied trace, fatal hls.js error, inability to recover, premature end, or timeout caused by the policy/network interaction.
- Never delete an unfavorable run. Add `superseded_by_run_id` only for a documented harness-invalid rerun.
- The analysis script must reject duplicate run IDs, unknown schema versions, non-monotonic event sequence numbers, and mismatched hashes.

## 8. Data contracts

### 8.1 Repository result layout

```text
results/
  dry-run/
  raw/<run_id>/
    run.json
    events.ndjson
    samples.csv
    fragments.csv
    network.csv
    console.log
  summary/
    runs.csv
    cells.csv
    paired_deltas.csv
    reaction_anchors.csv
    validation_report.json
  figures/
```

Large media assets should use Git LFS or a release artifact with a hash; do not put large binaries in ordinary Git history. Raw experiment logs should be immutable after data freeze.

### 8.2 `run.json` required schema

| Group | Required fields |
|---|---|
| identity | `schema_version`, `run_id`, `policy_id`, `trace_id`, `repeat_id`, `order_index`, `status` |
| provenance | `git_commit`, `hlsjs_version`, `browser_version`, `os`, `player_build_sha256`, `manifest_sha256`, `ladder_sha256`, `trace_sha256`, `analysis_version` |
| parameters | complete resolved hls.js config, conservative parameters, hard timeout, sample rate, media URL/duration, cache flags |
| timing | `run_zero_epoch_ms`, `trace_actual_start_epoch_ms`, `play_request_epoch_ms`, `start_skew_ms`, terminal time/reason |
| integrity | filenames, byte sizes, SHA-256 for all per-run artifacts, `superseded_by_run_id` if applicable |

### 8.3 `events.ndjson`

One JSON object per line:

```json
{
  "schema_version": "1.0",
  "run_id": "D-V-r2",
  "seq": 147,
  "t_rel_ms": 30251.42,
  "epoch_ms": 1794200000000.42,
  "media_s": 24.108,
  "source": "hls",
  "event": "FRAG_LOADING",
  "payload": {"request_id":"main-7-a1","type":"main","sn":7,"level":2,"start_s":28,"duration_s":4}
}
```

`seq` must be contiguous and `t_rel_ms` nondecreasing. Unknown fields may be added, but required fields cannot change without a schema-version bump and Member 2 + Member 3 approval.

### 8.4 `fragments.csv`

Required columns:

`run_id,request_id,attempt,type,sn,part,media_start_s,duration_s,level,bitrate_bps,width,height,t_request_ms,t_first_byte_ms,t_load_end_ms,t_buffered_ms,bytes_loaded,effective_throughput_bps,aborted,error,played_t_ms`

`effective_throughput_bps = 8 × bytes_loaded / [(t_load_end_ms − t_request_ms)/1000]`; this includes request latency and is therefore an application-effective rate. If a first-byte rate is also wanted, add a separately named field—do not overwrite this definition.

### 8.5 `samples.csv` and `network.csv`

`samples.csv`:

`run_id,seq,t_rel_ms,media_s,buffer_ahead_s,buffer_ranges_json,paused,seeking,ended,ready_state,network_state,playback_rate,current_level,next_auto_level,hls_bw_estimate_bps,document_visibility`

`network.csv`:

`run_id,seq,t_rel_ms,epoch_ms,target_capacity_bps,delay_ms,loss_pct,bytes_since_last,measured_bps,anchor_id,shaper_state`

### 8.6 Per-run summary (`summary/runs.csv`)

Required columns:

`run_id,policy_id,trace_id,repeat_id,order_index,valid_harness,started,completed,terminal_reason,startup_delay_s,rebuffer_count,rebuffer_duration_s,rebuffer_ratio,tw_bitrate_kbps,tw_bitrate_prefix_kbps,prefix_only,switch_count,up_switch_count,down_switch_count,switches_per_min,switch_magnitude_kbps,buffer_mean_s,buffer_p05_s,low_buffer_fraction,reaction_anchor_n,reaction_median_s,reaction_worst_s,played_media_s,wall_session_s,start_skew_ms,sample_coverage,raw_sha256`

Use empty/`NA`, never zero, for not-applicable or unobserved measurements.

### 8.7 Cell and paired summary schemas

`cells.csv` has one row per policy × trace × metric:

`policy_id,trace_id,metric,unit,n_valid,values_json,median,min,max,mean,sample_sd,n_complete`

`paired_deltas.csv` has one row per trace × repeat × metric:

`trace_id,repeat_id,metric,default_value,conservative_value,delta_c_minus_d,improvement_signed`

For lower-is-better metrics, `improvement_signed = default − conservative`; for higher-is-better metrics, it is `conservative − default`. Store both raw delta and direction-normalized improvement to prevent sign mistakes.

## 9. Statistical reporting with only three repeats

Three repeats are enough to expose basic consistency but too few for persuasive distributional inference. Use descriptive, paired reporting:

1. **Always show all three run-level points.** Never show only bars.
2. **Primary cell summary:** median and full `[min, max]` range.
3. **Secondary familiar summary:** mean and sample standard deviation (`n−1` denominator), clearly labelled; do not draw 95% confidence intervals from `n=3`.
4. **Primary comparison:** paired deltas for matching trace + repeat IDs, followed by median paired delta and its full range.
5. **Direction consistency:** say `3/3`, `2/3`, etc. Do not call it statistically significant.
6. **Completion:** exact `x/3`; if any run is incomplete, quality metrics from the observed prefix remain separate and are not silently pooled with complete runs.
7. **Zero baselines:** report absolute differences; do not calculate percentage improvement when default rebuffer duration is zero.
8. **Multiplicity:** no composite “winner” score unless weights were fixed before data collection. Keep stalls, bitrate, startup, switches, reaction, and completion separate.
9. **Representative run selection:** for time-series figures, choose the run whose total rebuffer duration is the cell median; break ties by median time-weighted bitrate, then lowest repeat ID. State this rule before plotting.
10. **Language:** “observed in these three runs” and “directionally consistent” are acceptable; “proves,” “always,” and population-level causal claims are not.

## 10. Chart set

### 10.1 Full analysis set

1. **System/trace diagram:** server → shaper → hls.js player → event logger → reducer.
2. **Trace + behavior small multiples:** x = wall time; panels for target/achieved throughput and played bitrate, buffer occupancy, and stall shading. One preselected representative run per policy for `gradual` and `volatile`.
3. **Rebuffer duration paired dot/slope plot:** all three paired repeats per trace; facet by trace.
4. **Rebuffer event count paired dot plot:** integer y-axis.
5. **Time-weighted bitrate paired dot/slope plot:** complete runs only.
6. **Startup delay paired dot plot.**
7. **Switch count and switch magnitude:** two compact panels.
8. **Reaction-time anchor plot:** each anchor as a dot; policy color; censored observations shown with arrows, proactive-safe values at zero.
9. **Buffer safety:** paired `buffer_p05_s` plus optional occupancy empirical CDF in appendix.
10. **Trade-off scatter:** x = median rebuffer duration, y = median time-weighted bitrate; label policy/trace; completion shown by point shape.
11. **Completion table:** `x/3` plus terminal reasons; a table is clearer than a percentage bar.

Every quantitative chart must show units, `n`, policy, trace, and whether it uses complete runs only. Use the same policy colors everywhere. Show target capacity as a step/ramp and achieved throughput as a separate line—never label one as the other.

### 10.2 Twelve-minute presentation story (720 seconds)

| Slide | Time | Story and evidence |
|---|---:|---|
| 1. Question + stakes | 0:45 | “Can a conservative client reduce stalls under changing bandwidth, and what quality does it give up?” Identify policies; label predictions as hypotheses. |
| 2. How adaptive streaming works | 1:15 | Segment ladder, throughput estimate, buffer, ABR choice; explain the quality–stall trade-off. |
| 3. Controlled experiment | 1:30 | Architecture, fixed variables, three traces, 18 core runs. State optional outage separately. |
| 4. Measurement rules | 1:15 | Define startup, rebuffer, played bitrate, switches, buffer, reaction, completion in one visual. |
| 5. One trace, two behaviors | 2:00 | Gradual or volatile time-series figure: capacity → requests/played levels → buffer → stalls. Explain mechanism, not just totals. |
| 6. Main outcomes | 2:00 | Paired rebuffer and bitrate figures with all three points; report median/range and completion. |
| 7. Adaptation behavior | 1:30 | Reaction time, switches, and low-buffer evidence; connect behavior to outcomes. |
| 8. Trade-off + limitations | 1:15 | Trade-off scatter; only three repeats, one asset/browser/machine, emulation not the public Internet. |
| 9. Answer | 0:30 | One sentence on where conservative helped/hurt, one quantified trade-off, one future step. |

If results do not match H1–H4, present that discrepancy as the finding. Do not redesign the hypothesis slide after seeing data.

## 11. Acceptance criteria

### 11.1 Apparatus acceptance before counted runs

- [ ] Frozen media has ≥4 aligned levels, fixed segment duration, validated playlists, and committed hashes.
- [ ] Stock mode uses the pinned hls.js default ABR config; an automated config diff proves only allowed fields differ in conservative mode.
- [ ] All four core metric fixtures pass: no-stall, startup-only waiting, two post-start stalls, retry/duplicate fragment.
- [ ] Completion fixture distinguishes real end from premature `ended`/fatal/timeout.
- [ ] Buffer sampler reaches ≥95% coverage with no >500 ms gaps in dry runs.
- [ ] All mandatory hls.js/DOM events and fragment fields are present.
- [ ] Every core trace passes throughput/timing calibration tolerances.
- [ ] Two end-to-end dry runs (one per policy) produce validator-clean raw and summary files.

### 11.2 Dataset acceptance

- [ ] Exactly 18 valid core outcomes exist: 2 policies × 3 traces × 3 repeats. If outage is included, exactly 24 outcomes exist.
- [ ] Harness-invalid attempts remain archived and point to reruns; valid player failures remain counted.
- [ ] Every counted run references the same approved media/player/trace versions except the declared policy field.
- [ ] `validation_report.json` reports zero schema, hash, sequence, clock, and matrix errors.
- [ ] All summaries regenerate from raw data with one command at the data-freeze commit.
- [ ] Every result sentence can be traced to a summary row and every summary row to immutable raw files.

### 11.3 Preregistered policy targets (not project-pass conditions)

The study is successful even if the conservative policy misses these targets; an honest negative result is valid. The conservative design target is:

- no lower completion count on any core trace;
- positive median paired improvement in rebuffer duration on both `gradual` and `volatile`;
- no more than 20% lower median time-weighted bitrate on `stable`;
- no more than +0.5 s median startup-delay penalty;
- no slower median reaction time at adverse anchors;
- at least 2/3 paired runs in the expected direction for each claimed benefit.

Do not convert these engineering targets into claims of statistical significance.

## 12. GitHub collaboration foundation

### 12.1 Repository structure and ownership

```text
media/ scripts/ server/       # Member 1
network/ traces/              # Member 1
player/ policies/ logger/     # Member 2
schemas/                      # Members 2 + 3 contract
analysis/ orchestration/      # Member 3
results/summary/ figures/     # Member 3
results/raw/                  # immutable after freeze; generated by matrix
slides/ docs/                 # Member 3, with all-team content review
.github/                      # shared
```

Suggested `CODEOWNERS` (replace placeholders with actual GitHub handles):

```text
/media/          @asadullah
/server/         @asadullah
/network/        @asadullah
/traces/         @asadullah
/player/         @susmoy
/policies/       @susmoy
/logger/         @susmoy
/schemas/        @susmoy @miraj
/analysis/       @miraj
/orchestration/  @miraj
/docs/           @miraj
/slides/         @miraj
/.github/        @asadullah @susmoy @miraj
```

Ownership means first reviewer and contract responsibility, not exclusive permission. Anyone may contribute through PRs.

### 12.2 Branch and commit rules

- Protect `main`; no direct pushes, no force-pushes, no committed secrets.
- No permanent `develop` branch. Use short-lived branches from updated `main`.
- Branches: `feat/m1-media-ladder`, `feat/m1-trace-runner`, `feat/m2-player-logger`, `feat/m2-conservative-abr`, `feat/m3-analysis`, `docs/m3-slides`, `fix/m2-stall-state`.
- One concern per PR; target ≤400 reviewable changed lines excluding generated manifests/lockfiles.
- Conventional commits: `feat(player): ...`, `fix(network): ...`, `test(analysis): ...`, `docs(protocol): ...`, `chore(media): ...`.
- Rebase/update from `main` before requesting final review; squash-merge; delete branch after merge.
- Never rewrite a merged commit or data-freeze tag.

### 12.3 PR contract and review routing

Every PR body must contain:

1. **Purpose / linked issue**
2. **Files and ownership areas touched**
3. **Contract or schema impact:** `none`, backward-compatible, or breaking
4. **How tested:** exact command and observed result
5. **Evidence:** sample log/chart/screenshot where applicable
6. **Handoff:** inputs, outputs, paths, version, known limitations
7. **Checklist:** lint/test/build/validator, no large accidental files, docs updated

Review rules:

- At least one non-author approval and green required checks for every PR.
- Cross-boundary PRs require the owner of every affected interface. Examples: logger schema requires Members 2 and 3; player/trace start handshake requires Members 1 and 2; analysis assumptions about trace anchors require Members 1 and 3.
- Breaking `/schemas` changes require Members 2 and 3 plus one migration fixture.
- Data-freeze and final-slide PRs require all three approvals.
- Reviewer checks behavior and contract, not only style. Author resolves every comment or records an agreed follow-up issue.

Required CI on PRs:

- formatting/lint;
- player unit tests and production build;
- trace-schema validation;
- synthetic event-fixture reducer tests;
- raw→summary reproducibility smoke test;
- forbidden large-file/secret scan;
- documentation link check if available.

### 12.4 Issue and decision practice

- One issue per deliverable, assigned to one owner, with `depends on` links and acceptance checklist.
- Labels: `area:media`, `area:network`, `area:player`, `area:analysis`, `area:slides`, `contract`, `blocked`, `experiment`, `bug`.
- Record irreversible choices—ladder, hls.js version, sample rate, trace schedule, metric definitions—in short decision records under `docs/decisions/ADR-xxx.md`.
- A contract change after Milestone 0 must identify affected raw data. After data freeze, it requires a new dataset version rather than silently rerunning selected cells.

## 13. Handoff contracts

### 13.1 Media contract — Member 1 → Members 2 and 3

Deliver:

- manifest URL/path and local server start command;
- `ladder.json`: level index, nominal and average bitrate, width, height, codec, frame rate;
- content duration, segment target/actual duration distribution, keyframe alignment report;
- manifest/segment hash manifest and license/source note;
- cache/CORS headers and playlist-validation output.

Acceptance by Member 2: all levels play in the pinned browser and map exactly to hls.js level indexes. Acceptance by Member 3: ladder and hash files are machine-readable and sufficient to calculate played bitrate.

### 13.2 Network contract — Member 1 → Members 2 and 3

Deliver:

- versioned trace schema, resolved traces, and hashes;
- `arm(run_id, trace_id, run_zero_epoch_ms)`, `status(run_id)`, and `stop(run_id)` interface or equivalent CLI;
- target/actual `network.csv` writer;
- cleanup that restores the host interface even after failure;
- calibration report and start-skew evidence.

Acceptance by Member 2: a player run sees the intended transitions without affecting control traffic. Acceptance by Member 3: trace start and anchors align with browser events and validator tolerances.

### 13.3 Player/logger contract — Member 2 → Members 1 and 3

Deliver:

- one build with runtime `policy_id`, never two drifting player builds;
- exact launch URL/CLI and a machine-readable `ready` signal;
- stock default and documented conservative algorithm/parameters;
- complete `events.ndjson`, `samples.csv`, and `fragments.csv` output;
- fatal/nonfatal error handling and terminal reason;
- fixture tests for startup/stall/switch/retry/completion semantics.

Acceptance by Member 1: media and traces work without player-specific manual steps. Acceptance by Member 3: files pass schema validation and reproduce expected metrics from fixtures.

### 13.4 Evidence contract — Member 3 → all

Deliver:

- protocol version and matrix manifest before counted runs;
- raw-data validator and one-command reducer;
- deterministic chart script with representative-run selection rule;
- data-freeze manifest containing every run/artifact hash;
- results table where every claim cites a metric/figure;
- 12-minute deck, source list, speaker assignments, and timed rehearsal notes.

Acceptance by Members 1 and 2: networking and player mechanisms are represented accurately; figures can be regenerated from the tagged commit.

## 14. Dependency-aware milestones

| Milestone/tag | Lead | Depends on | Exit gate |
|---|---|---|---|
| M0 `v0.1-contracts` | Miraj coordinates; all approve | repo created | Protocol, schemas, run IDs, trace derivation, ownership, and ADRs merged. No counted code required. |
| M1 `v0.2-media-network` | Asadullah | M0 schema/IDs | Frozen media + ladder, server, resolved traces, shaper, cleanup, calibration all pass. |
| M2 `v0.3-player` | Susmoy | M0 schemas + M1 media contract | One selectable build, both policies, complete logger, fixture tests, stock-config proof. |
| M3 `v0.4-end-to-end` | Miraj | M1 + M2 | Two policy dry runs validate; reducer and charts regenerate; run-order manifest frozen. |
| M4 `v0.5-data-freeze` | Miraj runs; all witness/review | M3 | 18 core outcomes (or 24 declared), validation clean, hashes committed, no selective reruns. |
| M5 `v1.0-presentation` | Miraj coordinates | M4 | Final charts, claims review, limitations, source slide, 12-minute timed rehearsal, backup demo/video. |

No member should wait idle for a full upstream milestone. Member 3 can build validators from synthetic fixtures while Member 1 creates media; Member 2 can build against a temporary test stream, but M2 acceptance requires the frozen M1 media contract.

## 15. Step-by-step member work plans

### 15.1 Member 1 — Asadullah Galib: media + networking

1. **Create media/network issues and ADR proposals.** Inputs: M0 protocol. Output: ladder/segment/server/shaper choices. Done when all three approve the contracts.
2. **Select and document a legally usable source clip.** Record duration, resolution, frame rate, audio, and source/license. Do not choose content after observing ABR results.
3. **Build the reproducible encoding script.** Produce ≥4 H.264/AAC HLS representations with aligned keyframes and fixed target segment duration; keep command/config in Git.
4. **Validate media.** Check playlist syntax, segment counts/durations, decode/playback, keyframe alignment, and level metadata. Generate `ladder.json` and SHA-256 manifest.
5. **Build the local HTTP server.** Correct MIME/CORS, `Cache-Control: no-store`, deterministic URL paths, health endpoint, and documented launch/stop commands.
6. **Compile normalized trace definitions against the frozen ladder.** Resolve capacities, generate reaction anchors, validate no gaps/overlap, and hash each trace.
7. **Implement the shaper controller.** Provide arm/status/stop, shared run-zero timing, per-transition logs, and `finally`/signal cleanup that removes shaping.
8. **Calibrate every trace.** Run backlogged transfers, produce target-versus-achieved plots/tables, and meet ±10% rate/±0.5 s transition gates. Fix rather than waive unexplained failures.
9. **Publish M1 handoff PR.** Include exact commands, sample artifacts, calibration, known limits, and media/network contract version. Request Susmoy + Miraj reviews.
10. **Support integration.** Verify player traffic uses the shaped path, investigate network anomalies, and sign off the data-freeze trace/hash manifest.
11. **Presentation contribution.** Own the architecture/trace explanation and limitations of emulation; provide one clean trace diagram and a 60–90 s speaking segment.

Dependencies: steps 3–4 precede final trace resolution; steps 6–8 precede counted runs; Member 2 needs step 4, and Member 3 needs steps 4 and 8.

### 15.2 Member 2 — Susmoy L: player + adaptation

1. **Pin the player toolchain and hls.js build.** Commit lockfile/version and expose version/config in `run.json`.
2. **Implement one experiment page/build.** Runtime parameters select `default` or `conservative`, trace ID, run ID, and run zero. Prevent source prefetch before run zero.
3. **Establish the untouched baseline.** Instantiate stock hls.js ABR defaults. Add an automated resolved-config snapshot so “default” is auditable.
4. **Specify the conservative policy before results.** Document estimator window, safety factor, up/down hysteresis, minimum dwell, startup level, and fallback behavior. Keep non-ABR settings equal.
5. **Implement the conservative policy behind the same interface.** Log every decision: inputs, estimate, buffer, candidate, selected level, and reason.
6. **Implement raw instrumentation.** DOM lifecycle, all required hls.js events, 4 Hz samples, fragment attempts/timings, level metadata, hls bandwidth estimate, and errors. Use contiguous sequence numbers and monotonic timestamps.
7. **Implement terminal handling/export.** Flush artifacts atomically on end/fatal/timeout; incomplete runs must still export valid partial logs and reason.
8. **Build event fixtures/tests.** Cover startup waiting, short ignored wait, two stalls, duplicate waiting, fragment retry, level request not played, switch, premature end, and fatal error.
9. **Integrate M1 contracts.** Verify all frozen levels, manifest hash, cache behavior, shared run-zero, and shaped-media path.
10. **Publish M2 handoff PR.** Include launch command/URL, policy parameters, config diff, fixture output, sample raw files, and known limitations. Request Asadullah + Miraj reviews.
11. **Support dry run/data freeze.** Diagnose player errors without changing policy parameters after counted runs begin. Any required change creates a new protocol/dataset version.
12. **Presentation contribution.** Own the player/ABR and reaction-mechanism explanation; provide pseudocode and a 60–90 s speaking segment.

Dependencies: logger fields depend on M0 schemas; final level mapping depends on M1 media; counted runs depend on M1 trace start and M3 validator acceptance.

### 15.3 Member 3 — Miraj: evidence + analysis + presentation

1. **Freeze the protocol and terminology.** Turn this framework into issues, ADRs, metric fixtures, and matrix manifest; explicitly label hypotheses.
2. **Own machine-readable schemas.** Define `run.json`, NDJSON/CSV schemas, enums, units, NA behavior, versioning, and validator error messages with Susmoy.
3. **Create synthetic raw fixtures before real runs.** Hand-construct known startup/stall/switch/buffer/reaction/completion cases and expected summaries.
4. **Implement the validator and reducer.** One command validates matrix/provenance/timing/hashes and emits all summary tables. Unit-test formulas and direction signs.
5. **Implement deterministic charts.** Read summaries only, show all repeats, apply fixed colors/order/representative-run rule, and write figure metadata.
6. **Build the orchestrator/run manifest.** Encode fixed order, fresh contexts, arm/ready/start/stop handshakes, artifact collection, and rerun lineage.
7. **Conduct two-policy end-to-end dry runs.** Confirm contracts with Members 1 and 2; keep dry data separate. Open issues for failures rather than patching around them in analysis.
8. **Run the counted matrix exactly once per valid cell.** Monitor only validity signals. For harness-invalid attempts, preserve and rerun; for valid poor outcomes, do not replace.
9. **Freeze and audit data.** Generate artifact hashes, validation report, summary regeneration log, and `v0.5-data-freeze` PR. Require all-team approval.
10. **Analyze without overclaiming.** Produce raw-point and paired-delta figures, completion reasons, hypothesis table, and limitations. Keep prefix-only quality separate.
11. **Build the 12-minute deck.** Use the timed story, speaker handoffs, sources, and result-to-figure traceability. Keep backup detail charts outside the main nine-slide flow.
12. **Rehearse and revise delivery, not results.** Run at least two timed rehearsals; cut low-value detail to reach 12:00. Prepare a local backup recording and static figures.

Dependencies: analysis scaffolding can start at M0; real reducer acceptance needs M2 sample logs; counted orchestration needs M1 shaper and M2 player; slides with findings wait for data freeze.

## 16. Integration runbook

1. Pull tagged/approved M1 and M2 artifacts; ensure clean working tree.
2. Start media server; verify health and manifest hash.
3. Start shaper service; verify unshaped cleanup state.
4. Start player/orchestrator; verify exact git commit, browser, hls.js, schemas.
5. Create run manifest entry and future run zero.
6. Arm shaper and player; require both ready acknowledgements.
7. Execute run; do not interact with browser.
8. Stop/cleanup shaper in all terminal paths.
9. Validate artifact hashes, events, timing, coverage, and matrix identity immediately.
10. If harness-invalid, archive and create linked rerun ID. If valid outcome, accept it even if poor.
11. After each repeat block, back up raw files read-only. Do not inspect comparative result plots until all core runs are collected unless needed to debug a validity failure.
12. At matrix completion, run one-command validation/reduction, open data-freeze PR, and obtain all three reviews.

## 17. Result-writing template

Use this pattern after data freeze:

> Under **[trace]**, the conservative policy had median total rebuffer duration **[C median, range] s** versus **[D median, range] s** for stock hls.js across **3 paired runs**; the paired improvements were **[three values] s**. Its median time-weighted played bitrate was **[C] kbps** versus **[D] kbps**, and completion was **[x/3]** versus **[y/3]**. This is **[consistent/not consistent]** with H1, but with only three repeats it is descriptive evidence for this setup, not a population-level significance claim.

Keep “hypothesis,” “observed result,” and “interpretation” in separate sentences.

## Sources

[1] https://www.itu.int/rec/dologin_pub.asp?id=T-REC-P.1203-201710-I!!PDF-E&lang=e&type=items — ITU-T Recommendation P.1203 (10/2017)
[2] https://hlsjs.video-dev.org/api-docs/hls.js.events — hls.js Events enum
[3] https://hlsjs.video-dev.org/api-docs/hls.js.fragbuffereddata — hls.js FragBufferedData interface
[4] https://hlsjs.video-dev.org/api-docs/hls.js.level — hls.js Level class
[5] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/waiting_event — MDN: HTMLMediaElement waiting event
[6] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playing_event — MDN: HTMLMediaElement playing event
[7] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/buffered — MDN: HTMLMediaElement buffered property
[8] https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/ended_event — MDN: HTMLMediaElement ended event
[9] https://developer.mozilla.org/en-US/docs/Web/API/Performance/now — MDN: Performance.now()
[10] https://web.stanford.edu/class/cs244/papers/videostreaming-sigcomm2015.pdf — Yin et al., A Control-Theoretic Approach for Dynamic Adaptive Video Streaming over HTTP
[11] https://www.man7.org/linux/man-pages/man8/netem.8.html — tc-netem(8) Linux manual page
[12] https://hlsjs.video-dev.org/api-docs/hls.js.hls — hls.js Hls class
