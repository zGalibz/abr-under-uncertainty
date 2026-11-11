import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';

export async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}
