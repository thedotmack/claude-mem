<!-- Mirror of GitHub issue #3982. The issue is the public tracker; this doc is the design.
     If the two drift, the doc is canonical for design and the issue for status (oh-my-issues health check). -->

> **Tracker:** https://github.com/thedotmack/claude-mem/issues/3982

## Defect
FTS5 unicode61 can't segment CJK → phrase search always returns 0 even when rows exist. Chroma-empty→FTS fallback does not fix matching.

## Children
- #3801
- #3859

## Related PRs
- #3810
- #3173
- #3285
- #3430

## Fix sequence
CJK-aware tokenizer / trigram / LIKE fallback on script detect; same contract on worker SQLite and server search.

## Test matrix
- CJK query × worker SQLite FTS × server search
- Empty-chroma fallback path

## Out of scope
- Chroma spawn/pin (plan-22 #3610)
- Project identity (plan-20)
