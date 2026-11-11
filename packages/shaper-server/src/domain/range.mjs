const DIGITS = /^[0-9]+$/;

function number(text) {
  if (!DIGITS.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseSingleRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer');
  if (header === undefined || header === null) return size === 0 ? { kind: 'full', start: 0, end: -1, length: 0 } : { kind: 'full', start: 0, end: size - 1, length: size };
  if (typeof header !== 'string' || !header.startsWith('bytes=') || header.includes(',') || /\s/.test(header)) return { kind: 'malformed', code: 'RANGE_UNSUPPORTED' };
  const spec = header.slice(6);
  const match = /^([0-9]*)-([0-9]*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return { kind: 'malformed', code: 'RANGE_UNSUPPORTED' };
  if (size === 0) return { kind: 'unsatisfiable', code: 'RANGE_NOT_SATISFIABLE' };
  if (!match[1]) {
    const suffix = number(match[2]);
    if (suffix === null) return { kind: 'malformed', code: 'RANGE_UNSUPPORTED' };
    if (suffix === 0) return { kind: 'unsatisfiable', code: 'RANGE_NOT_SATISFIABLE' };
    const length = Math.min(suffix, size);
    return { kind: 'partial', start: size - length, end: size - 1, length };
  }
  const start = number(match[1]);
  const requestedEnd = match[2] ? number(match[2]) : size - 1;
  if (start === null || requestedEnd === null) return { kind: 'malformed', code: 'RANGE_UNSUPPORTED' };
  if (start >= size || requestedEnd < start) return { kind: 'unsatisfiable', code: 'RANGE_NOT_SATISFIABLE' };
  const end = Math.min(requestedEnd, size - 1);
  return { kind: 'partial', start, end, length: end - start + 1 };
}
