export function validateScenarioSemantics(scenario) {
  const issues = [];
  const phases = scenario?.phases;
  if (!Array.isArray(phases) || phases.length === 0) return ['phases must be a non-empty array'];
  if (phases[0].startMs !== 0) issues.push('first phase must start at zero');
  const ids = new Set();
  phases.forEach((phase, index) => {
    if (ids.has(phase.id)) issues.push(`duplicate phase id ${phase.id}`);
    ids.add(phase.id);
    if (!Number.isInteger(phase.startMs) || phase.startMs < 0) issues.push(`${phase.id}: invalid startMs`);
    if (!Number.isInteger(phase.downlinkKbps) || phase.downlinkKbps <= 0) issues.push(`${phase.id}: invalid downlinkKbps`);
    const last = index === phases.length - 1;
    if (last && phase.endMs !== undefined) issues.push('final phase must be unbounded');
    if (!last) {
      if (!Number.isInteger(phase.endMs) || phase.endMs <= phase.startMs) issues.push(`${phase.id}: invalid endMs`);
      if (phase.endMs !== phases[index + 1].startMs) issues.push(`${phase.id}: gap or overlap`);
    }
  });
  return issues;
}

export function compileSchedule(scenario) {
  const issues = validateScenarioSemantics(scenario);
  if (issues.length) throw new Error(issues.join('; '));
  const phases = scenario.phases.map((phase) => Object.freeze({ ...phase }));
  function phaseAt(runMs) {
    if (!Number.isFinite(runMs) || runMs < 0) throw new RangeError('run time must be non-negative');
    return phases.find((phase) => runMs >= phase.startMs && (phase.endMs === undefined || runMs < phase.endMs)) ?? phases.at(-1);
  }
  function integratedBytes(fromRunMs, toRunMs) {
    if (toRunMs < fromRunMs || fromRunMs < 0) throw new RangeError('invalid integration interval');
    let cursor = fromRunMs;
    let bytes = 0;
    while (cursor < toRunMs) {
      const phase = phaseAt(cursor);
      const end = Math.min(toRunMs, phase.endMs ?? toRunMs);
      bytes += (end - cursor) * phase.downlinkKbps / 8;
      cursor = end;
    }
    return bytes;
  }
  function msUntilBytes(fromRunMs, byteCount) {
    if (byteCount <= 0) return 0;
    let low = 0;
    let high = 1;
    while (integratedBytes(fromRunMs, fromRunMs + high) < byteCount) {
      high *= 2;
      if (high > 3_600_000) throw new Error('unable to schedule bytes within one hour');
    }
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const mid = (low + high) / 2;
      if (integratedBytes(fromRunMs, fromRunMs + mid) >= byteCount) high = mid;
      else low = mid;
    }
    return high;
  }
  return Object.freeze({ phases: Object.freeze(phases), phaseAt, integratedBytes, msUntilBytes });
}
