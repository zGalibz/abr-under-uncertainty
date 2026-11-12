// Metric reducer: turns one run's raw player events into the run-level
// metrics defined in docs/PROJECT_DESIGN.md §10 and
// docs/research/experiment-and-team-framework.md §4.
//
// Every metric is recomputed from raw events here. The client summary the
// player sends at finish time is only a cross-check, never the source.

import { median, percentile } from './stats.mjs';

export const STALL_MIN_MS = 250; // a waiting interval shorter than this is not a stall
export const CONFIRM_WINDOW_MS = 500; // a `playing` event must be followed by real progress within this window
export const CONFIRM_PROGRESS_SEC = 0.05;
export const LOW_BUFFER_SEC = 0.5;
export const MAX_SAMPLE_GAP_MS = 500;
export const EVAL_SAFETY_FACTOR = 0.85; // γ_eval used only to place reaction anchors

const t = (e) => e.clientMonoMs;

// A `playing` event counts only if the media clock really advances afterwards
// (not paused, not seeking, currentTime +0.05 s within 500 ms).
function isConfirmedPlaying(events, i) {
  const p = events[i];
  const from = p.mediaTimeSec ?? 0;
  for (let j = i + 1; j < events.length && t(events[j]) <= t(p) + CONFIRM_WINDOW_MS; j += 1) {
    const e = events[j];
    if (e.type !== 'media.sample') continue;
    if (!e.data.paused && !e.data.seeking && e.data.currentTimeSec >= from + CONFIRM_PROGRESS_SEC) return true;
  }
  return false;
}

export function ladderFromEvents(events) {
  let levels = null;
  for (const e of events) {
    if (e.type === 'hls.manifest_parsed' || e.type === 'hls.levels_updated') levels = e.data.levels;
  }
  return levels ? [...levels].sort((a, b) => a.level - b.level) : [];
}

// Highest level whose peak bitrate fits inside γ × capacity, or −1 if none fits.
function safeLevel(ladder, capacityBps) {
  let safe = -1;
  for (const l of ladder) if (l.bitrateBps <= EVAL_SAFETY_FACTOR * capacityBps) safe = Math.max(safe, l.level);
  return safe;
}

// Reaction anchors come from Galib's scenario manifest (configs/scenarios/
// manifest.json). Only "adverse" anchors where the safe level actually drops
// are scored. The safe level uses the same γ = 0.85 rule Galib's trace
// compiler used, applied to the measured peak bitrates. Anchors are
// evaluator metadata only; neither ABR policy ever sees them.
export function anchorsFor(scenarioEntry, ladder) {
  if (!scenarioEntry || ladder.length === 0) return [];
  const phases = scenarioEntry.scenario.phases;
  return scenarioEntry.anchors
    .filter((a) => a.kind === 'adverse')
    .map((a) => {
      const safeBefore = safeLevel(ladder, a.fromKbps * 1000);
      const safeAfter = safeLevel(ladder, a.toKbps * 1000);
      return {
        anchor_id: a.id,
        t_rel_ms: a.atMs,
        plateau_end_ms: phases.find((p) => p.id === a.toPhaseId)?.endMs ?? null,
        capacity_before_bps: a.fromKbps * 1000,
        capacity_after_bps: a.toKbps * 1000,
        safe_level_before: safeBefore,
        safe_level_after: safeAfter,
        // When nothing is safe (−1) the best a policy can do is the lowest level.
        target_level: Math.max(safeAfter, 0),
      };
    })
    .filter((a) => a.safe_level_after < a.safe_level_before);
}

function findTerminal(events) {
  const ended = events.find((e) => e.type === 'media.ended');
  const fatal = events.find((e) => e.type === 'media.error' || (e.type === 'hls.error' && e.data.fatal));
  const finished = events.find((e) => e.type === 'client.finished');
  const candidates = [ended, fatal, finished].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (t(a) <= t(b) ? a : b));
}

function reduceStartup(events) {
  const reqIndex = events.findIndex((e) => e.type === 'media.play_requested');
  if (reqIndex < 0) return { tRequest: null, firstPlayIndex: -1 };
  for (let i = reqIndex + 1; i < events.length; i += 1) {
    if (events[i].type === 'media.playing' && isConfirmedPlaying(events, i)) {
      return { tRequest: t(events[reqIndex]), firstPlayIndex: i };
    }
  }
  return { tRequest: t(events[reqIndex]), firstPlayIndex: -1 };
}

