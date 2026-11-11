import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCalibration } from '../../src/services/calibration-runner.mjs';

const scenario = { id: 'two-phase', phases: [
  { id: 'a', startMs: 0, endMs: 4000, downlinkKbps: 1000 },
  { id: 'b', startMs: 4000, downlinkKbps: 2000 },
] };

test('evaluates plateau medians and transition timing gates', () => {
  const bins = [
    { startMs: 1000, endMs: 2000, measuredKbps: 950 },
    { startMs: 2000, endMs: 3000, measuredKbps: 1000 },
    { startMs: 3000, endMs: 4000, measuredKbps: 1050 },
    { startMs: 5000, endMs: 6000, measuredKbps: 1900 },
    { startMs: 6000, endMs: 7000, measuredKbps: 2000 },
    { startMs: 7000, endMs: 8000, measuredKbps: 2100 },
  ];
  const writes = [{ kind: 'write', phaseId: 'b', atRunMs: 4100 }];
  const result = evaluateCalibration({ scenario, bins, writes });
  assert.equal(result.passed, true);
  assert.equal(result.plateaus[0].medianMeasuredKbps, 1000);
  assert.equal(result.transitions[0].errorMs, 100);
});
