# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_210130` |
| Start Time | 2026-01-25 21:01:30 UTC |
| End Time | 2026-01-25 21:02:04 UTC |
| Duration | 00:00:34 (34 seconds) |
| Poll Interval | 10s |
| Total Events | 35 |
| Anomalies | 7 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_210130_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_210130_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_210130_report.md`

---

## Event Summary

```
     21 SPAWN
      7 ANOMALY
      3 STATE_CHANGE
      2 THREAD_CHANGE
      1 SESSION_START
      1 SESSION_END
```

## Peak Values

```json
{
  "peak_total_mem_mb": 8123,
  "peak_swap_mb": 370,
  "min_available_mb": 20173,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

```
2026-01-25T21:01:34.803Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T21:01:34.908Z | HIGH_MEM: 7655MB total (threshold: 6000MB) fds=780 threads=332
2026-01-25T21:01:35.035Z | ACCUMULATION: net 20 processes (spawns=20 exits=0)
2026-01-25T21:01:35.155Z | HIGH_THREADS: 332 total threads across all processes
2026-01-25T21:02:00.388Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T21:02:00.497Z | HIGH_MEM: 8091MB total (threshold: 6000MB) fds=835 threads=383
2026-01-25T21:02:00.631Z | HIGH_THREADS: 383 total threads across all processes
```

---

## Process Spawns (All)

```
2026-01-25T21:01:30.811Z | PID 2176912 | claude-code 1025MB fds=55 thr=21 vsz=74955MB cpu=40.1% state=S 
2026-01-25T21:01:31.008Z | PID 2176975 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude)
2026-01-25T21:01:31.176Z | PID 2177149 | worker 229MB fds=79 thr=14 vsz=73714MB cpu=1.0% state=S 
2026-01-25T21:01:31.379Z | PID 2177204 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun)
2026-01-25T21:01:31.577Z | PID 2177439 | chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S 
2026-01-25T21:01:31.777Z | PID 2177481 | chroma 412MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S 
2026-01-25T21:01:31.960Z | PID 2218628 | claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S 
2026-01-25T21:01:32.162Z | PID 2324436 | claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S 
2026-01-25T21:01:32.356Z | PID 2330749 | claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S 
2026-01-25T21:01:32.535Z | PID 2333496 | claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S 
2026-01-25T21:01:32.734Z | PID 2334120 | claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S 
2026-01-25T21:01:32.925Z | PID 2341546 | claude-code 401MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S 
2026-01-25T21:01:33.117Z | PID 2352236 | claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S 
2026-01-25T21:01:33.327Z | PID 2354907 | claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S 
2026-01-25T21:01:33.524Z | PID 2356757 | claude-code 414MB fds=43 thr=16 vsz=73384MB cpu=0.4% state=S 
2026-01-25T21:01:33.711Z | PID 2400755 | claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S 
2026-01-25T21:01:33.897Z | PID 2413534 | claude-code 930MB fds=73 thr=20 vsz=73956MB cpu=13.1% state=R 
2026-01-25T21:01:34.113Z | PID 2413583 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude)
2026-01-25T21:01:34.312Z | PID 3216780 | claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:01:34.504Z | PID 3265860 | claude-code 406MB fds=46 thr=19 vsz=72886MB cpu=25.8% state=S 
2026-01-25T21:02:00.056Z | PID 3279510 | claude-code 427MB fds=46 thr=38 vsz=73090MB cpu=55.3% state=S 
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

```
2026-01-25T21:01:45.832Z | PID 2177481 | chroma S->R
2026-01-25T21:01:58.230Z | PID 2177481 | chroma R->S
2026-01-25T21:01:59.518Z | PID 2413534 | claude-code R->S
```

---

## Memory Trajectory (sampled every 10 events)

```
2026-01-25T21:01:32.356Z | total:7723MB | swap:370MB | avail:20597MB | 
2026-01-25T21:01:34.312Z | total:7646MB | swap:370MB | avail:20702MB | 
2026-01-25T21:01:34.803Z | total:7647MB | swap:370MB | avail:20699MB | 
2026-01-25T21:01:34.908Z | total:7648MB | swap:370MB | avail:20698MB | 
2026-01-25T21:01:35.035Z | total:7649MB | swap:370MB | avail:20697MB | 
2026-01-25T21:01:35.155Z | total:7649MB | swap:370MB | avail:20711MB | 
2026-01-25T21:01:59.518Z | total:8080MB | swap:370MB | avail:20185MB | 
2026-01-25T21:02:00.388Z | total:8089MB | swap:370MB | avail:20194MB | 
2026-01-25T21:02:00.497Z | total:8091MB | swap:370MB | avail:20192MB | 
2026-01-25T21:02:00.631Z | total:8092MB | swap:370MB | avail:20192MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-25T21:01:30.584Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:7732MB, , net_procs:0, sys:20558MB avail, swap:370MB]
[2026-01-25T21:01:30.811Z] #2 SPAWN PID:2176912 claude-code 1025MB fds=55 thr=21 vsz=74955MB cpu=40.1% state=S  [mem:7740MB, , net_procs:1, sys:20556MB avail, swap:370MB]
[2026-01-25T21:01:31.008Z] #3 SPAWN PID:2176975 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude) [mem:7756MB, , net_procs:2, sys:20531MB avail, swap:370MB]
[2026-01-25T21:01:31.176Z] #4 SPAWN PID:2177149 worker 229MB fds=79 thr=14 vsz=73714MB cpu=1.0% state=S  [mem:7806MB, , net_procs:3, sys:20438MB avail, swap:370MB]
[2026-01-25T21:01:31.379Z] #5 SPAWN PID:2177204 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun) [mem:8055MB, , net_procs:4, sys:20196MB avail, swap:370MB]
[2026-01-25T21:01:31.577Z] #6 SPAWN PID:2177439 chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S  [mem:8123MB, , net_procs:5, sys:20185MB avail, swap:370MB]
[2026-01-25T21:01:31.777Z] #7 SPAWN PID:2177481 chroma 412MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S  [mem:8117MB, , net_procs:6, sys:20230MB avail, swap:370MB]
[2026-01-25T21:01:31.960Z] #8 SPAWN PID:2218628 claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S  [mem:8066MB, , net_procs:7, sys:20242MB avail, swap:370MB]
[2026-01-25T21:01:32.162Z] #9 SPAWN PID:2324436 claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S  [mem:8036MB, , net_procs:8, sys:20493MB avail, swap:370MB]
[2026-01-25T21:01:32.356Z] #10 SPAWN PID:2330749 claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S  [mem:7723MB, , net_procs:9, sys:20597MB avail, swap:370MB]
[2026-01-25T21:01:32.535Z] #11 SPAWN PID:2333496 claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S  [mem:7721MB, , net_procs:10, sys:20598MB avail, swap:370MB]
[2026-01-25T21:01:32.734Z] #12 SPAWN PID:2334120 claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S  [mem:7718MB, , net_procs:11, sys:20599MB avail, swap:370MB]
[2026-01-25T21:01:32.925Z] #13 SPAWN PID:2341546 claude-code 401MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S  [mem:7682MB, , net_procs:12, sys:20635MB avail, swap:370MB]
[2026-01-25T21:01:33.117Z] #14 SPAWN PID:2352236 claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S  [mem:7686MB, , net_procs:13, sys:20635MB avail, swap:370MB]
[2026-01-25T21:01:33.327Z] #15 SPAWN PID:2354907 claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S  [mem:7685MB, , net_procs:14, sys:20648MB avail, swap:370MB]
[2026-01-25T21:01:33.524Z] #16 SPAWN PID:2356757 claude-code 414MB fds=43 thr=16 vsz=73384MB cpu=0.4% state=S  [mem:7683MB, , net_procs:15, sys:20666MB avail, swap:370MB]
[2026-01-25T21:01:33.711Z] #17 SPAWN PID:2400755 claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S  [mem:7669MB, , net_procs:16, sys:20664MB avail, swap:370MB]
[2026-01-25T21:01:33.897Z] #18 SPAWN PID:2413534 claude-code 930MB fds=73 thr=20 vsz=73956MB cpu=13.1% state=R  [mem:7648MB, , net_procs:17, sys:20685MB avail, swap:370MB]
[2026-01-25T21:01:34.113Z] #19 SPAWN PID:2413583 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude) [mem:7646MB, , net_procs:18, sys:20691MB avail, swap:370MB]
[2026-01-25T21:01:34.312Z] #20 SPAWN PID:3216780 claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S  [mem:7646MB, , net_procs:19, sys:20702MB avail, swap:370MB]
[2026-01-25T21:01:34.504Z] #21 SPAWN PID:3265860 claude-code 406MB fds=46 thr=19 vsz=72886MB cpu=25.8% state=S  [mem:7648MB, , net_procs:20, sys:20700MB avail, swap:370MB]
[2026-01-25T21:01:34.803Z] #22 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:7647MB, , net_procs:20, sys:20699MB avail, swap:370MB]
[2026-01-25T21:01:34.908Z] #23 ANOMALY  HIGH_MEM: 7655MB total (threshold: 6000MB) fds=780 threads=332 [mem:7648MB, , net_procs:20, sys:20698MB avail, swap:370MB]
[2026-01-25T21:01:35.035Z] #24 ANOMALY  ACCUMULATION: net 20 processes (spawns=20 exits=0) [mem:7649MB, , net_procs:20, sys:20697MB avail, swap:370MB]
[2026-01-25T21:01:35.155Z] #25 ANOMALY  HIGH_THREADS: 332 total threads across all processes [mem:7649MB, , net_procs:20, sys:20711MB avail, swap:370MB]
[2026-01-25T21:01:45.832Z] #26 STATE_CHANGE PID:2177481 chroma S->R [mem:7832MB, , net_procs:20, sys:20550MB avail, swap:370MB]
[2026-01-25T21:01:46.018Z] #27 THREAD_CHANGE PID:2177481 chroma threads: 69->84 [mem:7962MB, , net_procs:20, sys:20667MB avail, swap:370MB]
[2026-01-25T21:01:58.230Z] #28 STATE_CHANGE PID:2177481 chroma R->S [mem:8089MB, , net_procs:20, sys:20173MB avail, swap:370MB]
[2026-01-25T21:01:58.345Z] #29 THREAD_CHANGE PID:2177481 chroma threads: 84->69 [mem:8090MB, , net_procs:20, sys:20173MB avail, swap:370MB]
[2026-01-25T21:01:59.518Z] #30 STATE_CHANGE PID:2413534 claude-code R->S [mem:8080MB, , net_procs:20, sys:20185MB avail, swap:370MB]
[2026-01-25T21:02:00.056Z] #31 SPAWN PID:3279510 claude-code 427MB fds=46 thr=38 vsz=73090MB cpu=55.3% state=S  [mem:8088MB, , net_procs:21, sys:20176MB avail, swap:370MB]
[2026-01-25T21:02:00.388Z] #32 ANOMALY  HIGH_COUNT: 15 Claude instances (threshold: 5) [mem:8089MB, , net_procs:21, sys:20194MB avail, swap:370MB]
[2026-01-25T21:02:00.497Z] #33 ANOMALY  HIGH_MEM: 8091MB total (threshold: 6000MB) fds=835 threads=383 [mem:8091MB, , net_procs:21, sys:20192MB avail, swap:370MB]
[2026-01-25T21:02:00.631Z] #34 ANOMALY  HIGH_THREADS: 383 total threads across all processes [mem:8092MB, , net_procs:21, sys:20192MB avail, swap:370MB]
[2026-01-25T21:02:03.949Z] #35 SESSION_END  Benchmark ABORTED by user after 00:00:33 [mem:8070MB, , net_procs:21, sys:20277MB avail, swap:370MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-25T21:01:30.584Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:7732MB, , net_procs:0, sys:20558MB avail, swap:370MB]
[2026-01-25T21:01:30.811Z] #2 SPAWN PID:2176912 claude-code 1025MB fds=55 thr=21 vsz=74955MB cpu=40.1% state=S  [mem:7740MB, , net_procs:1, sys:20556MB avail, swap:370MB]
[2026-01-25T21:01:31.008Z] #3 SPAWN PID:2176975 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude) [mem:7756MB, , net_procs:2, sys:20531MB avail, swap:370MB]
[2026-01-25T21:01:31.176Z] #4 SPAWN PID:2177149 worker 229MB fds=79 thr=14 vsz=73714MB cpu=1.0% state=S  [mem:7806MB, , net_procs:3, sys:20438MB avail, swap:370MB]
[2026-01-25T21:01:31.379Z] #5 SPAWN PID:2177204 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun) [mem:8055MB, , net_procs:4, sys:20196MB avail, swap:370MB]
[2026-01-25T21:01:31.577Z] #6 SPAWN PID:2177439 chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S  [mem:8123MB, , net_procs:5, sys:20185MB avail, swap:370MB]
[2026-01-25T21:01:31.777Z] #7 SPAWN PID:2177481 chroma 412MB fds=20 thr=69 vsz=5741MB cpu=10.9% state=S  [mem:8117MB, , net_procs:6, sys:20230MB avail, swap:370MB]
[2026-01-25T21:01:31.960Z] #8 SPAWN PID:2218628 claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.2% state=S  [mem:8066MB, , net_procs:7, sys:20242MB avail, swap:370MB]
[2026-01-25T21:01:32.162Z] #9 SPAWN PID:2324436 claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S  [mem:8036MB, , net_procs:8, sys:20493MB avail, swap:370MB]
[2026-01-25T21:01:32.356Z] #10 SPAWN PID:2330749 claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S  [mem:7723MB, , net_procs:9, sys:20597MB avail, swap:370MB]
[2026-01-25T21:01:32.535Z] #11 SPAWN PID:2333496 claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S  [mem:7721MB, , net_procs:10, sys:20598MB avail, swap:370MB]
[2026-01-25T21:01:32.734Z] #12 SPAWN PID:2334120 claude-code 406MB fds=43 thr=17 vsz=73735MB cpu=0.6% state=S  [mem:7718MB, , net_procs:11, sys:20599MB avail, swap:370MB]
[2026-01-25T21:01:32.925Z] #13 SPAWN PID:2341546 claude-code 401MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S  [mem:7682MB, , net_procs:12, sys:20635MB avail, swap:370MB]
[2026-01-25T21:01:33.117Z] #14 SPAWN PID:2352236 claude-code 418MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S  [mem:7686MB, , net_procs:13, sys:20635MB avail, swap:370MB]
[2026-01-25T21:01:33.327Z] #15 SPAWN PID:2354907 claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S  [mem:7685MB, , net_procs:14, sys:20648MB avail, swap:370MB]
[2026-01-25T21:01:33.524Z] #16 SPAWN PID:2356757 claude-code 414MB fds=43 thr=16 vsz=73384MB cpu=0.4% state=S  [mem:7683MB, , net_procs:15, sys:20666MB avail, swap:370MB]
[2026-01-25T21:01:33.711Z] #17 SPAWN PID:2400755 claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S  [mem:7669MB, , net_procs:16, sys:20664MB avail, swap:370MB]
[2026-01-25T21:01:33.897Z] #18 SPAWN PID:2413534 claude-code 930MB fds=73 thr=20 vsz=73956MB cpu=13.1% state=R  [mem:7648MB, , net_procs:17, sys:20685MB avail, swap:370MB]
[2026-01-25T21:01:34.113Z] #19 SPAWN PID:2413583 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude) [mem:7646MB, , net_procs:18, sys:20691MB avail, swap:370MB]
[2026-01-25T21:01:34.312Z] #20 SPAWN PID:3216780 claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S  [mem:7646MB, , net_procs:19, sys:20702MB avail, swap:370MB]
[2026-01-25T21:01:34.504Z] #21 SPAWN PID:3265860 claude-code 406MB fds=46 thr=19 vsz=72886MB cpu=25.8% state=S  [mem:7648MB, , net_procs:20, sys:20700MB avail, swap:370MB]
[2026-01-25T21:01:34.803Z] #22 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:7647MB, , net_procs:20, sys:20699MB avail, swap:370MB]
[2026-01-25T21:01:34.908Z] #23 ANOMALY  HIGH_MEM: 7655MB total (threshold: 6000MB) fds=780 threads=332 [mem:7648MB, , net_procs:20, sys:20698MB avail, swap:370MB]
[2026-01-25T21:01:35.035Z] #24 ANOMALY  ACCUMULATION: net 20 processes (spawns=20 exits=0) [mem:7649MB, , net_procs:20, sys:20697MB avail, swap:370MB]
[2026-01-25T21:01:35.155Z] #25 ANOMALY  HIGH_THREADS: 332 total threads across all processes [mem:7649MB, , net_procs:20, sys:20711MB avail, swap:370MB]
[2026-01-25T21:01:45.832Z] #26 STATE_CHANGE PID:2177481 chroma S->R [mem:7832MB, , net_procs:20, sys:20550MB avail, swap:370MB]
[2026-01-25T21:01:46.018Z] #27 THREAD_CHANGE PID:2177481 chroma threads: 69->84 [mem:7962MB, , net_procs:20, sys:20667MB avail, swap:370MB]
[2026-01-25T21:01:58.230Z] #28 STATE_CHANGE PID:2177481 chroma R->S [mem:8089MB, , net_procs:20, sys:20173MB avail, swap:370MB]
[2026-01-25T21:01:58.345Z] #29 THREAD_CHANGE PID:2177481 chroma threads: 84->69 [mem:8090MB, , net_procs:20, sys:20173MB avail, swap:370MB]
[2026-01-25T21:01:59.518Z] #30 STATE_CHANGE PID:2413534 claude-code R->S [mem:8080MB, , net_procs:20, sys:20185MB avail, swap:370MB]
[2026-01-25T21:02:00.056Z] #31 SPAWN PID:3279510 claude-code 427MB fds=46 thr=38 vsz=73090MB cpu=55.3% state=S  [mem:8088MB, , net_procs:21, sys:20176MB avail, swap:370MB]
[2026-01-25T21:02:00.388Z] #32 ANOMALY  HIGH_COUNT: 15 Claude instances (threshold: 5) [mem:8089MB, , net_procs:21, sys:20194MB avail, swap:370MB]
[2026-01-25T21:02:00.497Z] #33 ANOMALY  HIGH_MEM: 8091MB total (threshold: 6000MB) fds=835 threads=383 [mem:8091MB, , net_procs:21, sys:20192MB avail, swap:370MB]
[2026-01-25T21:02:00.631Z] #34 ANOMALY  HIGH_THREADS: 383 total threads across all processes [mem:8092MB, , net_procs:21, sys:20192MB avail, swap:370MB]
[2026-01-25T21:02:03.949Z] #35 SESSION_END  Benchmark ABORTED by user after 00:00:33 [mem:8070MB, , net_procs:21, sys:20277MB avail, swap:370MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_210130_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_210130_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_210130_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_210130_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_210130_events.jsonl
```

---

_Report generated at 2026-01-25 21:02:04 UTC_