// Stall state machine (design §7.2): open on post-start `waiting` while
// playback is intended, ignore duplicate `waiting`, close on confirmed
// `playing`, keep only intervals ≥ 250 ms, censor intervals still open at
// the terminal event.
function reduceStalls(events, firstPlayIndex, tTerminal) {
  const stalls = [];
  let open = null;
  let paused = false;
  let seeking = false;
  let rate = 1;
  let duplicateWaiting = 0;
  let debounced = 0;
  for (let i = firstPlayIndex + 1; i < events.length; i += 1) {
    const e = events[i];
    if (t(e) > tTerminal) break;
    if (e.type === 'media.pause') paused = true;
    else if (e.type === 'media.play_requested') paused = false;
    else if (e.type === 'media.seeking') seeking = true;
    else if (e.type === 'media.seeked') seeking = false;
    else if (e.type === 'media.rate_changed') rate = e.data.playbackRate;
    else if (e.type === 'media.waiting') {
      if (open) duplicateWaiting += 1;
      else if (!paused && !seeking && rate > 0) open = { startMs: t(e), mediaTimeSec: e.mediaTimeSec };
    } else if (e.type === 'media.playing' && open && isConfirmedPlaying(events, i)) {
      paused = false;
      const durationMs = t(e) - open.startMs;
      if (durationMs >= STALL_MIN_MS) stalls.push({ ...open, endMs: t(e), durationMs, censored: false });
      else debounced += 1;
      open = null;
    }
  }
  if (open) {
    const durationMs = tTerminal - open.startMs;
    if (durationMs >= STALL_MIN_MS) stalls.push({ ...open, endMs: tTerminal, durationMs, censored: true });
  }
  return { stalls, duplicateWaiting, debounced };
}

function mediaReachedSec(events, completed) {
  const ended = events.find((e) => e.type === 'media.ended');
  if (completed && ended) return ended.data.durationSec;
  let reached = 0;
  for (const e of events) {
    if (e.type === 'media.sample') reached = Math.max(reached, e.data.currentTimeSec);
    else if (typeof e.mediaTimeSec === 'number') reached = Math.max(reached, e.mediaTimeSec);
  }
  return reached;
}

// Played fragments come from FRAG_CHANGED (what was actually shown), not
// from what was requested or downloaded.
function reducePlayedFragments(events, ladder, reachedSec) {
  const bySn = new Map();
  for (const e of events) if (e.type === 'hls.frag_changed') bySn.set(e.data.sn, e.data);
  const levelBitrate = new Map(ladder.map((l) => [l.level, l.averageBitrateBps ?? l.bitrateBps]));
  return [...bySn.values()]
    .map((f) => {
      const playedSec = Math.max(0, Math.min(f.startSec + f.durationSec, reachedSec) - f.startSec);
      return { ...f, playedSec, bitrateUsedBps: levelBitrate.get(f.level) ?? f.bitrateBps };
    })
    .filter((f) => f.playedSec > 0)
    .sort((a, b) => a.startSec - b.startSec);
}

function reduceSwitches(played) {
  let up = 0;
  let down = 0;
  let magnitudeBps = 0;
  for (let i = 1; i < played.length; i += 1) {
    const prev = played[i - 1];
    const cur = played[i];
    if (cur.level === prev.level) continue;
    if (cur.bitrateUsedBps > prev.bitrateUsedBps) up += 1;
    else down += 1;
    magnitudeBps += Math.abs(cur.bitrateUsedBps - prev.bitrateUsedBps);
  }
  return { up, down, magnitudeBps };
}

// Buffer occupancy as a left-constant integral over 4 Hz samples between
// first playback and the terminal event. Also measures sample coverage.
function reduceBuffer(events, tFirst, tTerminal) {
  const samples = events.filter((e) => e.type === 'media.sample' && t(e) >= tFirst && t(e) <= tTerminal);
  const windowMs = tTerminal - tFirst;
  if (samples.length === 0 || windowMs <= 0) {
    return { mean: null, p05: null, lowFraction: null, coverage: samples.length ? 1 : 0, gaps: 0 };
  }
  let weighted = 0;
  let total = 0;
  let low = 0;
  let covered = Math.min(t(samples[0]) - tFirst, MAX_SAMPLE_GAP_MS);
  let gaps = t(samples[0]) - tFirst > MAX_SAMPLE_GAP_MS ? 1 : 0;
  samples.forEach((s, j) => {
    const next = j + 1 < samples.length ? t(samples[j + 1]) : tTerminal;
    const dt = next - t(s);
    const b = s.data.forwardBufferSec;
    weighted += b * dt;
    total += dt;
    if (b < LOW_BUFFER_SEC) low += dt;
    covered += Math.min(dt, MAX_SAMPLE_GAP_MS);
    if (dt > MAX_SAMPLE_GAP_MS) gaps += 1;
  });
  return {
    mean: total > 0 ? weighted / total : null,
    p05: percentile(samples.map((s) => s.data.forwardBufferSec), 0.05),
    lowFraction: total > 0 ? low / total : null,
    coverage: Math.min(1, covered / windowMs),
    gaps,
  };
}

