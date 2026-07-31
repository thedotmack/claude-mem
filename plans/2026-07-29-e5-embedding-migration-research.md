# multilingual-e5 Embedding Migration — Research Handoff (External Evidence Base)

Date: 2026-07-29. Status: research complete, feeds the plan in
`plans/2026-07-29-e5-embedding-migration.md`. Companion doc — read that one
first for the design; read this one for why each step is safe.

Produced in the `search` project under its evidentiality protocol: structural
dorking for recall, verbatim-quote extraction from fetched primary sources,
deterministic fact-gate before anything is called a fact. The full claim graph
lives in the `search` repo at `knowledge/agent-memory/chroma-mcp-e5-migration.md`
(claims c-1008…c-1013, + 4 source files in `knowledge/sources/`) and passes
`python -m engine.epistemics_lint`. This file is the self-contained summary —
you do not need the other repo to act on it.

## Corpus (all fetched 2026-07-29)

| Source | URL | Dated | What it is |
| --- | --- | --- | --- |
| chroma-mcp repo (server.py, README, CHANGELOG) | github.com/chroma-core/chroma-mcp | 2025-08-14 (CHANGELOG 0.2.6) | The MCP server claude-mem spawns; vendor's own code/docs |
| chromadb `SentenceTransformerEmbeddingFunction` source | raw.githubusercontent.com/chroma-core/chroma/main/chromadb/utils/embedding_functions/sentence_transformer_embedding_function.py | 2026-07-29 (main branch) | chromadb's built-in sentence-transformers EF |
| intfloat/multilingual-e5-small model card | huggingface.co/intfloat/multilingual-e5-small | 2024-02 (paper arXiv:2402.05672) | Authors' own model card |
| Local Chroma store inspection | `~/.claude-mem/chroma/chroma.sqlite3` (sqlite3 CLI) | 2026-07-29 | Direct witness of the live collection config on this machine |

All are primary sources for *de jure* questions ("what does the code/the model
card prescribe"); vendor self-description stance does not matter for this
claim type.

## Findings — fact-gate passed

**F1. chroma-mcp CAN swap the embedding function, but only from a fixed
built-in list. e5 / sentence-transformers is not on it.**
server.py: *"mcp_known_embedding_functions: Dict[str, EmbeddingFunction] = {
"default": DefaultEmbeddingFunction, "cohere": CohereEmbeddingFunction,
"openai": OpenAIEmbeddingFunction, "jina": JinaEmbeddingFunction, "voyageai":
VoyageAIEmbeddingFunction, "roboflow": RoboflowEmbeddingFunction, }"* and the
selected class is instantiated **with no arguments**:
*"embedding_function = mcp_known_embedding_functions[embedding_function_name]
... configuration=CreateCollectionConfiguration( embedding_function=embedding_function() )"*.
README: *"Chroma MCP supports several embedding functions: `default`, `cohere`,
`openai`, `jina`, `voyageai`, and `roboflow`."* CHANGELOG 0.2.1 (2025-04-03)
introduced the selection; latest release 0.2.6 (2025-08-14) added none.

**F2. claude-mem-dev creates collections without `embedding_function_name` →
the default MiniLM EF is in effect today.**
`src/services/sync/ChromaSync.ts:125`: `await
chromaMcp.callTool('chroma_create_collection', { collection_name:
this.collectionName });` — the parameter defaults to `"default"`. The spawned
server is pinned: `CHROMA_MCP_PINNED_VERSION = '0.2.6'`
(`ChromaMcpManager.ts:33`), launched via `uvx --from chroma-mcp==0.2.6
chroma-mcp` (`buildLauncherPrefix`, ~line 515-523).
Local witness: the live store has one collection `cm__claude-mem`,
`dimension = 384`, persisted config
`"embedding_function":{"type":"known","name":"default","config":{}}`.

**F3. The embedding function persists in the collection configuration — old
collections cannot be re-shoed; migration = recreate + reindex.**
README: *"The embedding functions utilize Chroma's collection configuration,
which persists the selected embedding function of a collection for retrieval.
Once a collection is created using the collection configuration, on retrieval
for future queries and inserts, the same embedding function will be used,
without needing to specify the embedding function again."* (Persistence added
in Chroma v1.0.0.) The local `schema_str` in F2 shows exactly this mechanism
in the live store.

**F4. chromadb's `SentenceTransformerEmbeddingFunction` takes any
`model_name`, is registry-known (`sentence_transformer`), and round-trips
through the persisted collection config — so e5 via this EF persists and
restores across server restarts with no custom registration.**
Source: *"def __init__( self, model_name: str = "all-MiniLM-L6-v2", device:
str = "cpu", normalize_embeddings: bool = False, **kwargs: Any, )"*,
*"@staticmethod def name() -> str: return "sentence_transformer""*, and
`get_config()` returns `{model_name, device, normalize_embeddings, kwargs}` /
`build_from_config()` reconstructs from it. The dependency is optional and
lazy: *"The sentence_transformers python package is not installed. Please
install it with `pip install sentence_transformers`"*.

**F5. multilingual-e5 models are trained with `query: `/`passage: ` prefixes;
without them the authors state quality degrades. e5-small is 384-dim (same as
all-MiniLM-L6-v2), 512-token context, 100 languages.**
Model card: *"Each input text should start with "query: " or "passage: ",
even for non-English texts."* FAQ: *"Yes, this is how the model is trained,
otherwise you will see a performance degradation."* *"This model has 12 layers
and the embedding size is 384."* Russian retrieval on Mr. TyDi: small 60.8
MRR@10 vs BM25 32.9 (authors' benchmark). Works via sentence-transformers
natively: *"model = SentenceTransformer('intfloat/multilingual-e5-small')
... embeddings = model.encode(input_texts, normalize_embeddings=True)"*.

## Verdict on the migration question

"Can chroma-mcp swap the embedding function?" — **Yes, by design, but the list
is closed and e5 is not in it.** The cheap, registry-safe path is a minimal
fork of chroma-mcp that adds one factory entry wrapping
`SentenceTransformerEmbeddingFunction(model_name="intfloat/multilingual-e5-small",
normalize_embeddings=True)` — a *known* EF name, so persistence/restart works
stock (F4). Everything else is two line-level touch points in claude-mem-dev
plus a full reindex (F2, F3).

## Gotchas confirmed in the sources

- **Auto-create bypass.** `chroma_add_documents` in chroma-mcp calls
  `get_or_create_collection(collection_name)` with NO configuration — if an
  add lands before the create, the collection is born with the default EF and
  the fork never gets a say.
- **Docstring lies.** `chroma_create_collection`'s docstring lists `ollama`
  as an option, but no such key exists in the dict → KeyError on use.
- **No-prefix degradation (F5).** The stock ST EF adds no `query: `/`passage: `
  prefixes. A prefix-adding custom EF is possible but must solve config
  persistence for a non-registry EF name — that is a phase-2 question, not MVP.

## Gaps (not verified in this research)

- Exact `--from` spec format uvx accepts for a fork (git URL vs local path) —
  verify first during implementation; vendoring the fork as a local path is
  the recommended offline-safe default.
- Real-world cost of skipping e5 prefixes on this project's Russian data —
  measure on MVP before building the prefix wrapper.
- ONNX build of e5 without the torch dependency — not investigated.
- Dependency weight: sentence-transformers pulls torch+transformers (~1 GB
  into the uvx env) + model download on first start (~470 MB fp32 for
  e5-small). Sizes are estimates, not measured.
