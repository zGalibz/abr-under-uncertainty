// The frozen apparatus a run is analysed against: experiment config,
// scenario manifest (frozen traces + reaction anchors) and the measured
// media package. These are Galib's files; the analysis only reads them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Canonical } from '../../shaper-server/src/domain/canonical-json.mjs';
import { readJson, repoRoot } from './io.mjs';

export const DEFAULT_CONTEXT_FILES = {
  experiment: 'configs/experiment.v1.json',
  scenarioManifest: 'configs/scenarios/manifest.json',
  packageManifest: 'media/package.json',
};

// Measured ladder in level order (v0 → level 0). Bitrates are what the
// encoder actually produced, not nominal targets.
function ladderFromPackage(pkg) {
  return [...pkg.renditions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r, level) => ({
      level,
      id: r.id,
      width: r.width,
      height: r.height,
      bitrateBps: r.measuredPeakBps,
      averageBitrateBps: r.measuredAverageBps,
      codecs: r.codecs,
    }));
}

export function loadContext(files = {}, root = repoRoot) {
  const f = { ...DEFAULT_CONTEXT_FILES, ...files };
  const abs = (p) => path.resolve(root, p);
  const experiment = readJson(abs(f.experiment));
  const manifest = readJson(abs(f.scenarioManifest));
  const packageBytes = fs.readFileSync(abs(f.packageManifest));
  const pkg = JSON.parse(packageBytes);
  const scenarios = new Map();
  for (const entry of manifest.scenarios) {
    const scenario = readJson(path.resolve(root, entry.path));
    scenarios.set(entry.id, { ...entry, scenario, computedSha256: sha256Canonical(scenario) });
  }
  return {
    experiment,
    experimentSha256: sha256Canonical(experiment),
    packageSha256: crypto.createHash('sha256').update(packageBytes).digest('hex'),
    scenarios,
    ladder: ladderFromPackage(pkg),
    durationSec: pkg.durationSeconds,
    files: f,
  };
}
