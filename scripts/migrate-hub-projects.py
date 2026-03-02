#!/usr/bin/env python3
"""
Migration script: Re-tag existing observations with correct project names
based on their files_read/files_modified paths.

Reads configuration from .claude-mem-hub.json in the specified vault directory.
Resolves symlinks automatically to build real-path patterns.

Usage:
    python3 migrate-hub-projects.py /path/to/vault [--dry-run]
    python3 migrate-hub-projects.py /path/to/vault --source-project Obsidian [--dry-run]
"""

import sqlite3
import json
import os
import sys


def load_hub_config(vault_dir: str) -> dict:
    """Load .claude-mem-hub.json from the vault directory."""
    config_path = os.path.join(vault_dir, ".claude-mem-hub.json")
    if not os.path.exists(config_path):
        print(f"Error: {config_path} not found")
        sys.exit(1)

    with open(config_path) as f:
        config = json.load(f)

    if not config.get("hub_mode"):
        print("Error: hub_mode is not enabled in config")
        sys.exit(1)

    if not config.get("default_project") or not config.get("project_patterns"):
        print("Error: missing default_project or project_patterns in config")
        sys.exit(1)

    return config


def build_real_path_patterns(vault_dir: str, project_patterns: dict) -> dict:
    """Build real-path patterns by resolving symlinks in the vault."""
    real_patterns = {}
    for rel_pattern, project_name in project_patterns.items():
        abs_path = os.path.join(vault_dir, rel_pattern)
        try:
            real_path = os.path.realpath(abs_path)
            if real_path != abs_path:
                real_patterns[real_path] = project_name
        except OSError:
            pass
    return real_patterns


def resolve_project(
    file_path: str,
    vault_dir: str,
    project_patterns: dict,
    real_path_patterns: dict,
) -> str | None:
    """Resolve a file path to a project name. Returns None if no match."""
    if not file_path:
        return None

    # Sort by length (longest first) for correct matching
    sorted_real = sorted(real_path_patterns.items(), key=lambda x: len(x[0]), reverse=True)
    sorted_relative = sorted(project_patterns.items(), key=lambda x: len(x[0]), reverse=True)

    # Try absolute path match against real repo locations
    for pattern, project in sorted_real:
        if file_path.startswith(pattern + "/") or file_path == pattern:
            return project

    # Try relative path match (paths stored relative to vault)
    for pattern, project in sorted_relative:
        if file_path.startswith(pattern + "/") or file_path == pattern:
            return project

    # Try making absolute path relative to vault
    if file_path.startswith(vault_dir):
        rel_path = os.path.relpath(file_path, vault_dir)
        for pattern, project in sorted_relative:
            if rel_path.startswith(pattern + "/") or rel_path == pattern:
                return project

    return None


def main():
    # Parse arguments
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]

    if not args:
        print("Usage: python3 migrate-hub-projects.py /path/to/vault [--dry-run] [--source-project NAME]")
        print()
        print("Options:")
        print("  --dry-run              Show what would change without modifying the database")
        print("  --source-project NAME  Only re-tag observations currently tagged as NAME")
        print("                         (default: basename of vault directory)")
        sys.exit(1)

    vault_dir = os.path.abspath(args[0])
    dry_run = "--dry-run" in flags

    # Parse --source-project
    source_project = None
    for i, flag in enumerate(flags):
        if flag == "--source-project" and i + 1 < len(flags):
            source_project = flags[i + 1]

    if not source_project:
        source_project = os.path.basename(vault_dir)

    if not os.path.isdir(vault_dir):
        print(f"Error: {vault_dir} is not a directory")
        sys.exit(1)

    # Load config
    config = load_hub_config(vault_dir)
    project_patterns = config["project_patterns"]
    default_project = config["default_project"]

    # Build real-path patterns from symlinks
    real_path_patterns = build_real_path_patterns(vault_dir, project_patterns)

    print(f"Vault: {vault_dir}")
    print(f"Source project: {source_project}")
    print(f"Default project: {default_project}")
    print(f"Patterns: {len(project_patterns)} relative + {len(real_path_patterns)} real-path")

    # Open database
    db_path = os.path.expanduser("~/.claude-mem/claude-mem.db")
    if not os.path.exists(db_path):
        print(f"Database not found at {db_path}")
        sys.exit(1)

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    # Get observations tagged with source project
    cursor = db.execute(
        "SELECT id, project, files_read, files_modified FROM observations WHERE project = ?",
        (source_project,),
    )
    rows = cursor.fetchall()
    print(f"\nFound {len(rows)} observations tagged as '{source_project}'")

    if not rows:
        print("Nothing to migrate.")
        db.close()
        return

    updates = {}  # id -> new_project
    for row in rows:
        files_read = json.loads(row["files_read"]) if row["files_read"] else []
        files_modified = json.loads(row["files_modified"]) if row["files_modified"] else []
        all_files = files_read + files_modified

        # Try to resolve project from any file path
        resolved = None
        for f in all_files:
            resolved = resolve_project(f, vault_dir, project_patterns, real_path_patterns)
            if resolved:
                break

        if resolved:
            updates[row["id"]] = resolved

    # Count by project
    project_counts: dict[str, int] = {}
    for _id, project in updates.items():
        project_counts[project] = project_counts.get(project, 0) + 1

    # Count remaining as default_project
    remaining = len(rows) - len(updates)
    project_counts[default_project] = project_counts.get(default_project, 0) + remaining

    print(f"\nMigration plan:")
    for project, count in sorted(project_counts.items(), key=lambda x: -x[1]):
        print(f"  {project}: {count}")
    print(f"  Total: {len(rows)}")

    if dry_run:
        print("\n[DRY RUN] No changes made.")
        db.close()
        return

    # Apply updates
    print(f"\nApplying {len(updates)} project re-tags...")
    for obs_id, new_project in updates.items():
        db.execute(
            "UPDATE observations SET project = ? WHERE id = ?",
            (new_project, obs_id),
        )

    # Re-tag remaining source_project -> default_project
    db.execute(
        "UPDATE observations SET project = ? WHERE project = ?",
        (default_project, source_project),
    )

    # Also update sdk_sessions and session_summaries
    db.execute(
        "UPDATE sdk_sessions SET project = ? WHERE project = ?",
        (default_project, source_project),
    )
    db.execute(
        "UPDATE session_summaries SET project = ? WHERE project = ?",
        (default_project, source_project),
    )

    db.commit()

    # Verify
    cursor2 = db.execute(
        "SELECT project, COUNT(*) as cnt FROM observations GROUP BY project ORDER BY cnt DESC"
    )
    print("\nPost-migration distribution:")
    for row in cursor2:
        print(f"  {row[0]}: {row[1]}")

    print("\nMigration complete.")
    db.close()


if __name__ == "__main__":
    main()
