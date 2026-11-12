# Results — `abr-under-uncertainty-v1`, dataset v1

Status: **data frozen, awaiting approval by all three members** (`v0.5-data-freeze`). Protocol: `docs/experiment-protocol.md` (committed and pushed before the first counted run). Every number below comes from `results/summary/` and can be regenerated with one command (§9).

## 1. The answer in one paragraph

Across 18 counted runs (2 policies × 3 traces × 3 repeats, all valid and complete), **neither policy stalled even once**. The conservative policy therefore had no stalls to prevent, and the main hypothesis (H1) is not supported. It still paid for its caution with a lower played bitrate in every one of the 9 paired comparisons: 384 kbit/s (11.6 %) lower on `stable-v1`, 355 kbit/s (14.8 %) on `gradual-v1` and 67 kbit/s (3.4 %) on `volatile-v1`. In exchange it started playback about 0.95 s sooner and kept about 2 s more minimum buffer (9/9 pairs each). Our interpretation: stock hls.js builds a deep buffer while bandwidth is high, and in these traces with this 128 s clip that buffer always outlasted the low-bandwidth phases, so the trade-off the hypotheses describe was never forced.

## 2. What was run

| Item | Value |
|---|---|
| Counted runs | 18 valid outcomes, 1 harness-invalid attempt (rerun), 0 rejected; matrix 18/18 complete |
| Order | `results/run-order.json` (seed 20261109), executed exactly in order |
| Session | 2026-11-12, 07:11–07:55 UTC, one uninterrupted session (43 min 40 s), one machine |
| Apparatus | every counted run records commit `082cff0`, clean; player bundle built from it; Chrome for Testing 153.0.8010.12; hls.js 1.7.4 |
| Rehearsals | 2 warm-ups (stable) and 2 dry runs (volatile), all valid, kept in `results/dry-run/` and never counted |
| Validation | `results/summary/validation_report.json` |
| Freeze | `results/data-freeze.json`: 19 runs, 77 raw files, 444.9 MB, SHA-256 of each; `npm run freeze -- --verify` |
| Raw archive | `abr-under-uncertainty-v1-raw.tar.gz`, 28.6 MB, SHA-256 `d882e2e3b3804fdccd3741de399a3545e208b2dcbfaade48b2067e95cec4f9d6` (kept outside git by Miraj) |

**The one harness-invalid attempt.** Cell #8 (`gradual-v1`, default, repeat 1), attempt 1 (`r_01a1cea7…`). The host's network changed briefly: Chrome logged `net::ERR_NETWORK_CHANGED` twice. hls.js reported the aborted load with response code 0, the player forwarded it as `httpStatus: 0`, and the telemetry schema allows only 100–599 or null. The server therefore rejected every telemetry batch (777 × HTTP 422). The run could not finalize, the runner's watchdog aborted it, and the validator classified it harness-invalid under the pre-registered rule. It stored no events at all, so it could not have influenced any result. The rerun (`r_01a1ceab…`) is valid, and the ledger records the lineage. The player bug was fixed after data collection (`3bd28d8`); dataset v1 used the unfixed apparatus throughout, and no other run saw a network change.

## 3. Results by trace

Primary summary: median [min, max] over 3 runs. Paired Δ = conservative − default for the same repeat. Mean and sample SD are in `results/summary/cells.csv`; every pair is in `results/summary/paired_deltas.csv`.

### `stable-v1` (7 045 kbit/s throughout)

| Metric | Default | Conservative | Paired Δ (repeats 1, 2, 3) | Conservative better |
|---|---|---|---|---|
| Rebuffer events | 0 [0, 0] | 0 [0, 0] | 0, 0, 0 | 0/3 (3 ties) |
| Played bitrate (kbit/s) | 3 319 [3 319, 3 319] | 2 936 [2 936, 2 936] | −384, −384, −384 | 0/3 |
| Startup (s) | 1.22 [1.17, 1.26] | 0.26 [0.25, 0.27] | −0.93, −0.99, −0.97 | 3/3 |
| Switches | 0 [0, 0] | 3 [3, 3] | +3, +3, +3 | 0/3 |
| Buffer p5 (s) | 3.85 [3.81, 4.03] | 6.07 [6.07, 6.08] | +2.26, +2.05, +2.22 | 3/3 |
| Completed | 3/3 | 3/3 | | |

