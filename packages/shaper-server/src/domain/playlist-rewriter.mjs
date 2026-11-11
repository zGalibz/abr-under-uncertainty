import path from 'node:path';

function encodePath(relative) {
  return relative.split('/').map(encodeURIComponent).join('/');
}

function resolveUri(uri, playlistRelativePath) {
  if (!uri || uri.includes('\\') || uri.includes('?') || uri.includes('#') || uri.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(uri)) throw new Error(`unsafe playlist URI: ${uri}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(playlistRelativePath), uri));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) throw new Error(`unsafe playlist URI: ${uri}`);
  return resolved;
}

export function rewritePlaylist({ text, playlistRelativePath, runId }) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const terminal = text.endsWith('\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (terminal) lines.pop();
  const rewritten = lines.map((line) => {
    if (!line || line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="/stream/v1/${runId}/${encodePath(resolveUri(uri, playlistRelativePath))}"`);
    }
    return `/stream/v1/${runId}/${encodePath(resolveUri(line, playlistRelativePath))}`;
  });
  return `${rewritten.join(newline)}${terminal ? newline : ''}`;
}
