# Post-Mortem: libSQL + Xenova Migration Experiment

**Date:** 2026-05-04
**Trigger:** Migration run killed at ~4 hours wall-clock. Embed phase finished at 48 min; CREATE INDEX `libsql_vector_idx` ran for 3+ hours with no progress signal and never completed.
**Source artifacts:** `/Users/alexnewman/Scripts/claude-mem/.scratch/turso-vector-test/`, plus `handoff.md`, `migration-audit.md`, `lancedb-fitness.md`, `tubes-questions.md`, `sync-container-plan-v4-draft.md`.

---

## 1. Starting state

Going in, the following were already established as fact:

- libSQL opens the production `~/.claude-mem/claude-mem.db` (310 MB at copy time) cleanly. 36 tables, 77,188 observations, 8,434 summaries, all readable. Verified by `step1-open-asis.mjs`. libSQL is a true file-format superset of SQLite.
- `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` with `quantized: false` produces vectors that are cosine-similarity 1.00000000 to chroma-mcp's `DefaultEmbeddingFunction` — drop-in compatible. Per-component max diff was 1.16e-7 (fp32 noise). Verified by source-code chain through `chroma_mcp/server.py:171-172` to `chromadb/utils/embedding_functions/onnx_mini_lm_l6_v2.py`.
- Quantized variant: cos sim 0.987–0.995 to fp32 — semantically equivalent for ranking, smaller (~25 MB vs ~80 MB), marginally faster on small batches.
- Architectural decision: self-hosted libSQL (`sqld`), not Turso cloud. Single primary, two embedded replicas (Mac + Railway `app`).
- Architectural decision: regenerate vectors from source text in `claude-mem.db`, not extract from existing Chroma. Cleaner, no chromadb dependency.

Unknown going in: Xenova throughput on real-text + real-volume; libSQL `vector_top_k` query latency at full scale; quantized vs fp32 perf delta at scale; CREATE INDEX wall-clock; WAL pressure during bulk index build; whether the JOIN+filter shape returns enough results for small projects. The handoff's back-of-envelope was "Total ~3 min per run." That estimate was the load-bearing flaw.

## 2. What we set out to verify

