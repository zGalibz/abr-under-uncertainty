# Shaper Server

Local same-origin experiment server for lifecycle control, telemetry persistence, run-scoped HLS delivery, and deterministic aggregate bandwidth shaping.

## Commands

```bash
npm run scenarios:compile
npm run calibrate:scenarios
npm run server
npm run test:server
```

Default binding: `127.0.0.1:8080`.

Override only when needed:

```bash
HOST=127.0.0.1 PORT=8090 npm run server
```

## Design invariants

- one aggregate FIFO token budget per started run;
- zero initial tokens, 16 KiB burst, 4 KiB maximum write;
- monotonic phase timing with boundary-aware capacity integration;
- playlists and API traffic bypass shaping;
- successful media bodies consume the shared budget;
- atomic run-state snapshots and append-only NDJSON evidence;
- idempotent create/lifecycle/event replay behavior;
- loopback binding and secure real-path containment by default.

API details are normative in `contracts/openapi.yaml`. Artifact shapes are normative in `contracts/schemas/`.
