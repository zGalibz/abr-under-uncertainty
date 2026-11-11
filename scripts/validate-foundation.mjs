import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { sha256Canonical } from '../packages/shaper-server/src/domain/canonical-json.mjs';

const root = process.cwd();
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), 'utf8'),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const scenarioSchema = readJson('contracts/schemas/scenario.schema.json');
const experimentSchema = readJson('contracts/schemas/experiment-config.schema.json');
const telemetrySchema = readJson('contracts/schemas/telemetry-event.schema.json');
const mediaPackageSchema = readJson('contracts/schemas/media-package.schema.json');
const mediaValidationSchema = readJson('contracts/schemas/media-validation-report.schema.json');
const scenarioManifestSchema = readJson('contracts/schemas/scenario-manifest.schema.json');
const calibrationReportSchema = readJson('contracts/schemas/calibration-report.schema.json');

ajv.addSchema(scenarioSchema);
ajv.addSchema(experimentSchema);
ajv.addSchema(telemetrySchema);
ajv.addSchema(mediaPackageSchema);
ajv.addSchema(mediaValidationSchema);
ajv.addSchema(scenarioManifestSchema);
ajv.addSchema(calibrationReportSchema);

const failures = [];
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validateJson(relativePath, schemaId) {
  const data = readJson(relativePath);
  const validate = ajv.getSchema(schemaId);
  if (!validate(data)) {
    failures.push(`${relativePath}: ${ajv.errorsText(validate.errors, { separator: '\n  ' })}`);
  }
  return data;
}

function validateScenarioSemantics(relativePath, scenario) {
  const phases = scenario.phases;
  if (phases[0].startMs !== 0) {
    failures.push(`${relativePath}: first phase must start at 0 ms`);
  }
  const ids = new Set();
  phases.forEach((phase, index) => {
    if (ids.has(phase.id)) failures.push(`${relativePath}: duplicate phase id ${phase.id}`);
    ids.add(phase.id);
    const isLast = index === phases.length - 1;
    if (!isLast && phase.endMs === undefined) {
      failures.push(`${relativePath}: only the final phase may omit endMs`);
    }
    if (isLast && phase.endMs !== undefined) {
      failures.push(`${relativePath}: final phase must continue without endMs`);
    }
    if (!isLast) {
      const next = phases[index + 1];
      if (phase.endMs !== next.startMs) {
        failures.push(`${relativePath}: phases ${phase.id} and ${next.id} are not contiguous`);
      }
      if (phase.endMs <= phase.startMs) failures.push(`${relativePath}: phase ${phase.id} has non-positive duration`);
    }
  });
}

const scenarioDir = path.join(root, 'configs/scenarios');
const scenarioFiles = fs.readdirSync(scenarioDir)
  .filter((name) => name.endsWith('.v1.json'))
  .sort();

const scenariosById = new Map();
for (const name of scenarioFiles) {
  const relativePath = `configs/scenarios/${name}`;
  const scenario = validateJson(relativePath, scenarioSchema.$id);
  validateScenarioSemantics(relativePath, scenario);
  scenariosById.set(scenario.id, scenario);
}

const experiment = validateJson('configs/experiment.v1.json', experimentSchema.$id);
validateJson('contracts/examples/telemetry.level-switched.json', telemetrySchema.$id);
if (fs.existsSync(path.join(root, 'media/package.json'))) {
  validateJson('media/package.json', mediaPackageSchema.$id);
  const validationReport = validateJson('media/validation-report.json', mediaValidationSchema.$id);
  const packageHash = sha256Bytes(fs.readFileSync(path.join(root, 'media/package.json')));
  if (experiment.packageManifestSha256 !== packageHash) failures.push('configs/experiment.v1.json: package manifest hash mismatch');
  if (validationReport.packageManifestSha256 !== packageHash) failures.push('media/validation-report.json: package manifest hash mismatch');
}
const scenarioManifest = validateJson('configs/scenarios/manifest.json', scenarioManifestSchema.$id);
for (const entry of scenarioManifest.scenarios) {
  const scenario = scenariosById.get(entry.id);
  if (!scenario || sha256Canonical(scenario) !== entry.sha256) failures.push(`configs/scenarios/manifest.json: hash mismatch for ${entry.id}`);
}
if (scenarioManifest.packageManifestSha256 !== experiment.packageManifestSha256) failures.push('configs/scenarios/manifest.json: package manifest link mismatch');
if (fs.existsSync(path.join(root, 'results/calibration/calibration-report.json'))) {
  const calibration = validateJson('results/calibration/calibration-report.json', calibrationReportSchema.$id);
  const scenarioManifestHash = sha256Bytes(fs.readFileSync(path.join(root, 'configs/scenarios/manifest.json')));
  if (calibration.scenarioManifestSha256 !== scenarioManifestHash) failures.push('results/calibration/calibration-report.json: scenario manifest hash mismatch');
}

if (failures.length > 0) {
  console.error('Foundation validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Foundation validation passed: ${scenarioFiles.length} frozen scenarios, experiment config, telemetry example, Member 1 manifests, and calibration evidence.`);