The "yes, ship it" gate was: (a) end-to-end migration completes in bounded wall-clock, (b) `vector_top_k` query latency under some target (Chroma's typical sub-100ms is the natural reference), (c) top-K results pass a semantic sanity check, (d) fp32 vs quantized comparison at full scale produces a defensible default, (e) the architectural wins (drop chroma service, drop SSH tunnel, drop uv/Python) materialize without performance regression.

We got (e) — architecturally yes. We got (a) only for the embed phase, and at much worse perf than expected. We never reached (b), (c), or (d). The single concrete data point we needed to greenlight the architecture — `vector_top_k` query latency over a built index — is the one we still don't have.

## 3. Chronology

The session opened with reading `src/services/sync/ChromaSync.ts` (1099 lines) to determine what text gets embedded today. Findings: observations get N docs (narrative + text + each fact, separately), session_summaries get up to 6 (one per `field_type`), user_prompts get 1 each. This drove the schema decision: a polymorphic `embeddings` side table with `(parent_table, parent_id, field_type, field_index)` keys, F32_BLOB(384) column, and the vector index deferred until after population. `step2a-create-schema.mjs` and `step2b-generate-embeddings.mjs` were written against that shape. The audit (`migration-audit.md` §A.8) later confirmed the embedding-text equivalence with ChromaSync is exact.

The bench loop expanded across three scripts. `bench-embed.mjs` (synthetic), `bench-embed-real.mjs` (real text from observations), and `bench-embed-truncated.mjs` together established that EMBED_BATCH=32 with length-sort + 1000-char truncation kills padding waste. Cold CPU favored 64; under thermal load 32 won. The migration runs steady-state hot, so 32 was the right pick.

The insert bench was a rabbit hole. `bench-insert.mjs` → `bench-insert-real.mjs` → `bench-insert-isolate.mjs` ultimately discovered that DELETE FROM leaves WAL freepage residue that makes subsequent INSERTs ~90× slower when UNIQUE constraints force lookups against WAL pages. The fix: DROP+CREATE, not DELETE FROM. Real production-relevant finding. But: insert was 3.7% of total wall-clock. Hours were spent characterizing a sub-5% segment.

The full migration kicked off with `--quantized=true`. `step2b-quantized-full.log` captured it: scan and load took 0.3s; total docs to embed was 548,026 (not 77,188 — the handoff used the wrong unit of work). Initial throughput 852 docs/s, monotonically declining to 190 docs/s by completion. Embed phase: 2772.5s. Insert phase: 107.0s. Total: 2882.6s ≈ 48 min. Then `CREATE INDEX embeddings_vec_idx ON embeddings(libsql_vector_idx(embedding))` started, with no further log output.

In parallel, three sub-investigations ran. `lancedb-fitness.md`: stay with libSQL. `tubes-questions.md`: three answers about an unrelated PR. `migration-audit.md`: three perf wins, ten architectural risks, all concrete.

Two operational incidents: WAL grew through the embed phase to 10.2 GB at the audit snapshot (~4:30am), then to 14.06 GB at last sample (5:28am). Disk pressure on the Mac surfaced 8.6 GB reclaimable in `~/Library/Caches`, which Alex cleared. Final state at the kill: main DB 1.50 GB; WAL 14.06 GB; SHM 27.3 MB. Index never built. Process killed manually after ~4 hours total wall-clock (~3+ hours of which was the index alone).

## 4. Findings — what's actually true now

**The unit of work is 548,026 documents, not 77,188.** The handoff estimate of "77k rows × 2 ms = 154s" used the wrong row count and the wrong per-row cost. Real total: 548k × 5.26 ms = 2884 s ≈ 18× the handoff estimate.

**Xenova throughput under sustained thermal load is ~190 docs/sec on Apple Silicon, not the ~500 docs/sec the small-batch bench suggested.** The 4.5× decline from start (852 docs/s) to end (190 docs/s) is real thermal throttling, not a script bug. The migration audit confirms: `bench-embed-real`/`bench-embed-truncated` peaked at ~380 docs/s cold, ~190 docs/s hot. The script is correct; the laptop is the bottleneck.

**Insert is 3.7% of wall-clock.** 107s of 2882s. `client.batch()` per TX_BATCH=256 is good enough; the DROP+CREATE-not-DELETE finding is real but its leverage on the migration window is small. Bigger leverage exists in steady-state (re-embed flows must always DROP+CREATE).

**libSQL `libsql_vector_idx` HNSW build is single-threaded, journaled into WAL, with no progress signal.** This is inherent to SQLite/libSQL's design: writers are serial, every page mutation is journaled for crash safety, and `CREATE INDEX` is one opaque statement. Chroma's hnswlib uses thread pools and isn't journaled to a file the same way. At 548k docs the WAL ballooned to 14.06 GB on a 1.5 GB main DB — a ~9.4× ratio — and the build did not finish in 3+ hours.

**The polymorphic side-table design correctly mirrors Chroma's document model.** Per the audit, `narrative`, `text`, and each `fact` are passed as raw strings without title/subtitle concatenation, identical to ChromaSync's `formatObservationDocs`. The legacy `text` column is read for backfill compatibility (old rows have non-null values; ChromaSync.ts:320 sets `text: null` for new writes).

**A potential behavioral regression on small-project queries was identified but not measured.** ChromaSync uses `where: { project }` server-side, returning top-K matches *within* the project. The libSQL pattern in `step3-query-bench.mjs` does `vector_top_k(idx, q, FETCH_K=50)` then `WHERE project=? LIMIT 20`. A project with only 3 docs in the global top-50 returns 3, not 20. For Alex's many small one-off projects this will manifest as "asked for 20 hits, got 3."

**Quantized=true was used but probably should not be the default.** The handoff said run both modes and pick. We ran only quantized. Audit notes that bench-embed-real's thermal variance dwarfs the quantized↔fp32 delta — i.e., they're effectively comparable at scale. fp32 wins on free correctness (bit-equivalent to existing Chroma), so unless the perf delta is materially large, fp32 is the default.

## 5. Where the experiment failed

The 4-hour wall-clock isn't the most damning fact. The most damning facts are:

1. **No small-N stepping stone before the 548k run.** A 10k-doc test would have surfaced both the throughput and the index-build behavior in 60s of embed and a few minutes of index. We extrapolated from a 20-row synthetic test (`test.mjs`) directly to 548k. That's a four-order-of-magnitude jump on assumed-linear scaling. Avoidable; the parent agent's mistake.

2. **The "~3 min/run" estimate was a red flag we didn't catch.** Three minutes for embed + index at 548k docs implies ~3000 docs/sec end-to-end. That's not plausible for a write-amplifying HNSW build with WAL journaling. A back-of-envelope on the *algorithmic* cost — 548k × HNSW M=16 = ~9M edge insertions, each a page mutation, each journaled — would have shown the index alone is in tens of minutes minimum even on optimistic assumptions. We multiplied the bench by N and trusted it. Avoidable.

3. **Disproportionate time on insert performance.** Three bench scripts for the 3.7% segment of wall-clock. The DROP-vs-DELETE finding is genuinely useful for steady-state, but it didn't change tonight's outcome. Avoidable; gold-plating.

4. **Single-mode run.** Handoff explicitly required both quantized and fp32 at production scale to make a defensible default choice. We ran only quantized=true. Now we have neither a clean fp32 dataset nor a head-to-head measurement. Avoidable.

5. **No timeout on long-running build.** CREATE INDEX is opaque; we didn't pre-write a "kill at N minutes if stuck" rule. We watched manually and made a kill decision without comparison data. Avoidable.

6. **Single-threaded HNSW build was foreseeable.** SQLite is single-writer by design. We knew Chroma was multithreaded; we never asked whether libSQL's index build was. Avoidable; should have been surfaced before kickoff.

What's inherent to libSQL (not the parent agent's fault): single-writer index builds, WAL journaling of every index page mutation, no progress signal during `CREATE INDEX`, no native server-side pre-filter on metadata before `vector_top_k`. These are SQLite-family architectural choices and they don't go away.

