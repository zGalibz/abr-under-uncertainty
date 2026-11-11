import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildFfmpegArgs, LADDER } from './ffmpeg-command.mjs';
import { parseMediaPlaylist } from './hls-playlist.mjs';
import { measuredBandwidth } from './bandwidth.mjs';
import { renderMasterPlaylist } from './master-manifest.mjs';
import { firstVclNalType } from './h264-annexb.mjs';

const exec = promisify(execFile);

async function run(command, args, options = {}) {
  return exec(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
}

async function jsonCommand(command, args) {
  const { stdout } = await run(command, args, { encoding: 'utf8' });
  return JSON.parse(stdout);
}

async function firstVersionLine(command) {
  const { stdout } = await run(command, ['-version'], { encoding: 'utf8' });
  return stdout.split(/\r?\n/)[0];
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function gitInfo() {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
      run('git', ['status', '--porcelain'], { encoding: 'utf8' }),
    ]);
    return { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { commit: '0000000000000000000000000000000000000000', dirty: true };
  }
}

async function sourceMetadata(source) {
  const probe = await jsonCommand('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,sample_rate,channels',
    '-of', 'json', source,
  ]);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  if (!video || !audio) throw new Error('source must contain one video and one audio stream');
  return {
    durationSeconds: Number(probe.format.duration), width: video.width, height: video.height,
    frameRate: video.avg_frame_rate, videoCodec: video.codec_name, audioCodec: audio.codec_name,
    audioSampleRate: Number(audio.sample_rate), audioChannels: audio.channels,
  };
}

function parseMasterCodecs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const codecs = new Map();
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const match = /CODECS="([^"]+)"/.exec(lines[index]);
    const uri = lines[index + 1];
    const id = uri.split('/')[0];
    if (match && /^v[0-3]$/.test(id)) codecs.set(id, match[1]);
  }
  return codecs;
}

async function inspectSegment(file, duration, relativeUri) {
  const fileStat = await stat(file);
  const packetProbe = await jsonCommand('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_packets',
    '-show_entries', 'packet=pts,dts,flags', '-of', 'json', file,
  ]);
  const packets = packetProbe.packets ?? [];
  if (packets.length === 0) throw new Error(`${relativeUri}: no video packets`);
  const first = packets[0];
  if (!String(first.flags ?? '').includes('K')) throw new Error(`${relativeUri}: first video packet is not key`);
  const { stdout } = await run('ffmpeg', [
    '-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-c:v', 'copy', '-f', 'h264', 'pipe:1',
  ], { encoding: 'buffer' });
  const nalType = firstVclNalType(stdout);
  if (nalType !== 5) throw new Error(`${relativeUri}: first VCL NAL is ${nalType}, expected IDR type 5`);
  const rate = measuredBandwidth([{ bytes: fileStat.size, duration }]).peakBps;
  return {
    bytes: fileStat.size, rateBps: rate, firstVideoPts90k: Number(first.pts), firstVideoDts90k: Number(first.dts),
    frameCount: packets.length, firstFrameKey: true, firstVclNalType: nalType, sha256: await sha256File(file),
  };
}

async function validateRenditionStreams(playlist, expected) {
  const probe = await jsonCommand('ffprobe', [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,profile,width,height,pix_fmt,avg_frame_rate,sample_rate,channels',
    '-of', 'json', playlist,
  ]);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  if (!video || !audio || probe.streams.filter((stream) => ['video', 'audio'].includes(stream.codec_type)).length !== 2) throw new Error(`${expected.id}: expected exactly video and audio`);
  if (video.codec_name !== 'h264' || video.width !== expected.width || video.height !== expected.height || video.pix_fmt !== 'yuv420p' || video.avg_frame_rate !== '30/1') throw new Error(`${expected.id}: video stream mismatch`);
  if (audio.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || audio.channels !== 2) throw new Error(`${expected.id}: audio stream mismatch`);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-xerror', '-i', playlist, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
}

async function generatedFiles(output) {
  const files = ['master.m3u8'];
  for (const item of LADDER) {
    files.push(`${item.id}/index.m3u8`);
    const names = (await readdir(path.join(output, item.id))).filter((name) => /^seg_[0-9]{5}\.ts$/.test(name)).sort();
    files.push(...names.map((name) => `${item.id}/${name}`));
  }
  return files;
}

async function allRelativeFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await allRelativeFiles(root, absolute));
    else files.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return files.sort();
}

