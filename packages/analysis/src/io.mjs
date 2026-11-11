import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Parses events.ndjson. Bad lines are reported, not thrown, so the validator
// can explain exactly which line of which run is broken.
export function readNdjson(file) {
  const events = [];
  const parseErrors = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      parseErrors.push(`line ${i + 1}: ${err.message}`);
    }
  });
  return { events, parseErrors };
}

// A raw run directory is results/raw/<run_id>/ containing run.json and events.ndjson.
export function listRunDirs(rawDir) {
  if (!fs.existsSync(rawDir)) return [];
  return fs.readdirSync(rawDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(rawDir, d.name, 'run.json')))
    .map((d) => path.join(rawDir, d.name))
    .sort();
}

export function loadRun(runDir) {
  const run = readJson(path.join(runDir, 'run.json'));
  const eventsFile = path.join(runDir, 'events.ndjson');
  const { events, parseErrors } = fs.existsSync(eventsFile)
    ? readNdjson(eventsFile)
    : { events: [], parseErrors: ['events.ndjson is missing'] };
  const scenario = run.scenarioFile ? readJson(path.resolve(repoRoot, run.scenarioFile)) : null;
  const rawSha256 = fs.existsSync(eventsFile) ? sha256File(eventsFile) : null;
  return { dir: runDir, run, events, parseErrors, scenario, rawSha256 };
}

// Not-applicable and unobserved values are written as NA, never as 0.
function csvCell(value) {
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return 'NA';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function writeCsv(file, columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
