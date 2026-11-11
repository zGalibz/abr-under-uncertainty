# Media CLI

Reproducibly packages one source into the four-level aligned HLS ladder and validates the result.

## Commands

From the repository root:

```bash
npm run media:package -- \
  --source assets/source/source.mp4 \
  --output media \
  --preset medium \
  --license "public domain (user-provided claim)"

npm run media:validate -- --output media
npm run test:media
```

The package command removes and rebuilds the output directory, runs FFmpeg, calculates measured bandwidth, renders the canonical master playlist, creates `package.json`, and performs full validation.

The validator verifies file hashes, playlists, codec properties, decoding, key/IDR starts, GOP length, timestamp alignment, and measured bandwidth. It writes `validation-report.json` only after all checks pass.

Use an absolute source path in a fresh checkout. Relative CLI paths are resolved from the repository command directory, including npm workspace execution.
