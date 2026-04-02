#!/usr/bin/env python3
"""
Token Velocity Study — Phase 1: Extraction

Scans ~/.claude/projects/ for session JSONL files, extracts per-session
token usage metrics, cross-references with claude-mem's SQLite database
for observation counts, and writes a flat CSV for downstream analysis.

Discovery strategy: JSONL files on disk are the source of truth (the
sessions-index.json is often stale and references files that no longer
exist). Each JSONL line carries `isSidechain`, `sessionId`, and
`timestamp` fields, so we extract metadata directly from file content.

Usage:
    python3 velocity-study/extract.py
"""

import csv
import json
import sqlite3
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
CLAUDE_MEM_DB_PATH = Path.home() / ".claude-mem" / "claude-mem.db"
OUTPUT_CSV_PATH = Path(__file__).resolve().parent / "metrics.csv"
MINIMUM_NON_SIDECHAIN_SESSIONS = 5
ASSUMED_CONTEXT_WINDOW = 200_000

CSV_COLUMNS = [
    "project_id",
    "session_id",
    "sequence_num",
    "date",
    "model",
    "total_api_tokens",
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "context_utilization",
    "observation_count",
    "has_claude_mem",
]


# ---------------------------------------------------------------------------
# Claude-mem DB helpers
# ---------------------------------------------------------------------------

def build_observation_count_lookup() -> dict[str, int]:
    """Return {content_session_id: observation_count} from claude-mem DB."""
    if not CLAUDE_MEM_DB_PATH.exists():
        print(f"  [warn] claude-mem DB not found at {CLAUDE_MEM_DB_PATH}")
        return {}

    lookup: dict[str, int] = {}
    try:
        conn = sqlite3.connect(str(CLAUDE_MEM_DB_PATH))
        try:
            cursor = conn.execute(
                """
                SELECT s.content_session_id, COUNT(o.id) AS observation_count
                FROM sdk_sessions s
                LEFT JOIN observations o ON o.memory_session_id = s.memory_session_id
                GROUP BY s.content_session_id
                """
            )
            for content_session_id, observation_count in cursor:
                if content_session_id:
                    lookup[content_session_id] = observation_count
        finally:
            conn.close()
    except Exception as exc:
        print(f"  [warn] Failed to query claude-mem DB: {exc}")

    return lookup


# ---------------------------------------------------------------------------
# JSONL parsing
# ---------------------------------------------------------------------------

