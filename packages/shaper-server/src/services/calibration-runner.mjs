import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExperimentServer } from '../http/app.mjs';
import { sha256Canonical } from '../domain/canonical-json.mjs';

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

export function evaluateCalibration({ scenario, bins, writes, endMs = Math.max(...bins.map((bin) => bin.endMs), 0) }) {
  const plateaus = scenario.phases.map((phase, index) => {
    const phaseEnd = phase.endMs ?? endMs;
    const usable = bins.filter((bin) => bin.startMs >= phase.startMs + 1000 && bin.endMs <= phaseEnd);
    const measured = usable.length ? median(usable.map((bin) => bin.measuredKbps)) : 0;
    const relativeError = phase.downlinkKbps ? (measured - phase.downlinkKbps) / phase.downlinkKbps : 1;
    return { phaseId: phase.id, targetKbps: phase.downlinkKbps, medianMeasuredKbps: Math.round(measured * 1000) / 1000, relativeError, passed: usable.length >= 2 && Math.abs(relativeError) <= 0.10 };
  });
  const transitions = scenario.phases.slice(1).map((phase) => {
    const first = writes.find((record) => record.kind === 'write' && record.phaseId === phase.id && record.atRunMs >= phase.startMs);
    const errorMs = first ? first.atRunMs - phase.startMs : Number.POSITIVE_INFINITY;
    return { anchorId: `${phase.id}-anchor`, errorMs, passed: Number.isFinite(errorMs) && errorMs >= 0 && errorMs <= 500 };
  });
  return { id: scenario.id, passed: plateaus.every((item) => item.passed) && transitions.every((item) => item.passed), plateaus, transitions };
}

function scaledScenario(source, phaseDurationMs = 4000) {
  return {
    ...source,
    id: `${source.id}-calibration`, responseStartDelayMs: 20,
    phases: source.phases.map((phase, index) => ({ id: phase.id, startMs: index * phaseDurationMs, ...(index < source.phases.length - 1 ? { endMs: (index + 1) * phaseDurationMs } : {}), downlinkKbps: phase.downlinkKbps })),
  };
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

export async function calibrateScenario({ packageRoot, scenario, experiment, gitCommit, segmentPath = 'v3/seg_00000.ts' }) {
  const scaled = scaledScenario(scenario);
  const resultsRoot = await mkdtemp(path.join(os.tmpdir(), 'abr-calibration-'));
  const service = await createExperimentServer({ packageRoot, resultsRoot, scenarios: new Map([[scaled.id, scaled]]), experiment });
  try {
    const address = await service.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://${address.address}:${address.port}`;
    const run = await postJson(`${base}/api/v1/runs`, { requestId: randomUUID(), experimentId: experiment.id, scenarioId: scaled.id, policyId: 'default-hlsjs', repetition: 1, orderSeed: 0, clientLabel: 'calibration', gitCommit, gitDirty: true });
    const started = await postJson(`${base}/api/v1/runs/${run.runId}/start`, { clientSendEpochMs: Date.now(), clientSendMonoMs: performance.now() });
    const totalMs = scaled.phases.length * 4000;
    const byteBins = new Map();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), totalMs + 100);
    try {
      while (!controller.signal.aborted) {
        const response = await fetch(`${base}/stream/v1/${run.runId}/${segmentPath}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`calibration media response ${response.status}`);
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const runMs = Date.now() - started.serverRunStartEpochMs;
          if (runMs >= totalMs) { controller.abort(); break; }
          const bin = Math.floor(runMs / 1000);
          byteBins.set(bin, (byteBins.get(bin) ?? 0) + value.byteLength);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally { clearTimeout(timer); }
    await postJson(`${base}/api/v1/runs/${run.runId}/abort`, { reason: 'calibration_complete' });
    await service.close();
    const bins = [...byteBins].sort(([a], [b]) => a - b).map(([bin, bytes]) => ({ startMs: bin * 1000, endMs: (bin + 1) * 1000, measuredKbps: bytes * 8 / 1000 }));
    const schedulerPath = path.join(resultsRoot, run.runId, 'scheduler-writes.ndjson');
    const writes = (await readFile(schedulerPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    return { result: evaluateCalibration({ scenario: scaled, bins, writes, endMs: totalMs }), bins, writes };
  } finally {
    await service.close().catch(() => {});
    await rm(resultsRoot, { recursive: true, force: true });
  }
}

export function buildCalibrationReport({ gitCommit, scenarioManifestSha256, results }) {
  return { schemaVersion: '1.0.0', generatedAt: new Date().toISOString(), gitCommit, scenarioManifestSha256, valid: results.every((result) => result.passed), scenarios: results };
}

export const calibrationScenarioHash = (scenario) => sha256Canonical(scaledScenario(scenario));
