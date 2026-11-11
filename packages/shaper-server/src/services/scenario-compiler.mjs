import { sha256Canonical } from '../domain/canonical-json.mjs';

const scheduler = Object.freeze({ scope: 'per-run-aggregate-media-body', discipline: 'work-conserving-fifo', initialTokensBytes: 0, maxBurstBytes: 16384, maxChunkBytes: 4096 });

function safeBetween(lowerPeak, upperPeak) {
  const lower = lowerPeak / 0.85;
  const upper = upperPeak / 0.85;
  const kbps = Math.floor(((lower + upper) / 2) / 1000);
  if (0.85 * kbps * 1000 < lowerPeak || 0.85 * kbps * 1000 >= upperPeak) throw new Error('unable to derive safe threshold rate');
  return kbps;
}

function scenario(id, description, phases) {
  return { schemaVersion: '1.0.0', id, description, status: 'frozen', clock: 'server-monotonic-since-run-start', rateUnit: 'decimal-kbit-per-second', responseStartDelayMs: 20, scheduler: { ...scheduler }, phases };
}

function anchors(phases) {
  const result = [];
  for (let index = 1; index < phases.length; index += 1) {
    const from = phases[index - 1]; const to = phases[index];
    result.push({ id: `${to.id}-anchor`, atMs: to.startMs, kind: to.downlinkKbps < from.downlinkKbps ? 'adverse' : 'recovery', fromPhaseId: from.id, toPhaseId: to.id, fromKbps: from.downlinkKbps, toKbps: to.downlinkKbps });
  }
  return result;
}

export function compileScenarioSet({ packageManifest, packageManifestSha256 }) {
  const renditions = [...packageManifest.renditions].sort((a, b) => a.id.localeCompare(b.id));
  if (renditions.length !== 4 || renditions.map((item) => item.id).join(',') !== 'v0,v1,v2,v3') throw new Error('scenario compilation requires v0 through v3');
  const peak = renditions.map((item) => item.measuredPeakBps);
  if (peak.some((value, index) => !Number.isSafeInteger(value) || value <= 0 || (index > 0 && value <= peak[index - 1]))) throw new Error('rendition peaks must strictly increase');
  const top = Math.ceil((peak[3] / 0.85 * 1.25) / 1000);
  const v2 = safeBetween(peak[2], peak[3]);
  const v1 = safeBetween(peak[1], peak[2]);
  const v0 = safeBetween(peak[0], peak[1]);
  const severe = Math.max(1, Math.floor((peak[0] / 0.85 * 0.75) / 1000));
  const scenarios = new Map();
  scenarios.set('stable-v1', scenario('stable-v1', 'Stable capacity with headroom above the highest measured rendition.', [{ id: 'high', startMs: 0, downlinkKbps: top }]));
  scenarios.set('gradual-v1', scenario('gradual-v1', 'Measured-ladder congestion steps followed by recovery.', [
    { id: 'high', startMs: 0, endMs: 20000, downlinkKbps: top },
    { id: 'v2-safe', startMs: 20000, endMs: 40000, downlinkKbps: v2 },
    { id: 'v1-safe', startMs: 40000, endMs: 60000, downlinkKbps: v1 },
    { id: 'v0-safe', startMs: 60000, endMs: 80000, downlinkKbps: v0 },
    { id: 'severe', startMs: 80000, endMs: 100000, downlinkKbps: severe },
    { id: 'recovery', startMs: 100000, downlinkKbps: top },
  ]));
  scenarios.set('volatile-v1', scenario('volatile-v1', 'Repeated measured-ladder capacity oscillations and final recovery.', [
    { id: 'high-1', startMs: 0, endMs: 12000, downlinkKbps: top },
    { id: 'v0-safe-1', startMs: 12000, endMs: 24000, downlinkKbps: v0 },
    { id: 'v2-safe-1', startMs: 24000, endMs: 36000, downlinkKbps: v2 },
    { id: 'severe-1', startMs: 36000, endMs: 48000, downlinkKbps: severe },
    { id: 'high-2', startMs: 48000, endMs: 60000, downlinkKbps: top },
    { id: 'v0-safe-2', startMs: 60000, endMs: 72000, downlinkKbps: v0 },
    { id: 'v2-safe-2', startMs: 72000, endMs: 84000, downlinkKbps: v2 },
    { id: 'severe-2', startMs: 84000, endMs: 96000, downlinkKbps: severe },
    { id: 'recovery', startMs: 96000, downlinkKbps: top },
  ]));
  const manifest = { schemaVersion: '1.0.0', packageManifestSha256, scenarios: [...scenarios.values()].map((value) => ({ id: value.id, path: `configs/scenarios/${value.id.replace('-v1', '.v1')}.json`, sha256: sha256Canonical(value), anchors: anchors(value.phases) })) };
  return { scenarios, manifest };
}
