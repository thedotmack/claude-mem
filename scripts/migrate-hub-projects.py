#!/usr/bin/env python3
"""
Migration script: Re-tag existing observations with correct project names
based on their files_read/files_modified paths.

Uses the same logic as resolveProjectFromFilePath:
1. Check absolute paths against real repo locations (symlink targets)
2. Check relative paths against project_patterns
3. Default to obsidian-vault if no match
"""

import sqlite3
import json
import os
import sys

# Hub config - mirrors .claude-mem-hub.json
VAULT_CWD = "/home/lexter/Documentos/Obsidian"

PROJECT_PATTERNS = {
    "repos/api/legal-core": "legal-core",
    "repos/api/prognosticos": "prognosticos",
    "repos/api/api": "api",
    "repos/api/lexter-copilot-api": "lexter-copilot-api",
    "repos/api/lexter-copilot-server": "lexter-copilot-server",
    "repos/api/lexter-diligence": "lexter-diligence",
    "repos/api/lexter-imobiliario": "lexter-imobiliario",
    "repos/api/pdf-handler": "pdf-handler",
    "repos/api/question-inference": "question-inference",
    "repos/data/data-lake": "data-lake",
    "repos/data/deepnote-analytics": "deepnote-analytics",
    "repos/data/documents-pipeline": "documents-pipeline",
    "repos/data/media-commander": "media-commander",
    "repos/infra/infrastructure": "infrastructure",
    "repos/infra/ops-hub": "ops-hub",
    "repos/web/admin-console": "admin-console",
    "repos/web/legal-ui": "legal-ui",
    "repos/web/lexter-copilot-addin": "lexter-copilot-addin",
    "repos/docs/handbook": "handbook",
    "repos/faculdade/plant-disease-classifier": "plant-disease-classifier",
}

# Real paths that symlinks point to (for absolute path matching)
REAL_PATH_PATTERNS = {
    "/home/lexter/lexter/api/api": "api",
    "/home/lexter/lexter/api/legal-core": "legal-core",
    "/home/lexter/lexter/api/lexter-copilot-api": "lexter-copilot-api",
    "/home/lexter/lexter/api/lexter-copilot-server": "lexter-copilot-server",
    "/home/lexter/lexter/api/lexter-diligence": "lexter-diligence",
    "/home/lexter/lexter/api/lexter-imobiliario": "lexter-imobiliario",
    "/home/lexter/lexter/api/pdf-handler": "pdf-handler",
    "/home/lexter/lexter/api/prognosticos": "prognosticos",
    "/home/lexter/lexter/api/question-inference": "question-inference",
    "/home/lexter/lexter/data/data-lake": "data-lake",
    "/home/lexter/lexter/data/deepnote-analytics": "deepnote-analytics",
    "/home/lexter/lexter/data/documents-pipeline": "documents-pipeline",
    "/home/lexter/lexter/data/media-commander": "media-commander",
    "/home/lexter/lexter/infra/infrastructure": "infrastructure",
    "/home/lexter/lexter/infra/ops-hub": "ops-hub",
    "/home/lexter/lexter/web/admin-console": "admin-console",
    "/home/lexter/lexter/web/legal-ui": "legal-ui",
    "/home/lexter/lexter/web/lexter-copilot-addin": "lexter-copilot-addin",
    "/home/lexter/lexter/docs/handbook": "handbook",
    "/home/lexter/pessoal/faculdade/plant-disease-classifier": "plant-disease-classifier",
}

DEFAULT_PROJECT = "obsidian-vault"


def resolve_project(file_path: str) -> str | None:
    """Resolve a file path to a project name. Returns None if no match."""
    if not file_path:
        return None

    # Sort by length (longest first) for correct matching
    sorted_real = sorted(REAL_PATH_PATTERNS.items(), key=lambda x: len(x[0]), reverse=True)
    sorted_relative = sorted(PROJECT_PATTERNS.items(), key=lambda x: len(x[0]), reverse=True)

    # Try absolute path match against real repo locations
    for pattern, project in sorted_real:
        if file_path.startswith(pattern + "/") or file_path == pattern:
            return project

    # Try relative path match (paths stored relative to vault)
    for pattern, project in sorted_relative:
        if file_path.startswith(pattern + "/") or file_path == pattern:
            return project

    # Try making absolute path relative to vault
    if file_path.startswith(VAULT_CWD):
        rel_path = os.path.relpath(file_path, VAULT_CWD)
        for pattern, project in sorted_relative:
            if rel_path.startswith(pattern + "/") or rel_path == pattern:
                return project

    return None


def main():
    dry_run = "--dry-run" in sys.argv
    db_path = os.path.expanduser("~/.claude-mem/claude-mem.db")

    if not os.path.exists(db_path):
        print(f"Database not found at {db_path}")
        sys.exit(1)

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    # Get all observations tagged as 'Obsidian'
    cursor = db.execute(
        "SELECT id, project, files_read, files_modified FROM observations WHERE project = ?",
        ("Obsidian",),
    )
    rows = cursor.fetchall()
    print(f"Found {len(rows)} observations tagged as 'Obsidian'")

    updates = {}  # id -> new_project
    for row in rows:
        files_read = json.loads(row["files_read"]) if row["files_read"] else []
        files_modified = json.loads(row["files_modified"]) if row["files_modified"] else []
        all_files = files_read + files_modified

        # Try to resolve project from any file path
        resolved = None
        for f in all_files:
            resolved = resolve_project(f)
            if resolved:
                break

        if resolved:
            updates[row["id"]] = resolved

    # Count by project
    project_counts: dict[str, int] = {}
    for _id, project in updates.items():
        project_counts[project] = project_counts.get(project, 0) + 1

    # Count remaining as obsidian-vault
    remaining = len(rows) - len(updates)
    project_counts[DEFAULT_PROJECT] = remaining

    print(f"\nMigration plan:")
    for project, count in sorted(project_counts.items(), key=lambda x: -x[1]):
        print(f"  {project}: {count}")
    print(f"  Total: {len(rows)}")

    if dry_run:
        print("\n[DRY RUN] No changes made.")
        return

    # Apply updates
    print(f"\nApplying {len(updates)} project re-tags...")
    update_stmt = db.execute  # type hint
    for obs_id, new_project in updates.items():
        db.execute(
            "UPDATE observations SET project = ? WHERE id = ?",
            (new_project, obs_id),
        )

    # Re-tag remaining 'Obsidian' -> 'obsidian-vault'
    db.execute(
        "UPDATE observations SET project = ? WHERE project = ?",
        (DEFAULT_PROJECT, "Obsidian"),
    )

    # Also update sdk_sessions and session_summaries
    db.execute(
        "UPDATE sdk_sessions SET project = ? WHERE project = ?",
        (DEFAULT_PROJECT, "Obsidian"),
    )
    db.execute(
        "UPDATE session_summaries SET project = ? WHERE project = ?",
        (DEFAULT_PROJECT, "Obsidian"),
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
