# Member 1 Verification Record

Verification date: 2026-11-11 16:22 CST

## Environment

```text
macOS host
Node.js v26.8.1
npm 11.19.0
FFmpeg 9.0.2 with libx264
FFprobe 9.0.2
```

## Frozen identities

```text
source SHA-256:
fda77d579859928e9c4134dc7a66eacc69cbeaed2860668130bfce05ac995dc1

package manifest SHA-256:
a8c65b415d4729f84e1a17f6882623a47e2e3f1b0f24739c07224d7a96201158

scenario manifest SHA-256:
91048d006f673b854174e9ffa73a9e6e3bdc46a7a59c8a4a6ff286c767d5b03e
```

## Commands and observed results

```text
npm run check:foundation
PASS — 3 frozen scenarios, experiment config, telemetry example,
Member 1 manifests, and calibration evidence.

npx --yes @redocly/cli@latest lint contracts/openapi.yaml
PASS — API description valid.

npm test
PASS — 28 tests total:
  4 contract tests
  10 media tests
  14 shaper-server tests

npm audit --audit-level=moderate
PASS — 0 vulnerabilities.

git diff --check
PASS — no whitespace errors.

npm run media:validate -- --output media
PASS — 265 payload files checked and independently re-inspected; four aligned decodable renditions.

npm run calibrate:scenarios
PASS — 16/16 plateau gates and 13/13 transition gates.
```

## Live server smoke test

The production CLI was started at `127.0.0.1:8099` and read back:

```text
GET /healthz  -> {"status":"ok"}
GET /readyz   -> {"status":"ready"}
```

The process was then shut down.

## Interpretation boundary

These results verify Member 1 media/network correctness and calibration only. They do not measure or compare the default and conservative ABR policies. The policy result remains pending until the complete controlled experiment matrix is run and validated.
