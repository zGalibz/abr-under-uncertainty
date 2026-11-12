import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerController, DEFAULT_POLICY_ID } from '../src/player-controller.js';
import { POLICY_ID } from '../src/policy/conservative.js';
import { TelemetryClient } from '../src/telemetry.js';

class FakeHls {
  static isSupported() { return true; }
  static version = '1.7.4';
  static Events = { MANIFEST_PARSED: 'manifest', LEVELS_UPDATED: 'levels', LEVEL_SWITCHING: 'switching', LEVEL_SWITCHED: 'switched', FRAG_LOADING: 'loading', FRAG_LOADED: 'loaded', FRAG_BUFFERED: 'buffered', FRAG_CHANGED: 'changed', ERROR: 'error' };
  static ErrorDetails = { BUFFER_STALLED_ERROR: 'bufferStalledError' };
  constructor(config) { this.config = config; this.handlers = new Map(); this.bandwidthEstimate = 2_000_000; this._loadLevel = -1; this.writes = [];
    for (const control of ['currentLevel', 'nextLevel', 'loadLevel', 'nextLoadLevel', 'nextAutoLevel', 'bandwidthEstimate', 'autoLevelCapping']) {
      const backing = `_${control}`; this[backing] = control === 'loadLevel' ? -1 : this[control];
      Object.defineProperty(this, control, { configurable: true, get: () => this[backing], set: (value) => { this.writes.push({ control, value }); this[backing] = value; } });
    } }
  on(event, handler) { this.handlers.set(event, handler); }
  off(event) { this.handlers.delete(event); }
  emit(event, data) { this.handlers.get(event)?.(event, data); }
  loadSource(url) { this.url = url; }
  attachMedia(video) { this.video = video; }
  destroy() { this.destroyed = true; }
}

class FakeVideo {
  constructor() { this.listeners = new Map(); this.currentTime = 0; this.readyState = 4; this.paused = false; this.seeking = false; this.ended = false; this.playbackRate = 1; this.muted = false; this.autoplay = false; this.duration = 20; this.buffered = { length: 1, start: () => 0, end: () => 10 }; }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  removeEventListener(event) { this.listeners.delete(event); }
  emit(event) { this.listeners.get(event)?.(); }
  async play() { this.emit('play'); }
  getVideoPlaybackQuality() { return { droppedVideoFrames: 0, totalVideoFrames: 12 }; }
}

const levels = [
  { bitrate: 596000, averageBitrate: 580000, width: 640, height: 360, codecs: 'avc1.64001e,mp4a.40.2' },
  { bitrate: 996000, averageBitrate: 980000, width: 854, height: 480, codecs: 'avc1.64001e,mp4a.40.2' },
];
function makeTelemetry() { const events = []; return { events, client: new TelemetryClient({ runId: 'r_017f22e2-79b0-7cc3-98c4-dc0c0c07398f', batchSize: 200, flushIntervalMs: 60_000, onEvent: (event) => events.push(event), transport: { appendEvents: async () => ({ accepted: 1 }) } }) }; }

test('default policy preserves stock automatic ABR and does not write forbidden manual controls', async () => {
  const video = new FakeVideo(); const { client, events } = makeTelemetry(); const controller = new PlayerController({ HlsClass: FakeHls, video, telemetry: client });
  await controller.start({ manifestUrl: '/stream/v1/r_x/master.m3u8', policyId: DEFAULT_POLICY_ID }); const hls = controller.hls; hls.writes = [];
  hls.emit(FakeHls.Events.MANIFEST_PARSED, { levels, firstLevel: 0 });
  hls.emit(FakeHls.Events.FRAG_BUFFERED, { frag: { type: 'main', sn: 0, level: 0, duration: 2 }, stats: { loaded: 1000, loading: { start: 0, end: 1000 } } });
  assert.equal(hls.config.startLevel, -1); assert.equal(hls.config.capLevelToPlayerSize, false); assert.deepEqual(hls.writes, []);
  assert.equal(events.some((event) => event.type === 'abr.decision'), false); controller.destroy(); await client.close();
});

