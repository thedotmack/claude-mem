# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_205918` |
| Start Time | 2026-01-25 20:59:18 UTC |
| End Time | 2026-01-25 21:01:28 UTC |
| Duration | 00:02:10 (130 seconds) |
| Poll Interval | 10s |
| Total Events | 53 |
| Anomalies | 14 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_205918_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_205918_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_205918_report.md`

---

## Event Summary

```
     23 SPAWN
     14 ANOMALY
      6 THREAD_CHANGE
      4 STATE_CHANGE
      3 EXIT
      1 SESSION_START
      1 SESSION_END
      1 ORPHAN
```

## Peak Values

```json
{
  "peak_total_mem_mb": 8539,
  "peak_swap_mb": 370,
  "min_available_mb": 19977,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

```
2026-01-25T20:59:23.434Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:59:23.554Z | HIGH_MEM: 8442MB total (threshold: 6000MB) fds=872 threads=350
2026-01-25T20:59:23.710Z | ACCUMULATION: net 22 processes (spawns=22 exits=0)
2026-01-25T20:59:23.830Z | HIGH_THREADS: 350 total threads across all processes
2026-01-25T20:59:48.566Z | HIGH_THREADS: 347 total threads across all processes
2026-01-25T21:00:01.432Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-25T21:00:01.589Z | HIGH_MEM: 7194MB total (threshold: 6000MB) fds=735 threads=319
2026-01-25T21:00:01.772Z | ACCUMULATION: net 19 processes (spawns=22 exits=3)
2026-01-25T21:00:38.582Z | HIGH_THREADS: 298 total threads across all processes
2026-01-25T21:01:03.151Z | HIGH_THREADS: 310 total threads across all processes
2026-01-25T21:01:15.461Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T21:01:15.607Z | ACCUMULATION: net 20 processes (spawns=23 exits=3)
2026-01-25T21:01:15.732Z | HIGH_THREADS: 354 total threads across all processes
2026-01-25T21:01:28.126Z | HIGH_THREADS: 334 total threads across all processes
```

---

## Process Spawns (All)

```
2026-01-25T20:59:18.942Z | PID 1895927 | claude-code 706MB fds=66 thr=19 vsz=73574MB cpu=7.6% state=S 
2026-01-25T20:59:19.175Z | PID 1896009 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=1895927(claude)
2026-01-25T20:59:19.349Z | PID 2176912 | claude-code 1028MB fds=57 thr=21 vsz=74955MB cpu=40.4% state=S 
2026-01-25T20:59:19.557Z | PID 2176975 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude)
2026-01-25T20:59:19.749Z | PID 2177149 | worker 223MB fds=81 thr=13 vsz=73714MB cpu=1.0% state=S 
2026-01-25T20:59:19.949Z | PID 2177204 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun)
2026-01-25T20:59:20.119Z | PID 2177439 | chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S 
2026-01-25T20:59:20.288Z | PID 2177481 | chroma 413MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S 
2026-01-25T20:59:20.469Z | PID 2218628 | claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S 
2026-01-25T20:59:20.664Z | PID 2324436 | claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S 
2026-01-25T20:59:20.865Z | PID 2330749 | claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S 
2026-01-25T20:59:21.065Z | PID 2333496 | claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S 
2026-01-25T20:59:21.251Z | PID 2334120 | claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S 
2026-01-25T20:59:21.444Z | PID 2341546 | claude-code 400MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S 
2026-01-25T20:59:21.690Z | PID 2352236 | claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S 
2026-01-25T20:59:21.892Z | PID 2354907 | claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S 
2026-01-25T20:59:22.092Z | PID 2356757 | claude-code 413MB fds=43 thr=8 vsz=73384MB cpu=0.4% state=S 
2026-01-25T20:59:22.294Z | PID 2400755 | claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S 
2026-01-25T20:59:22.481Z | PID 2413534 | claude-code 928MB fds=74 thr=20 vsz=73775MB cpu=12.8% state=R 
2026-01-25T20:59:22.691Z | PID 2413583 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude)
2026-01-25T20:59:22.881Z | PID 3159654 | claude-code 426MB fds=46 thr=20 vsz=72994MB cpu=17.7% state=S 
2026-01-25T20:59:23.070Z | PID 3216780 | claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:01:15.149Z | PID 3265860 | claude-code 435MB fds=46 thr=35 vsz=72886MB cpu=50.5% state=S 
```


---

## Process Exits (All)

```
2026-01-25T21:00:00.680Z | PID 1896009 | mcp-server 67MB fds=21 thr=7 lived 41s 
2026-01-25T21:00:00.816Z | PID 3159654 | claude-code 404MB fds=46 thr=18 lived 38s 
2026-01-25T21:00:01.083Z | PID 1895927 | claude-code 707MB fds=66 thr=19 lived 42s orphaned MCP:1896009
```


---

## Orphan Events

```
2026-01-25T21:00:00.954Z | PID 1896009 | mcp-server orphaned by death of 1895927
```

---

## Memory Changes (>100MB)

_No significant memory changes detected._

---

## State Changes

```
2026-01-25T20:59:35.685Z | PID 2413534 | claude-code R->S
2026-01-25T21:00:38.000Z | PID 2413534 | claude-code S->R
2026-01-25T21:00:50.314Z | PID 2413534 | claude-code R->S
2026-01-25T21:01:27.369Z | PID 2413534 | claude-code S->R
```

---

## Memory Trajectory (sampled every 10 events)

```
2026-01-25T20:59:20.469Z | total:8436MB | swap:370MB | avail:20024MB | 
2026-01-25T20:59:22.481Z | total:8457MB | swap:370MB | avail:20014MB | 
2026-01-25T20:59:23.434Z | total:8457MB | swap:370MB | avail:20013MB | 
2026-01-25T20:59:23.554Z | total:8459MB | swap:370MB | avail:20013MB | 
2026-01-25T20:59:23.710Z | total:8460MB | swap:370MB | avail:20011MB | 
2026-01-25T20:59:23.830Z | total:8461MB | swap:370MB | avail:20009MB | 
2026-01-25T20:59:48.566Z | total:8391MB | swap:370MB | avail:20118MB | 
2026-01-25T21:00:00.164Z | total:7209MB | swap:370MB | avail:20900MB | 
2026-01-25T21:00:01.432Z | total:7209MB | swap:370MB | avail:20610MB | 
2026-01-25T21:00:01.589Z | total:7209MB | swap:370MB | avail:20595MB | 
2026-01-25T21:00:01.772Z | total:7208MB | swap:370MB | avail:20583MB | 
2026-01-25T21:00:38.000Z | total:7176MB | swap:370MB | avail:21107MB | 
2026-01-25T21:00:38.582Z | total:7172MB | swap:370MB | avail:21106MB | 
2026-01-25T21:01:03.151Z | total:7176MB | swap:370MB | avail:21076MB | 
2026-01-25T21:01:15.461Z | total:7651MB | swap:370MB | avail:20358MB | 
2026-01-25T21:01:15.607Z | total:7653MB | swap:370MB | avail:20351MB | 
2026-01-25T21:01:15.732Z | total:7658MB | swap:370MB | avail:20355MB | 
2026-01-25T21:01:27.369Z | total:7722MB | swap:370MB | avail:20569MB | 
2026-01-25T21:01:28.126Z | total:7726MB | swap:370MB | avail:20497MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-25T20:59:18.750Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:8413MB, , net_procs:0, sys:20075MB avail, swap:370MB]
[2026-01-25T20:59:18.942Z] #2 SPAWN PID:1895927 claude-code 706MB fds=66 thr=19 vsz=73574MB cpu=7.6% state=S  [mem:8418MB, , net_procs:1, sys:20024MB avail, swap:370MB]
[2026-01-25T20:59:19.175Z] #3 SPAWN PID:1896009 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=1895927(claude) [mem:8426MB, , net_procs:2, sys:19984MB avail, swap:370MB]
[2026-01-25T20:59:19.349Z] #4 SPAWN PID:2176912 claude-code 1028MB fds=57 thr=21 vsz=74955MB cpu=40.4% state=S  [mem:8427MB, , net_procs:3, sys:20043MB avail, swap:370MB]
[2026-01-25T20:59:19.557Z] #5 SPAWN PID:2176975 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude) [mem:8428MB, , net_procs:4, sys:19984MB avail, swap:370MB]
[2026-01-25T20:59:19.749Z] #6 SPAWN PID:2177149 worker 223MB fds=81 thr=13 vsz=73714MB cpu=1.0% state=S  [mem:8429MB, , net_procs:5, sys:19982MB avail, swap:370MB]
[2026-01-25T20:59:19.949Z] #7 SPAWN PID:2177204 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun) [mem:8431MB, , net_procs:6, sys:20034MB avail, swap:370MB]
[2026-01-25T20:59:20.119Z] #8 SPAWN PID:2177439 chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S  [mem:8432MB, , net_procs:7, sys:20032MB avail, swap:370MB]
[2026-01-25T20:59:20.288Z] #9 SPAWN PID:2177481 chroma 413MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S  [mem:8434MB, , net_procs:8, sys:20027MB avail, swap:370MB]
[2026-01-25T20:59:20.469Z] #10 SPAWN PID:2218628 claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S  [mem:8436MB, , net_procs:9, sys:20024MB avail, swap:370MB]
[2026-01-25T20:59:20.664Z] #11 SPAWN PID:2324436 claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S  [mem:8438MB, , net_procs:10, sys:20023MB avail, swap:370MB]
[2026-01-25T20:59:20.865Z] #12 SPAWN PID:2330749 claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S  [mem:8539MB, , net_procs:11, sys:19977MB avail, swap:370MB]
[2026-01-25T20:59:21.065Z] #13 SPAWN PID:2333496 claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S  [mem:8440MB, , net_procs:12, sys:20039MB avail, swap:370MB]
[2026-01-25T20:59:21.251Z] #14 SPAWN PID:2334120 claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S  [mem:8445MB, , net_procs:13, sys:20027MB avail, swap:370MB]
[2026-01-25T20:59:21.444Z] #15 SPAWN PID:2341546 claude-code 400MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S  [mem:8457MB, , net_procs:14, sys:20021MB avail, swap:370MB]
[2026-01-25T20:59:21.690Z] #16 SPAWN PID:2352236 claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S  [mem:8455MB, , net_procs:15, sys:20020MB avail, swap:370MB]
[2026-01-25T20:59:21.892Z] #17 SPAWN PID:2354907 claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S  [mem:8460MB, , net_procs:16, sys:20012MB avail, swap:370MB]
[2026-01-25T20:59:22.092Z] #18 SPAWN PID:2356757 claude-code 413MB fds=43 thr=8 vsz=73384MB cpu=0.4% state=S  [mem:8459MB, , net_procs:17, sys:20012MB avail, swap:370MB]
[2026-01-25T20:59:22.294Z] #19 SPAWN PID:2400755 claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S  [mem:8457MB, , net_procs:18, sys:20015MB avail, swap:370MB]
[2026-01-25T20:59:22.481Z] #20 SPAWN PID:2413534 claude-code 928MB fds=74 thr=20 vsz=73775MB cpu=12.8% state=R  [mem:8457MB, , net_procs:19, sys:20014MB avail, swap:370MB]
[2026-01-25T20:59:22.691Z] #21 SPAWN PID:2413583 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude) [mem:8457MB, , net_procs:20, sys:20014MB avail, swap:370MB]
[2026-01-25T20:59:22.881Z] #22 SPAWN PID:3159654 claude-code 426MB fds=46 thr=20 vsz=72994MB cpu=17.7% state=S  [mem:8457MB, , net_procs:21, sys:20013MB avail, swap:370MB]
[2026-01-25T20:59:23.070Z] #23 SPAWN PID:3216780 claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S  [mem:8457MB, , net_procs:22, sys:20012MB avail, swap:370MB]
[2026-01-25T20:59:23.434Z] #24 ANOMALY  HIGH_COUNT: 15 Claude instances (threshold: 5) [mem:8457MB, , net_procs:22, sys:20013MB avail, swap:370MB]
[2026-01-25T20:59:23.554Z] #25 ANOMALY  HIGH_MEM: 8442MB total (threshold: 6000MB) fds=872 threads=350 [mem:8459MB, , net_procs:22, sys:20013MB avail, swap:370MB]
[2026-01-25T20:59:23.710Z] #26 ANOMALY  ACCUMULATION: net 22 processes (spawns=22 exits=0) [mem:8460MB, , net_procs:22, sys:20011MB avail, swap:370MB]
[2026-01-25T20:59:23.830Z] #27 ANOMALY  HIGH_THREADS: 350 total threads across all processes [mem:8461MB, , net_procs:22, sys:20009MB avail, swap:370MB]
[2026-01-25T20:59:35.685Z] #28 STATE_CHANGE PID:2413534 claude-code R->S [mem:8402MB, , net_procs:22, sys:20086MB avail, swap:370MB]
[2026-01-25T20:59:48.566Z] #29 ANOMALY  HIGH_THREADS: 347 total threads across all processes [mem:8391MB, , net_procs:22, sys:20118MB avail, swap:370MB]
[2026-01-25T21:00:00.164Z] #30 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:7209MB, , net_procs:22, sys:20900MB avail, swap:370MB]
[2026-01-25T21:00:00.680Z] #31 EXIT PID:1896009 mcp-server 67MB fds=21 thr=7 lived 41s  [mem:7209MB, , net_procs:21, sys:20808MB avail, swap:370MB]
[2026-01-25T21:00:00.816Z] #32 EXIT PID:3159654 claude-code 404MB fds=46 thr=18 lived 38s  [mem:7209MB, , net_procs:20, sys:20804MB avail, swap:370MB]
[2026-01-25T21:00:00.954Z] #33 ORPHAN PID:1896009 mcp-server orphaned by death of 1895927 [mem:7209MB, , net_procs:19, sys:20793MB avail, swap:370MB]
[2026-01-25T21:00:01.083Z] #34 EXIT PID:1895927 claude-code 707MB fds=66 thr=19 lived 42s orphaned MCP:1896009 [mem:7209MB, , net_procs:19, sys:20751MB avail, swap:370MB]
[2026-01-25T21:00:01.432Z] #35 ANOMALY  HIGH_COUNT: 13 Claude instances (threshold: 5) [mem:7209MB, , net_procs:19, sys:20610MB avail, swap:370MB]
[2026-01-25T21:00:01.589Z] #36 ANOMALY  HIGH_MEM: 7194MB total (threshold: 6000MB) fds=735 threads=319 [mem:7209MB, , net_procs:19, sys:20595MB avail, swap:370MB]
[2026-01-25T21:00:01.772Z] #37 ANOMALY  ACCUMULATION: net 19 processes (spawns=22 exits=3) [mem:7208MB, , net_procs:19, sys:20583MB avail, swap:370MB]
[2026-01-25T21:00:36.480Z] #38 THREAD_CHANGE PID:2177149 worker threads: 13->6 [mem:7171MB, , net_procs:19, sys:21158MB avail, swap:370MB]
[2026-01-25T21:00:37.699Z] #39 THREAD_CHANGE PID:2356757 claude-code threads: 16->9 [mem:7171MB, , net_procs:19, sys:21115MB avail, swap:370MB]
[2026-01-25T21:00:38.000Z] #40 STATE_CHANGE PID:2413534 claude-code S->R [mem:7176MB, , net_procs:19, sys:21107MB avail, swap:370MB]
[2026-01-25T21:00:38.582Z] #41 ANOMALY  HIGH_THREADS: 298 total threads across all processes [mem:7172MB, , net_procs:19, sys:21106MB avail, swap:370MB]
[2026-01-25T21:00:50.314Z] #42 STATE_CHANGE PID:2413534 claude-code R->S [mem:7169MB, , net_procs:19, sys:21102MB avail, swap:370MB]
[2026-01-25T21:01:01.187Z] #43 THREAD_CHANGE PID:2177149 worker threads: 5->13 [mem:7176MB, , net_procs:19, sys:21095MB avail, swap:370MB]
[2026-01-25T21:01:02.472Z] #44 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:7176MB, , net_procs:19, sys:21076MB avail, swap:370MB]
[2026-01-25T21:01:03.151Z] #45 ANOMALY  HIGH_THREADS: 310 total threads across all processes [mem:7176MB, , net_procs:19, sys:21076MB avail, swap:370MB]
[2026-01-25T21:01:15.149Z] #46 SPAWN PID:3265860 claude-code 435MB fds=46 thr=35 vsz=72886MB cpu=50.5% state=S  [mem:7649MB, , net_procs:20, sys:20408MB avail, swap:370MB]
[2026-01-25T21:01:15.461Z] #47 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:7651MB, , net_procs:20, sys:20358MB avail, swap:370MB]
[2026-01-25T21:01:15.607Z] #48 ANOMALY  ACCUMULATION: net 20 processes (spawns=23 exits=3) [mem:7653MB, , net_procs:20, sys:20351MB avail, swap:370MB]
[2026-01-25T21:01:15.732Z] #49 ANOMALY  HIGH_THREADS: 354 total threads across all processes [mem:7658MB, , net_procs:20, sys:20355MB avail, swap:370MB]
[2026-01-25T21:01:27.369Z] #50 STATE_CHANGE PID:2413534 claude-code S->R [mem:7722MB, , net_procs:20, sys:20569MB avail, swap:370MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-25T20:59:19.349Z] #4 SPAWN PID:2176912 claude-code 1028MB fds=57 thr=21 vsz=74955MB cpu=40.4% state=S  [mem:8427MB, , net_procs:3, sys:20043MB avail, swap:370MB]
[2026-01-25T20:59:19.557Z] #5 SPAWN PID:2176975 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude) [mem:8428MB, , net_procs:4, sys:19984MB avail, swap:370MB]
[2026-01-25T20:59:19.749Z] #6 SPAWN PID:2177149 worker 223MB fds=81 thr=13 vsz=73714MB cpu=1.0% state=S  [mem:8429MB, , net_procs:5, sys:19982MB avail, swap:370MB]
[2026-01-25T20:59:19.949Z] #7 SPAWN PID:2177204 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun) [mem:8431MB, , net_procs:6, sys:20034MB avail, swap:370MB]
[2026-01-25T20:59:20.119Z] #8 SPAWN PID:2177439 chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S  [mem:8432MB, , net_procs:7, sys:20032MB avail, swap:370MB]
[2026-01-25T20:59:20.288Z] #9 SPAWN PID:2177481 chroma 413MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S  [mem:8434MB, , net_procs:8, sys:20027MB avail, swap:370MB]
[2026-01-25T20:59:20.469Z] #10 SPAWN PID:2218628 claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S  [mem:8436MB, , net_procs:9, sys:20024MB avail, swap:370MB]
[2026-01-25T20:59:20.664Z] #11 SPAWN PID:2324436 claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S  [mem:8438MB, , net_procs:10, sys:20023MB avail, swap:370MB]
[2026-01-25T20:59:20.865Z] #12 SPAWN PID:2330749 claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S  [mem:8539MB, , net_procs:11, sys:19977MB avail, swap:370MB]
[2026-01-25T20:59:21.065Z] #13 SPAWN PID:2333496 claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S  [mem:8440MB, , net_procs:12, sys:20039MB avail, swap:370MB]
[2026-01-25T20:59:21.251Z] #14 SPAWN PID:2334120 claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S  [mem:8445MB, , net_procs:13, sys:20027MB avail, swap:370MB]
[2026-01-25T20:59:21.444Z] #15 SPAWN PID:2341546 claude-code 400MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S  [mem:8457MB, , net_procs:14, sys:20021MB avail, swap:370MB]
[2026-01-25T20:59:21.690Z] #16 SPAWN PID:2352236 claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S  [mem:8455MB, , net_procs:15, sys:20020MB avail, swap:370MB]
[2026-01-25T20:59:21.892Z] #17 SPAWN PID:2354907 claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S  [mem:8460MB, , net_procs:16, sys:20012MB avail, swap:370MB]
[2026-01-25T20:59:22.092Z] #18 SPAWN PID:2356757 claude-code 413MB fds=43 thr=8 vsz=73384MB cpu=0.4% state=S  [mem:8459MB, , net_procs:17, sys:20012MB avail, swap:370MB]
[2026-01-25T20:59:22.294Z] #19 SPAWN PID:2400755 claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S  [mem:8457MB, , net_procs:18, sys:20015MB avail, swap:370MB]
[2026-01-25T20:59:22.481Z] #20 SPAWN PID:2413534 claude-code 928MB fds=74 thr=20 vsz=73775MB cpu=12.8% state=R  [mem:8457MB, , net_procs:19, sys:20014MB avail, swap:370MB]
[2026-01-25T20:59:22.691Z] #21 SPAWN PID:2413583 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude) [mem:8457MB, , net_procs:20, sys:20014MB avail, swap:370MB]
[2026-01-25T20:59:22.881Z] #22 SPAWN PID:3159654 claude-code 426MB fds=46 thr=20 vsz=72994MB cpu=17.7% state=S  [mem:8457MB, , net_procs:21, sys:20013MB avail, swap:370MB]
[2026-01-25T20:59:23.070Z] #23 SPAWN PID:3216780 claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S  [mem:8457MB, , net_procs:22, sys:20012MB avail, swap:370MB]
[2026-01-25T20:59:23.434Z] #24 ANOMALY  HIGH_COUNT: 15 Claude instances (threshold: 5) [mem:8457MB, , net_procs:22, sys:20013MB avail, swap:370MB]
[2026-01-25T20:59:23.554Z] #25 ANOMALY  HIGH_MEM: 8442MB total (threshold: 6000MB) fds=872 threads=350 [mem:8459MB, , net_procs:22, sys:20013MB avail, swap:370MB]
[2026-01-25T20:59:23.710Z] #26 ANOMALY  ACCUMULATION: net 22 processes (spawns=22 exits=0) [mem:8460MB, , net_procs:22, sys:20011MB avail, swap:370MB]
[2026-01-25T20:59:23.830Z] #27 ANOMALY  HIGH_THREADS: 350 total threads across all processes [mem:8461MB, , net_procs:22, sys:20009MB avail, swap:370MB]
[2026-01-25T20:59:35.685Z] #28 STATE_CHANGE PID:2413534 claude-code R->S [mem:8402MB, , net_procs:22, sys:20086MB avail, swap:370MB]
[2026-01-25T20:59:48.566Z] #29 ANOMALY  HIGH_THREADS: 347 total threads across all processes [mem:8391MB, , net_procs:22, sys:20118MB avail, swap:370MB]
[2026-01-25T21:00:00.164Z] #30 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:7209MB, , net_procs:22, sys:20900MB avail, swap:370MB]
[2026-01-25T21:00:00.680Z] #31 EXIT PID:1896009 mcp-server 67MB fds=21 thr=7 lived 41s  [mem:7209MB, , net_procs:21, sys:20808MB avail, swap:370MB]
[2026-01-25T21:00:00.816Z] #32 EXIT PID:3159654 claude-code 404MB fds=46 thr=18 lived 38s  [mem:7209MB, , net_procs:20, sys:20804MB avail, swap:370MB]
[2026-01-25T21:00:00.954Z] #33 ORPHAN PID:1896009 mcp-server orphaned by death of 1895927 [mem:7209MB, , net_procs:19, sys:20793MB avail, swap:370MB]
[2026-01-25T21:00:01.083Z] #34 EXIT PID:1895927 claude-code 707MB fds=66 thr=19 lived 42s orphaned MCP:1896009 [mem:7209MB, , net_procs:19, sys:20751MB avail, swap:370MB]
[2026-01-25T21:00:01.432Z] #35 ANOMALY  HIGH_COUNT: 13 Claude instances (threshold: 5) [mem:7209MB, , net_procs:19, sys:20610MB avail, swap:370MB]
[2026-01-25T21:00:01.589Z] #36 ANOMALY  HIGH_MEM: 7194MB total (threshold: 6000MB) fds=735 threads=319 [mem:7209MB, , net_procs:19, sys:20595MB avail, swap:370MB]
[2026-01-25T21:00:01.772Z] #37 ANOMALY  ACCUMULATION: net 19 processes (spawns=22 exits=3) [mem:7208MB, , net_procs:19, sys:20583MB avail, swap:370MB]
[2026-01-25T21:00:36.480Z] #38 THREAD_CHANGE PID:2177149 worker threads: 13->6 [mem:7171MB, , net_procs:19, sys:21158MB avail, swap:370MB]
[2026-01-25T21:00:37.699Z] #39 THREAD_CHANGE PID:2356757 claude-code threads: 16->9 [mem:7171MB, , net_procs:19, sys:21115MB avail, swap:370MB]
[2026-01-25T21:00:38.000Z] #40 STATE_CHANGE PID:2413534 claude-code S->R [mem:7176MB, , net_procs:19, sys:21107MB avail, swap:370MB]
[2026-01-25T21:00:38.582Z] #41 ANOMALY  HIGH_THREADS: 298 total threads across all processes [mem:7172MB, , net_procs:19, sys:21106MB avail, swap:370MB]
[2026-01-25T21:00:50.314Z] #42 STATE_CHANGE PID:2413534 claude-code R->S [mem:7169MB, , net_procs:19, sys:21102MB avail, swap:370MB]
[2026-01-25T21:01:01.187Z] #43 THREAD_CHANGE PID:2177149 worker threads: 5->13 [mem:7176MB, , net_procs:19, sys:21095MB avail, swap:370MB]
[2026-01-25T21:01:02.472Z] #44 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:7176MB, , net_procs:19, sys:21076MB avail, swap:370MB]
[2026-01-25T21:01:03.151Z] #45 ANOMALY  HIGH_THREADS: 310 total threads across all processes [mem:7176MB, , net_procs:19, sys:21076MB avail, swap:370MB]
[2026-01-25T21:01:15.149Z] #46 SPAWN PID:3265860 claude-code 435MB fds=46 thr=35 vsz=72886MB cpu=50.5% state=S  [mem:7649MB, , net_procs:20, sys:20408MB avail, swap:370MB]
[2026-01-25T21:01:15.461Z] #47 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:7651MB, , net_procs:20, sys:20358MB avail, swap:370MB]
[2026-01-25T21:01:15.607Z] #48 ANOMALY  ACCUMULATION: net 20 processes (spawns=23 exits=3) [mem:7653MB, , net_procs:20, sys:20351MB avail, swap:370MB]
[2026-01-25T21:01:15.732Z] #49 ANOMALY  HIGH_THREADS: 354 total threads across all processes [mem:7658MB, , net_procs:20, sys:20355MB avail, swap:370MB]
[2026-01-25T21:01:27.369Z] #50 STATE_CHANGE PID:2413534 claude-code S->R [mem:7722MB, , net_procs:20, sys:20569MB avail, swap:370MB]
[2026-01-25T21:01:27.777Z] #51 THREAD_CHANGE PID:3265860 claude-code threads: 35->19 [mem:7724MB, , net_procs:20, sys:20568MB avail, swap:370MB]
[2026-01-25T21:01:28.126Z] #52 ANOMALY  HIGH_THREADS: 334 total threads across all processes [mem:7726MB, , net_procs:20, sys:20497MB avail, swap:370MB]
[2026-01-25T21:01:28.568Z] #53 SESSION_END  Benchmark ABORTED by user after 00:02:10 [mem:7731MB, , net_procs:20, sys:20564MB avail, swap:370MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205918_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_205918_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205918_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205918_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_205918_events.jsonl
```

---

_Report generated at 2026-01-25 21:01:28 UTC_
