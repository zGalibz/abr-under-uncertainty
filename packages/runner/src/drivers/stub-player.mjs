// Stub player driver: a tiny Node.js stand-in for Susmoy's browser player.
//
// It speaks the same protocol the real player must speak (POST /start,
// fetch the run-scoped HLS over the shaped server, POST /events in batches,
// POST /finish), always plays the lowest level, and emits contract-valid
// telemetry. It exists so the runner can be tested end to end against
// Galib's real server before the real player exists. It is NOT an ABR policy
// and its numbers mean nothing.

const SAMPLE_MS = 250;
const MAX_BUFFER_SEC = 10;
const BATCH = 200; // contracts/openapi.yaml EventBatch maxItems

function parseMaster(text) {
  const levels = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) return;
    const attr = (k) => line.match(new RegExp(`${k}=("[^"]*"|[^,]*)`))?.[1]?.replaceAll('"', '');
    const [width, height] = attr('RESOLUTION').split('x').map(Number);
    levels.push({ uri: lines[i + 1].trim(), width, height, bitrateBps: Number(attr('BANDWIDTH')), averageBitrateBps: Number(attr('AVERAGE-BANDWIDTH')) || null, codecs: attr('CODECS') });
  });
  return levels.map((l, level) => ({ level, ...l }));
}

function parseMedia(text) {
  const segments = [];
  let start = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXTINF:')) return;
    const duration = Number(line.slice(8).split(',')[0]);
    segments.push({ sn: segments.length, uri: lines[i + 1].trim(), startSec: start, durationSec: duration });
    start += duration;
  });
  return segments;
}

