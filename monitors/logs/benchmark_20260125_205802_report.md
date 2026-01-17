# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_205802` |
| Start Time | 2026-01-25 20:58:02 UTC |
| End Time | 2026-01-25 20:58:25 UTC |
| Duration | 00:00:23 (23 seconds) |
| Poll Interval | 10s |
| Total Events | 28 |
| Anomalies | 5 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_205802_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_205802_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_205802_report.md`

---

## Event Summary

```
     21 SPAWN
      5 ANOMALY
      1 SESSION_START
      1 SESSION_END
```

## Peak Values

```json
{
  "peak_total_mem_mb": 8413,
  "peak_swap_mb": 370,
  "min_available_mb": 19931,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

```
2026-01-25T20:58:06.617Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T20:58:06.723Z | HIGH_MEM: 8374MB total (threshold: 6000MB) fds=868 threads=347
2026-01-25T20:58:06.883Z | ACCUMULATION: net 21 processes (spawns=21 exits=0)
2026-01-25T20:58:07.000Z | HIGH_THREADS: 347 total threads across all processes
2026-01-25T20:58:19.198Z | HIGH_THREADS: 350 total threads across all processes
```

---

## Process Spawns (All)

```
2026-01-25T20:58:02.342Z | PID 1895927 | claude-code 700MB fds=67 thr=18 vsz=73574MB cpu=7.6% state=S 
2026-01-25T20:58:02.566Z | PID 1896009 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=1895927(claude)
2026-01-25T20:58:02.730Z | PID 2176912 | claude-code 1023MB fds=57 thr=21 vsz=74955MB cpu=40.5% state=S 
2026-01-25T20:58:02.954Z | PID 2176975 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude)
2026-01-25T20:58:03.136Z | PID 2177149 | worker 222MB fds=81 thr=13 vsz=73714MB cpu=1.0% state=S 
2026-01-25T20:58:03.371Z | PID 2177204 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun)
2026-01-25T20:58:03.562Z | PID 2177439 | chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S 
2026-01-25T20:58:03.753Z | PID 2177481 | chroma 413MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S 
2026-01-25T20:58:03.939Z | PID 2218628 | claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S 
2026-01-25T20:58:04.143Z | PID 2324436 | claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S 
2026-01-25T20:58:04.338Z | PID 2330749 | claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S 
2026-01-25T20:58:04.542Z | PID 2333496 | claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S 
2026-01-25T20:58:04.735Z | PID 2334120 | claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S 
2026-01-25T20:58:04.916Z | PID 2341546 | claude-code 400MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S 
2026-01-25T20:58:05.119Z | PID 2352236 | claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S 
2026-01-25T20:58:05.302Z | PID 2354907 | claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S 
2026-01-25T20:58:05.497Z | PID 2356757 | claude-code 413MB fds=43 thr=9 vsz=73384MB cpu=0.4% state=S 
2026-01-25T20:58:05.694Z | PID 2400755 | claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S 
2026-01-25T20:58:05.888Z | PID 2413534 | claude-code 884MB fds=71 thr=20 vsz=73760MB cpu=12.1% state=R 
2026-01-25T20:58:06.085Z | PID 2413583 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude)
2026-01-25T20:58:06.270Z | PID 3159654 | claude-code 415MB fds=47 thr=18 vsz=72994MB cpu=17.5% state=S 
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
2026-01-25T20:58:03.939Z | total:8375MB | swap:370MB | avail:20024MB | 
2026-01-25T20:58:05.888Z | total:8388MB | swap:370MB | avail:20044MB | 
2026-01-25T20:58:06.617Z | total:8390MB | swap:370MB | avail:20046MB | 
2026-01-25T20:58:06.723Z | total:8391MB | swap:370MB | avail:20047MB | 
2026-01-25T20:58:06.883Z | total:8392MB | swap:370MB | avail:20047MB | 
2026-01-25T20:58:07.000Z | total:8394MB | swap:370MB | avail:20055MB | 
2026-01-25T20:58:19.198Z | total:8407MB | swap:370MB | avail:20017MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-25T20:58:02.102Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:8395MB, , net_procs:0, sys:19987MB avail, swap:370MB]
[2026-01-25T20:58:02.342Z] #2 SPAWN PID:1895927 claude-code 700MB fds=67 thr=18 vsz=73574MB cpu=7.6% state=S  [mem:8407MB, , net_procs:1, sys:19992MB avail, swap:370MB]
[2026-01-25T20:58:02.566Z] #3 SPAWN PID:1896009 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=1895927(claude) [mem:8410MB, , net_procs:2, sys:19993MB avail, swap:370MB]
[2026-01-25T20:58:02.730Z] #4 SPAWN PID:2176912 claude-code 1023MB fds=57 thr=21 vsz=74955MB cpu=40.5% state=S  [mem:8406MB, , net_procs:3, sys:19993MB avail, swap:370MB]
[2026-01-25T20:58:02.954Z] #5 SPAWN PID:2176975 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude) [mem:8407MB, , net_procs:4, sys:19958MB avail, swap:370MB]
[2026-01-25T20:58:03.136Z] #6 SPAWN PID:2177149 worker 222MB fds=81 thr=13 vsz=73714MB cpu=1.0% state=S  [mem:8409MB, , net_procs:5, sys:19931MB avail, swap:370MB]
[2026-01-25T20:58:03.371Z] #7 SPAWN PID:2177204 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun) [mem:8410MB, , net_procs:6, sys:19982MB avail, swap:370MB]
[2026-01-25T20:58:03.562Z] #8 SPAWN PID:2177439 chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S  [mem:8412MB, , net_procs:7, sys:19982MB avail, swap:370MB]
[2026-01-25T20:58:03.753Z] #9 SPAWN PID:2177481 chroma 413MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S  [mem:8413MB, , net_procs:8, sys:19981MB avail, swap:370MB]
[2026-01-25T20:58:03.939Z] #10 SPAWN PID:2218628 claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S  [mem:8375MB, , net_procs:9, sys:20024MB avail, swap:370MB]
[2026-01-25T20:58:04.143Z] #11 SPAWN PID:2324436 claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S  [mem:8372MB, , net_procs:10, sys:20038MB avail, swap:370MB]
[2026-01-25T20:58:04.338Z] #12 SPAWN PID:2330749 claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S  [mem:8373MB, , net_procs:11, sys:20040MB avail, swap:370MB]
[2026-01-25T20:58:04.542Z] #13 SPAWN PID:2333496 claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S  [mem:8374MB, , net_procs:12, sys:20038MB avail, swap:370MB]
[2026-01-25T20:58:04.735Z] #14 SPAWN PID:2334120 claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S  [mem:8380MB, , net_procs:13, sys:20037MB avail, swap:370MB]
[2026-01-25T20:58:04.916Z] #15 SPAWN PID:2341546 claude-code 400MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S  [mem:8379MB, , net_procs:14, sys:20036MB avail, swap:370MB]
[2026-01-25T20:58:05.119Z] #16 SPAWN PID:2352236 claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S  [mem:8379MB, , net_procs:15, sys:20043MB avail, swap:370MB]
[2026-01-25T20:58:05.302Z] #17 SPAWN PID:2354907 claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S  [mem:8381MB, , net_procs:16, sys:20056MB avail, swap:370MB]
[2026-01-25T20:58:05.497Z] #18 SPAWN PID:2356757 claude-code 413MB fds=43 thr=9 vsz=73384MB cpu=0.4% state=S  [mem:8387MB, , net_procs:17, sys:20045MB avail, swap:370MB]
[2026-01-25T20:58:05.694Z] #19 SPAWN PID:2400755 claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S  [mem:8389MB, , net_procs:18, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:05.888Z] #20 SPAWN PID:2413534 claude-code 884MB fds=71 thr=20 vsz=73760MB cpu=12.1% state=R  [mem:8388MB, , net_procs:19, sys:20044MB avail, swap:370MB]
[2026-01-25T20:58:06.085Z] #21 SPAWN PID:2413583 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude) [mem:8389MB, , net_procs:20, sys:20043MB avail, swap:370MB]
[2026-01-25T20:58:06.270Z] #22 SPAWN PID:3159654 claude-code 415MB fds=47 thr=18 vsz=72994MB cpu=17.5% state=S  [mem:8390MB, , net_procs:21, sys:20048MB avail, swap:370MB]
[2026-01-25T20:58:06.617Z] #23 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:8390MB, , net_procs:21, sys:20046MB avail, swap:370MB]
[2026-01-25T20:58:06.723Z] #24 ANOMALY  HIGH_MEM: 8374MB total (threshold: 6000MB) fds=868 threads=347 [mem:8391MB, , net_procs:21, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:06.883Z] #25 ANOMALY  ACCUMULATION: net 21 processes (spawns=21 exits=0) [mem:8392MB, , net_procs:21, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:07.000Z] #26 ANOMALY  HIGH_THREADS: 347 total threads across all processes [mem:8394MB, , net_procs:21, sys:20055MB avail, swap:370MB]
[2026-01-25T20:58:19.198Z] #27 ANOMALY  HIGH_THREADS: 350 total threads across all processes [mem:8407MB, , net_procs:21, sys:20017MB avail, swap:370MB]
[2026-01-25T20:58:25.105Z] #28 SESSION_END  Benchmark ABORTED by user after 00:00:23 [mem:8410MB, , net_procs:21, sys:20052MB avail, swap:370MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-25T20:58:02.102Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:8395MB, , net_procs:0, sys:19987MB avail, swap:370MB]
[2026-01-25T20:58:02.342Z] #2 SPAWN PID:1895927 claude-code 700MB fds=67 thr=18 vsz=73574MB cpu=7.6% state=S  [mem:8407MB, , net_procs:1, sys:19992MB avail, swap:370MB]
[2026-01-25T20:58:02.566Z] #3 SPAWN PID:1896009 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=1895927(claude) [mem:8410MB, , net_procs:2, sys:19993MB avail, swap:370MB]
[2026-01-25T20:58:02.730Z] #4 SPAWN PID:2176912 claude-code 1023MB fds=57 thr=21 vsz=74955MB cpu=40.5% state=S  [mem:8406MB, , net_procs:3, sys:19993MB avail, swap:370MB]
[2026-01-25T20:58:02.954Z] #5 SPAWN PID:2176975 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude) [mem:8407MB, , net_procs:4, sys:19958MB avail, swap:370MB]
[2026-01-25T20:58:03.136Z] #6 SPAWN PID:2177149 worker 222MB fds=81 thr=13 vsz=73714MB cpu=1.0% state=S  [mem:8409MB, , net_procs:5, sys:19931MB avail, swap:370MB]
[2026-01-25T20:58:03.371Z] #7 SPAWN PID:2177204 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun) [mem:8410MB, , net_procs:6, sys:19982MB avail, swap:370MB]
[2026-01-25T20:58:03.562Z] #8 SPAWN PID:2177439 chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S  [mem:8412MB, , net_procs:7, sys:19982MB avail, swap:370MB]
[2026-01-25T20:58:03.753Z] #9 SPAWN PID:2177481 chroma 413MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S  [mem:8413MB, , net_procs:8, sys:19981MB avail, swap:370MB]
[2026-01-25T20:58:03.939Z] #10 SPAWN PID:2218628 claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S  [mem:8375MB, , net_procs:9, sys:20024MB avail, swap:370MB]
[2026-01-25T20:58:04.143Z] #11 SPAWN PID:2324436 claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S  [mem:8372MB, , net_procs:10, sys:20038MB avail, swap:370MB]
[2026-01-25T20:58:04.338Z] #12 SPAWN PID:2330749 claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S  [mem:8373MB, , net_procs:11, sys:20040MB avail, swap:370MB]
[2026-01-25T20:58:04.542Z] #13 SPAWN PID:2333496 claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S  [mem:8374MB, , net_procs:12, sys:20038MB avail, swap:370MB]
[2026-01-25T20:58:04.735Z] #14 SPAWN PID:2334120 claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S  [mem:8380MB, , net_procs:13, sys:20037MB avail, swap:370MB]
[2026-01-25T20:58:04.916Z] #15 SPAWN PID:2341546 claude-code 400MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S  [mem:8379MB, , net_procs:14, sys:20036MB avail, swap:370MB]
[2026-01-25T20:58:05.119Z] #16 SPAWN PID:2352236 claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S  [mem:8379MB, , net_procs:15, sys:20043MB avail, swap:370MB]
[2026-01-25T20:58:05.302Z] #17 SPAWN PID:2354907 claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S  [mem:8381MB, , net_procs:16, sys:20056MB avail, swap:370MB]
[2026-01-25T20:58:05.497Z] #18 SPAWN PID:2356757 claude-code 413MB fds=43 thr=9 vsz=73384MB cpu=0.4% state=S  [mem:8387MB, , net_procs:17, sys:20045MB avail, swap:370MB]
[2026-01-25T20:58:05.694Z] #19 SPAWN PID:2400755 claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S  [mem:8389MB, , net_procs:18, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:05.888Z] #20 SPAWN PID:2413534 claude-code 884MB fds=71 thr=20 vsz=73760MB cpu=12.1% state=R  [mem:8388MB, , net_procs:19, sys:20044MB avail, swap:370MB]
[2026-01-25T20:58:06.085Z] #21 SPAWN PID:2413583 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude) [mem:8389MB, , net_procs:20, sys:20043MB avail, swap:370MB]
[2026-01-25T20:58:06.270Z] #22 SPAWN PID:3159654 claude-code 415MB fds=47 thr=18 vsz=72994MB cpu=17.5% state=S  [mem:8390MB, , net_procs:21, sys:20048MB avail, swap:370MB]
[2026-01-25T20:58:06.617Z] #23 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:8390MB, , net_procs:21, sys:20046MB avail, swap:370MB]
[2026-01-25T20:58:06.723Z] #24 ANOMALY  HIGH_MEM: 8374MB total (threshold: 6000MB) fds=868 threads=347 [mem:8391MB, , net_procs:21, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:06.883Z] #25 ANOMALY  ACCUMULATION: net 21 processes (spawns=21 exits=0) [mem:8392MB, , net_procs:21, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:07.000Z] #26 ANOMALY  HIGH_THREADS: 347 total threads across all processes [mem:8394MB, , net_procs:21, sys:20055MB avail, swap:370MB]
[2026-01-25T20:58:19.198Z] #27 ANOMALY  HIGH_THREADS: 350 total threads across all processes [mem:8407MB, , net_procs:21, sys:20017MB avail, swap:370MB]
[2026-01-25T20:58:25.105Z] #28 SESSION_END  Benchmark ABORTED by user after 00:00:23 [mem:8410MB, , net_procs:21, sys:20052MB avail, swap:370MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205802_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_205802_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205802_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205802_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205802_events.jsonl
```

---

_Report generated at 2026-01-25 20:58:25 UTC_
