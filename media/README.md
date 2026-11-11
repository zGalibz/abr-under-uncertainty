# Generated HLS package

The local validated package contains four H.264/AAC MPEG-TS renditions with aligned two-second segments.

## Verified package

| ID | Resolution | Target video | Segments | Measured peak | Measured average |
|---|---:|---:|---:|---:|---:|
| `v0` | 640×360 | 500 kbit/s | 65 | 806,144 bit/s | 637,086 bit/s |
| `v1` | 854×480 | 900 kbit/s | 65 | 1,391,200 bit/s | 1,035,116 bit/s |
| `v2` | 1280×720 | 1,800 kbit/s | 65 | 2,704,192 bit/s | 1,928,178 bit/s |
| `v3` | 1920×1080 | 3,200 kbit/s | 65 | 4,790,240 bit/s | 3,319,421 bit/s |

Package-manifest SHA-256 from the final validation run:

`a8c65b415d4729f84e1a17f6882623a47e2e3f1b0f24739c07224d7a96201158`

The validation checked 265 payload files, decoded all four complete renditions, verified hashes, equal segment counts, cross-rendition duration/PTS alignment, first-packet key flags, and IDR NAL boundaries. The local package passed with no errors or warnings.

## Reproduce

```bash
npm ci
npm run package -w @abr-lab/media-cli -- \
  --source assets/source/source.mp4 \
  --output media \
  --preset medium \
  --license "public domain (user-provided claim)"

npm run validate -w @abr-lab/media-cli -- --output media
```

Generated segment files are excluded from ordinary Git history. `package.json` and `validation-report.json` are retained as the evidence/handoff metadata; a distribution archive can be attached to a repository release when teammates need the exact media bytes.
