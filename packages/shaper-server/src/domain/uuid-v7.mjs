import { randomBytes as cryptoRandomBytes } from 'node:crypto';

const RUN_RE = /^r_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MASK_74 = (1n << 74n) - 1n;
const MASK_62 = (1n << 62n) - 1n;

function random74(randomBytes) {
  const buffer = randomBytes(10);
  let value = 0n;
  for (const byte of buffer) value = (value << 8n) | BigInt(byte);
  return value & MASK_74;
}

function format(timestamp, payload) {
  const bytes = Buffer.alloc(16);
  let time = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) { bytes[index] = Number(time & 0xffn); time >>= 8n; }
  const randA = Number((payload >> 62n) & 0xfffn);
  const randB = payload & MASK_62;
  bytes[6] = 0x70 | ((randA >> 8) & 0x0f);
  bytes[7] = randA & 0xff;
  let tail = randB;
  for (let index = 15; index >= 8; index -= 1) { bytes[index] = Number(tail & 0xffn); tail >>= 8n; }
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function createUuidV7Generator({ wallClock = { nowEpochMs: () => Date.now() }, randomBytes = cryptoRandomBytes } = {}) {
  let lastTime = -1;
  let payload = 0n;
  return {
    next() {
      const observed = Math.trunc(wallClock.nowEpochMs());
      if (!Number.isSafeInteger(observed) || observed < 0 || observed >= 2 ** 48) throw new RangeError('UUIDv7 timestamp is outside 48-bit range');
      const timestamp = Math.max(observed, lastTime);
      if (timestamp === lastTime) {
        payload = (payload + 1n) & MASK_74;
        if (payload === 0n) throw new Error('UUIDv7 logical payload exhausted');
      } else {
        payload = random74(randomBytes);
        lastTime = timestamp;
      }
      return format(timestamp, payload);
    },
  };
}

export const formatRunId = (uuid) => `r_${uuid}`;
export const isRunId = (value) => typeof value === 'string' && RUN_RE.test(value);
