import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = process.cwd();
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), 'utf8'),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const scenarioSchema = readJson('contracts/schemas/scenario.schema.json');
const experimentSchema = readJson('contracts/schemas/experiment-config.schema.json');
const telemetrySchema = readJson('contracts/schemas/telemetry-event.schema.json');

ajv.addSchema(scenarioSchema);
ajv.addSchema(experimentSchema);
ajv.addSchema(telemetrySchema);

const failures = [];

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
    }
  });
}

const scenarioDir = path.join(root, 'configs/scenarios');
const scenarioFiles = fs.readdirSync(scenarioDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

for (const name of scenarioFiles) {
  const relativePath = `configs/scenarios/${name}`;
  const scenario = validateJson(relativePath, scenarioSchema.$id);
  validateScenarioSemantics(relativePath, scenario);
}

validateJson('configs/experiment.v1.json', experimentSchema.$id);
validateJson('contracts/examples/telemetry.level-switched.json', telemetrySchema.$id);

if (failures.length > 0) {
  console.error('Foundation validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Foundation validation passed: ${scenarioFiles.length} scenarios, experiment config, and telemetry example.`);
