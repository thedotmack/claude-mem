"""Phase 5 tests (plan 5.3): device export carries no text, and merging a second device's export flips
replica sessions from extrapolated to measured while the extrapolation is recomputed for the rest."""
import copy
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

import _paths  # noqa: F401
import test_rollup as tr
from acr import devices, evidence, rollup, transcripts


class Export(unittest.TestCase):
    def setUp(self):
        self.fx = tr.Fixture("setUp"); self.fx.setUp(); self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "projects", "-w-p"))
        line = dict(type="assistant", timestamp="2026-09-18T17:00:00.000Z", sessionId="cs1", requestId="r1", cwd="/w/p", isSidechain=False,
                    message=dict(id="m1", model="claude-fable-5-1", usage=dict(input_tokens=10, output_tokens=5, cache_creation_input_tokens=0, cache_read_input_tokens=0), content=[dict(type="text", text="secret prompt text")]))
        with open(os.path.join(self.tmp, "projects", "-w-p", "cs1.jsonl"), "w") as fh: fh.write(json.dumps(line) + "\n")

    def tearDown(self):
        self.fx.tearDown(); shutil.rmtree(self.tmp)

    def test_export_has_ids_tokens_models_and_no_text(self):
        doc = transcripts.collect(tr.W, claude_glob=os.path.join(self.tmp, "projects", "**", "*.jsonl"), codex_glob=os.path.join(self.tmp, "none", "*.jsonl"), window_block=tr.W.block())
        path, out = devices.export("mac", doc, self.tmp, tr.W.block(), live_db=self.fx.dbp)
        self.assertTrue(path.endswith("device-usage-mac.json")); self.assertFalse(os.path.exists(os.path.join(self.tmp, "snapshot.db")))
        d = devices.load(path)
        self.assertEqual((d["device"], len(d["rows"]), d["rows"][0]["device"], d["rows"][0]["session"]), ("mac", 1, "mac", "cs1"))
        self.assertIn("m1", d["sessions"]); self.assertEqual(d["sessions"]["m1"]["content_session_id"], "cs1")
        txt = open(path).read(); self.assertNotIn("secret prompt", txt); self.assertNotIn("/w/p", txt); self.assertNotIn(".jsonl", txt)
        self.assertFalse(any(k in r for r in d["rows"] for k in devices.FORBIDDEN))

    def test_load_rejects_text_fields(self):
        p = os.path.join(self.tmp, "bad.json")
        with open(p, "w") as fh: json.dump(dict(device="x", window={}, rows=[dict(session="a", prompt="hi")], sessions={}), fh)
        with self.assertRaises(ValueError): devices.load(p)


class OutsideWindow(unittest.TestCase):
    def test_rows_outside_the_report_window_are_never_appended(self):
        rows = []; export = dict(device="mac", window=dict(start_pt="2026-09-21", end_exclusive_pt="2026-09-22"), sessions={},
                                 rows=[tr.row("x", tr.ms(0, 9)), tr.row("x", tr.ms(3, 1)), tr.row("x", tr.ms(-1, 23))])   # one inside, two outside
        out = devices.merge(rows, [export], {}, tr.W.block())
        self.assertEqual(len(rows), 1); self.assertEqual((out[0]["outside_window"], out[0]["unmatched"], out[0]["window_matches_report"]), (2, 1, False))
        rows = []; devices.merge(rows, [export], {}, dict(start_epoch_ms=None, end_epoch_ms=None))   # a --session run has no bounds
        self.assertEqual(len(rows), 3)


class Merge(unittest.TestCase):
    """cs2 is a replica session on the box (remote observations, no transcript). A Mac export whose local
    session map names its memory id m2 must join it."""
    def setUp(self):
        self.fx = tr.Fixture("setUp"); self.fx.setUp()

    def tearDown(self):
        self.fx.tearDown()

    def build(self, exports=()):
        db = sqlite3.connect(self.fx.dbp); db.row_factory = sqlite3.Row
        try:
            usage = dict(window=tr.W.block(), rows=copy.deepcopy(self.fx.rows))
            report, _, _ = rollup.build(usage, tr.PRICES, db, evidence.Scope("period", S=tr.W.start_epoch_ms, E=tr.W.end_epoch_ms), tr.W.block(), now=tr.NOW, use_gh=False,
                                        remote=lambda cwd: None, behavior=False, device_exports=list(exports))
            return report
        finally:
            db.close()

    def mac_export(self, cs="mac-local-cs2", mid="m2", n=1, inp=50000):
        rows = [dict(src="claude-code", session=cs, sidechain=False, model="claude-fable-5-1", ts=tr.ts(tr.ms(1, 8.3 + i * 0.1)), input=inp, output=1000, cache_write=0, cache_write_1h=0, cache_write_5m=0, cache_read=0, cost_usd_reported=None, device="mac") for i in range(n)]
        return dict(device="mac", host_label="alex-mbp", exported_at_pt="x", window=tr.W.block(), rows=rows, sessions={mid: dict(content_session_id=cs, project="claude-mem/wt", started_at_epoch=tr.ms(1, 8))})

    def test_merge_flips_extrapolated_to_measured(self):
        before = self.build(); li0 = {li["session_ids"][0]: li for li in before["line_items"]}
        self.assertEqual(li0["m2"]["cost_basis"], "extrapolated"); self.assertGreater(before["spend"]["extrapolated_unmeasured_usd"], 0)
        after = self.build([self.mac_export()]); li1 = {li["session_ids"][0]: li for li in after["line_items"]}
        self.assertEqual((li1["m2"]["cost_basis"], li1["m2"]["has_transcript"], li1["m2"]["device"]), ("estimated_usage", True, ["mac", "remote-1"]))
        self.assertGreater(after["spend"]["agent_estimated_usd"], before["spend"]["agent_estimated_usd"])
        self.assertEqual(after["spend"]["extrapolated_unmeasured_usd"], 0.0)                  # only the trivial cs3 stays unmeasured, with 0 observer tokens
        self.assertIn("from 1 sessions with no transcript", after["spend"]["extrapolation_basis"])
        for li in after["line_items"]: li["has_transcript"] = True
        from acr import costs; self.assertIn("all sessions measured", costs.extrapolation(after["line_items"])[1])
        self.assertIn("device export: mac", li1["m2"]["notes"])
        de = after["device_exports"][0]; self.assertEqual((de["device"], de["joined"], de["unmatched"], de["duplicates_skipped"], de["window_matches_report"]), ("mac", 1, 0, 0, True))
        self.assertEqual(after["unmatched_transcripts"]["count"], before["unmatched_transcripts"]["count"])

    def test_unknown_session_is_unmatched_and_duplicates_skipped(self):
        ex = self.mac_export(cs="nobody-knows", mid="m-none")
        after = self.build([ex, ex])
        de = after["device_exports"]; self.assertEqual((de[0]["unmatched"], de[1]["duplicates_skipped"]), (1, 1))
        self.assertEqual(after["unmatched_transcripts"]["count"], 2)    # the orphan row from the fixture plus this one
        self.assertIn("device:mac", after["unmatched_transcripts"]["by_dir"])


if __name__ == "__main__":
    unittest.main()
