#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { compileScenarioSet } from '../services/scenario-compiler.mjs';

const root = process.env.INIT_CWD || process.cwd();
const packagePath = path.resolve(root, 'media/package.json');
const configs = path.resolve(root, 'configs');
const packageBytes = await readFile(packagePath);
const packageManifest = JSON.parse(packageBytes);
const packageManifestSha256 = createHash('sha256').update(packageBytes).digest('hex');
const { scenarios, manifest } = compileScenarioSet({ packageManifest, packageManifestSha256 });
for (const [id, value] of scenarios) {
  const filename = id.replace('-v1', '.v1.json');
  await writeFile(path.join(configs, 'scenarios', filename), `${JSON.stringify(value, null, 2)}\n`);
}
await writeFile(path.join(configs, 'scenarios', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const experimentPath = path.join(configs, 'experiment.v1.json');
const experiment = JSON.parse(await readFile(experimentPath, 'utf8'));
experiment.packageManifestSha256 = packageManifestSha256;
await writeFile(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`);
console.log(JSON.stringify({ packageManifestSha256, scenarios: manifest.scenarios.map(({ id, sha256, anchors }) => ({ id, sha256, anchors: anchors.length })) }, null, 2));
