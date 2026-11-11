// Cell summaries and paired deltas (framework §8.7 and §9).

import { max, mean, median, min, sampleSd } from './stats.mjs';

export const DEFAULT_POLICY = 'default-hlsjs';
export const CONSERVATIVE_POLICY = 'conservative-throughput-v1';

// direction: which way is better. Buffer is "higher is safer", not
// automatically better, but it is still compared in that direction.
export const METRICS = [
  { metric: 'startup_delay_s', unit: 's', direction: 'lower' },
  { metric: 'rebuffer_count', unit: 'count', direction: 'lower' },
  { metric: 'rebuffer_duration_s', unit: 's', direction: 'lower' },
  { metric: 'rebuffer_ratio', unit: 'ratio', direction: 'lower' },
  { metric: 'tw_bitrate_kbps', unit: 'kbps', direction: 'higher' },
  { metric: 'switch_count', unit: 'count', direction: 'lower' },
  { metric: 'switch_magnitude_kbps', unit: 'kbps', direction: 'lower' },
  { metric: 'buffer_mean_s', unit: 's', direction: 'higher' },
  { metric: 'buffer_p05_s', unit: 's', direction: 'higher' },
  { metric: 'low_buffer_fraction', unit: 'ratio', direction: 'lower' },
  { metric: 'reaction_median_s', unit: 's', direction: 'lower' },
  { metric: 'reaction_worst_s', unit: 's', direction: 'lower' },
];

const num = (v) => (v === null || v === undefined ? null : Number(v));

export function buildCells(validRuns) {
  const rows = [];
  const policies = [...new Set(validRuns.map((r) => r.policy_id))].sort();
  const traces = [...new Set(validRuns.map((r) => r.trace_id))].sort();
  for (const policy of policies) {
    for (const trace of traces) {
      const runs = validRuns.filter((r) => r.policy_id === policy && r.trace_id === trace).sort((a, b) => a.repeat_id - b.repeat_id);
      for (const { metric, unit } of METRICS) {
        const values = runs.map((r) => num(r[metric]));
        const present = values.filter((v) => v !== null);
        rows.push({
          policy_id: policy,
          trace_id: trace,
          metric,
          unit,
          n_valid: present.length,
          values_json: JSON.stringify(values),
          median: median(present),
          min: min(present),
          max: max(present),
          mean: mean(present),
          sample_sd: sampleSd(present),
          n_complete: runs.filter((r) => r.completed).length,
        });
      }
    }
  }
  return rows;
}

// Paired by trace + repeat: repeat 2 of default is compared with repeat 2 of
// conservative. improvement_signed > 0 always means "conservative did better".
export function buildPairedDeltas(validRuns) {
  const rows = [];
  const traces = [...new Set(validRuns.map((r) => r.trace_id))].sort();
  for (const trace of traces) {
    const repeats = [...new Set(validRuns.filter((r) => r.trace_id === trace).map((r) => r.repeat_id))].sort((a, b) => a - b);
    for (const repeat of repeats) {
      const d = validRuns.find((r) => r.trace_id === trace && r.repeat_id === repeat && r.policy_id === DEFAULT_POLICY);
      const c = validRuns.find((r) => r.trace_id === trace && r.repeat_id === repeat && r.policy_id === CONSERVATIVE_POLICY);
      for (const { metric, direction } of METRICS) {
        const dv = d ? num(d[metric]) : null;
        const cv = c ? num(c[metric]) : null;
        const delta = dv !== null && cv !== null ? cv - dv : null;
        rows.push({
          trace_id: trace,
          repeat_id: repeat,
          metric,
          default_value: dv,
          conservative_value: cv,
          delta_c_minus_d: delta,
          improvement_signed: delta === null ? null : direction === 'lower' ? -delta : delta,
        });
      }
    }
  }
  return rows;
}

// Completion table: exact x/3 with terminal reasons, per policy × trace.
export function buildCompletion(validRuns) {
  const rows = [];
  const keys = new Set(validRuns.map((r) => `${r.policy_id}|${r.trace_id}`));
  for (const key of [...keys].sort()) {
    const [policy, trace] = key.split('|');
    const runs = validRuns.filter((r) => r.policy_id === policy && r.trace_id === trace);
    const reasons = {};
    for (const r of runs) reasons[r.terminal_reason] = (reasons[r.terminal_reason] ?? 0) + 1;
    rows.push({
      policy_id: policy,
      trace_id: trace,
      completed: `${runs.filter((r) => r.completed).length}/${runs.length}`,
      terminal_reasons: Object.entries(reasons).map(([k, v]) => `${k}:${v}`).join(' '),
    });
  }
  return rows;
}
