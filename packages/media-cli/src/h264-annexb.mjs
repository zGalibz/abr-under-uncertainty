function startCodes(buffer) {
  const starts = [];
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 1) {
      starts.push(index + 3);
      index += 2;
    } else if (index + 4 < buffer.length && buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 0 && buffer[index + 3] === 1) {
      starts.push(index + 4);
      index += 3;
    }
  }
  return starts;
}

export function nalTypes(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Annex-B input must be a Buffer');
  return startCodes(buffer).filter((index) => index < buffer.length).map((index) => buffer[index] & 0x1f);
}

export function firstVclNalType(buffer) {
  return nalTypes(buffer).find((type) => type >= 1 && type <= 5) ?? null;
}