def extract_session_metadata_and_metrics(jsonl_path: Path) -> dict | None:
    """
    Parse a session JSONL file and return combined metadata + token metrics.

    Extracts from the raw JSONL lines:
      - isSidechain (from any line that has it)
      - sessionId (from any line that has it)
      - earliest timestamp (from any line with a timestamp)
      - token usage aggregated across all qualifying assistant turns

    Returns a dict with keys:
        is_sidechain, session_id, earliest_timestamp,
        total_input_tokens, total_output_tokens,
        total_cache_creation_tokens, total_cache_read_tokens,
        peak_context, model
    or None if the file is unreadable.
    """
    total_input_tokens = 0
    total_output_tokens = 0
    total_cache_creation_tokens = 0
    total_cache_read_tokens = 0
    peak_context = 0
    model = ""
    has_assistant_turns = False

    # Metadata extracted from any JSONL line
    is_sidechain = None  # None = not yet determined
    session_id = None
    earliest_timestamp = None

    try:
        with open(jsonl_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue

                # Extract metadata from any line that has it
                if is_sidechain is None and "isSidechain" in obj:
                    is_sidechain = bool(obj["isSidechain"])

                if session_id is None and obj.get("sessionId"):
                    session_id = obj["sessionId"]

                line_timestamp = obj.get("timestamp")
                if line_timestamp:
                    if earliest_timestamp is None or line_timestamp < earliest_timestamp:
                        earliest_timestamp = line_timestamp

                # Only process assistant messages with a stop_reason for tokens
                if obj.get("type") != "assistant":
                    continue

                message = obj.get("message")
                if not isinstance(message, dict):
                    continue

                if message.get("stop_reason") is None:
                    continue

                # Qualifying assistant turn
                has_assistant_turns = True
                usage = message.get("usage", {})

                input_tok = usage.get("input_tokens", 0) or 0
                output_tok = usage.get("output_tokens", 0) or 0
                cache_create_tok = usage.get("cache_creation_input_tokens", 0) or 0
                cache_read_tok = usage.get("cache_read_input_tokens", 0) or 0

                total_input_tokens += input_tok
                total_output_tokens += output_tok
                total_cache_creation_tokens += cache_create_tok
                total_cache_read_tokens += cache_read_tok

                # Peak context = max across turns of all input-side tokens
                turn_context = input_tok + cache_create_tok + cache_read_tok
                if turn_context > peak_context:
                    peak_context = turn_context

                # Capture model from the most recent assistant message
                turn_model = message.get("model", "")
                if turn_model:
                    model = turn_model

    except OSError as exc:
        print(f"  [warn] Could not read {jsonl_path}: {exc}")
        return None

    # Fall back to filename stem as session_id if not found in content
    if session_id is None:
        session_id = jsonl_path.stem

    # Default is_sidechain to False if never encountered in file
    if is_sidechain is None:
        is_sidechain = False

    return {
        "is_sidechain": is_sidechain,
        "session_id": session_id,
        "earliest_timestamp": earliest_timestamp or "",
        "has_assistant_turns": has_assistant_turns,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "total_cache_creation_tokens": total_cache_creation_tokens,
        "total_cache_read_tokens": total_cache_read_tokens,
        "peak_context": peak_context,
        "model": model,
    }


# ---------------------------------------------------------------------------
# Project scanning
# ---------------------------------------------------------------------------

def discover_jsonl_files(project_dir: Path) -> list[Path]:
    """Return all *.jsonl files in a project directory (non-recursive)."""
    return sorted(project_dir.glob("*.jsonl"))


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

def main() -> None:
    if not CLAUDE_PROJECTS_DIR.exists():
        print(f"ERROR: Claude projects directory not found: {CLAUDE_PROJECTS_DIR}")
        sys.exit(1)

    # Step 1: Build observation lookup from claude-mem DB
    print("Loading claude-mem observation counts...")
    observation_lookup = build_observation_count_lookup()
    print(f"  Found {len(observation_lookup)} sessions with DB records")

    # Step 2: Discover all project directories
    project_dirs = sorted([
        p for p in CLAUDE_PROJECTS_DIR.iterdir()
        if p.is_dir()
    ])
    print(f"\nScanning {len(project_dirs)} project directories for JSONL files...")

    # Phase A: scan all projects to count non-sidechain sessions per project
    # (needed to enforce the minimum-sessions threshold before extracting)
    project_jsonl_map: dict[str, list[Path]] = {}
    projects_with_jsonl = 0

    for project_dir in project_dirs:
        jsonl_files = discover_jsonl_files(project_dir)
        if jsonl_files:
            projects_with_jsonl += 1
            project_jsonl_map[project_dir.name] = jsonl_files

    print(f"  {projects_with_jsonl} projects have JSONL files on disk")

    # Phase B: For each project with JSONLs, do a quick sidechain check
    # then extract metrics for qualifying projects
    all_rows: list[dict] = []
    projects_qualifying = 0
    sessions_extracted = 0
    sessions_skipped_sidechain = 0
    sessions_skipped_no_data = 0

    for project_id, jsonl_files in sorted(project_jsonl_map.items()):
        # First pass: determine which files are non-sidechain sessions
        # We parse each file fully (extracting both metadata and metrics in one pass)
        parsed_sessions: list[dict] = []

        for jsonl_path in jsonl_files:
            result = extract_session_metadata_and_metrics(jsonl_path)
            if result is None:
                continue
            parsed_sessions.append(result)

        non_sidechain_sessions = [s for s in parsed_sessions if not s["is_sidechain"]]
        sidechain_count = len(parsed_sessions) - len(non_sidechain_sessions)
        sessions_skipped_sidechain += sidechain_count

        if len(non_sidechain_sessions) < MINIMUM_NON_SIDECHAIN_SESSIONS:
            # Still count sessions that had no data even if project doesn't qualify
            sessions_skipped_no_data += sum(
                1 for s in non_sidechain_sessions if not s["has_assistant_turns"]
            )
            continue

        projects_qualifying += 1

        # Build CSV rows for qualifying non-sidechain sessions with data
        project_rows: list[dict] = []

        for session in non_sidechain_sessions:
            if not session["has_assistant_turns"]:
                sessions_skipped_no_data += 1
                continue

            sessions_extracted += 1

            total_api_tokens = (
                session["total_input_tokens"]
                + session["total_output_tokens"]
                + session["total_cache_creation_tokens"]
                + session["total_cache_read_tokens"]
            )

            if total_api_tokens == 0:
                sessions_skipped_no_data += 1
                sessions_extracted -= 1
                continue

            context_utilization = (
                session["peak_context"] / ASSUMED_CONTEXT_WINDOW
                if ASSUMED_CONTEXT_WINDOW > 0
                else 0.0
            )

            obs_count = observation_lookup.get(session["session_id"], 0)

            project_rows.append({
                "project_id": project_id,
                "session_id": session["session_id"],
                "date": session["earliest_timestamp"],
                "model": session["model"],
                "total_api_tokens": total_api_tokens,
                "input_tokens": session["total_input_tokens"],
                "output_tokens": session["total_output_tokens"],
                "cache_creation_tokens": session["total_cache_creation_tokens"],
                "cache_read_tokens": session["total_cache_read_tokens"],
                "context_utilization": round(context_utilization, 6),
                "observation_count": obs_count,
                "has_claude_mem": "true" if obs_count > 0 else "false",
            })

        # Sort by date within project, assign sequence numbers (1-indexed)
        project_rows.sort(key=lambda row: row["date"])
        for sequence_number, row in enumerate(project_rows, start=1):
            row["sequence_num"] = sequence_number

        all_rows.extend(project_rows)

    # Step 3: Sort final output by project_id, then sequence_num
    all_rows.sort(key=lambda r: (r["project_id"], r["sequence_num"]))

    # Step 4: Write CSV
    OUTPUT_CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_CSV_PATH, "w", newline="") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in all_rows:
            writer.writerow(row)

    # Step 5: Summary
    print(f"\n{'='*60}")
    print("Extraction complete")
    print(f"{'='*60}")
    print(f"  Projects scanned:            {len(project_dirs)}")
    print(f"  Projects with JSONL on disk: {projects_with_jsonl}")
    print(f"  Projects qualifying (>={MINIMUM_NON_SIDECHAIN_SESSIONS} sessions): {projects_qualifying}")
    print(f"  Sessions extracted:           {sessions_extracted}")
    print(f"  Sessions skipped (sidechain): {sessions_skipped_sidechain}")
    print(f"  Sessions skipped (no data):   {sessions_skipped_no_data}")
    print(f"  Rows in CSV:                 {len(all_rows)}")
    print(f"  Output: {OUTPUT_CSV_PATH}")

    # Quick claude-mem coverage stat
    mem_sessions = sum(1 for r in all_rows if r["has_claude_mem"] == "true")
    print(f"  Sessions with claude-mem:    {mem_sessions} / {len(all_rows)}")


if __name__ == "__main__":
    main()
