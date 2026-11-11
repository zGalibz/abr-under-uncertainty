import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFfmpegArgs, LADDER } from '../src/ffmpeg-command.mjs';
import { renderMasterPlaylist } from '../src/master-manifest.mjs';
import { firstVclNalType } from '../src/h264-annexb.mjs';

test('builds a four-rendition aligned FFmpeg command', () => {
  const args = buildFfmpegArgs({ source: 'assets/source/source.mp4', output: 'media' });
  assert.deepEqual(LADDER.map(({ id, width, height, targetVideoBps }) => ({ id, width, height, targetVideoBps })), [
    { id: 'v0', width: 640, height: 360, targetVideoBps: 500000 },
    { id: 'v1', width: 854, height: 480, targetVideoBps: 900000 },
    { id: 'v2', width: 1280, height: 720, targetVideoBps: 1800000 },
    { id: 'v3', width: 1920, height: 1080, targetVideoBps: 3200000 },
  ]);
  assert.ok(args.includes('expr:gte(t,n_forced*2)'));
  assert.ok(args.includes('keyint=60:min-keyint=60:scenecut=0:open-gop=0:force-cfr=1'));
  assert.ok(args.includes('v:0,a:0,name:v0 v:1,a:1,name:v1 v:2,a:2,name:v2 v:3,a:3,name:v3'));
  assert.equal(args.at(-1), 'media/%v/index.m3u8');
});

test('renders measured master attributes in canonical order', () => {
  const text = renderMasterPlaylist([
    { id: 'v1', width: 854, height: 480, peakBps: 1000000, averageBps: 900000, codecs: 'avc1.64001f,mp4a.40.2' },
    { id: 'v0', width: 640, height: 360, peakBps: 600000, averageBps: 550000, codecs: 'avc1.64001e,mp4a.40.2' },
    { id: 'v3', width: 1920, height: 1080, peakBps: 3500000, averageBps: 3200000, codecs: 'avc1.640028,mp4a.40.2' },
    { id: 'v2', width: 1280, height: 720, peakBps: 2000000, averageBps: 1800000, codecs: 'avc1.64001f,mp4a.40.2' },
  ]);
  assert.match(text, /^#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n/);
  assert.ok(text.indexOf('v0/index.m3u8') < text.indexOf('v3/index.m3u8'));
  assert.match(text, /BANDWIDTH=600000,AVERAGE-BANDWIDTH=550000,CODECS="avc1\.64001e,mp4a\.40\.2",RESOLUTION=640x360,FRAME-RATE=30\.000/);
});

test('identifies the first VCL NAL as IDR', () => {
  const annexB = Buffer.from([0,0,0,1,0x67,1,2,0,0,1,0x68,3,0,0,1,0x65,4,5]);
  assert.equal(firstVclNalType(annexB), 5);
  const nonIdr = Buffer.from([0,0,1,0x41,1]);
  assert.equal(firstVclNalType(nonIdr), 1);
});
