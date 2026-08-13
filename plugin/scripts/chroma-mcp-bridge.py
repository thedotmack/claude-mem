#!/usr/bin/env python3
"""claude-mem's pinned chroma-mcp bridge.

chroma-mcp 0.2.6's ``chroma_add_documents`` fetches every existing ID before
each add. That makes a rebuild quadratic and pushes ordinary batches past the
MCP client's 60-second deadline once a collection grows. Chroma's native
``Collection.add`` already rejects duplicate IDs, so this bridge replaces only
that tool with a direct, validation-equivalent call and leaves every other
upstream tool untouched.
"""

import os
from threading import Lock
from typing import Dict, List


def _lower_process_priority() -> None:
    """Keep local embedding/index work from competing with interactive apps."""
    if not hasattr(os, "setpriority") or not hasattr(os, "PRIO_PROCESS"):
        return

    try:
        configured = int(os.environ.get("CLAUDE_MEM_CHROMA_NICE_LEVEL", "15"))
    except ValueError:
        configured = 15

    target = min(20, max(0, configured))
    try:
        current = os.getpriority(os.PRIO_PROCESS, 0)
        # Never raise the priority when a caller already launched us with a
        # lower priority (for example an isolated rebuild under nice -n 20).
        if target > current:
            os.setpriority(os.PRIO_PROCESS, 0, target)
    except OSError:
        # Priority lowering is a load-safety optimization, not a condition for
        # serving MCP. Sandboxed platforms may deny setpriority entirely.
        pass


# Apply priority before importing Chroma/ONNX, whose module initialization can
# perform CPU-heavy native work as well as the later embedding calls.
_lower_process_priority()

from chromadb.api.types import DefaultEmbeddingFunction
from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
from chroma_mcp.server import get_chroma_client, main, mcp


# Chroma's DefaultEmbeddingFunction constructs ONNXMiniLM_L6_V2 inside every
# __call__. chroma-mcp resolves a new collection facade for each MCP request,
# so a rebuild otherwise reloads the same model for every 100-document batch.
# Patch the class method so even already-created default instances share one
# lazy model/tokenizer/session. The lock keeps a semantic query from racing a
# backfill mutation through the same tokenizer/session object.
_cached_onnx_embedding_function = ONNXMiniLM_L6_V2()
_embedding_lock = Lock()


def _cached_default_embedding_call(self, input):
    with _embedding_lock:
        return _cached_onnx_embedding_function(input)


DefaultEmbeddingFunction.__call__ = _cached_default_embedding_call


async def chroma_add_documents_fast(
    collection_name: str,
    documents: List[str],
    ids: List[str],
    metadatas: List[Dict] | None = None,
) -> str:
    """Add documents without chroma-mcp's full-collection duplicate scan."""
    if not documents:
        raise ValueError("The 'documents' list cannot be empty.")
    if not ids:
        raise ValueError("The 'ids' list is required and cannot be empty.")
    if any(not document_id.strip() for document_id in ids):
        raise ValueError("IDs cannot be empty strings.")
    if len(ids) != len(documents):
        raise ValueError(
            f"Number of ids ({len(ids)}) must match number of documents ({len(documents)})."
        )
    if metadatas is not None and len(metadatas) != len(documents):
        raise ValueError(
            f"Number of metadatas ({len(metadatas)}) must match number of documents ({len(documents)})."
        )

    # Defense in depth for callers outside ChromaSync. SQLite's FTS5 trigram
    # tokenizer persists a malformed inverted index when a document contains
    # NUL, even though the add itself reports success.
    documents = [document.replace("\x00", "\ufffd") for document in documents]

    try:
        collection = get_chroma_client().get_or_create_collection(collection_name)
        collection.add(documents=documents, metadatas=metadatas, ids=ids)
        return f"Successfully added {len(documents)} documents to collection {collection_name}"
    except Exception as error:
        raise Exception(
            f"Failed to add documents to collection '{collection_name}': {error}"
        ) from error


tool_manager = getattr(mcp, "_tool_manager", None)
registered_tools = getattr(tool_manager, "_tools", None)
if not isinstance(registered_tools, dict) or "chroma_add_documents" not in registered_tools:
    raise RuntimeError("Unsupported chroma-mcp/FastMCP tool registry; refusing an unverified bridge")

del registered_tools["chroma_add_documents"]
mcp.add_tool(
    chroma_add_documents_fast,
    name="chroma_add_documents",
    description="Add documents to a Chroma collection.",
)


if __name__ == "__main__":
    main()