const SEGMENT_PATH = /(?:^|\/)v(\d+)\/seg_(\d+)\.ts$/;

// Media requests from server-requests.ndjson, timed on the server's
// scenario clock (acceptedAtRunMs), so no client/server clock mapping is
// needed for reaction time.
export function mediaRequests(serverRequests) {
  return (serverRequests ?? [])
    .filter((r) => r.method === 'GET' && SEGMENT_PATH.test(r.path))
    .map((r) => {
      const [, level, sn] = r.path.match(SEGMENT_PATH);
      const complete = !r.aborted && (r.status === 200 || r.status === 206) && r.bodyBytesWritten === r.representationBytes;
      return { level: Number(level), sn: Number(sn), atMs: r.acceptedAtRunMs, complete };
    })
    .sort((a, b) => a.atMs - b.atMs);
}

// Reaction time per anchor (framework §4.6): time from the capacity drop to
// the first media request at or below the new safe level that completed and
// was buffered by the player.
//
// Statuses: ok (reacted, or 0 s when already safe), censored (requests were
// made during the low plateau but none reached the safe level before it
// ended), not_exposed (no media request at all during the plateau: the buffer
// was full or the whole clip was already downloaded, so the policy never had
// to choose a level under the new capacity), not_reached (run ended first).
// Only ok and censored anchors are scored; framework §4.6 does not cover the
// not_exposed case, which the dry runs showed is common (stock hls.js fetched
// the whole 128 s clip within ~70 s on the volatile trace).
function reduceReactions(events, anchors, run, serverRequests, terminalRunMs) {
  if (anchors.length === 0 || !serverRequests) return [];
  const requests = mediaRequests(serverRequests);
  const buffered = new Set(events.filter((e) => e.type === 'hls.frag_buffered').map((e) => `${e.data.level}:${e.data.sn}`));
  const results = [];
  for (const a of anchors) {
    const base = { run_id: run.runId, ...a };
    if (terminalRunMs < a.t_rel_ms) {
      results.push({ ...base, status: 'not_reached', level_pre: null, reaction_s: null, censored: false, proactive_or_already_safe: false });
      continue;
    }
    const plateauEnd = Math.min(a.plateau_end_ms ?? Infinity, terminalRunMs);
    const pre = requests.filter((r) => r.atMs < a.t_rel_ms).at(-1);
    if (pre && pre.level <= a.target_level) {
      results.push({ ...base, status: 'ok', level_pre: pre.level, reaction_s: 0, censored: false, proactive_or_already_safe: true });
      continue;
    }
    const during = requests.filter((r) => r.atMs >= a.t_rel_ms && r.atMs < plateauEnd);
    if (during.length === 0) {
      results.push({ ...base, status: 'not_exposed', level_pre: pre?.level ?? null, reaction_s: null, censored: false, proactive_or_already_safe: false });
      continue;
    }
    const hit = during.find((r) => r.level <= a.target_level && r.complete && buffered.has(`${r.level}:${r.sn}`));
    results.push(hit
      ? { ...base, status: 'ok', level_pre: pre?.level ?? null, reaction_s: (hit.atMs - a.t_rel_ms) / 1000, censored: false, proactive_or_already_safe: false }
      : { ...base, status: 'censored', level_pre: pre?.level ?? null, reaction_s: null, censored: true, proactive_or_already_safe: false });
  }
  return results;
}

// The player's clock reading when the server's scenario clock started.
// The player sends clientSendMonoMs with /start and the server fixes run zero
// on receipt; on loopback the gap is a few ms, so this is used only to place
// client events on the scenario time axis (charts, "anchor reached" checks).
export const clientMonoAtRunZero = (run) => run.startRequest?.clientSendMonoMs ?? null;

