# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_213114` |
| Start Time | 2026-01-25 21:31:14 UTC |
| End Time | 2026-01-25 21:33:25 UTC |
| Duration | 00:02:11 (131 seconds) |
| Poll Interval | 10s |
| Total Events | 3 |
| Anomalies | 0 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_213114_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_213114_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_213114_report.md`

---

## Event Summary

```
      1 SPAWN
      1 SESSION_START
      1 SESSION_END
```

## Peak Values

```json
{
  "peak_total_mem_mb": 25,
  "peak_swap_mb": 0,
  "min_available_mb": 27479,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

_No anomalies detected during this benchmark._

---

## Process Spawns (All)

```
2026-01-25T21:31:14.836Z | PID 11072 | claude-code 20MB fds=5 thr=1 vsz=29MB cpu=13.9% state=S 
```


---

## Process Exits (All)

```

```


---

## Orphan Events

_No orphan events detected._

---

## Memory Changes (>100MB)

_No significant memory changes detected._

---

## State Changes

_No state changes detected._

---

## Memory Trajectory (sampled every 10 events)

```

```

---

## Timeline (First 50 events)

```
[2026-01-25T21:31:14.637Z] #1 SESSION_START  Benchmark started (foreground), duration: 4h (14400 s), poll interval: 10s [mem:25MB, , net_procs:0, sys:27922MB avail, swap:0MB]
[2026-01-25T21:31:14.836Z] #2 SPAWN PID:11072 claude-code 20MB fds=5 thr=1 vsz=29MB cpu=13.9% state=S  [mem:25MB, , net_procs:1, sys:27922MB avail, swap:0MB]
[2026-01-25T21:33:25.367Z] #3 SESSION_END  Benchmark ABORTED by user after 00:02:11 [mem:22MB, , net_procs:1, sys:27479MB avail, swap:0MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-25T21:31:14.637Z] #1 SESSION_START  Benchmark started (foreground), duration: 4h (14400 s), poll interval: 10s [mem:25MB, , net_procs:0, sys:27922MB avail, swap:0MB]
[2026-01-25T21:31:14.836Z] #2 SPAWN PID:11072 claude-code 20MB fds=5 thr=1 vsz=29MB cpu=13.9% state=S  [mem:25MB, , net_procs:1, sys:27922MB avail, swap:0MB]
[2026-01-25T21:33:25.367Z] #3 SESSION_END  Benchmark ABORTED by user after 00:02:11 [mem:22MB, , net_procs:1, sys:27479MB avail, swap:0MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213114_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_213114_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213114_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213114_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213114_events.jsonl
```

---

_Report generated at 2026-01-25 21:33:25 UTC_
