// Deterministic SVG charts from validated summaries (framework §10).
// Specs are Vega-Lite JSON; the same inputs always produce the same SVG.

import fs from 'node:fs';
import path from 'node:path';
import * as vega from 'vega';
import * as vl from 'vega-lite';
import { CONSERVATIVE_POLICY, DEFAULT_POLICY } from './summarize.mjs';

// Fixed policy colours used by every chart.
const POLICY_SCALE = { domain: [DEFAULT_POLICY, CONSERVATIVE_POLICY], range: ['#4C78A8', '#F58518'] };
const TRACE_ORDER = ['stable-v1', 'gradual-v1', 'volatile-v1', 'outage-v1'];

async function renderSvg(spec, file) {
  const config = { legend: { labelLimit: 260 }, axis: { labelLimit: 260 } };
  const compiled = vl.compile({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', background: 'white', config, ...spec }).spec;
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' });
  const svg = await view.toSVG();
  view.finalize();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svg);
  return file;
}

// Paired dot/slope plot: one dot per run, a line joins the same repeat of
// both policies, one panel per trace.
function pairedSpec(runs, metric, label, note) {
  const data = runs.filter((r) => r[metric] !== null).map((r) => ({
    trace: r.trace_id, policy: r.policy_id, repeat: `repeat ${r.repeat_id}`, value: Number(r[metric]),
  }));
  const n = data.length;
  return {
    title: { text: label, subtitle: `each dot = one run; lines join matching repeats; n = ${n} runs${note ? `; ${note}` : ''}` },
    data: { values: data },
    facet: { column: { field: 'trace', type: 'nominal', sort: TRACE_ORDER, title: null } },
    spec: {
      width: 160,
      height: 220,
      layer: [
        { mark: { type: 'line', color: '#999', strokeWidth: 1 }, encoding: { detail: { field: 'repeat' } } },
        { mark: { type: 'point', filled: true, size: 70 }, encoding: { color: { field: 'policy', type: 'nominal', scale: POLICY_SCALE, title: 'policy' } } },
      ],
      encoding: {
        x: { field: 'policy', type: 'nominal', sort: POLICY_SCALE.domain, axis: { labelAngle: -20, title: null } },
        y: { field: 'value', type: 'quantitative', title: label },
      },
    },
  };
}

function tradeoffSpec(cells) {
  const get = (p, t, m) => cells.find((c) => c.policy_id === p && c.trace_id === t && c.metric === m);
  const points = [];
  for (const c of cells.filter((x) => x.metric === 'rebuffer_duration_s')) {
    const br = get(c.policy_id, c.trace_id, 'tw_bitrate_kbps');
    if (c.median === null || !br || br.median === null) continue;
    points.push({ policy: c.policy_id, trace: c.trace_id, rebuffer: c.median, bitrate: br.median, n: c.n_valid, complete: `${c.n_complete}/${c.n_valid}` });
  }
  return {
    title: { text: 'Quality vs stalls trade-off', subtitle: 'cell medians; bitrate from complete runs only; up-left is better' },
    width: 420,
    height: 300,
    data: { values: points },
    layer: [
      {
        mark: { type: 'point', filled: true, size: 120 },
        encoding: {
          color: { field: 'policy', type: 'nominal', scale: POLICY_SCALE },
          shape: { field: 'trace', type: 'nominal', sort: TRACE_ORDER },
          tooltip: [{ field: 'policy' }, { field: 'trace' }, { field: 'complete' }],
        },
      },
    ],
    encoding: {
      x: { field: 'rebuffer', type: 'quantitative', title: 'median total rebuffering (s)' },
      y: { field: 'bitrate', type: 'quantitative', title: 'median time-weighted bitrate (kbps)', scale: { zero: false } },
    },
  };
}

function reactionSpec(anchorRows) {
  const notExposed = anchorRows.filter((a) => a.status === 'not_exposed').length;
  const data = anchorRows.filter((a) => a.status === 'ok' || a.status === 'censored').map((a) => ({
    anchor: a.anchor_id,
    policy: a.policy_id,
    // Censored anchors are drawn at the plateau length, the lower bound of the true value.
    value: a.censored ? (a.plateau_end_ms - a.t_rel_ms) / 1000 : a.reaction_s,
    status: a.censored ? 'censored (no reaction before plateau ended)' : a.proactive_or_already_safe ? 'already safe (0 s)' : 'reacted',
  }));
  return {
    title: { text: 'Reaction time after capacity drops', subtitle: `each mark = one anchor in one run; n = ${data.length}${notExposed ? `; ${notExposed} anchor(s) not shown: no media request during the low plateau (not exposed)` : ''}` },
    width: 520,
    height: 260,
    data: { values: data },
    mark: { type: 'point', filled: true, size: 70, opacity: 0.8 },
    encoding: {
      x: { field: 'anchor', type: 'nominal', title: 'reaction anchor', axis: { labelAngle: -30 } },
      xOffset: { field: 'policy', type: 'nominal', sort: POLICY_SCALE.domain },
      y: { field: 'value', type: 'quantitative', title: 'reaction time (s)' },
      color: { field: 'policy', type: 'nominal', scale: POLICY_SCALE },
      shape: { field: 'status', type: 'nominal', title: 'outcome' },
    },
  };
}

// Time series for one representative run: configured capacity, achieved
// goodput and played bitrate on top, forward buffer below, stalls shaded in both.
function timeseriesSpec(series) {
  const { runId, policy, trace, capacity, achieved = [], played, buffer, stalls } = series;
  const stallLayer = { data: { values: stalls }, mark: { type: 'rect', color: '#d62728', opacity: 0.2 }, encoding: { x: { field: 'start', type: 'quantitative' }, x2: { field: 'end' } } };
  const xTitle = { title: 'time since play request (s)' };
  const achievedLayer = achieved.length
    ? [{ data: { values: achieved }, mark: { type: 'rect', color: '#9e9e9e', opacity: 0.45 }, encoding: { x: { field: 't', type: 'quantitative' }, x2: { field: 't2' }, y: { field: 'kbps', type: 'quantitative' }, y2: { datum: 0 } } }]
    : [];
  return {
    title: { text: `${trace} — ${policy}`, subtitle: `representative run ${runId} (median rebuffering in its cell); red = stalls` },
    vconcat: [
      {
        width: 560,
        height: 180,
        layer: [
          stallLayer,
          ...achievedLayer,
          { data: { values: capacity }, mark: { type: 'line', interpolate: 'step-after', color: '#555', strokeDash: [4, 3] }, encoding: { x: { field: 't', type: 'quantitative', ...xTitle }, y: { field: 'kbps', type: 'quantitative', title: 'kbps' } } },
          { data: { values: played }, mark: { type: 'line', interpolate: 'step-after', color: POLICY_SCALE.range[POLICY_SCALE.domain.indexOf(policy)] ?? '#000', strokeWidth: 2 }, encoding: { x: { field: 't', type: 'quantitative' }, y: { field: 'kbps', type: 'quantitative' } } },
        ],
        title: { text: `configured capacity (dashed) · ${achieved.length ? 'achieved media goodput per second, server log (grey bars) · ' : ''}played bitrate (solid)`, fontSize: 11 },
      },
      {
        width: 560,
        height: 120,
        layer: [
          stallLayer,
          { data: { values: buffer }, mark: { type: 'line', color: '#2ca02c' }, encoding: { x: { field: 't', type: 'quantitative', ...xTitle }, y: { field: 's', type: 'quantitative', title: 'forward buffer (s)' } } },
        ],
      },
    ],
  };
}

export async function renderAll({ runs, cells, anchorRows, timeseries, outDir }) {
  const written = [];
  const paired = [
    ['rebuffer_duration_s', 'Total rebuffering (s)'],
    ['rebuffer_count', 'Rebuffer events (count)'],
    ['tw_bitrate_kbps', 'Time-weighted played bitrate (kbps)', 'complete runs only'],
    ['startup_delay_s', 'Startup delay (s)'],
    ['switch_count', 'Played quality switches (count)'],
    ['buffer_p05_s', 'Forward buffer, 5th percentile (s)'],
  ];
  for (const [metric, label, note] of paired) {
    written.push(await renderSvg(pairedSpec(runs, metric, label, note), path.join(outDir, `paired_${metric}.svg`)));
  }
  written.push(await renderSvg(tradeoffSpec(cells), path.join(outDir, 'tradeoff.svg')));
  if (anchorRows.length) written.push(await renderSvg(reactionSpec(anchorRows), path.join(outDir, 'reaction_anchors.svg')));
  for (const s of timeseries) {
    written.push(await renderSvg(timeseriesSpec(s), path.join(outDir, `timeseries_${s.trace}_${s.policy}.svg`)));
  }
  return written;
}