## 6. Trade-offs that crystallized

The architectural decision was Chroma → libSQL native vectors + Xenova in-process. Tonight quantified the costs:

**Now-real costs.** Single-threaded HNSW build is a meaningful regression for any flow that requires a full reindex; on this machine it failed to finish at 548k docs in 3+ hours. WAL pressure during bulk-load is severe (14 GB on a 1.5 GB DB) and will dictate volume sizing for the Railway plan — Hobby tier 5 GB volumes won't survive an unmitigated full backfill. Project-filtered queries may under-serve small projects with the FETCH_K-then-filter pattern. No progress signal during long-running builds is operationally awkward.

**Now-real benefits.** One file, one sync mechanism: vectors ride the libSQL WAL replication for free, removing Chroma's separate replication path. No Python/uv in the container. No second Railway service. No Mac→container SSH tunnel. In-process embedding via Xenova produces fp32 vectors bit-equivalent to chroma-mcp's default — vendor-portable and identical to the existing collection.

**Net.** The architectural decision still holds. The single-threaded index build is a one-time cost for backfill that we now know how to amortize: build offline on a powerful machine and ship the indexed file; let replicas sync the prebuilt index. Steady-state insertion into an existing HNSW is much cheaper than building from scratch (Chroma uses the same approach for incremental indexing today). The trade is acceptable as long as we never try to build in-place on the constrained Railway runtime.

## 7. Recommendations for next session

The migration audit identified three concrete wins. Apply all three before re-running.

1. **`PRAGMA wal_checkpoint(TRUNCATE)` before `CREATE INDEX`.** This is the single highest-leverage fix. Forces all 14 GB of WAL pages back into the main DB and resets the WAL to zero. Subsequent `CREATE INDEX` runs against pure main-DB pages with no WAL reconciliation overhead. Audit estimates this converts the index phase from "no end in sight" to plausibly 5–15 min.

2. **Bind embeddings as `Uint8Array`, not `JSON.stringify(Array.from(...))`.** Replace the `vector32(?)` JSON path with a direct blob bind: `new Uint8Array(out.data.buffer, out.data.byteOffset + off * 4, 384 * 4)` and SQL `VALUES (..., ?)`. Eliminates ~2 GB of allocation churn in a 548k run. Verify byte order with a small round-trip — libSQL stores fp32 little-endian, Apple Silicon is little-endian, so `Float32Array.buffer` should be byte-identical to `vector32()` output.

3. **Fix the project-filter regression at query time.** Don't ship the FETCH_K=50-then-filter pattern as-is. Either iteratively expand FETCH_K until enough rows post-filter, or research per-project partial indexes.

