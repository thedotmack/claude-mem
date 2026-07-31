# multilingual-e5 Embedding Migration (MiniLM → e5)

Date: 2026-07-29. Status: research validated (evidence base:
`plans/2026-07-29-e5-embedding-migration-research.md`, fact-gate passed),
ready for implementation. Suggested branch: `feat/e5-embeddings`.

## Problem

All vector search runs on Chroma's default embedding function,
all-MiniLM-L6-v2 (384-dim, English-centric). Russian-language observations and
mixed Russian+code content embed poorly, so semantic recall over memory
underperforms for a large share of actual usage. Collections are created with
no explicit EF (`ChromaSync.ts:125`), so the default is silently in effect and
persisted into every `cm__*` collection config (research F2, F3).

## Proposal

Move embeddings to `intfloat/multilingual-e5-small` (384-dim — same dimension
as MiniLM — 100 languages, 512-token context) via a **minimal fork of
chroma-mcp** that registers one extra embedding-function factory, plus two
line-level touch points in this repo, plus a one-time full reindex from SQLite.

MVP scope: **no `query: `/`passage: ` prefixes** (research F5 — works with
documented degradation, keeps the EF registry-known and persistence stock).
Prefix wrapper is phase 2, gated on measuring the degradation on real data.

### Change 1 — fork `chroma-mcp` (vendored at `vendor/chroma-mcp/`)

In `src/chroma_mcp/server.py`, one entry in the existing dict (research F1 —
values are used as zero-arg factories, hence the lambda):

```python
from chromadb.utils.embedding_functions import (
    # ...existing imports...
    SentenceTransformerEmbeddingFunction,
)

mcp_known_embedding_functions: Dict[str, EmbeddingFunction] = {
    # ...existing entries unchanged...
    "e5-multilingual": lambda: SentenceTransformerEmbeddingFunction(
        model_name="intfloat/multilingual-e5-small",
        normalize_embeddings=True,
    ),
}
```

Why this is registry-safe (research F4): `SentenceTransformerEmbeddingFunction`
is a built-in chromadb EF with `name() == "sentence_transformer"`; its
`get_config()`/`build_from_config()` round-trip through the persisted
collection configuration, so collections created with it survive server
restarts with no custom registration.

Also in the fork:

- `pyproject.toml`: add `sentence-transformers` dependency (pulls torch +
  transformers — see Risks).
- Fix the `chroma_create_collection` docstring while there (lists `ollama`,
  which is not in the dict — research, Gotchas).
- Harden `chroma_add_documents`: replace `get_or_create_collection` with
  `get_collection` + explicit error, so a collection can never be auto-born
  with the default EF bypassing the fork (research, Gotchas). Verify no
  claude-mem path relies on auto-create first (`ensureCollectionExists` is
  expected to always run before writes).

### Change 2 — spawn the fork (`src/services/sync/ChromaMcpManager.ts`)

`buildLauncherPrefix` (~line 515) currently emits
`--from chroma-mcp==0.2.6`. Point it at the vendored fork:

```
'--from', './vendor/chroma-mcp', 'chroma-mcp',
```

