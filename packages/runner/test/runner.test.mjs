// End-to-end runner test against Galib's real experiment server, a tiny
// ffmpeg-generated HLS package and the stub player. Needs ffmpeg on PATH
// (the CI workflow installs it).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadContext } from '../../analysis/src/context.mjs';
import { packageMedia } from '../../media-cli/src/package-hls.mjs';
import { sha256Canonical } from '../../shaper-server/src/domain/canonical-json.mjs';
import { createExperimentServer } from '../../shaper-server/src/http/app.mjs';
import { ServerApi } from '../src/api.mjs';
import { createStubDriver } from '../src/drivers/stub-player.mjs';
import { buildOrderDocument, writeOrFreezeOrder } from '../src/order.mjs';
import { LABELS, StopSession, runSchedule } from '../src/runner.mjs';

const exec = promisify(execFile);

// A complete miniature apparatus on disk: 6 s clip, one high-capacity trace,
// experiment config, scenario manifest; then Galib's server on top of it.
async function startApparatus(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abr-runner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mp4');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  await packageMedia({ source, output: path.join(root, 'media'), preset: 'ultrafast', licenseClaim: 'generated test fixture' });
  const scenario = {
    schemaVersion: '1.0.0', id: 'test-high-v1', description: 'runner test', status: 'frozen',
    clock: 'server-monotonic-since-run-start', rateUnit: 'decimal-kbit-per-second', responseStartDelayMs: 20,
    scheduler: { scope: 'per-run-aggregate-media-body', discipline: 'work-conserving-fifo', initialTokensBytes: 0, maxBurstBytes: 16384, maxChunkBytes: 4096 },
    phases: [{ id: 'high', startMs: 0, downlinkKbps: 50000 }],
  };
  const write = (rel, value) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`); };
  write('configs/scenarios/test-high.json', scenario);
  const packageSha256 = createHash('sha256').update(fs.readFileSync(path.join(root, 'media/package.json'))).digest('hex');
  const experiment = {
    ...JSON.parse(fs.readFileSync(new URL('../../../configs/experiment.v1.json', import.meta.url))),
    packageManifestSha256: packageSha256,
    scenarioFiles: ['configs/scenarios/test-high.json'],
  };
  experiment.execution = { ...experiment.execution, repetitionsPerCell: 1 };
  experiment.stopPolicy = { ...experiment.stopPolicy, maxWallDurationMs: 30000 };
  write('configs/experiment.json', experiment);
  write('configs/manifest.json', { schemaVersion: '1.0.0', packageManifestSha256: packageSha256, scenarios: [{ id: scenario.id, path: 'configs/scenarios/test-high.json', sha256: sha256Canonical(scenario), anchors: [] }] });
  const ctx = loadContext({ experiment: 'configs/experiment.json', scenarioManifest: 'configs/manifest.json', packageManifest: 'media/package.json' }, root);

  const rawDir = path.join(root, 'raw');
  const service = await createExperimentServer({
    packageRoot: path.join(root, 'media'), resultsRoot: rawDir, scenarios: new Map([[scenario.id, scenario]]),
    experiment: { id: experiment.id, sha256: sha256Canonical(experiment), packageSha256 },
  });
  const address = await service.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => service.close());
  return { root, ctx, rawDir, api: new ServerApi(`http://${address.address}:${address.port}`) };
}

const git = { commit: '0'.repeat(40), dirty: true };
const quiet = () => {};

// Wraps a driver so the first N sessions "crash" immediately.
function crashFirst(n, inner) {
  let opened = 0;
  return {
    ...inner,
    async openSession(args) {
      opened += 1;
      if (opened > n) return inner.openSession(args);
      return { consoleLines: ['simulated crash'], failure: 'browser page crashed', close: async () => {} };
    },
  };
}

test('runner drives real server runs end to end, validates them, and reruns harness failures', { timeout: 180000 }, async (t) => {
  const a = await startApparatus(t);
  const ledgerFile = path.join(a.root, 'ledger.ndjson');
  const deps = { api: a.api, ctx: a.ctx, mode: 'dry-run', git, playerUrl: 'stub://player', rawDir: a.rawDir, ledgerFile, pollMs: 200, log: quiet };
  const cells = a.ctx.experiment.player.policies.map((policy) => ({ policy, trace: 'test-high-v1', repetition: 1 }));

  // First session crashes: the runner must abort it, mark it harness-invalid,
  // and rerun the same cell, which then succeeds.
  const summary = await runSchedule(cells, { ...deps, driver: crashFirst(1, createStubDriver()) });
  assert.deepEqual({ valid: summary.valid, harnessInvalid: summary.harnessInvalid, attempts: summary.attempts }, { valid: 2, harnessInvalid: 1, attempts: 3 });

  const ledger = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 3);
  assert.equal(ledger[0].serverStatus, 'ABORTED');
  assert.equal(ledger[0].validation, 'harness_invalid');
  assert.match(ledger[0].abortReason, /crashed/);
  assert.equal(ledger[1].rerunOf, ledger[0].runId, 'rerun points back to the failed attempt');
  assert.equal(ledger[1].validation, 'valid', ledger[1].errors.join(' | '));
  assert.equal(ledger[2].validation, 'valid', ledger[2].errors.join(' | '));
  for (const entry of ledger.slice(1)) {
    const run = JSON.parse(fs.readFileSync(path.join(a.rawDir, entry.runId, 'run.json'), 'utf8'));
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.clientLabel, LABELS['dry-run']);
    assert.ok(fs.statSync(path.join(a.rawDir, entry.runId, 'server-requests.ndjson')).size > 0, 'media went through the shaped server');
  }

  // Resuming skips cells that already have a valid run.
  const again = await runSchedule(cells, { ...deps, driver: createStubDriver() });
  assert.equal(again.skipped, 2);
  assert.equal(again.attempts, 0);
});

test('runner stops when the server runs a different apparatus', { timeout: 120000 }, async (t) => {
  const a = await startApparatus(t);
  const wrong = { ...a.ctx, experimentSha256: 'f'.repeat(64) };
  const cells = [{ policy: 'default-hlsjs', trace: 'test-high-v1', repetition: 1 }];
  await assert.rejects(
    runSchedule(cells, { api: a.api, ctx: wrong, mode: 'dry-run', git, playerUrl: 'stub://player', rawDir: a.rawDir, ledgerFile: path.join(a.root, 'l.ndjson'), driver: createStubDriver(), log: quiet }),
    (e) => e instanceof StopSession && /experiment config/.test(e.message),
  );
});

test('run order is deterministic and frozen once written', async (t) => {
  const ctx = loadContext();
  const doc = buildOrderDocument(ctx);
  assert.equal(doc.order.length, 18);
  assert.deepEqual(buildOrderDocument(ctx), doc, 'same seed gives the same order');
  const cells = new Set(doc.order.map((o) => `${o.policy}|${o.trace}|${o.repetition}`));
  assert.equal(cells.size, 18, 'every cell exactly once');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'abr-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run-order.json');
  assert.equal(writeOrFreezeOrder(file, ctx).written, true);
  assert.equal(writeOrFreezeOrder(file, ctx).written, false);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"orderIndex": 1,', '"orderIndex": 99,'));
  assert.throws(() => writeOrFreezeOrder(file, ctx), /refusing to overwrite/);
});
