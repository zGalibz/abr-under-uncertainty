import assert from 'node:assert/strict';
import test from 'node:test';
import { compileScenarioSet } from '../../src/services/scenario-compiler.mjs';

const packageManifest = {
  renditions: [
    { id: 'v0', measuredPeakBps: 800000 },
    { id: 'v1', measuredPeakBps: 1400000 },
    { id: 'v2', measuredPeakBps: 2700000 },
    { id: 'v3', measuredPeakBps: 4800000 },
  ],
};

test('compiles three frozen ladder-relative scenarios and reaction anchors', () => {
  const result = compileScenarioSet({ packageManifest, packageManifestSha256: 'a'.repeat(64) });
  assert.deepEqual([...result.scenarios.keys()], ['stable-v1', 'gradual-v1', 'volatile-v1']);
  for (const scenario of result.scenarios.values()) {
    assert.equal(scenario.status, 'frozen');
    assert.equal(scenario.phases[0].startMs, 0);
    assert.equal('endMs' in scenario.phases.at(-1), false);
  }
  const gradual = result.manifest.scenarios.find((item) => item.id === 'gradual-v1');
  assert.ok(gradual.anchors.some((anchor) => anchor.kind === 'adverse'));
  assert.ok(gradual.anchors.some((anchor) => anchor.kind === 'recovery'));
  const stableRate = result.scenarios.get('stable-v1').phases[0].downlinkKbps * 1000;
  assert.ok(0.85 * stableRate > 4800000);
});