(Local path preferred over a git URL: no network dependency at spawn time.
The exact `--from` spec uv accepts for a local path is the first thing to
verify — research, Gaps.) Keep `CHROMA_MCP_DEP_OVERRIDES` (onnxruntime /
protobuf pins, issue #2371) — they apply to the same subprocess and are still
needed. Update `CHROMA_MCP_PINNED_VERSION` semantics or replace with a fork
ref constant; make the EF name a constant alongside it.

### Change 3 — request the EF at creation (`src/services/sync/ChromaSync.ts`)

`ensureCollectionExists` (line ~125):

```ts
await chromaMcp.callTool('chroma_create_collection', {
  collection_name: this.collectionName,
  embedding_function_name: CHROMA_EMBEDDING_FUNCTION, // 'e5-multilingual'
});
```

Expose the name via `SettingsDefaultsManager` (new key, e.g.
`CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION`, default `e5-multilingual`) so rollback
is a one-line config change.

### Change 4 — data migration (one-time)

The source of truth is SQLite; Chroma is always rebuildable.

1. Delete all `cm__*` collections (`chroma_delete_collection`), or remove
   `~/.claude-mem/chroma` entirely.
2. Reset the backfill watermarks consumed by `runBackfillPipeline`
   (`ChromaSync.ts:722+`) — otherwise the smart backfill skips everything
   already watermarked.
3. Start the worker; the stock `ensureBackfilled` (`ChromaSync.ts:707`)
   re-embeds all observations/summaries/prompts with e5.

Same dimension (384) as MiniLM, but vectors are **not** compatible — reindex
is mandatory regardless (research F3, F5).

### What this is NOT

- Not a protocol change: the EF name travels in the existing
  `embedding_function_name` parameter of `chroma_create_collection`.
- Not a prefix-correct e5 integration: MVP skips `query: `/`passage: `
  prefixes (phase 2, after measuring).
- Not a model-size commitment: e5-base/large (768/1024-dim) stay out of scope;
  small matches the current dimension and is the cheapest migration.

## Implementation outline

1. Vendor the chroma-mcp fork; verify `uvx --from ./vendor/chroma-mcp
   chroma-mcp --help` starts and the prewarm path
   (`ChromaMcpManager.buildPrewarmCommandArgs`) still works. Raise
   `CHROMA_PREWARM_TIMEOUT` if the first torch/model download exceeds it.
2. Apply Changes 2–3 + settings key; unit-test the launcher-prefix builder
   and the create-collection call args.
3. Run the data migration on a copy of the live store; verify acceptance
   criteria below.
4. Measure: pick 5–10 real Russian prompts/observations that MiniLM failed to
   surface, confirm they now rank top-5; smoke 3–5 English queries for
   regressions. Record results in this doc — this measurement is the gate for
   phase 2 (prefix wrapper) and cannot be skipped.
5. Phase 2 (only if the measurement shows real degradation): custom EF wrapper
   adding `query: `/`passage: ` prefixes, with its persistence story
   (non-registry EF name in collection config) designed and tested explicitly.

## Acceptance criteria

1. New collections show
   `"embedding_function":{"type":"known","name":"sentence_transformer","config":{"model_name":"intfloat/multilingual-e5-small",...}}`
   in `schema_str` of `chroma.sqlite3`.
2. Persistence test: create → full worker + chroma-mcp restart →
   `chroma_query_documents` succeeds (no EF reconstruction errors).
3. Russian recall: previously-failing Russian queries return relevant hits in
   top-5.
4. English smoke: no obvious regression on 3–5 typical queries.
5. Cold start: prewarm with the new dependency completes within the
   configured timeout.

## Rollback

Restore `--from chroma-mcp==0.2.6`, set the EF setting back to `default` (or
remove the parameter), delete `cm__*`, re-run the backfill. Nothing is
irreversible — SQLite holds the truth and Chroma rebuilds from it.

## Risks

- **Dependency weight**: sentence-transformers pulls torch+transformers (~1 GB
  uvx env, estimate) + ~470 MB model download on first start (e5-small fp32,
  estimate). Mitigations: prewarm exists; ONNX e5 without torch is a
  not-investigated alternative (research, Gaps).
- **Fork maintenance**: one more artifact to track upstream — consistent with
  the existing pin+overrides regime, but real.
- **Auto-create bypass**: covered by the fork hardening in Change 1; verify
  the create-before-write invariant holds in all sync paths.

## Effort estimate (expert judgement, not gate-verified)

- MVP (this plan): ~1 working day including acceptance tests.
- Full version (prefix wrapper or ONNX + regression suite): 2–3 days, half of
  it persistence/quality testing rather than code.
