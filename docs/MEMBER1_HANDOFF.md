# Member 1 Integration Handoff

This is the short operational handoff for the player and experiment-analysis owners. Read `MEMBER1_IMPLEMENTATION.md` for design rationale and complete evidence.

## Prerequisites

```bash
npm ci
npm run check:foundation
npm test
```

The local machine must also have the validated `media/` payload. Confirm it with:

```bash
npm run media:validate -- --output media
```

Expected package-manifest SHA-256:

```text
a8c65b415d4729f84e1a17f6882623a47e2e3f1b0f24739c07224d7a96201158
```

## Start server

```bash
npm run server
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

Expected responses:

```json
{"status":"ok"}
{"status":"ready"}
```

## Minimal run sequence

Create:

```bash
curl -sS http://127.0.0.1:8080/api/v1/runs \
  -H 'content-type: application/json' \
  -d '{
    "requestId":"REPLACE_WITH_UUID",
    "experimentId":"abr-under-uncertainty-v1",
    "scenarioId":"stable-v1",
    "policyId":"default-hlsjs",
    "repetition":1,
    "orderSeed":20261109,
    "clientLabel":"player",
    "gitCommit":"REPLACE_WITH_40_HEX_COMMIT",
    "gitDirty":false
  }'
```

Start the returned run:

```bash
curl -sS http://127.0.0.1:8080/api/v1/runs/RUN_ID/start \
  -H 'content-type: application/json' \
  -d '{"clientSendEpochMs":0,"clientSendMonoMs":0}'
```

Load the returned `hlsUrl` in the hls.js player. Do not construct a non-run-scoped media URL.

Post telemetry:

```bash
curl -sS http://127.0.0.1:8080/api/v1/runs/RUN_ID/events \
  -H 'content-type: application/json' \
  --data-binary @event-batch.json
```

Finish:

```bash
curl -sS http://127.0.0.1:8080/api/v1/runs/RUN_ID/finish \
  -H 'content-type: application/json' \
  -d '{"reason":"ended","lastSeq":123,"clientSummary":{}}'
```

For harness failure, call `/abort` instead of `/finish`.

## Raw outputs

Each run is stored under:

```text
results/raw/{runId}/
  run.json
  events.ndjson
  server-requests.ndjson
  scheduler-writes.ndjson
```

Never edit these files during analysis. Copy or read them into derived-output folders.

## Fixed integration rules

- One started run equals one fresh player session.
- The player must use the server-provided run-scoped master URL.
- Browser HTTP cache and service workers must be disabled for counted runs.
- Event identity is `(runId, source, seq)`.
- Exact event replay is safe; conflicting reuse returns `409`.
- `/finish` succeeds only when player sequences are contiguous from `0` through `lastSeq`; resend missing events before retrying finish.
- A run records immutable `policyId`; do not infer policy later from filenames.
- Scenario time begins only at `/start`.
- A server restart marks an active run `FAILED` with `SERVER_RESTART`; rerun it with lineage rather than resuming or resetting its clock.
- Playlists and API calls are unshaped; successful `.ts` bodies share one aggregate run cap.
- Range requests are supported, but multi-range requests are rejected.
- Reaction anchors come from `configs/scenarios/manifest.json`.
- Measured package rates come from `media/package.json`, not nominal encoder targets.

## Contract locations

```text
contracts/openapi.yaml
contracts/schemas/run.schema.json
contracts/schemas/telemetry-event.schema.json
contracts/schemas/server-request.schema.json
contracts/schemas/scheduler-event.schema.json
contracts/schemas/media-package.schema.json
contracts/schemas/scenario-manifest.schema.json
```

If an interface must change, update the contract and request review from every affected owner before changing the implementation.
