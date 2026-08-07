"""Functional smoke for the vendored chroma-mcp fork: create an e5-multilingual
collection in a TEMP persistent dir, add a doc, query it, restart the client
(persistence), and print the persisted EF config from chroma.sqlite3.
Mirrors acceptance criteria 1-2 of plans/2026-07-29-e5-embedding-migration.md.
"""

import asyncio
import importlib.util
import json
import os
import sqlite3
import sys

data_dir = sys.argv[1]

spec = importlib.util.spec_from_file_location(
    "chroma_mcp_server",
    os.path.join(os.path.dirname(__file__), "src", "chroma_mcp", "server.py"),
)
server = importlib.util.module_from_spec(spec)
sys.argv = ["chroma-mcp", "--client-type", "persistent", "--data-dir", data_dir]
spec.loader.exec_module(server)


async def main():
    # create with the fork's EF
    print(
        await server.chroma_create_collection(
            collection_name="cm__e5-smoke",
            embedding_function_name="e5-multilingual",
        )
    )

    # hardening check: add to a nonexistent collection must FAIL
    try:
        await server.chroma_add_documents(
            collection_name="cm__never-created", documents=["x"], ids=["x"]
        )
        print("HARDENING-FAIL: auto-create still possible")
    except Exception as e:
        print(f"HARDENING-OK: {type(e).__name__}: {str(e)[:120]}")

    await server.chroma_add_documents(
        collection_name="cm__e5-smoke",
        documents=["настройка прокси для huggingface", "dns resolver config"],
        ids=["ru1", "en1"],
    )
    result = await server.chroma_query_documents(
        collection_name="cm__e5-smoke", query_texts=["как скачать модель через прокси"], n_results=1
    )
    print("QUERY-OK:", json.dumps(result.get("ids")))


asyncio.run(main())

# simulate restart: fresh client, query again (EF rebuilt from persisted config)
server._chroma_client = None

import chromadb

client2 = chromadb.PersistentClient(path=data_dir)
coll = client2.get_collection("cm__e5-smoke")  # build_from_config path
q = coll.query(query_texts=["proxy settings"], n_results=1)
print("RESTART-QUERY-OK:", json.dumps(q.get("ids")))

db = sqlite3.connect(os.path.join(data_dir, "chroma.sqlite3"))
row = db.execute("SELECT schema_str FROM collections WHERE name='cm__e5-smoke'").fetchone()
schema = row[0] if row else ""
assert '"sentence_transformer"' in schema and "intfloat/multilingual-e5-small" in schema, schema[
    :500
]
print("PERSISTED-CONFIG-OK:", schema[:300])
