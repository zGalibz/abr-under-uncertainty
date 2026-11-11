import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function invalid(message) {
  const error = new Error(`INVALID_ASSET_PATH: ${message}`);
  error.code = 'INVALID_ASSET_PATH';
  error.status = 400;
  return error;
}

export async function createAssetResolver({ packageRoot }) {
  const realRoot = await realpath(packageRoot);
  return {
    async resolve(raw) {
      if (typeof raw !== 'string' || !raw || /%(?:2f|5c)/i.test(raw) || raw.includes('\\') || raw.includes('\0')) throw invalid('unsafe encoded path');
      let decoded;
      try { decoded = decodeURIComponent(raw); } catch { throw invalid('malformed encoding'); }
      if (!decoded || decoded.includes('\\') || decoded.includes('\0') || path.posix.isAbsolute(decoded)) throw invalid('unsafe decoded path');
      const parts = decoded.split('/');
      if (parts.some((part) => !part || part === '.' || part === '..')) throw invalid('unsafe path segment');
      const lexical = path.resolve(realRoot, ...parts);
      if (!lexical.startsWith(`${realRoot}${path.sep}`)) throw invalid('path escapes package root');
      let targetReal;
      try { targetReal = await realpath(lexical); } catch (error) {
        if (error.code === 'ENOENT') { error.code = 'ASSET_NOT_FOUND'; error.status = 404; }
        throw error;
      }
      const relative = path.relative(realRoot, targetReal);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw invalid('symlink escapes package root');
      const fileStat = await stat(targetReal);
      if (!fileStat.isFile()) throw invalid('asset is not a regular file');
      return { relativePath: parts.join('/'), absolutePath: lexical, realPath: targetReal, stat: fileStat, extension: path.extname(targetReal).toLowerCase() };
    },
  };
}
