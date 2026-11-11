#!/usr/bin/env node
import process from 'node:process';
import { packageMedia, validateMediaPackage } from '../src/package-hls.mjs';
import { resolveUserPath } from '../src/cli-path.mjs';

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${item}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = options(rest);
  if (command === 'package') {
    const source = resolveUserPath(opts.source ?? 'assets/source/source.mp4');
    const output = resolveUserPath(opts.output ?? 'media');
    const result = await packageMedia({ source, output, preset: opts.preset ?? 'medium', duration: opts.duration ? Number(opts.duration) : null, licenseClaim: opts.license ?? 'public domain (user-provided claim)' });
    console.log(JSON.stringify({ valid: result.report.valid, output, renditions: result.manifest.renditions.map(({ id, segmentCount, measuredPeakBps, measuredAverageBps }) => ({ id, segmentCount, measuredPeakBps, measuredAverageBps })) }, null, 2));
    return;
  }
  if (command === 'validate') {
    const output = resolveUserPath(opts.output ?? 'media');
    const report = await validateMediaPackage({ output });
    console.log(JSON.stringify(report, null, 2));
    if (!report.valid) process.exitCode = 1;
    return;
  }
  throw new Error('usage: abr-media <package|validate> [--source path] [--output path] [--preset name] [--duration seconds]');
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
