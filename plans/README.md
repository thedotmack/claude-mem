# Plan masters

Every open bug in this repo belongs to exactly one **plan master** — an architectural defect, not a
symptom. Symptoms get filed, routed to their master with a redirect comment, and closed as
*not planned*. The unit of work is the master; one PR per cluster closes its children atomically.

The GitHub issue is the public tracker. The doc here is the design. They reference each other, and
when they drift the doc is canonical for design and the issue for status.

| Plan | Master | Doc | Architectural defect |
|---|---|---|---|
| plan-12 | [#2785](https://github.com/thedotmack/claude-mem/issues/2785) | [12-provider-and-extensibility-roadmap.md](12-provider-and-extensibility-roadmap.md) | Net-new capabilities, not defects — providers, ingestion, integrations, UX |
| plan-14 | [#3602](https://github.com/thedotmack/claude-mem/issues/3602) | [14-child-process-ownership.md](14-child-process-ownership.md) | Every process the worker spawns dies with the worker |
| plan-15 | [#3603](https://github.com/thedotmack/claude-mem/issues/3603) | [15-worker-port-and-liveness-authority.md](15-worker-port-and-liveness-authority.md) | One verified answer to "is a worker serving this port?" |
| plan-16 | [#3604](https://github.com/thedotmack/claude-mem/issues/3604) | [16-canonical-install-identity-and-bundle-integrity.md](16-canonical-install-identity-and-bundle-integrity.md) | One resolvable, dependency-complete plugin root; recycles that cannot kill a working worker |
| plan-17 | [#3605](https://github.com/thedotmack/claude-mem/issues/3605) | [17-hook-wrapper-contract.md](17-hook-wrapper-contract.md) | Hook wrapper: thin, cheap, fail-open on every host |
| plan-18 | [#3606](https://github.com/thedotmack/claude-mem/issues/3606) | [18-observer-response-pipeline.md](18-observer-response-pipeline.md) | Classify every output, never confirm a batch on failure, bound every history |
| plan-19 | [#3607](https://github.com/thedotmack/claude-mem/issues/3607) | [19-observer-subprocess-isolation.md](19-observer-subprocess-isolation.md) | Explicit env, cwd, config, tool set and auth source for the headless generator |
| plan-20 | [#3608](https://github.com/thedotmack/claude-mem/issues/3608) | [20-project-identity-and-injection-scope.md](20-project-identity-and-injection-scope.md) | One project resolver shared by capture, sync and retrieval; injection config that reaches the query |
| plan-21 | [#3609](https://github.com/thedotmack/claude-mem/issues/3609) | [21-sqlite-schema-evolution-and-queue-state.md](21-sqlite-schema-evolution-and-queue-state.md) | One DDL path guarded by introspection, immutable session keys, transitionable queue states |
| plan-22 | [#3610](https://github.com/thedotmack/claude-mem/issues/3610) | [22-chroma-sidecar-contract.md](22-chroma-sidecar-contract.md) | Host-safe sidecar spawn, single-writer upsert sync, honest fallback — or retire the sidecar |
| plan-23 | [#3611](https://github.com/thedotmack/claude-mem/issues/3611) | [23-host-integration-contracts.md](23-host-integration-contracts.md) | Every non-Claude-Code adapter validated by contract tests against the host's actual schema |
| plan-24 | [#3618](https://github.com/thedotmack/claude-mem/issues/3618) | [24-server-runtime-generation-and-sync-contract.md](24-server-runtime-generation-and-sync-contract.md) | One generation pipeline shared by worker and server; session linkage on every write path |
| plan-25 | [#3982](https://github.com/thedotmack/claude-mem/issues/3982) | [25-search-read-path-fts-cjk.md](25-search-read-path-fts-cjk.md) | CJK-aware matching when FTS5 unicode61 returns 0 |

Earlier plans (01–11, 13) shipped or were folded into the masters above; `02`, `04` and `08` remain
here as historical design docs.

## Routing a new bug

Pattern-match the symptom against the masters above and ask: *would the fix described there also fix
this?* If yes, add a Round-N comment to the master naming the child, the one-line symptom, a 1–3 line
fix sketch and any new test-matrix cell, then close the child as *not planned* with:

> Consolidating into #\<MASTER\> (plan-XX). The root cause and fix sequencing are tracked there
> alongside the rest of the cluster — please follow that issue for progress.

Resist opening a new master. Most bugs are children of an existing plan. Two things legitimately stay
out of this scheme: genuine feature requests with no shared root cause (those go to plan-12), and
support questions, which are answered rather than routed.

## Health checks

- **Graveyard master** — 5+ Round-N comments with no shipping PR. Force a PR or split the plan.
- **Over-broad master** — the children's fixes cannot fit one PR. Split into two narrower plans.
- **Surface-clustered master** — the children share a topic but not a fix. Re-cluster by root cause.
- **Drift** — the master body and the doc disagree. Regenerate the doc's mirror from the issue.
