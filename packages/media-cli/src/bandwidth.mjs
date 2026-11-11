function parseDecimal(value) {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value)) throw new Error(`invalid decimal duration: ${value}`);
  const [whole, fraction = ''] = value.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * scale + BigInt(fraction || '0');
  if (numerator <= 0n) throw new Error('duration must be positive');
  return { numerator, scale, digits: fraction.length };
}

function ceilDivide(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

export function measuredBandwidth(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('at least one segment is required');
  const parsed = segments.map((segment) => {
    if (!Number.isSafeInteger(segment.bytes) || segment.bytes <= 0) throw new Error('segment bytes must be a positive safe integer');
    return { bytes: BigInt(segment.bytes), duration: parseDecimal(segment.duration) };
  });
  let peak = 0n;
  const maxDigits = Math.max(...parsed.map((entry) => entry.duration.digits));
  const commonScale = 10n ** BigInt(maxDigits);
  let totalDuration = 0n;
  let totalBytes = 0n;
  for (const entry of parsed) {
    const rate = ceilDivide(entry.bytes * 8n * entry.duration.scale, entry.duration.numerator);
    if (rate > peak) peak = rate;
    totalBytes += entry.bytes;
    totalDuration += entry.duration.numerator * (commonScale / entry.duration.scale);
  }
  const average = ceilDivide(totalBytes * 8n * commonScale, totalDuration);
  const result = { peakBps: Number(peak), averageBps: Number(average) };
  if (!Number.isSafeInteger(result.peakBps) || !Number.isSafeInteger(result.averageBps)) throw new Error('measured bandwidth exceeds safe integer range');
  return result;
}
