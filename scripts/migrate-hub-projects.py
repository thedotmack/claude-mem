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

    # absolute_patterns is optional
    if "absolute_patterns" not in config:
        config["absolute_patterns"] = {}

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
    absolute_patterns: dict,
    config: dict | None = None,
) -> str | None:
    """Resolve a file path to a project name. Returns None if no match."""
    if not file_path:
        return None

    # Expand ~ to home directory for tilde-prefixed paths
    if file_path.startswith("~/") or file_path == "~":
        file_path = os.path.expanduser(file_path)

    # Sort by length (longest first) for correct matching
    sorted_absolute = sorted(absolute_patterns.items(), key=lambda x: len(x[0]), reverse=True)
    sorted_real = sorted(real_path_patterns.items(), key=lambda x: len(x[0]), reverse=True)
    sorted_relative = sorted(project_patterns.items(), key=lambda x: len(x[0]), reverse=True)

    # Try absolute_patterns first (files outside vault accessed by real path)
    for pattern, project in sorted_absolute:
        normalized = pattern.rstrip("/")
        if file_path.startswith(normalized + "/") or file_path == normalized:
            return project

    # Try absolute path match against real repo locations (from symlinks)
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

    # Fallback: match project name as a leading directory in the path
    # This catches relative paths like "my-project/packages/..." stored
    # without the repos/ prefix. Only matches if the project name appears as
    # the first or second path component to avoid false positives from generic
    # names like "api" appearing deep in the path.
    vault_content_prefixes = tuple(config.get("vault_content_prefixes", []))
    if not any(file_path.startswith(p) for p in vault_content_prefixes):
        # Build a map of project basenames to project names
        # Skip short/ambiguous names (< 4 chars) to avoid false positives
        basename_map = {}
        for pattern, project in sorted_relative:
            basename = os.path.basename(pattern)
            if len(basename) >= 4:
                basename_map[basename] = project
        for pattern, project in sorted_absolute:
            basename = os.path.basename(pattern.rstrip("/"))
            if len(basename) >= 4:
                basename_map[basename] = project

        parts = file_path.replace("\\", "/").split("/")
        # Only check first 2 non-empty parts to avoid deep matches
        leading_parts = [p for p in parts[:2] if p]
        for part in leading_parts:
            if part in basename_map:
                return basename_map[part]
            # Try hyphen/underscore variant (e.g. documents_pipeline -> documents-pipeline)
            alt = part.replace("_", "-") if "_" in part else part.replace("-", "_")
            if alt != part and alt in basename_map:
                return basename_map[alt]

    return None


def main():
    # Parse arguments
    argv = sys.argv[1:]
    if not argv:
        print("Usage: python3 migrate-hub-projects.py /path/to/vault [--dry-run] [--source-project NAME]")
        print()
        print("Options:")
        print("  --dry-run              Show what would change without modifying the database")
        print("  --source-project NAME  Only re-tag observations currently tagged as NAME")
        print("                         (default: basename of vault directory)")
        sys.exit(1)

    dry_run = "--dry-run" in argv

    # Parse --source-project VALUE
    source_project = None
    for i, arg in enumerate(argv):
        if arg == "--source-project" and i + 1 < len(argv):
            source_project = argv[i + 1]

    # Vault dir is the first non-flag argument
    positional = [a for a in argv if not a.startswith("--") and (argv.index(a) == 0 or argv[argv.index(a) - 1] != "--source-project")]
    if not positional:
        print("Error: vault directory is required")
        sys.exit(1)

    vault_dir = os.path.abspath(positional[0])

    if not source_project:
        source_project = os.path.basename(vault_dir)

    if not os.path.isdir(vault_dir):
        print(f"Error: {vault_dir} is not a directory")
        sys.exit(1)

    # Load config
    config = load_hub_config(vault_dir)
    project_patterns = config["project_patterns"]
    default_project = config["default_project"]
    absolute_patterns = config.get("absolute_patterns", {})

    # Build real-path patterns from symlinks
    real_path_patterns = build_real_path_patterns(vault_dir, project_patterns)

    print(f"Vault: {vault_dir}")
    print(f"Source project: {source_project}")
    print(f"Default project: {default_project}")
    print(f"Patterns: {len(project_patterns)} relative + {len(real_path_patterns)} real-path + {len(absolute_patterns)} absolute")

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
            resolved = resolve_project(f, vault_dir, project_patterns, real_path_patterns, absolute_patterns, config)
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
