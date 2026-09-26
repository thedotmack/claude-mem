import datetime as dt
import json
import os
import platform
import shutil
import tempfile
import unittest

import _paths
from acr import period, transcripts
from acr.period import PT


class Collector(unittest.TestCase):
    """Fixtures are copied into a temp dir so their mtime is 'now' (the reader prefilters on mtime)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="acr-tests-")
        shutil.copytree(os.path.join(_paths.FIXTURES, "projects"), os.path.join(cls.tmp, "projects"), copy_function=shutil.copy)
        shutil.copytree(os.path.join(_paths.FIXTURES, "codex"), os.path.join(cls.tmp, "codex"), copy_function=shutil.copy)
        cls.claude_glob = os.path.join(cls.tmp, "projects", "**", "*.jsonl")
        cls.codex_glob = os.path.join(cls.tmp, "codex", "sessions", "**", "*.jsonl")
        cls.now = dt.datetime(2026, 9, 25, 16, 42, tzinfo=PT)
        cls.window = period.resolve_window("2026-09-18", "2026-09-19", now=cls.now)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def collect(self, **kw):
        return transcripts.collect(kw.pop("window", self.window), claude_glob=self.claude_glob,
                                   codex_glob=self.codex_glob, **kw)

    def by_msg(self, doc):
        out = {}
        for r in doc["rows"]:
            if r["src"] == "claude-code":
                out.setdefault((r["session"], r["input"]), r)
        return out

    def test_dedup_on_message_id_and_request_id(self):
        doc = self.collect()
        claude = [r for r in doc["rows"] if r["src"] == "claude-code"]
        # sess-aaaa: msg_1 (twice -> once), msg_3, msg_4; msg_2 excluded (t == end). sess-bbbb: msg_5.
        self.assertEqual(len(claude), 4)
        self.assertEqual(doc["collector"]["dedup_dropped"], 1)
        self.assertEqual(sum(1 for r in claude if r["input"] == 10), 1)

    def test_window_edges_start_included_end_excluded(self):
        doc = self.collect()
        inputs = sorted(r["input"] for r in doc["rows"] if r["src"] == "claude-code")
        self.assertIn(10, inputs)        # msg_1 at exactly 2026-09-18T07:00:00Z == start
        self.assertNotIn(1000, inputs)   # msg_2 at exactly 2026-09-19T07:00:00Z == end
        # start row rendered in PT
        row = next(r for r in doc["rows"] if r["input"] == 10)
        self.assertEqual(row["ts"], "2026-09-18T00:00:00-07:00")

    def test_cache_split_direct_ephemeral_5m_field(self):
        row = self.by_msg(self.collect())[("sess-aaaa", 10)]
        self.assertEqual((row["cache_write"], row["cache_write_1h"], row["cache_write_5m"]), (100, 40, 60))

    def test_cache_split_fallback_subtraction(self):
        rows = self.by_msg(self.collect())
        r3 = rows[("sess-aaaa", 1)]   # cache_creation has only ephemeral_1h_input_tokens
        self.assertEqual((r3["cache_write"], r3["cache_write_1h"], r3["cache_write_5m"]), (100, 30, 70))
        r4 = rows[("sess-aaaa", 3)]   # no cache_creation block at all
        self.assertEqual((r4["cache_write"], r4["cache_write_1h"], r4["cache_write_5m"]), (100, 0, 100))

    def test_row_fields_and_extensions(self):
        rows = self.by_msg(self.collect())
        r = rows[("sess-bbbb", 50)]
        self.assertEqual(set(r), {"src", "file", "dir", "cwd", "session", "sidechain", "model", "ts", "input", "output",
                                  "cache_write", "cache_write_1h", "cache_write_5m", "cache_read", "cost_usd_reported", "device"})
        self.assertEqual(r["dir"], "-workspace-proj-b")
        self.assertEqual(r["cwd"], "/workspace/proj-b")
        self.assertTrue(r["sidechain"])
        self.assertEqual(r["device"], "local")
        self.assertEqual(r["cost_usd_reported"], 0.0123)
        self.assertEqual(r["model"], "claude-fable-5-1")
        self.assertIsNone(rows[("sess-aaaa", 10)]["cost_usd_reported"])

    def test_collector_block(self):
        doc = self.collect()
        c = doc["collector"]
        self.assertEqual(c["host_label"], platform.node())
        self.assertNotRegex(c["host_label"], r"^[0-9a-f]{8}-[0-9a-f]{4}-")  # never a device UUID
        self.assertEqual(c["files_seen"], 3)
        self.assertEqual(c["files_seen_by_src"], {"claude-code": 2, "codex": 1})
        self.assertEqual(c["rows"], len(doc["rows"]))
        self.assertEqual(c["window"], doc["window"])
        self.assertEqual(doc["window"]["start_pt"], "2026-09-18")
        self.assertFalse(doc["window"]["partial_last_day"])
        self.assertEqual(c["glob"], [self.claude_glob, self.codex_glob])

    def test_codex_cumulative_counter_becomes_per_event_growth_in_window(self):
        doc = self.collect()
        codex = [r for r in doc["rows"] if r["src"] == "codex"]
        # two token_count events inside the window (the 2026-09-19T07:00Z one == end is excluded); each row is the growth since the previous event
        self.assertEqual(len(codex), 2)
        self.assertEqual([(r["input"], r["output"], r["cache_read"]) for r in codex], [(100 - 40, 10, 40), (400 - 160, 70, 160)])
        self.assertEqual((sum(r["input"] for r in codex), sum(r["output"] for r in codex), sum(r["cache_read"] for r in codex)), (500 - 200, 80, 200))
        r = codex[0]
        self.assertEqual(r["model"], "gpt-5-codex")
        self.assertEqual(r["session"], "rollout-codex-1.jsonl")
        self.assertEqual(r["device"], "local")
        self.assertEqual(r["cache_write_5m"], 0)

    def test_codex_usage_before_the_window_is_subtracted(self):
        d = os.path.join(self.tmp, "codex", "sessions", "2026", "09", "17"); os.makedirs(d, exist_ok=True); self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        ev = lambda t, i, c, o: json.dumps(dict(timestamp=t, type="event_msg", payload=dict(type="token_count", info=dict(total_token_usage=dict(input_tokens=i, cached_input_tokens=c, output_tokens=o)))))
        with open(os.path.join(d, "rollout-boundary.jsonl"), "w") as fh:
            fh.write(json.dumps(dict(timestamp="2026-09-17T20:00:00.000Z", type="turn_context", payload=dict(model="gpt-5-codex"))) + "\n")
            fh.write(ev("2026-09-17T20:00:05.000Z", 300000, 100000, 50000) + "\n")     # before the window: cumulative 300k/100k/50k
            fh.write(ev("2026-09-18T15:00:00.000Z", 300000, 100000, 50000) + "\n")     # no growth: no row
            fh.write(ev("2026-09-18T16:00:00.000Z", 350000, 120000, 60000) + "\n")     # +50k in (+20k cached), +10k out
            fh.write(ev("2026-09-18T23:00:00.000Z", 360000, 120000, 61000) + "\n")     # +10k in, +1k out
        doc = self.collect()
        rows = [r for r in doc["rows"] if r["src"] == "codex" and r["session"] == "rollout-boundary.jsonl"]
        self.assertEqual([(r["input"], r["cache_read"], r["output"]) for r in rows], [(30000, 20000, 10000), (10000, 0, 1000)])
        self.assertEqual(sum(r["input"] + r["cache_read"] for r in rows), 360000 - 300000)   # only in-window growth, never the pre-window 300k

    def test_session_filter_has_no_period_filter(self):
        block = period.session_block("sess-aaaa", now=self.now)
        doc = self.collect(window=None, session="sess-aaaa", window_block=block)
        sessions = {r["session"] for r in doc["rows"]}
        self.assertEqual(sessions, {"sess-aaaa"})
        inputs = sorted(r["input"] for r in doc["rows"])
        self.assertEqual(inputs, [1, 3, 10, 1000])  # msg_2 (t == old end) is in: no window
        self.assertEqual(doc["collector"]["dedup_dropped"], 1)
        self.assertEqual(doc["window"]["session"], "sess-aaaa")
        self.assertIsNone(doc["window"]["start_pt"])

    def test_session_filter_other_session(self):
        doc = self.collect(window=None, session="sess-bbbb", window_block=period.session_block("sess-bbbb", now=self.now))
        self.assertEqual([r["session"] for r in doc["rows"]], ["sess-bbbb"])

    def test_window_outside_fixture_dates_yields_no_rows(self):
        w = period.resolve_window("2026-09-20", "2026-09-21", now=self.now)
        self.assertEqual(self.collect(window=w)["rows"], [])

    def test_session_without_window_block_builds_one(self):
        doc = self.collect(window=None, session="sess-bbbb")  # no window_block passed
        self.assertEqual(doc["window"]["session"], "sess-bbbb")
        self.assertIsNone(doc["window"]["start_pt"])
        self.assertEqual([r["session"] for r in doc["rows"]], ["sess-bbbb"])

    def test_needs_window_or_session(self):
        with self.assertRaises(ValueError):
            transcripts.collect(None, claude_glob=self.claude_glob, codex_glob=self.codex_glob)


if __name__ == "__main__":
    unittest.main()
