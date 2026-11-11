import { createHash } from 'node:crypto';

function normalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  throw new TypeError('canonical JSON supports only plain JSON values');
}

export function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

export function canonicalBytes(value) {
  return Buffer.from(`${canonicalize(value)}\n`);
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}
