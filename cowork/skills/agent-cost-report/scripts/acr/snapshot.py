"""Read-only snapshot of the claude-mem SQLite database (plan Phase 1.3).

The live DB runs in WAL mode (src/services/sqlite/connection.ts:53-55), so a plain file copy
is wrong; the sqlite3 backup API is used instead. The live connection is opened with
`mode=ro` and closed right after the backup. Nothing here ever writes to the live DB.
"""
import os
import sqlite3

DB_FILE = "claude-mem.db"
SNAPSHOT_FILE = "snapshot.db"


def data_dir(env=None):
    """Mirrors src/shared/paths.ts:20-66: $CLAUDE_MEM_DATA_DIR if set, else ~/.claude-mem.
    settings.json is never consulted."""
    env = os.environ if env is None else env
    d = env.get("CLAUDE_MEM_DATA_DIR")
    return os.path.expanduser(d) if d else os.path.expanduser(os.path.join("~", ".claude-mem"))


def db_path(env=None):
    return os.path.join(data_dir(env), DB_FILE)


def snapshot(outdir, live=None):
    """Copy the live DB into <outdir>/snapshot.db via the backup API; return the snapshot path."""
    live = live or db_path()
    if not os.path.exists(live):
        raise FileNotFoundError(f"claude-mem database not found at {live} "
                                f"(set CLAUDE_MEM_DATA_DIR if it lives elsewhere)")
    os.makedirs(outdir, exist_ok=True)
    snap = os.path.join(outdir, SNAPSHOT_FILE)
    for ext in ("", "-wal", "-shm", "-journal"):  # drop a stale snapshot from an earlier run
        if os.path.exists(snap + ext):
            os.remove(snap + ext)
    # copied from /workspace/weekly-cost-workflow/weekly_report.py:17
    # src = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True); dst = sqlite3.connect(SNAP); src.backup(dst); dst.close(); src.close()
    src = sqlite3.connect(f"file:{live}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(snap)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return snap


def open_snapshot(snap):
    """Open a snapshot for querying (row_factory=Row, as weekly_report.py:18)."""
    db = sqlite3.connect(snap)
    db.row_factory = sqlite3.Row
    return db
