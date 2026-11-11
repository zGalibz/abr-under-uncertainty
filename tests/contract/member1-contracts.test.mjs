import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const requiredSchemas = [
  'media-package.schema.json',
  'media-validation-report.schema.json',
  'run.schema.json',
  'server-request.schema.json',
  'scheduler-event.schema.json',
  'scenario-manifest.schema.json',
  'calibration-report.schema.json',
];

test('Member 1 machine-readable contracts exist', () => {
  for (const name of requiredSchemas) {
    assert.equal(existsSync(`contracts/schemas/${name}`), true, `${name} is missing`);
  }
});

test('scenario status is mandatory and only frozen scenarios are experiment-ready', () => {
  const schema = readJson('contracts/schemas/scenario.schema.json');
  assert.ok(schema.required.includes('status'));
  assert.deepEqual(schema.properties.status.enum, ['draft', 'frozen']);
});

test('OpenAPI records policy provenance and operational endpoints', () => {
  const openapi = readFileSync('contracts/openapi.yaml', 'utf8');
  assert.match(openapi, /\/healthz:/);
  assert.match(openapi, /\/readyz:/);
  assert.match(openapi, /policyId/);
  assert.match(openapi, /X-Content-Type-Options/);
  assert.match(openapi, /Content-Length/);
  assert.match(openapi, /If-Range/);
  assert.match(openapi, /EVENT_IDENTITY_CONFLICT/);
});

test('run contract preserves immutable comparison provenance', () => {
  const schema = readJson('contracts/schemas/run.schema.json');
  for (const field of [
    'policyId', 'orderSeed', 'clientLabel', 'gitCommit', 'gitDirty',
    'experimentSha256', 'scenarioSha256', 'packageSha256',
  ]) {
    assert.ok(schema.required.includes(field), `${field} must be required`);
  }
});
