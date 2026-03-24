# Backlog: Data coherence investigation

**Date**: 2026-03-24
**Priority**: High
**Status**: To investigate

## Problem

Observation count dropped significantly:
- User recalls ~35,000+ observations historically
- MSM3U (server, with MSM4M's DB): 7,315 observations
- MBPM4M (standalone, last sync early March): 5,376 observations

Two sessions hold 83% of all prompts (7,940 out of 9,604):
- `e791bbd2-...` → 4,619 prompts
- `8ab20428-...` → 3,321 prompts

## Hypotheses

1. **Deduplication/cleanup introduced in recent versions** — claude-mem may have added a built-in cleanup that pruned old observations
2. **DB transfer truncation** — the SCP/dump-restore between machines may have lost data
3. **Schema repair dropped data** — the `schema-repair` mechanism may have rebuilt tables without all rows
4. **Migration side-effect** — one of the migrations (v10.x) may have restructured tables and lost rows

## Investigation steps

- [ ] Check MBPM4M's original DB (untouched) for observation count
- [ ] Check MSM4M's backup DB (`~/.claude-mem/backups/pre-multinode-*/claude-mem.db`)
- [ ] Compare observation counts across all backup DBs
- [ ] Search claude-mem changelog for any cleanup/dedup/prune features
- [ ] Check if `VACUUM` or `schema-repair` could drop rows
- [ ] Analyze the 2 mega-prompt sessions for anomalies
