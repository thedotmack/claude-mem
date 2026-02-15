#!/usr/bin/env python3
"""
Backfill ChromaDB vector index from existing SQLite observations.

After resetting claude-mem's vector-db directory (e.g. to fix HNSW corruption),
this script repopulates ChromaDB from the SQLite database which retains all data.

It replicates the exact document format used by claude-mem's ChromaSync.ts,
so semantic search works identically to real-time indexed documents.

Requirements:
    pip install chromadb   (or run via: uvx --from chromadb python3 backfill-chroma.py)

Usage:
    python3 scripts/backfill-chroma.py                          # uses defaults (~/.claude-mem/)
    python3 scripts/backfill-chroma.py --dry-run                # preview without writing
    python3 scripts/backfill-chroma.py --db ~/custom/path.db    # custom DB path
    python3 scripts/backfill-chroma.py --host 10.0.0.5          # non-default Chroma host

Safe to run multiple times — skips documents that already exist in ChromaDB.

Use cases:
    - Rebuild vector index after HNSW corruption (see #1110)
    - Restore semantic search after migrating to a new machine
    - Re-index after ChromaDB version upgrades that change index format
    - Re-embed after switching embedding models
    - Development/testing: nuke and rebuild the index cleanly
"""

import argparse
import json
import os
import sqlite3
import sys

BATCH_SIZE = 50


def get_default_db_path():
    """Resolve the default claude-mem database path."""
    # Check CLAUDE_MEM_DATA_DIR env var first (matches claude-mem's own resolution)
    data_dir = os.environ.get("CLAUDE_MEM_DATA_DIR")
    if data_dir:
        return os.path.join(data_dir, "claude-mem.db")
    return os.path.join(os.path.expanduser("~"), ".claude-mem", "claude-mem.db")


def get_db(db_path):
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    return db


def format_observation_docs(row):
    """Format an observation into multiple Chroma documents.

    Matches ChromaSync.ts formatObservationDocs() exactly:
    - base metadata uses sqlite_id, doc_type, and minimal fields
    - optional fields (subtitle, concepts, files) added only when present
    - arrays stored as comma-separated strings, not raw JSON
    """
    obs_id = row["id"]

    # Base metadata — matches ChromaSync.ts lines 222-230
    base_meta = {
        "sqlite_id": obs_id,
        "doc_type": "observation",
        "memory_session_id": row["memory_session_id"] or "",
        "project": row["project"] or "",
        "created_at_epoch": row["created_at_epoch"] or 0,
        "type": row["type"] or "discovery",
        "title": row["title"] or "Untitled",
    }

    # Optional metadata — matches ChromaSync.ts lines 232-244
    if row["subtitle"]:
        base_meta["subtitle"] = row["subtitle"]

    try:
        concepts = json.loads(row["concepts"] or "[]")
        if concepts:
            base_meta["concepts"] = ",".join(str(c) for c in concepts)
    except (json.JSONDecodeError, TypeError):
        pass

    try:
        files_read = json.loads(row["files_read"] or "[]")
        if files_read:
            base_meta["files_read"] = ",".join(str(f) for f in files_read)
    except (json.JSONDecodeError, TypeError):
        pass

    try:
        files_modified = json.loads(row["files_modified"] or "[]")
        if files_modified:
            base_meta["files_modified"] = ",".join(str(f) for f in files_modified)
    except (json.JSONDecodeError, TypeError):
        pass

    docs = []

    if row["narrative"]:
        docs.append({
            "id": f"obs_{obs_id}_narrative",
            "document": row["narrative"],
            "metadata": {**base_meta, "field_type": "narrative"},
        })

    if row["text"]:
        docs.append({
            "id": f"obs_{obs_id}_text",
            "document": row["text"],
            "metadata": {**base_meta, "field_type": "text"},
        })

    try:
        facts = json.loads(row["facts"] or "[]")
        for i, fact in enumerate(facts):
            if fact:
                docs.append({
                    "id": f"obs_{obs_id}_fact_{i}",
                    "document": str(fact),
                    "metadata": {**base_meta, "field_type": "fact", "fact_index": i},
                })
    except (json.JSONDecodeError, TypeError):
        pass

    return docs


def format_summary_docs(row):
    """Format a session summary into multiple Chroma documents.

    Matches ChromaSync.ts formatSummaryDocs() exactly:
    - base metadata uses sqlite_id and doc_type
    - each summary field becomes a separate vector document
    """
    summary_id = row["id"]

    # Base metadata — matches ChromaSync.ts lines 283-290
    base_meta = {
        "sqlite_id": summary_id,
        "doc_type": "session_summary",
        "memory_session_id": row["memory_session_id"] or "",
        "project": row["project"] or "",
        "created_at_epoch": row["created_at_epoch"] or 0,
        "prompt_number": row["prompt_number"] or 0,
    }

    docs = []
    for field in ["request", "investigated", "learned", "completed", "next_steps", "notes"]:
        if row[field]:
            docs.append({
                "id": f"summary_{summary_id}_{field}",
                "document": row[field],
                "metadata": {**base_meta, "field_type": field},
            })

    return docs


def format_prompt_doc(row):
    """Format a user prompt as a single Chroma document.

    Matches ChromaSync.ts formatUserPromptDoc() exactly:
    - uses sqlite_id, doc_type, memory_session_id, project from JOIN
    """
    return {
        "id": f"prompt_{row['id']}",
        "document": row["prompt_text"],
        "metadata": {
            "sqlite_id": row["id"],
            "doc_type": "user_prompt",
            "memory_session_id": row["memory_session_id"] or "",
            "project": row["project"] or "",
            "created_at_epoch": row["created_at_epoch"] or 0,
            "prompt_number": row["prompt_number"] or 0,
        },
    }