export function reduceRun({ run, events: unsorted, serverRequests }, ctx) {
  const events = [...unsorted].sort((a, b) => a.seq - b.seq);
  const { ladder } = ctx;
  const anchors = anchorsFor(ctx.scenarios.get(run.scenarioId), ladder);
  const finished = events.find((e) => e.type === 'client.finished');
  const terminal = findTerminal(events);
  const tTerminal = terminal ? t(terminal) : (events.at(-1) ? t(events.at(-1)) : 0);
  const completed = Boolean(events.find((e) => e.type === 'media.ended')) && finished?.data.reason === 'ended';

  const { tRequest, firstPlayIndex } = reduceStartup(events);
  const started = firstPlayIndex >= 0;
  const tFirst = started ? t(events[firstPlayIndex]) : null;

  const stallInfo = started ? reduceStalls(events, firstPlayIndex, tTerminal) : { stalls: [], duplicateWaiting: 0, debounced: 0 };
  const rebufferMs = stallInfo.stalls.reduce((s, x) => s + x.durationMs, 0);
  const sessionAfterStartSec = started ? (tTerminal - tFirst) / 1000 : null;

  const reachedSec = mediaReachedSec(events, completed);
  const played = reducePlayedFragments(events, ladder, reachedSec);
  const playedSec = played.reduce((s, f) => s + f.playedSec, 0);
  const twBitrateKbps = playedSec > 0 ? played.reduce((s, f) => s + f.bitrateUsedBps * f.playedSec, 0) / playedSec / 1000 : null;
  const sw = reduceSwitches(played);

  const buffer = started ? reduceBuffer(events, tFirst, tTerminal) : { mean: null, p05: null, lowFraction: null, coverage: null, gaps: 0 };
  const zero = clientMonoAtRunZero(run);
  const reactions = reduceReactions(events, anchors, run, serverRequests, zero === null ? Infinity : tTerminal - zero);
  const scored = reactions.filter((r) => r.status === 'ok' || r.status === 'censored');
  const reactionValues = scored.filter((r) => !r.censored).map((r) => r.reaction_s);

  const metrics = {
    run_id: run.runId,
    policy_id: run.policyId,
    trace_id: run.scenarioId,
    repeat_id: run.repetition,
    started,
    completed,
    terminal_reason: finished?.data.reason ?? 'missing',
    startup_delay_s: started ? (tFirst - tRequest) / 1000 : null,
    rebuffer_count: started ? stallInfo.stalls.length : null,
    rebuffer_duration_s: started ? rebufferMs / 1000 : null,
    rebuffer_ratio: started && sessionAfterStartSec > 0 ? rebufferMs / 1000 / sessionAfterStartSec : null,
    rebuffer_censored_n: stallInfo.stalls.filter((s) => s.censored).length,
    tw_bitrate_kbps: completed ? twBitrateKbps : null,
    tw_bitrate_prefix_kbps: completed ? null : twBitrateKbps,
    prefix_only: !completed,
    switch_count: started ? sw.up + sw.down : null,
    up_switch_count: started ? sw.up : null,
    down_switch_count: started ? sw.down : null,
    switches_per_min: playedSec > 0 ? (60 * (sw.up + sw.down)) / playedSec : null,
    switch_magnitude_kbps: started ? sw.magnitudeBps / 1000 : null,
    buffer_mean_s: buffer.mean,
    buffer_p05_s: buffer.p05,
    low_buffer_fraction: buffer.lowFraction,
    reaction_anchor_n: anchors.length ? scored.length : null,
    reaction_censored_n: anchors.length ? scored.filter((r) => r.censored).length : null,
    reaction_not_exposed_n: anchors.length ? reactions.filter((r) => r.status === 'not_exposed').length : null,
    reaction_median_s: reactionValues.length ? median(reactionValues) : null,
    reaction_worst_s: reactionValues.length ? Math.max(...reactionValues) : null,
    played_media_s: playedSec,
    wall_session_s: finished && tRequest !== null ? (t(finished) - tRequest) / 1000 : null,
    start_skew_ms: null, // needs server logs (Galib's server-requests.ndjson); not available yet
    sample_coverage: buffer.coverage,
  };

  return {
    metrics,
    detail: {
      stalls: stallInfo.stalls,
      duplicateWaiting: stallInfo.duplicateWaiting,
      debouncedWaiting: stallInfo.debounced,
      sampleGaps: buffer.gaps,
      played,
      anchors,
      reactions,
      ladder,
      tFirstPlayMs: tFirst,
      tTerminalMs: tTerminal,
    },
  };
}
