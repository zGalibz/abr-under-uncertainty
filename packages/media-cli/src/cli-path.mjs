import path from 'node:path';

export function resolveUserPath(value, { cwd = process.cwd(), initCwd = process.env.INIT_CWD } = {}) {
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(initCwd || cwd, value);
}
