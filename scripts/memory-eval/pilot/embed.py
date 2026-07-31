# SPDX-License-Identifier: Apache-2.0
"""e5 pilot — embedding index + query ranking (steps 2-3a).

Embeds all exported candidates with intfloat/multilingual-e5-small
(normalize_embeddings=True) and caches the vectors in `embeddings.npz`
(no vector DB — plain numpy). Then embeds the gold-set queries and writes
per-query top-5 observation ids by cosine similarity, project-scoped the
same way the harness FTS pool is (project = ? OR merged_into_project = ?).

Variants (both always computed in one run — prefix check is cheap):
  plain    — no prefixes (MVP per plans/2026-07-29-e5-embedding-migration.md)
  prefixed — queries get "query: ", passages get "passage: " (phase 2)

Usage:
  uv run --with sentence-transformers scripts/memory-eval/pilot/embed.py [--force]

--force rebuilds embeddings.npz even if the cache is present and consistent.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
JSONL_PATH = HERE / "observations.jsonl"
NPZ_PATH = HERE / "embeddings.npz"
GOLD_PATH = HERE.parent / "gold.json"
OUT_PATH = HERE / "e5-top5.json"

MODEL_NAME = "intfloat/multilingual-e5-small"
TOP_K = 5
BATCH_SIZE = 64


def load_records():
    records = []
    with JSONL_PATH.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def obs_text(rec):
    """Single embedding text for an observation: title + narrative + facts + concepts."""
    parts = []
    if rec.get("title"):
        parts.append(rec["title"])
    if rec.get("narrative"):
        parts.append(rec["narrative"])
    if rec.get("facts"):
        try:
            facts = json.loads(rec["facts"])
            if isinstance(facts, list):
                parts.append("; ".join(str(f) for f in facts))
        except (json.JSONDecodeError, TypeError):
            parts.append(str(rec["facts"]))
    if rec.get("concepts"):
        try:
            concepts = json.loads(rec["concepts"])
            if isinstance(concepts, list):
                parts.append(" ".join(str(c) for c in concepts))
        except (json.JSONDecodeError, TypeError):
            pass
    return "\n".join(p for p in parts if p) or "(empty)"


def build_or_load_index(model, records, force):
    ids = np.array([r["id"] for r in records], dtype=np.int64)
    kinds = np.array([r["record"] for r in records])
    if NPZ_PATH.exists() and not force:
        cached = np.load(NPZ_PATH, allow_pickle=False)
        if (
            "ids" in cached
            and "embeddings" in cached
            and cached["ids"].shape == ids.shape
            and np.array_equal(cached["ids"], ids)
            and str(cached["model"]) == MODEL_NAME
        ):
            print(f"index cache hit: {NPZ_PATH} ({ids.shape[0]} vectors)", flush=True)
            return cached["embeddings"]
        print("index cache stale — rebuilding", flush=True)

    # Passage embeddings are prefix-independent for the cache: we store the
    # raw vectors of the plain text; the "passage: " variant is re-derived at
    # query time only if needed. Simpler: cache plain; prefixed run re-embeds
    # in-memory (cheap enough at ~7k docs) — but to keep it truly cheap we
    # cache BOTH variants in one npz.
    texts = [
        obs_text(r) if r["record"] == "observation" else r["fact"] for r in records
    ]
    t0 = time.time()
    plain = model.encode(
        texts,
        normalize_embeddings=True,
        batch_size=BATCH_SIZE,
        show_progress_bar=True,
        convert_to_numpy=True,
    )
    prefixed = model.encode(
        ["passage: " + t for t in texts],
        normalize_embeddings=True,
        batch_size=BATCH_SIZE,
        show_progress_bar=True,
        convert_to_numpy=True,
    )
    np.savez(
        NPZ_PATH,
        ids=ids,
        kinds=kinds,
        model=np.array(MODEL_NAME),
        embeddings=plain.astype(np.float32),
        embeddings_prefixed=prefixed.astype(np.float32),
    )
    print(
        f"embedded {len(texts)} candidates in {time.time() - t0:.1f}s → {NPZ_PATH}",
        flush=True,
    )
    return None  # signals "just rebuilt"; caller reloads


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="rebuild embeddings.npz")
    args = ap.parse_args()

    from sentence_transformers import SentenceTransformer

    t0 = time.time()
    model = SentenceTransformer(MODEL_NAME)
    print(f"model loaded in {time.time() - t0:.1f}s", flush=True)

    records = load_records()
    print(
        f"records: {len(records)} "
        f"({sum(1 for r in records if r['record'] == 'observation')} observations, "
        f"{sum(1 for r in records if r['record'] == 'fact')} facts)",
        flush=True,
    )

    rebuilt = build_or_load_index(model, records, args.force) is None
    cached = np.load(NPZ_PATH, allow_pickle=False)
    ids = cached["ids"]
    kinds = cached["kinds"]
    emb = {"plain": cached["embeddings"], "prefixed": cached["embeddings_prefixed"]}
    if rebuilt:
        print("index rebuilt this run", flush=True)

    # Candidate metadata for project scoping; ranking is over OBSERVATIONS
    # only — gold ids are observation ids, and the FTS baseline ranks
    # observations only (facts are exported/embedded for completeness).
    obs_mask = kinds == "observation"
    proj = np.empty(len(records), dtype=object)
    merged = np.empty(len(records), dtype=object)
    for i, r in enumerate(records):
        proj[i] = r["project"]
        merged[i] = r.get("merged_into_project") or ""

    gold = json.loads(GOLD_PATH.read_text(encoding="utf-8"))
    items = gold["items"]
    print(f"gold queries: {len(items)}", flush=True)

    results = {}
    for variant in ("plain", "prefixed"):
        q_texts = [it["promptText"] for it in items]
        if variant == "prefixed":
            q_texts = ["query: " + t for t in q_texts]
        t0 = time.time()
        q_emb = model.encode(
            q_texts,
            normalize_embeddings=True,
            batch_size=BATCH_SIZE,
            convert_to_numpy=True,
        )
        E = emb[variant]
        per_query = []
        for qi, it in enumerate(items):
            mask = obs_mask & ((proj == it["project"]) | (merged == it["project"]))
            cand_idx = np.nonzero(mask)[0]
            if cand_idx.size == 0:
                per_query.append({"promptId": it["promptId"], "top": []})
                continue
            sims = E[cand_idx] @ q_emb[qi]
            k = min(TOP_K, cand_idx.size)
            best = cand_idx[np.argpartition(-sims, k - 1)[:k]]
            best = best[np.argsort(-sims[np.searchsorted(cand_idx, best)])]
            per_query.append(
                {
                    "promptId": it["promptId"],
                    "top": [
                        {
                            "id": int(ids[j]),
                            "score": float(sims[np.searchsorted(cand_idx, j)]),
                        }
                        for j in best
                    ],
                }
            )
        results[variant] = per_query
        print(
            f"variant {variant}: {len(items)} queries ranked in {time.time() - t0:.1f}s",
            flush=True,
        )

    OUT_PATH.write_text(
        json.dumps(
            {
                "model": MODEL_NAME,
                "topK": TOP_K,
                "candidates": int(obs_mask.sum()),
                "queries": len(items),
                "variants": results,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"wrote {OUT_PATH}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
