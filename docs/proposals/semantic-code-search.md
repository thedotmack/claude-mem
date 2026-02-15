# Proposal: Semantic Code Search (mgrep-like local alternative)

**Status:** Research complete, parked for later
**Date:** 2026-02-15
**Inspired by:** [mixedbread-ai/mgrep](https://github.com/mixedbread-ai/mgrep)

## Summary

Add mgrep-like semantic code search to claude-mem. Fully local (no cloud API), leveraging existing Chroma infrastructure. Natural language queries across code, docs, and PDFs.

## Why

- New contributors or large unfamiliar codebases benefit from natural language code queries
- Serena handles structural/symbolic navigation well, but fuzzy cross-cutting concept search ("where do we handle retry logic") has no good local solution
- claude-mem already has ~80% of the infrastructure (Chroma, MCP server, Worker service, search orchestrator)

## Embedding Model: Snowflake Arctic Embed XS (ONNX)

Replace current `all-MiniLM-L6-v2` (default Chroma) with **Snowflake Arctic Embed XS**:

| Model | Params | Disk | MTEB Retrieval | Speed |
|-------|--------|------|----------------|-------|
| **Arctic Embed XS (int8)** | **22M** | **~23MB** | **50.15** | Very Fast |
| all-MiniLM-L6-v2 | 22M | ~45MB | 41.95 | Very Fast |
| BGE-Small-EN-v1.5 | 33M | ~67MB | 51.68 | Fast |
| nomic-embed-text-v1.5 | 137M | ~275MB | 53.25 | Medium |

Arctic XS int8 ONNX: same size as MiniLM, ~20% better retrieval, no PyTorch dependency.

### Custom ONNX MCP Server

The standard `chroma-mcp` (via `uvx`) doesn't support custom HuggingFace models. Solution: custom Python MCP server using pure ONNX runtime.

```python
# Dependencies: chromadb, onnxruntime, tokenizers, numpy, huggingface_hub, mcp[cli]
# No PyTorch required

class ArcticXSEmbeddingFunction(EmbeddingFunction):
    def __init__(self):
        # Auto-downloads ~23MB int8 ONNX model from HuggingFace
        self.session = ort.InferenceSession("model_int8.onnx")
        self.tokenizer = Tokenizer.from_file("tokenizer.json")

    def __call__(self, input: Documents) -> Embeddings:
        # Tokenize -> ONNX inference -> mean pooling -> L2 normalize
        encoded = self.tokenizer.encode_batch(input)
        input_ids = np.array([e.ids for e in encoded], dtype=np.int64)
        attention_mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
        token_type_ids = np.array([e.type_ids for e in encoded], dtype=np.int64)

        outputs = self.session.run(None, {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "token_type_ids": token_type_ids
        })

        embeddings = outputs[0]
        mask_expanded = np.expand_dims(attention_mask, -1)
        sum_embeddings = np.sum(embeddings * mask_expanded, axis=1)
        sum_mask = np.clip(mask_expanded.sum(axis=1), a_min=1e-9, a_max=None)
        pooled = sum_embeddings / sum_mask

        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        normalized = pooled / np.clip(norms, a_min=1e-9, a_max=None)
        return normalized.tolist()
```

Spawn via `uv run` (same as current `uvx chroma-mcp` - no Python install required from user).

## Architecture

### Phase 1 - Core Code Search

**File Indexing Pipeline:**
- File discovery: `git ls-files` (respects .gitignore)
- Custom `.cmsearchignore` support via `ignore` npm package
- Code chunking: ~500 lines per chunk with line range tracking
- SQLite metadata: file path, content hash, language, last_indexed, line_start/end
- Chroma indexing via custom Arctic XS MCP server
- Config: max file size (default 1MB), max file count (default 1000)

**Sync Strategy (no file watcher needed):**
- On search with `--sync`: `git ls-files` -> compare hashes in SQLite -> re-index changed/new, remove deleted
- Git-based diffing is reliable across all platforms (Windows, WSL, macOS, Linux)
- Optional: `@parcel/watcher` for real-time watch mode (Phase 2)

**MCP Tool:**
```typescript
{
  name: 'code_search',
  params: { query, language?, path?, limit?, sync? },
  returns: [{ file_path, line_start, line_end, snippet, score }]
}
```

**New Worker Routes:**
- `GET /api/search/code?query=...&language=ts&limit=20`
- `GET /api/code-files/list` (indexed files)
- `POST /api/code-files/sync` (trigger re-index)

### Phase 2 - Multi-Document

- PDF extraction (`pdfjs-dist`) with page number tracking
- Markdown/text files (same pipeline)
- Images: skip unless vision embedding model becomes lightweight

### Phase 3 - Agent Features

- `--answer` mode: pass search results to SDK agent for synthesis
- `--agentic` mode: multi-query refinement via existing agent loop
- `--web` mode: merge ddg-search results with local results
- Reranking via cross-encoder (optional, moderate effort)

## mgrep Feature Parity

| mgrep Feature | claude-mem Has | Gap |
|---|---|---|
| Natural language search | ChromaSync + SearchOrchestrator | Just needs code indexing |
| File watching (`watch`) | Nothing | `@parcel/watcher` or git-based sync |
| Sync before search (`--sync`) | Nothing | `git ls-files` + hash comparison |
| Multi-doc: code | Nothing | File chunker with line ranges |
| Multi-doc: PDFs | Nothing | `pdfjs-dist` |
| Multi-doc: images | Nothing | Vision model (heavy, skip) |
| Reranking | Nothing | Cross-encoder or sort by distance |
| Result format (path + line range) | Observation format only | New result type |
| `.gitignore` / ignore files | Nothing | `ignore` npm package |
| Max file size / count limits | Nothing | Config check |
| Content preview (`--content`) | Full observation bodies | Read file at line range |
| MCP tool for agents | Already exists | Add `code_search` tool |
| Store management | Chroma collections per project | Already there |
| Web search (`--web`) | ddg-search MCP exists | Combine results |
| Agentic multi-query | SDK agent infrastructure | Reuse existing agents |
| Synthesized answer (`--answer`) | SDK agent with Claude | Reuse existing pipeline |

## Existing Infrastructure to Reuse

| Component | Reuse |
|-----------|-------|
| ChromaSync | Extend with `doc_type: 'source_code'` + new metadata fields |
| SearchOrchestrator | Add CodeSearchStrategy alongside existing strategies |
| MCP Server | Add `code_search` tool (thin HTTP proxy pattern) |
| Worker Service | New `CodeIndexManager` following existing manager pattern |
| SettingsManager | Extend for code search config (ignore patterns, limits) |
| SQLite layer | New `CodeFileStore` for file metadata tracking |

## New Components (~1500 lines)

| Component | Lines | Purpose |
|-----------|-------|---------|
| `arctic-chroma-server.py` | ~100 | Custom ONNX MCP server |
| `CodeIndexManager.ts` | ~400 | Orchestrates indexing pipeline |
| `CodeChunker.ts` | ~200 | Split files into indexable chunks |
| `CodeFileStore.ts` | ~200 | SQLite tracking of indexed files |
| `CodeSearchRoutes.ts` | ~200 | HTTP endpoints |
| ChromaSync extensions | ~100 | `syncSourceFile()` method |
| MCP server extensions | ~100 | New tools |
| Config/ignore handling | ~200 | Settings + .gitignore parsing |

## Platform Considerations

- **File watching:** Git-based sync preferred over chokidar/fs.watch (WSL2 cross-boundary issues)
- **Python:** Not required - `uv` auto-manages Python environment (same as current `uvx chroma-mcp`)
- **ONNX model:** Auto-downloaded from HuggingFace on first use (~23MB)

## Decision Log

- Arctic XS over MiniLM: 20% better retrieval, same size, ONNX int8 available
- Custom MCP server over hacking `chroma-mcp`: full control, same dependency footprint
- Git-based sync over file watcher: reliable cross-platform, simpler
- Separate from Serena: Serena = structural/symbolic, this = fuzzy/conceptual
- Local-only, no cloud: privacy, offline, no API key
- Parked: current users have Serena; revisit when targeting new contributors / larger codebases

## References

- [mgrep](https://github.com/mixedbread-ai/mgrep) - inspiration
- [Snowflake Arctic Embed XS](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs) - ONNX model
- [Arctic Embed XS int8 ONNX](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/blob/refs%2Fpr%2F8/onnx/model_int8.onnx) - quantized variant (~23MB)
