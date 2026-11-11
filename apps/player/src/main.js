import { LiveDashboard } from './dashboard.js';
import { BUILD_METADATA } from './build-metadata.js';
import { MockRunApi } from './mocks/mock-run-api.js';
import { PlayerController, POLICY_IDS } from './player-controller.js';
import { HttpRunApi, resolveRunHlsUrl } from './run-api.js';
import { TelemetryClient } from './telemetry.js';

const form = document.querySelector('#run-form');
const video = document.querySelector('#video');
const resetButton = document.querySelector('#reset');
const status = document.querySelector('#status');
const runId = document.querySelector('[data-run-id]');
const dashboard = new LiveDashboard(document.querySelector('#dashboard'));
let controller = null; let telemetry = null; let api = null; let previewTimer = null; let activeRun = null;

function requestId() { return crypto.randomUUID?.() || '00000000-0000-4000-8000-000000000000'; }
function setStatus(message, tone = 'neutral') { status.textContent = message; status.dataset.tone = tone; }
function setRun(run) { runId.textContent = run ? `${run.runId} · ${run.status}` : 'No run'; }
function selected(name) { return new FormData(form).get(name); }

async function createAndStartRun(useMock) {
  const serverBaseUrl = selected('server').trim() || BUILD_METADATA.serverBaseUrl;
  api = useMock ? new MockRunApi() : new HttpRunApi({ baseUrl: serverBaseUrl });
  const run = await api.createRun({ requestId: requestId(), experimentId: 'abr-under-uncertainty-v1', scenarioId: selected('scenario'), policyId: selected('policy'), repetition: 1, orderSeed: 20261109, clientLabel: 'browser-player', gitCommit: BUILD_METADATA.gitCommit, gitDirty: BUILD_METADATA.gitDirty });
  activeRun = run; setRun(run);
  let started;
  try { started = await api.startRun(run.runId, { clientSendEpochMs: Date.now(), clientSendMonoMs: performance.now() }); }
  catch (error) { await api.abortRun(run.runId, { reason: 'player failed to start run' }).catch(() => {}); activeRun = null; throw error; }
  setRun({ ...run, status: started.status }); return { run, started };
}

function createTelemetry(run, transport) {
  telemetry = new TelemetryClient({ runId: run.runId, transport, onEvent: (event) => dashboard.ingest(event) });
  telemetry.emit('client.ready', { userAgent: navigator.userAgent, hlsJsVersion: window.Hls?.version || '1.7.4', viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 } });
  return telemetry;
}

async function finalizeRun(run, reason, summary) {
  try {
    await telemetry.close();
    const finished = reason === 'aborted'
      ? await api.abortRun(run.runId, { reason: 'player reset or user abort' })
      : await api.finishRun(run.runId, { reason, lastSeq: Math.max(0, telemetry.nextSeq - 1), clientSummary: {
      startupDelayMs: Math.max(0, summary.startupDelayMs ?? 0), rebufferCount: summary.rebufferCount, rebufferDurationMs: summary.rebufferDurationMs,
      droppedVideoFrames: summary.droppedVideoFrames, totalVideoFrames: summary.totalVideoFrames,
      } });
    activeRun = null;
    setRun(finished); setStatus(`Run ${reason}: telemetry flushed and server finalization acknowledged.`, 'success');
  } catch (error) { setStatus(`Run is incomplete: telemetry or finalization failed (${error.message}).`, 'error'); }
}

async function startRealRun() {
  if (!window.Hls) throw new Error('Local hls.js bundle is missing. Run npm run build first.');
  const { run, started } = await createAndStartRun(false);
  createTelemetry(run, api);
  controller = new PlayerController({ HlsClass: window.Hls, video, telemetry, onState: (state) => dashboard.render(state), onTerminal: ({ reason, summary }) => finalizeRun(run, reason, summary) });
  try { await controller.start({ manifestUrl: resolveRunHlsUrl(started.hlsUrl, api.baseUrl), policyId: selected('policy') }); }
  catch (error) { await controller.complete('aborted'); throw error; }
  setStatus('Run started. Media was requested only after the lifecycle start response.', 'success');
}

async function startMockPreview() {
  const { run } = await createAndStartRun(true); const client = createTelemetry(run, api);
  setStatus('MOCK dashboard preview: synthetic events only; no video or experimental measurement.', 'warning');
  const levels = [{ level: 0, width: 640, height: 360, bitrateBps: 596000, averageBitrateBps: 580000, codecs: 'avc1.64001e,mp4a.40.2' }];
  client.emit('hls.manifest_parsed', { levels, firstLevel: 0 }); let time = 0;
  previewTimer = setInterval(() => {
    time += 0.25; client.emit('media.sample', { currentTimeSec: time, readyState: 4, forwardBufferSec: 6, paused: false, seeking: false, playbackRate: 1 }, time);
    dashboard.render({ runState: 'MOCK_PREVIEW', policyId: selected('policy'), requestedLevel: 0, effectiveLevel: 0, levels, forwardBufferSec: 6, hlsEstimateBps: 2_000_000, policy: null, stalls: { rebufferCount: 0, rebufferDurationMs: 0 }, resolvedConfig: { hlsJsVersion: '1.7.4', startLevel: -1, capLevelToPlayerSize: false } });
  }, 250);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault(); await reset(); setStatus('Creating run…');
  try { if (selected('source') === 'mock') await startMockPreview(); else await startRealRun(); }
  catch (error) { setStatus(`Could not start: ${error.message}`, 'error'); }
});

async function reset() {
  clearInterval(previewTimer); previewTimer = null;
  if (controller && !controller.finished) await controller.complete('aborted');
  if (controller) { controller.destroy(); controller = null; }
  if (!controller && activeRun && api) { try { await telemetry?.close(); await api.abortRun(activeRun.runId, { reason: 'player reset before playback' }); } catch { /* best-effort abort after an incomplete startup */ } }
  if (telemetry) { try { await telemetry.close(); } catch { /* status is already shown during terminal finalization */ } telemetry = null; }
  video.removeAttribute('src'); video.load(); activeRun = null; setRun(null); dashboard.render({ runState: 'IDLE', levels: [], stalls: {} });
}
resetButton.addEventListener('click', () => { void reset(); setStatus('Player reset.'); });
if (!POLICY_IDS.includes(selected('policy'))) throw new Error('invalid policy UI configuration');
dashboard.render({ runState: 'IDLE', levels: [], stalls: {} });
