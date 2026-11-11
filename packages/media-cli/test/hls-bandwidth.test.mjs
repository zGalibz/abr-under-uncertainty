import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMediaPlaylist } from '../src/hls-playlist.mjs';
import { measuredBandwidth } from '../src/bandwidth.mjs';

const valid = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:2.000000,
seg_00000.ts
#EXTINF:1.500000,
seg_00001.ts
#EXT-X-ENDLIST
`;

test('parses a strict deterministic VOD playlist', () => {
  const parsed = parseMediaPlaylist(valid, 'v0/index.m3u8');
  assert.equal(parsed.targetDuration, 2);
  assert.deepEqual(parsed.segments, [
    { sequence: 0, duration: '2.000000', uri: 'seg_00000.ts' },
    { sequence: 1, duration: '1.500000', uri: 'seg_00001.ts' },
  ]);
});

test('rejects traversal and incomplete VOD playlists', () => {
  assert.throws(() => parseMediaPlaylist(valid.replace('seg_00000.ts', '../x.ts'), 'v0/index.m3u8'), /unsafe segment URI/);
  assert.throws(() => parseMediaPlaylist(valid.replace('#EXT-X-ENDLIST\n', ''), 'v0/index.m3u8'), /ENDLIST/);
});

test('calculates peak and weighted average using exact ceiling arithmetic', () => {
  const result = measuredBandwidth([
    { bytes: 162996, duration: '2.000000' },
    { bytes: 100000, duration: '1.500000' },
  ]);
  assert.deepEqual(result, { peakBps: 651984, averageBps: 601134 });
});

test('ceils a fractional peak instead of understating it', () => {
  const result = measuredBandwidth([{ bytes: 162996, duration: '2.000001' }]);
  assert.equal(result.peakBps, 651984);
});
