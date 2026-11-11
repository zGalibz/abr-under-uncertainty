export const LADDER = Object.freeze([
  { id: 'v0', width: 640, height: 360, targetVideoBps: 500000, maxVideoBps: 550000, bufferBps: 1000000, level: '3.0' },
  { id: 'v1', width: 854, height: 480, targetVideoBps: 900000, maxVideoBps: 990000, bufferBps: 1800000, level: '3.1' },
  { id: 'v2', width: 1280, height: 720, targetVideoBps: 1800000, maxVideoBps: 1980000, bufferBps: 3600000, level: '3.1' },
  { id: 'v3', width: 1920, height: 1080, targetVideoBps: 3200000, maxVideoBps: 3520000, bufferBps: 6400000, level: '4.0' },
]);

const kb = (value) => `${Math.round(value / 1000)}k`;

export function buildFfmpegArgs({ source, output, duration = null, preset = 'medium' }) {
  const filter = [
    '[0:v:0]fps=fps=30:start_time=0,split=4[v0in][v1in][v2in][v3in]',
    '[v0in]scale=640:360:flags=lanczos,setsar=1[v0]',
    '[v1in]scale=854:480:flags=lanczos,setsar=1[v1]',
    '[v2in]scale=1280:720:flags=lanczos,setsar=1[v2]',
    '[v3in]scale=1920:1080:flags=lanczos,setsar=1[v3]',
    '[0:a:0]aresample=48000:first_pts=0,asplit=4[a0][a1][a2][a3]',
  ].join(';');
  const args = ['-hide_banner', '-y', '-i', source];
  if (duration !== null) args.push('-t', String(duration));
  args.push('-filter_complex', filter);
  for (let index = 0; index < 4; index += 1) args.push('-map', `[v${index}]`, '-map', `[a${index}]`);
  args.push('-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p', '-profile:v', 'high');
  for (let index = 0; index < 4; index += 1) args.push(`-level:v:${index}`, LADDER[index].level);
  for (let index = 0; index < 4; index += 1) {
    const item = LADDER[index];
    args.push(`-b:v:${index}`, kb(item.targetVideoBps), `-maxrate:v:${index}`, kb(item.maxVideoBps), `-bufsize:v:${index}`, kb(item.bufferBps));
  }
  args.push(
    '-g:v', '60', '-keyint_min:v', '60', '-sc_threshold:v', '0', '-flags:v', '+cgop',
    '-force_key_frames:v', 'expr:gte(t,n_forced*2)',
    '-x264-params:v', 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:force-cfr=1',
    '-fps_mode:v', 'cfr', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k', '-ar:a', '48000', '-ac:a', '2', '-shortest',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments', '-start_number', '0', '-hls_segment_filename', `${output}/%v/seg_%05d.ts`,
    '-master_pl_name', 'master.ffmpeg.m3u8', '-var_stream_map', 'v:0,a:0,name:v0 v:1,a:1,name:v1 v:2,a:2,name:v2 v:3,a:3,name:v3',
    `${output}/%v/index.m3u8`,
  );
  return args;
}
