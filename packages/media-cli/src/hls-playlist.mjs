import path from 'node:path';

export function parseMediaPlaylist(text, playlistPath = 'index.m3u8') {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '#EXTM3U') throw new Error(`${playlistPath}: missing EXTM3U`);
  if (!lines.includes('#EXT-X-PLAYLIST-TYPE:VOD')) throw new Error(`${playlistPath}: missing VOD type`);
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error(`${playlistPath}: missing ENDLIST`);
  if (!lines.includes('#EXT-X-INDEPENDENT-SEGMENTS')) throw new Error(`${playlistPath}: missing independent segments`);
  const mediaSequenceLine = lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  if (mediaSequenceLine && mediaSequenceLine !== '#EXT-X-MEDIA-SEQUENCE:0') throw new Error(`${playlistPath}: media sequence must be zero`);
  const targetLine = lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:'));
  if (!targetLine) throw new Error(`${playlistPath}: missing target duration`);
  const targetDuration = Number(targetLine.slice(targetLine.indexOf(':') + 1));
  if (!Number.isInteger(targetDuration) || targetDuration <= 0) throw new Error(`${playlistPath}: invalid target duration`);

  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXTINF:')) continue;
    const duration = line.slice(8).split(',')[0];
    if (!/^[0-9]+(?:\.[0-9]+)?$/.test(duration) || Number(duration) <= 0) throw new Error(`${playlistPath}: invalid EXTINF`);
    const uri = lines[index + 1];
    if (!uri || uri.startsWith('#')) throw new Error(`${playlistPath}: missing segment URI`);
    if (uri.includes('?') || uri.includes('#') || uri.includes('\\') || path.posix.isAbsolute(uri) || uri.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new Error(`${playlistPath}: unsafe segment URI ${uri}`);
    }
    if (!/^seg_[0-9]{5}\.ts$/.test(uri)) throw new Error(`${playlistPath}: non-deterministic segment URI ${uri}`);
    segments.push({ sequence: segments.length, duration, uri });
  }
  if (segments.length === 0) throw new Error(`${playlistPath}: no segments`);
  const maxDuration = Math.max(...segments.map((segment) => Number(segment.duration)));
  if (targetDuration !== Math.ceil(maxDuration)) throw new Error(`${playlistPath}: TARGETDURATION mismatch`);
  return { targetDuration, segments };
}
