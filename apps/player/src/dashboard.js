function formatBps(value) {
  return Number.isFinite(value) ? `${(value / 1_000_000).toFixed(2)} Mbps` : '—';
}
function levelLabel(level, levels) {
  const match = levels?.find((item) => item.level === level);
  return match ? `L${level} · ${match.width}×${match.height} · ${formatBps(match.bitrateBps)}` : '—';
}

/** Renders only values supplied by recorded events/controller state. */
export class LiveDashboard {
  constructor(root) { this.root = root; this.rows = []; }

  ingest(event) {
    this.rows.unshift(event); this.rows = this.rows.slice(0, 60);
    const list = this.root.querySelector('[data-events]');
    if (!list) return;
    list.replaceChildren(...this.rows.map((item) => {
      const row = document.createElement('li');
      row.textContent = `#${item.seq} ${item.type} @ ${item.clientMonoMs.toFixed(1)} ms`;
      return row;
    }));
  }

  render(state) {
    const write = (name, value) => { const node = this.root.querySelector(`[data-value="${name}"]`); if (node) node.textContent = value; };
    write('state', state.runState || 'IDLE'); write('requested', levelLabel(state.requestedLevel, state.levels)); write('effective', levelLabel(state.effectiveLevel, state.levels));
    write('buffer', `${(state.forwardBufferSec || 0).toFixed(2)} s`); write('hls-throughput', formatBps(state.hlsEstimateBps));
    write('policy-throughput', formatBps(state.policy?.estimateBps)); write('decision', state.policy ? `${state.policy.upEvidence} upgrade confirmations` : 'Stock hls.js automatic ABR');
    write('stalls', `${state.stalls?.rebufferCount || 0} retained / ${(state.stalls?.rebufferDurationMs || 0).toFixed(0)} ms`);
    write('config', state.resolvedConfig ? `hls.js ${state.resolvedConfig.hlsJsVersion}; startLevel ${state.resolvedConfig.startLevel}; capLevelToPlayerSize ${state.resolvedConfig.capLevelToPlayerSize}` : '—');
  }
}
