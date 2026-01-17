# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_175945` |
| Start Time | 2026-01-25 17:59:46 UTC |
| End Time | 2026-01-25 18:02:14 UTC |
| Duration | 00:02:28 (148 seconds) |
| Poll Interval | 10s |
| Total Events | 34 |
| Anomalies | 5 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_175945_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_175945_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_175945_report.md`

---

## Event Summary

```
     23 SPAWN
      5 ANOMALY
      4 STATE_CHANGE
      1 SESSION_START
      1 SESSION_END
```

## Peak Values

```json
{
  "peak_total_mem_mb": 8357,
  "peak_swap_mb": 371,
  "min_available_mb": 19902,
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
2026-01-25T17:59:46.246Z | PID 1895927 | claude-code 700MB cpu=10.7% state=S 
2026-01-25T17:59:46.419Z | PID 1896009 | mcp-server 67MB cpu=0.0% state=S parent=1895927(claude)
2026-01-25T17:59:46.575Z | PID 2176912 | claude-code 783MB cpu=32.6% state=R 
2026-01-25T17:59:46.825Z | PID 2176975 | mcp-server 67MB cpu=0.0% state=S parent=2176912(claude)
2026-01-25T17:59:47.017Z | PID 2177149 | worker 204MB cpu=1.1% state=S 
2026-01-25T17:59:47.241Z | PID 2177204 | mcp-server 67MB cpu=0.0% state=S parent=2177149(bun)
2026-01-25T17:59:47.427Z | PID 2177439 | chroma 44MB cpu=0.0% state=S 
2026-01-25T17:59:47.613Z | PID 2177481 | chroma 368MB cpu=10.8% state=S 
2026-01-25T17:59:47.826Z | PID 2218628 | claude-code 548MB cpu=2.3% state=S 
2026-01-25T17:59:48.053Z | PID 2324436 | claude-code 487MB cpu=1.7% state=S 
2026-01-25T17:59:48.229Z | PID 2330749 | claude-code 487MB cpu=0.4% state=S 
2026-01-25T17:59:48.384Z | PID 2333496 | claude-code 403MB cpu=1.0% state=S 
2026-01-25T17:59:48.531Z | PID 2334120 | claude-code 404MB cpu=0.6% state=S 
2026-01-25T17:59:48.678Z | PID 2341546 | claude-code 400MB cpu=0.7% state=S 
2026-01-25T17:59:48.832Z | PID 2352236 | claude-code 417MB cpu=0.7% state=S 
2026-01-25T17:59:49.036Z | PID 2354907 | claude-code 398MB cpu=0.6% state=S 
2026-01-25T17:59:49.230Z | PID 2356757 | claude-code 412MB cpu=0.4% state=S 
2026-01-25T17:59:49.383Z | PID 2400755 | claude-code 501MB cpu=0.6% state=S 
2026-01-25T17:59:49.537Z | PID 2413534 | claude-code 482MB cpu=17.4% state=S 
2026-01-25T17:59:49.726Z | PID 2413583 | mcp-server 67MB cpu=0.1% state=S parent=2413534(claude)
2026-01-25T18:00:47.748Z | PID 2428128 | claude-code 457MB cpu=69.2% state=S 
2026-01-25T18:00:47.972Z | PID 2428180 | mcp-server 78MB cpu=5.2% state=S parent=2428128(claude)
2026-01-25T18:01:11.820Z | PID 2431240 | claude-code 412MB cpu=62.2% state=S 
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
2026-01-25T17:59:47.826Z | total:7319MB | swap:371MB | avail:21133MB | 
2026-01-25T17:59:49.537Z | total:7319MB | swap:371MB | avail:21144MB | 
2026-01-25T17:59:49.933Z | total:7319MB | swap:371MB | avail:21145MB | 
2026-01-25T17:59:50.047Z | total:7319MB | swap:371MB | avail:21146MB | 
2026-01-25T18:00:48.225Z | total:7870MB | swap:371MB | avail:20328MB | 
2026-01-25T18:01:12.075Z | total:8285MB | swap:371MB | avail:19902MB | 
2026-01-25T18:01:12.206Z | total:8287MB | swap:371MB | avail:19915MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-25T17:59:46.013Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:7319MB, , sys:21136MB avail, swap:371MB]
[2026-01-25T17:59:46.246Z] #2 SPAWN PID:1895927 claude-code 700MB cpu=10.7% state=S  [mem:7319MB, , sys:21137MB avail, swap:371MB]
[2026-01-25T17:59:46.419Z] #3 SPAWN PID:1896009 mcp-server 67MB cpu=0.0% state=S parent=1895927(claude) [mem:7319MB, , sys:21136MB avail, swap:371MB]
[2026-01-25T17:59:46.575Z] #4 SPAWN PID:2176912 claude-code 783MB cpu=32.6% state=R  [mem:7319MB, , sys:21136MB avail, swap:371MB]
[2026-01-25T17:59:46.825Z] #5 SPAWN PID:2176975 mcp-server 67MB cpu=0.0% state=S parent=2176912(claude) [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.017Z] #6 SPAWN PID:2177149 worker 204MB cpu=1.1% state=S  [mem:7319MB, , sys:21133MB avail, swap:371MB]
[2026-01-25T17:59:47.241Z] #7 SPAWN PID:2177204 mcp-server 67MB cpu=0.0% state=S parent=2177149(bun) [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.427Z] #8 SPAWN PID:2177439 chroma 44MB cpu=0.0% state=S  [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.613Z] #9 SPAWN PID:2177481 chroma 368MB cpu=10.8% state=S  [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.826Z] #10 SPAWN PID:2218628 claude-code 548MB cpu=2.3% state=S  [mem:7319MB, , sys:21133MB avail, swap:371MB]
[2026-01-25T17:59:48.053Z] #11 SPAWN PID:2324436 claude-code 487MB cpu=1.7% state=S  [mem:7319MB, , sys:21135MB avail, swap:371MB]
[2026-01-25T17:59:48.229Z] #12 SPAWN PID:2330749 claude-code 487MB cpu=0.4% state=S  [mem:7319MB, , sys:21141MB avail, swap:371MB]
[2026-01-25T17:59:48.384Z] #13 SPAWN PID:2333496 claude-code 403MB cpu=1.0% state=S  [mem:7319MB, , sys:21140MB avail, swap:371MB]
[2026-01-25T17:59:48.531Z] #14 SPAWN PID:2334120 claude-code 404MB cpu=0.6% state=S  [mem:7319MB, , sys:21139MB avail, swap:371MB]
[2026-01-25T17:59:48.678Z] #15 SPAWN PID:2341546 claude-code 400MB cpu=0.7% state=S  [mem:7319MB, , sys:21138MB avail, swap:371MB]
[2026-01-25T17:59:48.832Z] #16 SPAWN PID:2352236 claude-code 417MB cpu=0.7% state=S  [mem:7320MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T17:59:49.036Z] #17 SPAWN PID:2354907 claude-code 398MB cpu=0.6% state=S  [mem:7319MB, , sys:21145MB avail, swap:371MB]
[2026-01-25T17:59:49.230Z] #18 SPAWN PID:2356757 claude-code 412MB cpu=0.4% state=S  [mem:7319MB, , sys:21147MB avail, swap:371MB]
[2026-01-25T17:59:49.383Z] #19 SPAWN PID:2400755 claude-code 501MB cpu=0.6% state=S  [mem:7319MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T17:59:49.537Z] #20 SPAWN PID:2413534 claude-code 482MB cpu=17.4% state=S  [mem:7319MB, , sys:21144MB avail, swap:371MB]
[2026-01-25T17:59:49.726Z] #21 SPAWN PID:2413583 mcp-server 67MB cpu=0.1% state=S parent=2413534(claude) [mem:7319MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T17:59:49.933Z] #22 ANOMALY  High Claude instance count: 13 (threshold: 5) [mem:7319MB, , sys:21145MB avail, swap:371MB]
[2026-01-25T17:59:50.047Z] #23 ANOMALY  High memory usage: 7306MB (threshold: 6000MB) [mem:7319MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T18:00:00.386Z] #24 STATE_CHANGE PID:2176912 claude-code R->S [mem:7329MB, , sys:20701MB avail, swap:371MB]
[2026-01-25T18:00:47.748Z] #25 SPAWN PID:2428128 claude-code 457MB cpu=69.2% state=S  [mem:7870MB, , sys:20326MB avail, swap:371MB]
[2026-01-25T18:00:47.972Z] #26 SPAWN PID:2428180 mcp-server 78MB cpu=5.2% state=S parent=2428128(claude) [mem:7870MB, , sys:20326MB avail, swap:371MB]
[2026-01-25T18:00:48.225Z] #27 ANOMALY  High Claude instance count: 14 (threshold: 5) [mem:7870MB, , sys:20328MB avail, swap:371MB]
[2026-01-25T18:01:11.443Z] #28 STATE_CHANGE PID:2413534 claude-code S->R [mem:8281MB, , sys:19911MB avail, swap:371MB]
[2026-01-25T18:01:11.820Z] #29 SPAWN PID:2431240 claude-code 412MB cpu=62.2% state=S  [mem:8282MB, , sys:19908MB avail, swap:371MB]
[2026-01-25T18:01:12.075Z] #30 ANOMALY  High Claude instance count: 15 (threshold: 5) [mem:8285MB, , sys:19902MB avail, swap:371MB]
[2026-01-25T18:01:12.206Z] #31 ANOMALY  High memory usage: 8294MB (threshold: 6000MB) [mem:8287MB, , sys:19915MB avail, swap:371MB]
[2026-01-25T18:01:59.027Z] #32 STATE_CHANGE PID:2413534 claude-code R->S [mem:8327MB, , sys:20052MB avail, swap:371MB]
[2026-01-25T18:02:10.752Z] #33 STATE_CHANGE PID:2413534 claude-code S->R [mem:8357MB, , sys:20059MB avail, swap:371MB]
[2026-01-25T18:02:14.488Z] #34 SESSION_END  Benchmark ABORTED by user after 00:02:28 [mem:8333MB, , sys:20058MB avail, swap:371MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-25T17:59:46.013Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:7319MB, , sys:21136MB avail, swap:371MB]
[2026-01-25T17:59:46.246Z] #2 SPAWN PID:1895927 claude-code 700MB cpu=10.7% state=S  [mem:7319MB, , sys:21137MB avail, swap:371MB]
[2026-01-25T17:59:46.419Z] #3 SPAWN PID:1896009 mcp-server 67MB cpu=0.0% state=S parent=1895927(claude) [mem:7319MB, , sys:21136MB avail, swap:371MB]
[2026-01-25T17:59:46.575Z] #4 SPAWN PID:2176912 claude-code 783MB cpu=32.6% state=R  [mem:7319MB, , sys:21136MB avail, swap:371MB]
[2026-01-25T17:59:46.825Z] #5 SPAWN PID:2176975 mcp-server 67MB cpu=0.0% state=S parent=2176912(claude) [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.017Z] #6 SPAWN PID:2177149 worker 204MB cpu=1.1% state=S  [mem:7319MB, , sys:21133MB avail, swap:371MB]
[2026-01-25T17:59:47.241Z] #7 SPAWN PID:2177204 mcp-server 67MB cpu=0.0% state=S parent=2177149(bun) [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.427Z] #8 SPAWN PID:2177439 chroma 44MB cpu=0.0% state=S  [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.613Z] #9 SPAWN PID:2177481 chroma 368MB cpu=10.8% state=S  [mem:7319MB, , sys:21134MB avail, swap:371MB]
[2026-01-25T17:59:47.826Z] #10 SPAWN PID:2218628 claude-code 548MB cpu=2.3% state=S  [mem:7319MB, , sys:21133MB avail, swap:371MB]
[2026-01-25T17:59:48.053Z] #11 SPAWN PID:2324436 claude-code 487MB cpu=1.7% state=S  [mem:7319MB, , sys:21135MB avail, swap:371MB]
[2026-01-25T17:59:48.229Z] #12 SPAWN PID:2330749 claude-code 487MB cpu=0.4% state=S  [mem:7319MB, , sys:21141MB avail, swap:371MB]
[2026-01-25T17:59:48.384Z] #13 SPAWN PID:2333496 claude-code 403MB cpu=1.0% state=S  [mem:7319MB, , sys:21140MB avail, swap:371MB]
[2026-01-25T17:59:48.531Z] #14 SPAWN PID:2334120 claude-code 404MB cpu=0.6% state=S  [mem:7319MB, , sys:21139MB avail, swap:371MB]
[2026-01-25T17:59:48.678Z] #15 SPAWN PID:2341546 claude-code 400MB cpu=0.7% state=S  [mem:7319MB, , sys:21138MB avail, swap:371MB]
[2026-01-25T17:59:48.832Z] #16 SPAWN PID:2352236 claude-code 417MB cpu=0.7% state=S  [mem:7320MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T17:59:49.036Z] #17 SPAWN PID:2354907 claude-code 398MB cpu=0.6% state=S  [mem:7319MB, , sys:21145MB avail, swap:371MB]
[2026-01-25T17:59:49.230Z] #18 SPAWN PID:2356757 claude-code 412MB cpu=0.4% state=S  [mem:7319MB, , sys:21147MB avail, swap:371MB]
[2026-01-25T17:59:49.383Z] #19 SPAWN PID:2400755 claude-code 501MB cpu=0.6% state=S  [mem:7319MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T17:59:49.537Z] #20 SPAWN PID:2413534 claude-code 482MB cpu=17.4% state=S  [mem:7319MB, , sys:21144MB avail, swap:371MB]
[2026-01-25T17:59:49.726Z] #21 SPAWN PID:2413583 mcp-server 67MB cpu=0.1% state=S parent=2413534(claude) [mem:7319MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T17:59:49.933Z] #22 ANOMALY  High Claude instance count: 13 (threshold: 5) [mem:7319MB, , sys:21145MB avail, swap:371MB]
[2026-01-25T17:59:50.047Z] #23 ANOMALY  High memory usage: 7306MB (threshold: 6000MB) [mem:7319MB, , sys:21146MB avail, swap:371MB]
[2026-01-25T18:00:00.386Z] #24 STATE_CHANGE PID:2176912 claude-code R->S [mem:7329MB, , sys:20701MB avail, swap:371MB]
[2026-01-25T18:00:47.748Z] #25 SPAWN PID:2428128 claude-code 457MB cpu=69.2% state=S  [mem:7870MB, , sys:20326MB avail, swap:371MB]
[2026-01-25T18:00:47.972Z] #26 SPAWN PID:2428180 mcp-server 78MB cpu=5.2% state=S parent=2428128(claude) [mem:7870MB, , sys:20326MB avail, swap:371MB]
[2026-01-25T18:00:48.225Z] #27 ANOMALY  High Claude instance count: 14 (threshold: 5) [mem:7870MB, , sys:20328MB avail, swap:371MB]
[2026-01-25T18:01:11.443Z] #28 STATE_CHANGE PID:2413534 claude-code S->R [mem:8281MB, , sys:19911MB avail, swap:371MB]
[2026-01-25T18:01:11.820Z] #29 SPAWN PID:2431240 claude-code 412MB cpu=62.2% state=S  [mem:8282MB, , sys:19908MB avail, swap:371MB]
[2026-01-25T18:01:12.075Z] #30 ANOMALY  High Claude instance count: 15 (threshold: 5) [mem:8285MB, , sys:19902MB avail, swap:371MB]
[2026-01-25T18:01:12.206Z] #31 ANOMALY  High memory usage: 8294MB (threshold: 6000MB) [mem:8287MB, , sys:19915MB avail, swap:371MB]
[2026-01-25T18:01:59.027Z] #32 STATE_CHANGE PID:2413534 claude-code R->S [mem:8327MB, , sys:20052MB avail, swap:371MB]
[2026-01-25T18:02:10.752Z] #33 STATE_CHANGE PID:2413534 claude-code S->R [mem:8357MB, , sys:20059MB avail, swap:371MB]
[2026-01-25T18:02:14.488Z] #34 SESSION_END  Benchmark ABORTED by user after 00:02:28 [mem:8333MB, , sys:20058MB avail, swap:371MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_175945_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_175945_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_175945_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_175945_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_175945_events.jsonl
```

---

_Report generated at 2026-01-25 18:02:14 UTC_
