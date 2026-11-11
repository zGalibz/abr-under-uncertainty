export function renderMasterPlaylist(renditions) {
  const ordered = [...renditions].sort((a, b) => a.id.localeCompare(b.id));
  if (ordered.map((item) => item.id).join(',') !== 'v0,v1,v2,v3') throw new Error('master requires v0 through v3');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const item of ordered) {
    for (const key of ['width', 'height', 'peakBps', 'averageBps']) {
      if (!Number.isSafeInteger(item[key]) || item[key] <= 0) throw new Error(`invalid ${key} for ${item.id}`);
    }
    if (!item.codecs || /["\r\n]/.test(item.codecs)) throw new Error(`invalid codecs for ${item.id}`);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${item.peakBps},AVERAGE-BANDWIDTH=${item.averageBps},CODECS="${item.codecs}",RESOLUTION=${item.width}x${item.height},FRAME-RATE=30.000`);
    lines.push(`${item.id}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}
