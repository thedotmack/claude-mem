# Migration Audit — libSQL + Xenova Embeddings

Files audited:
- `/Users/alexnewman/Scripts/claude-mem/.scratch/turso-vector-test/step2a-create-schema.mjs`
- `/Users/alexnewman/Scripts/claude-mem/.scratch/turso-vector-test/step2b-generate-embeddings.mjs`
- `/Users/alexnewman/Scripts/claude-mem/.scratch/turso-vector-test/step3-query-bench.mjs`
- `/Users/alexnewman/Scripts/claude-mem/.scratch/turso-vector-test/bench-embed*.mjs`
- `/Users/alexnewman/Scripts/claude-mem/.scratch/turso-vector-test/bench-insert*.mjs`
- `/Users/alexnewman/Scripts/claude-mem/src/services/sync/ChromaSync.ts`
- `/Users/alexnewman/Scripts/claude-mem/src/services/sqlite/observations/files.ts`

Live process state (PID 58570) verified during audit: embed phase finished at 2882s = 48m, insert phase 107s, currently on `CREATE INDEX libsql_vector_idx`. WAL is 10.2 GB; main DB is 1.5 GB.

---

## Bottom line

The work is **largely correct and ships-ready in spirit**, with two real but small bugs (correctness #2 and #3 below) and one big perf issue (perf #1) that explains a large chunk of the runtime pain. The 48-min embed phase is **legitimately CPU-bound at ~190 docs/sec** and not a script bug — it matches the pure-bench numbers (~380 docs/s on cold CPU, ~190 on hot/throttled). The slow `CREATE INDEX` on a 10 GB WAL is the architecture's fault, not yours: every index node has to be journaled. There is one significant optimization left on the table (binary blob binding instead of JSON-stringified arrays) that should cut embed-phase serialization waste, plus a checkpoint-before-index step that would make the WAL bounded. Architecture itself is sound — `embeddings` side table with `vector_top_k` is the right shape, and the query bench SQL is correctly written. None of the findings below are blockers for proving the architecture works; address them before promoting this code into the worker.

---

## A. Correctness findings

1. **`user_prompts` INNER JOIN drops orphaned prompts** — `step2b-generate-embeddings.mjs:84-87`. The query `JOIN sdk_sessions s ON up.content_session_id = s.content_session_id` will silently skip any user_prompt whose sdk_session row is missing. The schema does have `ON DELETE CASCADE` for prompts when an sdk_session is deleted, so in steady state this is a no-op. But ChromaSync's `backfillPrompts` (lines 781-790) uses the **same** INNER JOIN, so this matches existing prod behavior — flagging only because in any DB where `ON DELETE CASCADE` was disabled or the integrity is suspect, both would silently drop rows. Not a regression vs Chroma, just a shared pre-existing gap. Severity: low.

2. **`merged_into_project` is hardcoded to `null` for prompts; production sets it from a separate path** — `step2b-generate-embeddings.mjs:144`. ChromaSync's `formatUserPromptDoc` (`ChromaSync.ts:409-422`) doesn't include `merged_into_project` in prompt metadata at all, and prompts have no such column on the `user_prompts` table. So step2b's behavior is *identical to prod* for prompts. Self-flag here that the side-table column exists for prompts but will always be null. Not a bug — just keep the column nullable as it is.

3. **Empty-string check on `r.facts` is correct, but the condition `r.facts !== '[]'` is redundant given the `JSON.parse → Array.isArray → length` flow** — `step2b-generate-embeddings.mjs:106`. If `facts` is `'[]'`, `JSON.parse` returns `[]`, the for-loop body never runs, and zero docs are added. The shortcut is harmless and saves one parse, but worth noting it's purely an optimization, not a correctness check. No bug.

4. **`Array.from(out.data.slice(off, off + 384))` produces a 384-length number array but does not validate length** — `step2b-generate-embeddings.mjs:204`. If for any reason `out.data.length` is unexpected (e.g. model returns sequence-level instead of pooled output), the slice can be short and `vector32(?)` will be called with a wrong-dim JSON string. libSQL will throw on `F32_BLOB(384)` mismatch, but only at insert time, killing the whole batch transaction. Recommend asserting `out.data.length === slice.length * 384` per call. Severity: low (tested config has been stable, but defense-in-depth matters at 548k rows).

5. **`text` column on observations is legacy and unused — but step2b reads it.** `step2b-generate-embeddings.mjs:75, 103-105`. Per `ChromaSync.ts:320` (`text: null, // Legacy field, not used`), live writes set `text: null`. However, the query selects it and embeds it if non-empty. This is **correct** because old rows in the existing DB *do* have non-null `text` values that Chroma was embedding — preserving them is the desired behavior. Not a bug, but worth a one-line comment in the script noting that `text` is read for backfill compatibility only.

6. **`merged_into_project` gets carried forward to embeddings rows but ChromaSync filters it out at insert time** — `step2b-generate-embeddings.mjs:115, 217` vs `ChromaSync.ts:248-250` (the `cleanMetadatas` filter strips empty/null values from metadata). step2b stores literal `null` in the new `merged_into_project` TEXT column. This is a **behavioral improvement** over Chroma (which omitted the key entirely when null), not a regression. Search code reading the side table will need to handle null values explicitly — confirm the worker query layer is ready for that. Severity: low/informational.

7. **`Float32Array` precision via `JSON.stringify`** — `step2b-generate-embeddings.mjs:204, 216`. Round-tripping through `Array.from(Float32Array)` → `JSON.stringify` → `vector32()` is lossless for finite floats: `Array.from` widens to fp64 (no precision loss for inputs that are already fp32-representable), `JSON.stringify` emits enough digits to round-trip fp64, and `vector32()` truncates back to fp32 — net result is bit-identical to the source bytes. **No precision bug.** However, `NaN` and `±Infinity` would JSON-stringify as `null` and crash `vector32()`. With `normalize: true` set, these are extremely unlikely (would require a zero-norm vector → division by zero), but recommend a sanity check on `out.data` for NaN per row in defensive prod code. Severity: low.

8. **Embedding-text equivalence with ChromaSync is exact** — verified `narrative`, `text`, each `fact` are passed as raw strings without title/subtitle/concept concatenation. ChromaSync stores `title` only as metadata, never as embedded document content (`ChromaSync.ts:135-156`). step2b reproduces this exactly. ✅

---

## B. Perf wins already in place (validated)

1. **Length-sorted batching** (`step2b:171`) — correctly applied after truncation. Confirmed against `bench-embed-truncated.mjs` finding that length-sort kills padding waste.
2. **Truncate to 1000 chars** (`step2b:34, 158-163`) — bench-embed-truncated showed this is necessary to avoid padding the long-tail. 256-token model cap = ~1024 chars max useful input.
3. **DROP+CREATE not DELETE FROM** (`step2b:51-52`) — `bench-insert-isolate.mjs` finding (UNIQUE-constraint lookups against WAL pages slow inserts ~90× after DELETE) is correctly applied.
4. **`client.batch()` not per-row `tx.execute`** (`step2b:219`) — `bench-insert-real.mjs` finding rendered through. Note: total insert cost was only 107s of 2882s = 3.7%, so insert-method choice has limited impact in this run.
5. **Index built AFTER population** (`step2b:239-243`) — correct, otherwise every UPDATE rebuilds the HNSW.
6. **EMBED_BATCH=32 / TX_BATCH=256** — these are both at validated peaks per bench-embed-real (32 won on real text). TX_BATCH=256 is fine but is **not tuned** — see perf #5.

---

## C. Perf left on the table (prioritized by expected gain)

### 1. Bind embeddings as `Uint8Array` (raw blob) instead of `JSON.stringify(vec)` — **~5–15% total speedup**
`step2b:204, 216`. The current pipeline is: Float32Array → `Array.from()` (widen to fp64) → `JSON.stringify` (~10 bytes per float = ~3.8 KB per row) → re-parse on the SQLite side → fp32 truncate. At 548k rows this is **~2 GB of text passing through the SQL bind layer.**

**Fix:** libSQL's `InValue` type accepts `Uint8Array` directly (verified in `node_modules/@libsql/core/lib-esm/api.d.ts:436`). Replace:
```js
JSON.stringify(Array.from(out.data.slice(off, off + 384)))
```
with:
```js
new Uint8Array(out.data.buffer, out.data.byteOffset + off * 4, 384 * 4)
```
and change SQL from `VALUES (..., vector32(?))` to `VALUES (..., ?)` (`F32_BLOB` accepts raw blob bytes directly — `vector32()` is the SQL helper that *parses a JSON string into a blob*, so when you already have the blob bytes, skip it).

**Verify behaviour first**: write a tiny test that inserts via `Uint8Array` and round-trips through `vector_distance_cos` to confirm byte order matches `vector32()`'s output. libSQL stores F32 little-endian; `Float32Array.buffer` is platform-endian (little-endian on all modern targets, including Apple Silicon).

Expected gain: most of the 107s `insert` phase + ~5% off the `embed` phase (the Array.from + JSON.stringify happens inside the embed-phase critical path at `step2b:204`). Total: **30–60s saved on a 2882s run**. Small but free, and it removes 2 GB of allocation pressure during the run.

### 2. `PRAGMA wal_checkpoint(TRUNCATE)` before CREATE INDEX — **15–30 min saved on the index phase**
The 10 GB WAL is the single biggest reason CREATE INDEX is taking 25+ min. Every page the index scans has to be reconciled against WAL-resident newer versions. Worse: the CREATE INDEX itself adds substantially more WAL on top.

**Fix:** Insert two lines after the embed loop and before `CREATE INDEX`:
```js
console.log('[checkpoint] PRAGMA wal_checkpoint(TRUNCATE) ...');
await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
```
This forces all pending WAL pages back into the main DB and resets the WAL file to zero. Skip this and the OS file cache gets thrashed reading mostly-WAL data during index build.

Expected gain: **substantial** — checkpointing 10 GB sequentially is ~30s on NVMe; subsequent CREATE INDEX runs against pure main-DB pages with no WAL reconciliation. Could plausibly cut the in-flight index phase from 25+ min to 3–5 min.

### 3. `PRAGMA synchronous=NORMAL` for the bulk-load phase — **5–10% on insert phase**
`bench-insert-isolate.mjs` tested this and the comment in observation 78960 said "barely faster," but at production scale "barely faster" still scales linearly. With WAL mode (which is libSQL's default), `synchronous=NORMAL` is durable across crashes and only differs from `FULL` in fsync frequency.

**Fix:** before the embed loop:
```js
await client.execute('PRAGMA synchronous=NORMAL');
```
Restore to FULL after `CREATE INDEX` if the production worker wants stricter durability semantics for online writes. (Reasonable default to leave NORMAL — it's what most prod SQLite deployments use anyway.)

Expected gain: 5–10s shaved off the 107s insert phase. Marginal individually but stacks with #1 and #4.

### 4. Embedding ↔ insert pipelining — **save ~107s (the entire insert phase)**
Right now: embed all 256 rows → commit batch → embed next 256. Embedding is 96% of wall-clock; insert is 4%. Insert is sitting **idle** during embed phases.

**Fix:** maintain a single in-flight `client.batch()` promise. After the current EMBED_BATCH finishes, fire-and-forget the insert (don't `await`) and start the next embed. `await` the previous insert promise before starting the next, and `await` the final one after the loop.

```js
let pendingInsert = Promise.resolve();
for (...) {
  // embed
  await pendingInsert; // ensure prior insert finished
  pendingInsert = client.batch(stmts, 'write');
}
await pendingInsert;
```

Expected gain: nearly the entire insert phase (107s) hides behind the next embed phase. Total embed→done improvement: ~3.7%. Modest but trivial to implement and removes a serial dependency.

### 5. EMBED_BATCH/TX_BATCH tuning was **not** explored exhaustively
Bench-embed plateaued at 32 on real text under thermal load (observation 78947) but **with a cold CPU, batch=64 was faster** (observation 78945). The migration ran for 48 minutes — clearly the steady-state thermal-throttled regime, where 32 is right.

**However:** the migration log shows throughput steadily declining from ~290 docs/s at the start to 190 docs/s near the end (see `step2b-quantized-full.log`). That's not just thermal — it might also be that ETA estimation used early-batch rate to project the end. Not a fix needed; just confirm in step3 that the slowdown was thermal not data-shape.

Expected gain: 0. Already correctly chosen for the conditions.

### 6. Was `quantized=true` the right default? — **probably not**
User stated "fp32 wins on free correctness if performance is comparable." The bench reported ~14% speed delta. Real-text bench (78946, 78947) showed thermal variance dwarfs the quantized↔fp32 delta — i.e., they're **effectively comparable** under load. The migration ran with `quantized=true` and produced vectors that are NOT bit-compatible with existing Chroma (cos sim 0.987–0.995). Since we're regenerating from source text anyway, this is fine for *this* run, but:

**Recommend:** also run step2b with `--quantized=false` to confirm the perf delta at production scale on the same machine. If it's <20% slower, flip to fp32 by default — the bit-compat with the existing Chroma collection (which the user might restore from one day) is worth the small perf cost. The `--quantized=` CLI flag is already there, so no code change needed; just run a second migration into a separate scratch DB.

Expected gain: not a perf win — it's a correctness/operability win that costs ~10–20% on the embed phase.

### 7. Embedding loading — every doc object holds redundant per-row metadata copies
`step2b:93-99` copies `base = { parent_table, parent_id, project, created_at_epoch, merged_into_project }` then `{ ...base, field_type, ... }` for every field. With ~9 fields/doc avg over 548k docs, that's ~5M object spreads. JS engines optimize this fine but it's a big GC churn moment.

**Fix:** flatten the doc to keep `parent_id` only and re-look-up `project`/`created_at_epoch` via a single Map lookup at insert time. Not worth implementing for a 3-min build amortized over a one-off migration; flag if this becomes a worker-process hot path.

Expected gain: 5–10s of GC noise. Skip unless you see GC pause in prod traces.

---

## D. Architectural risks (numbered, with severity)

1. **No FOREIGN KEY constraints between `embeddings` and parent tables** — *medium*. `embeddings.parent_id` has no `REFERENCES observations(id) ON DELETE CASCADE`. If an observation is deleted (which the worker does for re-embedding flows), the embeddings row is orphaned and will appear in vector_top_k results with no joinable parent. ChromaSync handles this via collection-level `chroma_delete_documents` + watermark, but the libSQL design leaves it on the application layer. Recommend adding either:
   - `FOREIGN KEY(parent_id) REFERENCES observations(id) ON DELETE CASCADE` (only works when `parent_table='observations'` — would require split tables or a trigger), OR
   - An explicit "embeddings_GC" pass on worker startup that LEFT JOINs and deletes orphans.
   
   The polymorphic `parent_table` column makes a true FK impossible; triggers per parent_table are the cleanest. Defer; document in plan v4.

2. **`vector_top_k` JOIN shape in `step3-query-bench.mjs` is correct** — *no risk*. The `JOIN embeddings e ON e.rowid = k.id` works because libSQL's `vector_top_k` returns the rowid of the indexed table, and `e.rowid` aliases the integer primary key (`id INTEGER PRIMARY KEY AUTOINCREMENT`). Verified syntax matches the official libsql examples. ✅

3. **`vector_top_k` ANN result is post-filtered by `WHERE e.project = ?` in Variant B** — *medium operational risk*. With `FETCH_K=50` and `LIMIT TOP_K=20`, if a project has fewer than 20 docs in the ANN top-50, you'll return fewer than 20 results. With many small projects (the user has ~100 projects, claude-mem itself is the biggest), this will silently under-serve project-scoped queries. ChromaSync's existing `where: { project: targetProject }` is filtered server-side at query time, returning the top-K matches **within** the project, not the top-K-overall-then-filter-to-project. **This is a behavioral regression vs Chroma** that will manifest as "I asked for 20 hits in project X, got only 3."
   
   **Fix:** loop with increasing `FETCH_K` until you have enough rows after the filter, OR maintain per-project HNSW indexes (one index per project). Per-project indexes are likely the right answer at scale; libSQL supports building multiple `libsql_vector_idx` indexes on the same column with different WHERE clauses... actually it doesn't directly, but you can build them on filtered subset tables/views. Defer to plan v4 — flag explicitly that the simple `FETCH_K=50, filter, LIMIT 20` shape will under-serve small projects.

4. **In-memory load of all 548k doc objects** — *low for migration, medium for production*. Migration is a one-off; ~150 MB resident is fine. But if this same code shape lands in `ChromaSync.ts`'s replacement, the worker process will load the entire embeddings universe into memory at every backfill. **For production, the loop must stream** — `SELECT ... LIMIT N OFFSET M` or use libSQL streaming cursor (if available in the JS client; otherwise just LIMIT/OFFSET). Don't ship the migration's `.execute()`-then-load-all pattern as the hot worker code.

5. **`F32_BLOB(384)` is hardcoded** — *low*. The model dimension is determined by `Xenova/all-MiniLM-L6-v2`. If the worker ever swaps to `bge-small-en` (also 384) or `bge-base-en` (768), the schema needs to change. For now, OK. Document the dimension dependency in plan v4.

6. **`@xenova/transformers` model cache at `./models/`** — *low*. step2b sets `env.cacheDir = './models'` (relative to cwd). When this lands in the worker, it'll need to point at `$CLAUDE_MEM_DATA_DIR/models/` not `./models/` (the worker's cwd is unpredictable). Already noted in handoff §3. ✅

7. **The 10 GB WAL on a 1.5 GB main DB is a flag for the Railway container plan** — *medium*. If the libSQL DB lives on a Railway volume (1 GB free / $0.25 per GB-month above), this migration's transient WAL would saturate a typical volume size. Plan v4 needs to provision: main DB + 8x WAL safety margin during initial backfill. Or run `wal_checkpoint(TRUNCATE)` at end of every TX_BATCH (slower but bounded).

8. **No `IF NOT EXISTS` on the vector index inside step2b** — *low*. step2b drops + creates: `DROP INDEX IF EXISTS embeddings_vec_idx` then `CREATE INDEX embeddings_vec_idx ON ...`. If you re-run step2b mid-flight (after partial), the embeddings table is dropped and recreated, so the vector index is implicitly dropped with the table. Fine.

9. **No transaction around the schema bootstrap (`DROP TABLE` + `CREATE TABLE` + 2x `CREATE INDEX`)** — *low*. If the script crashes between the DROP and the second CREATE INDEX, the next run's DROP IF EXISTS handles it cleanly. Idempotent. ✅

10. **`step2b` does not honour `CLAUDE_MEM_DATA_DIR`** — *informational*. Hardcoded `file:claude-mem.libsql.db` — fine for the spike, but plan v4's worker code must derive the path from the data dir. Already noted in handoff. ✅
