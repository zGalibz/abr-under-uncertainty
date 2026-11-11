#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createExperimentServer } from '../http/app.mjs';
import { sha256Canonical } from '../domain/canonical-json.mjs';

const root = process.env.INIT_CWD || process.cwd();
const experimentConfig = JSON.parse(await readFile(path.join(root, 'configs/experiment.v1.json'), 'utf8'));
const scenarios = new Map();
for (const relative of experimentConfig.scenarioFiles) {
  const value = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  scenarios.set(value.id, value);
}
const packageBytes = await readFile(path.join(root, 'media/package.json'));
const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
if (packageSha256 !== experimentConfig.packageManifestSha256) throw new Error('experiment package hash does not match media/package.json');
const service = await createExperimentServer({
  packageRoot: path.join(root, 'media'), resultsRoot: path.join(root, 'results/raw'), scenarios,
  experiment: { id: experimentConfig.id, sha256: sha256Canonical(experimentConfig), packageSha256 },
});
const address = await service.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 8080) });
console.log(`ABR experiment server listening on http://${address.address}:${address.port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