**Production migration path.** Build the full embeddings + index OFFLINE on the dev Mac, then copy the resulting libSQL DB file to the `sqld` primary. Replicas pull the prebuilt index for free via `db.sync()`. Don't attempt the build on the Railway runtime. Steady-state: embed each new observation as the worker writes it; HNSW insert is sub-100ms per row even at scale.

**Bench plan that gets to a yes/no in <60 min.** With the existing populated `embeddings` table on `claude-mem.libsql.db`: (1) `PRAGMA wal_checkpoint(TRUNCATE)` and confirm the 14 GB WAL drops to near-zero; (2) `CREATE INDEX embeddings_vec_idx ON embeddings(libsql_vector_idx(embedding))` and time it; (3) run `step3-query-bench.mjs` with five realistic queries, report median/p95/p99; (4) run a semantic sanity check by hand (top-3 for "OAuth tunnel", "tubes plan", "PR #2282"); (5) re-run `step2b` once more with `--quantized=false` into a separate scratch DB; compare totals.

**Things to skip next session.** Don't re-do insert benches. Don't re-run the full migration without WAL checkpointing in place. Don't extrapolate from synthetic small-N to production-scale without a stepping-stone.

## 8. Open questions

(1) `CREATE INDEX libsql_vector_idx` wall-clock with WAL checkpointed first — single biggest unknown. (2) `vector_top_k` query latency at full scale — never benched. (3) Whether the project-filter regression matters in practice — depends on docs-per-project distribution, never measured. (4) Incremental embed cost during normal worker writes. (5) Behavior of `wal_checkpoint(TRUNCATE)` while the worker is actively writing (online concurrency, not just bulk-load). (6) fp32 vs quantized at production scale, head-to-head. (7) Semantic correctness at scale — top-K results actually relevant. (8) How libSQL's WAL-based replication handles a 14 GB WAL during initial replica sync (or whether `db.sync()` only ships the post-checkpoint snapshot). (9) Reindex cadence — incremental forever vs occasional full rebuild.

## 9. Side outcomes worth carrying forward

**LanceDB is ruled out.** No embedded-replica equivalent; multi-writer story is "S3 + DynamoDB commit store," which is a managed-AWS dependency on every write — strictly worse than libSQL embedded replicas for the multi-device sync use case. At 550k × 384 dims neither tool has a perf advantage; embedding generation dominates regardless. Trigger to revisit: if compliance ever requires immutable time-travel for the vector store. Not a current requirement.

**Tubes side investigation.** PR #1468 (`thedotmack/gstack-mode`) is closed, 286 commits behind main, with file renames (SDKAgent.ts → ClaudeProvider.ts) and a refactored ResponseProcessor. Not cherry-pickable today. Path B (build inline using the resolveMode/setModeOverride/cache-map design as a blueprint) is the realistic option. PostToolUse `additionalContext` is documented and supported with a 10K char cap; one open MCP-tool routing bug (anthropics/claude-code#24788). Container tubes deferred to v2 — multi-host tube registration and connector-ownership require a lease-and-heartbeat layer that isn't designed. Phase 7 idle-spawn depends on container tubes being interesting and inherits the deferral.

**The "assumption" concept Alex raised mid-session and didn't ship.** Flag for re-surfacing next session — the term wasn't specified deeply enough to act on, but it was in the air.

## 10. Honest assessment

Tonight was worth the time, but most of the value was negative — we learned what doesn't work fast enough and what to avoid next time. The positive value (architecture confirmed, audit findings, LanceDB ruled out, tubes investigated) is real but smaller than 4 hours of focused work should produce. The single biggest learning is operational: **on a SQLite-family engine, never run `CREATE INDEX` after a multi-GB WAL accumulation without first running `PRAGMA wal_checkpoint(TRUNCATE)`.** The single biggest avoidable mistake was extrapolating from a 20-row synthetic test directly to 548k docs without a 10k-doc stepping-stone in between. The next concrete action is small: run `wal_checkpoint(TRUNCATE)` against `claude-mem.libsql.db` and then `CREATE INDEX libsql_vector_idx` over the existing populated `embeddings` table. That single experiment turns this from "killed and unresolved" to "we know how to ship" — and it costs minutes, not hours.
