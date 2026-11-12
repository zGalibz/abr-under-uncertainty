// Descriptive statistics used by the summaries. With n = 3 per cell the
// design forbids inferential statistics, so only these are provided.

const finite = (values) => values.filter((v) => typeof v === 'number' && Number.isFinite(v));

export function median(values) {
  const xs = finite(values).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function min(values) {
  const xs = finite(values);
  return xs.length ? Math.min(...xs) : null;
}

export function max(values) {
  const xs = finite(values);
  return xs.length ? Math.max(...xs) : null;
}

export function mean(values) {
  const xs = finite(values);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

// Sample standard deviation (n − 1 denominator), as required by the design.
export function sampleSd(values) {
  const xs = finite(values);
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// Linear-interpolation percentile (the common "type 7" definition), p in [0, 1].
export function percentile(values, p) {
  const xs = finite(values).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const h = (xs.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
}