def add_batch(collection, docs):
    """Add a batch of documents to the collection, filtering empty ones."""
    if not docs:
        return 0

    ids = [d["id"] for d in docs]
    documents = [d["document"] for d in docs]
    metadatas = [d["metadata"] for d in docs]

    filtered = [(i, doc, meta) for i, doc, meta in zip(ids, documents, metadatas) if doc and doc.strip()]
    if not filtered:
        return 0

    ids, documents, metadatas = zip(*filtered)
    collection.add(ids=list(ids), documents=list(documents), metadatas=list(metadatas))
    return len(ids)


def get_existing_ids(collection, existing_count):
    """Fetch all existing document IDs, paginating for large collections."""
    existing_ids = set()
    if existing_count == 0:
        return existing_ids

    # Paginate to avoid memory issues on very large collections
    page_size = 10000
    offset = 0
    while offset < existing_count:
        result = collection.get(include=[], limit=page_size, offset=offset)
        existing_ids.update(result["ids"])
        if len(result["ids"]) < page_size:
            break
        offset += page_size

    return existing_ids


def process_table(label, docs, collection, existing_ids, dry_run):
    """Process and add a list of documents, with progress reporting."""
    new_docs = [d for d in docs if d["id"] not in existing_ids]
    print(f"New documents to add: {len(new_docs)}")

    if dry_run:
        print("  (dry run — skipping writes)")
        return 0

    total = 0
    for i in range(0, len(new_docs), BATCH_SIZE):
        batch = new_docs[i:i + BATCH_SIZE]
        added = add_batch(collection, batch)
        total += added
        progress = min(i + BATCH_SIZE, len(new_docs))
        print(f"  Progress: {progress}/{len(new_docs)} ({added} added in batch)")

    return total


def main():
    parser = argparse.ArgumentParser(
        description="Backfill ChromaDB vector index from claude-mem's SQLite database.",
        epilog="See https://github.com/thedotmack/claude-mem/issues/1110 for context.",
    )
    parser.add_argument("--db", default=get_default_db_path(),
                        help="Path to claude-mem SQLite database (default: ~/.claude-mem/claude-mem.db)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="ChromaDB server host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000,
                        help="ChromaDB server port (default: 8000)")
    parser.add_argument("--collection", default="cm__claude-mem",
                        help="ChromaDB collection name (default: cm__claude-mem)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview what would be added without writing to ChromaDB")
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f"Error: Database not found at {args.db}", file=sys.stderr)
        print(f"Set --db or CLAUDE_MEM_DATA_DIR environment variable.", file=sys.stderr)
        sys.exit(1)

    # Connect to Chroma
    import chromadb
    print(f"Connecting to ChromaDB at {args.host}:{args.port}...")
    try:
        client = chromadb.HttpClient(host=args.host, port=args.port)
        heartbeat = client.heartbeat()
        print(f"Connected (heartbeat: {heartbeat})")
    except Exception as e:
        print(f"Error: Cannot connect to ChromaDB at {args.host}:{args.port}", file=sys.stderr)
        print(f"Make sure your Chroma server is running.", file=sys.stderr)
        print(f"  Detail: {e}", file=sys.stderr)
        sys.exit(1)

    collection = client.get_or_create_collection(name=args.collection)
    existing_count = collection.count()
    print(f"Collection '{args.collection}': {existing_count} existing documents")

    print("Fetching existing document IDs...")
    existing_ids = get_existing_ids(collection, existing_count)
    print(f"Found {len(existing_ids)} existing IDs to skip")

    db = get_db(args.db)
    total_added = 0

    # --- Observations ---
    print("\n--- Observations ---")
    rows = db.execute("SELECT * FROM observations ORDER BY id").fetchall()
    print(f"Found {len(rows)} observations in SQLite")
    obs_docs = []
    for row in rows:
        obs_docs.extend(format_observation_docs(row))
    total_added += process_table("observations", obs_docs, collection, existing_ids, args.dry_run)

    # --- Summaries ---
    print("\n--- Summaries ---")
    rows = db.execute("SELECT * FROM session_summaries ORDER BY id").fetchall()
    print(f"Found {len(rows)} summaries in SQLite")
    sum_docs = []
    for row in rows:
        sum_docs.extend(format_summary_docs(row))
    total_added += process_table("summaries", sum_docs, collection, existing_ids, args.dry_run)

    # --- User Prompts ---
    # JOIN with sdk_sessions to get project and memory_session_id
    # (matches ChromaSync.ts ensureBackfilled() lines 704-713)
    print("\n--- User Prompts ---")
    rows = db.execute("""
        SELECT up.*, s.project, s.memory_session_id
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        ORDER BY up.id
    """).fetchall()
    print(f"Found {len(rows)} prompts in SQLite")
    prompt_docs = []
    for row in rows:
        if row["prompt_text"] and row["prompt_text"].strip():
            prompt_docs.append(format_prompt_doc(row))
    total_added += process_table("prompts", prompt_docs, collection, existing_ids, args.dry_run)

    # Summary
    final_count = collection.count() if not args.dry_run else existing_count
    print(f"\n{'='*50}")
    if args.dry_run:
        print("Dry run complete — no documents were written.")
    else:
        print("Backfill complete!")
    print(f"  Documents added: {total_added}")
    print(f"  Collection total: {final_count}")

    db.close()


if __name__ == "__main__":
    main()
