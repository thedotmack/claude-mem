import os
import shutil
import sqlite3
import tempfile
import unittest

import _paths  # noqa: F401
from acr import snapshot


class DbPath(unittest.TestCase):
    def test_env_override(self):
        self.assertEqual(snapshot.db_path({"CLAUDE_MEM_DATA_DIR": "/data/mem"}), "/data/mem/claude-mem.db")

    def test_default_is_home_claude_mem(self):
        self.assertEqual(snapshot.db_path({}), os.path.expanduser("~/.claude-mem/claude-mem.db"))
        self.assertEqual(snapshot.db_path({"CLAUDE_MEM_DATA_DIR": ""}), os.path.expanduser("~/.claude-mem/claude-mem.db"))


class Backup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="acr-snap-")
        self.live = os.path.join(self.tmp, "live", "claude-mem.db")
        os.makedirs(os.path.dirname(self.live))
        db = sqlite3.connect(self.live)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE sdk_sessions (content_session_id TEXT, project TEXT, started_at_epoch INTEGER)")
        db.executemany("INSERT INTO sdk_sessions VALUES (?,?,?)", [("s1", "p", 1), ("s2", "q", 2)])
        db.commit()
        db.close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_snapshot_is_a_faithful_copy_and_live_is_untouched(self):
        before = os.stat(self.live)
        out = os.path.join(self.tmp, "out")
        snap = snapshot.snapshot(out, live=self.live)
        self.assertEqual(snap, os.path.join(out, "snapshot.db"))
        after = os.stat(self.live)
        self.assertEqual((before.st_mtime_ns, before.st_size), (after.st_mtime_ns, after.st_size))
        db = snapshot.open_snapshot(snap)
        rows = db.execute("SELECT content_session_id, project FROM sdk_sessions ORDER BY 1").fetchall()
        db.close()
        self.assertEqual([tuple(r) for r in rows], [("s1", "p"), ("s2", "q")])
        # a second run replaces the stale snapshot
        snap2 = snapshot.snapshot(out, live=self.live)
        self.assertEqual(snap, snap2)

    def test_env_resolution_used_when_live_not_given(self):
        os.environ["CLAUDE_MEM_DATA_DIR"] = os.path.dirname(self.live)
        try:
            snap = snapshot.snapshot(os.path.join(self.tmp, "out2"))
        finally:
            del os.environ["CLAUDE_MEM_DATA_DIR"]
        self.assertTrue(os.path.exists(snap))

    def test_missing_db_is_a_clear_error(self):
        with self.assertRaises(FileNotFoundError):
            snapshot.snapshot(os.path.join(self.tmp, "out3"), live=os.path.join(self.tmp, "nope.db"))


if __name__ == "__main__":
    unittest.main()