test('custom policy enters manual mode through loadLevel and cleanup unregisters listeners', async () => {
  const video = new FakeVideo(); const { client, events } = makeTelemetry(); const controller = new PlayerController({ HlsClass: FakeHls, video, telemetry: client });
  await controller.start({ manifestUrl: '/stream/v1/r_x/master.m3u8', policyId: POLICY_ID }); const hls = controller.hls;
  hls.emit(FakeHls.Events.MANIFEST_PARSED, { levels, firstLevel: 0 });
  assert.deepEqual(hls.writes, [{ control: 'loadLevel', value: 0 }]); assert.equal(events.at(-1).type, 'abr.decision');
  hls.emit(FakeHls.Events.LEVEL_SWITCHING, { level: 0, ...levels[0] }); hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 0, ...levels[0] });
  assert.equal(events.some((event) => event.type === 'hls.level_switching'), true); assert.equal(events.some((event) => event.type === 'hls.level_switched'), true);
  controller.destroy(); assert.equal(hls.destroyed, true); assert.equal(hls.handlers.size, 0); await client.close();
});

class FakeDocument {
  constructor(visibilityState = 'visible') { this.visibilityState = visibilityState; this.listeners = new Map(); }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  removeEventListener(event) { this.listeners.delete(event); }
  set(state) { this.visibilityState = state; this.listeners.get('visibilitychange')?.(); }
}

test('tab visibility changes are recorded as evidence, including a page hidden at start', async () => {
  const doc = new FakeDocument(); const video = new FakeVideo(); const { client, events } = makeTelemetry();
  const controller = new PlayerController({ HlsClass: FakeHls, video, telemetry: client, documentRef: doc });
  await controller.start({ manifestUrl: '/stream/v1/r_x/master.m3u8', policyId: DEFAULT_POLICY_ID });
  assert.equal(events.some((event) => event.type === 'client.visibility_changed'), false);
  doc.set('hidden'); doc.set('visible');
  assert.deepEqual(events.filter((event) => event.type === 'client.visibility_changed').map((event) => event.data.state), ['hidden', 'visible']);
  controller.destroy(); assert.equal(doc.listeners.size, 0); await client.close();

  const hiddenDoc = new FakeDocument('hidden'); const second = makeTelemetry();
  const hiddenStart = new PlayerController({ HlsClass: FakeHls, video: new FakeVideo(), telemetry: second.client, documentRef: hiddenDoc });
  await hiddenStart.start({ manifestUrl: '/stream/v1/r_x/master.m3u8', policyId: DEFAULT_POLICY_ID });
  assert.deepEqual(second.events.filter((event) => event.type === 'client.visibility_changed').map((event) => event.data.state), ['hidden']);
  hiddenStart.destroy(); await second.client.close();
});

test('client.finished is the last event: nothing is recorded after a terminal state', async () => {
  const doc = new FakeDocument(); const video = new FakeVideo(); const { client, events } = makeTelemetry();
  const controller = new PlayerController({ HlsClass: FakeHls, video, telemetry: client, documentRef: doc });
  await controller.start({ manifestUrl: '/stream/v1/r_x/master.m3u8', policyId: POLICY_ID }); const hls = controller.hls;
  hls.emit(FakeHls.Events.MANIFEST_PARSED, { levels, firstLevel: 0 });
  await controller.complete('timeout');
  assert.equal(events.at(-1).type, 'client.finished'); assert.equal(events.at(-1).data.reason, 'timeout');
  const count = events.length;
  hls.emit(FakeHls.Events.FRAG_LOADING, { frag: { type: 'main', sn: 9, level: 0, start: 18, duration: 2, url: 'http://127.0.0.1:8080/stream/v1/r_x/v0/seg_00009.ts' } });
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError' });
  video.emit('waiting'); video.emit('pause'); doc.set('hidden');
  assert.equal(events.length, count); assert.equal(hls.handlers.size, 0); assert.equal(video.listeners.size, 0);
  controller.destroy(); await client.close();
});

test('a fatal HLS error emits a terminal event and finalizes exactly once', async () => {
  const video = new FakeVideo(); const { client, events } = makeTelemetry(); let terminals = 0;
  const controller = new PlayerController({ HlsClass: FakeHls, video, telemetry: client, onTerminal: async () => { terminals += 1; } });
  await controller.start({ manifestUrl: '/stream/v1/r_x/master.m3u8', policyId: DEFAULT_POLICY_ID });
  controller.hls.emit(FakeHls.Events.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 500 } });
  await controller.terminalPromise; assert.equal(terminals, 1); assert.equal(events.at(-1).type, 'client.finished'); await client.close();
});
