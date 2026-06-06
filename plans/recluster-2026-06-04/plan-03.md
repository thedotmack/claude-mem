# [plan-03] Worker / Daemon Lifecycle Hardening — supervision, identity, resource bounds

## Defect

The worker/daemon has no robust lifecycle contract: startup health is checked against the wrong PID so `start` reports "process died during startup" even when it is alive; the PID file is never validated against process identity, so a recycled PID produces a permanent ghost-PID deadlock; the generator's spawned SDK child is SIGTERM'd (exit 143) mid-run leaving the queue to drown; Bun workers OOM-cascade when the host runs a heavy dev server; observer transcripts grow unbounded (single 1.9 GB JSONL); and on Windows the cumulative effect is zero observations ever generated. These are all the same gap: no identity-validated supervision with bounded resources and honest health.

## Children

- #2747 — worker-cli `start` always fails 'Process died during startup' — waitForHealth checks the wrong PID
- #2726 — Worker PID file not validated against process identity → permanent ghost-PID deadlock (Windows)
- #2740 — Generator's spawned SDK child gets SIGTERM (exit 143) at ~3 min; no observations insert; queue drowns
- #2720 — Bun workers OOM cascade on Windows when host project runs Next.js dev (Turbopack)
- #2754 — Observer session transcripts grow unbounded — single 1.9 GB JSONL, 6.1 GB total
- #2703 — 0 observations ever generated on Windows (cross-cutting worker defects)

## Fix sequence

Design doc: `plans/03-worker-lifecycle.md`. Health-check the actual spawned PID; validate PID-file identity (pid+start-time) before trusting/killing; supervise the SDK child with restart-on-unexpected-exit and queue drain protection; bound memory + transcript size with rotation; converge the Windows zero-observation path on the above.

## Test matrix

| Host | Scenario | Required behavior |
|---|---|---|
| all | start | health checks the real PID; no false "died" |
| all | recycled PID | identity mismatch → no ghost deadlock |
| all | long generation | SDK child survives or restarts; queue drains |
| Windows | host Next.js dev running | no OOM cascade; observations land |
| all | long session | transcript rotates; bounded disk |

## Out of scope

Env contamination of the SDK subprocess (was plan-06); observer output parsing (plan-11).