export async function validateMediaPackage({ output }) {
  const errors = [];
  const checks = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
    checks.push({ id: 'manifest-readable', passed: true, details: 'package.json parsed' });
  } catch (error) {
    return { schemaVersion: '1.0.0', validatedAt: new Date().toISOString(), gitCommit: (await gitInfo()).commit, gitDirty: true, packageManifestSha256: '0'.repeat(64), valid: false, checks: [], errors: [error.message], warnings: [] };
  }
  const allowedFiles = new Set([...Object.keys(manifest.files), 'package.json', 'validation-report.json', 'README.md', '.gitkeep']);
  for (const relative of await allRelativeFiles(output)) {
    if (!allowedFiles.has(relative)) errors.push(`unexpected package file: ${relative}`);
  }
  for (const [relative, expectedHash] of Object.entries(manifest.files)) {
    try {
      const actual = await sha256File(path.join(output, relative));
      if (actual !== expectedHash) errors.push(`${relative}: SHA-256 mismatch`);
    } catch (error) { errors.push(`${relative}: ${error.message}`); }
  }
  checks.push({ id: 'file-hashes', passed: errors.length === 0, details: `${Object.keys(manifest.files).length} payload files checked` });
  try {
    const parsed = [];
    const measuredRenditions = [];
    for (let index = 0; index < LADDER.length; index += 1) {
      const ladder = LADDER[index];
      const rendition = manifest.renditions[index];
      if (rendition.id !== ladder.id) throw new Error(`rendition order mismatch at ${index}`);
      const playlistFile = path.join(output, rendition.playlist);
      await validateRenditionStreams(playlistFile, ladder);
      const playlistText = await readFile(playlistFile, 'utf8');
      const playlist = parseMediaPlaylist(playlistText, rendition.playlist);
      if (await sha256File(playlistFile) !== rendition.playlistSha256) throw new Error(`${ladder.id}: playlist SHA-256 metadata mismatch`);
      if (playlist.segments.length !== rendition.segmentCount || playlist.segments.length !== rendition.segments.length) throw new Error(`${ladder.id}: segment count mismatch`);
      const actualSegments = [];
      for (let segmentIndex = 0; segmentIndex < playlist.segments.length; segmentIndex += 1) {
        const listed = playlist.segments[segmentIndex];
        const expectedSegment = rendition.segments[segmentIndex];
        const relativeUri = `${ladder.id}/${listed.uri}`;
        if (expectedSegment.sequence !== listed.sequence || expectedSegment.uri !== relativeUri || expectedSegment.extinfSeconds !== listed.duration) throw new Error(`${relativeUri}: manifest playlist metadata mismatch`);
        const actual = await inspectSegment(path.join(output, relativeUri), listed.duration, relativeUri);
        for (const key of ['bytes', 'rateBps', 'firstVideoPts90k', 'firstVideoDts90k', 'frameCount', 'firstFrameKey', 'firstVclNalType', 'sha256']) {
          if (actual[key] !== expectedSegment[key]) throw new Error(`${relativeUri}: ${key} metadata mismatch`);
        }
        actualSegments.push({ ...actual, extinfSeconds: listed.duration });
      }
      const measured = measuredBandwidth(actualSegments.map((segment) => ({ bytes: segment.bytes, duration: segment.extinfSeconds })));
      if (measured.peakBps !== rendition.measuredPeakBps || measured.averageBps !== rendition.measuredAverageBps) throw new Error(`${ladder.id}: measured bandwidth metadata mismatch`);
      measuredRenditions.push({ id: ladder.id, width: ladder.width, height: ladder.height, peakBps: measured.peakBps, averageBps: measured.averageBps, codecs: rendition.codecs });
      parsed.push(playlist);
    }
    const expectedMaster = renderMasterPlaylist(measuredRenditions);
    const actualMaster = await readFile(path.join(output, manifest.masterPlaylist), 'utf8');
    if (actualMaster !== expectedMaster || await sha256File(path.join(output, manifest.masterPlaylist)) !== manifest.masterSha256) throw new Error('master playlist metadata mismatch');
    const counts = new Set(parsed.map((playlist) => playlist.segments.length));
    if (counts.size !== 1) throw new Error('rendition segment counts differ');
    for (let segmentIndex = 0; segmentIndex < parsed[0].segments.length; segmentIndex += 1) {
      const durations = parsed.map((playlist) => Number(playlist.segments[segmentIndex].duration));
      if (Math.max(...durations) - Math.min(...durations) > 1 / 30 + 1e-6) throw new Error(`segment ${segmentIndex}: duration misalignment`);
      const pts = manifest.renditions.map((rendition) => rendition.segments[segmentIndex].firstVideoPts90k);
      if (Math.max(...pts) - Math.min(...pts) > 3000) throw new Error(`segment ${segmentIndex}: PTS misalignment`);
      if (manifest.renditions.some((rendition) => rendition.segments[segmentIndex].firstVclNalType !== 5)) throw new Error(`segment ${segmentIndex}: non-IDR boundary`);
    }
    checks.push({ id: 'media-structure', passed: true, details: 'four aligned decodable renditions verified' });
  } catch (error) {
    errors.push(error.message);
    checks.push({ id: 'media-structure', passed: false, details: error.message });
  }
  const git = await gitInfo();
  return {
    schemaVersion: '1.0.0', validatedAt: new Date().toISOString(), gitCommit: git.commit, gitDirty: git.dirty,
    packageManifestSha256: await sha256File(path.join(output, 'package.json')), valid: errors.length === 0,
    checks, errors, warnings: [],
  };
}

