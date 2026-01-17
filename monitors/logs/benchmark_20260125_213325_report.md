# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_213325` |
| Start Time | 2026-01-25 21:33:25 UTC |
| End Time | 2026-01-26 01:33:30 UTC |
| Duration | 04:00:05 (14405 seconds) |
| Poll Interval | 10s |
| Total Events | 1725 |
| Anomalies | 206 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_213325_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_213325_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_213325_report.md`

---

## Event Summary

```
    981 THREAD_CHANGE
    377 STATE_CHANGE
    206 ANOMALY
     48 SPAWN
     47 PROGRESS
     42 EXIT
      8 FD_CHANGE
      7 ORPHAN
      7 MEM_CHANGE
      1 SESSION_START
      1 SESSION_END
```

## Peak Values

```json
{
  "peak_total_mem_mb": 7604,
  "peak_swap_mb": 0,
  "min_available_mb": 10376,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

```
2026-01-25T21:37:00.428Z | HIGH_THREADS: 177 total threads across all processes
2026-01-25T21:37:22.772Z | HIGH_THREADS: 133 total threads across all processes
2026-01-25T21:37:34.035Z | HIGH_THREADS: 174 total threads across all processes
2026-01-25T21:38:18.815Z | HIGH_THREADS: 146 total threads across all processes
2026-01-25T21:41:07.427Z | HIGH_THREADS: 160 total threads across all processes
2026-01-25T21:42:58.633Z | HIGH_THREADS: 138 total threads across all processes
2026-01-25T21:44:05.113Z | HIGH_THREADS: 185 total threads across all processes
2026-01-25T21:44:27.897Z | ACCUMULATION: net 11 processes (spawns=12 exits=1)
2026-01-25T21:44:28.007Z | HIGH_THREADS: 207 total threads across all processes
2026-01-25T21:44:51.662Z | HIGH_THREADS: 189 total threads across all processes
2026-01-25T21:46:33.493Z | HIGH_COUNT: 5 Claude instances (threshold: 5)
2026-01-25T21:46:33.618Z | HIGH_THREADS: 221 total threads across all processes
2026-01-25T21:46:45.727Z | HIGH_COUNT: 6 Claude instances (threshold: 5)
2026-01-25T21:46:57.652Z | HIGH_COUNT: 7 Claude instances (threshold: 5)
2026-01-25T21:46:57.786Z | ACCUMULATION: net 15 processes (spawns=16 exits=1)
2026-01-25T21:46:57.911Z | HIGH_THREADS: 282 total threads across all processes
2026-01-25T21:47:34.693Z | HIGH_COUNT: 8 Claude instances (threshold: 5)
2026-01-25T21:47:47.510Z | HIGH_COUNT: 9 Claude instances (threshold: 5)
2026-01-25T21:49:03.671Z | HIGH_COUNT: 10 Claude instances (threshold: 5)
2026-01-25T21:49:29.055Z | HIGH_COUNT: 9 Claude instances (threshold: 5)
2026-01-25T21:50:20.708Z | HIGH_COUNT: 11 Claude instances (threshold: 5)
2026-01-25T21:50:20.897Z | ACCUMULATION: net 20 processes (spawns=28 exits=8)
2026-01-25T21:50:34.148Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-25T21:50:34.283Z | HIGH_THREADS: 347 total threads across all processes
2026-01-25T21:51:41.322Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-25T21:51:55.244Z | HIGH_THREADS: 294 total threads across all processes
2026-01-25T21:52:09.936Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T21:52:10.084Z | HIGH_MEM: 6393MB total (threshold: 6000MB) fds=933 threads=351
2026-01-25T21:52:10.337Z | HIGH_THREADS: 351 total threads across all processes
2026-01-25T21:52:24.726Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T21:52:24.966Z | ACCUMULATION: net 25 processes (spawns=35 exits=10)
2026-01-25T21:52:53.957Z | HIGH_THREADS: 335 total threads across all processes
2026-01-25T21:53:08.855Z | HIGH_THREADS: 365 total threads across all processes
2026-01-25T21:53:36.846Z | HIGH_THREADS: 340 total threads across all processes
2026-01-25T21:54:20.505Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-25T21:54:20.688Z | HIGH_THREADS: 354 total threads across all processes
2026-01-25T21:54:35.167Z | HIGH_COUNT: 15 Claude instances (threshold: 5)
2026-01-25T21:55:17.868Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-25T21:56:14.475Z | HIGH_COUNT: 17 Claude instances (threshold: 5)
2026-01-25T21:56:28.673Z | HIGH_COUNT: 16 Claude instances (threshold: 5)
2026-01-25T21:56:57.167Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T21:56:57.402Z | ACCUMULATION: net 24 processes (spawns=38 exits=14)
2026-01-25T21:56:57.566Z | HIGH_THREADS: 328 total threads across all processes
2026-01-25T21:57:11.475Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-25T21:57:38.190Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-25T21:58:18.457Z | HIGH_COUNT: 14 Claude instances (threshold: 5)
2026-01-25T21:58:18.596Z | HIGH_THREADS: 352 total threads across all processes
2026-01-25T21:58:32.529Z | HIGH_THREADS: 330 total threads across all processes
2026-01-25T21:58:45.135Z | HIGH_COUNT: 11 Claude instances (threshold: 5)
2026-01-25T21:58:58.418Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-25T22:00:06.071Z | HIGH_COUNT: 13 Claude instances (threshold: 5)
2026-01-25T22:01:25.759Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-25T22:01:25.898Z | HIGH_THREADS: 361 total threads across all processes
2026-01-25T22:01:39.544Z | HIGH_THREADS: 330 total threads across all processes
2026-01-25T22:02:18.565Z | HIGH_COUNT: 11 Claude instances (threshold: 5)
2026-01-25T22:02:18.715Z | HIGH_THREADS: 357 total threads across all processes
2026-01-25T22:02:31.448Z | HIGH_THREADS: 335 total threads across all processes
2026-01-25T22:02:44.138Z | HIGH_COUNT: 12 Claude instances (threshold: 5)
2026-01-25T22:03:09.006Z | HIGH_COUNT: 11 Claude instances (threshold: 5)
2026-01-25T22:03:34.558Z | HIGH_COUNT: 10 Claude instances (threshold: 5)
2026-01-25T22:04:36.125Z | HIGH_COUNT: 11 Claude instances (threshold: 5)
2026-01-25T22:05:00.704Z | HIGH_COUNT: 10 Claude instances (threshold: 5)
2026-01-25T22:06:13.771Z | SLOW_LEAK: claude-code grew 503MB in 954s (~31MB/min)
2026-01-25T22:08:06.553Z | SLOW_LEAK: claude-code grew 511MB in 1067s (~28MB/min)
2026-01-25T22:08:19.704Z | HIGH_COUNT: 8 Claude instances (threshold: 5)
2026-01-25T22:08:19.861Z | ACCUMULATION: net 18 processes (spawns=45 exits=27)
2026-01-25T22:08:19.994Z | HIGH_THREADS: 276 total threads across all processes
2026-01-25T22:08:31.491Z | SLOW_LEAK: claude-code grew 515MB in 1092s (~28MB/min)
2026-01-25T22:08:43.825Z | SLOW_LEAK: claude-code grew 521MB in 1104s (~28MB/min)
2026-01-25T22:08:56.865Z | HIGH_COUNT: 9 Claude instances (threshold: 5)
2026-01-25T22:09:08.641Z | SLOW_LEAK: claude-code grew 516MB in 1129s (~27MB/min)
2026-01-25T22:09:21.177Z | SLOW_LEAK: claude-code grew 536MB in 1142s (~28MB/min)
2026-01-25T22:09:22.151Z | HIGH_COUNT: 8 Claude instances (threshold: 5)
2026-01-25T22:09:33.574Z | SLOW_LEAK: claude-code grew 538MB in 1154s (~27MB/min)
2026-01-25T22:09:45.779Z | SLOW_LEAK: claude-code grew 529MB in 1166s (~27MB/min)
2026-01-25T22:09:58.003Z | SLOW_LEAK: claude-code grew 508MB in 1178s (~25MB/min)
2026-01-25T22:10:10.440Z | SLOW_LEAK: claude-code grew 552MB in 1191s (~27MB/min)
2026-01-25T22:10:11.421Z | HIGH_COUNT: 9 Claude instances (threshold: 5)
2026-01-25T22:10:23.238Z | SLOW_LEAK: claude-code grew 537MB in 1204s (~26MB/min)
2026-01-25T22:10:35.728Z | SLOW_LEAK: claude-code grew 544MB in 1216s (~26MB/min)
2026-01-25T22:10:48.034Z | SLOW_LEAK: claude-code grew 530MB in 1229s (~25MB/min)
2026-01-25T22:11:00.092Z | SLOW_LEAK: claude-code grew 531MB in 1241s (~25MB/min)
2026-01-25T22:11:12.335Z | SLOW_LEAK: claude-code grew 524MB in 1253s (~25MB/min)
2026-01-25T22:11:24.541Z | SLOW_LEAK: claude-code grew 506MB in 1265s (~24MB/min)
2026-01-25T22:11:36.750Z | SLOW_LEAK: claude-code grew 525MB in 1277s (~24MB/min)
2026-01-25T22:12:01.221Z | SLOW_LEAK: claude-code grew 524MB in 1302s (~24MB/min)
2026-01-25T22:12:13.836Z | SLOW_LEAK: claude-code grew 533MB in 1314s (~24MB/min)
2026-01-25T22:12:26.145Z | SLOW_LEAK: claude-code grew 537MB in 1327s (~24MB/min)
2026-01-25T22:12:38.411Z | SLOW_LEAK: claude-code grew 541MB in 1339s (~24MB/min)
2026-01-25T22:12:50.739Z | SLOW_LEAK: claude-code grew 554MB in 1351s (~24MB/min)
2026-01-25T22:12:51.846Z | HIGH_COUNT: 10 Claude instances (threshold: 5)
2026-01-25T22:12:51.994Z | ACCUMULATION: net 20 processes (spawns=48 exits=28)
2026-01-25T22:13:03.532Z | SLOW_LEAK: claude-code grew 550MB in 1364s (~24MB/min)
2026-01-25T22:13:04.462Z | HIGH_COUNT: 9 Claude instances (threshold: 5)
2026-01-25T22:13:04.609Z | ACCUMULATION: net 19 processes (spawns=48 exits=29)
2026-01-25T22:13:16.075Z | SLOW_LEAK: claude-code grew 591MB in 1377s (~25MB/min)
2026-01-25T22:13:28.252Z | SLOW_LEAK: claude-code grew 542MB in 1389s (~23MB/min)
2026-01-25T22:13:29.022Z | HIGH_COUNT: 8 Claude instances (threshold: 5)
2026-01-25T22:13:40.593Z | SLOW_LEAK: claude-code grew 575MB in 1401s (~24MB/min)
2026-01-25T22:13:52.723Z | SLOW_LEAK: claude-code grew 536MB in 1413s (~22MB/min)
2026-01-25T22:14:04.888Z | SLOW_LEAK: claude-code grew 533MB in 1425s (~22MB/min)
2026-01-25T22:14:16.978Z | SLOW_LEAK: claude-code grew 558MB in 1437s (~23MB/min)
2026-01-25T22:14:29.038Z | SLOW_LEAK: claude-code grew 556MB in 1450s (~23MB/min)
2026-01-25T22:14:41.009Z | SLOW_LEAK: claude-code grew 548MB in 1462s (~22MB/min)
2026-01-25T22:14:53.078Z | SLOW_LEAK: claude-code grew 551MB in 1474s (~22MB/min)
2026-01-25T22:15:05.012Z | SLOW_LEAK: claude-code grew 556MB in 1486s (~22MB/min)
2026-01-25T22:15:17.253Z | SLOW_LEAK: claude-code grew 546MB in 1498s (~21MB/min)
2026-01-25T22:21:08.543Z | HIGH_THREADS: 248 total threads across all processes
2026-01-25T22:21:20.871Z | HIGH_THREADS: 268 total threads across all processes
2026-01-25T22:24:12.484Z | HIGH_THREADS: 249 total threads across all processes
2026-01-25T22:24:24.877Z | HIGH_THREADS: 264 total threads across all processes
2026-01-25T22:49:01.143Z | HIGH_THREADS: 244 total threads across all processes
2026-01-25T22:49:13.359Z | HIGH_THREADS: 251 total threads across all processes
2026-01-25T22:49:37.658Z | HIGH_THREADS: 245 total threads across all processes
2026-01-25T22:49:50.307Z | HIGH_THREADS: 261 total threads across all processes
2026-01-25T22:52:03.944Z | HIGH_THREADS: 247 total threads across all processes
2026-01-25T22:52:16.183Z | HIGH_THREADS: 260 total threads across all processes
2026-01-25T23:04:06.672Z | SLOW_LEAK: claude-code grew 507MB in 4427s (~6MB/min)
2026-01-25T23:04:18.957Z | SLOW_LEAK: claude-code grew 508MB in 4439s (~6MB/min)
2026-01-25T23:04:31.403Z | SLOW_LEAK: claude-code grew 507MB in 4452s (~6MB/min)
2026-01-25T23:04:43.660Z | SLOW_LEAK: claude-code grew 509MB in 4464s (~6MB/min)
2026-01-25T23:06:45.159Z | SLOW_LEAK: claude-code grew 501MB in 4586s (~6MB/min)
2026-01-25T23:07:21.556Z | SLOW_LEAK: claude-code grew 502MB in 4622s (~6MB/min)
2026-01-25T23:07:45.804Z | SLOW_LEAK: claude-code grew 503MB in 4646s (~6MB/min)
2026-01-25T23:08:09.975Z | SLOW_LEAK: claude-code grew 504MB in 4670s (~6MB/min)
2026-01-25T23:08:22.203Z | SLOW_LEAK: claude-code grew 505MB in 4683s (~6MB/min)
2026-01-25T23:10:59.540Z | SLOW_LEAK: claude-code grew 502MB in 4840s (~6MB/min)
2026-01-25T23:11:11.708Z | SLOW_LEAK: claude-code grew 501MB in 4852s (~6MB/min)
2026-01-25T23:11:23.772Z | SLOW_LEAK: claude-code grew 502MB in 4864s (~6MB/min)
2026-01-25T23:11:47.677Z | SLOW_LEAK: claude-code grew 503MB in 4888s (~6MB/min)
2026-01-25T23:12:23.690Z | SLOW_LEAK: claude-code grew 504MB in 4924s (~6MB/min)
2026-01-25T23:12:47.820Z | SLOW_LEAK: claude-code grew 505MB in 4948s (~6MB/min)
2026-01-25T23:15:12.404Z | SLOW_LEAK: claude-code grew 501MB in 5093s (~5MB/min)
2026-01-25T23:15:24.670Z | SLOW_LEAK: claude-code grew 502MB in 5105s (~5MB/min)
2026-01-25T23:16:00.704Z | SLOW_LEAK: claude-code grew 503MB in 5141s (~5MB/min)
2026-01-25T23:16:24.989Z | SLOW_LEAK: claude-code grew 504MB in 5165s (~5MB/min)
2026-01-25T23:17:00.981Z | SLOW_LEAK: claude-code grew 505MB in 5201s (~5MB/min)
2026-01-25T23:17:24.989Z | SLOW_LEAK: claude-code grew 506MB in 5225s (~5MB/min)
2026-01-25T23:17:48.788Z | SLOW_LEAK: claude-code grew 507MB in 5249s (~5MB/min)
2026-01-25T23:18:25.066Z | SLOW_LEAK: claude-code grew 508MB in 5286s (~5MB/min)
2026-01-25T23:20:13.793Z | SLOW_LEAK: claude-code grew 501MB in 5394s (~5MB/min)
2026-01-25T23:20:25.978Z | SLOW_LEAK: claude-code grew 502MB in 5406s (~5MB/min)
2026-01-25T23:21:01.958Z | SLOW_LEAK: claude-code grew 503MB in 5442s (~5MB/min)
2026-01-25T23:21:26.065Z | SLOW_LEAK: claude-code grew 504MB in 5467s (~5MB/min)
2026-01-25T23:24:03.733Z | SLOW_LEAK: claude-code grew 502MB in 5624s (~5MB/min)
2026-01-25T23:24:15.937Z | SLOW_LEAK: claude-code grew 501MB in 5636s (~5MB/min)
2026-01-25T23:24:28.254Z | SLOW_LEAK: claude-code grew 502MB in 5649s (~5MB/min)
2026-01-25T23:24:52.585Z | SLOW_LEAK: claude-code grew 503MB in 5673s (~5MB/min)
2026-01-25T23:25:04.777Z | SLOW_LEAK: claude-code grew 504MB in 5685s (~5MB/min)
2026-01-25T23:25:29.072Z | SLOW_LEAK: claude-code grew 505MB in 5710s (~5MB/min)
2026-01-25T23:27:54.601Z | SLOW_LEAK: claude-code grew 502MB in 5855s (~5MB/min)
2026-01-25T23:28:30.895Z | SLOW_LEAK: claude-code grew 503MB in 5891s (~5MB/min)
2026-01-25T23:29:07.273Z | SLOW_LEAK: claude-code grew 504MB in 5928s (~5MB/min)
2026-01-25T23:29:31.865Z | SLOW_LEAK: claude-code grew 505MB in 5952s (~5MB/min)
2026-01-25T23:29:55.826Z | SLOW_LEAK: claude-code grew 506MB in 5976s (~5MB/min)
2026-01-25T23:30:20.185Z | SLOW_LEAK: claude-code grew 507MB in 6001s (~5MB/min)
2026-01-25T23:32:32.478Z | SLOW_LEAK: claude-code grew 501MB in 6133s (~4MB/min)
2026-01-25T23:32:56.451Z | SLOW_LEAK: claude-code grew 502MB in 6157s (~4MB/min)
2026-01-25T23:33:08.350Z | SLOW_LEAK: claude-code grew 503MB in 6169s (~4MB/min)
2026-01-25T23:33:44.532Z | SLOW_LEAK: claude-code grew 504MB in 6205s (~4MB/min)
2026-01-25T23:34:08.366Z | SLOW_LEAK: claude-code grew 505MB in 6229s (~4MB/min)
2026-01-25T23:34:20.350Z | SLOW_LEAK: claude-code grew 504MB in 6241s (~4MB/min)
2026-01-25T23:34:32.356Z | SLOW_LEAK: claude-code grew 505MB in 6253s (~4MB/min)
2026-01-25T23:34:44.412Z | SLOW_LEAK: claude-code grew 506MB in 6265s (~4MB/min)
2026-01-25T23:35:08.289Z | SLOW_LEAK: claude-code grew 507MB in 6289s (~4MB/min)
2026-01-25T23:37:31.913Z | SLOW_LEAK: claude-code grew 501MB in 6432s (~4MB/min)
2026-01-25T23:41:07.208Z | SLOW_LEAK: claude-code grew 502MB in 6648s (~4MB/min)
2026-01-25T23:41:31.587Z | SLOW_LEAK: claude-code grew 503MB in 6672s (~4MB/min)
2026-01-25T23:41:43.714Z | SLOW_LEAK: claude-code grew 502MB in 6684s (~4MB/min)
2026-01-25T23:41:55.912Z | SLOW_LEAK: claude-code grew 503MB in 6696s (~4MB/min)
2026-01-25T23:42:08.062Z | SLOW_LEAK: claude-code grew 504MB in 6709s (~4MB/min)
2026-01-25T23:42:32.421Z | SLOW_LEAK: claude-code grew 505MB in 6733s (~4MB/min)
2026-01-25T23:45:07.890Z | SLOW_LEAK: claude-code grew 501MB in 6888s (~4MB/min)
2026-01-25T23:45:32.521Z | SLOW_LEAK: claude-code grew 502MB in 6913s (~4MB/min)
2026-01-25T23:45:56.559Z | SLOW_LEAK: claude-code grew 503MB in 6937s (~4MB/min)
2026-01-25T23:48:32.856Z | SLOW_LEAK: claude-code grew 501MB in 7093s (~4MB/min)
2026-01-25T23:48:56.751Z | SLOW_LEAK: claude-code grew 502MB in 7117s (~4MB/min)
2026-01-25T23:49:20.655Z | SLOW_LEAK: claude-code grew 503MB in 7141s (~4MB/min)
2026-01-25T23:49:56.979Z | SLOW_LEAK: claude-code grew 504MB in 7177s (~4MB/min)
2026-01-25T23:50:09.199Z | SLOW_LEAK: claude-code grew 505MB in 7190s (~4MB/min)
2026-01-25T23:52:09.074Z | SLOW_LEAK: claude-code grew 501MB in 7310s (~4MB/min)
2026-01-25T23:52:57.018Z | SLOW_LEAK: claude-code grew 502MB in 7358s (~4MB/min)
2026-01-25T23:53:08.910Z | SLOW_LEAK: claude-code grew 503MB in 7369s (~4MB/min)
2026-01-25T23:53:33.017Z | SLOW_LEAK: claude-code grew 504MB in 7394s (~4MB/min)
2026-01-25T23:53:57.237Z | SLOW_LEAK: claude-code grew 505MB in 7418s (~4MB/min)
2026-01-25T23:56:44.780Z | SLOW_LEAK: claude-code grew 501MB in 7585s (~3MB/min)
2026-01-25T23:57:08.827Z | SLOW_LEAK: claude-code grew 502MB in 7609s (~3MB/min)
2026-01-25T23:59:55.516Z | SLOW_LEAK: claude-code grew 501MB in 7776s (~3MB/min)
2026-01-26T00:00:19.815Z | SLOW_LEAK: claude-code grew 502MB in 7800s (~3MB/min)
2026-01-26T00:00:56.412Z | SLOW_LEAK: claude-code grew 503MB in 7837s (~3MB/min)
2026-01-26T00:01:20.855Z | SLOW_LEAK: claude-code grew 504MB in 7861s (~3MB/min)
2026-01-26T00:01:33.027Z | SLOW_LEAK: claude-code grew 505MB in 7874s (~3MB/min)
2026-01-26T00:01:57.264Z | SLOW_LEAK: claude-code grew 506MB in 7898s (~3MB/min)
2026-01-26T00:04:21.862Z | SLOW_LEAK: claude-code grew 501MB in 8042s (~3MB/min)
2026-01-26T00:04:34.055Z | SLOW_LEAK: claude-code grew 502MB in 8055s (~3MB/min)
2026-01-26T00:04:58.715Z | SLOW_LEAK: claude-code grew 503MB in 8079s (~3MB/min)
2026-01-26T00:07:12.417Z | SLOW_LEAK: claude-code grew 501MB in 8213s (~3MB/min)
2026-01-26T00:08:00.659Z | SLOW_LEAK: claude-code grew 502MB in 8261s (~3MB/min)
2026-01-26T00:11:37.455Z | SLOW_LEAK: claude-code grew 503MB in 8478s (~3MB/min)
2026-01-26T00:12:01.661Z | SLOW_LEAK: claude-code grew 504MB in 8502s (~3MB/min)
2026-01-26T00:12:25.697Z | SLOW_LEAK: claude-code grew 505MB in 8526s (~3MB/min)
2026-01-26T00:12:37.666Z | SLOW_LEAK: claude-code grew 506MB in 8538s (~3MB/min)
2026-01-26T00:15:13.378Z | SLOW_LEAK: claude-code grew 502MB in 8694s (~3MB/min)
2026-01-26T00:15:25.301Z | SLOW_LEAK: claude-code grew 501MB in 8706s (~3MB/min)
2026-01-26T00:15:37.244Z | SLOW_LEAK: claude-code grew 502MB in 8718s (~3MB/min)
2026-01-26T00:17:02.813Z | HIGH_THREADS: 115 total threads across all processes
```

---

## Process Spawns (All)

```
2026-01-25T21:36:16.909Z | PID 17786 | claude-code 472MB fds=88 thr=34 vsz=72854MB cpu=47.2% state=S 
2026-01-25T21:36:17.113Z | PID 17854 | mcp-server 77MB fds=21 thr=7 vsz=11249MB cpu=2.6% state=S parent=17786(claude)
2026-01-25T21:36:17.293Z | PID 17988 | worker 106MB fds=25 thr=15 vsz=72258MB cpu=11.2% state=S 
2026-01-25T21:36:17.497Z | PID 18050 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=3.2% state=S parent=17988(bun)
2026-01-25T21:36:59.845Z | PID 20064 | chroma 150MB fds=11 thr=21 vsz=1847MB cpu=7.1% state=S 
2026-01-25T21:37:00.040Z | PID 20069 | claude-code 419MB fds=47 thr=34 vsz=72826MB cpu=52.4% state=S 
2026-01-25T21:37:00.224Z | PID 20106 | chroma 248MB fds=20 thr=70 vsz=5600MB cpu=89.6% state=S 
2026-01-25T21:37:33.589Z | PID 23482 | claude-code 456MB fds=88 thr=34 vsz=72862MB cpu=86.4% state=R 
2026-01-25T21:37:33.812Z | PID 23557 | mcp-server 78MB fds=22 thr=7 vsz=11249MB cpu=9.8% state=S parent=23482(claude)
2026-01-25T21:44:04.650Z | PID 56629 | claude-code 472MB fds=88 thr=36 vsz=72990MB cpu=53.0% state=S 
2026-01-25T21:44:04.867Z | PID 56680 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=2.9% state=S parent=56629(claude)
2026-01-25T21:44:27.650Z | PID 59164 | claude-code 399MB fds=72 thr=34 vsz=72826MB cpu=138% state=R 
2026-01-25T21:46:33.278Z | PID 75597 | claude-code 433MB fds=47 thr=18 vsz=72826MB cpu=31.7% state=S 
2026-01-25T21:46:45.191Z | PID 78659 | claude-code 472MB fds=91 thr=34 vsz=72854MB cpu=80.7% state=S 
2026-01-25T21:46:45.411Z | PID 78723 | mcp-server 78MB fds=22 thr=7 vsz=11249MB cpu=5.3% state=S parent=78659(claude)
2026-01-25T21:46:57.402Z | PID 80784 | claude-code 414MB fds=47 thr=36 vsz=72986MB cpu=23.5% state=S 
2026-01-25T21:47:21.450Z | PID 86254 | claude-code 494MB fds=92 thr=34 vsz=72886MB cpu=64.0% state=R 
2026-01-25T21:47:21.706Z | PID 86303 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=3.1% state=S parent=86254(claude)
2026-01-25T21:47:34.276Z | PID 88383 | claude-code 415MB fds=47 thr=18 vsz=72818MB cpu=20.8% state=S 
2026-01-25T21:47:47.236Z | PID 92797 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:48:11.750Z | PID 99716 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.4% state=S 
2026-01-25T21:49:03.300Z | PID 113423 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:49:16.055Z | PID 116361 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:49:41.124Z | PID 123307 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:49:54.066Z | PID 125826 | claude-code 418MB fds=48 thr=37 vsz=73062MB cpu=23.5% state=S 
2026-01-25T21:50:19.899Z | PID 130841 | claude-code 463MB fds=88 thr=20 vsz=72826MB cpu=24.9% state=S 
2026-01-25T21:50:20.126Z | PID 131653 | mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=1.4% state=S parent=130841(claude)
2026-01-25T21:50:20.357Z | PID 132750 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:50:33.341Z | PID 135391 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:50:33.580Z | PID 135795 | claude-code 428MB fds=47 thr=36 vsz=72962MB cpu=28.4% state=S 
2026-01-25T21:51:00.739Z | PID 145230 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:51:40.905Z | PID 156180 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:52:09.085Z | PID 163430 | claude-code 524MB fds=88 thr=23 vsz=72926MB cpu=43.6% state=R 
2026-01-25T21:52:09.426Z | PID 163580 | mcp-server 79MB fds=21 thr=7 vsz=11249MB cpu=1.4% state=S parent=163430(claude)
2026-01-25T21:52:24.233Z | PID 165216 | claude-code 446MB fds=46 thr=19 vsz=72886MB cpu=16.9% state=S 
2026-01-25T21:54:19.956Z | PID 208104 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:55:17.315Z | PID 228733 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:56:13.930Z | PID 244390 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:58:17.760Z | PID 285837 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:58:17.996Z | PID 285880 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T21:58:57.999Z | PID 296689 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T22:00:05.441Z | PID 317830 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T22:00:45.605Z | PID 331030 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T22:02:43.738Z | PID 364182 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T22:04:35.832Z | PID 388698 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T22:08:56.544Z | PID 442471 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T22:10:11.082Z | PID 455201 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
2026-01-25T22:12:51.482Z | PID 491757 | claude-code 3MB fds=3 thr=1 vsz=7MB cpu=0.0% state=S 
```


---

## Process Exits (All)

```
2026-01-25T21:42:58.405Z | PID 20069 | claude-code 418MB fds=46 thr=17 lived 358s 
2026-01-25T21:47:21.850Z | PID 59164 | claude-code 412MB fds=48 thr=18 lived 174s 
2026-01-25T21:48:11.913Z | PID 92797 | claude-code 3MB fds=3 thr=1 lived 24s 
2026-01-25T21:49:16.226Z | PID 113423 | claude-code 3MB fds=3 thr=1 lived 13s 
2026-01-25T21:49:28.778Z | PID 99716 | claude-code 3MB fds=3 thr=1 lived 77s 
2026-01-25T21:49:41.261Z | PID 116361 | claude-code 3MB fds=3 thr=1 lived 25s 
2026-01-25T21:49:54.404Z | PID 23482 | claude-code 542MB fds=56 thr=17 lived 741s orphaned MCP:23557
2026-01-25T21:49:54.580Z | PID 23557 | mcp-server 67MB fds=21 thr=7 lived 741s 
2026-01-25T21:50:33.783Z | PID 132750 | claude-code 3MB fds=3 thr=1 lived 13s 
2026-01-25T21:51:00.886Z | PID 135391 | claude-code 3MB fds=3 thr=1 lived 27s 
2026-01-25T21:54:34.675Z | PID 208104 | claude-code 3MB fds=3 thr=1 lived 15s 
2026-01-25T21:56:28.242Z | PID 228733 | claude-code 3MB fds=3 thr=1 lived 71s 
2026-01-25T21:56:56.441Z | PID 123307 | claude-code 3MB fds=3 thr=1 lived 435s 
2026-01-25T21:56:56.600Z | PID 165216 | claude-code 419MB fds=47 thr=17 lived 272s 
2026-01-25T21:57:10.941Z | PID 244390 | claude-code 3MB fds=3 thr=1 lived 57s 
2026-01-25T21:57:37.819Z | PID 145230 | claude-code 3MB fds=3 thr=1 lived 397s 
2026-01-25T21:58:44.567Z | PID 156180 | claude-code 3MB fds=3 thr=1 lived 424s 
2026-01-25T21:58:44.699Z | PID 285837 | claude-code 3MB fds=3 thr=1 lived 27s 
2026-01-25T21:58:44.816Z | PID 285880 | claude-code 3MB fds=3 thr=1 lived 27s 
2026-01-25T22:00:45.753Z | PID 317830 | claude-code 3MB fds=3 thr=1 lived 40s 
2026-01-25T22:01:25.404Z | PID 331030 | claude-code 3MB fds=3 thr=1 lived 40s 
2026-01-25T22:02:18.237Z | PID 296689 | claude-code 3MB fds=3 thr=1 lived 201s 
2026-01-25T22:03:08.692Z | PID 364182 | claude-code 3MB fds=3 thr=1 lived 25s 
2026-01-25T22:03:34.146Z | PID 88383 | claude-code 402MB fds=46 thr=18 lived 960s 
2026-01-25T22:05:00.408Z | PID 388698 | claude-code 3MB fds=3 thr=1 lived 25s 
2026-01-25T22:08:19.269Z | PID 125826 | claude-code 399MB fds=46 thr=19 lived 1105s 
2026-01-25T22:08:19.395Z | PID 80784 | claude-code 423MB fds=46 thr=17 lived 1282s 
2026-01-25T22:09:21.836Z | PID 442471 | claude-code 3MB fds=3 thr=1 lived 25s 
2026-01-25T22:13:04.146Z | PID 491757 | claude-code 3MB fds=3 thr=1 lived 13s 
2026-01-25T22:13:28.740Z | PID 455201 | claude-code 3MB fds=3 thr=1 lived 197s 
2026-01-26T00:17:00.611Z | PID 78723 | mcp-server 67MB fds=21 thr=7 lived 9015s 
2026-01-26T00:17:00.726Z | PID 56680 | mcp-server 67MB fds=21 thr=7 lived 9176s 
2026-01-26T00:17:00.947Z | PID 78659 | claude-code 792MB fds=55 thr=18 lived 9015s orphaned MCP:78723
2026-01-26T00:17:01.176Z | PID 17786 | claude-code 496MB fds=53 thr=16 lived 9645s orphaned MCP:17854
2026-01-26T00:17:01.402Z | PID 130841 | claude-code 959MB fds=53 thr=18 lived 8802s orphaned MCP:131653
2026-01-26T00:17:01.530Z | PID 131653 | mcp-server 67MB fds=21 thr=7 lived 8801s 
2026-01-26T00:17:01.781Z | PID 56629 | claude-code 518MB fds=55 thr=17 lived 9177s orphaned MCP:56680
2026-01-26T00:17:01.911Z | PID 163580 | mcp-server 67MB fds=21 thr=7 lived 8692s 
2026-01-26T00:17:02.140Z | PID 163430 | claude-code 579MB fds=53 thr=17 lived 8693s orphaned MCP:163580
2026-01-26T00:17:02.258Z | PID 17854 | mcp-server 66MB fds=21 thr=7 lived 9645s 
2026-01-26T00:17:02.402Z | PID 86303 | mcp-server 67MB fds=21 thr=7 lived 8981s 
2026-01-26T00:17:02.636Z | PID 86254 | claude-code 717MB fds=53 thr=18 lived 8981s orphaned MCP:86303
```


---

## Orphan Events

```
2026-01-25T21:49:54.224Z | PID 23557 | mcp-server orphaned by death of 23482
2026-01-26T00:17:00.842Z | PID 78723 | mcp-server orphaned by death of 78659
2026-01-26T00:17:01.065Z | PID 17854 | mcp-server orphaned by death of 17786
2026-01-26T00:17:01.296Z | PID 131653 | mcp-server orphaned by death of 130841
2026-01-26T00:17:01.664Z | PID 56680 | mcp-server orphaned by death of 56629
2026-01-26T00:17:02.032Z | PID 163580 | mcp-server orphaned by death of 163430
2026-01-26T00:17:02.518Z | PID 86303 | mcp-server orphaned by death of 86254
```

---

## Memory Changes (>100MB)

```
2026-01-25T21:44:27.348Z | PID 56629 | claude-code 497MB->690MB (1193MB) fds=88 thr=23
2026-01-25T21:53:04.972Z | PID 20106 | chroma 342MB->464MB (1122MB) fds=25 thr=89
2026-01-25T21:53:33.625Z | PID 20106 | chroma 446MB->344MB (-102MB) fds=25 thr=74
2026-01-25T21:58:15.301Z | PID 20106 | chroma 357MB->479MB (1122MB) fds=25 thr=89
2026-01-25T21:58:29.560Z | PID 20106 | chroma 479MB->360MB (-119MB) fds=25 thr=74
2026-01-25T22:01:23.138Z | PID 20106 | chroma 360MB->467MB (1107MB) fds=25 thr=89
2026-01-25T22:01:36.949Z | PID 20106 | chroma 467MB->361MB (-106MB) fds=25 thr=74
```

---

## State Changes

```
2026-01-25T21:36:59.265Z | PID 17786 | claude-code S->R
2026-01-25T21:37:10.680Z | PID 17786 | claude-code R->S
2026-01-25T21:37:21.929Z | PID 17786 | claude-code S->R
2026-01-25T21:37:44.273Z | PID 17786 | claude-code R->S
2026-01-25T21:37:45.013Z | PID 23482 | claude-code R->S
2026-01-25T21:38:06.581Z | PID 17786 | claude-code S->R
2026-01-25T21:38:17.685Z | PID 17786 | claude-code R->S
2026-01-25T21:38:29.083Z | PID 17786 | claude-code S->R
2026-01-25T21:38:40.428Z | PID 17786 | claude-code R->S
2026-01-25T21:40:10.105Z | PID 17786 | claude-code S->R
2026-01-25T21:40:21.301Z | PID 17786 | claude-code R->S
2026-01-25T21:40:43.970Z | PID 17786 | claude-code S->R
2026-01-25T21:41:06.410Z | PID 17786 | claude-code R->S
2026-01-25T21:41:17.669Z | PID 17786 | claude-code S->R
2026-01-25T21:41:28.922Z | PID 17786 | claude-code R->S
2026-01-25T21:41:40.602Z | PID 20069 | claude-code S->R
2026-01-25T21:41:51.241Z | PID 17786 | claude-code S->R
2026-01-25T21:41:51.830Z | PID 20069 | claude-code R->S
2026-01-25T21:42:02.453Z | PID 17786 | claude-code R->S
2026-01-25T21:42:13.948Z | PID 20069 | claude-code S->R
2026-01-25T21:42:25.047Z | PID 20069 | claude-code R->S
2026-01-25T21:44:38.461Z | PID 17988 | worker S->R
2026-01-25T21:44:39.393Z | PID 59164 | claude-code R->S
2026-01-25T21:44:50.211Z | PID 17988 | worker R->S
2026-01-25T21:44:50.919Z | PID 56629 | claude-code S->R
2026-01-25T21:44:51.323Z | PID 59164 | claude-code S->D
2026-01-25T21:45:02.671Z | PID 56629 | claude-code R->S
2026-01-25T21:45:02.964Z | PID 59164 | claude-code D->S
2026-01-25T21:45:36.423Z | PID 56629 | claude-code S->R
2026-01-25T21:45:59.009Z | PID 56629 | claude-code R->S
2026-01-25T21:46:10.410Z | PID 59164 | claude-code S->R
2026-01-25T21:46:21.703Z | PID 59164 | claude-code R->S
2026-01-25T21:46:32.910Z | PID 56629 | claude-code S->R
2026-01-25T21:46:44.636Z | PID 56629 | claude-code R->S
2026-01-25T21:46:44.995Z | PID 75597 | claude-code S->R
2026-01-25T21:46:56.480Z | PID 23482 | claude-code S->R
2026-01-25T21:46:56.981Z | PID 75597 | claude-code R->S
2026-01-25T21:47:08.646Z | PID 23482 | claude-code R->S
2026-01-25T21:47:09.272Z | PID 78659 | claude-code S->R
2026-01-25T21:47:21.058Z | PID 78659 | claude-code R->S
2026-01-25T21:47:32.565Z | PID 17988 | worker S->R
2026-01-25T21:47:33.064Z | PID 23482 | claude-code S->R
2026-01-25T21:47:33.815Z | PID 80784 | claude-code S->R
2026-01-25T21:47:34.015Z | PID 86254 | claude-code R->S
2026-01-25T21:47:45.021Z | PID 17786 | claude-code S->R
2026-01-25T21:47:45.299Z | PID 17988 | worker R->S
2026-01-25T21:47:46.120Z | PID 75597 | claude-code S->D
2026-01-25T21:47:46.315Z | PID 78659 | claude-code S->R
2026-01-25T21:47:46.604Z | PID 80784 | claude-code R->S
2026-01-25T21:47:46.809Z | PID 86254 | claude-code S->R
2026-01-25T21:47:57.764Z | PID 17786 | claude-code R->S
2026-01-25T21:47:58.337Z | PID 23482 | claude-code R->S
2026-01-25T21:47:58.757Z | PID 75597 | claude-code D->S
2026-01-25T21:47:59.144Z | PID 86254 | claude-code R->S
2026-01-25T21:48:11.204Z | PID 86254 | claude-code S->R
2026-01-25T21:48:11.524Z | PID 88383 | claude-code S->R
2026-01-25T21:48:23.510Z | PID 78659 | claude-code R->S
2026-01-25T21:48:23.812Z | PID 80784 | claude-code S->R
2026-01-25T21:48:24.067Z | PID 86254 | claude-code R->S
2026-01-25T21:48:35.758Z | PID 23482 | claude-code S->R
2026-01-25T21:48:36.621Z | PID 78659 | claude-code S->R
2026-01-25T21:48:37.006Z | PID 80784 | claude-code R->S
2026-01-25T21:48:37.267Z | PID 86254 | claude-code S->R
2026-01-25T21:48:37.576Z | PID 88383 | claude-code R->S
2026-01-25T21:48:49.584Z | PID 78659 | claude-code R->S
2026-01-25T21:48:49.961Z | PID 86254 | claude-code R->S
2026-01-25T21:49:01.326Z | PID 23482 | claude-code R->S
2026-01-25T21:49:02.213Z | PID 78659 | claude-code S->R
2026-01-25T21:49:02.683Z | PID 86254 | claude-code S->R
2026-01-25T21:49:14.660Z | PID 23482 | claude-code S->R
2026-01-25T21:49:15.268Z | PID 78659 | claude-code R->S
2026-01-25T21:49:27.370Z | PID 23482 | claude-code R->S
2026-01-25T21:49:28.270Z | PID 86254 | claude-code R->S
2026-01-25T21:49:52.297Z | PID 20106 | chroma S->R
2026-01-25T21:49:53.043Z | PID 78659 | claude-code S->R
2026-01-25T21:49:53.504Z | PID 86254 | claude-code S->R
2026-01-25T21:50:05.741Z | PID 20106 | chroma R->S
2026-01-25T21:50:18.780Z | PID 78659 | claude-code R->S
2026-01-25T21:50:19.182Z | PID 86254 | claude-code R->S
2026-01-25T21:50:32.091Z | PID 78659 | claude-code S->R
2026-01-25T21:50:45.496Z | PID 75597 | claude-code S->R
2026-01-25T21:50:46.099Z | PID 86254 | claude-code S->R
2026-01-25T21:50:46.679Z | PID 130841 | claude-code S->R
2026-01-25T21:50:47.191Z | PID 135795 | claude-code S->R
2026-01-25T21:50:58.921Z | PID 75597 | claude-code R->S
2026-01-25T21:51:00.142Z | PID 130841 | claude-code R->S
2026-01-25T21:51:00.495Z | PID 135795 | claude-code R->S
2026-01-25T21:51:13.134Z | PID 86254 | claude-code R->S
2026-01-25T21:51:13.873Z | PID 130841 | claude-code S->R
2026-01-25T21:51:14.217Z | PID 135795 | claude-code S->R
2026-01-25T21:51:27.220Z | PID 135795 | claude-code R->S
2026-01-25T21:51:38.525Z | PID 20106 | chroma S->R
2026-01-25T21:51:39.799Z | PID 86254 | claude-code S->R
2026-01-25T21:51:52.245Z | PID 20106 | chroma R->S
2026-01-25T21:51:54.455Z | PID 135795 | claude-code S->R
2026-01-25T21:52:08.549Z | PID 135795 | claude-code R->S
2026-01-25T21:52:22.079Z | PID 86254 | claude-code R->D
2026-01-25T21:52:23.126Z | PID 130841 | claude-code R->S
2026-01-25T21:52:36.487Z | PID 78659 | claude-code R->S
2026-01-25T21:52:37.076Z | PID 86254 | claude-code D->R
```

---

## Memory Trajectory (sampled every 10 events)

```
2026-01-25T21:37:00.040Z | total:1558MB | swap:0MB | avail:25869MB | 
2026-01-25T21:37:00.428Z | total:1561MB | swap:0MB | avail:25903MB | 
2026-01-25T21:37:22.772Z | total:1485MB | swap:0MB | avail:26154MB | 
2026-01-25T21:37:33.589Z | total:2015MB | swap:0MB | avail:25299MB | 
2026-01-25T21:37:34.035Z | total:2014MB | swap:0MB | avail:25322MB | 
2026-01-25T21:38:18.815Z | total:1966MB | swap:0MB | avail:25736MB | 
2026-01-25T21:38:29.083Z | total:1962MB | swap:0MB | avail:25739MB | 
2026-01-25T21:39:25.885Z | total:1975MB | swap:0MB | avail:25726MB | 
2026-01-25T21:40:22.119Z | total:1974MB | swap:0MB | avail:25727MB | 
2026-01-25T21:41:07.427Z | total:2009MB | swap:0MB | avail:25606MB | 
2026-01-25T21:41:17.776Z | total:2039MB | swap:0MB | avail:25625MB | 
2026-01-25T21:42:58.633Z | total:1566MB | swap:0MB | avail:26031MB | 
2026-01-25T21:44:05.113Z | total:2115MB | swap:0MB | avail:25306MB | 
2026-01-25T21:44:27.897Z | total:2667MB | swap:0MB | avail:24779MB | 
2026-01-25T21:44:28.007Z | total:2666MB | swap:0MB | avail:24776MB | 
2026-01-25T21:44:51.323Z | total:2588MB | swap:0MB | avail:24943MB | 
2026-01-25T21:44:51.662Z | total:2706MB | swap:0MB | avail:24937MB | 
2026-01-25T21:46:33.278Z | total:3378MB | swap:0MB | avail:24300MB | 
2026-01-25T21:46:33.493Z | total:3189MB | swap:0MB | avail:24242MB | 
2026-01-25T21:46:33.618Z | total:3190MB | swap:0MB | avail:24234MB | 
2026-01-25T21:46:45.727Z | total:3711MB | swap:0MB | avail:23611MB | 
2026-01-25T21:46:56.981Z | total:4134MB | swap:0MB | avail:23242MB | 
2026-01-25T21:46:57.652Z | total:4144MB | swap:0MB | avail:23374MB | 
2026-01-25T21:46:57.786Z | total:4145MB | swap:0MB | avail:23375MB | 
2026-01-25T21:46:57.911Z | total:4143MB | swap:0MB | avail:23377MB | 
2026-01-25T21:47:21.450Z | total:4577MB | swap:0MB | avail:22696MB | 
2026-01-25T21:47:34.693Z | total:4844MB | swap:0MB | avail:22586MB | 
2026-01-25T21:47:45.299Z | total:4769MB | swap:0MB | avail:21722MB | 
2026-01-25T21:47:47.510Z | total:4794MB | swap:0MB | avail:21686MB | 
2026-01-25T21:47:58.757Z | total:4771MB | swap:0MB | avail:21523MB | 
2026-01-25T21:48:36.621Z | total:4945MB | swap:0MB | avail:17943MB | 
2026-01-25T21:49:02.683Z | total:4883MB | swap:0MB | avail:20346MB | 
2026-01-25T21:49:03.671Z | total:4879MB | swap:0MB | avail:20049MB | 
2026-01-25T21:49:29.055Z | total:4945MB | swap:0MB | avail:20795MB | 
2026-01-25T21:49:54.404Z | total:4778MB | swap:0MB | avail:18813MB | 
2026-01-25T21:50:20.708Z | total:5319MB | swap:0MB | avail:16153MB | 
2026-01-25T21:50:20.897Z | total:5318MB | swap:0MB | avail:16448MB | 
2026-01-25T21:50:34.148Z | total:5683MB | swap:0MB | avail:19237MB | 
2026-01-25T21:50:34.283Z | total:5685MB | swap:0MB | avail:19212MB | 
2026-01-25T21:50:46.679Z | total:5797MB | swap:0MB | avail:19255MB | 
2026-01-25T21:51:13.134Z | total:5840MB | swap:0MB | avail:16250MB | 
2026-01-25T21:51:41.322Z | total:5717MB | swap:0MB | avail:14537MB | 
2026-01-25T21:51:52.245Z | total:5875MB | swap:0MB | avail:11649MB | 
2026-01-25T21:51:55.244Z | total:5724MB | swap:0MB | avail:11893MB | 
2026-01-25T21:52:09.085Z | total:6774MB | swap:0MB | avail:12778MB | 
2026-01-25T21:52:09.936Z | total:6778MB | swap:0MB | avail:12839MB | 
2026-01-25T21:52:10.084Z | total:6777MB | swap:0MB | avail:12706MB | 
2026-01-25T21:52:10.337Z | total:6792MB | swap:0MB | avail:12601MB | 
2026-01-25T21:52:24.726Z | total:6846MB | swap:0MB | avail:13515MB | 
2026-01-25T21:52:24.966Z | total:6950MB | swap:0MB | avail:13467MB | 
2026-01-25T21:52:52.245Z | total:6866MB | swap:0MB | avail:13035MB | 
2026-01-25T21:52:53.957Z | total:7101MB | swap:0MB | avail:13394MB | 
2026-01-25T21:53:07.509Z | total:6866MB | swap:0MB | avail:13268MB | 
2026-01-25T21:53:08.855Z | total:6892MB | swap:0MB | avail:13935MB | 
2026-01-25T21:53:36.846Z | total:6841MB | swap:0MB | avail:16408MB | 
2026-01-25T21:53:50.075Z | total:6845MB | swap:0MB | avail:17005MB | 
2026-01-25T21:54:17.538Z | total:6892MB | swap:0MB | avail:16506MB | 
2026-01-25T21:54:20.505Z | total:6957MB | swap:0MB | avail:16720MB | 
2026-01-25T21:54:20.688Z | total:7042MB | swap:0MB | avail:16678MB | 
2026-01-25T21:54:33.183Z | total:7007MB | swap:0MB | avail:16450MB | 
2026-01-25T21:54:35.167Z | total:7000MB | swap:0MB | avail:16572MB | 
2026-01-25T21:55:02.190Z | total:7054MB | swap:0MB | avail:16328MB | 
2026-01-25T21:55:17.868Z | total:7067MB | swap:0MB | avail:16117MB | 
2026-01-25T21:55:30.911Z | total:7130MB | swap:0MB | avail:15775MB | 
2026-01-25T21:56:13.930Z | total:7031MB | swap:0MB | avail:15735MB | 
2026-01-25T21:56:14.475Z | total:7036MB | swap:0MB | avail:15604MB | 
2026-01-25T21:56:28.673Z | total:7063MB | swap:0MB | avail:15966MB | 
2026-01-25T21:56:40.364Z | total:7054MB | swap:0MB | avail:15273MB | 
2026-01-25T21:56:57.167Z | total:6682MB | swap:0MB | avail:17139MB | 
2026-01-25T21:56:57.402Z | total:6681MB | swap:0MB | avail:17068MB | 
2026-01-25T21:56:57.566Z | total:6687MB | swap:0MB | avail:17033MB | 
2026-01-25T21:57:08.753Z | total:6685MB | swap:0MB | avail:18479MB | 
2026-01-25T21:57:11.475Z | total:6731MB | swap:0MB | avail:18405MB | 
2026-01-25T21:57:37.190Z | total:6704MB | swap:0MB | avail:19596MB | 
2026-01-25T21:57:38.190Z | total:6727MB | swap:0MB | avail:19533MB | 
2026-01-25T21:58:15.904Z | total:6989MB | swap:0MB | avail:18288MB | 
2026-01-25T21:58:18.457Z | total:6717MB | swap:0MB | avail:17821MB | 
2026-01-25T21:58:18.596Z | total:6718MB | swap:0MB | avail:17851MB | 
2026-01-25T21:58:30.689Z | total:6721MB | swap:0MB | avail:17007MB | 
2026-01-25T21:58:32.529Z | total:6910MB | swap:0MB | avail:16871MB | 
2026-01-25T21:58:45.135Z | total:6733MB | swap:0MB | avail:20667MB | 
2026-01-25T21:58:57.368Z | total:6740MB | swap:0MB | avail:17060MB | 
2026-01-25T21:58:58.418Z | total:6740MB | swap:0MB | avail:16997MB | 
2026-01-25T21:59:37.357Z | total:6841MB | swap:0MB | avail:16631MB | 
2026-01-25T22:00:06.071Z | total:6824MB | swap:0MB | avail:17591MB | 
2026-01-25T22:00:31.047Z | total:6856MB | swap:0MB | avail:18569MB | 
2026-01-25T22:01:23.138Z | total:7244MB | swap:0MB | avail:18464MB | 
2026-01-25T22:01:25.759Z | total:7002MB | swap:0MB | avail:19021MB | 
2026-01-25T22:01:25.898Z | total:7002MB | swap:0MB | avail:18975MB | 
2026-01-25T22:01:36.949Z | total:7011MB | swap:0MB | avail:19208MB | 
2026-01-25T22:01:39.544Z | total:7023MB | swap:0MB | avail:19184MB | 
2026-01-25T22:01:51.548Z | total:7204MB | swap:0MB | avail:19125MB | 
2026-01-25T22:02:18.565Z | total:7078MB | swap:0MB | avail:20477MB | 
2026-01-25T22:02:18.715Z | total:7033MB | swap:0MB | avail:20476MB | 
2026-01-25T22:02:31.448Z | total:7088MB | swap:0MB | avail:20687MB | 
2026-01-25T22:02:43.738Z | total:7069MB | swap:0MB | avail:19816MB | 
2026-01-25T22:02:44.138Z | total:7072MB | swap:0MB | avail:19630MB | 
2026-01-25T22:03:09.006Z | total:7026MB | swap:0MB | avail:20838MB | 
2026-01-25T22:03:33.530Z | total:6810MB | swap:0MB | avail:20949MB | 
2026-01-25T22:03:34.558Z | total:6646MB | swap:0MB | avail:20964MB | 
2026-01-25T22:04:34.685Z | total:6656MB | swap:0MB | avail:20066MB | 
2026-01-25T22:04:36.125Z | total:6614MB | swap:0MB | avail:20115MB | 
2026-01-25T22:05:00.704Z | total:6602MB | swap:0MB | avail:21150MB | 
2026-01-25T22:05:35.957Z | total:6707MB | swap:0MB | avail:21037MB | 
2026-01-25T22:06:13.771Z | total:6708MB | swap:0MB | avail:20936MB | 
2026-01-25T22:06:25.493Z | total:6678MB | swap:0MB | avail:20934MB | 
2026-01-25T22:07:14.907Z | total:6698MB | swap:0MB | avail:20963MB | 
2026-01-25T22:07:40.971Z | total:6723MB | swap:0MB | avail:21035MB | 
2026-01-25T22:08:06.553Z | total:6745MB | swap:0MB | avail:21101MB | 
2026-01-25T22:08:18.956Z | total:5877MB | swap:0MB | avail:21883MB | 
2026-01-25T22:08:19.704Z | total:5862MB | swap:0MB | avail:21902MB | 
2026-01-25T22:08:19.861Z | total:5862MB | swap:0MB | avail:21902MB | 
2026-01-25T22:08:19.994Z | total:5862MB | swap:0MB | avail:21901MB | 
2026-01-25T22:08:31.491Z | total:5915MB | swap:0MB | avail:21833MB | 
2026-01-25T22:08:43.825Z | total:5909MB | swap:0MB | avail:21820MB | 
2026-01-25T22:08:56.029Z | total:5926MB | swap:0MB | avail:20862MB | 
2026-01-25T22:08:56.865Z | total:5932MB | swap:0MB | avail:20833MB | 
2026-01-25T22:09:08.641Z | total:5909MB | swap:0MB | avail:20572MB | 
2026-01-25T22:09:21.177Z | total:5888MB | swap:0MB | avail:21644MB | 
2026-01-25T22:09:21.836Z | total:5885MB | swap:0MB | avail:21642MB | 
2026-01-25T22:09:22.151Z | total:5886MB | swap:0MB | avail:21653MB | 
2026-01-25T22:09:33.574Z | total:5940MB | swap:0MB | avail:21741MB | 
2026-01-25T22:09:45.779Z | total:5945MB | swap:0MB | avail:21799MB | 
2026-01-25T22:09:58.003Z | total:5903MB | swap:0MB | avail:21800MB | 
2026-01-25T22:10:10.440Z | total:5943MB | swap:0MB | avail:20034MB | 
2026-01-25T22:10:11.082Z | total:5943MB | swap:0MB | avail:19523MB | 
2026-01-25T22:10:11.421Z | total:5943MB | swap:0MB | avail:19403MB | 
2026-01-25T22:10:23.238Z | total:5926MB | swap:0MB | avail:17680MB | 
2026-01-25T22:10:35.728Z | total:5937MB | swap:0MB | avail:16279MB | 
2026-01-25T22:10:48.034Z | total:5916MB | swap:0MB | avail:20245MB | 
2026-01-25T22:11:00.092Z | total:5909MB | swap:0MB | avail:19823MB | 
2026-01-25T22:11:12.335Z | total:5916MB | swap:0MB | avail:20056MB | 
2026-01-25T22:11:24.541Z | total:5875MB | swap:0MB | avail:20466MB | 
2026-01-25T22:11:36.750Z | total:5896MB | swap:0MB | avail:20500MB | 
2026-01-25T22:12:01.221Z | total:5897MB | swap:0MB | avail:20000MB | 
2026-01-25T22:12:12.484Z | total:5907MB | swap:0MB | avail:20057MB | 
2026-01-25T22:12:13.836Z | total:5921MB | swap:0MB | avail:20306MB | 
2026-01-25T22:12:26.145Z | total:5948MB | swap:0MB | avail:20199MB | 
2026-01-25T22:12:38.411Z | total:5948MB | swap:0MB | avail:19996MB | 
2026-01-25T22:12:50.739Z | total:5965MB | swap:0MB | avail:18740MB | 
2026-01-25T22:12:51.846Z | total:5971MB | swap:0MB | avail:18462MB | 
2026-01-25T22:12:51.994Z | total:5976MB | swap:0MB | avail:18392MB | 
2026-01-25T22:13:03.532Z | total:5966MB | swap:0MB | avail:20198MB | 
2026-01-25T22:13:04.462Z | total:5941MB | swap:0MB | avail:20112MB | 
2026-01-25T22:13:04.609Z | total:5943MB | swap:0MB | avail:20069MB | 
2026-01-25T22:13:16.075Z | total:6014MB | swap:0MB | avail:20139MB | 
2026-01-25T22:13:28.252Z | total:5955MB | swap:0MB | avail:21539MB | 
2026-01-25T22:13:29.022Z | total:5959MB | swap:0MB | avail:21541MB | 
2026-01-25T22:13:40.593Z | total:5979MB | swap:0MB | avail:21755MB | 
2026-01-25T22:13:52.723Z | total:5943MB | swap:0MB | avail:21735MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-25T21:33:25.582Z] #1 SESSION_START  Benchmark started (foreground), duration: 4h (14400 s), poll interval: 10s [mem:2MB, , net_procs:0, sys:27490MB avail, swap:0MB]
[2026-01-25T21:36:16.909Z] #2 SPAWN PID:17786 claude-code 472MB fds=88 thr=34 vsz=72854MB cpu=47.2% state=S  [mem:737MB, , net_procs:1, sys:26580MB avail, swap:0MB]
[2026-01-25T21:36:17.113Z] #3 SPAWN PID:17854 mcp-server 77MB fds=21 thr=7 vsz=11249MB cpu=2.6% state=S parent=17786(claude) [mem:734MB, , net_procs:2, sys:26588MB avail, swap:0MB]
[2026-01-25T21:36:17.293Z] #4 SPAWN PID:17988 worker 106MB fds=25 thr=15 vsz=72258MB cpu=11.2% state=S  [mem:734MB, , net_procs:3, sys:26601MB avail, swap:0MB]
[2026-01-25T21:36:17.497Z] #5 SPAWN PID:18050 mcp-server 78MB fds=21 thr=7 vsz=11249MB cpu=3.2% state=S parent=17988(bun) [mem:735MB, , net_procs:4, sys:26598MB avail, swap:0MB]
[2026-01-25T21:36:27.794Z] #6 THREAD_CHANGE PID:17786 claude-code threads: 34->22 [mem:695MB, , net_procs:4, sys:26767MB avail, swap:0MB]
[2026-01-25T21:36:59.265Z] #7 STATE_CHANGE PID:17786 claude-code S->R [mem:1554MB, , net_procs:4, sys:25756MB avail, swap:0MB]
[2026-01-25T21:36:59.362Z] #8 THREAD_CHANGE PID:17786 claude-code threads: 18->24 [mem:1555MB, , net_procs:4, sys:25752MB avail, swap:0MB]
[2026-01-25T21:36:59.845Z] #9 SPAWN PID:20064 chroma 150MB fds=11 thr=21 vsz=1847MB cpu=7.1% state=S  [mem:1557MB, , net_procs:5, sys:25859MB avail, swap:0MB]
[2026-01-25T21:37:00.040Z] #10 SPAWN PID:20069 claude-code 419MB fds=47 thr=34 vsz=72826MB cpu=52.4% state=S  [mem:1558MB, , net_procs:6, sys:25869MB avail, swap:0MB]
[2026-01-25T21:37:00.224Z] #11 SPAWN PID:20106 chroma 248MB fds=20 thr=70 vsz=5600MB cpu=89.6% state=S  [mem:1559MB, , net_procs:7, sys:25892MB avail, swap:0MB]
[2026-01-25T21:37:00.428Z] #12 ANOMALY  HIGH_THREADS: 177 total threads across all processes [mem:1561MB, , net_procs:7, sys:25903MB avail, swap:0MB]
[2026-01-25T21:37:10.680Z] #13 STATE_CHANGE PID:17786 claude-code R->S [mem:1494MB, , net_procs:7, sys:26016MB avail, swap:0MB]
[2026-01-25T21:37:10.794Z] #14 THREAD_CHANGE PID:17786 claude-code threads: 24->34 [mem:1495MB, , net_procs:7, sys:26030MB avail, swap:0MB]
[2026-01-25T21:37:11.262Z] #15 THREAD_CHANGE PID:20064 chroma threads: 21->2 [mem:1503MB, , net_procs:7, sys:26044MB avail, swap:0MB]
[2026-01-25T21:37:11.497Z] #16 THREAD_CHANGE PID:20069 claude-code threads: 34->18 [mem:1511MB, , net_procs:7, sys:26045MB avail, swap:0MB]
[2026-01-25T21:37:21.929Z] #17 STATE_CHANGE PID:17786 claude-code S->R [mem:1479MB, , net_procs:7, sys:26162MB avail, swap:0MB]
[2026-01-25T21:37:22.036Z] #18 THREAD_CHANGE PID:17786 claude-code threads: 34->19 [mem:1480MB, , net_procs:7, sys:26159MB avail, swap:0MB]
[2026-01-25T21:37:22.772Z] #19 ANOMALY  HIGH_THREADS: 133 total threads across all processes [mem:1485MB, , net_procs:7, sys:26154MB avail, swap:0MB]
[2026-01-25T21:37:33.589Z] #20 SPAWN PID:23482 claude-code 456MB fds=88 thr=34 vsz=72862MB cpu=86.4% state=R  [mem:2015MB, , net_procs:8, sys:25299MB avail, swap:0MB]
[2026-01-25T21:37:33.812Z] #21 SPAWN PID:23557 mcp-server 78MB fds=22 thr=7 vsz=11249MB cpu=9.8% state=S parent=23482(claude) [mem:2014MB, , net_procs:9, sys:25297MB avail, swap:0MB]
[2026-01-25T21:37:34.035Z] #22 ANOMALY  HIGH_THREADS: 174 total threads across all processes [mem:2014MB, , net_procs:9, sys:25322MB avail, swap:0MB]
[2026-01-25T21:37:44.273Z] #23 STATE_CHANGE PID:17786 claude-code R->S [mem:2027MB, , net_procs:9, sys:25508MB avail, swap:0MB]
[2026-01-25T21:37:45.013Z] #24 STATE_CHANGE PID:23482 claude-code R->S [mem:2021MB, , net_procs:9, sys:25519MB avail, swap:0MB]
[2026-01-25T21:37:45.112Z] #25 THREAD_CHANGE PID:23482 claude-code threads: 34->21 [mem:2021MB, , net_procs:9, sys:25526MB avail, swap:0MB]
[2026-01-25T21:38:06.581Z] #26 STATE_CHANGE PID:17786 claude-code S->R [mem:1990MB, , net_procs:9, sys:25700MB avail, swap:0MB]
[2026-01-25T21:38:17.685Z] #27 STATE_CHANGE PID:17786 claude-code R->S [mem:1965MB, , net_procs:9, sys:25741MB avail, swap:0MB]
[2026-01-25T21:38:18.013Z] #28 THREAD_CHANGE PID:17988 worker threads: 11->4 [mem:1965MB, , net_procs:9, sys:25739MB avail, swap:0MB]
[2026-01-25T21:38:18.815Z] #29 ANOMALY  HIGH_THREADS: 146 total threads across all processes [mem:1966MB, , net_procs:9, sys:25736MB avail, swap:0MB]
[2026-01-25T21:38:29.083Z] #30 STATE_CHANGE PID:17786 claude-code S->R [mem:1962MB, , net_procs:9, sys:25739MB avail, swap:0MB]
[2026-01-25T21:38:29.639Z] #31 THREAD_CHANGE PID:20069 claude-code threads: 15->8 [mem:1962MB, , net_procs:9, sys:25742MB avail, swap:0MB]
[2026-01-25T21:38:30.151Z] #32 PROGRESS  Elapsed: 00:05:05, Remaining: 03:54:55, Events: 31 [mem:1962MB, , net_procs:9, sys:25742MB avail, swap:0MB]
[2026-01-25T21:38:40.428Z] #33 STATE_CHANGE PID:17786 claude-code R->S [mem:1977MB, , net_procs:9, sys:25717MB avail, swap:0MB]
[2026-01-25T21:38:40.766Z] #34 THREAD_CHANGE PID:17988 worker threads: 3->11 [mem:1998MB, , net_procs:9, sys:25707MB avail, swap:0MB]
[2026-01-25T21:38:51.863Z] #35 THREAD_CHANGE PID:17988 worker threads: 11->4 [mem:1963MB, , net_procs:9, sys:25726MB avail, swap:0MB]
[2026-01-25T21:38:52.361Z] #36 THREAD_CHANGE PID:20069 claude-code threads: 7->15 [mem:1963MB, , net_procs:9, sys:25726MB avail, swap:0MB]
[2026-01-25T21:39:03.542Z] #37 THREAD_CHANGE PID:20069 claude-code threads: 15->8 [mem:1974MB, , net_procs:9, sys:25726MB avail, swap:0MB]
[2026-01-25T21:39:14.376Z] #38 THREAD_CHANGE PID:17988 worker threads: 3->11 [mem:1965MB, , net_procs:9, sys:25746MB avail, swap:0MB]
[2026-01-25T21:39:25.475Z] #39 THREAD_CHANGE PID:17988 worker threads: 11->4 [mem:1975MB, , net_procs:9, sys:25721MB avail, swap:0MB]
[2026-01-25T21:39:25.885Z] #40 THREAD_CHANGE PID:20069 claude-code threads: 7->15 [mem:1975MB, , net_procs:9, sys:25726MB avail, swap:0MB]
[2026-01-25T21:39:36.730Z] #41 THREAD_CHANGE PID:17988 worker threads: 4->11 [mem:1970MB, , net_procs:9, sys:25718MB avail, swap:0MB]
[2026-01-25T21:39:37.120Z] #42 THREAD_CHANGE PID:20069 claude-code threads: 15->8 [mem:1969MB, , net_procs:9, sys:25724MB avail, swap:0MB]
[2026-01-25T21:39:47.974Z] #43 THREAD_CHANGE PID:17988 worker threads: 11->4 [mem:1990MB, , net_procs:9, sys:25703MB avail, swap:0MB]
[2026-01-25T21:39:48.339Z] #44 THREAD_CHANGE PID:20069 claude-code threads: 8->15 [mem:1991MB, , net_procs:9, sys:25705MB avail, swap:0MB]
[2026-01-25T21:39:59.460Z] #45 THREAD_CHANGE PID:20069 claude-code threads: 15->8 [mem:1976MB, , net_procs:9, sys:25731MB avail, swap:0MB]
[2026-01-25T21:40:10.105Z] #46 STATE_CHANGE PID:17786 claude-code S->R [mem:1978MB, , net_procs:9, sys:25710MB avail, swap:0MB]
[2026-01-25T21:40:10.397Z] #47 THREAD_CHANGE PID:17988 worker threads: 3->11 [mem:1979MB, , net_procs:9, sys:25710MB avail, swap:0MB]
[2026-01-25T21:40:21.301Z] #48 STATE_CHANGE PID:17786 claude-code R->S [mem:1973MB, , net_procs:9, sys:25730MB avail, swap:0MB]
[2026-01-25T21:40:21.677Z] #49 THREAD_CHANGE PID:17988 worker threads: 11->4 [mem:1974MB, , net_procs:9, sys:25728MB avail, swap:0MB]
[2026-01-25T21:40:22.119Z] #50 THREAD_CHANGE PID:20069 claude-code threads: 7->15 [mem:1974MB, , net_procs:9, sys:25727MB avail, swap:0MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-26T01:20:47.000Z] #1676 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1418MB, , net_procs:6, sys:26327MB avail, swap:0MB]
[2026-01-26T01:20:57.808Z] #1677 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1418MB, , net_procs:6, sys:26325MB avail, swap:0MB]
[2026-01-26T01:21:19.249Z] #1678 THREAD_CHANGE PID:17988 worker threads: 5->15 [mem:1420MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:21:19.856Z] #1679 PROGRESS  Elapsed: 03:47:54, Remaining: 00:12:06, Events: 1678 [mem:1420MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:22:02.009Z] #1680 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:22:44.821Z] #1681 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26323MB avail, swap:0MB]
[2026-01-26T01:22:55.554Z] #1682 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:23:17.121Z] #1683 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26324MB avail, swap:0MB]
[2026-01-26T01:23:28.018Z] #1684 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26322MB avail, swap:0MB]
[2026-01-26T01:23:49.506Z] #1685 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26326MB avail, swap:0MB]
[2026-01-26T01:24:00.313Z] #1686 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:24:21.761Z] #1687 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26327MB avail, swap:0MB]
[2026-01-26T01:24:32.539Z] #1688 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26322MB avail, swap:0MB]
[2026-01-26T01:24:43.279Z] #1689 THREAD_CHANGE PID:17988 worker threads: 6->13 [mem:1420MB, , net_procs:6, sys:26323MB avail, swap:0MB]
[2026-01-26T01:24:54.101Z] #1690 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26323MB avail, swap:0MB]
[2026-01-26T01:25:15.546Z] #1691 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:25:26.318Z] #1692 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:25:47.864Z] #1693 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26325MB avail, swap:0MB]
[2026-01-26T01:25:58.632Z] #1694 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26324MB avail, swap:0MB]
[2026-01-26T01:26:20.020Z] #1695 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:26:20.634Z] #1696 PROGRESS  Elapsed: 03:52:55, Remaining: 00:07:05, Events: 1695 [mem:1420MB, , net_procs:6, sys:26326MB avail, swap:0MB]
[2026-01-26T01:26:30.867Z] #1697 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26326MB avail, swap:0MB]
[2026-01-26T01:26:52.266Z] #1698 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26324MB avail, swap:0MB]
[2026-01-26T01:27:03.090Z] #1699 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26330MB avail, swap:0MB]
[2026-01-26T01:27:13.840Z] #1700 THREAD_CHANGE PID:17988 worker threads: 6->13 [mem:1420MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:27:24.638Z] #1701 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:27:46.218Z] #1702 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1421MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:27:56.951Z] #1703 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26327MB avail, swap:0MB]
[2026-01-26T01:28:18.424Z] #1704 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1421MB, , net_procs:6, sys:26335MB avail, swap:0MB]
[2026-01-26T01:28:29.194Z] #1705 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1421MB, , net_procs:6, sys:26332MB avail, swap:0MB]
[2026-01-26T01:28:50.643Z] #1706 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26325MB avail, swap:0MB]
[2026-01-26T01:29:01.390Z] #1707 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:29:22.751Z] #1708 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26327MB avail, swap:0MB]
[2026-01-26T01:29:33.539Z] #1709 THREAD_CHANGE PID:17988 worker threads: 13->5 [mem:1420MB, , net_procs:6, sys:26322MB avail, swap:0MB]
[2026-01-26T01:29:44.409Z] #1710 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26331MB avail, swap:0MB]
[2026-01-26T01:29:55.145Z] #1711 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26324MB avail, swap:0MB]
[2026-01-26T01:30:16.606Z] #1712 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26323MB avail, swap:0MB]
[2026-01-26T01:30:27.350Z] #1713 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26324MB avail, swap:0MB]
[2026-01-26T01:30:48.674Z] #1714 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26328MB avail, swap:0MB]
[2026-01-26T01:30:59.386Z] #1715 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26324MB avail, swap:0MB]
[2026-01-26T01:31:20.745Z] #1716 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:31:21.444Z] #1717 PROGRESS  Elapsed: 03:57:56, Remaining: 00:02:04, Events: 1716 [mem:1420MB, , net_procs:6, sys:26326MB avail, swap:0MB]
[2026-01-26T01:31:31.656Z] #1718 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26327MB avail, swap:0MB]
[2026-01-26T01:32:14.446Z] #1719 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26326MB avail, swap:0MB]
[2026-01-26T01:32:25.209Z] #1720 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26326MB avail, swap:0MB]
[2026-01-26T01:32:46.537Z] #1721 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26337MB avail, swap:0MB]
[2026-01-26T01:32:57.285Z] #1722 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26334MB avail, swap:0MB]
[2026-01-26T01:33:18.662Z] #1723 THREAD_CHANGE PID:17988 worker threads: 5->13 [mem:1420MB, , net_procs:6, sys:26334MB avail, swap:0MB]
[2026-01-26T01:33:29.384Z] #1724 THREAD_CHANGE PID:17988 worker threads: 13->6 [mem:1420MB, , net_procs:6, sys:26329MB avail, swap:0MB]
[2026-01-26T01:33:30.018Z] #1725 SESSION_END  Benchmark completed after 04:00:05 [mem:1420MB, , net_procs:6, sys:26329MB avail, swap:0MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213325_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_213325_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213325_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213325_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_213325_events.jsonl
```

---

_Report generated at 2026-01-26 01:33:30 UTC_
