# ADR-002: Media measurement, package hashing, and run-wide shaping

- Status: Accepted for Member 1 implementation; team contract review pending
- Decision owners: media/networking owner, with player and analysis owners as affected reviewers

## Context

The experiment requires one reproducible HLS package and identical network conditions across parallel browser requests. Nominal encoder targets do not equal muxed network demand, per-request throttling multiplies capacity under concurrency, and a package manifest cannot contain a stable hash of itself.

## Decisions

1. Calculate each rendition's peak and weighted-average bandwidth from complete MPEG-TS segment bytes and `EXTINF` duration, including audio and container overhead. Round upward.
2. Generate the canonical master playlist after encoding from those measured values.
3. Hash every package payload inside `media/package.json`, excluding the manifest itself. Record the manifest's external SHA-256 in `media/validation-report.json` and `configs/experiment.v1.json`.
4. Use one aggregate token ledger and FIFO scheduler per run, not one limiter per request.
5. Start with zero tokens, cap burst credit at 16 KiB, and cap each write at 4 KiB.
6. Integrate capacity over server monotonic time and split elapsed intervals at half-open scenario boundaries.
7. Persist run state atomically and evidence as append-only NDJSON. Treat exact retries as idempotent and conflicting retries as `409`.
8. Shape only successful media response bodies; do not shape API, playlist, HEAD, rejection, or error traffic.

## Consequences

- Concurrent segment fetches cannot multiply the configured bandwidth.
- Scenario thresholds and ABR interpretation use actual package demand.
- The package digest has no self-reference ambiguity.
- Browser retries preserve one evidence record instead of creating silent duplicates.
- The local server is intentionally specialized for controlled single-host experiments rather than general web hosting.
