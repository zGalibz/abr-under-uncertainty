import { POLICY_IDS } from './player-controller.js';

// Runner-controlled mode (the runner ↔ player contract in packages/runner/README.md).
//
// Member 3's runner creates the run on the experiment server, then opens
//
//   <player page>?api=<server base URL>&runId=<runId>&policyId=<policy>&maxWallMs=<n>
//
// and never touches the page. The player then calls /start, plays muted,
// posts telemetry and calls /finish (ended / timeout / fatal_error) by itself.

const RUN_ID = /^r_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DEFAULT_MAX_WALL_MS = 240_000;

/**
 * Returns null for a normal (manual) page load, the parsed runner parameters
 * when the URL carries a runId, and throws when a runner URL is malformed, so
 * a broken runner URL can never fall back to a manual run.
 */
export function readAutomationParams(search) {
  const params = new URLSearchParams(search);
  const runId = params.get('runId');
  if (runId === null) return null;
  if (!RUN_ID.test(runId)) throw new Error(`invalid runId "${runId}"`);

  const policyId = params.get('policyId');
  if (!POLICY_IDS.includes(policyId)) throw new Error(`unknown policyId "${policyId}"`);

  const api = params.get('api');
  let apiBase;
  try {
    apiBase = new URL(api);
  } catch {
    throw new Error(`api must be an absolute http(s) URL, got "${api}"`);
  }
  if (!['http:', 'https:'].includes(apiBase.protocol)) throw new Error(`api must be http(s), got "${api}"`);

  const rawWall = params.get('maxWallMs');
  const maxWallMs = rawWall === null ? DEFAULT_MAX_WALL_MS : Number(rawWall);
  if (!Number.isInteger(maxWallMs) || maxWallMs <= 0) throw new Error(`maxWallMs must be a positive integer, got "${rawWall}"`);

  return { runId, policyId, apiBase: apiBase.origin, maxWallMs };
}
