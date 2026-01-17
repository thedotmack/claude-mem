# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260126_013335` |
| Start Time | 2026-01-26 01:33:35 UTC |
| End Time | 2026-01-26 05:33:45 UTC |
| Duration | 04:00:10 (14410 seconds) |
| Poll Interval | 10s |
| Total Events | 3392 |
| Anomalies | 519 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260126_013335_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260126_013335_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260126_013335_report.md`

---

## Event Summary

```
   1541 THREAD_CHANGE
    906 STATE_CHANGE
    519 ANOMALY
    158 SPAWN
    151 EXIT
     47 PROGRESS
     38 MEM_CHANGE
     19 FD_CHANGE
     11 ORPHAN
      1 SESSION_START
      1 SESSION_END
```

## Peak Values

```json
{
  "peak_total_mem_mb": 13502,
  "peak_swap_mb": 29,
  "min_available_mb": 5212,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

```
2026-01-26T01:33:36.672Z | HIGH_THREADS: 114 total threads across all processes
2026-01-26T03:31:16.735Z | HIGH_THREADS: 165 total threads across all processes
2026-01-26T03:31:28.104Z | HIGH_THREADS: 147 total threads across all processes
2026-01-26T03:31:50.123Z | HIGH_THREADS: 181 total threads across all processes
2026-01-26T03:32:45.556Z | HIGH_THREADS: 148 total threads across all processes
2026-01-26T03:32:56.744Z | HIGH_THREADS: 160 total threads across all processes
2026-01-26T03:33:08.065Z | HIGH_COUNT: 5 Claude instances (threshold: 5)
2026-01-26T03:34:49.154Z | HIGH_THREADS: 146 total threads across all processes
2026-01-26T03:35:00.597Z | HIGH_COUNT: 5 Claude instances (threshold: 5)
2026-01-26T03:35:00.750Z | HIGH_THREADS: 204 total threads across all processes
2026-01-26T03:35:11.989Z | HIGH_THREADS: 192 total threads across all processes
2026-01-26T03:35:45.390Z | HIGH_COUNT: 6 Claude instances (threshold: 5)
2026-01-26T03:35:45.519Z | ACCUMULATION: net 11 processes (spawns=14 exits=3)
2026-01-26T03:35:45.618Z | HIGH_THREADS: 228 total threads across all processes
2026-01-26T03:36:31.031Z | HIGH_THREADS: 195 total threads across all processes
2026-01-26T03:36:53.865Z | HIGH_THREADS: 204 total threads across all processes
2026-01-26T03:37:05.166Z | HIGH_THREADS: 197 total threads across all processes
2026-01-26T03:37:16.622Z | HIGH_THREADS: 205 total threads across all processes
2026-01-26T03:37:28.014Z | HIGH_THREADS: 193 total threads across all processes
2026-01-26T03:38:25.260Z | HIGH_THREADS: 200 total threads across all processes
2026-01-26T03:38:36.465Z | HIGH_THREADS: 198 total threads across all processes
2026-01-26T03:38:47.902Z | HIGH_THREADS: 204 total threads across all processes
2026-01-26T03:38:59.256Z | HIGH_THREADS: 197 total threads across all processes
2026-01-26T03:39:21.882Z | HIGH_THREADS: 203 total threads across all processes
2026-01-26T03:39:33.353Z | HIGH_THREADS: 192 total threads across all processes
2026-01-26T03:40:40.156Z | HIGH_THREADS: 148 total threads across all processes
2026-01-26T03:40:51.387Z | HIGH_THREADS: 156 total threads across all processes
2026-01-26T03:41:25.120Z | HIGH_THREADS: 149 total threads across all processes
2026-01-26T03:41:36.238Z | HIGH_THREADS: 150 total threads across all processes
2026-01-26T03:42:43.172Z | HIGH_THREADS: 149 total threads across all processes
2026-01-26T03:42:54.304Z | HIGH_THREADS: 152 total threads across all processes
2026-01-26T03:43:17.038Z | HIGH_COUNT: 5 Claude instances (threshold: 5)
2026-01-26T03:43:17.166Z | HIGH_THREADS: 207 total threads across all processes
2026-01-26T03:43:28.818Z | HIGH_THREADS: 191 total threads across all processes
2026-01-26T03:44:14.538Z | HIGH_COUNT: 6 Claude instances (threshold: 5)
2026-01-26T03:44:14.679Z | HIGH_THREADS: 248 total threads across all processes
2026-01-26T03:44:49.379Z | HIGH_COUNT: 7 Claude instances (threshold: 5)
2026-01-26T03:45:36.272Z | HIGH_COUNT: 8 Claude instances (threshold: 5)
2026-01-26T03:45:36.399Z | ACCUMULATION: net 15 processes (spawns=20 exits=5)
2026-01-26T03:45:36.527Z | HIGH_THREADS: 296 total threads across all processes
2026-01-26T03:45:48.845Z | HIGH_COUNT: 9 Claude instances (threshold: 5)
2026-01-26T03:46:14.041Z | HIGH_COUNT: 11 Claude instances (threshold: 5)
2026-01-26T03:46:14.222Z | HIGH_THREADS: 344 total threads across all processes
2026-01-26T03:46:27.402Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-26T03:46:27.529Z | HIGH_MEM: 6274MB total (threshold: 6000MB) fds=874 threads=352
2026-01-26T03:46:27.688Z | ACCUMULATION: net 21 processes (spawns=26 exits=5)
2026-01-26T03:46:27.816Z | HIGH_THREADS: 352 total threads across all processes
2026-01-26T03:46:40.436Z | HIGH_THREADS: 333 total threads across all processes
2026-01-26T03:47:20.423Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T03:47:20.569Z | HIGH_THREADS: 374 total threads across all processes
2026-01-26T03:47:34.561Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:48:16.033Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T03:48:29.541Z | HIGH_THREADS: 346 total threads across all processes
2026-01-26T03:48:42.633Z | HIGH_THREADS: 354 total threads across all processes
2026-01-26T03:49:10.142Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:49:24.273Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-26T03:49:37.935Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:49:52.583Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-26T03:50:22.718Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-26T03:50:22.880Z | ACCUMULATION: net 25 processes (spawns=35 exits=10)
2026-01-26T03:50:36.766Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:50:36.937Z | ACCUMULATION: net 23 processes (spawns=35 exits=12)
2026-01-26T03:50:37.116Z | HIGH_THREADS: 340 total threads across all processes
2026-01-26T03:50:51.201Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-26T03:51:19.519Z | HIGH_THREADS: 351 total threads across all processes
2026-01-26T03:52:14.184Z | HIGH_THREADS: 345 total threads across all processes
2026-01-26T03:52:42.116Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-26T03:52:42.300Z | ACCUMULATION: net 25 processes (spawns=37 exits=12)
2026-01-26T03:52:56.007Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-26T03:52:56.210Z | ACCUMULATION: net 24 processes (spawns=37 exits=13)
2026-01-26T03:53:10.767Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-26T03:53:10.971Z | ACCUMULATION: net 25 processes (spawns=38 exits=13)
2026-01-26T03:53:11.133Z | HIGH_THREADS: 418 total threads across all processes
2026-01-26T03:53:25.887Z | HIGH_THREADS: 399 total threads across all processes
2026-01-26T03:53:40.400Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:53:40.564Z | ACCUMULATION: net 23 processes (spawns=38 exits=15)
2026-01-26T03:53:40.701Z | HIGH_THREADS: 343 total threads across all processes
2026-01-26T03:53:54.342Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-26T03:53:54.533Z | ACCUMULATION: net 25 processes (spawns=40 exits=15)
2026-01-26T03:54:08.632Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:54:08.821Z | ACCUMULATION: net 23 processes (spawns=40 exits=17)
2026-01-26T03:55:31.381Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T03:55:45.303Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:55:59.854Z | HIGH_THREADS: 371 total threads across all processes
2026-01-26T03:56:14.362Z | HIGH_THREADS: 338 total threads across all processes
2026-01-26T03:56:29.060Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-26T03:56:29.214Z | HIGH_THREADS: 392 total threads across all processes
2026-01-26T03:56:43.586Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-26T03:56:43.746Z | ACCUMULATION: net 25 processes (spawns=48 exits=23)
2026-01-26T03:57:25.789Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T03:57:25.951Z | ACCUMULATION: net 23 processes (spawns=49 exits=26)
2026-01-26T03:57:38.745Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-26T03:57:38.878Z | HIGH_THREADS: 348 total threads across all processes
2026-01-26T03:57:51.889Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T03:58:32.203Z | HIGH_THREADS: 350 total threads across all processes
2026-01-26T04:00:05.313Z | HIGH_THREADS: 347 total threads across all processes
2026-01-26T04:00:18.597Z | HIGH_THREADS: 355 total threads across all processes
2026-01-26T04:01:37.265Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-26T04:01:49.724Z | HIGH_THREADS: 349 total threads across all processes
2026-01-26T04:02:02.963Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T04:02:03.101Z | HIGH_THREADS: 359 total threads across all processes
2026-01-26T04:02:28.116Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-26T04:02:40.872Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T04:02:54.119Z | HIGH_THREADS: 348 total threads across all processes
2026-01-26T04:03:08.160Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T04:03:08.319Z | HIGH_THREADS: 361 total threads across all processes
2026-01-26T04:03:22.078Z | HIGH_THREADS: 348 total threads across all processes
2026-01-26T04:03:35.304Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T04:04:01.208Z | HIGH_THREADS: 353 total threads across all processes
2026-01-26T04:04:28.282Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T04:04:54.437Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-26T04:05:47.100Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-26T04:06:00.456Z | HIGH_MEM: 8049MB total (threshold: 6000MB) fds=889 threads=374
2026-01-26T04:06:14.185Z | HIGH_MEM: 7920MB total (threshold: 6000MB) fds=892 threads=379
2026-01-26T04:06:41.627Z | HIGH_MEM: 8020MB total (threshold: 6000MB) fds=883 threads=383
2026-01-26T04:07:23.352Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-26T04:07:23.499Z | ACCUMULATION: net 25 processes (spawns=61 exits=36)
2026-01-26T04:07:23.638Z | HIGH_THREADS: 414 total threads across all processes
2026-01-26T04:08:34.850Z | HIGH_THREADS: 397 total threads across all processes
2026-01-26T04:08:49.076Z | HIGH_THREADS: 414 total threads across all processes
2026-01-26T04:09:17.720Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T04:09:32.880Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T04:09:47.609Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T04:10:58.518Z | HIGH_THREADS: 399 total threads across all processes
2026-01-26T04:11:12.648Z | HIGH_THREADS: 405 total threads across all processes
2026-01-26T04:11:27.147Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:14:20.981Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:14:36.533Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:14:52.067Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:14:52.276Z | ACCUMULATION: net 30 processes (spawns=68 exits=38)
2026-01-26T04:14:52.426Z | HIGH_FDS: 1082 total file descriptors across all processes
2026-01-26T04:15:22.997Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:15:23.228Z | ACCUMULATION: net 29 processes (spawns=68 exits=39)
2026-01-26T04:15:38.758Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:15:39.027Z | ACCUMULATION: net 30 processes (spawns=69 exits=39)
2026-01-26T04:15:39.185Z | HIGH_THREADS: 479 total threads across all processes
2026-01-26T04:15:54.380Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:15:54.554Z | ACCUMULATION: net 29 processes (spawns=69 exits=40)
2026-01-26T04:16:10.050Z | HIGH_THREADS: 433 total threads across all processes
2026-01-26T04:16:25.375Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:16:25.569Z | ACCUMULATION: net 30 processes (spawns=70 exits=40)
2026-01-26T04:16:25.753Z | HIGH_THREADS: 491 total threads across all processes
2026-01-26T04:16:56.297Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:16:56.430Z | HIGH_MEM: 10176MB total (threshold: 6000MB) fds=1190 threads=480
2026-01-26T04:18:26.941Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:18:43.151Z | HIGH_MEM: 9971MB total (threshold: 6000MB) fds=1176 threads=469
2026-01-26T04:18:58.255Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:19:28.571Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:19:28.772Z | HIGH_THREADS: 442 total threads across all processes
2026-01-26T04:19:44.131Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:19:44.304Z | ACCUMULATION: net 28 processes (spawns=74 exits=46)
2026-01-26T04:19:44.432Z | HIGH_THREADS: 458 total threads across all processes
2026-01-26T04:19:58.588Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:19:58.815Z | HIGH_THREADS: 442 total threads across all processes
2026-01-26T04:20:14.015Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:20:14.241Z | ACCUMULATION: net 31 processes (spawns=77 exits=46)
2026-01-26T04:20:14.397Z | HIGH_THREADS: 491 total threads across all processes
2026-01-26T04:20:45.961Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:20:46.138Z | HIGH_MEM: 10193MB total (threshold: 6000MB) fds=1246 threads=493
2026-01-26T04:21:13.220Z | SLOW_LEAK: claude-code grew 552MB in 2277s (~14MB/min)
2026-01-26T04:22:05.005Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:22:05.166Z | HIGH_MEM: 9843MB total (threshold: 6000MB) fds=1153 threads=475
2026-01-26T04:22:05.365Z | ACCUMULATION: net 29 processes (spawns=79 exits=50)
2026-01-26T04:22:20.147Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T04:22:20.318Z | HIGH_THREADS: 401 total threads across all processes
2026-01-26T04:23:02.517Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-26T04:24:35.415Z | HIGH_THREADS: 455 total threads across all processes
2026-01-26T04:24:48.502Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T04:25:42.524Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T04:25:42.635Z | HIGH_MEM: 10443MB total (threshold: 6000MB) fds=1217 threads=540
2026-01-26T04:25:42.782Z | HIGH_THREADS: 540 total threads across all processes
2026-01-26T04:25:56.344Z | HIGH_THREADS: 497 total threads across all processes
2026-01-26T04:26:36.843Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T04:26:36.956Z | HIGH_MEM: 9471MB total (threshold: 6000MB) fds=1144 threads=469
2026-01-26T04:26:50.706Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:26:50.810Z | HIGH_MEM: 10538MB total (threshold: 6000MB) fds=1299 threads=550
2026-01-26T04:26:50.960Z | ACCUMULATION: net 30 processes (spawns=86 exits=56)
2026-01-26T04:26:51.098Z | HIGH_THREADS: 550 total threads across all processes
2026-01-26T04:27:05.034Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T04:27:05.178Z | ACCUMULATION: net 29 processes (spawns=86 exits=57)
2026-01-26T04:27:05.294Z | HIGH_THREADS: 502 total threads across all processes
2026-01-26T04:27:19.469Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:27:19.620Z | ACCUMULATION: net 30 processes (spawns=87 exits=57)
2026-01-26T04:27:19.763Z | HIGH_THREADS: 495 total threads across all processes
2026-01-26T04:27:47.014Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T04:27:47.116Z | HIGH_MEM: 9366MB total (threshold: 6000MB) fds=1171 threads=473
2026-01-26T04:27:47.265Z | ACCUMULATION: net 27 processes (spawns=87 exits=60)
2026-01-26T04:28:00.833Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T04:28:00.965Z | HIGH_THREADS: 513 total threads across all processes
2026-01-26T04:28:14.690Z | HIGH_THREADS: 486 total threads across all processes
2026-01-26T04:28:28.282Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:28:28.405Z | HIGH_MEM: 10472MB total (threshold: 6000MB) fds=1326 threads=520
2026-01-26T04:28:28.554Z | ACCUMULATION: net 30 processes (spawns=90 exits=60)
2026-01-26T04:28:28.657Z | HIGH_THREADS: 520 total threads across all processes
2026-01-26T04:29:10.845Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:29:10.986Z | HIGH_THREADS: 489 total threads across all processes
2026-01-26T04:29:25.376Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:29:25.511Z | HIGH_THREADS: 522 total threads across all processes
2026-01-26T04:29:39.543Z | HIGH_THREADS: 482 total threads across all processes
2026-01-26T04:32:22.866Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:32:22.988Z | HIGH_THREADS: 531 total threads across all processes
2026-01-26T04:32:50.828Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:33:04.544Z | HIGH_THREADS: 483 total threads across all processes
2026-01-26T04:33:18.454Z | HIGH_THREADS: 501 total threads across all processes
2026-01-26T04:33:31.962Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:33:32.082Z | HIGH_THREADS: 557 total threads across all processes
2026-01-26T04:33:45.369Z | HIGH_THREADS: 518 total threads across all processes
2026-01-26T04:34:27.332Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:34:27.501Z | HIGH_THREADS: 478 total threads across all processes
2026-01-26T04:34:41.593Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:34:41.716Z | HIGH_THREADS: 516 total threads across all processes
2026-01-26T04:34:55.595Z | HIGH_THREADS: 488 total threads across all processes
2026-01-26T04:35:09.521Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:35:09.701Z | HIGH_THREADS: 511 total threads across all processes
2026-01-26T04:35:23.390Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:35:23.534Z | HIGH_THREADS: 484 total threads across all processes
2026-01-26T04:35:39.197Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:35:39.341Z | HIGH_THREADS: 517 total threads across all processes
2026-01-26T04:35:55.127Z | HIGH_THREADS: 485 total threads across all processes
2026-01-26T04:36:05.451Z | FD_LEAK: worker FDs grew by 53 (mem only +14MB)
2026-01-26T04:36:11.557Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:36:11.719Z | HIGH_THREADS: 569 total threads across all processes
2026-01-26T04:36:26.552Z | HIGH_THREADS: 546 total threads across all processes
2026-01-26T04:37:38.868Z | HIGH_THREADS: 553 total threads across all processes
2026-01-26T04:37:54.638Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:37:54.797Z | HIGH_THREADS: 549 total threads across all processes
2026-01-26T04:38:10.877Z | HIGH_COUNT: 24 Claude instances (threshold: 5)
2026-01-26T04:38:11.080Z | ACCUMULATION: net 35 processes (spawns=99 exits=64)
2026-01-26T04:38:26.762Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:38:26.928Z | ACCUMULATION: net 34 processes (spawns=100 exits=66)
2026-01-26T04:38:43.072Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:38:53.420Z | FD_LEAK: worker FDs grew by 54 (mem only +14MB)
2026-01-26T04:38:59.872Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:39:10.274Z | FD_LEAK: worker FDs grew by 53 (mem only +15MB)
2026-01-26T04:39:16.517Z | HIGH_MEM: 12047MB total (threshold: 6000MB) fds=1345 threads=532
2026-01-26T04:39:32.311Z | HIGH_MEM: 11986MB total (threshold: 6000MB) fds=1341 threads=520
2026-01-26T04:39:47.884Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:39:48.051Z | HIGH_THREADS: 550 total threads across all processes
2026-01-26T04:40:02.819Z | HIGH_MEM: 12102MB total (threshold: 6000MB) fds=1341 threads=569
2026-01-26T04:40:13.173Z | FD_LEAK: worker FDs grew by 57 (mem only +12MB)
2026-01-26T04:40:17.435Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:40:32.966Z | HIGH_COUNT: 24 Claude instances (threshold: 5)
2026-01-26T04:40:33.134Z | ACCUMULATION: net 35 processes (spawns=106 exits=71)
2026-01-26T04:40:49.918Z | HIGH_COUNT: 25 Claude instances (threshold: 5)
2026-01-26T04:40:50.108Z | HIGH_THREADS: 536 total threads across all processes
2026-01-26T04:41:06.263Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:41:06.452Z | ACCUMULATION: net 34 processes (spawns=107 exits=73)
2026-01-26T04:41:06.597Z | HIGH_THREADS: 565 total threads across all processes
2026-01-26T04:41:17.930Z | SLOW_LEAK: claude-code grew 511MB in 3304s (~9MB/min)
2026-01-26T04:41:22.122Z | HIGH_COUNT: 24 Claude instances (threshold: 5)
2026-01-26T04:41:22.290Z | ACCUMULATION: net 35 processes (spawns=108 exits=73)
2026-01-26T04:41:22.418Z | HIGH_THREADS: 541 total threads across all processes
2026-01-26T04:41:33.869Z | SLOW_LEAK: claude-code grew 516MB in 3320s (~9MB/min)
2026-01-26T04:41:37.892Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:41:38.040Z | ACCUMULATION: net 34 processes (spawns=108 exits=74)
2026-01-26T04:41:53.458Z | HIGH_COUNT: 24 Claude instances (threshold: 5)
2026-01-26T04:41:53.614Z | ACCUMULATION: net 35 processes (spawns=110 exits=75)
2026-01-26T04:41:53.746Z | HIGH_THREADS: 565 total threads across all processes
2026-01-26T04:42:40.073Z | HIGH_COUNT: 25 Claude instances (threshold: 5)
2026-01-26T04:42:40.251Z | HIGH_THREADS: 547 total threads across all processes
2026-01-26T04:42:55.647Z | HIGH_COUNT: 24 Claude instances (threshold: 5)
2026-01-26T04:43:11.157Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:43:11.305Z | ACCUMULATION: net 34 processes (spawns=111 exits=77)
2026-01-26T04:43:26.083Z | HIGH_THREADS: 558 total threads across all processes
2026-01-26T04:43:41.833Z | HIGH_COUNT: 25 Claude instances (threshold: 5)
2026-01-26T04:43:42.011Z | ACCUMULATION: net 36 processes (spawns=113 exits=77)
2026-01-26T04:43:42.176Z | HIGH_THREADS: 547 total threads across all processes
2026-01-26T04:43:52.476Z | FD_LEAK: worker FDs grew by 53 (mem only +16MB)
2026-01-26T04:44:08.449Z | FD_LEAK: worker FDs grew by 57 (mem only +17MB)
2026-01-26T04:44:14.802Z | HIGH_THREADS: 564 total threads across all processes
2026-01-26T04:44:29.797Z | HIGH_COUNT: 24 Claude instances (threshold: 5)
2026-01-26T04:45:00.712Z | HIGH_COUNT: 23 Claude instances (threshold: 5)
2026-01-26T04:45:00.888Z | ACCUMULATION: net 34 processes (spawns=115 exits=81)
2026-01-26T04:45:01.061Z | HIGH_THREADS: 544 total threads across all processes
2026-01-26T04:45:26.591Z | FD_LEAK: worker FDs grew by 58 (mem only +11MB)
2026-01-26T04:45:29.256Z | SLOW_LEAK: claude-code grew 557MB in 1516s (~22MB/min)
2026-01-26T04:45:32.335Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:45:32.474Z | HIGH_MEM: 11780MB total (threshold: 6000MB) fds=1271 threads=488
2026-01-26T04:45:32.638Z | HIGH_THREADS: 488 total threads across all processes
2026-01-26T04:45:42.909Z | FD_LEAK: worker FDs grew by 53 (mem only +10MB)
2026-01-26T04:45:44.917Z | SLOW_LEAK: claude-code grew 504MB in 1531s (~19MB/min)
2026-01-26T04:46:42.480Z | SLOW_LEAK: claude-code grew 525MB in 1589s (~19MB/min)
2026-01-26T04:46:57.739Z | SLOW_LEAK: claude-code grew 515MB in 1604s (~19MB/min)
2026-01-26T04:46:58.869Z | SLOW_LEAK: claude-code grew 779MB in 1209s (~38MB/min)
2026-01-26T04:47:00.498Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:47:00.649Z | HIGH_MEM: 12156MB total (threshold: 6000MB) fds=1271 threads=469
2026-01-26T04:47:13.962Z | SLOW_LEAK: claude-code grew 508MB in 1620s (~18MB/min)
2026-01-26T04:47:16.410Z | HIGH_MEM: 11728MB total (threshold: 6000MB) fds=1263 threads=473
2026-01-26T04:47:29.135Z | SLOW_LEAK: claude-code grew 516MB in 1636s (~18MB/min)
2026-01-26T04:47:31.682Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:47:44.167Z | SLOW_LEAK: claude-code grew 519MB in 1651s (~18MB/min)
2026-01-26T04:47:58.399Z | SLOW_LEAK: claude-code grew 532MB in 1665s (~19MB/min)
2026-01-26T04:48:00.329Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:48:15.234Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:48:28.192Z | SLOW_LEAK: claude-code grew 503MB in 1695s (~17MB/min)
2026-01-26T04:49:29.809Z | HIGH_THREADS: 534 total threads across all processes
2026-01-26T04:49:44.201Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:50:13.669Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:50:13.852Z | HIGH_THREADS: 487 total threads across all processes
2026-01-26T04:50:42.434Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:50:42.585Z | ACCUMULATION: net 29 processes (spawns=119 exits=90)
2026-01-26T04:50:42.693Z | HIGH_THREADS: 446 total threads across all processes
2026-01-26T04:51:11.311Z | HIGH_THREADS: 462 total threads across all processes
2026-01-26T04:51:25.839Z | HIGH_THREADS: 421 total threads across all processes
2026-01-26T04:51:40.744Z | HIGH_THREADS: 467 total threads across all processes
2026-01-26T04:51:51.039Z | FD_LEAK: worker FDs grew by 51 (mem only +18MB)
2026-01-26T04:51:55.702Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:51:55.888Z | ACCUMULATION: net 30 processes (spawns=122 exits=92)
2026-01-26T04:52:24.464Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:52:24.618Z | ACCUMULATION: net 29 processes (spawns=122 exits=93)
2026-01-26T04:52:39.466Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:52:39.640Z | ACCUMULATION: net 30 processes (spawns=123 exits=93)
2026-01-26T04:52:39.766Z | HIGH_THREADS: 418 total threads across all processes
2026-01-26T04:52:54.185Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:52:54.339Z | ACCUMULATION: net 29 processes (spawns=123 exits=94)
2026-01-26T04:52:54.468Z | HIGH_THREADS: 460 total threads across all processes
2026-01-26T04:53:09.512Z | HIGH_COUNT: 22 Claude instances (threshold: 5)
2026-01-26T04:53:09.746Z | ACCUMULATION: net 31 processes (spawns=125 exits=94)
2026-01-26T04:53:39.851Z | HIGH_THREADS: 511 total threads across all processes
2026-01-26T04:53:54.955Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:53:55.119Z | HIGH_THREADS: 481 total threads across all processes
2026-01-26T04:54:09.179Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:54:09.360Z | ACCUMULATION: net 28 processes (spawns=126 exits=98)
2026-01-26T04:54:19.643Z | FD_LEAK: worker FDs grew by 53 (mem only +18MB)
2026-01-26T04:54:33.398Z | FD_LEAK: worker FDs grew by 54 (mem only +19MB)
2026-01-26T04:54:47.132Z | FD_LEAK: worker FDs grew by 53 (mem only +19MB)
2026-01-26T04:54:51.201Z | HIGH_THREADS: 421 total threads across all processes
2026-01-26T04:55:06.046Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:55:19.156Z | SLOW_LEAK: claude-code grew 543MB in 1710s (~19MB/min)
2026-01-26T04:55:33.636Z | SLOW_LEAK: claude-code grew 520MB in 1724s (~18MB/min)
2026-01-26T04:55:35.051Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:55:49.595Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T04:56:03.866Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:56:14.313Z | FD_LEAK: worker FDs grew by 52 (mem only +13MB)
2026-01-26T04:56:28.609Z | FD_LEAK: worker FDs grew by 53 (mem only +14MB)
2026-01-26T04:56:44.949Z | SLOW_LEAK: claude-code grew 525MB in 2191s (~14MB/min)
2026-01-26T04:56:46.961Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:56:47.096Z | HIGH_MEM: 9835MB total (threshold: 6000MB) fds=1068 threads=430
2026-01-26T04:57:29.003Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T04:58:34.166Z | SLOW_LEAK: claude-code grew 521MB in 2027s (~15MB/min)
2026-01-26T04:58:35.964Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T04:58:48.251Z | SLOW_LEAK: claude-code grew 503MB in 2041s (~14MB/min)
2026-01-26T04:59:01.770Z | SLOW_LEAK: claude-code grew 513MB in 2328s (~13MB/min)
2026-01-26T04:59:16.248Z | SLOW_LEAK: claude-code grew 508MB in 2343s (~13MB/min)
2026-01-26T04:59:18.895Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T04:59:33.044Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:00:16.318Z | SLOW_LEAK: claude-code grew 528MB in 2403s (~13MB/min)
2026-01-26T05:00:18.596Z | HIGH_MEM: 10001MB total (threshold: 6000MB) fds=1056 threads=426
2026-01-26T05:00:31.086Z | SLOW_LEAK: claude-code grew 515MB in 2418s (~12MB/min)
2026-01-26T05:00:33.107Z | HIGH_MEM: 9892MB total (threshold: 6000MB) fds=1070 threads=427
2026-01-26T05:00:45.846Z | SLOW_LEAK: claude-code grew 511MB in 2432s (~12MB/min)
2026-01-26T05:01:00.670Z | SLOW_LEAK: claude-code grew 515MB in 2447s (~12MB/min)
2026-01-26T05:01:03.315Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:01:03.470Z | HIGH_MEM: 10345MB total (threshold: 6000MB) fds=1114 threads=490
2026-01-26T05:01:03.645Z | HIGH_THREADS: 490 total threads across all processes
2026-01-26T05:01:13.977Z | FD_LEAK: worker FDs grew by 51 (mem only +20MB)
2026-01-26T05:01:18.482Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T05:01:30.803Z | SLOW_LEAK: claude-code grew 505MB in 2477s (~12MB/min)
2026-01-26T05:01:33.687Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:01:46.228Z | SLOW_LEAK: claude-code grew 504MB in 2493s (~12MB/min)
2026-01-26T05:01:48.970Z | HIGH_MEM: 9838MB total (threshold: 6000MB) fds=1061 threads=426
2026-01-26T05:01:49.151Z | HIGH_THREADS: 426 total threads across all processes
2026-01-26T05:02:01.479Z | SLOW_LEAK: claude-code grew 563MB in 2508s (~13MB/min)
2026-01-26T05:02:15.893Z | SLOW_LEAK: claude-code grew 536MB in 2522s (~12MB/min)
2026-01-26T05:02:30.419Z | SLOW_LEAK: claude-code grew 529MB in 2537s (~12MB/min)
2026-01-26T05:02:33.105Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T05:02:33.261Z | HIGH_MEM: 10289MB total (threshold: 6000MB) fds=1117 threads=497
2026-01-26T05:02:33.453Z | HIGH_THREADS: 497 total threads across all processes
2026-01-26T05:02:43.939Z | FD_LEAK: worker FDs grew by 53 (mem only +18MB)
2026-01-26T05:02:46.306Z | SLOW_LEAK: claude-code grew 590MB in 2553s (~13MB/min)
2026-01-26T05:03:01.296Z | SLOW_LEAK: claude-code grew 556MB in 2568s (~12MB/min)
2026-01-26T05:03:16.381Z | SLOW_LEAK: claude-code grew 564MB in 2583s (~13MB/min)
2026-01-26T05:03:30.464Z | SLOW_LEAK: claude-code grew 541MB in 2597s (~12MB/min)
2026-01-26T05:03:44.713Z | SLOW_LEAK: claude-code grew 538MB in 2611s (~12MB/min)
2026-01-26T05:03:59.016Z | SLOW_LEAK: claude-code grew 555MB in 2626s (~12MB/min)
2026-01-26T05:04:01.417Z | HIGH_THREADS: 439 total threads across all processes
2026-01-26T05:04:13.695Z | SLOW_LEAK: claude-code grew 549MB in 2640s (~12MB/min)
2026-01-26T05:04:16.039Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:04:28.321Z | SLOW_LEAK: claude-code grew 558MB in 2655s (~12MB/min)
2026-01-26T05:04:43.076Z | SLOW_LEAK: claude-code grew 548MB in 2670s (~12MB/min)
2026-01-26T05:04:45.710Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T05:04:58.144Z | SLOW_LEAK: claude-code grew 561MB in 2685s (~12MB/min)
2026-01-26T05:05:00.648Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:05:12.918Z | SLOW_LEAK: claude-code grew 558MB in 2699s (~12MB/min)
2026-01-26T05:05:15.581Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T05:05:27.623Z | SLOW_LEAK: claude-code grew 551MB in 2714s (~12MB/min)
2026-01-26T05:05:29.964Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:05:42.294Z | SLOW_LEAK: claude-code grew 562MB in 2729s (~12MB/min)
2026-01-26T05:05:56.113Z | SLOW_LEAK: claude-code grew 571MB in 2743s (~12MB/min)
2026-01-26T05:05:57.926Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:06:09.882Z | SLOW_LEAK: claude-code grew 578MB in 2756s (~12MB/min)
2026-01-26T05:06:23.505Z | SLOW_LEAK: claude-code grew 573MB in 2770s (~12MB/min)
2026-01-26T05:06:25.489Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:06:25.605Z | HIGH_MEM: 9335MB total (threshold: 6000MB) fds=1024 threads=442
2026-01-26T05:06:37.464Z | SLOW_LEAK: claude-code grew 567MB in 2784s (~12MB/min)
2026-01-26T05:06:39.057Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:06:50.472Z | SLOW_LEAK: claude-code grew 602MB in 2797s (~12MB/min)
2026-01-26T05:07:17.824Z | HIGH_THREADS: 396 total threads across all processes
2026-01-26T05:07:31.170Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:07:31.308Z | HIGH_THREADS: 428 total threads across all processes
2026-01-26T05:07:44.663Z | HIGH_THREADS: 399 total threads across all processes
2026-01-26T05:07:54.911Z | FD_LEAK: worker FDs grew by 51 (mem only +20MB)
2026-01-26T05:07:58.251Z | HIGH_THREADS: 416 total threads across all processes
2026-01-26T05:08:11.676Z | HIGH_THREADS: 398 total threads across all processes
2026-01-26T05:08:21.914Z | FD_LEAK: worker FDs grew by 55 (mem only +17MB)
2026-01-26T05:08:23.549Z | SLOW_LEAK: claude-code grew 532MB in 2890s (~11MB/min)
2026-01-26T05:08:25.479Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:08:25.610Z | HIGH_THREADS: 474 total threads across all processes
2026-01-26T05:08:38.575Z | HIGH_THREADS: 447 total threads across all processes
2026-01-26T05:08:49.954Z | SLOW_LEAK: claude-code grew 521MB in 2916s (~10MB/min)
2026-01-26T05:08:51.481Z | HIGH_THREADS: 451 total threads across all processes
2026-01-26T05:09:05.013Z | HIGH_THREADS: 424 total threads across all processes
2026-01-26T05:09:16.585Z | SLOW_LEAK: claude-code grew 517MB in 2943s (~10MB/min)
2026-01-26T05:09:18.297Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:09:18.432Z | HIGH_THREADS: 398 total threads across all processes
2026-01-26T05:09:28.671Z | FD_LEAK: worker FDs grew by 51 (mem only +18MB)
2026-01-26T05:09:31.560Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:09:31.704Z | HIGH_THREADS: 466 total threads across all processes
2026-01-26T05:09:44.556Z | HIGH_THREADS: 431 total threads across all processes
2026-01-26T05:10:20.178Z | FD_LEAK: worker FDs grew by 53 (mem only +19MB)
2026-01-26T05:10:23.227Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:11:15.801Z | HIGH_THREADS: 398 total threads across all processes
2026-01-26T05:11:28.858Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:11:41.947Z | HIGH_THREADS: 402 total threads across all processes
2026-01-26T05:11:54.808Z | HIGH_THREADS: 397 total threads across all processes
2026-01-26T05:12:08.180Z | HIGH_THREADS: 413 total threads across all processes
2026-01-26T05:12:21.396Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T05:12:21.532Z | ACCUMULATION: net 24 processes (spawns=142 exits=118)
2026-01-26T05:12:21.640Z | HIGH_THREADS: 368 total threads across all processes
2026-01-26T05:12:34.724Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:12:34.863Z | ACCUMULATION: net 25 processes (spawns=143 exits=118)
2026-01-26T05:12:48.387Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T05:12:48.549Z | ACCUMULATION: net 24 processes (spawns=143 exits=119)
2026-01-26T05:13:28.042Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:13:28.185Z | ACCUMULATION: net 25 processes (spawns=144 exits=119)
2026-01-26T05:13:40.862Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T05:13:41.000Z | ACCUMULATION: net 24 processes (spawns=144 exits=120)
2026-01-26T05:13:54.316Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:13:54.487Z | ACCUMULATION: net 25 processes (spawns=145 exits=120)
2026-01-26T05:14:34.986Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:14:35.125Z | HIGH_THREADS: 430 total threads across all processes
2026-01-26T05:15:11.056Z | FD_LEAK: worker FDs grew by 51 (mem only +18MB)
2026-01-26T05:15:50.658Z | FD_LEAK: worker FDs grew by 53 (mem only +16MB)
2026-01-26T05:15:53.987Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:16:07.635Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:16:20.836Z | HIGH_THREADS: 393 total threads across all processes
2026-01-26T05:16:34.200Z | HIGH_THREADS: 417 total threads across all processes
2026-01-26T05:16:46.076Z | SLOW_LEAK: claude-code grew 510MB in 3393s (~9MB/min)
2026-01-26T05:16:48.044Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:16:58.346Z | FD_LEAK: worker FDs grew by 57 (mem only +15MB)
2026-01-26T05:17:01.817Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:17:01.970Z | HIGH_THREADS: 453 total threads across all processes
2026-01-26T05:17:15.995Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:17:28.086Z | SLOW_LEAK: claude-code grew 509MB in 3435s (~8MB/min)
2026-01-26T05:17:42.437Z | SLOW_LEAK: claude-code grew 548MB in 3449s (~9MB/min)
2026-01-26T05:17:44.379Z | HIGH_THREADS: 444 total threads across all processes
2026-01-26T05:17:58.012Z | HIGH_THREADS: 462 total threads across all processes
2026-01-26T05:18:09.574Z | SLOW_LEAK: claude-code grew 506MB in 3476s (~8MB/min)
2026-01-26T05:18:10.013Z | SLOW_LEAK: claude-code grew 528MB in 3081s (~10MB/min)
2026-01-26T05:18:22.860Z | SLOW_LEAK: claude-code grew 563MB in 3489s (~9MB/min)
2026-01-26T05:18:23.300Z | SLOW_LEAK: claude-code grew 511MB in 3094s (~9MB/min)
2026-01-26T05:18:36.381Z | SLOW_LEAK: claude-code grew 510MB in 3503s (~8MB/min)
2026-01-26T05:18:36.837Z | SLOW_LEAK: claude-code grew 511MB in 3107s (~9MB/min)
2026-01-26T05:18:38.489Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T05:18:50.321Z | SLOW_LEAK: claude-code grew 522MB in 3517s (~8MB/min)
2026-01-26T05:18:52.143Z | HIGH_THREADS: 449 total threads across all processes
2026-01-26T05:19:03.765Z | SLOW_LEAK: claude-code grew 534MB in 3530s (~9MB/min)
2026-01-26T05:19:06.005Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:19:06.187Z | HIGH_THREADS: 456 total threads across all processes
2026-01-26T05:19:17.867Z | SLOW_LEAK: claude-code grew 516MB in 3544s (~8MB/min)
2026-01-26T05:19:20.291Z | HIGH_COUNT: 21 Claude instances (threshold: 5)
2026-01-26T05:19:32.258Z | SLOW_LEAK: claude-code grew 564MB in 3559s (~9MB/min)
2026-01-26T05:19:32.701Z | SLOW_LEAK: claude-code grew 522MB in 3163s (~9MB/min)
2026-01-26T05:19:34.319Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:19:46.361Z | SLOW_LEAK: claude-code grew 581MB in 3573s (~9MB/min)
2026-01-26T05:19:46.784Z | SLOW_LEAK: claude-code grew 535MB in 3177s (~10MB/min)
2026-01-26T05:19:59.616Z | SLOW_LEAK: claude-code grew 555MB in 3586s (~9MB/min)
2026-01-26T05:20:00.144Z | SLOW_LEAK: claude-code grew 537MB in 3191s (~10MB/min)
2026-01-26T05:20:13.114Z | SLOW_LEAK: claude-code grew 560MB in 3600s (~9MB/min)
2026-01-26T05:20:13.685Z | SLOW_LEAK: claude-code grew 507MB in 3204s (~9MB/min)
2026-01-26T05:20:26.687Z | SLOW_LEAK: claude-code grew 528MB in 3613s (~8MB/min)
2026-01-26T05:20:28.662Z | HIGH_THREADS: 438 total threads across all processes
2026-01-26T05:20:40.487Z | SLOW_LEAK: claude-code grew 550MB in 3627s (~9MB/min)
2026-01-26T05:20:42.162Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:20:54.025Z | SLOW_LEAK: claude-code grew 535MB in 3641s (~8MB/min)
2026-01-26T05:20:56.041Z | HIGH_COUNT: 20 Claude instances (threshold: 5)
2026-01-26T05:21:08.155Z | SLOW_LEAK: claude-code grew 537MB in 3655s (~8MB/min)
2026-01-26T05:21:10.123Z | HIGH_COUNT: 19 Claude instances (threshold: 5)
2026-01-26T05:21:33.668Z | FD_LEAK: worker FDs grew by 53 (mem only +20MB)
2026-01-26T05:21:35.936Z | SLOW_LEAK: claude-code grew 501MB in 3286s (~9MB/min)
2026-01-26T05:21:37.393Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:22:04.099Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T05:22:04.235Z | ACCUMULATION: net 24 processes (spawns=154 exits=130)
2026-01-26T05:22:04.358Z | HIGH_THREADS: 383 total threads across all processes
2026-01-26T05:25:34.475Z | HIGH_COUNT: 18 Claude instances (threshold: 5)
2026-01-26T05:25:34.607Z | ACCUMULATION: net 25 processes (spawns=155 exits=130)
2026-01-26T05:25:34.732Z | HIGH_THREADS: 461 total threads across all processes
2026-01-26T05:25:47.767Z | HIGH_THREADS: 429 total threads across all processes
2026-01-26T05:25:58.012Z | FD_LEAK: worker FDs grew by 51 (mem only +13MB)
2026-01-26T05:26:00.856Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-26T05:26:00.994Z | ACCUMULATION: net 23 processes (spawns=155 exits=132)
2026-01-26T05:26:13.699Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-26T05:26:13.832Z | HIGH_MEM: 7108MB total (threshold: 6000MB) fds=842 threads=388
2026-01-26T05:26:13.971Z | HIGH_THREADS: 388 total threads across all processes
2026-01-26T05:26:36.268Z | FD_LEAK: worker FDs grew by 52 (mem only +14MB)
2026-01-26T05:27:25.927Z | FD_LEAK: worker FDs grew by 53 (mem only +15MB)
2026-01-26T05:27:41.199Z | HIGH_THREADS: 333 total threads across all processes
2026-01-26T05:28:05.620Z | HIGH_THREADS: 351 total threads across all processes
2026-01-26T05:28:55.606Z | HIGH_THREADS: 336 total threads across all processes
2026-01-26T05:29:45.487Z | HIGH_THREADS: 381 total threads across all processes
2026-01-26T05:29:58.403Z | HIGH_THREADS: 335 total threads across all processes
2026-01-26T05:30:11.298Z | HIGH_THREADS: 376 total threads across all processes
2026-01-26T05:30:23.857Z | HIGH_THREADS: 339 total threads across all processes
2026-01-26T05:31:14.472Z | HIGH_THREADS: 377 total threads across all processes
2026-01-26T05:31:27.394Z | HIGH_THREADS: 342 total threads across all processes
2026-01-26T05:31:40.231Z | HIGH_THREADS: 376 total threads across all processes
2026-01-26T05:31:53.392Z | HIGH_THREADS: 335 total threads across all processes
2026-01-26T05:32:18.469Z | HIGH_THREADS: 155 total threads across all processes
2026-01-26T05:32:29.495Z | HIGH_THREADS: 139 total threads across all processes
```

---

## Process Spawns (All)

```
2026-01-26T01:33:35.539Z | PID 17988 | worker 131MB fds=41 thr=5 vsz=72554MB cpu=0.3% state=S 
2026-01-26T01:33:35.770Z | PID 18050 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=17988(bun)
2026-01-26T01:33:35.942Z | PID 20064 | chroma 65MB fds=11 thr=2 vsz=1807MB cpu=0.0% state=S 
2026-01-26T01:33:36.129Z | PID 20106 | chroma 363MB fds=18 thr=67 vsz=5853MB cpu=8.2% state=S 
2026-01-26T01:33:36.302Z | PID 75597 | claude-code 391MB fds=43 thr=16 vsz=73054MB cpu=0.7% state=S 
2026-01-26T01:33:36.477Z | PID 135795 | claude-code 400MB fds=43 thr=17 vsz=73509MB cpu=1.7% state=S 
2026-01-26T03:31:04.966Z | PID 2291961 | claude-code 402MB fds=68 thr=33 vsz=72790MB cpu=149% state=S 
2026-01-26T03:31:16.514Z | PID 2292544 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=1.3% state=S parent=2291961(claude)
2026-01-26T03:31:27.537Z | PID 2293503 | claude-code 426MB fds=47 thr=18 vsz=72818MB cpu=27.3% state=S 
2026-01-26T03:31:49.686Z | PID 2295768 | claude-code 490MB fds=88 thr=34 vsz=72886MB cpu=55.8% state=S 
2026-01-26T03:31:49.896Z | PID 2295819 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=2.2% state=S parent=2295768(claude)
2026-01-26T03:33:07.866Z | PID 2302177 | claude-code 436MB fds=47 thr=18 vsz=72818MB cpu=29.3% state=S 
2026-01-26T03:35:00.375Z | PID 2315204 | claude-code 421MB fds=47 thr=35 vsz=72894MB cpu=31.4% state=S 
2026-01-26T03:35:45.178Z | PID 2320447 | claude-code 424MB fds=47 thr=37 vsz=73030MB cpu=55.8% state=S 
2026-01-26T03:43:16.597Z | PID 2363765 | claude-code 454MB fds=88 thr=34 vsz=72894MB cpu=52.2% state=S 
2026-01-26T03:43:16.813Z | PID 2363820 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=3.9% state=S parent=2363765(claude)
2026-01-26T03:44:14.298Z | PID 2370005 | claude-code 421MB fds=47 thr=38 vsz=73098MB cpu=31.4% state=S 
2026-01-26T03:44:48.875Z | PID 2374600 | claude-code 445MB fds=54 thr=20 vsz=72886MB cpu=24.8% state=S 
2026-01-26T03:44:49.099Z | PID 2375475 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=1.7% state=S parent=2374600(claude)
2026-01-26T03:45:36.006Z | PID 2383117 | claude-code 418MB fds=47 thr=35 vsz=72894MB cpu=32.0% state=S 
2026-01-26T03:45:48.577Z | PID 2386068 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.2% state=S 
2026-01-26T03:46:13.183Z | PID 2390145 | claude-code 525MB fds=91 thr=34 vsz=72950MB cpu=62.3% state=R 
2026-01-26T03:46:13.441Z | PID 2390262 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=2.1% state=S parent=2390145(claude)
2026-01-26T03:46:13.633Z | PID 2391235 | claude-code 416MB fds=46 thr=34 vsz=72826MB cpu=49.6% state=S 
2026-01-26T03:46:26.826Z | PID 2394593 | claude-code 459MB fds=88 thr=37 vsz=73090MB cpu=37.3% state=S 
2026-01-26T03:46:27.065Z | PID 2394917 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=2.4% state=S parent=2394593(claude)
2026-01-26T03:47:20.092Z | PID 2410257 | claude-code 445MB fds=46 thr=20 vsz=72954MB cpu=22.9% state=S 
2026-01-26T03:47:34.126Z | PID 2418589 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:49:09.651Z | PID 2451526 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:49:23.729Z | PID 2457385 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:49:51.680Z | PID 2465509 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:49:51.942Z | PID 2466937 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:50:06.662Z | PID 2470725 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:50:06.945Z | PID 2471436 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:50:22.235Z | PID 2472244 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:50:50.706Z | PID 2482113 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:52:41.572Z | PID 2517318 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:53:10.271Z | PID 2526435 | claude-code 422MB fds=46 thr=34 vsz=72826MB cpu=46.6% state=R 
2026-01-26T03:53:53.628Z | PID 2540873 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:53:53.848Z | PID 2540967 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:54:22.161Z | PID 2550265 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:54:36.127Z | PID 2554552 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:55:44.722Z | PID 2576192 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:55:58.931Z | PID 2581339 | claude-code 450MB fds=89 thr=34 vsz=72854MB cpu=55.7% state=S 
2026-01-26T03:56:13.840Z | PID 2581720 | mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=1.3% state=S parent=2581339(claude)
2026-01-26T03:56:28.074Z | PID 2588849 | claude-code 436MB fds=46 thr=34 vsz=72818MB cpu=25.5% state=S 
2026-01-26T03:56:28.320Z | PID 2588850 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:56:43.023Z | PID 2594405 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:56:57.570Z | PID 2599065 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T03:57:51.476Z | PID 2614224 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:02:02.618Z | PID 2692374 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:02:40.512Z | PID 2701666 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:03:07.648Z | PID 2708066 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:03:21.438Z | PID 2711562 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:04:27.858Z | PID 2728666 | claude-code 435MB fds=46 thr=19 vsz=72930MB cpu=17.0% state=S 
2026-01-26T04:05:46.316Z | PID 2754491 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:05:46.541Z | PID 2754832 | claude-code 432MB fds=46 thr=18 vsz=72859MB cpu=18.1% state=S 
2026-01-26T04:06:13.524Z | PID 2764534 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:06:27.388Z | PID 2767967 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:07:22.622Z | PID 2787088 | claude-code 415MB fds=47 thr=17 vsz=72758MB cpu=22.6% state=S 
2026-01-26T04:07:22.866Z | PID 2788375 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:09:17.128Z | PID 2824677 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:09:32.246Z | PID 2830066 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:11:26.212Z | PID 2863372 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:11:26.531Z | PID 2863997 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:14:20.312Z | PID 2912385 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:14:51.123Z | PID 2921251 | claude-code 494MB fds=101 thr=20 vsz=72818MB cpu=21.7% state=S 
2026-01-26T04:14:51.452Z | PID 2922120 | mcp-server 79MB fds=21 thr=7 vsz=11249MB cpu=0.9% state=S parent=2921251(claude)
2026-01-26T04:15:38.186Z | PID 2938028 | claude-code 452MB fds=47 thr=17 vsz=72790MB cpu=16.7% state=S 
2026-01-26T04:16:24.775Z | PID 2956271 | claude-code 427MB fds=46 thr=33 vsz=72800MB cpu=29.2% state=S 
2026-01-26T04:16:55.682Z | PID 2963140 | claude-code 459MB fds=46 thr=17 vsz=72758MB cpu=15.5% state=S 
2026-01-26T04:18:26.376Z | PID 2998879 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:18:42.344Z | PID 3003970 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:19:27.966Z | PID 3015876 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:19:58.068Z | PID 3026912 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:20:13.036Z | PID 3031265 | claude-code 578MB fds=91 thr=26 vsz=72958MB cpu=50.0% state=S 
2026-01-26T04:20:13.386Z | PID 3031491 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=1.4% state=S parent=3031265(claude)
2026-01-26T04:20:29.029Z | PID 3033138 | claude-code 408MB fds=47 thr=18 vsz=72858MB cpu=18.2% state=S 
2026-01-26T04:20:45.245Z | PID 3041431 | claude-code 444MB fds=46 thr=17 vsz=72750MB cpu=18.2% state=S 
2026-01-26T04:24:34.893Z | PID 3112350 | claude-code 446MB fds=47 thr=18 vsz=72826MB cpu=27.1% state=R 
2026-01-26T04:24:47.907Z | PID 3118452 | claude-code 451MB fds=88 thr=34 vsz=72894MB cpu=66.2% state=S 
2026-01-26T04:24:48.137Z | PID 3118601 | mcp-server 78MB fds=22 thr=7 vsz=11249MB cpu=4.9% state=S parent=3118452(claude)
2026-01-26T04:25:42.179Z | PID 3132873 | claude-code 437MB fds=46 thr=34 vsz=72786MB cpu=36.4% state=S 
2026-01-26T04:26:49.867Z | PID 3151838 | claude-code 538MB fds=88 thr=33 vsz=72989MB cpu=73.5% state=S 
2026-01-26T04:26:50.084Z | PID 3152904 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=1.1% state=S parent=3151838(claude)
2026-01-26T04:26:50.282Z | PID 3154686 | claude-code 420MB fds=47 thr=34 vsz=72858MB cpu=33.2% state=S 
2026-01-26T04:27:19.053Z | PID 3164680 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:28:00.138Z | PID 3176768 | claude-code 497MB fds=88 thr=33 vsz=72886MB cpu=46.2% state=S 
2026-01-26T04:28:00.346Z | PID 3176915 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=1.7% state=S parent=3176768(claude)
2026-01-26T04:28:27.854Z | PID 3184749 | claude-code 457MB fds=47 thr=19 vsz=72894MB cpu=26.7% state=S 
2026-01-26T04:29:10.428Z | PID 3201430 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:32:22.475Z | PID 3263738 | claude-code 456MB fds=49 thr=19 vsz=72894MB cpu=29.5% state=S 
2026-01-26T04:33:31.542Z | PID 3286603 | claude-code 430MB fds=47 thr=34 vsz=72858MB cpu=61.1% state=S 
2026-01-26T04:34:26.826Z | PID 3304195 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:35:09.004Z | PID 3320433 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:35:38.595Z | PID 3329376 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:36:10.932Z | PID 3342206 | claude-code 448MB fds=46 thr=33 vsz=72794MB cpu=27.4% state=S 
2026-01-26T04:37:53.910Z | PID 3385176 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:38:10.121Z | PID 3389879 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:38:25.803Z | PID 3395579 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:38:59.084Z | PID 3408828 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:39:31.549Z | PID 3419548 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:40:01.979Z | PID 3429395 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:40:16.652Z | PID 3431518 | claude-code 444MB fds=46 thr=18 vsz=72826MB cpu=17.7% state=S 
2026-01-26T04:40:16.858Z | PID 3431801 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:40:32.429Z | PID 3440119 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:40:49.206Z | PID 3446265 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:41:21.515Z | PID 3457711 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:41:52.545Z | PID 3466310 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:41:52.769Z | PID 3468489 | claude-code 446MB fds=47 thr=18 vsz=72826MB cpu=18.8% state=S 
2026-01-26T04:42:39.374Z | PID 3484503 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:43:40.851Z | PID 3510714 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:43:41.170Z | PID 3511929 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:43:57.446Z | PID 3512668 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:44:13.969Z | PID 3521505 | claude-code 461MB fds=46 thr=17 vsz=72758MB cpu=23.4% state=S 
2026-01-26T04:46:59.903Z | PID 3583240 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:48:14.616Z | PID 3607195 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:49:43.728Z | PID 3634695 | claude-code 450MB fds=47 thr=17 vsz=72758MB cpu=15.7% state=S 
2026-01-26T04:50:27.710Z | PID 3649854 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:51:25.259Z | PID 3672437 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:51:40.106Z | PID 3677223 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.1% state=S 
2026-01-26T04:51:55.095Z | PID 3681435 | claude-code 431MB fds=47 thr=18 vsz=72826MB cpu=16.5% state=S 
2026-01-26T04:52:38.955Z | PID 3694622 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:53:08.623Z | PID 3704164 | claude-code 427MB fds=46 thr=18 vsz=72858MB cpu=17.4% state=S 
2026-01-26T04:53:08.840Z | PID 3704675 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:53:39.025Z | PID 3714280 | claude-code 421MB fds=47 thr=33 vsz=72750MB cpu=38.8% state=S 
2026-01-26T04:55:05.371Z | PID 3743978 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:55:49.136Z | PID 3757433 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:58:35.427Z | PID 3805909 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T04:59:18.327Z | PID 3819926 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:01:02.688Z | PID 3853507 | claude-code 426MB fds=46 thr=33 vsz=72790MB cpu=32.9% state=S 
2026-01-26T05:01:17.905Z | PID 3859296 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:01:48.237Z | PID 3868450 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:02:32.484Z | PID 3882591 | claude-code 437MB fds=46 thr=33 vsz=72782MB cpu=31.5% state=S 
2026-01-26T05:04:00.653Z | PID 3906650 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:04:45.128Z | PID 3920476 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:05:14.999Z | PID 3931701 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:06:38.637Z | PID 3956994 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:08:25.086Z | PID 3980353 | claude-code 434MB fds=47 thr=34 vsz=72830MB cpu=24.2% state=S 
2026-01-26T05:09:17.652Z | PID 3993476 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.2% state=S 
2026-01-26T05:09:31.211Z | PID 3996512 | claude-code 430MB fds=46 thr=35 vsz=72894MB cpu=47.0% state=S 
2026-01-26T05:11:28.505Z | PID 4024637 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:12:34.369Z | PID 4039226 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:13:27.688Z | PID 4050099 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:13:53.835Z | PID 4054389 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:14:34.614Z | PID 4065205 | claude-code 416MB fds=46 thr=18 vsz=72858MB cpu=24.6% state=S 
2026-01-26T05:16:07.252Z | PID 4093334 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:16:20.330Z | PID 4096422 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:17:01.441Z | PID 4105677 | claude-code 434MB fds=47 thr=18 vsz=72854MB cpu=18.0% state=S 
2026-01-26T05:17:15.470Z | PID 4108301 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:18:38.023Z | PID 4135113 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:19:19.473Z | PID 4146542 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:19:19.691Z | PID 4147053 | claude-code 444MB fds=46 thr=34 vsz=72826MB cpu=31.1% state=S 
2026-01-26T05:20:55.666Z | PID 4175147 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-26T05:25:31.787Z | PID 36981 | claude-code 393MB fds=55 thr=30 vsz=72570MB cpu=148% state=R 
2026-01-26T05:27:01.355Z | PID 52433 | claude-code 433MB fds=47 thr=18 vsz=72858MB cpu=26.4% state=R 
2026-01-26T05:28:16.214Z | PID 66722 | claude-code 423MB fds=47 thr=35 vsz=72886MB cpu=76.7% state=S 
2026-01-26T05:32:16.262Z | PID 111853 | claude-code 428MB fds=47 thr=34 vsz=72818MB cpu=59.6% state=S 
```


---

## Process Exits (All)

```
2026-01-26T03:31:27.665Z | PID 2292544 | mcp-server 78MB fds=21 thr=7 lived 11s 
2026-01-26T03:31:27.905Z | PID 2291961 | claude-code 988MB fds=109 thr=29 lived 23s orphaned MCP:2292544
2026-01-26T03:34:48.917Z | PID 2302177 | claude-code 400MB fds=48 thr=17 lived 101s 
2026-01-26T03:39:44.577Z | PID 2320447 | claude-code 397MB fds=48 thr=19 lived 239s 
2026-01-26T03:39:44.714Z | PID 2315204 | claude-code 394MB fds=48 thr=16 lived 284s 
2026-01-26T03:48:15.597Z | PID 2418589 | claude-code 3MB fds=3 thr=1 lived 41s 
2026-01-26T03:49:37.473Z | PID 2451526 | claude-code 3MB fds=3 thr=1 lived 28s 
2026-01-26T03:49:52.121Z | PID 2457385 | claude-code 3MB fds=3 thr=1 lived 29s 
2026-01-26T03:50:07.150Z | PID 2466937 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T03:50:07.415Z | PID 2386068 | claude-code 3MB fds=3 thr=1 lived 259s 
2026-01-26T03:50:36.175Z | PID 2470725 | claude-code 3MB fds=3 thr=1 lived 30s 
2026-01-26T03:50:36.345Z | PID 2472244 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T03:52:55.475Z | PID 2517318 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T03:53:39.779Z | PID 2410257 | claude-code 439MB fds=46 thr=20 lived 379s 
2026-01-26T03:53:39.958Z | PID 2526435 | claude-code 431MB fds=47 thr=18 lived 29s 
2026-01-26T03:54:07.985Z | PID 2540873 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T03:54:08.144Z | PID 2540967 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T03:54:22.309Z | PID 2465509 | claude-code 3MB fds=3 thr=1 lived 271s 
2026-01-26T03:54:36.311Z | PID 2550265 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T03:55:30.969Z | PID 2554552 | claude-code 3MB fds=3 thr=1 lived 54s 
2026-01-26T03:55:59.215Z | PID 2394593 | claude-code 601MB fds=58 thr=20 lived 573s orphaned MCP:2394917
2026-01-26T03:55:59.370Z | PID 2394917 | mcp-server 67MB fds=21 thr=7 lived 572s 
2026-01-26T03:56:28.537Z | PID 2576192 | claude-code 3MB fds=3 thr=1 lived 44s 
2026-01-26T03:56:57.732Z | PID 2594405 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T03:57:25.207Z | PID 2588850 | claude-code 3MB fds=3 thr=1 lived 57s 
2026-01-26T03:57:25.338Z | PID 2471436 | claude-code 3MB fds=3 thr=1 lived 439s 
2026-01-26T03:57:38.259Z | PID 2599065 | claude-code 3MB fds=3 thr=1 lived 41s 
2026-01-26T03:57:38.438Z | PID 2482113 | claude-code 3MB fds=3 thr=1 lived 408s 
2026-01-26T04:01:36.934Z | PID 2614224 | claude-code 3MB fds=3 thr=1 lived 225s 
2026-01-26T04:02:27.776Z | PID 2692374 | claude-code 3MB fds=3 thr=1 lived 25s 
2026-01-26T04:03:21.619Z | PID 2708066 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T04:03:34.930Z | PID 2711562 | claude-code 3MB fds=3 thr=1 lived 13s 
2026-01-26T04:04:54.039Z | PID 2701666 | claude-code 3MB fds=3 thr=1 lived 134s 
2026-01-26T04:05:46.695Z | PID 2383117 | claude-code 423MB fds=46 thr=19 lived 1210s 
2026-01-26T04:06:13.686Z | PID 2754491 | claude-code 3MB fds=3 thr=1 lived 27s 
2026-01-26T04:06:27.549Z | PID 2764534 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T04:09:47.099Z | PID 2830066 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T04:14:35.925Z | PID 2767967 | claude-code 3MB fds=3 thr=1 lived 488s 
2026-01-26T04:15:22.421Z | PID 2788375 | claude-code 3MB fds=3 thr=1 lived 480s 
2026-01-26T04:15:53.791Z | PID 2588849 | claude-code 500MB fds=46 thr=18 lived 1165s 
2026-01-26T04:18:42.549Z | PID 2912385 | claude-code 3MB fds=3 thr=1 lived 262s 
2026-01-26T04:18:57.668Z | PID 3003970 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T04:19:42.970Z | PID 2375475 | mcp-server 66MB fds=21 thr=7 lived 2093s 
2026-01-26T04:19:43.142Z | PID 3015876 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T04:19:43.316Z | PID 2998879 | claude-code 3MB fds=3 thr=1 lived 77s 
2026-01-26T04:19:43.596Z | PID 2374600 | claude-code 806MB fds=53 thr=20 lived 2095s orphaned MCP:2375475
2026-01-26T04:20:29.213Z | PID 2938028 | claude-code 408MB fds=48 thr=16 lived 291s 
2026-01-26T04:22:04.064Z | PID 2824677 | claude-code 3MB fds=3 thr=1 lived 767s 
2026-01-26T04:22:04.243Z | PID 2863997 | claude-code 3MB fds=3 thr=1 lived 638s 
2026-01-26T04:22:04.409Z | PID 3041431 | claude-code 388MB fds=47 thr=17 lived 79s 
2026-01-26T04:22:19.473Z | PID 2370005 | claude-code 442MB fds=46 thr=21 lived 2285s 
2026-01-26T04:22:19.601Z | PID 2963140 | claude-code 420MB fds=46 thr=16 lived 324s 
2026-01-26T04:23:02.050Z | PID 2863372 | claude-code 3MB fds=3 thr=1 lived 696s 
2026-01-26T04:24:35.028Z | PID 3026912 | claude-code 3MB fds=3 thr=1 lived 277s 
2026-01-26T04:26:36.291Z | PID 2363820 | other 0MB fds=0 thr=1 lived 2600s 
2026-01-26T04:26:36.505Z | PID 2363765 | claude-code 882MB fds=68 thr=23 lived 2600s orphaned MCP:2363820
2026-01-26T04:27:04.664Z | PID 3112350 | claude-code 413MB fds=48 thr=18 lived 150s 
2026-01-26T04:27:46.372Z | PID 2581339 | claude-code 785MB fds=57 thr=29 lived 1908s orphaned MCP:2581720
2026-01-26T04:27:46.502Z | PID 2581720 | mcp-server 67MB fds=21 thr=7 lived 1893s 
2026-01-26T04:27:46.629Z | PID 3164680 | claude-code 3MB fds=3 thr=1 lived 27s 
2026-01-26T04:29:24.967Z | PID 3201430 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T04:32:50.452Z | PID 3263738 | claude-code 411MB fds=50 thr=19 lived 28s 
2026-01-26T04:34:41.181Z | PID 3304195 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T04:35:22.964Z | PID 3320433 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T04:38:26.012Z | PID 3385176 | claude-code 3MB fds=3 thr=1 lived 33s 
2026-01-26T04:38:26.171Z | PID 3389879 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T04:38:42.484Z | PID 3395579 | claude-code 3MB fds=3 thr=1 lived 17s 
2026-01-26T04:39:31.709Z | PID 3408828 | claude-code 3MB fds=3 thr=1 lived 32s 
2026-01-26T04:39:47.292Z | PID 3419548 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T04:40:02.147Z | PID 3329376 | claude-code 3MB fds=3 thr=1 lived 264s 
2026-01-26T04:40:17.011Z | PID 3429395 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T04:41:05.454Z | PID 3431801 | claude-code 3MB fds=3 thr=1 lived 49s 
2026-01-26T04:41:05.641Z | PID 3446265 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T04:41:37.304Z | PID 3431518 | claude-code 434MB fds=47 thr=18 lived 81s 
2026-01-26T04:41:52.922Z | PID 3457711 | claude-code 3MB fds=3 thr=1 lived 31s 
2026-01-26T04:42:55.051Z | PID 3484503 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T04:43:10.607Z | PID 3466310 | claude-code 3MB fds=3 thr=1 lived 78s 
2026-01-26T04:43:57.633Z | PID 3184749 | claude-code 426MB fds=46 thr=18 lived 930s 
2026-01-26T04:44:14.138Z | PID 3510714 | claude-code 3MB fds=3 thr=1 lived 34s 
2026-01-26T04:44:29.253Z | PID 3512668 | claude-code 3MB fds=3 thr=1 lived 32s 
2026-01-26T04:45:00.133Z | PID 3440119 | claude-code 3MB fds=3 thr=1 lived 268s 
2026-01-26T04:45:31.278Z | PID 3176915 | mcp-server 67MB fds=21 thr=7 lived 1051s 
2026-01-26T04:45:31.579Z | PID 3176768 | claude-code 748MB fds=61 thr=20 lived 1051s orphaned MCP:3176915
2026-01-26T04:45:31.731Z | PID 3521505 | claude-code 417MB fds=47 thr=17 lived 78s 
2026-01-26T04:47:31.157Z | PID 3583240 | claude-code 3MB fds=3 thr=1 lived 32s 
2026-01-26T04:47:59.811Z | PID 3468489 | claude-code 430MB fds=46 thr=17 lived 367s 
2026-01-26T04:50:12.966Z | PID 2390145 | claude-code 975MB fds=58 thr=20 lived 3839s orphaned MCP:2390262
2026-01-26T04:50:13.121Z | PID 2390262 | mcp-server 67MB fds=21 thr=7 lived 3840s 
2026-01-26T04:50:27.856Z | PID 3634695 | claude-code 413MB fds=47 thr=16 lived 44s 
2026-01-26T04:50:41.983Z | PID 3649854 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T04:51:25.387Z | PID 3607195 | claude-code 3MB fds=3 thr=1 lived 191s 
2026-01-26T04:51:40.264Z | PID 3672437 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T04:52:23.957Z | PID 3681435 | claude-code 436MB fds=48 thr=18 lived 28s 
2026-01-26T04:52:53.729Z | PID 3694622 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T04:53:39.207Z | PID 3704164 | claude-code 407MB fds=47 thr=18 lived 31s 
2026-01-26T04:53:54.327Z | PID 3677223 | claude-code 3MB fds=3 thr=1 lived 134s 
2026-01-26T04:54:08.370Z | PID 2295819 | mcp-server 67MB fds=21 thr=7 lived 4939s 
2026-01-26T04:54:08.674Z | PID 2295768 | claude-code 555MB fds=53 thr=16 lived 4939s orphaned MCP:2295819
2026-01-26T04:55:34.505Z | PID 3743978 | claude-code 3MB fds=3 thr=1 lived 29s 
2026-01-26T04:56:03.370Z | PID 3757433 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T04:56:46.457Z | PID 3714280 | claude-code 411MB fds=48 thr=16 lived 187s 
2026-01-26T04:57:28.622Z | PID 3704675 | claude-code 3MB fds=3 thr=1 lived 260s 
2026-01-26T04:59:32.539Z | PID 3819926 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T05:01:33.118Z | PID 3859296 | claude-code 3MB fds=3 thr=1 lived 16s 
2026-01-26T05:01:48.405Z | PID 3853507 | claude-code 423MB fds=47 thr=15 lived 46s 
2026-01-26T05:04:00.797Z | PID 3805909 | claude-code 3MB fds=3 thr=1 lived 325s 
2026-01-26T05:04:15.462Z | PID 3906650 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T05:05:00.086Z | PID 3920476 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T05:05:29.425Z | PID 3931701 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-26T05:05:57.547Z | PID 3868450 | claude-code 3MB fds=3 thr=1 lived 249s 
2026-01-26T05:06:24.882Z | PID 3118601 | mcp-server 67MB fds=21 thr=7 lived 2496s 
2026-01-26T05:06:25.126Z | PID 3118452 | claude-code 828MB fds=58 thr=17 lived 2498s orphaned MCP:3118601
2026-01-26T05:07:30.804Z | PID 3956994 | claude-code 3MB fds=3 thr=1 lived 52s 
2026-01-26T05:09:17.799Z | PID 3132873 | claude-code 409MB fds=45 thr=17 lived 2615s 
2026-01-26T05:09:17.936Z | PID 3882591 | claude-code 389MB fds=43 thr=9 lived 405s 
2026-01-26T05:10:22.816Z | PID 3993476 | claude-code 3MB fds=3 thr=1 lived 65s 
2026-01-26T05:12:20.909Z | PID 4024637 | claude-code 3MB fds=3 thr=1 lived 52s 
2026-01-26T05:12:21.043Z | PID 3996512 | claude-code 404MB fds=47 thr=19 lived 170s 
2026-01-26T05:12:48.034Z | PID 4039226 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T05:13:40.525Z | PID 4050099 | claude-code 3MB fds=3 thr=1 lived 13s 
2026-01-26T05:15:53.657Z | PID 4054389 | claude-code 3MB fds=3 thr=1 lived 120s 
2026-01-26T05:16:20.464Z | PID 4093334 | claude-code 3MB fds=3 thr=1 lived 13s 
2026-01-26T05:16:47.635Z | PID 4096422 | claude-code 3MB fds=3 thr=1 lived 27s 
2026-01-26T05:19:05.568Z | PID 4135113 | claude-code 3MB fds=3 thr=1 lived 27s 
2026-01-26T05:19:19.841Z | PID 4065205 | claude-code 406MB fds=47 thr=18 lived 285s 
2026-01-26T05:19:33.867Z | PID 4146542 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T05:20:41.801Z | PID 4108301 | claude-code 3MB fds=3 thr=1 lived 206s 
2026-01-26T05:21:09.775Z | PID 4175147 | claude-code 3MB fds=3 thr=1 lived 14s 
2026-01-26T05:21:37.005Z | PID 4147053 | claude-code 401MB fds=47 thr=17 lived 137s 
2026-01-26T05:22:03.705Z | PID 3154686 | claude-code 427MB fds=46 thr=20 lived 3313s 
2026-01-26T05:26:00.377Z | PID 3031265 | claude-code 1014MB fds=59 thr=19 lived 3947s orphaned MCP:3031491
2026-01-26T05:26:00.508Z | PID 3031491 | mcp-server 67MB fds=21 thr=7 lived 3947s 
2026-01-26T05:26:13.049Z | PID 3151838 | claude-code 937MB fds=60 thr=19 lived 3563s orphaned MCP:3152904
2026-01-26T05:26:13.206Z | PID 3152904 | mcp-server 67MB fds=21 thr=7 lived 3563s 
2026-01-26T05:26:13.363Z | PID 3511929 | claude-code 3MB fds=3 thr=1 lived 2552s 
2026-01-26T05:27:03.108Z | PID 36981 | claude-code 431MB fds=48 thr=18 lived 92s 
2026-01-26T05:28:18.252Z | PID 52433 | claude-code 415MB fds=48 thr=16 lived 77s 
2026-01-26T05:32:16.670Z | PID 2956271 | claude-code 397MB fds=43 thr=16 lived 4552s 
2026-01-26T05:32:16.783Z | PID 135795 | claude-code 402MB fds=43 thr=17 lived 14320s 
2026-01-26T05:32:16.939Z | PID 2754832 | claude-code 406MB fds=43 thr=27 lived 5190s 
2026-01-26T05:32:17.065Z | PID 3342206 | claude-code 400MB fds=43 thr=16 lived 3367s 
2026-01-26T05:32:17.189Z | PID 3286603 | claude-code 404MB fds=43 thr=18 lived 3526s 
2026-01-26T05:32:17.320Z | PID 4105677 | claude-code 398MB fds=43 thr=15 lived 916s 
2026-01-26T05:32:17.449Z | PID 2728666 | claude-code 404MB fds=43 thr=9 lived 5270s 
2026-01-26T05:32:17.563Z | PID 3033138 | claude-code 406MB fds=43 thr=20 lived 4308s 
2026-01-26T05:32:17.675Z | PID 66722 | claude-code 420MB fds=48 thr=17 lived 241s 
2026-01-26T05:32:17.802Z | PID 3980353 | claude-code 399MB fds=43 thr=8 lived 1432s 
2026-01-26T05:32:17.927Z | PID 2787088 | claude-code 395MB fds=43 thr=8 lived 5095s 
2026-01-26T05:32:18.053Z | PID 2293503 | claude-code 388MB fds=43 thr=8 lived 7251s 
2026-01-26T05:32:18.165Z | PID 75597 | claude-code 392MB fds=43 thr=16 lived 14322s 
2026-01-26T05:32:18.278Z | PID 2391235 | claude-code 413MB fds=43 thr=18 lived 6365s 
```


---

## Orphan Events

```
2026-01-26T03:31:27.789Z | PID 2292544 | mcp-server orphaned by death of 2291961
2026-01-26T03:55:59.089Z | PID 2394917 | mcp-server orphaned by death of 2394593
2026-01-26T04:19:43.463Z | PID 2375475 | mcp-server orphaned by death of 2374600
2026-01-26T04:26:36.402Z | PID 2363820 | mcp-server orphaned by death of 2363765
2026-01-26T04:27:46.256Z | PID 2581720 | mcp-server orphaned by death of 2581339
2026-01-26T04:45:31.449Z | PID 3176915 | mcp-server orphaned by death of 3176768
2026-01-26T04:50:12.842Z | PID 2390262 | mcp-server orphaned by death of 2390145
2026-01-26T04:54:08.516Z | PID 2295819 | mcp-server orphaned by death of 2295768
2026-01-26T05:06:25.005Z | PID 3118601 | mcp-server orphaned by death of 3118452
2026-01-26T05:26:00.268Z | PID 3031491 | mcp-server orphaned by death of 3031265
2026-01-26T05:26:12.944Z | PID 3152904 | mcp-server orphaned by death of 3151838
```

---

## Memory Changes (>100MB)

```
2026-01-26T03:31:16.194Z | PID 2291961 | claude-code 402MB->988MB (5586MB) fds=109 thr=29
2026-01-26T03:46:52.062Z | PID 2374600 | claude-code 690MB->554MB (-136MB) fds=55 thr=20
2026-01-26T03:47:47.996Z | PID 2410257 | claude-code 504MB->397MB (-107MB) fds=47 thr=19
2026-01-26T03:50:03.405Z | PID 20106 | chroma 392MB->508MB (1116MB) fds=23 thr=87
2026-01-26T03:50:18.651Z | PID 20106 | chroma 508MB->393MB (-115MB) fds=23 thr=72
2026-01-26T03:54:19.572Z | PID 20106 | chroma 391MB->493MB (1102MB) fds=23 thr=87
2026-01-26T03:54:33.450Z | PID 20106 | chroma 493MB->392MB (-101MB) fds=23 thr=72
2026-01-26T03:55:56.195Z | PID 20106 | chroma 393MB->502MB (1109MB) fds=23 thr=87
2026-01-26T03:56:10.671Z | PID 20106 | chroma 502MB->392MB (-110MB) fds=23 thr=72
2026-01-26T03:56:27.500Z | PID 2581339 | claude-code 454MB->561MB (1107MB) fds=88 thr=33
2026-01-26T04:04:11.938Z | PID 20106 | chroma 406MB->533MB (1127MB) fds=22 thr=86
2026-01-26T04:04:25.405Z | PID 20106 | chroma 533MB->406MB (-127MB) fds=22 thr=71
2026-01-26T04:15:49.963Z | PID 20106 | chroma 420MB->544MB (1124MB) fds=23 thr=87
2026-01-26T04:16:05.431Z | PID 20106 | chroma 544MB->422MB (-122MB) fds=23 thr=72
2026-01-26T04:18:22.556Z | PID 20106 | chroma 425MB->553MB (1128MB) fds=22 thr=86
2026-01-26T04:18:37.818Z | PID 20106 | chroma 553MB->423MB (-130MB) fds=22 thr=71
2026-01-26T04:21:12.993Z | PID 2363765 | claude-code 899MB->1006MB (1107MB) fds=62 thr=23
2026-01-26T04:25:41.798Z | PID 3118452 | claude-code 430MB->550MB (1120MB) fds=88 thr=34
2026-01-26T04:27:57.950Z | PID 20106 | chroma 424MB->527MB (1103MB) fds=22 thr=86
2026-01-26T04:28:11.536Z | PID 20106 | chroma 527MB->424MB (-103MB) fds=22 thr=71
2026-01-26T04:28:27.464Z | PID 3176768 | claude-code 489MB->598MB (1109MB) fds=88 thr=33
2026-01-26T04:33:03.318Z | PID 3118452 | claude-code 640MB->745MB (1105MB) fds=57 thr=19
2026-01-26T04:33:16.955Z | PID 3118452 | claude-code 745MB->641MB (-104MB) fds=57 thr=18
2026-01-26T04:35:34.680Z | PID 20106 | chroma 441MB->567MB (1126MB) fds=21 thr=85
2026-01-26T04:35:50.307Z | PID 20106 | chroma 567MB->440MB (-127MB) fds=22 thr=71
2026-01-26T04:44:44.792Z | PID 3521505 | claude-code 519MB->404MB (-115MB) fds=47 thr=17
2026-01-26T04:45:29.110Z | PID 3031265 | claude-code 1027MB->1135MB (1108MB) fds=57 thr=22
2026-01-26T04:46:58.729Z | PID 3151838 | claude-code 862MB->1317MB (4455MB) fds=61 thr=20
2026-01-26T04:47:15.023Z | PID 3151838 | claude-code 1317MB->851MB (-466MB) fds=61 thr=20
2026-01-26T04:54:22.778Z | PID 3714280 | claude-code 532MB->427MB (-105MB) fds=48 thr=16
2026-01-26T04:55:19.009Z | PID 3151838 | claude-code 937MB->1081MB (1144MB) fds=65 thr=20
2026-01-26T04:55:48.032Z | PID 3151838 | claude-code 1058MB->937MB (-121MB) fds=65 thr=20
2026-01-26T05:02:44.545Z | PID 20106 | chroma 455MB->576MB (1121MB) fds=22 thr=86
2026-01-26T05:02:59.563Z | PID 20106 | chroma 576MB->467MB (-109MB) fds=23 thr=86
2026-01-26T05:04:27.764Z | PID 2921251 | claude-code 717MB->592MB (-125MB) fds=72 thr=20
2026-01-26T05:07:03.380Z | PID 3031265 | claude-code 1180MB->1057MB (-123MB) fds=57 thr=22
2026-01-26T05:17:40.735Z | PID 20106 | chroma 458MB->591MB (1133MB) fds=22 thr=86
2026-01-26T05:17:55.020Z | PID 20106 | chroma 591MB->469MB (-122MB) fds=22 thr=71
```

---

## State Changes

```
2026-01-26T02:08:08.215Z | PID 135795 | claude-code S->R
2026-01-26T02:08:19.106Z | PID 135795 | claude-code R->S
2026-01-26T03:15:04.599Z | PID 75597 | claude-code S->R
2026-01-26T03:15:15.478Z | PID 75597 | claude-code R->S
2026-01-26T03:23:32.308Z | PID 135795 | claude-code S->R
2026-01-26T03:23:43.060Z | PID 135795 | claude-code R->S
2026-01-26T03:31:16.065Z | PID 2291961 | claude-code S->D
2026-01-26T03:32:01.069Z | PID 2295768 | claude-code S->R
2026-01-26T03:32:12.220Z | PID 2295768 | claude-code R->S
2026-01-26T03:32:56.460Z | PID 2295768 | claude-code S->R
2026-01-26T03:33:18.917Z | PID 2295768 | claude-code R->S
2026-01-26T03:33:30.132Z | PID 2295768 | claude-code S->R
2026-01-26T03:33:52.432Z | PID 2295768 | claude-code R->S
2026-01-26T03:34:15.117Z | PID 2302177 | claude-code S->R
2026-01-26T03:34:26.328Z | PID 2302177 | claude-code R->S
2026-01-26T03:35:33.790Z | PID 2295768 | claude-code S->R
2026-01-26T03:36:07.707Z | PID 2295768 | claude-code R->S
2026-01-26T03:36:08.084Z | PID 2320447 | claude-code S->R
2026-01-26T03:36:19.100Z | PID 2295768 | claude-code S->R
2026-01-26T03:36:19.535Z | PID 2320447 | claude-code R->S
2026-01-26T03:36:53.334Z | PID 2295768 | claude-code R->S
2026-01-26T03:37:50.307Z | PID 2295768 | claude-code S->R
2026-01-26T03:38:01.693Z | PID 2295768 | claude-code R->S
2026-01-26T03:38:24.485Z | PID 2295768 | claude-code S->R
2026-01-26T03:38:47.363Z | PID 2295768 | claude-code R->S
2026-01-26T03:43:28.370Z | PID 2363765 | claude-code S->R
2026-01-26T03:43:39.915Z | PID 2363765 | claude-code R->S
2026-01-26T03:44:48.511Z | PID 2363765 | claude-code S->R
2026-01-26T03:45:12.217Z | PID 2363765 | claude-code R->S
2026-01-26T03:45:47.652Z | PID 2363765 | claude-code S->R
2026-01-26T03:46:12.288Z | PID 2363765 | claude-code R->S
2026-01-26T03:46:25.307Z | PID 2363765 | claude-code S->R
2026-01-26T03:46:25.719Z | PID 2374600 | claude-code S->R
2026-01-26T03:46:26.517Z | PID 2391235 | claude-code S->R
2026-01-26T03:46:39.230Z | PID 2374600 | claude-code R->S
2026-01-26T03:46:51.947Z | PID 2374600 | claude-code S->R
2026-01-26T03:46:52.854Z | PID 2391235 | claude-code R->S
2026-01-26T03:47:05.089Z | PID 2370005 | claude-code S->R
2026-01-26T03:47:06.163Z | PID 2391235 | claude-code S->R
2026-01-26T03:47:18.509Z | PID 2370005 | claude-code R->S
2026-01-26T03:47:19.195Z | PID 2390145 | claude-code R->S
2026-01-26T03:47:19.511Z | PID 2391235 | claude-code R->S
2026-01-26T03:47:19.702Z | PID 2394593 | claude-code S->D
2026-01-26T03:47:30.883Z | PID 17988 | worker S->R
2026-01-26T03:47:31.406Z | PID 20106 | chroma S->R
2026-01-26T03:47:33.173Z | PID 2390145 | claude-code S->R
2026-01-26T03:47:33.567Z | PID 2394593 | claude-code D->R
2026-01-26T03:47:44.904Z | PID 17988 | worker R->S
2026-01-26T03:47:45.360Z | PID 20106 | chroma R->S
2026-01-26T03:47:47.230Z | PID 2390145 | claude-code R->S
2026-01-26T03:47:47.641Z | PID 2394593 | claude-code R->S
2026-01-26T03:47:59.104Z | PID 75597 | claude-code S->R
2026-01-26T03:48:00.173Z | PID 2374600 | claude-code R->S
2026-01-26T03:48:00.770Z | PID 2390145 | claude-code S->D
2026-01-26T03:48:01.298Z | PID 2394593 | claude-code S->R
2026-01-26T03:48:12.697Z | PID 75597 | claude-code R->S
2026-01-26T03:48:13.269Z | PID 2295768 | claude-code S->R
2026-01-26T03:48:14.146Z | PID 2374600 | claude-code S->R
2026-01-26T03:48:14.445Z | PID 2383117 | claude-code S->R
2026-01-26T03:48:14.738Z | PID 2390145 | claude-code D->R
2026-01-26T03:48:15.203Z | PID 2394593 | claude-code R->S
2026-01-26T03:48:27.233Z | PID 2295768 | claude-code R->S
2026-01-26T03:48:28.242Z | PID 2383117 | claude-code R->S
2026-01-26T03:48:28.971Z | PID 2394593 | claude-code S->R
2026-01-26T03:48:41.627Z | PID 2390145 | claude-code R->S
2026-01-26T03:48:42.037Z | PID 2394593 | claude-code R->S
2026-01-26T03:48:53.183Z | PID 20106 | chroma S->R
2026-01-26T03:48:54.338Z | PID 2370005 | claude-code S->R
2026-01-26T03:48:54.963Z | PID 2390145 | claude-code S->R
2026-01-26T03:48:55.422Z | PID 2394593 | claude-code S->R
2026-01-26T03:49:06.622Z | PID 20106 | chroma R->S
2026-01-26T03:49:07.893Z | PID 2370005 | claude-code R->S
2026-01-26T03:49:08.790Z | PID 2390145 | claude-code R->S
2026-01-26T03:49:21.658Z | PID 2363765 | claude-code R->S
2026-01-26T03:49:22.688Z | PID 2390145 | claude-code S->R
2026-01-26T03:49:23.146Z | PID 2394593 | claude-code R->S
2026-01-26T03:49:35.450Z | PID 2363765 | claude-code S->R
2026-01-26T03:49:35.860Z | PID 2374600 | claude-code R->S
2026-01-26T03:49:36.179Z | PID 2383117 | claude-code S->R
2026-01-26T03:49:36.505Z | PID 2390145 | claude-code R->S
2026-01-26T03:49:36.872Z | PID 2391235 | claude-code S->R
2026-01-26T03:49:49.905Z | PID 2374600 | claude-code S->R
2026-01-26T03:49:50.485Z | PID 2390145 | claude-code S->R
2026-01-26T03:49:50.941Z | PID 2391235 | claude-code R->S
2026-01-26T03:49:51.193Z | PID 2394593 | claude-code S->R
2026-01-26T03:50:03.268Z | PID 20106 | chroma S->R
2026-01-26T03:50:04.560Z | PID 2363765 | claude-code R->S
2026-01-26T03:50:05.343Z | PID 2383117 | claude-code R->S
2026-01-26T03:50:05.984Z | PID 2394593 | claude-code R->S
2026-01-26T03:50:18.500Z | PID 20106 | chroma R->S
2026-01-26T03:50:19.958Z | PID 2363765 | claude-code S->R
2026-01-26T03:50:20.496Z | PID 2374600 | claude-code R->S
2026-01-26T03:50:34.863Z | PID 2374600 | claude-code S->R
2026-01-26T03:50:48.567Z | PID 2363765 | claude-code R->S
2026-01-26T03:50:49.865Z | PID 2394593 | claude-code S->R
2026-01-26T03:51:03.104Z | PID 2363765 | claude-code S->R
2026-01-26T03:51:04.000Z | PID 2390145 | claude-code R->S
2026-01-26T03:51:17.790Z | PID 2390145 | claude-code S->R
2026-01-26T03:51:18.321Z | PID 2394593 | claude-code R->S
2026-01-26T03:51:32.008Z | PID 2394593 | claude-code S->R
```

---

## Memory Trajectory (sampled every 10 events)

```
2026-01-26T01:33:36.672Z | total:1420MB | swap:0MB | avail:26340MB | 
2026-01-26T01:33:57.609Z | total:1420MB | swap:0MB | avail:26343MB | 
2026-01-26T01:37:31.839Z | total:1422MB | swap:0MB | avail:26336MB | 
2026-01-26T01:40:45.035Z | total:1422MB | swap:0MB | avail:26337MB | 
2026-01-26T01:43:15.530Z | total:1422MB | swap:0MB | avail:26328MB | 
2026-01-26T01:45:24.581Z | total:1422MB | swap:0MB | avail:26337MB | 
2026-01-26T01:47:55.479Z | total:1422MB | swap:0MB | avail:26329MB | 
2026-01-26T01:50:47.026Z | total:1422MB | swap:0MB | avail:26334MB | 
2026-01-26T01:53:59.419Z | total:1424MB | swap:0MB | avail:26329MB | 
2026-01-26T01:56:29.459Z | total:1425MB | swap:0MB | avail:26325MB | 
2026-01-26T01:58:48.810Z | total:1425MB | swap:0MB | avail:26328MB | 
2026-01-26T02:01:51.764Z | total:1424MB | swap:0MB | avail:26327MB | 
2026-01-26T02:04:01.161Z | total:1424MB | swap:0MB | avail:26318MB | 
2026-01-26T02:07:03.297Z | total:1426MB | swap:0MB | avail:26325MB | 
2026-01-26T02:08:51.086Z | total:1426MB | swap:0MB | avail:26324MB | 
2026-01-26T02:12:14.848Z | total:1426MB | swap:0MB | avail:26323MB | 
2026-01-26T02:14:55.592Z | total:1426MB | swap:0MB | avail:26329MB | 
2026-01-26T02:17:57.405Z | total:1426MB | swap:0MB | avail:26326MB | 
2026-01-26T02:20:49.390Z | total:1426MB | swap:0MB | avail:26325MB | 
2026-01-26T02:23:52.270Z | total:1428MB | swap:0MB | avail:26327MB | 
2026-01-26T02:26:01.468Z | total:1428MB | swap:0MB | avail:26316MB | 
2026-01-26T02:28:32.232Z | total:1428MB | swap:0MB | avail:26312MB | 
2026-01-26T02:31:45.077Z | total:1428MB | swap:0MB | avail:26314MB | 
2026-01-26T02:34:26.023Z | total:1428MB | swap:0MB | avail:26311MB | 
2026-01-26T02:37:28.289Z | total:1430MB | swap:0MB | avail:26314MB | 
2026-01-26T02:39:48.221Z | total:1430MB | swap:0MB | avail:26325MB | 
2026-01-26T02:42:19.160Z | total:1430MB | swap:0MB | avail:26305MB | 
2026-01-26T02:45:00.217Z | total:1430MB | swap:0MB | avail:26314MB | 
2026-01-26T02:47:30.629Z | total:1430MB | swap:0MB | avail:26302MB | 
2026-01-26T02:49:50.413Z | total:1430MB | swap:0MB | avail:26308MB | 
2026-01-26T02:51:49.301Z | total:1432MB | swap:0MB | avail:26310MB | 
2026-01-26T02:53:15.591Z | total:1432MB | swap:0MB | avail:26305MB | 
2026-01-26T02:54:41.981Z | total:1432MB | swap:0MB | avail:26319MB | 
2026-01-26T02:55:57.383Z | total:1432MB | swap:0MB | avail:26316MB | 
2026-01-26T02:57:13.474Z | total:1433MB | swap:0MB | avail:26311MB | 
2026-01-26T02:58:50.068Z | total:1433MB | swap:0MB | avail:26324MB | 
2026-01-26T02:59:55.923Z | total:1432MB | swap:0MB | avail:26322MB | 
2026-01-26T03:01:22.224Z | total:1432MB | swap:0MB | avail:26327MB | 
2026-01-26T03:02:27.844Z | total:1432MB | swap:0MB | avail:26345MB | 
2026-01-26T03:03:54.277Z | total:1432MB | swap:0MB | avail:26343MB | 
2026-01-26T03:05:20.406Z | total:1433MB | swap:0MB | avail:26337MB | 
2026-01-26T03:06:57.646Z | total:1434MB | swap:0MB | avail:26336MB | 
2026-01-26T03:08:13.694Z | total:1434MB | swap:0MB | avail:26329MB | 
2026-01-26T03:09:19.020Z | total:1435MB | swap:0MB | avail:26705MB | 
2026-01-26T03:10:45.304Z | total:1435MB | swap:0MB | avail:26712MB | 
2026-01-26T03:12:00.963Z | total:1434MB | swap:0MB | avail:26704MB | 
2026-01-26T03:13:16.570Z | total:1434MB | swap:0MB | avail:26713MB | 
2026-01-26T03:14:21.578Z | total:1434MB | swap:0MB | avail:26780MB | 
2026-01-26T03:15:47.517Z | total:1435MB | swap:0MB | avail:26786MB | 
2026-01-26T03:16:52.981Z | total:1434MB | swap:0MB | avail:26780MB | 
2026-01-26T03:18:18.717Z | total:1435MB | swap:0MB | avail:26779MB | 
2026-01-26T03:19:24.439Z | total:1433MB | swap:0MB | avail:26773MB | 
2026-01-26T03:21:01.158Z | total:1435MB | swap:0MB | avail:26777MB | 
2026-01-26T03:23:32.308Z | total:1437MB | swap:0MB | avail:26777MB | 
2026-01-26T03:26:02.421Z | total:1436MB | swap:0MB | avail:26773MB | 
2026-01-26T03:29:15.692Z | total:1437MB | swap:0MB | avail:26340MB | 
2026-01-26T03:30:20.818Z | total:1437MB | swap:0MB | avail:26296MB | 
2026-01-26T03:31:16.065Z | total:2722MB | swap:0MB | avail:24864MB | 
2026-01-26T03:31:16.735Z | total:3185MB | swap:0MB | avail:24388MB | 
2026-01-26T03:31:28.104Z | total:1883MB | swap:0MB | avail:25616MB | 
2026-01-26T03:31:49.686Z | total:2410MB | swap:0MB | avail:25160MB | 
2026-01-26T03:31:50.123Z | total:2405MB | swap:0MB | avail:25173MB | 
2026-01-26T03:32:45.556Z | total:2340MB | swap:0MB | avail:25447MB | 
2026-01-26T03:32:56.460Z | total:2653MB | swap:0MB | avail:25100MB | 
2026-01-26T03:32:56.744Z | total:2678MB | swap:0MB | avail:25059MB | 
2026-01-26T03:33:08.065Z | total:2832MB | swap:0MB | avail:24871MB | 
2026-01-26T03:34:14.642Z | total:2819MB | swap:0MB | avail:24871MB | 
2026-01-26T03:34:49.154Z | total:2377MB | swap:0MB | avail:25363MB | 
2026-01-26T03:35:00.597Z | total:2898MB | swap:0MB | avail:24847MB | 
2026-01-26T03:35:00.750Z | total:2901MB | swap:0MB | avail:24809MB | 
2026-01-26T03:35:11.989Z | total:2949MB | swap:0MB | avail:24765MB | 
2026-01-26T03:35:45.390Z | total:3295MB | swap:0MB | avail:24454MB | 
2026-01-26T03:35:45.519Z | total:3296MB | swap:0MB | avail:24454MB | 
2026-01-26T03:35:45.618Z | total:3296MB | swap:0MB | avail:24453MB | 
2026-01-26T03:36:31.031Z | total:3248MB | swap:0MB | avail:24653MB | 
2026-01-26T03:36:41.867Z | total:3274MB | swap:0MB | avail:24623MB | 
2026-01-26T03:36:53.865Z | total:3289MB | swap:0MB | avail:24611MB | 
2026-01-26T03:37:05.166Z | total:3280MB | swap:0MB | avail:24622MB | 
2026-01-26T03:37:16.622Z | total:3236MB | swap:0MB | avail:24652MB | 
2026-01-26T03:37:28.014Z | total:3236MB | swap:0MB | avail:24653MB | 
2026-01-26T03:37:49.481Z | total:3226MB | swap:0MB | avail:24673MB | 
2026-01-26T03:38:24.982Z | total:3289MB | swap:0MB | avail:24414MB | 
2026-01-26T03:38:25.260Z | total:3290MB | swap:0MB | avail:24428MB | 
2026-01-26T03:38:36.465Z | total:3333MB | swap:0MB | avail:24512MB | 
2026-01-26T03:38:47.902Z | total:3291MB | swap:0MB | avail:24603MB | 
2026-01-26T03:38:59.256Z | total:3239MB | swap:0MB | avail:24653MB | 
2026-01-26T03:39:21.882Z | total:3250MB | swap:0MB | avail:24622MB | 
2026-01-26T03:39:32.776Z | total:3235MB | swap:0MB | avail:24671MB | 
2026-01-26T03:39:33.353Z | total:3237MB | swap:0MB | avail:24671MB | 
2026-01-26T03:40:40.156Z | total:2429MB | swap:0MB | avail:25365MB | 
2026-01-26T03:40:51.387Z | total:2429MB | swap:0MB | avail:25364MB | 
2026-01-26T03:41:25.120Z | total:2431MB | swap:0MB | avail:25370MB | 
2026-01-26T03:41:36.238Z | total:2432MB | swap:0MB | avail:25359MB | 
2026-01-26T03:41:47.036Z | total:2432MB | swap:0MB | avail:25360MB | 
2026-01-26T03:42:43.172Z | total:2431MB | swap:0MB | avail:25360MB | 
2026-01-26T03:42:54.304Z | total:2431MB | swap:0MB | avail:25366MB | 
2026-01-26T03:43:04.536Z | total:2431MB | swap:0MB | avail:25376MB | 
2026-01-26T03:43:17.038Z | total:2982MB | swap:0MB | avail:24534MB | 
2026-01-26T03:43:17.166Z | total:2981MB | swap:0MB | avail:24548MB | 
2026-01-26T03:43:28.818Z | total:2978MB | swap:0MB | avail:24731MB | 
2026-01-26T03:44:01.571Z | total:2946MB | swap:0MB | avail:24778MB | 
2026-01-26T03:44:14.538Z | total:3425MB | swap:0MB | avail:24180MB | 
2026-01-26T03:44:14.679Z | total:3426MB | swap:0MB | avail:24180MB | 
2026-01-26T03:44:37.494Z | total:3833MB | swap:0MB | avail:23876MB | 
2026-01-26T03:44:49.379Z | total:3962MB | swap:0MB | avail:23720MB | 
2026-01-26T03:45:35.710Z | total:4500MB | swap:0MB | avail:23102MB | 
2026-01-26T03:45:36.272Z | total:4501MB | swap:0MB | avail:23145MB | 
2026-01-26T03:45:36.399Z | total:4503MB | swap:0MB | avail:23145MB | 
2026-01-26T03:45:36.527Z | total:4504MB | swap:0MB | avail:23143MB | 
2026-01-26T03:45:48.845Z | total:4599MB | swap:0MB | avail:21131MB | 
2026-01-26T03:46:12.288Z | total:5699MB | swap:0MB | avail:17194MB | 
2026-01-26T03:46:14.041Z | total:5765MB | swap:0MB | avail:16620MB | 
2026-01-26T03:46:14.222Z | total:5771MB | swap:0MB | avail:16540MB | 
2026-01-26T03:46:26.619Z | total:6414MB | swap:0MB | avail:17005MB | 
2026-01-26T03:46:27.402Z | total:6310MB | swap:0MB | avail:16779MB | 
2026-01-26T03:46:27.529Z | total:6313MB | swap:0MB | avail:16899MB | 
2026-01-26T03:46:27.688Z | total:6316MB | swap:0MB | avail:16887MB | 
2026-01-26T03:46:27.816Z | total:6403MB | swap:0MB | avail:17275MB | 
2026-01-26T03:46:40.436Z | total:6348MB | swap:0MB | avail:19791MB | 
2026-01-26T03:46:51.947Z | total:6197MB | swap:0MB | avail:19994MB | 
2026-01-26T03:47:19.702Z | total:6956MB | swap:0MB | avail:19078MB | 
2026-01-26T03:47:20.423Z | total:6825MB | swap:0MB | avail:19141MB | 
2026-01-26T03:47:20.569Z | total:6881MB | swap:0MB | avail:19435MB | 
2026-01-26T03:47:33.680Z | total:6938MB | swap:0MB | avail:19074MB | 
2026-01-26T03:47:34.561Z | total:6950MB | swap:0MB | avail:19149MB | 
2026-01-26T03:47:59.104Z | total:6722MB | swap:0MB | avail:18400MB | 
2026-01-26T03:48:14.445Z | total:6775MB | swap:0MB | avail:19148MB | 
2026-01-26T03:48:16.033Z | total:6813MB | swap:0MB | avail:19263MB | 
2026-01-26T03:48:29.541Z | total:7051MB | swap:0MB | avail:19706MB | 
2026-01-26T03:48:42.633Z | total:6883MB | swap:0MB | avail:19262MB | 
2026-01-26T03:48:55.422Z | total:7013MB | swap:0MB | avail:19466MB | 
2026-01-26T03:49:10.142Z | total:7227MB | swap:0MB | avail:18071MB | 
2026-01-26T03:49:22.095Z | total:6996MB | swap:0MB | avail:17237MB | 
2026-01-26T03:49:24.273Z | total:7011MB | swap:0MB | avail:17409MB | 
2026-01-26T03:49:37.473Z | total:7065MB | swap:0MB | avail:18119MB | 
2026-01-26T03:49:37.935Z | total:6926MB | swap:0MB | avail:18189MB | 
2026-01-26T03:49:52.583Z | total:6951MB | swap:0MB | avail:15241MB | 
2026-01-26T03:50:07.150Z | total:7147MB | swap:0MB | avail:14992MB | 
2026-01-26T03:50:22.718Z | total:6929MB | swap:0MB | avail:10966MB | 
2026-01-26T03:50:22.880Z | total:6930MB | swap:0MB | avail:10899MB | 
2026-01-26T03:50:36.766Z | total:7003MB | swap:0MB | avail:13166MB | 
2026-01-26T03:50:36.937Z | total:7004MB | swap:0MB | avail:13047MB | 
2026-01-26T03:50:37.116Z | total:7009MB | swap:0MB | avail:12959MB | 
2026-01-26T03:50:50.706Z | total:7028MB | swap:0MB | avail:9783MB | 
2026-01-26T03:50:51.201Z | total:7002MB | swap:0MB | avail:9835MB | 
2026-01-26T03:51:19.519Z | total:7115MB | swap:0MB | avail:10297MB | 
2026-01-26T03:51:32.164Z | total:7046MB | swap:0MB | avail:10775MB | 
2026-01-26T03:52:14.184Z | total:7194MB | swap:0MB | avail:13823MB | 
2026-01-26T03:52:26.456Z | total:7010MB | swap:0MB | avail:16394MB | 
2026-01-26T03:52:42.116Z | total:6944MB | swap:0MB | avail:16201MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-26T01:33:35.338Z] #1 SESSION_START  Benchmark started (foreground), duration: 4h (14400 s), poll interval: 10s [mem:1420MB, , net_procs:0, sys:26335MB avail, swap:0MB]
[2026-01-26T01:33:35.539Z] #2 SPAWN PID:17988 worker 131MB fds=41 thr=5 vsz=72554MB cpu=0.3% state=S  [mem:1420MB, , net_procs:1, sys:26333MB avail, swap:0MB]
[2026-01-26T01:33:35.770Z] #3 SPAWN PID:18050 mcp-server 67MB fds=21 thr=7 vsz=11239MB cpu=0.0% state=S parent=17988(bun) [mem:1420MB, , net_procs:2, sys:26333MB avail, swap:0MB]
[2026-01-26T01:33:35.942Z] #4 SPAWN PID:20064 chroma 65MB fds=11 thr=2 vsz=1807MB cpu=0.0% state=S  [mem:1420MB, , net_procs:3, sys:26333MB avail, swap:0MB]
[2026-01-26T01:33:36.129Z] #5 SPAWN PID:20106 chroma 363MB fds=18 thr=67 vsz=5853MB cpu=8.2% state=S  [mem:1420MB, , net_procs:4, sys:26334MB avail, swap:0MB]
[2026-01-26T01:33:36.302Z] #6 SPAWN PID:75597 claude-code 391MB fds=43 thr=16 vsz=73054MB cpu=0.7% state=S  [mem:1420MB, , net_procs:5, sys:26336MB avail, swap:0MB]
[2026-01-26T01:33:36.477Z] #7 SPAWN PID:135795 claude-code 400MB fds=43 thr=17 vsz=73509MB cpu=1.7% state=S  [mem:1420MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:33:36.672Z] #8 ANOMALY  HIGH_THREADS: 114 total threads across all processes [mem:1420MB, , net_procs:6, sys:26340MB avail, swap:0MB]
[2026-01-26T01:33:46.893Z] #9 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:33:57.609Z] #10 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26343MB avail, swap:0MB]
[2026-01-26T01:34:18.930Z] #11 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1421MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:34:29.661Z] #12 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1421MB, , net_procs:6, sys:26335MB avail, swap:0MB]
[2026-01-26T01:34:51.017Z] #13 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1421MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:35:01.743Z] #14 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:35:44.637Z] #15 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:35:55.376Z] #16 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:36:16.776Z] #17 THREAD_CHANGE PID:17988 worker threads: 5->14 [mem:1422MB, , net_procs:6, sys:26337MB avail, swap:0MB]
[2026-01-26T01:36:59.712Z] #18 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:37:21.115Z] #19 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26332MB avail, swap:0MB]
[2026-01-26T01:37:31.839Z] #20 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:38:14.449Z] #21 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26337MB avail, swap:0MB]
[2026-01-26T01:38:25.171Z] #22 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26333MB avail, swap:0MB]
[2026-01-26T01:38:36.455Z] #23 PROGRESS  Elapsed: 00:05:01, Remaining: 03:54:59, Events: 22 [mem:1422MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:38:46.675Z] #24 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:38:57.455Z] #25 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:39:18.881Z] #26 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26333MB avail, swap:0MB]
[2026-01-26T01:39:29.739Z] #27 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:39:51.326Z] #28 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26327MB avail, swap:0MB]
[2026-01-26T01:40:02.193Z] #29 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26325MB avail, swap:0MB]
[2026-01-26T01:40:45.035Z] #30 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26337MB avail, swap:0MB]
[2026-01-26T01:40:55.785Z] #31 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:41:17.240Z] #32 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1423MB, , net_procs:6, sys:26339MB avail, swap:0MB]
[2026-01-26T01:41:28.127Z] #33 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26332MB avail, swap:0MB]
[2026-01-26T01:41:49.646Z] #34 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:42:00.370Z] #35 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26337MB avail, swap:0MB]
[2026-01-26T01:42:21.773Z] #36 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1423MB, , net_procs:6, sys:26337MB avail, swap:0MB]
[2026-01-26T01:42:32.510Z] #37 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:42:43.221Z] #38 THREAD_CHANGE PID:17988 worker threads: 6->13 [mem:1422MB, , net_procs:6, sys:26334MB avail, swap:0MB]
[2026-01-26T01:42:54.057Z] #39 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26336MB avail, swap:0MB]
[2026-01-26T01:43:15.530Z] #40 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:43:26.325Z] #41 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:43:37.629Z] #42 PROGRESS  Elapsed: 00:10:02, Remaining: 03:49:58, Events: 41 [mem:1422MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:43:47.854Z] #43 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26332MB avail, swap:0MB]
[2026-01-26T01:43:58.661Z] #44 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26339MB avail, swap:0MB]
[2026-01-26T01:44:20.019Z] #45 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1423MB, , net_procs:6, sys:26343MB avail, swap:0MB]
[2026-01-26T01:44:30.771Z] #46 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26333MB avail, swap:0MB]
[2026-01-26T01:44:52.204Z] #47 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1422MB, , net_procs:6, sys:26339MB avail, swap:0MB]
[2026-01-26T01:45:03.018Z] #48 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26341MB avail, swap:0MB]
[2026-01-26T01:45:13.785Z] #49 THREAD_CHANGE PID:17988 worker threads: 6->13 [mem:1422MB, , net_procs:6, sys:26342MB avail, swap:0MB]
[2026-01-26T01:45:24.581Z] #50 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1422MB, , net_procs:6, sys:26337MB avail, swap:0MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-26T05:31:25.730Z] #3343 THREAD_CHANGE PID:2728666 claude-code threads: 17->10 [mem:7143MB, , net_procs:20, sys:20967MB avail, swap:29MB]
[2026-01-26T05:31:26.025Z] #3344 THREAD_CHANGE PID:2787088 claude-code threads: 16->9 [mem:7145MB, , net_procs:20, sys:20966MB avail, swap:29MB]
[2026-01-26T05:31:26.226Z] #3345 STATE_CHANGE PID:2921251 claude-code R->S [mem:7146MB, , net_procs:20, sys:20967MB avail, swap:29MB]
[2026-01-26T05:31:26.863Z] #3346 THREAD_CHANGE PID:3980353 claude-code threads: 16->9 [mem:7229MB, , net_procs:20, sys:20966MB avail, swap:29MB]
[2026-01-26T05:31:27.053Z] #3347 STATE_CHANGE PID:4105677 claude-code S->R [mem:7351MB, , net_procs:20, sys:20910MB avail, swap:29MB]
[2026-01-26T05:31:27.394Z] #3348 ANOMALY  HIGH_THREADS: 342 total threads across all processes [mem:7156MB, , net_procs:20, sys:20909MB avail, swap:29MB]
[2026-01-26T05:31:38.293Z] #3349 THREAD_CHANGE PID:2293503 claude-code threads: 9->16 [mem:7150MB, , net_procs:20, sys:21033MB avail, swap:29MB]
[2026-01-26T05:31:38.486Z] #3350 THREAD_CHANGE PID:2391235 claude-code threads: 19->26 [mem:7461MB, , net_procs:20, sys:20751MB avail, swap:29MB]
[2026-01-26T05:31:38.688Z] #3351 THREAD_CHANGE PID:2728666 claude-code threads: 10->17 [mem:7422MB, , net_procs:20, sys:20701MB avail, swap:29MB]
[2026-01-26T05:31:38.936Z] #3352 THREAD_CHANGE PID:2787088 claude-code threads: 9->16 [mem:7506MB, , net_procs:20, sys:20861MB avail, swap:29MB]
[2026-01-26T05:31:39.104Z] #3353 STATE_CHANGE PID:2921251 claude-code S->R [mem:7257MB, , net_procs:20, sys:20790MB avail, swap:29MB]
[2026-01-26T05:31:39.744Z] #3354 THREAD_CHANGE PID:3980353 claude-code threads: 9->16 [mem:7143MB, , net_procs:20, sys:20837MB avail, swap:29MB]
[2026-01-26T05:31:39.923Z] #3355 STATE_CHANGE PID:4105677 claude-code R->S [mem:7144MB, , net_procs:20, sys:20835MB avail, swap:29MB]
[2026-01-26T05:31:40.231Z] #3356 ANOMALY  HIGH_THREADS: 376 total threads across all processes [mem:7145MB, , net_procs:20, sys:20876MB avail, swap:29MB]
[2026-01-26T05:31:40.340Z] #3357 PROGRESS  Elapsed: 03:58:05, Remaining: 00:01:55, Events: 3356 [mem:7146MB, , net_procs:20, sys:20876MB avail, swap:29MB]
[2026-01-26T05:31:51.184Z] #3358 THREAD_CHANGE PID:2293503 claude-code threads: 16->9 [mem:7173MB, , net_procs:20, sys:21005MB avail, swap:29MB]
[2026-01-26T05:31:51.388Z] #3359 THREAD_CHANGE PID:2391235 claude-code threads: 26->19 [mem:7150MB, , net_procs:20, sys:21032MB avail, swap:29MB]
[2026-01-26T05:31:51.616Z] #3360 THREAD_CHANGE PID:2728666 claude-code threads: 17->10 [mem:7130MB, , net_procs:20, sys:21051MB avail, swap:29MB]
[2026-01-26T05:31:51.933Z] #3361 THREAD_CHANGE PID:2787088 claude-code threads: 16->9 [mem:7132MB, , net_procs:20, sys:21053MB avail, swap:29MB]
[2026-01-26T05:31:52.168Z] #3362 STATE_CHANGE PID:2921251 claude-code R->S [mem:7132MB, , net_procs:20, sys:21063MB avail, swap:29MB]
[2026-01-26T05:31:52.711Z] #3363 THREAD_CHANGE PID:3342206 claude-code threads: 16->9 [mem:7138MB, , net_procs:20, sys:21058MB avail, swap:29MB]
[2026-01-26T05:31:52.900Z] #3364 THREAD_CHANGE PID:3980353 claude-code threads: 16->9 [mem:7140MB, , net_procs:20, sys:21057MB avail, swap:29MB]
[2026-01-26T05:31:53.392Z] #3365 ANOMALY  HIGH_THREADS: 335 total threads across all processes [mem:7144MB, , net_procs:20, sys:21062MB avail, swap:29MB]
[2026-01-26T05:32:05.199Z] #3366 THREAD_CHANGE PID:3342206 claude-code threads: 9->16 [mem:7129MB, , net_procs:20, sys:21067MB avail, swap:29MB]
[2026-01-26T05:32:15.817Z] #3367 FD_CHANGE PID:17988 worker fds: 94->42 (-52) mem=145MB [mem:1942MB, , net_procs:20, sys:25504MB avail, swap:29MB]
[2026-01-26T05:32:16.262Z] #3368 SPAWN PID:111853 claude-code 428MB fds=47 thr=34 vsz=72818MB cpu=59.6% state=S  [mem:1945MB, , net_procs:21, sys:25504MB avail, swap:29MB]
[2026-01-26T05:32:16.454Z] #3369 STATE_CHANGE PID:2921251 claude-code S->R [mem:1945MB, , net_procs:21, sys:25500MB avail, swap:29MB]
[2026-01-26T05:32:16.670Z] #3370 EXIT PID:2956271 claude-code 397MB fds=43 thr=16 lived 4552s  [mem:1946MB, , net_procs:20, sys:25498MB avail, swap:29MB]
[2026-01-26T05:32:16.783Z] #3371 EXIT PID:135795 claude-code 402MB fds=43 thr=17 lived 14320s  [mem:1946MB, , net_procs:19, sys:25497MB avail, swap:29MB]
[2026-01-26T05:32:16.939Z] #3372 EXIT PID:2754832 claude-code 406MB fds=43 thr=27 lived 5190s  [mem:1947MB, , net_procs:18, sys:25496MB avail, swap:29MB]
[2026-01-26T05:32:17.065Z] #3373 EXIT PID:3342206 claude-code 400MB fds=43 thr=16 lived 3367s  [mem:1947MB, , net_procs:17, sys:25500MB avail, swap:29MB]
[2026-01-26T05:32:17.189Z] #3374 EXIT PID:3286603 claude-code 404MB fds=43 thr=18 lived 3526s  [mem:1948MB, , net_procs:16, sys:25504MB avail, swap:29MB]
[2026-01-26T05:32:17.320Z] #3375 EXIT PID:4105677 claude-code 398MB fds=43 thr=15 lived 916s  [mem:1949MB, , net_procs:15, sys:25504MB avail, swap:29MB]
[2026-01-26T05:32:17.449Z] #3376 EXIT PID:2728666 claude-code 404MB fds=43 thr=9 lived 5270s  [mem:1949MB, , net_procs:14, sys:25504MB avail, swap:29MB]
[2026-01-26T05:32:17.563Z] #3377 EXIT PID:3033138 claude-code 406MB fds=43 thr=20 lived 4308s  [mem:1950MB, , net_procs:13, sys:25501MB avail, swap:29MB]
[2026-01-26T05:32:17.675Z] #3378 EXIT PID:66722 claude-code 420MB fds=48 thr=17 lived 241s  [mem:1951MB, , net_procs:12, sys:25501MB avail, swap:29MB]
[2026-01-26T05:32:17.802Z] #3379 EXIT PID:3980353 claude-code 399MB fds=43 thr=8 lived 1432s  [mem:1952MB, , net_procs:11, sys:25500MB avail, swap:29MB]
[2026-01-26T05:32:17.927Z] #3380 EXIT PID:2787088 claude-code 395MB fds=43 thr=8 lived 5095s  [mem:1953MB, , net_procs:10, sys:25499MB avail, swap:29MB]
[2026-01-26T05:32:18.053Z] #3381 EXIT PID:2293503 claude-code 388MB fds=43 thr=8 lived 7251s  [mem:1955MB, , net_procs:9, sys:25500MB avail, swap:29MB]
[2026-01-26T05:32:18.165Z] #3382 EXIT PID:75597 claude-code 392MB fds=43 thr=16 lived 14322s  [mem:1957MB, , net_procs:8, sys:25504MB avail, swap:29MB]
[2026-01-26T05:32:18.278Z] #3383 EXIT PID:2391235 claude-code 413MB fds=43 thr=18 lived 6365s  [mem:1982MB, , net_procs:7, sys:25472MB avail, swap:29MB]
[2026-01-26T05:32:18.469Z] #3384 ANOMALY  HIGH_THREADS: 155 total threads across all processes [mem:1993MB, , net_procs:7, sys:25462MB avail, swap:29MB]
[2026-01-26T05:32:29.031Z] #3385 THREAD_CHANGE PID:111853 claude-code threads: 34->18 [mem:1956MB, , net_procs:7, sys:25688MB avail, swap:29MB]
[2026-01-26T05:32:29.211Z] #3386 STATE_CHANGE PID:2921251 claude-code R->S [mem:1956MB, , net_procs:7, sys:25692MB avail, swap:29MB]
[2026-01-26T05:32:29.495Z] #3387 ANOMALY  HIGH_THREADS: 139 total threads across all processes [mem:1959MB, , net_procs:7, sys:25691MB avail, swap:29MB]
[2026-01-26T05:32:50.840Z] #3388 STATE_CHANGE PID:111853 claude-code S->R [mem:1951MB, , net_procs:7, sys:25597MB avail, swap:29MB]
[2026-01-26T05:33:01.743Z] #3389 STATE_CHANGE PID:111853 claude-code R->S [mem:1956MB, , net_procs:7, sys:25617MB avail, swap:29MB]
[2026-01-26T05:33:23.542Z] #3390 STATE_CHANGE PID:2921251 claude-code S->R [mem:1948MB, , net_procs:7, sys:25566MB avail, swap:29MB]
[2026-01-26T05:33:34.384Z] #3391 STATE_CHANGE PID:2921251 claude-code R->S [mem:1954MB, , net_procs:7, sys:25571MB avail, swap:29MB]
[2026-01-26T05:33:45.513Z] #3392 SESSION_END  Benchmark completed after 04:00:10 [mem:1944MB, , net_procs:7, sys:25708MB avail, swap:29MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260126_013335_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260126_013335_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260126_013335_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260126_013335_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260126_013335_events.jsonl
```

---

_Report generated at 2026-01-26 05:33:45 UTC_
