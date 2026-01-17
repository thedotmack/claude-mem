# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_204247` |
| Start Time | 2026-01-25 20:42:47 UTC |
| End Time | 2026-01-25 21:01:28 UTC |
| Duration | 00:18:41 (1121 seconds) |
| Poll Interval | 10s |
| Total Events | 237 |
| Anomalies | 56 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_204247_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_204247_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_204247_report.md`

---

## Event Summary

```
     74 THREAD_CHANGE
     56 ANOMALY
     54 STATE_CHANGE
     33 SPAWN
     13 EXIT
      3 PROGRESS
      1 SESSION_START
      1 SESSION_END
      1 ORPHAN
      1 MEM_CHANGE
```

## Peak Values

```json
{
  "peak_total_mem_mb": 9420,
  "peak_swap_mb": 370,
  "min_available_mb": 18400,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

```
2026-01-25T20:42:52.524Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-25T20:42:52.640Z | HIGH_MEM: 8705MB total (threshold: 6000MB) fds=926 threads=370
2026-01-25T20:42:52.784Z | ACCUMULATION: net 23 processes (spawns=23 exits=0)
2026-01-25T20:42:52.895Z | HIGH_THREADS: 370 total threads across all processes
2026-01-25T20:43:05.738Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-25T20:43:05.871Z | HIGH_THREADS: 429 total threads across all processes
2026-01-25T20:43:31.322Z | HIGH_THREADS: 397 total threads across all processes
2026-01-25T20:43:56.722Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:44:09.229Z | HIGH_THREADS: 348 total threads across all processes
2026-01-25T20:44:34.266Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T20:44:34.379Z | HIGH_MEM: 7797MB total (threshold: 6000MB) fds=826 threads=329
2026-01-25T20:48:18.331Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:48:18.444Z | HIGH_MEM: 8308MB total (threshold: 6000MB) fds=867 threads=380
2026-01-25T20:48:18.597Z | HIGH_THREADS: 380 total threads across all processes
2026-01-25T20:48:56.066Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T20:48:56.184Z | HIGH_MEM: 7791MB total (threshold: 6000MB) fds=816 threads=336
2026-01-25T20:48:56.316Z | HIGH_THREADS: 336 total threads across all processes
2026-01-25T20:49:21.340Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:49:21.455Z | HIGH_MEM: 8269MB total (threshold: 6000MB) fds=865 threads=378
2026-01-25T20:49:21.605Z | HIGH_THREADS: 378 total threads across all processes
2026-01-25T20:49:59.035Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T20:49:59.133Z | HIGH_MEM: 7812MB total (threshold: 6000MB) fds=815 threads=335
2026-01-25T20:49:59.263Z | HIGH_THREADS: 335 total threads across all processes
2026-01-25T20:52:03.639Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:52:03.748Z | HIGH_MEM: 8292MB total (threshold: 6000MB) fds=864 threads=380
2026-01-25T20:52:03.884Z | HIGH_THREADS: 380 total threads across all processes
2026-01-25T20:52:41.378Z | HIGH_THREADS: 347 total threads across all processes
2026-01-25T20:52:53.692Z | HIGH_THREADS: 350 total threads across all processes
2026-01-25T20:53:18.984Z | HIGH_THREADS: 347 total threads across all processes
2026-01-25T20:53:31.620Z | HIGH_THREADS: 357 total threads across all processes
2026-01-25T20:53:56.415Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-25T20:55:23.500Z | HIGH_THREADS: 349 total threads across all processes
2026-01-25T20:55:36.192Z | HIGH_THREADS: 385 total threads across all processes
2026-01-25T20:56:26.324Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:56:38.735Z | HIGH_THREADS: 349 total threads across all processes
2026-01-25T20:57:03.351Z | HIGH_THREADS: 354 total threads across all processes
2026-01-25T20:57:15.981Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T20:57:28.485Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:57:41.053Z | HIGH_THREADS: 348 total threads across all processes
2026-01-25T20:57:53.769Z | HIGH_THREADS: 352 total threads across all processes
2026-01-25T20:58:06.329Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T20:58:06.487Z | HIGH_THREADS: 347 total threads across all processes
2026-01-25T20:58:18.803Z | HIGH_THREADS: 350 total threads across all processes
2026-01-25T20:58:31.435Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T20:59:08.628Z | HIGH_THREADS: 349 total threads across all processes
2026-01-25T20:59:33.525Z | HIGH_THREADS: 357 total threads across all processes
2026-01-25T20:59:46.402Z | HIGH_THREADS: 346 total threads across all processes
2026-01-25T20:59:59.352Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-25T20:59:59.491Z | HIGH_MEM: 7194MB total (threshold: 6000MB) fds=735 threads=319
2026-01-25T20:59:59.633Z | ACCUMULATION: net 19 processes (spawns=32 exits=13)
2026-01-25T21:00:48.377Z | HIGH_THREADS: 295 total threads across all processes
2026-01-25T21:01:00.911Z | HIGH_THREADS: 312 total threads across all processes
2026-01-25T21:01:13.310Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T21:01:13.439Z | ACCUMULATION: net 20 processes (spawns=33 exits=13)
2026-01-25T21:01:13.547Z | HIGH_THREADS: 354 total threads across all processes
2026-01-25T21:01:25.901Z | HIGH_THREADS: 335 total threads across all processes
```

---

## Process Spawns (All)

```
2026-01-25T20:42:47.865Z | PID 1895927 | claude-code 710MB fds=66 thr=19 vsz=73574MB cpu=7.8% state=S 
2026-01-25T20:42:48.085Z | PID 1896009 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=1895927(claude)
2026-01-25T20:42:48.283Z | PID 2176912 | claude-code 1036MB fds=59 thr=23 vsz=74928MB cpu=40.7% state=R 
2026-01-25T20:42:48.505Z | PID 2176975 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude)
2026-01-25T20:42:48.688Z | PID 2177149 | worker 206MB fds=85 thr=13 vsz=73714MB cpu=1.0% state=S 
2026-01-25T20:42:48.886Z | PID 2177204 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun)
2026-01-25T20:42:49.084Z | PID 2177439 | chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S 
2026-01-25T20:42:49.270Z | PID 2177481 | chroma 412MB fds=23 thr=72 vsz=5765MB cpu=10.7% state=S 
2026-01-25T20:42:49.453Z | PID 2218628 | claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.3% state=S 
2026-01-25T20:42:49.639Z | PID 2324436 | claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S 
2026-01-25T20:42:49.827Z | PID 2330749 | claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S 
2026-01-25T20:42:50.016Z | PID 2333496 | claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S 
2026-01-25T20:42:50.211Z | PID 2334120 | claude-code 405MB fds=43 thr=16 vsz=73731MB cpu=0.6% state=S 
2026-01-25T20:42:50.386Z | PID 2341546 | claude-code 401MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S 
2026-01-25T20:42:50.594Z | PID 2352236 | claude-code 417MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S 
2026-01-25T20:42:50.788Z | PID 2354907 | claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S 
2026-01-25T20:42:50.967Z | PID 2356757 | claude-code 413MB fds=43 thr=9 vsz=73384MB cpu=0.4% state=S 
2026-01-25T20:42:51.156Z | PID 2400755 | claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S 
2026-01-25T20:42:51.354Z | PID 2413534 | claude-code 798MB fds=72 thr=20 vsz=73634MB cpu=9.7% state=R 
2026-01-25T20:42:51.589Z | PID 2413583 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude)
2026-01-25T20:42:51.771Z | PID 2977657 | claude-code 410MB fds=46 thr=18 vsz=72878MB cpu=14.3% state=S 
2026-01-25T20:42:51.977Z | PID 3023279 | claude-code 416MB fds=47 thr=17 vsz=72958MB cpu=18.4% state=S 
2026-01-25T20:42:52.186Z | PID 3031756 | claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T20:43:05.366Z | PID 3043103 | claude-code 469MB fds=46 thr=35 vsz=72918MB cpu=41.7% state=S 
2026-01-25T20:48:17.987Z | PID 3097752 | claude-code 476MB fds=48 thr=34 vsz=72850MB cpu=75.0% state=S 
2026-01-25T20:49:21.006Z | PID 3108771 | claude-code 453MB fds=46 thr=34 vsz=72858MB cpu=85.7% state=S 
2026-01-25T20:52:03.304Z | PID 3135804 | claude-code 482MB fds=46 thr=34 vsz=72858MB cpu=36.4% state=S 
2026-01-25T20:53:56.084Z | PID 3159654 | claude-code 456MB fds=46 thr=36 vsz=72986MB cpu=62.4% state=S 
2026-01-25T20:55:10.504Z | PID 3175364 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.2% state=S 
2026-01-25T20:55:35.690Z | PID 3180112 | claude-code 513MB fds=47 thr=34 vsz=72922MB cpu=55.7% state=S 
2026-01-25T20:57:28.188Z | PID 3202964 | claude-code 1MB fds=4 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T20:58:31.072Z | PID 3216780 | claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:01:12.970Z | PID 3265860 | claude-code 430MB fds=46 thr=35 vsz=72886MB cpu=75.3% state=S 
```


---

## Process Exits (All)

```
2026-01-25T20:43:56.214Z | PID 3023279 | claude-code 435MB fds=46 thr=19 lived 65s 
2026-01-25T20:43:56.349Z | PID 3043103 | claude-code 443MB fds=46 thr=17 lived 51s 
2026-01-25T20:44:33.923Z | PID 2977657 | claude-code 404MB fds=46 thr=17 lived 102s 
2026-01-25T20:48:55.715Z | PID 3097752 | claude-code 461MB fds=49 thr=18 lived 38s 
2026-01-25T20:49:58.701Z | PID 3108771 | claude-code 427MB fds=47 thr=18 lived 37s 
2026-01-25T20:55:10.641Z | PID 3135804 | claude-code 443MB fds=47 thr=16 lived 187s 
2026-01-25T20:55:35.823Z | PID 3175364 | claude-code 3MB fds=3 thr=1 lived 25s 
2026-01-25T20:56:26.007Z | PID 3180112 | claude-code 463MB fds=48 thr=16 lived 51s 
2026-01-25T20:57:15.647Z | PID 3031756 | claude-code 1MB fds=3 thr=1 lived 863s 
2026-01-25T20:58:06.016Z | PID 3202964 | claude-code 1MB fds=4 thr=1 lived 38s 
2026-01-25T20:59:58.575Z | PID 1896009 | mcp-server 67MB fds=21 thr=7 lived 1030s 
2026-01-25T20:59:58.730Z | PID 3159654 | claude-code 419MB fds=46 thr=18 lived 362s 
2026-01-25T20:59:59.038Z | PID 1895927 | claude-code 707MB fds=66 thr=18 lived 1031s orphaned MCP:1896009
```


---

## Orphan Events

```
2026-01-25T20:59:58.878Z | PID 1896009 | mcp-server orphaned by death of 1895927
```

---

## Memory Changes (>100MB)

```
2026-01-25T20:53:55.544Z | PID 2413534 | claude-code 759MB->871MB (1112MB) fds=70 thr=20
```

---

## State Changes

```
2026-01-25T20:43:03.114Z | PID 1895927 | claude-code S->R
2026-01-25T20:43:16.099Z | PID 1895927 | claude-code R->S
2026-01-25T20:43:28.896Z | PID 2176912 | claude-code R->S
2026-01-25T20:43:30.484Z | PID 2413534 | claude-code R->S
2026-01-25T20:43:43.132Z | PID 2413534 | claude-code S->R
2026-01-25T20:44:07.131Z | PID 2176912 | claude-code S->D
2026-01-25T20:44:19.672Z | PID 2176912 | claude-code D->S
2026-01-25T20:44:21.272Z | PID 2413534 | claude-code R->S
2026-01-25T20:45:23.012Z | PID 2352236 | claude-code S->R
2026-01-25T20:45:35.418Z | PID 2352236 | claude-code R->S
2026-01-25T20:48:15.930Z | PID 2176912 | claude-code S->R
2026-01-25T20:48:30.664Z | PID 3097752 | claude-code S->R
2026-01-25T20:48:41.451Z | PID 2176912 | claude-code R->S
2026-01-25T20:48:43.337Z | PID 3097752 | claude-code R->S
2026-01-25T20:48:53.803Z | PID 1895927 | claude-code S->R
2026-01-25T20:49:06.533Z | PID 1895927 | claude-code R->S
2026-01-25T20:49:32.023Z | PID 2176912 | claude-code S->R
2026-01-25T20:49:44.497Z | PID 2176912 | claude-code R->S
2026-01-25T20:49:58.364Z | PID 2413534 | claude-code S->R
2026-01-25T20:50:11.304Z | PID 2413534 | claude-code R->S
2026-01-25T20:50:22.146Z | PID 2176912 | claude-code S->R
2026-01-25T20:50:34.464Z | PID 2176912 | claude-code R->S
2026-01-25T20:51:50.251Z | PID 2413534 | claude-code S->R
2026-01-25T20:52:01.075Z | PID 2176912 | claude-code S->R
2026-01-25T20:52:02.918Z | PID 2413534 | claude-code R->S
2026-01-25T20:52:14.268Z | PID 2176912 | claude-code R->S
2026-01-25T20:52:27.194Z | PID 2177481 | chroma S->R
2026-01-25T20:52:39.113Z | PID 2176912 | claude-code S->R
2026-01-25T20:52:39.654Z | PID 2177481 | chroma R->S
2026-01-25T20:53:05.283Z | PID 2354907 | claude-code S->R
2026-01-25T20:53:16.365Z | PID 1895927 | claude-code S->R
2026-01-25T20:53:16.639Z | PID 2176912 | claude-code R->S
2026-01-25T20:53:18.008Z | PID 2354907 | claude-code R->S
2026-01-25T20:53:29.217Z | PID 1895927 | claude-code R->S
2026-01-25T20:53:29.475Z | PID 2176912 | claude-code S->R
2026-01-25T20:54:08.321Z | PID 2413534 | claude-code S->R
2026-01-25T20:54:32.794Z | PID 2413534 | claude-code R->S
2026-01-25T20:54:45.147Z | PID 2413534 | claude-code S->R
2026-01-25T20:54:45.509Z | PID 3135804 | claude-code S->R
2026-01-25T20:55:08.564Z | PID 2176912 | claude-code R->S
2026-01-25T20:55:21.271Z | PID 2176912 | claude-code S->R
2026-01-25T20:55:22.785Z | PID 2413534 | claude-code R->S
2026-01-25T20:55:35.219Z | PID 2413534 | claude-code S->R
2026-01-25T20:55:58.954Z | PID 2176912 | claude-code R->S
2026-01-25T20:56:12.204Z | PID 2333496 | claude-code S->R
2026-01-25T20:56:12.995Z | PID 2413534 | claude-code R->S
2026-01-25T20:56:24.743Z | PID 2333496 | claude-code R->S
2026-01-25T20:56:25.615Z | PID 2413534 | claude-code S->R
2026-01-25T20:57:53.098Z | PID 2413534 | claude-code R->S
2026-01-25T20:58:18.278Z | PID 2413534 | claude-code S->R
2026-01-25T20:59:32.828Z | PID 2413534 | claude-code R->S
2026-01-25T20:59:45.015Z | PID 2334120 | claude-code S->R
2026-01-25T20:59:57.580Z | PID 2334120 | claude-code R->S
2026-01-25T21:01:12.583Z | PID 2413534 | claude-code S->R
```

---

## Memory Trajectory (sampled every 10 events)

```
2026-01-25T20:42:49.453Z | total:8714MB | swap:370MB | avail:19684MB | 
2026-01-25T20:42:51.354Z | total:8694MB | swap:370MB | avail:19729MB | 
2026-01-25T20:42:52.524Z | total:8797MB | swap:370MB | avail:19677MB | 
2026-01-25T20:42:52.640Z | total:8870MB | swap:370MB | avail:19598MB | 
2026-01-25T20:42:52.784Z | total:8722MB | swap:370MB | avail:19684MB | 
2026-01-25T20:42:52.895Z | total:8711MB | swap:370MB | avail:19616MB | 
2026-01-25T20:43:04.647Z | total:9420MB | swap:370MB | avail:18845MB | 
2026-01-25T20:43:05.738Z | total:9259MB | swap:370MB | avail:19019MB | 
2026-01-25T20:43:05.871Z | total:9265MB | swap:370MB | avail:19023MB | 
2026-01-25T20:43:31.322Z | total:9167MB | swap:370MB | avail:19315MB | 
2026-01-25T20:43:55.569Z | total:8302MB | swap:370MB | avail:20102MB | 
2026-01-25T20:43:56.722Z | total:8284MB | swap:370MB | avail:20123MB | 
2026-01-25T20:44:09.229Z | total:8268MB | swap:370MB | avail:20212MB | 
2026-01-25T20:44:34.266Z | total:7809MB | swap:370MB | avail:20590MB | 
2026-01-25T20:44:34.379Z | total:7810MB | swap:370MB | avail:20590MB | 
2026-01-25T20:46:11.725Z | total:7797MB | swap:370MB | avail:20644MB | 
2026-01-25T20:47:26.539Z | total:7811MB | swap:370MB | avail:20616MB | 
2026-01-25T20:48:18.331Z | total:8287MB | swap:370MB | avail:20141MB | 
2026-01-25T20:48:18.444Z | total:8288MB | swap:370MB | avail:20141MB | 
2026-01-25T20:48:18.597Z | total:8289MB | swap:370MB | avail:20141MB | 
2026-01-25T20:48:56.066Z | total:7808MB | swap:370MB | avail:20594MB | 
2026-01-25T20:48:56.184Z | total:7809MB | swap:370MB | avail:20595MB | 
2026-01-25T20:48:56.316Z | total:7809MB | swap:370MB | avail:20595MB | 
2026-01-25T20:49:21.340Z | total:8261MB | swap:370MB | avail:20138MB | 
2026-01-25T20:49:21.455Z | total:8262MB | swap:370MB | avail:20136MB | 
2026-01-25T20:49:21.605Z | total:8263MB | swap:370MB | avail:20139MB | 
2026-01-25T20:49:44.497Z | total:8239MB | swap:370MB | avail:20171MB | 
2026-01-25T20:49:59.035Z | total:7826MB | swap:370MB | avail:20567MB | 
2026-01-25T20:49:59.133Z | total:7826MB | swap:370MB | avail:20567MB | 
2026-01-25T20:49:59.263Z | total:7826MB | swap:370MB | avail:20572MB | 
2026-01-25T20:50:34.464Z | total:7813MB | swap:370MB | avail:20641MB | 
2026-01-25T20:51:37.875Z | total:7805MB | swap:370MB | avail:20629MB | 
2026-01-25T20:52:03.639Z | total:8323MB | swap:370MB | avail:20132MB | 
2026-01-25T20:52:03.748Z | total:8323MB | swap:370MB | avail:20134MB | 
2026-01-25T20:52:03.884Z | total:8326MB | swap:370MB | avail:20131MB | 
2026-01-25T20:52:14.268Z | total:8340MB | swap:370MB | avail:20027MB | 
2026-01-25T20:52:41.378Z | total:8333MB | swap:370MB | avail:20044MB | 
2026-01-25T20:52:53.692Z | total:8370MB | swap:370MB | avail:20027MB | 
2026-01-25T20:53:05.469Z | total:8296MB | swap:370MB | avail:20078MB | 
2026-01-25T20:53:18.984Z | total:8281MB | swap:370MB | avail:20001MB | 
2026-01-25T20:53:31.620Z | total:8304MB | swap:370MB | avail:19949MB | 
2026-01-25T20:53:55.544Z | total:8889MB | swap:370MB | avail:19464MB | 
2026-01-25T20:53:56.415Z | total:8853MB | swap:370MB | avail:19449MB | 
2026-01-25T20:55:08.564Z | total:8360MB | swap:370MB | avail:19655MB | 
2026-01-25T20:55:23.500Z | total:8372MB | swap:370MB | avail:18893MB | 
2026-01-25T20:55:36.192Z | total:8887MB | swap:370MB | avail:19262MB | 
2026-01-25T20:56:26.007Z | total:8386MB | swap:370MB | avail:20045MB | 
2026-01-25T20:56:26.324Z | total:8387MB | swap:370MB | avail:20057MB | 
2026-01-25T20:56:38.735Z | total:8354MB | swap:370MB | avail:20014MB | 
2026-01-25T20:57:03.351Z | total:8387MB | swap:370MB | avail:20079MB | 
2026-01-25T20:57:15.981Z | total:8393MB | swap:370MB | avail:20086MB | 
2026-01-25T20:57:28.188Z | total:8357MB | swap:370MB | avail:20104MB | 
2026-01-25T20:57:28.485Z | total:8438MB | swap:370MB | avail:20043MB | 
2026-01-25T20:57:41.053Z | total:8370MB | swap:370MB | avail:20104MB | 
2026-01-25T20:57:53.769Z | total:8445MB | swap:370MB | avail:19962MB | 
2026-01-25T20:58:06.329Z | total:8389MB | swap:370MB | avail:20047MB | 
2026-01-25T20:58:06.487Z | total:8390MB | swap:370MB | avail:20047MB | 
2026-01-25T20:58:18.278Z | total:8395MB | swap:370MB | avail:20032MB | 
2026-01-25T20:58:18.803Z | total:8403MB | swap:370MB | avail:20017MB | 
2026-01-25T20:58:31.435Z | total:8401MB | swap:370MB | avail:20083MB | 
2026-01-25T20:59:08.628Z | total:8448MB | swap:370MB | avail:20055MB | 
2026-01-25T20:59:32.828Z | total:8467MB | swap:370MB | avail:20012MB | 
2026-01-25T20:59:33.525Z | total:8471MB | swap:370MB | avail:20010MB | 
2026-01-25T20:59:46.402Z | total:8405MB | swap:370MB | avail:20104MB | 
2026-01-25T20:59:59.038Z | total:7209MB | swap:370MB | avail:21215MB | 
2026-01-25T20:59:59.352Z | total:7210MB | swap:370MB | avail:21215MB | 
2026-01-25T20:59:59.491Z | total:7210MB | swap:370MB | avail:21216MB | 
2026-01-25T20:59:59.633Z | total:7209MB | swap:370MB | avail:21215MB | 
2026-01-25T21:00:48.377Z | total:7169MB | swap:370MB | avail:21099MB | 
2026-01-25T21:01:00.911Z | total:7176MB | swap:370MB | avail:21097MB | 
2026-01-25T21:01:12.583Z | total:7651MB | swap:370MB | avail:20358MB | 
2026-01-25T21:01:13.310Z | total:7655MB | swap:370MB | avail:20387MB | 
2026-01-25T21:01:13.439Z | total:7656MB | swap:370MB | avail:20394MB | 
2026-01-25T21:01:13.547Z | total:7657MB | swap:370MB | avail:20392MB | 
2026-01-25T21:01:25.901Z | total:7727MB | swap:370MB | avail:20498MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-25T20:42:47.641Z] #1 SESSION_START  Benchmark started, duration: 1h (3600 s), poll interval: 10s [mem:8740MB, , net_procs:0, sys:19687MB avail, swap:370MB]
[2026-01-25T20:42:47.865Z] #2 SPAWN PID:1895927 claude-code 710MB fds=66 thr=19 vsz=73574MB cpu=7.8% state=S  [mem:8743MB, , net_procs:1, sys:19686MB avail, swap:370MB]
[2026-01-25T20:42:48.085Z] #3 SPAWN PID:1896009 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=1895927(claude) [mem:8745MB, , net_procs:2, sys:19660MB avail, swap:370MB]
[2026-01-25T20:42:48.283Z] #4 SPAWN PID:2176912 claude-code 1036MB fds=59 thr=23 vsz=74928MB cpu=40.7% state=R  [mem:8924MB, , net_procs:3, sys:19635MB avail, swap:370MB]
[2026-01-25T20:42:48.505Z] #5 SPAWN PID:2176975 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2176912(claude) [mem:8757MB, , net_procs:4, sys:19651MB avail, swap:370MB]
[2026-01-25T20:42:48.688Z] #6 SPAWN PID:2177149 worker 206MB fds=85 thr=13 vsz=73714MB cpu=1.0% state=S  [mem:8770MB, , net_procs:5, sys:19644MB avail, swap:370MB]
[2026-01-25T20:42:48.886Z] #7 SPAWN PID:2177204 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2177149(bun) [mem:8748MB, , net_procs:6, sys:19651MB avail, swap:370MB]
[2026-01-25T20:42:49.084Z] #8 SPAWN PID:2177439 chroma 44MB fds=11 thr=2 vsz=1941MB cpu=0.0% state=S  [mem:8741MB, , net_procs:7, sys:19649MB avail, swap:370MB]
[2026-01-25T20:42:49.270Z] #9 SPAWN PID:2177481 chroma 412MB fds=23 thr=72 vsz=5765MB cpu=10.7% state=S  [mem:8738MB, , net_procs:8, sys:19664MB avail, swap:370MB]
[2026-01-25T20:42:49.453Z] #10 SPAWN PID:2218628 claude-code 481MB fds=43 thr=17 vsz=75932MB cpu=1.3% state=S  [mem:8714MB, , net_procs:9, sys:19684MB avail, swap:370MB]
[2026-01-25T20:42:49.639Z] #11 SPAWN PID:2324436 claude-code 488MB fds=43 thr=17 vsz=79748MB cpu=1.0% state=S  [mem:8714MB, , net_procs:10, sys:19717MB avail, swap:370MB]
[2026-01-25T20:42:49.827Z] #12 SPAWN PID:2330749 claude-code 490MB fds=43 thr=17 vsz=74054MB cpu=0.6% state=S  [mem:8678MB, , net_procs:11, sys:19716MB avail, swap:370MB]
[2026-01-25T20:42:50.016Z] #13 SPAWN PID:2333496 claude-code 405MB fds=43 thr=17 vsz=74120MB cpu=0.8% state=S  [mem:8678MB, , net_procs:12, sys:19714MB avail, swap:370MB]
[2026-01-25T20:42:50.211Z] #14 SPAWN PID:2334120 claude-code 405MB fds=43 thr=16 vsz=73731MB cpu=0.6% state=S  [mem:8679MB, , net_procs:13, sys:19731MB avail, swap:370MB]
[2026-01-25T20:42:50.386Z] #15 SPAWN PID:2341546 claude-code 401MB fds=43 thr=16 vsz=73726MB cpu=0.6% state=S  [mem:8688MB, , net_procs:14, sys:19716MB avail, swap:370MB]
[2026-01-25T20:42:50.594Z] #16 SPAWN PID:2352236 claude-code 417MB fds=43 thr=16 vsz=73485MB cpu=0.6% state=S  [mem:8690MB, , net_procs:15, sys:19714MB avail, swap:370MB]
[2026-01-25T20:42:50.788Z] #17 SPAWN PID:2354907 claude-code 400MB fds=43 thr=16 vsz=73520MB cpu=0.7% state=S  [mem:8687MB, , net_procs:16, sys:19718MB avail, swap:370MB]
[2026-01-25T20:42:50.967Z] #18 SPAWN PID:2356757 claude-code 413MB fds=43 thr=9 vsz=73384MB cpu=0.4% state=S  [mem:8690MB, , net_procs:17, sys:19723MB avail, swap:370MB]
[2026-01-25T20:42:51.156Z] #19 SPAWN PID:2400755 claude-code 504MB fds=43 thr=16 vsz=73626MB cpu=0.6% state=S  [mem:8694MB, , net_procs:18, sys:19730MB avail, swap:370MB]
[2026-01-25T20:42:51.354Z] #20 SPAWN PID:2413534 claude-code 798MB fds=72 thr=20 vsz=73634MB cpu=9.7% state=R  [mem:8694MB, , net_procs:19, sys:19729MB avail, swap:370MB]
[2026-01-25T20:42:51.589Z] #21 SPAWN PID:2413583 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=2413534(claude) [mem:8697MB, , net_procs:20, sys:19727MB avail, swap:370MB]
[2026-01-25T20:42:51.771Z] #22 SPAWN PID:2977657 claude-code 410MB fds=46 thr=18 vsz=72878MB cpu=14.3% state=S  [mem:8699MB, , net_procs:21, sys:19726MB avail, swap:370MB]
[2026-01-25T20:42:51.977Z] #23 SPAWN PID:3023279 claude-code 416MB fds=47 thr=17 vsz=72958MB cpu=18.4% state=S  [mem:8705MB, , net_procs:22, sys:19723MB avail, swap:370MB]
[2026-01-25T20:42:52.186Z] #24 SPAWN PID:3031756 claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S  [mem:8709MB, , net_procs:23, sys:19729MB avail, swap:370MB]
[2026-01-25T20:42:52.524Z] #25 ANOMALY  HIGH_COUNT: 16 Claude instances (threshold: 5) [mem:8797MB, , net_procs:23, sys:19677MB avail, swap:370MB]
[2026-01-25T20:42:52.640Z] #26 ANOMALY  HIGH_MEM: 8705MB total (threshold: 6000MB) fds=926 threads=370 [mem:8870MB, , net_procs:23, sys:19598MB avail, swap:370MB]
[2026-01-25T20:42:52.784Z] #27 ANOMALY  ACCUMULATION: net 23 processes (spawns=23 exits=0) [mem:8722MB, , net_procs:23, sys:19684MB avail, swap:370MB]
[2026-01-25T20:42:52.895Z] #28 ANOMALY  HIGH_THREADS: 370 total threads across all processes [mem:8711MB, , net_procs:23, sys:19616MB avail, swap:370MB]
[2026-01-25T20:43:03.114Z] #29 STATE_CHANGE PID:1895927 claude-code S->R [mem:9209MB, , net_procs:23, sys:19062MB avail, swap:370MB]
[2026-01-25T20:43:04.647Z] #30 THREAD_CHANGE PID:2356757 claude-code threads: 9->16 [mem:9420MB, , net_procs:23, sys:18845MB avail, swap:370MB]
[2026-01-25T20:43:05.366Z] #31 SPAWN PID:3043103 claude-code 469MB fds=46 thr=35 vsz=72918MB cpu=41.7% state=S  [mem:9248MB, , net_procs:24, sys:19012MB avail, swap:370MB]
[2026-01-25T20:43:05.738Z] #32 ANOMALY  HIGH_COUNT: 17 Claude instances (threshold: 5) [mem:9259MB, , net_procs:24, sys:19019MB avail, swap:370MB]
[2026-01-25T20:43:05.871Z] #33 ANOMALY  HIGH_THREADS: 429 total threads across all processes [mem:9265MB, , net_procs:24, sys:19023MB avail, swap:370MB]
[2026-01-25T20:43:16.099Z] #34 STATE_CHANGE PID:1895927 claude-code R->S [mem:9223MB, , net_procs:24, sys:19032MB avail, swap:370MB]
[2026-01-25T20:43:18.206Z] #35 THREAD_CHANGE PID:3043103 claude-code threads: 35->19 [mem:9258MB, , net_procs:24, sys:19098MB avail, swap:370MB]
[2026-01-25T20:43:28.896Z] #36 STATE_CHANGE PID:2176912 claude-code R->S [mem:9203MB, , net_procs:24, sys:19282MB avail, swap:370MB]
[2026-01-25T20:43:30.484Z] #37 STATE_CHANGE PID:2413534 claude-code R->S [mem:9189MB, , net_procs:24, sys:19304MB avail, swap:370MB]
[2026-01-25T20:43:31.322Z] #38 ANOMALY  HIGH_THREADS: 397 total threads across all processes [mem:9167MB, , net_procs:24, sys:19315MB avail, swap:370MB]
[2026-01-25T20:43:43.132Z] #39 STATE_CHANGE PID:2413534 claude-code S->R [mem:9216MB, , net_procs:24, sys:19297MB avail, swap:370MB]
[2026-01-25T20:43:55.569Z] #40 THREAD_CHANGE PID:2356757 claude-code threads: 16->9 [mem:8302MB, , net_procs:24, sys:20102MB avail, swap:370MB]
[2026-01-25T20:43:56.214Z] #41 EXIT PID:3023279 claude-code 435MB fds=46 thr=19 lived 65s  [mem:8308MB, , net_procs:23, sys:20099MB avail, swap:370MB]
[2026-01-25T20:43:56.349Z] #42 EXIT PID:3043103 claude-code 443MB fds=46 thr=17 lived 51s  [mem:8307MB, , net_procs:22, sys:20099MB avail, swap:370MB]
[2026-01-25T20:43:56.722Z] #43 ANOMALY  HIGH_COUNT: 15 Claude instances (threshold: 5) [mem:8284MB, , net_procs:22, sys:20123MB avail, swap:370MB]
[2026-01-25T20:44:07.131Z] #44 STATE_CHANGE PID:2176912 claude-code S->D [mem:8251MB, , net_procs:22, sys:20227MB avail, swap:370MB]
[2026-01-25T20:44:09.229Z] #45 ANOMALY  HIGH_THREADS: 348 total threads across all processes [mem:8268MB, , net_procs:22, sys:20212MB avail, swap:370MB]
[2026-01-25T20:44:19.672Z] #46 STATE_CHANGE PID:2176912 claude-code D->S [mem:8259MB, , net_procs:22, sys:20228MB avail, swap:370MB]
[2026-01-25T20:44:21.272Z] #47 STATE_CHANGE PID:2413534 claude-code R->S [mem:8213MB, , net_procs:22, sys:20273MB avail, swap:370MB]
[2026-01-25T20:44:33.923Z] #48 EXIT PID:2977657 claude-code 404MB fds=46 thr=17 lived 102s  [mem:7810MB, , net_procs:21, sys:20584MB avail, swap:370MB]
[2026-01-25T20:44:34.266Z] #49 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:7809MB, , net_procs:21, sys:20590MB avail, swap:370MB]
[2026-01-25T20:44:34.379Z] #50 ANOMALY  HIGH_MEM: 7797MB total (threshold: 6000MB) fds=826 threads=329 [mem:7810MB, , net_procs:21, sys:20590MB avail, swap:370MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-25T20:57:15.981Z] #188 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:8393MB, , net_procs:21, sys:20086MB avail, swap:370MB]
[2026-01-25T20:57:27.642Z] #189 THREAD_CHANGE PID:2356757 claude-code threads: 9->16 [mem:8355MB, , net_procs:21, sys:20100MB avail, swap:370MB]
[2026-01-25T20:57:28.188Z] #190 SPAWN PID:3202964 claude-code 1MB fds=4 thr=1 vsz=7MB cpu=0.0% state=S  [mem:8357MB, , net_procs:22, sys:20104MB avail, swap:370MB]
[2026-01-25T20:57:28.485Z] #191 ANOMALY  HIGH_COUNT: 15 Claude instances (threshold: 5) [mem:8438MB, , net_procs:22, sys:20043MB avail, swap:370MB]
[2026-01-25T20:57:40.257Z] #192 THREAD_CHANGE PID:2356757 claude-code threads: 16->9 [mem:8368MB, , net_procs:22, sys:20093MB avail, swap:370MB]
[2026-01-25T20:57:41.053Z] #193 ANOMALY  HIGH_THREADS: 348 total threads across all processes [mem:8370MB, , net_procs:22, sys:20104MB avail, swap:370MB]
[2026-01-25T20:57:53.098Z] #194 STATE_CHANGE PID:2413534 claude-code R->S [mem:8439MB, , net_procs:22, sys:19955MB avail, swap:370MB]
[2026-01-25T20:57:53.769Z] #195 ANOMALY  HIGH_THREADS: 352 total threads across all processes [mem:8445MB, , net_procs:22, sys:19962MB avail, swap:370MB]
[2026-01-25T20:57:53.884Z] #196 PROGRESS  Elapsed: 00:15:06, Remaining: 00:44:54, Events: 195 [mem:8446MB, , net_procs:22, sys:19962MB avail, swap:370MB]
[2026-01-25T20:58:06.016Z] #197 EXIT PID:3202964 claude-code 1MB fds=4 thr=1 lived 38s  [mem:8389MB, , net_procs:21, sys:20043MB avail, swap:370MB]
[2026-01-25T20:58:06.329Z] #198 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:8389MB, , net_procs:21, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:06.487Z] #199 ANOMALY  HIGH_THREADS: 347 total threads across all processes [mem:8390MB, , net_procs:21, sys:20047MB avail, swap:370MB]
[2026-01-25T20:58:18.278Z] #200 STATE_CHANGE PID:2413534 claude-code S->R [mem:8395MB, , net_procs:21, sys:20032MB avail, swap:370MB]
[2026-01-25T20:58:18.803Z] #201 ANOMALY  HIGH_THREADS: 350 total threads across all processes [mem:8403MB, , net_procs:21, sys:20017MB avail, swap:370MB]
[2026-01-25T20:58:30.487Z] #202 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:8397MB, , net_procs:21, sys:20086MB avail, swap:370MB]
[2026-01-25T20:58:31.072Z] #203 SPAWN PID:3216780 claude-code 1MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S  [mem:8399MB, , net_procs:22, sys:20080MB avail, swap:370MB]
[2026-01-25T20:58:31.435Z] #204 ANOMALY  HIGH_COUNT: 15 Claude instances (threshold: 5) [mem:8401MB, , net_procs:22, sys:20083MB avail, swap:370MB]
[2026-01-25T20:58:43.097Z] #205 THREAD_CHANGE PID:2356757 claude-code threads: 16->9 [mem:8414MB, , net_procs:22, sys:20057MB avail, swap:370MB]
[2026-01-25T20:58:55.519Z] #206 THREAD_CHANGE PID:2356757 claude-code threads: 9->16 [mem:8437MB, , net_procs:22, sys:19997MB avail, swap:370MB]
[2026-01-25T20:59:07.831Z] #207 THREAD_CHANGE PID:2356757 claude-code threads: 16->9 [mem:8443MB, , net_procs:22, sys:20051MB avail, swap:370MB]
[2026-01-25T20:59:08.628Z] #208 ANOMALY  HIGH_THREADS: 349 total threads across all processes [mem:8448MB, , net_procs:22, sys:20055MB avail, swap:370MB]
[2026-01-25T20:59:32.526Z] #209 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:8465MB, , net_procs:22, sys:20016MB avail, swap:370MB]
[2026-01-25T20:59:32.828Z] #210 STATE_CHANGE PID:2413534 claude-code R->S [mem:8467MB, , net_procs:22, sys:20012MB avail, swap:370MB]
[2026-01-25T20:59:33.525Z] #211 ANOMALY  HIGH_THREADS: 357 total threads across all processes [mem:8471MB, , net_procs:22, sys:20010MB avail, swap:370MB]
[2026-01-25T20:59:45.015Z] #212 STATE_CHANGE PID:2334120 claude-code S->R [mem:8400MB, , net_procs:22, sys:20110MB avail, swap:370MB]
[2026-01-25T20:59:45.562Z] #213 THREAD_CHANGE PID:2356757 claude-code threads: 16->8 [mem:8402MB, , net_procs:22, sys:20112MB avail, swap:370MB]
[2026-01-25T20:59:46.402Z] #214 ANOMALY  HIGH_THREADS: 346 total threads across all processes [mem:8405MB, , net_procs:22, sys:20104MB avail, swap:370MB]
[2026-01-25T20:59:57.580Z] #215 STATE_CHANGE PID:2334120 claude-code R->S [mem:7209MB, , net_procs:22, sys:21213MB avail, swap:370MB]
[2026-01-25T20:59:58.057Z] #216 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:7209MB, , net_procs:22, sys:21212MB avail, swap:370MB]
[2026-01-25T20:59:58.575Z] #217 EXIT PID:1896009 mcp-server 67MB fds=21 thr=7 lived 1030s  [mem:7209MB, , net_procs:21, sys:21212MB avail, swap:370MB]
[2026-01-25T20:59:58.730Z] #218 EXIT PID:3159654 claude-code 419MB fds=46 thr=18 lived 362s  [mem:7209MB, , net_procs:20, sys:21213MB avail, swap:370MB]
[2026-01-25T20:59:58.878Z] #219 ORPHAN PID:1896009 mcp-server orphaned by death of 1895927 [mem:7209MB, , net_procs:19, sys:21213MB avail, swap:370MB]
[2026-01-25T20:59:59.038Z] #220 EXIT PID:1895927 claude-code 707MB fds=66 thr=18 lived 1031s orphaned MCP:1896009 [mem:7209MB, , net_procs:19, sys:21215MB avail, swap:370MB]
[2026-01-25T20:59:59.352Z] #221 ANOMALY  HIGH_COUNT: 13 Claude instances (threshold: 5) [mem:7210MB, , net_procs:19, sys:21215MB avail, swap:370MB]
[2026-01-25T20:59:59.491Z] #222 ANOMALY  HIGH_MEM: 7194MB total (threshold: 6000MB) fds=735 threads=319 [mem:7210MB, , net_procs:19, sys:21216MB avail, swap:370MB]
[2026-01-25T20:59:59.633Z] #223 ANOMALY  ACCUMULATION: net 19 processes (spawns=32 exits=13) [mem:7209MB, , net_procs:19, sys:21215MB avail, swap:370MB]
[2026-01-25T21:00:35.329Z] #224 THREAD_CHANGE PID:2356757 claude-code threads: 16->9 [mem:7170MB, , net_procs:19, sys:21110MB avail, swap:370MB]
[2026-01-25T21:00:46.431Z] #225 THREAD_CHANGE PID:2177149 worker threads: 13->5 [mem:7169MB, , net_procs:19, sys:21097MB avail, swap:370MB]
[2026-01-25T21:00:48.377Z] #226 ANOMALY  HIGH_THREADS: 295 total threads across all processes [mem:7169MB, , net_procs:19, sys:21099MB avail, swap:370MB]
[2026-01-25T21:00:58.792Z] #227 THREAD_CHANGE PID:2177149 worker threads: 5->13 [mem:7176MB, , net_procs:19, sys:21092MB avail, swap:370MB]
[2026-01-25T21:01:00.068Z] #228 THREAD_CHANGE PID:2356757 claude-code threads: 8->16 [mem:7178MB, , net_procs:19, sys:21090MB avail, swap:370MB]
[2026-01-25T21:01:00.911Z] #229 ANOMALY  HIGH_THREADS: 312 total threads across all processes [mem:7176MB, , net_procs:19, sys:21097MB avail, swap:370MB]
[2026-01-25T21:01:12.583Z] #230 STATE_CHANGE PID:2413534 claude-code S->R [mem:7651MB, , net_procs:19, sys:20358MB avail, swap:370MB]
[2026-01-25T21:01:12.970Z] #231 SPAWN PID:3265860 claude-code 430MB fds=46 thr=35 vsz=72886MB cpu=75.3% state=S  [mem:7652MB, , net_procs:20, sys:20365MB avail, swap:370MB]
[2026-01-25T21:01:13.310Z] #232 ANOMALY  HIGH_COUNT: 14 Claude instances (threshold: 5) [mem:7655MB, , net_procs:20, sys:20387MB avail, swap:370MB]
[2026-01-25T21:01:13.439Z] #233 ANOMALY  ACCUMULATION: net 20 processes (spawns=33 exits=13) [mem:7656MB, , net_procs:20, sys:20394MB avail, swap:370MB]
[2026-01-25T21:01:13.547Z] #234 ANOMALY  HIGH_THREADS: 354 total threads across all processes [mem:7657MB, , net_procs:20, sys:20392MB avail, swap:370MB]
[2026-01-25T21:01:25.544Z] #235 THREAD_CHANGE PID:3265860 claude-code threads: 35->19 [mem:7730MB, , net_procs:20, sys:20489MB avail, swap:370MB]
[2026-01-25T21:01:25.901Z] #236 ANOMALY  HIGH_THREADS: 335 total threads across all processes [mem:7727MB, , net_procs:20, sys:20498MB avail, swap:370MB]
[2026-01-25T21:01:28.569Z] #237 SESSION_END  Benchmark ABORTED by user after 00:18:41 [mem:7729MB, , net_procs:20, sys:20564MB avail, swap:370MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_204247_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_204247_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_204247_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_204247_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_204247_events.jsonl
```

---

_Report generated at 2026-01-25 21:01:28 UTC_