Under `stable-v1`, the conservative policy had median total rebuffer duration 0.00 s [0.00, 0.00] versus 0.00 s [0.00, 0.00] for stock hls.js across 3 paired runs. Its median time-weighted played bitrate was 2 936 kbit/s versus 3 319 kbit/s, and completion was 3/3 versus 3/3. Stock hls.js played 1080p from the first segment to the last (3 319 kbit/s is exactly the 1080p rendition's measured average); the conservative policy started at 360p and climbed one rung at a time (3 up-switches).

### `gradual-v1` (7 045 → 4 408 → 2 409 → 1 292 → 711 kbit/s in 20 s steps, recovery at 100 s)

| Metric | Default | Conservative | Paired Δ (repeats 1, 2, 3) | Conservative better |
|---|---|---|---|---|
| Rebuffer events | 0 [0, 0] | 0 [0, 0] | 0, 0, 0 | 0/3 (3 ties) |
| Played bitrate (kbit/s) | 2 402 [2 386, 2 402] | 2 047 [2 047, 2 047] | −355, −355, −340 | 0/3 |
| Startup (s) | 1.18 [1.17, 1.26] | 0.26 [0.25, 0.27] | −0.91, −0.91, −1.01 | 3/3 |
| Switches | 3 [3, 3] | 5 [5, 5] | +2, +2, +2 | 0/3 |
| Buffer p5 (s) | 3.81 [3.80, 4.02] | 6.08 [6.07, 6.08] | +2.27, +2.28, +2.04 | 3/3 |
| Buffer mean (s) | 22.3 [22.3, 22.9] | 39.2 [39.2, 39.2] | +16.9, +16.8, +16.3 | 3/3 |
| Completed | 3/3 | 3/3 | | |

Under `gradual-v1`, the conservative policy had median total rebuffer duration 0.00 s [0.00, 0.00] versus 0.00 s [0.00, 0.00] for stock hls.js across 3 paired runs; the paired improvements were 0.00, 0.00 and 0.00 s. Its median time-weighted played bitrate was 2 047 kbit/s versus 2 402 kbit/s, and completion was 3/3 versus 3/3. This is not consistent with H1: there was no stall to reduce.

### `volatile-v1` (12 s plateaus alternating 7 045 / 1 292 / 4 408 / 711 kbit/s, recovery at 96 s)

| Metric | Default | Conservative | Paired Δ (repeats 1, 2, 3) | Conservative better |
|---|---|---|---|---|
| Rebuffer events | 0 [0, 0] | 0 [0, 0] | 0, 0, 0 | 0/3 (3 ties) |
| Played bitrate (kbit/s) | 1 975 [1 969, 1 975] | 1 908 [1 831, 1 908] | −62, −144, −67 | 0/3 |
| Startup (s) | 1.23 [1.18, 1.27] | 0.29 [0.26, 0.41] | −0.88, −1.01, −0.82 | 3/3 |
| Switches | 10 [10, 10] | 11 [11, 11] | +1, +1, +1 | 0/3 |
| Buffer p5 (s) | 3.86 [3.80, 4.04] | 6.07 [5.99, 6.11] | +2.31, +2.04, +2.13 | 3/3 |
| Buffer mean (s) | 26.3 [26.3, 26.7] | 33.7 [33.7, 33.9] | +6.9, +7.6, +7.3 | 3/3 |
| Completed | 3/3 | 3/3 | | |

Under `volatile-v1`, the conservative policy had median total rebuffer duration 0.00 s [0.00, 0.00] versus 0.00 s [0.00, 0.00] for stock hls.js across 3 paired runs; the paired improvements were 0.00, 0.00 and 0.00 s. Its median time-weighted played bitrate was 1 908 kbit/s versus 1 975 kbit/s, and completion was 3/3 versus 3/3. This is not consistent with H1.

Repeats were extremely consistent (most cells vary by well under 1 %), as expected from a deterministic local shaper; with only three repeats this shows repeatability of this setup, not a population effect.

## 4. Why nobody stalled (exploratory)

The diagnostics in this section were added after data collection and are **not pre-registered**: `download_end_s` and `media_mb` in `runs.csv`, both from the server's request log.

| Trace | Default: download finished (s) | Conservative: download finished (s) | Media fetched, default / conservative (MB) |
|---|---|---|---|
| stable | 61.9–62.2 | 54.3–54.5 | 53.5 / 46.8 |
| gradual | 95.1–96.2 | 55.5–55.6 | 38.6–38.9 / 32.8 |
| volatile | 73.4 | 59.1–65.1 | 32.7–32.9 / 29.3–30.8 |

Observation: both players fetched the whole 128 s clip long before it finished playing. The forward buffer peaked far above any low-bandwidth plateau (the time-series figures show 30–70 s), and stock hls.js kept about 30 s ahead even while `gradual-v1` fell to 711 kbit/s.

Interpretation: stock hls.js aims to buffer up to max(30 s, 60 MB ÷ level bitrate) ahead, which at these bitrates is more than the remaining clip, and the 7 Mbit/s opening phase of every trace fills that buffer quickly. Each later drop is shorter than the buffer it meets, so the default policy can stay at a high level and ride it out. Because the conservative policy chose lower levels, its smaller segments finished downloading sooner (55.6 s versus 96.2 s on `gradual-v1`). It was then no longer exposed to the late, harshest phases at all, which also explains its larger mean buffer.

## 5. Reaction to capacity drops (anchor level)

Per-anchor outcomes from `results/summary/reaction_anchors.csv` (3 runs each). Run-level `reaction_median_s` values are **not** compared between policies, because the two policies reacted at different anchors.

| Trace | Anchor (time, new capacity) | Default | Conservative |
|---|---|---|---|
| gradual | v2-safe (20 s, 4 408) | censored 3/3 (stayed at 1080p) | reacted 3/3, 3.8 s |
| gradual | v1-safe (40 s, 2 409) | censored 3/3 | reacted 3/3, 5.6–5.7 s |
| gradual | v0-safe (60 s, 1 292) | censored 3/3 | not exposed 3/3 (download finished) |
| gradual | severe (80 s, 711) | reacted 3/3, 2.8–3.6 s | not exposed 3/3 |
| volatile | v0-safe-1 (12 s, 1 292) | censored 3/3 | censored 3/3 |
| volatile | severe-1 (36 s, 711) | reacted 3/3, 10.0–11.3 s | censored 3/3 |
| volatile | v0-safe-2 (60 s, 1 292) | censored 3/3 | censored 2/3, not exposed 1/3 |
| volatile | severe-2 (84 s, 711) | not exposed 3/3 | not exposed 3/3 |

"Censored" means requests were made during the low plateau but none was at or below the strict safe level (peak ≤ 0.85 × capacity) before the plateau ended. "Not exposed" means no media request at all during the plateau. Where both policies were exposed, the conservative policy reached the safe level faster at two anchors (gradual 20 s and 40 s, 3/3 each) and slower at one (volatile 36 s, 3/3). Default's censored anchors did not cost it a stall: its buffer covered every plateau.

## 6. Hypotheses

| | Hypothesis (pre-registered) | Observation | Verdict |
|---|---|---|---|
| H1 | Conservative may reduce stalls during gradual and volatile drops | 0 stalls for both policies in all 12 gradual/volatile runs | **Not supported**: nothing to reduce |
| H2 | Any stall reduction may be paid for with lower bitrate or slower recovery | No stall reduction, yet lower bitrate in 9/9 pairs (−3.4 % to −14.8 %) and a slower climb to 1080p at start (about 22 s versus about 1 s) | **Cost observed without the benefit** |
| H3 | Both complete smoothly under stable bandwidth | 3/3 completed and 0 stalls for each policy | **Supported** |
| H4 | Volatility causes more switching and lower buffer safety than stable | Switches rose from 0 to 10 (default) and from 3 to 11 (conservative), and mean buffer fell (33.5→26.3 s, 39.8→33.7 s); buffer p5 and low-buffer fraction did not change (both set by the startup ramp) | **Partly consistent**, and not a clean test: `stable-v1` is much faster than volatile's average (§8) |

## 7. Pre-registered conservative-policy targets (framework §11.3)

| Target | Observed | Met |
|---|---|---|
| No lower completion on any trace | 3/3 versus 3/3 on every trace | Yes |
| Positive median paired rebuffer improvement on `gradual-v1` and `volatile-v1` | 0.00 s on both (no stalls) | **No** |
| At most 20 % lower median bitrate on `stable-v1` | 11.6 % lower (2 936 versus 3 319 kbit/s) | Yes |
| At most +0.5 s median startup penalty | 0.96 s *faster* (0.26 versus 1.22 s over all 9 runs each) | Yes |
| No slower median reaction at adverse anchors | Mixed: faster at 2 anchors, slower at 1, others censored or not exposed (§5) | **No** (not consistently) |
| At least 2/3 pairs in the expected direction for each claimed benefit | Startup 9/9, buffer p5 9/9; stalls 0/6 (all ties) | Only for the side benefits |

Missing these targets is a valid result, not a project failure (protocol §10).

## 8. Limitations

- **Three repeats per cell.** Results are descriptive ("observed in these three runs"); nothing here is a significance claim.
- **The traces never forced a stall.** With stock hls.js buffer settings and a 128 s clip, every low-bandwidth plateau was shorter than the buffer built before it, so the stall comparison is degenerate. A longer clip, longer or deeper low phases, or a capped buffer goal would test H1 properly; that would be a new dataset version, not a change to this one.
- **One clip, one browser, one machine.** Chrome 153 on Linux (WSL2) on one laptop; other content, browsers or devices may differ.
- **Local application-layer shaping.** The shaper limits media-body goodput on loopback; there is no packet loss, queueing delay or competing traffic. It is not the public Internet.
- **The stable trace is not a "similar average".** H4 compares volatile with a stable connection of similar average rate; `stable-v1` (7 045 kbit/s) is far faster than volatile's average (about 4 300 kbit/s over 128 s).
- **Bitrate is a quality proxy.** Time-weighted played bitrate is not perceived quality; there is no VMAF score or user study.
- **Reaction anchors are strict.** "Safe" means peak ≤ 0.85 × capacity. A policy with a deep buffer can stay above that level without risk, so a censored anchor is not by itself a failure.

## 9. Reproduce every number

```bash
npm ci
tar -xzf abr-under-uncertainty-v1-raw.tar.gz      # restores results/raw/ (git-ignored)
npm run freeze -- --verify                        # every raw file unchanged since the freeze
npm run analyze -- --order results/run-order.json # regenerates results/summary and results/figures
git diff --exit-code results/summary              # no output = identical
```

Running the analysis twice on the frozen data gives byte-identical summaries and figures.

## 10. Figures and tables

| File | Shows |
|---|---|
| `results/figures/traces.svg` | the three traces against the rendition ladder |
| `results/figures/timeseries_gradual-v1_*.svg`, `timeseries_volatile-v1_*.svg` | one representative run per policy and trace: configured capacity, achieved goodput, played bitrate, buffer, stalls |
| `results/figures/paired_rebuffer_duration_s.svg`, `paired_rebuffer_count.svg` | stalls (all zero) |
| `results/figures/paired_tw_bitrate_kbps.svg` | played bitrate, all 18 runs |
| `results/figures/paired_startup_delay_s.svg` | startup |
| `results/figures/paired_switch_count.svg`, `paired_switch_magnitude_kbps.svg` | switching |
| `results/figures/paired_buffer_p05_s.svg` | buffer safety |
| `results/figures/reaction_anchors.svg` | reaction per anchor |
| `results/figures/tradeoff.svg` | quality versus stalls |
| `results/summary/completion.csv` | completion 3/3 in every cell, all `ended` |
| `results/summary/runs.csv` | every run, including the harness-invalid attempt |
