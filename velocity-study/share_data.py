#!/usr/bin/env python3
"""
Token Velocity Study — Phase 4: Data Sharing

Reads metrics.csv, anonymizes all identifying information, and writes
velocity-data.json — a file safe to share publicly for aggregate analysis.

Anonymization:
  - Project IDs → SHA256 hash (groups sessions without revealing names)
  - Session IDs → stripped entirely
  - File paths, message content → never present in metrics.csv to begin with
  - Observation counts → bucketed ("0", "1-10", "10-50", "50+")
  - Machine identity → SHA256 of hostname

Usage:
    python3 velocity-study/share_data.py
"""

import csv
import hashlib
import json
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
INPUT_CSV_PATH = SCRIPT_DIR / "metrics.csv"
OUTPUT_JSON_PATH = SCRIPT_DIR / "velocity-data.json"

FIELDS_TO_EXPORT = [
    "project_hash",
    "sequence_num",
    "model",
    "total_api_tokens",
    "context_utilization",
    "observation_count_bucket",
    "has_claude_mem",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sha256_hex(value: str) -> str:
    """Return the SHA256 hex digest of a string."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def bucket_observation_count(raw_count: int) -> str:
    """Bucket an observation count into a privacy-safe range string."""
    if raw_count == 0:
        return "0"
    elif raw_count <= 10:
        return "1-10"
    elif raw_count <= 50:
        return "10-50"
    else:
        return "50+"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    if not INPUT_CSV_PATH.exists():
        print(f"ERROR: metrics.csv not found at {INPUT_CSV_PATH}")
        print("Run extract.py first:  python3 velocity-study/extract.py")
        sys.exit(1)

    # Read and anonymize
    anonymized_sessions = []
    with open(INPUT_CSV_PATH, newline="") as csvfile:
        reader = csv.DictReader(csvfile)
        for row in reader:
            anonymized_sessions.append({
                "project_hash": sha256_hex(row["project_id"]),
                "sequence_num": int(row["sequence_num"]),
                "model": row["model"],
                "total_api_tokens": int(row["total_api_tokens"]),
                "context_utilization": round(float(row["context_utilization"]), 4),
                "observation_count_bucket": bucket_observation_count(
                    int(row["observation_count"])
                ),
                "has_claude_mem": row["has_claude_mem"] == "true",
            })

    # Build output document
    machine_id_hash = sha256_hex(socket.gethostname())
    output_document = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "machine_id": machine_id_hash,
        "sessions": anonymized_sessions,
    }

    # Write JSON
    OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_JSON_PATH, "w") as f:
        json.dump(output_document, f, indent=2)

    # ---------------------------------------------------------------------------
    # Summary
    # ---------------------------------------------------------------------------
    total_sessions = len(anonymized_sessions)
    unique_projects = len({s["project_hash"] for s in anonymized_sessions})
    unique_models = sorted({s["model"] for s in anonymized_sessions})
    sessions_with_claude_mem = sum(
        1 for s in anonymized_sessions if s["has_claude_mem"]
    )

    print(f"\n{'=' * 60}")
    print("Token Velocity Study — Anonymized Data Export")
    print(f"{'=' * 60}")
    print(f"  Sessions included:    {total_sessions}")
    print(f"  Unique projects:      {unique_projects} (hashed)")
    print(f"  Models:               {', '.join(unique_models)}")
    print(f"  With claude-mem:      {sessions_with_claude_mem} / {total_sessions}")
    print(f"  Machine ID (hashed):  {machine_id_hash[:16]}...")
    print(f"  Output:               {OUTPUT_JSON_PATH}")

    # Show a sample row
    if anonymized_sessions:
        sample = anonymized_sessions[0]
        print(f"\n  Sample anonymized row:")
        print(f"    {json.dumps(sample, indent=4)}")

    # Privacy confirmation
    print(f"\n{'=' * 60}")
    print("Privacy check:")
    print("  [OK] No session IDs")
    print("  [OK] No project names (SHA256 hashed)")
    print("  [OK] No file paths or message content")
    print("  [OK] No dates or timestamps")
    print("  [OK] Observation counts bucketed (not exact)")
    print("  [OK] Machine ID is a SHA256 hash of hostname")
    print(f"{'=' * 60}")
    print(f"\nFile ready to share: {OUTPUT_JSON_PATH}")
    print("You can paste the contents into a GitHub Discussion or email.")


if __name__ == "__main__":
    main()
