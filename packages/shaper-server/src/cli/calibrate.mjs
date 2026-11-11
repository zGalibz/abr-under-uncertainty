#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { calibrateScenario, buildCalibrationReport } from '../services/calibration-runner.mjs';
import { sha256Canonical } from '../domain/canonical-json.mjs';

const exec = promisify(execFile);
const root = process.env.INIT_CWD || process.cwd();
const config = JSON.parse(await readFile(path.join(root, 'configs/experiment.v1.json'), 'utf8'));
const manifestBytes = await readFile(path.join(root, 'configs/scenarios/manifest.json'));
const scenarioManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const packageBytes = await readFile(path.join(root, 'media/package.json'));
const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
const { stdout: commitOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const gitCommit = commitOut.trim();
const experiment = { id: config.id, sha256: sha256Canonical(config), packageSha256 };
const results = [];
for (const relative of config.scenarioFiles) {
  const scenario = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  process.stdout.write(`Calibrating ${scenario.id}...\n`);
  const { result } = await calibrateScenario({ packageRoot: path.join(root, 'media'), scenario, experiment, gitCommit });
  results.push(result);
  process.stdout.write(`${scenario.id}: ${result.passed ? 'PASS' : 'FAIL'}\n`);
}
const report = buildCalibrationReport({ gitCommit, scenarioManifestSha256, results });
const outputDir = path.join(root, 'results/calibration');
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'calibration-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const markdown = ['# Bandwidth Shaper Calibration', '', `Overall: ${report.valid ? 'PASS' : 'FAIL'}`, '', '| Scenario | Plateau gates | Transition gates | Result |', '|---|---:|---:|---|', ...report.scenarios.map((item) => `| ${item.id} | ${item.plateaus.filter((x) => x.passed).length}/${item.plateaus.length} | ${item.transitions.filter((x) => x.passed).length}/${item.transitions.length} | ${item.passed ? 'PASS' : 'FAIL'} |`), ''].join('\n');
await writeFile(path.join(outputDir, 'calibration-report.md'), markdown);
console.log(JSON.stringify(report, null, 2));
if (!report.valid) process.exitCode = 1;