export async function playStub({ apiBase, runId, maxWallMs = 240000 }) {
  const t0 = performance.now();
  const now = () => performance.now() - t0 + 1; // player clock, ms
  const events = [];
  const emit = (type, data, mediaTimeSec) => {
    const e = { schemaVersion: '1.0.0', runId, source: 'player', seq: events.length, type, clientMonoMs: Math.round(now() * 1000) / 1000, clientEpochMs: Date.now() };
    if (mediaTimeSec !== undefined) e.mediaTimeSec = Math.round(mediaTimeSec * 1000) / 1000;
    e.data = data;
    events.push(e);
  };
  const post = async (pathname, body) => {
    const res = await fetch(`${apiBase}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };

  emit('client.ready', { userAgent: 'stub-player/1.0', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, hlsJsVersion: '1.7.4' });
  const start = await post(`/api/v1/runs/${runId}/start`, { clientSendEpochMs: Date.now(), clientSendMonoMs: now() });
  const masterUrl = `${apiBase}${start.hlsUrl}`;
  const levels = parseMaster(await (await fetch(masterUrl)).text());
  emit('hls.manifest_parsed', { levels: levels.map(({ uri, ...l }) => l), firstLevel: 0 });
  const level = levels[0];
  const mediaUrl = new URL(level.uri, masterUrl);
  const segments = parseMedia(await (await fetch(mediaUrl)).text());
  const durationSec = segments.reduce((s, x) => s + x.durationSec, 0);

  emit('media.play_requested', { muted: true, autoplay: true });
  emit('media.waiting', { readyState: 0, forwardBufferSec: 0 }, 0);

  let bufferEnd = 0;
  let currentTime = 0;
  let playing = false;
  let stalled = false;
  let ended = false;
  let shown = 0;
  const buffered = [];

  // Playback clock: advances media time while playing, 4 Hz samples.
  let last = now();
  const tick = () => {
    const t = now();
    const dt = (t - last) / 1000;
    last = t;
    if (playing && !stalled && !ended) {
      currentTime = Math.min(currentTime + dt, bufferEnd);
      if (currentTime >= durationSec - 1e-6) {
        ended = true;
        emit('media.ended', { durationSec }, durationSec);
        emit('media.pause', { reason: 'ended' }, durationSec);
        return;
      }
      if (currentTime >= bufferEnd - 1e-6) {
        stalled = true;
        emit('media.waiting', { readyState: 2, forwardBufferSec: 0 }, currentTime);
      }
    }
    while (playing && shown < buffered.length && currentTime >= buffered[shown].startSec) {
      const f = buffered[shown];
      emit('hls.frag_changed', { level: 0, sn: f.sn, startSec: f.startSec, durationSec: f.durationSec, bitrateBps: level.bitrateBps, width: level.width, height: level.height }, currentTime);
      shown += 1;
    }
    emit('media.sample', { currentTimeSec: Math.round(currentTime * 1000) / 1000, readyState: playing && !stalled ? 4 : 2, forwardBufferSec: Math.round(Math.max(0, bufferEnd - currentTime) * 1000) / 1000, paused: false, seeking: false, playbackRate: 1 }, currentTime);
  };
  const timer = setInterval(tick, SAMPLE_MS);

  // Download loop: one fragment at a time, lowest level only.
  try {
    for (const seg of segments) {
      while (bufferEnd - currentTime > MAX_BUFFER_SEC) await new Promise((r) => setTimeout(r, 50));
      const loadStart = now();
      emit('hls.frag_loading', { level: 0, sn: seg.sn, startSec: seg.startSec, durationSec: seg.durationSec, urlPath: new URL(seg.uri, mediaUrl).pathname });
      const res = await fetch(new URL(seg.uri, mediaUrl));
      const firstByte = now();
      const bytes = (await res.arrayBuffer()).byteLength;
      const loadEnd = now();
      emit('hls.frag_loaded', { level: 0, sn: seg.sn, bytes, loadStartMs: loadStart, firstByteMs: firstByte, loadEndMs: loadEnd });
      emit('hls.frag_buffered', { level: 0, sn: seg.sn, bytes, bandwidthEstimateBps: (8 * bytes) / Math.max(0.001, (loadEnd - loadStart) / 1000) });
      buffered.push(seg);
      bufferEnd += seg.durationSec;
      if (!playing) {
        playing = true;
        last = now();
        emit('media.playing', { readyState: 4, forwardBufferSec: bufferEnd }, 0);
      } else if (stalled) {
        stalled = false;
        last = now();
        emit('media.playing', { readyState: 4, forwardBufferSec: bufferEnd - currentTime }, currentTime);
      }
      if (now() > maxWallMs) break;
    }
    while (!ended && now() < maxWallMs) await new Promise((r) => setTimeout(r, 50));
  } finally {
    clearInterval(timer);
  }
  const reason = ended ? 'ended' : 'timeout';
  emit('client.finished', { reason, droppedVideoFrames: 0, totalVideoFrames: Math.round(currentTime * 30) });
  for (let i = 0; i < events.length; i += BATCH) await post(`/api/v1/runs/${runId}/events`, { events: events.slice(i, i + BATCH) });
  await post(`/api/v1/runs/${runId}/finish`, {
    reason,
    lastSeq: events.length - 1,
    clientSummary: { startupDelayMs: 0, rebufferCount: 0, rebufferDurationMs: 0, droppedVideoFrames: 0, totalVideoFrames: Math.round(currentTime * 30) },
  });
  return { reason, events: events.length };
}

// Driver wrapper so the runner can use the stub exactly like a browser.
export function createStubDriver() {
  return {
    name: 'stub',
    async start() { return { browserVersion: 'stub-player/1.0' }; },
    async openSession({ url }) {
      const u = new URL(url);
      const session = { consoleLines: [], failure: null };
      session.done = playStub({ apiBase: u.searchParams.get('api'), runId: u.searchParams.get('runId'), maxWallMs: Number(u.searchParams.get('maxWallMs') ?? 240000) })
        .then((r) => session.consoleLines.push(`stub finished: ${r.reason}, ${r.events} events`))
        .catch((e) => { session.failure = `stub player error: ${e.message}`; });
      session.close = async () => { await session.done; };
      return session;
    },
    async stop() {},
  };
}
