# Claude Code Process Benchmark Report

## Session Metadata

| Field | Value |
|-------|-------|
| Session ID | `20260125_194025` |
| Start Time | 2026-01-25 19:40:25 UTC |
| End Time | 2026-01-25 20:42:20 UTC |
| Duration | 01:01:55 (3715 seconds) |
| Poll Interval | 10s |
| Total Events | 289 |
| Anomalies | 59 |

## Raw Data Files

- **Event Log (JSONL):** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_194025_events.jsonl`
- **Timeline Log:** `/home/dev/projects/claude-mem/monitors/logs/session_20260125_194025_timeline.log`
- **This Report:** `/home/dev/projects/claude-mem/monitors/logs/benchmark_20260125_194025_report.md`

---

## Event Summary

```
    156 STATE_CHANGE
     59 ANOMALY
     42 SPAWN
     18 EXIT
     12 PROGRESS
      1 SESSION_START
      1 SESSION_END
```

## Peak Values

```json
{
  "peak_total_mem_mb": 8919,
  "peak_swap_mb": 370,
  "min_available_mb": 15228,
  "peak_claude_count": null,
  "peak_mcp_count": null
}
```

---

## All Anomalies

```
2026-01-25T19:40:29.477Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T19:40:29.583Z | High memory usage: 7891MB (threshold: 6000MB)
2026-01-25T19:41:04.342Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T19:41:27.578Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T19:41:39.442Z | High Claude instance count: 16 (threshold: 5)
2026-01-25T19:41:39.548Z | High memory usage: 8382MB (threshold: 6000MB)
2026-01-25T19:43:01.882Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T19:43:02.013Z | High memory usage: 7871MB (threshold: 6000MB)
2026-01-25T19:44:00.526Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T19:44:36.249Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T19:45:57.472Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T19:46:55.541Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T19:46:55.655Z | High memory usage: 8499MB (threshold: 6000MB)
2026-01-25T19:47:53.694Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T19:47:53.801Z | High memory usage: 7934MB (threshold: 6000MB)
2026-01-25T19:49:37.639Z | High memory usage: 8035MB (threshold: 6000MB)
2026-01-25T19:49:49.212Z | High memory usage: 7992MB (threshold: 6000MB)
2026-01-25T19:50:00.762Z | High memory usage: 8001MB (threshold: 6000MB)
2026-01-25T19:50:12.400Z | High memory usage: 7988MB (threshold: 6000MB)
2026-01-25T19:50:58.741Z | High memory usage: 8000MB (threshold: 6000MB)
2026-01-25T19:51:10.426Z | High memory usage: 7950MB (threshold: 6000MB)
2026-01-25T19:52:20.331Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T19:52:55.695Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T19:54:39.398Z | High memory usage: 8000MB (threshold: 6000MB)
2026-01-25T19:54:51.125Z | High memory usage: 7968MB (threshold: 6000MB)
2026-01-25T19:55:02.866Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T19:56:00.823Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T19:56:00.930Z | High memory usage: 8022MB (threshold: 6000MB)
2026-01-25T19:56:12.633Z | High memory usage: 7983MB (threshold: 6000MB)
2026-01-25T19:56:24.449Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T19:57:10.763Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T19:57:10.884Z | High memory usage: 8084MB (threshold: 6000MB)
2026-01-25T19:57:34.303Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T19:57:34.417Z | High memory usage: 7575MB (threshold: 6000MB)
2026-01-25T20:15:57.035Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T20:15:57.141Z | High memory usage: 8068MB (threshold: 6000MB)
2026-01-25T20:19:03.580Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T20:19:15.364Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T20:20:01.782Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T20:23:58.556Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T20:23:58.680Z | High memory usage: 7687MB (threshold: 6000MB)
2026-01-25T20:24:10.525Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T20:26:06.014Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T20:26:06.121Z | High memory usage: 8144MB (threshold: 6000MB)
2026-01-25T20:27:04.434Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T20:27:04.565Z | High memory usage: 7656MB (threshold: 6000MB)
2026-01-25T20:28:36.433Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T20:28:36.536Z | High memory usage: 8193MB (threshold: 6000MB)
2026-01-25T20:29:11.158Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T20:29:11.269Z | High memory usage: 7653MB (threshold: 6000MB)
2026-01-25T20:29:57.379Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T20:29:57.480Z | High memory usage: 8208MB (threshold: 6000MB)
2026-01-25T20:31:30.003Z | High memory usage: 7999MB (threshold: 6000MB)
2026-01-25T20:31:41.688Z | High Claude instance count: 13 (threshold: 5)
2026-01-25T20:35:19.236Z | High Claude instance count: 14 (threshold: 5)
2026-01-25T20:35:19.352Z | High memory usage: 8081MB (threshold: 6000MB)
2026-01-25T20:41:08.112Z | High Claude instance count: 15 (threshold: 5)
2026-01-25T20:41:55.446Z | High Claude instance count: 16 (threshold: 5)
2026-01-25T20:42:18.993Z | High Claude instance count: 17 (threshold: 5)
```

---

## Process Spawns (All)

```
2026-01-25T19:40:25.561Z | PID 1895927 | claude-code 706MB cpu=8.6% state=S 
2026-01-25T19:40:25.749Z | PID 1896009 | mcp-server 67MB cpu=0.0% state=S parent=1895927(claude)
2026-01-25T19:40:25.904Z | PID 2176912 | claude-code 942MB cpu=40.5% state=R 
2026-01-25T19:40:26.106Z | PID 2176975 | mcp-server 67MB cpu=0.0% state=S parent=2176912(claude)
2026-01-25T19:40:26.286Z | PID 2177149 | worker 204MB cpu=1.0% state=S 
2026-01-25T19:40:26.474Z | PID 2177204 | mcp-server 67MB cpu=0.0% state=S parent=2177149(bun)
2026-01-25T19:40:26.643Z | PID 2177439 | chroma 44MB cpu=0.0% state=S 
2026-01-25T19:40:26.844Z | PID 2177481 | chroma 395MB cpu=11.4% state=S 
2026-01-25T19:40:27.010Z | PID 2218628 | claude-code 480MB cpu=1.4% state=S 
2026-01-25T19:40:27.173Z | PID 2324436 | claude-code 487MB cpu=1.1% state=S 
2026-01-25T19:40:27.335Z | PID 2330749 | claude-code 489MB cpu=0.6% state=S 
2026-01-25T19:40:27.525Z | PID 2333496 | claude-code 404MB cpu=0.8% state=S 
2026-01-25T19:40:27.689Z | PID 2334120 | claude-code 406MB cpu=0.6% state=S 
2026-01-25T19:40:27.864Z | PID 2341546 | claude-code 400MB cpu=0.5% state=S 
2026-01-25T19:40:28.024Z | PID 2352236 | claude-code 417MB cpu=0.6% state=S 
2026-01-25T19:40:28.206Z | PID 2354907 | claude-code 399MB cpu=0.6% state=S 
2026-01-25T19:40:28.375Z | PID 2356757 | claude-code 414MB cpu=0.4% state=S 
2026-01-25T19:40:28.548Z | PID 2400755 | claude-code 504MB cpu=0.6% state=S 
2026-01-25T19:40:28.699Z | PID 2413534 | claude-code 535MB cpu=3.7% state=S 
2026-01-25T19:40:28.904Z | PID 2413583 | mcp-server 67MB cpu=0.0% state=S parent=2413534(claude)
2026-01-25T19:40:29.104Z | PID 2556094 | claude-code 394MB cpu=17.9% state=S 
2026-01-25T19:40:29.277Z | PID 2559397 | claude-code 3MB cpu=0.0% state=S 
2026-01-25T19:41:27.374Z | PID 2582958 | claude-code 3MB cpu=0.0% state=S 
2026-01-25T19:41:39.225Z | PID 2584453 | claude-code 440MB cpu=38.6% state=S 
2026-01-25T19:41:51.208Z | PID 2586017 | claude-code 3MB cpu=0.0% state=S 
2026-01-25T19:45:57.268Z | PID 2616976 | claude-code 474MB cpu=45.6% state=R 
2026-01-25T19:46:55.324Z | PID 2626113 | claude-code 456MB cpu=35.8% state=R 
2026-01-25T19:52:20.102Z | PID 2673423 | claude-code 3MB cpu=0.2% state=S 
2026-01-25T19:52:32.004Z | PID 2675024 | claude-code 3MB cpu=0.0% state=S 
2026-01-25T19:56:00.575Z | PID 2700409 | claude-code 474MB cpu=32.7% state=R 
2026-01-25T19:57:10.532Z | PID 2708341 | claude-code 487MB cpu=38.6% state=S 
2026-01-25T20:15:56.838Z | PID 2827563 | claude-code 469MB cpu=37.9% state=S 
2026-01-25T20:19:03.350Z | PID 2852972 | claude-code 3MB cpu=0.0% state=S 
2026-01-25T20:20:01.528Z | PID 2862141 | claude-code 3MB cpu=0.0% state=S 
2026-01-25T20:20:36.767Z | PID 2866632 | claude-code 3MB cpu=0.0% state=S 
2026-01-25T20:26:05.805Z | PID 2916440 | claude-code 459MB cpu=29.2% state=S 
2026-01-25T20:28:36.211Z | PID 2933278 | claude-code 482MB cpu=40.9% state=S 
2026-01-25T20:29:57.154Z | PID 2942480 | claude-code 492MB cpu=47.1% state=S 
2026-01-25T20:35:19.010Z | PID 2977657 | claude-code 453MB cpu=52.5% state=S 
2026-01-25T20:41:07.901Z | PID 3023279 | claude-code 484MB cpu=38.1% state=S 
2026-01-25T20:41:55.213Z | PID 3031756 | claude-code 1MB cpu=0.0% state=S 
2026-01-25T20:42:18.725Z | PID 3036883 | claude-code 3MB cpu=0.0% state=S 
```


---

## Process Exits (All)

```
2026-01-25T19:41:04.132Z | PID 2559397 | claude-code 3MB lived 35s 
2026-01-25T19:41:51.344Z | PID 2582958 | claude-code 3MB lived 24s 
2026-01-25T19:43:01.674Z | PID 2556094 | claude-code 417MB lived 152s 
2026-01-25T19:44:00.271Z | PID 2586017 | claude-code 3MB lived 129s 
2026-01-25T19:44:36.036Z | PID 2584453 | claude-code 408MB lived 177s 
2026-01-25T19:47:53.500Z | PID 2626113 | claude-code 427MB lived 58s 
2026-01-25T19:52:32.126Z | PID 2673423 | claude-code 3MB lived 12s 
2026-01-25T19:52:55.481Z | PID 2675024 | claude-code 3MB lived 23s 
2026-01-25T19:55:02.630Z | PID 2616976 | claude-code 425MB lived 545s 
2026-01-25T19:56:24.218Z | PID 2700409 | claude-code 434MB lived 24s 
2026-01-25T19:57:34.090Z | PID 2708341 | claude-code 465MB lived 24s 
2026-01-25T20:19:15.162Z | PID 2852972 | claude-code 3MB lived 12s 
2026-01-25T20:20:36.924Z | PID 2862141 | claude-code 3MB lived 35s 
2026-01-25T20:23:58.319Z | PID 2827563 | claude-code 407MB lived 482s 
2026-01-25T20:24:10.290Z | PID 2866632 | claude-code 3MB lived 214s 
2026-01-25T20:27:04.215Z | PID 2916440 | claude-code 414MB lived 59s 
2026-01-25T20:29:10.952Z | PID 2933278 | claude-code 433MB lived 34s 
2026-01-25T20:31:41.473Z | PID 2942480 | claude-code 403MB lived 104s 
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
2026-01-25T19:41:14.704Z | PID 2176912 | claude-code R->S
2026-01-25T19:41:37.925Z | PID 2176912 | claude-code S->R
2026-01-25T19:41:49.885Z | PID 2176912 | claude-code R->S
2026-01-25T19:42:02.816Z | PID 2413534 | claude-code S->R
2026-01-25T19:42:14.524Z | PID 2413534 | claude-code R->S
2026-01-25T19:42:25.223Z | PID 2176912 | claude-code S->R
2026-01-25T19:42:26.287Z | PID 2413534 | claude-code S->R
2026-01-25T19:42:37.006Z | PID 2176912 | claude-code R->S
2026-01-25T19:42:38.033Z | PID 2413534 | claude-code R->S
2026-01-25T19:43:13.374Z | PID 2413534 | claude-code S->R
2026-01-25T19:43:25.083Z | PID 2413534 | claude-code R->S
2026-01-25T19:43:47.426Z | PID 2176912 | claude-code S->R
2026-01-25T19:43:59.089Z | PID 2176912 | claude-code R->S
2026-01-25T19:44:11.309Z | PID 2324436 | claude-code S->R
2026-01-25T19:44:22.569Z | PID 2176912 | claude-code S->R
2026-01-25T19:44:23.114Z | PID 2324436 | claude-code R->S
2026-01-25T19:44:24.027Z | PID 2584453 | claude-code S->R
2026-01-25T19:44:34.640Z | PID 2176912 | claude-code R->S
2026-01-25T19:44:46.625Z | PID 2176912 | claude-code S->R
2026-01-25T19:44:58.185Z | PID 2176912 | claude-code R->S
2026-01-25T19:45:21.141Z | PID 2176912 | claude-code S->R
2026-01-25T19:45:22.229Z | PID 2413534 | claude-code S->R
2026-01-25T19:45:32.776Z | PID 2176912 | claude-code R->S
2026-01-25T19:45:33.874Z | PID 2413534 | claude-code R->S
2026-01-25T19:45:56.038Z | PID 2176912 | claude-code S->R
2026-01-25T19:46:07.860Z | PID 2176912 | claude-code R->S
2026-01-25T19:46:09.104Z | PID 2616976 | claude-code R->S
2026-01-25T19:46:19.561Z | PID 2176912 | claude-code S->R
2026-01-25T19:46:30.955Z | PID 1895927 | claude-code S->R
2026-01-25T19:46:42.477Z | PID 1895927 | claude-code R->S
2026-01-25T19:47:07.094Z | PID 2626113 | claude-code R->S
2026-01-25T19:47:17.622Z | PID 2176912 | claude-code R->S
2026-01-25T19:47:29.158Z | PID 2176912 | claude-code S->R
2026-01-25T19:47:52.316Z | PID 2176912 | claude-code R->D
2026-01-25T19:48:04.162Z | PID 2176912 | claude-code D->R
2026-01-25T19:48:15.682Z | PID 2176912 | claude-code R->S
2026-01-25T19:48:27.265Z | PID 2176912 | claude-code S->R
2026-01-25T19:49:01.740Z | PID 2176912 | claude-code R->S
2026-01-25T19:49:24.784Z | PID 2176912 | claude-code S->D
2026-01-25T19:49:36.283Z | PID 2176912 | claude-code D->R
2026-01-25T19:50:11.090Z | PID 2176912 | claude-code R->S
2026-01-25T19:50:22.747Z | PID 2176912 | claude-code S->R
2026-01-25T19:50:46.971Z | PID 2616976 | claude-code S->R
2026-01-25T19:50:58.523Z | PID 2616976 | claude-code R->S
2026-01-25T19:51:10.218Z | PID 2616976 | claude-code S->R
2026-01-25T19:51:20.767Z | PID 2176912 | claude-code R->S
2026-01-25T19:51:21.963Z | PID 2616976 | claude-code R->S
2026-01-25T19:51:32.422Z | PID 2176912 | claude-code S->R
2026-01-25T19:51:44.334Z | PID 2218628 | claude-code S->R
2026-01-25T19:51:45.190Z | PID 2616976 | claude-code S->R
2026-01-25T19:51:56.023Z | PID 2218628 | claude-code R->S
2026-01-25T19:51:56.880Z | PID 2616976 | claude-code R->S
2026-01-25T19:52:07.333Z | PID 2176912 | claude-code R->S
2026-01-25T19:52:30.686Z | PID 2176912 | claude-code S->R
2026-01-25T19:52:42.589Z | PID 2176912 | claude-code R->S
2026-01-25T19:52:54.234Z | PID 2176912 | claude-code S->R
2026-01-25T19:54:03.402Z | PID 2176912 | claude-code R->S
2026-01-25T19:54:26.449Z | PID 2176912 | claude-code S->R
2026-01-25T19:54:38.025Z | PID 2176912 | claude-code R->S
2026-01-25T19:54:50.893Z | PID 2616976 | claude-code S->R
2026-01-25T19:55:48.822Z | PID 2413534 | claude-code S->R
2026-01-25T19:56:00.326Z | PID 2413534 | claude-code R->S
2026-01-25T19:56:12.426Z | PID 2700409 | claude-code R->S
2026-01-25T19:56:57.754Z | PID 2176912 | claude-code S->R
2026-01-25T19:57:21.256Z | PID 2176912 | claude-code R->S
2026-01-25T19:59:28.423Z | PID 2176912 | claude-code S->R
2026-01-25T19:59:39.949Z | PID 2176912 | claude-code R->D
2026-01-25T19:59:51.580Z | PID 2176912 | claude-code D->S
2026-01-25T20:05:02.430Z | PID 2176912 | claude-code S->R
2026-01-25T20:05:14.071Z | PID 2176912 | claude-code R->S
2026-01-25T20:08:40.724Z | PID 2176912 | claude-code S->R
2026-01-25T20:08:52.281Z | PID 2176912 | claude-code R->S
2026-01-25T20:10:58.021Z | PID 1895927 | claude-code S->D
2026-01-25T20:11:09.489Z | PID 1895927 | claude-code D->S
2026-01-25T20:12:17.951Z | PID 2176912 | claude-code S->R
2026-01-25T20:12:29.418Z | PID 2176912 | claude-code R->S
2026-01-25T20:15:55.425Z | PID 2176912 | claude-code S->R
2026-01-25T20:16:19.002Z | PID 1895927 | claude-code S->R
2026-01-25T20:16:30.636Z | PID 1895927 | claude-code R->S
2026-01-25T20:16:42.317Z | PID 2176912 | claude-code R->D
2026-01-25T20:16:53.938Z | PID 2176912 | claude-code D->R
2026-01-25T20:17:28.752Z | PID 2176912 | claude-code R->S
2026-01-25T20:18:15.141Z | PID 1895927 | claude-code S->R
2026-01-25T20:18:26.795Z | PID 1895927 | claude-code R->S
2026-01-25T20:18:27.021Z | PID 2176912 | claude-code S->R
2026-01-25T20:18:39.833Z | PID 2827563 | claude-code S->R
2026-01-25T20:18:51.475Z | PID 2827563 | claude-code R->S
2026-01-25T20:20:13.323Z | PID 2827563 | claude-code S->R
2026-01-25T20:20:24.972Z | PID 2827563 | claude-code R->S
2026-01-25T20:22:45.312Z | PID 2176912 | claude-code R->S
2026-01-25T20:22:57.270Z | PID 2176912 | claude-code S->R
2026-01-25T20:23:21.201Z | PID 2176912 | claude-code R->S
2026-01-25T20:23:34.272Z | PID 2827563 | claude-code S->R
2026-01-25T20:23:44.855Z | PID 2176912 | claude-code S->R
2026-01-25T20:23:46.108Z | PID 2413534 | claude-code S->R
2026-01-25T20:23:46.362Z | PID 2827563 | claude-code R->S
2026-01-25T20:23:58.051Z | PID 2413534 | claude-code R->S
2026-01-25T20:24:09.056Z | PID 2176912 | claude-code R->S
2026-01-25T20:25:18.133Z | PID 2176912 | claude-code S->R
2026-01-25T20:25:29.771Z | PID 2176912 | claude-code R->S
```

---

## Memory Trajectory (sampled every 10 events)

```
2026-01-25T19:40:27.010Z | total:7910MB | swap:370MB | avail:18522MB | 
2026-01-25T19:40:28.699Z | total:7922MB | swap:370MB | avail:18964MB | 
2026-01-25T19:40:29.477Z | total:7913MB | swap:370MB | avail:18790MB | 
2026-01-25T19:40:29.583Z | total:7913MB | swap:370MB | avail:18859MB | 
2026-01-25T19:41:04.342Z | total:7869MB | swap:370MB | avail:20305MB | 
2026-01-25T19:41:27.578Z | total:7920MB | swap:370MB | avail:20080MB | 
2026-01-25T19:41:39.442Z | total:8402MB | swap:370MB | avail:18820MB | 
2026-01-25T19:41:39.548Z | total:8403MB | swap:370MB | avail:18819MB | 
2026-01-25T19:42:25.223Z | total:8307MB | swap:370MB | avail:20154MB | 
2026-01-25T19:43:01.882Z | total:7887MB | swap:370MB | avail:20539MB | 
2026-01-25T19:43:02.013Z | total:7888MB | swap:370MB | avail:20537MB | 
2026-01-25T19:43:59.089Z | total:7953MB | swap:370MB | avail:20446MB | 
2026-01-25T19:44:00.526Z | total:7964MB | swap:370MB | avail:20437MB | 
2026-01-25T19:44:36.249Z | total:7464MB | swap:370MB | avail:20966MB | 
2026-01-25T19:44:46.625Z | total:7469MB | swap:370MB | avail:20981MB | 
2026-01-25T19:45:57.472Z | total:7983MB | swap:370MB | avail:20427MB | 
2026-01-25T19:46:07.860Z | total:8008MB | swap:370MB | avail:19834MB | 
2026-01-25T19:46:55.541Z | total:8540MB | swap:370MB | avail:19634MB | 
2026-01-25T19:46:55.655Z | total:8538MB | swap:370MB | avail:19636MB | 
2026-01-25T19:47:29.158Z | total:8426MB | swap:370MB | avail:19893MB | 
2026-01-25T19:47:53.694Z | total:7937MB | swap:370MB | avail:20396MB | 
2026-01-25T19:47:53.801Z | total:7937MB | swap:370MB | avail:20386MB | 
2026-01-25T19:49:36.283Z | total:8049MB | swap:370MB | avail:20261MB | 
2026-01-25T19:49:37.639Z | total:8011MB | swap:370MB | avail:20332MB | 
2026-01-25T19:49:49.212Z | total:8027MB | swap:370MB | avail:20389MB | 
2026-01-25T19:50:00.762Z | total:7970MB | swap:370MB | avail:20445MB | 
2026-01-25T19:50:12.400Z | total:8014MB | swap:370MB | avail:20461MB | 
2026-01-25T19:50:58.741Z | total:7968MB | swap:370MB | avail:20527MB | 
2026-01-25T19:51:10.426Z | total:7970MB | swap:370MB | avail:20537MB | 
2026-01-25T19:52:07.333Z | total:7962MB | swap:370MB | avail:20436MB | 
2026-01-25T19:52:20.331Z | total:7980MB | swap:370MB | avail:20351MB | 
2026-01-25T19:52:55.695Z | total:7997MB | swap:370MB | avail:20486MB | 
2026-01-25T19:54:03.402Z | total:8005MB | swap:370MB | avail:20391MB | 
2026-01-25T19:54:39.398Z | total:8017MB | swap:370MB | avail:20455MB | 
2026-01-25T19:54:51.125Z | total:7982MB | swap:370MB | avail:20525MB | 
2026-01-25T19:55:02.866Z | total:7551MB | swap:370MB | avail:20826MB | 
2026-01-25T19:56:00.326Z | total:8033MB | swap:370MB | avail:20370MB | 
2026-01-25T19:56:00.823Z | total:8035MB | swap:370MB | avail:20364MB | 
2026-01-25T19:56:00.930Z | total:8035MB | swap:370MB | avail:20363MB | 
2026-01-25T19:56:12.633Z | total:7991MB | swap:370MB | avail:20414MB | 
2026-01-25T19:56:24.449Z | total:7573MB | swap:370MB | avail:20815MB | 
2026-01-25T19:57:10.763Z | total:8066MB | swap:370MB | avail:20269MB | 
2026-01-25T19:57:10.884Z | total:8068MB | swap:370MB | avail:20267MB | 
2026-01-25T19:57:34.303Z | total:7589MB | swap:370MB | avail:20796MB | 
2026-01-25T19:57:34.417Z | total:7589MB | swap:370MB | avail:20796MB | 
2026-01-25T20:05:02.430Z | total:7574MB | swap:370MB | avail:20865MB | 
2026-01-25T20:15:55.425Z | total:8078MB | swap:370MB | avail:20323MB | 
2026-01-25T20:15:57.035Z | total:8094MB | swap:370MB | avail:20234MB | 
2026-01-25T20:15:57.141Z | total:8093MB | swap:370MB | avail:20350MB | 
2026-01-25T20:18:15.141Z | total:8087MB | swap:370MB | avail:20270MB | 
2026-01-25T20:19:03.580Z | total:8088MB | swap:370MB | avail:19309MB | 
2026-01-25T20:19:15.364Z | total:8130MB | swap:370MB | avail:20301MB | 
2026-01-25T20:20:01.782Z | total:8107MB | swap:370MB | avail:20001MB | 
2026-01-25T20:23:44.855Z | total:8130MB | swap:370MB | avail:18702MB | 
2026-01-25T20:23:58.556Z | total:7711MB | swap:370MB | avail:19013MB | 
2026-01-25T20:23:58.680Z | total:7712MB | swap:370MB | avail:18950MB | 
2026-01-25T20:24:10.525Z | total:7731MB | swap:370MB | avail:20000MB | 
2026-01-25T20:25:18.133Z | total:7695MB | swap:370MB | avail:20727MB | 
2026-01-25T20:26:06.014Z | total:8165MB | swap:370MB | avail:20165MB | 
2026-01-25T20:26:06.121Z | total:8165MB | swap:370MB | avail:20126MB | 
2026-01-25T20:26:29.257Z | total:8183MB | swap:370MB | avail:20275MB | 
2026-01-25T20:27:04.434Z | total:7671MB | swap:370MB | avail:20697MB | 
2026-01-25T20:27:04.565Z | total:7671MB | swap:370MB | avail:20697MB | 
2026-01-25T20:28:36.433Z | total:8212MB | swap:370MB | avail:20027MB | 
2026-01-25T20:28:36.536Z | total:8213MB | swap:370MB | avail:19954MB | 
2026-01-25T20:29:10.952Z | total:7671MB | swap:370MB | avail:20689MB | 
2026-01-25T20:29:11.158Z | total:7672MB | swap:370MB | avail:20695MB | 
2026-01-25T20:29:11.269Z | total:7672MB | swap:370MB | avail:20695MB | 
2026-01-25T20:29:57.379Z | total:8231MB | swap:370MB | avail:20104MB | 
2026-01-25T20:29:57.480Z | total:8232MB | swap:370MB | avail:20102MB | 
2026-01-25T20:30:53.964Z | total:8136MB | swap:370MB | avail:20340MB | 
2026-01-25T20:31:30.003Z | total:8017MB | swap:370MB | avail:20456MB | 
2026-01-25T20:31:41.688Z | total:7615MB | swap:370MB | avail:20749MB | 
2026-01-25T20:35:18.783Z | total:8094MB | swap:370MB | avail:20219MB | 
2026-01-25T20:35:19.236Z | total:8098MB | swap:370MB | avail:20225MB | 
2026-01-25T20:35:19.352Z | total:8099MB | swap:370MB | avail:20233MB | 
2026-01-25T20:36:40.255Z | total:8079MB | swap:370MB | avail:20393MB | 
2026-01-25T20:38:59.637Z | total:8209MB | swap:370MB | avail:20151MB | 
2026-01-25T20:40:31.892Z | total:8258MB | swap:370MB | avail:20164MB | 
2026-01-25T20:41:08.112Z | total:8837MB | swap:370MB | avail:19297MB | 
2026-01-25T20:41:43.226Z | total:8730MB | swap:370MB | avail:19551MB | 
2026-01-25T20:41:55.446Z | total:8766MB | swap:370MB | avail:19389MB | 
2026-01-25T20:42:18.993Z | total:8701MB | swap:370MB | avail:18846MB | 
```

---

## Timeline (First 50 events)

```
[2026-01-25T19:40:25.358Z] #1 SESSION_START  Benchmark started, duration: 4h (14400 s), poll interval: 10s [mem:7900MB, , sys:18773MB avail, swap:370MB]
[2026-01-25T19:40:25.561Z] #2 SPAWN PID:1895927 claude-code 706MB cpu=8.6% state=S  [mem:7900MB, , sys:18627MB avail, swap:370MB]
[2026-01-25T19:40:25.749Z] #3 SPAWN PID:1896009 mcp-server 67MB cpu=0.0% state=S parent=1895927(claude) [mem:7903MB, , sys:18684MB avail, swap:370MB]
[2026-01-25T19:40:25.904Z] #4 SPAWN PID:2176912 claude-code 942MB cpu=40.5% state=R  [mem:7903MB, , sys:18664MB avail, swap:370MB]
[2026-01-25T19:40:26.106Z] #5 SPAWN PID:2176975 mcp-server 67MB cpu=0.0% state=S parent=2176912(claude) [mem:7908MB, , sys:18595MB avail, swap:370MB]
[2026-01-25T19:40:26.286Z] #6 SPAWN PID:2177149 worker 204MB cpu=1.0% state=S  [mem:7908MB, , sys:18519MB avail, swap:370MB]
[2026-01-25T19:40:26.474Z] #7 SPAWN PID:2177204 mcp-server 67MB cpu=0.0% state=S parent=2177149(bun) [mem:7908MB, , sys:18573MB avail, swap:370MB]
[2026-01-25T19:40:26.643Z] #8 SPAWN PID:2177439 chroma 44MB cpu=0.0% state=S  [mem:7909MB, , sys:18492MB avail, swap:370MB]
[2026-01-25T19:40:26.844Z] #9 SPAWN PID:2177481 chroma 395MB cpu=11.4% state=S  [mem:7908MB, , sys:18588MB avail, swap:370MB]
[2026-01-25T19:40:27.010Z] #10 SPAWN PID:2218628 claude-code 480MB cpu=1.4% state=S  [mem:7910MB, , sys:18522MB avail, swap:370MB]
[2026-01-25T19:40:27.173Z] #11 SPAWN PID:2324436 claude-code 487MB cpu=1.1% state=S  [mem:7910MB, , sys:18468MB avail, swap:370MB]
[2026-01-25T19:40:27.335Z] #12 SPAWN PID:2330749 claude-code 489MB cpu=0.6% state=S  [mem:7911MB, , sys:18377MB avail, swap:370MB]
[2026-01-25T19:40:27.525Z] #13 SPAWN PID:2333496 claude-code 404MB cpu=0.8% state=S  [mem:7912MB, , sys:18294MB avail, swap:370MB]
[2026-01-25T19:40:27.689Z] #14 SPAWN PID:2334120 claude-code 406MB cpu=0.6% state=S  [mem:7912MB, , sys:18249MB avail, swap:370MB]
[2026-01-25T19:40:27.864Z] #15 SPAWN PID:2341546 claude-code 400MB cpu=0.5% state=S  [mem:7914MB, , sys:18230MB avail, swap:370MB]
[2026-01-25T19:40:28.024Z] #16 SPAWN PID:2352236 claude-code 417MB cpu=0.6% state=S  [mem:7914MB, , sys:18466MB avail, swap:370MB]
[2026-01-25T19:40:28.206Z] #17 SPAWN PID:2354907 claude-code 399MB cpu=0.6% state=S  [mem:7916MB, , sys:18646MB avail, swap:370MB]
[2026-01-25T19:40:28.375Z] #18 SPAWN PID:2356757 claude-code 414MB cpu=0.4% state=S  [mem:7919MB, , sys:18590MB avail, swap:370MB]
[2026-01-25T19:40:28.548Z] #19 SPAWN PID:2400755 claude-code 504MB cpu=0.6% state=S  [mem:7920MB, , sys:18961MB avail, swap:370MB]
[2026-01-25T19:40:28.699Z] #20 SPAWN PID:2413534 claude-code 535MB cpu=3.7% state=S  [mem:7922MB, , sys:18964MB avail, swap:370MB]
[2026-01-25T19:40:28.904Z] #21 SPAWN PID:2413583 mcp-server 67MB cpu=0.0% state=S parent=2413534(claude) [mem:7922MB, , sys:18885MB avail, swap:370MB]
[2026-01-25T19:40:29.104Z] #22 SPAWN PID:2556094 claude-code 394MB cpu=17.9% state=S  [mem:7922MB, , sys:18787MB avail, swap:370MB]
[2026-01-25T19:40:29.277Z] #23 SPAWN PID:2559397 claude-code 3MB cpu=0.0% state=S  [mem:7915MB, , sys:18847MB avail, swap:370MB]
[2026-01-25T19:40:29.477Z] #24 ANOMALY  High Claude instance count: 15 (threshold: 5) [mem:7913MB, , sys:18790MB avail, swap:370MB]
[2026-01-25T19:40:29.583Z] #25 ANOMALY  High memory usage: 7891MB (threshold: 6000MB) [mem:7913MB, , sys:18859MB avail, swap:370MB]
[2026-01-25T19:41:04.132Z] #26 EXIT PID:2559397 claude-code 3MB lived 35s  [mem:7869MB, , sys:20328MB avail, swap:370MB]
[2026-01-25T19:41:04.342Z] #27 ANOMALY  High Claude instance count: 14 (threshold: 5) [mem:7869MB, , sys:20305MB avail, swap:370MB]
[2026-01-25T19:41:14.704Z] #28 STATE_CHANGE PID:2176912 claude-code R->S [mem:7937MB, , sys:20398MB avail, swap:370MB]
[2026-01-25T19:41:27.374Z] #29 SPAWN PID:2582958 claude-code 3MB cpu=0.0% state=S  [mem:7920MB, , sys:20100MB avail, swap:370MB]
[2026-01-25T19:41:27.578Z] #30 ANOMALY  High Claude instance count: 15 (threshold: 5) [mem:7920MB, , sys:20080MB avail, swap:370MB]
[2026-01-25T19:41:37.925Z] #31 STATE_CHANGE PID:2176912 claude-code S->R [mem:8497MB, , sys:18751MB avail, swap:370MB]
[2026-01-25T19:41:39.225Z] #32 SPAWN PID:2584453 claude-code 440MB cpu=38.6% state=S  [mem:8404MB, , sys:18824MB avail, swap:370MB]
[2026-01-25T19:41:39.442Z] #33 ANOMALY  High Claude instance count: 16 (threshold: 5) [mem:8402MB, , sys:18820MB avail, swap:370MB]
[2026-01-25T19:41:39.548Z] #34 ANOMALY  High memory usage: 8382MB (threshold: 6000MB) [mem:8403MB, , sys:18819MB avail, swap:370MB]
[2026-01-25T19:41:49.885Z] #35 STATE_CHANGE PID:2176912 claude-code R->S [mem:8352MB, , sys:19906MB avail, swap:370MB]
[2026-01-25T19:41:51.208Z] #36 SPAWN PID:2586017 claude-code 3MB cpu=0.0% state=S  [mem:8359MB, , sys:20089MB avail, swap:370MB]
[2026-01-25T19:41:51.344Z] #37 EXIT PID:2582958 claude-code 3MB lived 24s  [mem:8360MB, , sys:20088MB avail, swap:370MB]
[2026-01-25T19:42:02.816Z] #38 STATE_CHANGE PID:2413534 claude-code S->R [mem:8321MB, , sys:20051MB avail, swap:370MB]
[2026-01-25T19:42:14.524Z] #39 STATE_CHANGE PID:2413534 claude-code R->S [mem:8300MB, , sys:20113MB avail, swap:370MB]
[2026-01-25T19:42:25.223Z] #40 STATE_CHANGE PID:2176912 claude-code S->R [mem:8307MB, , sys:20154MB avail, swap:370MB]
[2026-01-25T19:42:26.287Z] #41 STATE_CHANGE PID:2413534 claude-code S->R [mem:8307MB, , sys:20154MB avail, swap:370MB]
[2026-01-25T19:42:37.006Z] #42 STATE_CHANGE PID:2176912 claude-code R->S [mem:8310MB, , sys:20054MB avail, swap:370MB]
[2026-01-25T19:42:38.033Z] #43 STATE_CHANGE PID:2413534 claude-code R->S [mem:8315MB, , sys:20174MB avail, swap:370MB]
[2026-01-25T19:43:01.674Z] #44 EXIT PID:2556094 claude-code 417MB lived 152s  [mem:7886MB, , sys:20537MB avail, swap:370MB]
[2026-01-25T19:43:01.882Z] #45 ANOMALY  High Claude instance count: 15 (threshold: 5) [mem:7887MB, , sys:20539MB avail, swap:370MB]
[2026-01-25T19:43:02.013Z] #46 ANOMALY  High memory usage: 7871MB (threshold: 6000MB) [mem:7888MB, , sys:20537MB avail, swap:370MB]
[2026-01-25T19:43:13.374Z] #47 STATE_CHANGE PID:2413534 claude-code S->R [mem:7875MB, , sys:20597MB avail, swap:370MB]
[2026-01-25T19:43:25.083Z] #48 STATE_CHANGE PID:2413534 claude-code R->S [mem:7872MB, , sys:20614MB avail, swap:370MB]
[2026-01-25T19:43:47.426Z] #49 STATE_CHANGE PID:2176912 claude-code S->R [mem:7921MB, , sys:20467MB avail, swap:370MB]
[2026-01-25T19:43:59.089Z] #50 STATE_CHANGE PID:2176912 claude-code R->S [mem:7953MB, , sys:20446MB avail, swap:370MB]
```

---

## Timeline (Last 50 events)

```
[2026-01-25T20:35:18.783Z] #240 STATE_CHANGE PID:2413534 claude-code S->R [mem:8094MB, , sys:20219MB avail, swap:370MB]
[2026-01-25T20:35:19.010Z] #241 SPAWN PID:2977657 claude-code 453MB cpu=52.5% state=S  [mem:8097MB, , sys:20216MB avail, swap:370MB]
[2026-01-25T20:35:19.236Z] #242 ANOMALY  High Claude instance count: 14 (threshold: 5) [mem:8098MB, , sys:20225MB avail, swap:370MB]
[2026-01-25T20:35:19.352Z] #243 ANOMALY  High memory usage: 8081MB (threshold: 6000MB) [mem:8099MB, , sys:20233MB avail, swap:370MB]
[2026-01-25T20:35:41.488Z] #244 STATE_CHANGE PID:2177481 chroma S->R [mem:8154MB, , sys:20216MB avail, swap:370MB]
[2026-01-25T20:35:53.135Z] #245 STATE_CHANGE PID:2177481 chroma R->S [mem:8096MB, , sys:20311MB avail, swap:370MB]
[2026-01-25T20:36:05.370Z] #246 STATE_CHANGE PID:2413534 claude-code R->S [mem:8093MB, , sys:20331MB avail, swap:370MB]
[2026-01-25T20:36:05.612Z] #247 STATE_CHANGE PID:2977657 claude-code S->R [mem:8093MB, , sys:20330MB avail, swap:370MB]
[2026-01-25T20:36:17.275Z] #248 STATE_CHANGE PID:2977657 claude-code R->S [mem:8076MB, , sys:20367MB avail, swap:370MB]
[2026-01-25T20:36:17.522Z] #249 PROGRESS  Elapsed: 00:55:52, Remaining: 03:04:08, Events: 248 [mem:8076MB, , sys:20366MB avail, swap:370MB]
[2026-01-25T20:36:40.255Z] #250 STATE_CHANGE PID:2413534 claude-code S->R [mem:8079MB, , sys:20393MB avail, swap:370MB]
[2026-01-25T20:37:26.347Z] #251 STATE_CHANGE PID:2413534 claude-code R->S [mem:8161MB, , sys:20245MB avail, swap:370MB]
[2026-01-25T20:37:37.951Z] #252 STATE_CHANGE PID:2413534 claude-code S->R [mem:8218MB, , sys:20169MB avail, swap:370MB]
[2026-01-25T20:37:49.561Z] #253 STATE_CHANGE PID:2413534 claude-code R->S [mem:8178MB, , sys:20211MB avail, swap:370MB]
[2026-01-25T20:38:01.250Z] #254 STATE_CHANGE PID:2413534 claude-code S->R [mem:8208MB, , sys:20238MB avail, swap:370MB]
[2026-01-25T20:38:12.848Z] #255 STATE_CHANGE PID:2413534 claude-code R->S [mem:8188MB, , sys:20193MB avail, swap:370MB]
[2026-01-25T20:38:36.159Z] #256 STATE_CHANGE PID:2413534 claude-code S->D [mem:8158MB, , sys:20215MB avail, swap:370MB]
[2026-01-25T20:38:47.759Z] #257 STATE_CHANGE PID:2413534 claude-code D->R [mem:8203MB, , sys:20131MB avail, swap:370MB]
[2026-01-25T20:38:47.998Z] #258 STATE_CHANGE PID:2977657 claude-code S->R [mem:8204MB, , sys:20112MB avail, swap:370MB]
[2026-01-25T20:38:59.175Z] #259 STATE_CHANGE PID:2341546 claude-code S->R [mem:8209MB, , sys:20173MB avail, swap:370MB]
[2026-01-25T20:38:59.637Z] #260 STATE_CHANGE PID:2413534 claude-code R->S [mem:8209MB, , sys:20151MB avail, swap:370MB]
[2026-01-25T20:38:59.890Z] #261 STATE_CHANGE PID:2977657 claude-code R->S [mem:8213MB, , sys:20114MB avail, swap:370MB]
[2026-01-25T20:39:11.053Z] #262 STATE_CHANGE PID:2341546 claude-code R->S [mem:8263MB, , sys:20078MB avail, swap:370MB]
[2026-01-25T20:39:11.496Z] #263 STATE_CHANGE PID:2413534 claude-code S->R [mem:8276MB, , sys:20070MB avail, swap:370MB]
[2026-01-25T20:39:34.743Z] #264 STATE_CHANGE PID:2413534 claude-code R->S [mem:8267MB, , sys:20109MB avail, swap:370MB]
[2026-01-25T20:39:46.296Z] #265 STATE_CHANGE PID:2413534 claude-code S->R [mem:8280MB, , sys:20142MB avail, swap:370MB]
[2026-01-25T20:40:09.172Z] #266 STATE_CHANGE PID:2341546 claude-code S->R [mem:8312MB, , sys:20090MB avail, swap:370MB]
[2026-01-25T20:40:09.600Z] #267 STATE_CHANGE PID:2413534 claude-code R->S [mem:8287MB, , sys:20085MB avail, swap:370MB]
[2026-01-25T20:40:20.212Z] #268 STATE_CHANGE PID:2176912 claude-code S->R [mem:8233MB, , sys:20082MB avail, swap:370MB]
[2026-01-25T20:40:21.013Z] #269 STATE_CHANGE PID:2341546 claude-code R->S [mem:8241MB, , sys:20085MB avail, swap:370MB]
[2026-01-25T20:40:31.892Z] #270 STATE_CHANGE PID:2176912 claude-code R->S [mem:8258MB, , sys:20164MB avail, swap:370MB]
[2026-01-25T20:40:33.066Z] #271 STATE_CHANGE PID:2413534 claude-code S->R [mem:8243MB, , sys:20176MB avail, swap:370MB]
[2026-01-25T20:41:06.665Z] #272 STATE_CHANGE PID:2176912 claude-code S->R [mem:8821MB, , sys:19368MB avail, swap:370MB]
[2026-01-25T20:41:07.901Z] #273 SPAWN PID:3023279 claude-code 484MB cpu=38.1% state=S  [mem:8834MB, , sys:19357MB avail, swap:370MB]
[2026-01-25T20:41:08.112Z] #274 ANOMALY  High Claude instance count: 15 (threshold: 5) [mem:8837MB, , sys:19297MB avail, swap:370MB]
[2026-01-25T20:41:18.573Z] #275 STATE_CHANGE PID:2177149 worker S->R [mem:8809MB, , sys:19482MB avail, swap:370MB]
[2026-01-25T20:41:19.831Z] #276 PROGRESS  Elapsed: 01:00:54, Remaining: 02:59:06, Events: 275 [mem:8919MB, , sys:19408MB avail, swap:370MB]
[2026-01-25T20:41:30.182Z] #277 STATE_CHANGE PID:2176912 claude-code R->S [mem:8771MB, , sys:19643MB avail, swap:370MB]
[2026-01-25T20:41:30.425Z] #278 STATE_CHANGE PID:2177149 worker R->S [mem:8775MB, , sys:19635MB avail, swap:370MB]
[2026-01-25T20:41:42.941Z] #279 STATE_CHANGE PID:2413534 claude-code R->S [mem:8724MB, , sys:19526MB avail, swap:370MB]
[2026-01-25T20:41:43.226Z] #280 STATE_CHANGE PID:3023279 claude-code S->D [mem:8730MB, , sys:19551MB avail, swap:370MB]
[2026-01-25T20:41:53.689Z] #281 STATE_CHANGE PID:2176912 claude-code S->R [mem:8744MB, , sys:19624MB avail, swap:370MB]
[2026-01-25T20:41:54.774Z] #282 STATE_CHANGE PID:2413534 claude-code S->R [mem:8757MB, , sys:19498MB avail, swap:370MB]
[2026-01-25T20:41:55.047Z] #283 STATE_CHANGE PID:3023279 claude-code D->S [mem:8751MB, , sys:19566MB avail, swap:370MB]
[2026-01-25T20:41:55.213Z] #284 SPAWN PID:3031756 claude-code 1MB cpu=0.0% state=S  [mem:8837MB, , sys:19448MB avail, swap:370MB]
[2026-01-25T20:41:55.446Z] #285 ANOMALY  High Claude instance count: 16 (threshold: 5) [mem:8766MB, , sys:19389MB avail, swap:370MB]
[2026-01-25T20:42:17.419Z] #286 STATE_CHANGE PID:2176912 claude-code R->S [mem:8733MB, , sys:18894MB avail, swap:370MB]
[2026-01-25T20:42:18.725Z] #287 SPAWN PID:3036883 claude-code 3MB cpu=0.0% state=S  [mem:8704MB, , sys:18873MB avail, swap:370MB]
[2026-01-25T20:42:18.993Z] #288 ANOMALY  High Claude instance count: 17 (threshold: 5) [mem:8701MB, , sys:18846MB avail, swap:370MB]
[2026-01-25T20:42:20.063Z] #289 SESSION_END  Benchmark ABORTED by user after 01:01:55 [mem:8707MB, , sys:18810MB avail, swap:370MB]
```

---

## Instructions for LLM Analysis

To analyze this data with an LLM, you can:

1. **Share this report** for a high-level overview
2. **Query the JSONL file** for detailed analysis:

```bash
# Get all anomalies with context (5 events before each)
jq -r 'select(.event == "ANOMALY") | .event_num' /home/dev/projects/claude-mem/monitors/logs/session_20260125_194025_events.jsonl | while read n; do
  jq "select(.event_num >= $(($n-5)) and .event_num <= $n)" /home/dev/projects/claude-mem/monitors/logs/session_20260125_194025_events.jsonl
done

# Get memory over time
jq -r '[.ts, .total_mem_mb, .system.swap_used_mb] | @csv' /home/dev/projects/claude-mem/monitors/logs/session_20260125_194025_events.jsonl

# Get all events for a specific PID
jq 'select(.pid == "TARGET_PID")' /home/dev/projects/claude-mem/monitors/logs/session_20260125_194025_events.jsonl

# Find processes that lived less than 60 seconds
jq -r 'select(.event == "EXIT" and (.details | test("lived [0-5]?[0-9]s")))' /home/dev/projects/claude-mem/monitors/logs/session_20260125_194025_events.jsonl
```

---

_Report generated at 2026-01-25 20:42:20 UTC_