export async function packageMedia({ source, output, preset = 'medium', duration = null, licenseClaim = 'public domain (user-provided claim)' }) {
  await stat(source);
  await mkdir(output, { recursive: true });
  for (const item of LADDER) {
    await rm(path.join(output, item.id), { recursive: true, force: true });
    await mkdir(path.join(output, item.id), { recursive: true });
  }
  for (const name of ['master.ffmpeg.m3u8', 'master.m3u8', 'package.json', 'validation-report.json']) await rm(path.join(output, name), { force: true });
  const args = buildFfmpegArgs({ source, output, duration, preset });
  await run('ffmpeg', args, { encoding: 'utf8' });
  const provisional = await readFile(path.join(output, 'master.ffmpeg.m3u8'), 'utf8');
  const codecMap = parseMasterCodecs(provisional);
  const sourceInfo = await sourceMetadata(source);
  const renditions = [];
  for (const ladder of LADDER) {
    const playlistRelative = `${ladder.id}/index.m3u8`;
    const playlistText = await readFile(path.join(output, playlistRelative), 'utf8');
    const playlist = parseMediaPlaylist(playlistText, playlistRelative);
    const segments = [];
    for (const segment of playlist.segments) {
      const relativeUri = `${ladder.id}/${segment.uri}`;
      const inspected = await inspectSegment(path.join(output, relativeUri), segment.duration, relativeUri);
      segments.push({ sequence: segment.sequence, uri: relativeUri, extinfSeconds: segment.duration, ...inspected });
    }
    const measured = measuredBandwidth(segments.map((segment) => ({ bytes: segment.bytes, duration: segment.extinfSeconds })));
    renditions.push({
      id: ladder.id, width: ladder.width, height: ladder.height, targetVideoBps: ladder.targetVideoBps,
      measuredPeakBps: measured.peakBps, measuredAverageBps: measured.averageBps,
      codecs: codecMap.get(ladder.id) ?? '', playlist: playlistRelative, playlistSha256: await sha256File(path.join(output, playlistRelative)),
      segmentCount: segments.length, segments,
    });
  }
  const master = renderMasterPlaylist(renditions.map((item) => ({ id: item.id, width: item.width, height: item.height, peakBps: item.measuredPeakBps, averageBps: item.measuredAverageBps, codecs: item.codecs })));
  await writeFile(path.join(output, 'master.m3u8'), master);
  await rm(path.join(output, 'master.ffmpeg.m3u8'), { force: true });
  const files = {};
  for (const relative of await generatedFiles(output)) files[relative] = await sha256File(path.join(output, relative));
  const ffmpegVersion = await firstVersionLine('ffmpeg');
  const ffprobeVersion = await firstVersionLine('ffprobe');
  const manifest = {
    schemaVersion: '1.0.0', assetId: 'adaptive-source-v1',
    source: { path: 'assets/source/source.mp4', sha256: await sha256File(source), ...sourceInfo, licenseClaim },
    toolchain: { ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion, node: process.version },
    packaging: { commandArgs: args, commandSha256: sha256Text(JSON.stringify(args)), frameRate: '30/1', segmentDurationSeconds: 2, gopFrames: 60, audioBitrateBps: 96000, audioSampleRate: 48000 },
    masterPlaylist: 'master.m3u8', masterSha256: files['master.m3u8'], durationSeconds: sourceInfo.durationSeconds,
    renditions, files,
  };
  await writeFile(path.join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const report = await validateMediaPackage({ output });
  await writeFile(path.join(output, 'validation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) throw new Error(`packaged media failed validation: ${report.errors.join('; ')}`);
  return { manifest, report };
}
