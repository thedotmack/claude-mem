<claude-mem-context>
# Memory Context

# [claude-mem/codex-version-mismatch-investigation-plan] recent context, 2026-05-06 7:08pm PDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (24,206t read) | 434,478t work | 94% savings

### May 5, 2026
80963 5:48p 🔵 PendingMessageStore Has Two Divergent Implementations in the Same Codebase
80965 5:49p 🔵 SessionManager Queue Integration: EventEmitter Per-Session, resetProcessingToPending on Iterator Start
80967 " 🔵 Schema.sql Shows Canonical pending_messages Table: 2 Statuses, No worker_pid Column, UNIQUE Dedup Index
80969 " 🔵 SessionQueueProcessor Test Suite Covers: Idle Timeout, Abort, EventEmitter Wake-up, Error Backoff, Listener Cleanup
80971 5:50p 🔵 PendingMessageStore Tests Reveal Self-Healing Uses started_processing_at_epoch Column Not Present in Current Schema
80973 " 🔵 storeObservationsAndMarkComplete Transitions pending_messages to 'processed' Status Atomically
80975 " 🔵 Worker Startup Performs Global Orphan Sweep: Resets All 'processing' Rows to 'pending'
80977 " 🔵 storeObservationsAndMarkComplete Sets 'processed' Status AND Nulls Payload Columns on Completion
80979 " 🔵 Migration 31 Purges 'processed'/'failed' Rows and Drops Legacy Columns — Code in transactions.ts Still Writes 'processed'
80980 5:51p 🔵 SessionStore Migration Path Has Migration 32 (dropWorkerPidColumn) Beyond runner.ts — Schema Divergence Confirmed
80981 " 🔵 BullMQ Ships Both CJS and ESM Builds with Lua Scripts Bundled
80982 " 🔵 Bee-Queue Is CJS-Only with No TypeScript Source or Build Step
80985 5:52p 🔵 Bee-Queue Feature Comparison Confirms Missing Features Claude-Mem Would Need
80988 " 🔵 BullMQ Maintains Three Active Major Version Lines (v3, v4, v5) with Long-Term Support
80990 5:53p 🔵 Bee-Queue Has Only One Active Version Line with 8 Total Lifetime Releases
80993 5:54p 🔵 BullMQ Has an Open Issue for Bun Compatibility — Not Yet Officially Supported
80994 " 🔵 Both BullMQ and Bee-Queue Import Successfully in Bun Runtime
80996 " 🔵 Queue Consumer Callsites: Three Providers Consume getMessageIterator, Two HTTP Ingest Paths
80998 " 🔵 ResponseProcessor Uses storeObservations (Not storeObservationsAndMarkComplete) and Calls clearPendingForSession on Completion
81001 5:55p 🔵 Providers Consume Queue as Async Generator of User Messages — Each Message Becomes an SDK Prompt
81002 " 🔵 OpenRouterProvider Processes One Message at a Time via processOneMessage — _persistentId Is Part of Message Contract
81006 5:56p 🔵 Queue Test Suite Has 6 Failing Tests Due to Constructor Mismatch and Behavior Divergence
81007 " ⚖️ Queue Engine Deep Dive Complete: BullMQ as Optional Backend, Keep SQLite as Default
81009 " 🔵 Branch History Shows Queue Cleanup Already Partially Done Before Deep Dive
81050 9:18p ⚖️ BullMQ Proposed as Alternative to Buggy claude-mem Queue
81051 9:21p 🔵 claude-mem Queue Architecture: Bespoke SQLite-Based Queue on Bun Runtime
81052 " 🔵 pending_messages Table Lost Retry and Failure Tracking Columns in Migration 31/32
81053 9:23p 🔵 Installer Auto-Provisions Only Bun and uv — Redis Not in Dependency Chain
81054 9:24p 🔵 Worker Is an HTTP Daemon, Not a Queue Consumer — Messages Reach It via REST Calls
81056 " ⚖️ BullMQ + Managed Valkey Sidecar Chosen as Queue Strategy for claude-mem
### May 6, 2026
81250 2:04p 🔵 litellm-proxy-setup branch fully merged into main
81251 2:05p 🔵 Two untracked files remain in litellm-public-docs worktree
81252 " 🔵 litellm-proxy.mdx never existed — only litellm-gateway.mdx in docs
81256 2:11p 🔵 Redis Compatible Sidecar Pattern
81286 4:14p 🔵 Duplicate `.codex-plugin/plugin.json` Files Found at Root and `plugin/` Subdirectory
81287 " 🔵 Codex Plugin Cache Contains Only claude-mem 12.3.1, No Local Dev Version
81292 " 🔵 Local `claude-mem` Source is 12.7.2 but Codex Plugin Cache is Stale at 12.3.1
81295 4:15p 🔵 `sync-marketplace.cjs` Targets Claude Code's `~/.claude/` Path, Not Codex's `~/.codex/` Cache
81296 4:16p 🔵 Codex Registered claude-mem as a Git-Sourced Marketplace (Not Local Filesystem), Cache Frozen at Commit `bb3dbfdb`
81297 " 🔵 Complete Codex Plugin Registration Map: `config.toml` Records Plugin as Enabled at `thedotmack` But Cache Stays at 12.3.1
81298 4:17p 🔵 Plugin Cache Frozen Since April 20; `marketplace.json` Says Local but Codex Recorded Git — `upgrade` Will Pull GitHub Not Local Worktree
81302 4:18p 🔵 Install Flow Passes Claude Code Marketplace Path to Codex — But Current Codex Registration Shows Git Source, Indicating Install Was Done Via Different Path
81303 " 🟣 Codex Plugin Version Mismatch Investigation Plan Written to `plans/2026-05-06-codex-plugin-version-mismatch.md`
81349 5:23p 🔵 Cross-Project Robot Memory Search: Tripoli, rosclaw, redplanet Results
81350 5:24p 🔵 Robot Project Memory Map: rosclaw/redplanet Not Found; innate-os/MARS/OM1 Confirmed
81352 5:26p 🔵 Tripoli Storyline App is MARS Robot Demo Presentation Site
81353 " 🔵 innate-os "Maurice" Robot: Full Architecture and claude-mem Integration PR #366
81354 " 🔵 MARS Robot Cinematography Skills in Stix/krakow-v2: /cmd_vel Orbit Math
81355 " 🟣 claude-mem ROS2 Robot Monitoring Mode (robot.json) with 7 Event Types
81517 7:08p 🔵 Codex Version Mismatch Investigation Branch State

Access 434k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>