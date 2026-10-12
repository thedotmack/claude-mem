import copy
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import _paths
import _db
from acr import costs, evidence, labels, period, rollup
from acr.period import PT

PRICES = json.load(open(os.path.join(_paths.FIXTURES, "prices_sample.json")))
PRICES["models"]["test/no-output"] = dict(input=1.0, output=None, cache_read=0.1, cache_write=1.25, cache_write_1h=None)
PRICES["models"]["test/negative"] = dict(input=-1.0, output=-1.0, cache_read=-1.0, cache_write=-1.0, cache_write_1h=None)
PRICES["models"]["google/gemini-2.5-flash-lite"] = dict(input=0.1, output=0.4, cache_read=None, cache_write=None, cache_write_1h=None)
NOW = dt.datetime(2026, 9, 25, 12, 0, tzinfo=PT)
W = period.resolve_window("2026-09-18", "2026-09-21", now=NOW)
S = W.start_epoch_ms
H = 3600 * 1000
REMOTE_UUID = "45b12c6b-d8b8-49ad-bb7f-ef49a85bab44"
CS4 = dict(inp=100000, out=10000)          # big enough that the abandoned session's waste is not $0.00


def ms(day_offset, hours):
    return S + day_offset * 24 * H + int(hours * H)


def ts(m):
    return dt.datetime.fromtimestamp(m / 1000, PT).isoformat()


def row(session, m, model="claude-fable-5-1", inp=1000, out=100, cw5=0, cw1h=0, cr=0, file="/t/a.jsonl", cwd="/w/p"):
    return dict(src="claude-code", file=file, dir="-w-p", cwd=cwd, session=session, sidechain=False, model=model, ts=ts(m), input=inp, output=out,
                cache_write=cw5 + cw1h, cache_write_1h=cw1h, cache_write_5m=cw5, cache_read=cr, cost_usd_reported=None, device="local")


def fable_usd(inp=1000, out=100, cw5=0, cw1h=0, cr=0):
    return (inp * 10 + out * 50 + cw5 * 12.5 + cw1h * 20 + cr * 0.25) / 1e6


class Fixture(unittest.TestCase):
    """S1: local session with a transcript, completed summary, ship observation, triplicated observer rows.
    S2: remote replica (no transcript), completed. S3: trivial. S4: abandoned local with a recovery prompt."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="acr-rollup-"); self.dbp = os.path.join(self.tmp, "claude-mem.db")
        db = _db.make_db(self.dbp)
        _db.add_session(db, "cs1", "m1", "claude-mem", ms(0, 9), completed_ms=ms(0, 10), user_prompt="implement the rollup")
        for _ in range(3): _db.add_obs(db, "m1", "claude-mem", "discovery", "read files", 5000, ms(0, 9.2))        # same per-turn value x3
        self.ship_id = _db.add_obs(db, "m1", "claude-mem", "change", "PR #4125 merged to main", 7000, ms(0, 9.5))
        _db.add_summary(db, "m1", "claude-mem", "implement the rollup", "Rollup implemented and merged", ms(0, 9.9))
        _db.add_prompt(db, "cs1", 1, "implement the rollup", ms(0, 9))
        _db.add_tool(db, "cs1", "claude-mem", ms(0, 9.1))
        _db.add_session(db, "cs2", "m2", "claude-mem/wt", ms(1, 8), completed_ms=ms(1, 9), user_prompt="fix the bug")
        _db.add_obs(db, "m2", "claude-mem/wt", "bugfix", "fixed it", 20000, ms(1, 8.5), device=REMOTE_UUID)
        _db.add_summary(db, "m2", "claude-mem/wt", "fix the bug", "Fixed the bug in the sync path", ms(1, 8.9), device=REMOTE_UUID)
        _db.add_session(db, "cs3", "m3", "helper", ms(0, 20), completed_ms=ms(0, 20))
        _db.add_session(db, "cs4", "m4", "other", ms(1, 12), completed_ms=ms(1, 13), user_prompt="resume the dig after the usage-limit reset")
        _db.add_obs(db, "m4", "other", "discovery", "poked around", 1000, ms(1, 12.5))
        _db.add_prompt(db, "cs4", 1, "resume the dig after the usage-limit reset", ms(1, 12))
        db.commit(); db.close()
        self.rows = [row("cs1", ms(0, 9.3)), row("cs1", ms(0, 9.6), cw5=2000, cw1h=1000, cr=50000),
                     row("cs4", ms(1, 12.4), **CS4), row("orphan", ms(2, 5), inp=100, out=10, file="/t/o.jsonl")]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self, rows=None, scope=None, prices=None, behavior=False):   # Phase 2 tests exercise the draft waste split; Phase 2B has its own tests
        import sqlite3
        db = sqlite3.connect(self.dbp); db.row_factory = sqlite3.Row
        try:
            usage = dict(window=W.block(), rows=copy.deepcopy(rows if rows is not None else self.rows))
            return rollup.build(usage, prices or PRICES, db, scope or evidence.Scope("period", S=W.start_epoch_ms, E=W.end_epoch_ms), W.block(),
                                now=NOW, use_gh=False, remote=lambda cwd: None, behavior=behavior)
        finally:
            db.close()


class Rollup(Fixture):
    def test_observer_dedup_counts_triplicated_value_once(self):
        r, ev, _ = self.build()
        e1 = next(x for x in ev if x["memory_session_id"] == "m1")
        self.assertEqual(e1["observer_tokens_raw"], 3 * 5000 + 7000)
        self.assertEqual(e1["observer_tokens"], 5000 + 7000)
        self.assertAlmostEqual(r["spend"]["observer_note_taker_est_usd"], round((12000 + 20000 + 1000) * 0.1 / 1e6, 2))

    def test_observer_never_changes_agent_estimate_or_by_day(self):
        base, _, _ = self.build()
        expected = fable_usd() + fable_usd(cw5=2000, cw1h=1000, cr=50000) + fable_usd(**CS4) + fable_usd(100, 10)
        self.assertAlmostEqual(base["spend"]["agent_estimated_usd"], round(expected, 2))
        self.assertEqual(base["spend"]["headline_usd"], base["spend"]["agent_estimated_usd"])
        import sqlite3
        db = sqlite3.connect(self.dbp); db.execute("update observations set discovery_tokens = discovery_tokens * 100"); db.commit(); db.close()
        big, _, _ = self.build()
        self.assertEqual(big["spend"]["agent_estimated_usd"], base["spend"]["agent_estimated_usd"])
        self.assertEqual([d["agent_estimated_usd"] for d in big["by_day"]], [d["agent_estimated_usd"] for d in base["by_day"]])
        self.assertEqual([c["agent_estimated_usd"] for c in big["by_category"]], [c["agent_estimated_usd"] for c in base["by_category"]])
        self.assertGreater(big["spend"]["observer_note_taker_est_usd"], base["spend"]["observer_note_taker_est_usd"])

    def test_measured_is_null_with_status_never_zero(self):
        r, _, _ = self.build()
        self.assertIsNone(r["spend"]["agent_measured_usd"]); self.assertEqual(r["spend"]["measured_status"], "unavailable")
        self.assertEqual(r["spend"]["grok_bot_usage"]["status"], "unavailable"); self.assertNotIn("seat", str(r["spend"]["grok_bot_usage"].get("status")))
        self.assertTrue(all(li["cost_measured"] == "unavailable" for li in r["line_items"]))

    def test_by_day_covers_every_day_including_empty(self):
        r, _, _ = self.build()
        self.assertEqual([d["day_pt"] for d in r["by_day"]], ["2026-09-18", "2026-09-19", "2026-09-20"])
        d3 = r["by_day"][2]
        self.assertFalse(d3["no_agent_work"])            # the orphan transcript row is on day 3
        r2, _, _ = self.build(rows=self.rows[:3])
        self.assertTrue(r2["by_day"][2]["no_agent_work"]); self.assertEqual(r2["by_day"][2]["agent_estimated_usd"], 0)
        self.assertEqual(len(r2["timeline"]["wins_by_day"]), 3)

    def test_extrapolation_only_touches_sessions_without_transcript(self):
        r, _, _ = self.build()
        li = {x["session_ids"][0]: x for x in r["line_items"]}
        self.assertEqual(li["m1"]["cost_basis"], "estimated_usage"); self.assertIsNone(li["m1"]["cost_extrapolated"])
        self.assertEqual(li["m2"]["cost_basis"], "extrapolated"); self.assertIsNone(li["m2"]["cost_estimated"])
        measured_usd = fable_usd() + fable_usd(cw5=2000, cw1h=1000, cr=50000) + fable_usd(**CS4)
        ratio = measured_usd / (12000 + 1000)                       # USD per observer token over transcript sessions
        self.assertAlmostEqual(li["m2"]["cost_extrapolated"], round(20000 * ratio, 2), places=2)
        self.assertAlmostEqual(r["spend"]["extrapolated_unmeasured_usd"], round(20000 * ratio, 2), places=2)
        self.assertTrue(r["spend"]["extrapolation_basis"].startswith("EXTRAPOLATED (low confidence)"))
        self.assertAlmostEqual(r["spend"]["total_estimate_usd"], round(r["spend"]["agent_estimated_usd"] + r["spend"]["extrapolated_unmeasured_usd"], 2))

    def test_labels_start_keyword_and_only_review_changes_them(self):
        r, _, review = self.build()
        self.assertTrue(all(li["label_source"] == "keyword" for li in r["line_items"]))
        self.assertEqual(r["labels"], dict(reviewed=0, total=5))
        self.assertTrue(all(en["label_source"] == "keyword" and en["draft_category"] for en in review["items"]))
        rollup.aggregate(r)                                     # aggregation alone never promotes a label
        self.assertEqual(r["labels"]["reviewed"], 0)
        n = labels.apply_review(r["line_items"], dict(items=[dict(work_item_id="WI-1", category="Feature", failure_type="Rework", reviewed_by="Alex"),
                                                           dict(work_item_id="WI-2", category="Bug fix", reviewed_by="anthropic/claude-x")]), "2026-09-25 12:00 PT")
        rollup.aggregate(r)
        self.assertEqual(n, 2); self.assertEqual(r["labels"], dict(reviewed=2, total=5))
        li = {x["work_item_id"]: x for x in r["line_items"]}
        self.assertEqual((li["WI-1"]["label_source"], li["WI-1"]["category"], li["WI-1"]["failure_type"]), ("human", "Feature", "Rework"))
        self.assertEqual(li["WI-2"]["label_source"], "llm"); self.assertEqual(li["WI-3"]["label_source"], "keyword")
        self.assertIn("Rework", [f["failure_type"] for f in r["failure_economics"]])

    def test_unpriced_models_contribute_zero_with_flag(self):
        rows = self.rows + [row("cs1", ms(0, 9.7), model="test/no-output"), row("cs1", ms(0, 9.8), model="test/negative"), row("cs1", ms(0, 9.85), model="<synthetic>")]
        base, _, _ = self.build(); r, _, _ = self.build(rows=rows)
        self.assertEqual(r["spend"]["agent_estimated_usd"], base["spend"]["agent_estimated_usd"])
        self.assertEqual({(u["model"], u["reason"]) for u in r["unpriced_models"]},
                         {("test/no-output", "no output price listed"), ("test/negative", "negative (variable) price listed"), ("<synthetic>", "not in price list")})
        self.assertEqual(r["totals"]["tokens"]["api_calls"], len(rows))
        self.assertTrue(any(a["kind"] == "unpriced" for a in r["attention"]))
        self.assertEqual(sum(m["unpriced_calls"] for m in r["by_model"]), 3)

    def test_join_key_and_unmatched_still_counted(self):
        r, _, _ = self.build()
        li = {x["session_ids"][0]: x for x in r["line_items"]}
        self.assertTrue(li["m1"]["has_transcript"]); self.assertEqual(li["m1"]["agent_calls"], 2)
        self.assertEqual(r["unmatched_transcripts"]["count"], 1); self.assertEqual(r["unmatched_transcripts"]["sessions"][0]["session"], "orphan")
        self.assertAlmostEqual(r["unmatched_transcripts"]["usd"], round(fable_usd(100, 10), 2))
        self.assertEqual(r["totals"]["tokens"]["input"], 1000 + 1000 + CS4["inp"] + 100)

    def test_devices_labeled_never_uuid(self):
        r, ev, review = self.build()
        self.assertEqual([d["device"] for d in r["devices"]], ["local", "remote-1"])
        li = {x["session_ids"][0]: x for x in r["line_items"]}
        self.assertEqual(li["m2"]["device"], ["remote-1"]); self.assertEqual(li["m1"]["device"], ["local"])
        self.assertNotIn(REMOTE_UUID, json.dumps([r, ev, review])); self.assertEqual(r["totals"]["devices"], 2)

    def test_statuses_trivial_and_totals(self):
        r, _, _ = self.build()
        li = {x["session_ids"][0]: x for x in r["line_items"]}
        self.assertEqual(li["m1"]["status"], "shipped"); self.assertEqual(li["m2"]["status"], "completed")
        self.assertEqual(li["m3"]["status"], "abandoned"); self.assertTrue(li["m3"]["trivial"]); self.assertEqual(li["m4"]["status"], "abandoned")
        self.assertEqual(li["m4"]["failure_signals"], ["Recovery after miss"]); self.assertEqual(li["m4"]["failure_type"], "Recovery after miss")
        t = r["totals"]
        self.assertEqual((t["sessions"], t["real_work_sessions"], t["finished_outcomes"], t["ship_events"], t["projects"], t["repos"]), (4, 3, 2, 1, 4, 3)); self.assertEqual(t["transcript_only_sessions"], 1)   # the orphan transcript is its own line item, counted apart
        orphan = next(li for li in r["line_items"] if li["content_session_id"] == "orphan")
        self.assertEqual((orphan["status"], orphan["cost_basis"], orphan["has_transcript"], orphan["confidence"]), ("in_progress", "estimated_usage", True, "low"))
        self.assertEqual(li["m4"]["wasted_cost"], li["m4"]["attributed_usd"]); self.assertGreater(t["waste_rate"], 0)
        self.assertEqual(r["trivial_sessions"][0]["work_item_id"], li["m3"]["work_item_id"])
        self.assertIsInstance(r["failure_economics"], list); self.assertLessEqual(len(r["attention"]), 3)
        self.assertNotIn("Rework", [c["category"] for c in r["by_category"]])

    def test_session_scope_on_transcript_only_id_builds(self):
        r, _, _ = self.build(scope=evidence.Scope("session", session="orphan"))       # no claude-mem session: n must still be bound
        self.assertEqual([li["work_item_id"] for li in r["line_items"]], ["WI-1"]); self.assertTrue(r["line_items"][0]["orphan"])
        self.assertEqual(r["unmatched_transcripts"]["count"], 1)

    def test_usage_rows_outside_window_are_not_priced(self):
        r, _, _ = self.build(rows=self.rows + [row("cs1", ms(-1, 5), inp=999999), row("cs1", ms(3, 0), inp=999999)])   # a wider shared collect
        self.assertEqual(r["window"]["usage_rows_outside_window"], 2)
        self.assertEqual(r["totals"]["tokens"]["input"], 1000 + 1000 + CS4["inp"] + 100)
        self.assertEqual(r["spend"]["agent_estimated_usd"], self.build()[0]["spend"]["agent_estimated_usd"])

    def test_no_ratio_marks_sessions_without_transcript_unmeasured(self):
        r, _, _ = self.build(rows=[])                                                 # nothing measured on this box: no ratio
        li = {x["session_ids"][0]: x for x in r["line_items"]}
        self.assertEqual((li["m2"]["cost_status"], li["m2"]["cost_extrapolated"], li["m2"]["attributed_usd"]), ("unmeasured", None, 0.0))
        self.assertIsNone(r["spend"]["extrapolated_unmeasured_usd"]); self.assertTrue(r["spend"]["extrapolation_basis"].startswith("n/a"))
        r, _, _ = self.build()
        li = {x["session_ids"][0]: x for x in r["line_items"]}
        self.assertEqual((li["m1"]["cost_status"], li["m2"]["cost_status"]), ("estimated", "extrapolated"))

    def test_project_scope_metadata_excludes_other_projects(self):
        r, _, _ = self.build(scope=evidence.Scope("project", S=W.start_epoch_ms, E=W.end_epoch_ms, project="claude-mem"))
        self.assertEqual(r["observer"]["rows_in_scope"], dict(observations=5, summaries=2, prompts=1, tool_uses=1))   # m4's "other" project rows stay out
        self.assertEqual(r["totals"]["devices"], 2)

    def test_review_recomputes_per_day_finished_outcomes(self):
        r, _, _ = self.build()
        self.assertEqual(sum(d["finished_outcomes"] for d in r["by_day"]), r["totals"]["finished_outcomes"])
        li = {x["session_ids"][0]: x for x in r["line_items"]}; self.assertEqual(li["m4"]["status"], "abandoned")
        labels.apply_review(r["line_items"], [dict(work_item_id=li["m4"]["work_item_id"], category="Investigation", reviewed_by="Alex", status="completed")], "t")
        rollup.aggregate(r)
        self.assertEqual(r["totals"]["finished_outcomes"], 3); self.assertEqual(sum(d["finished_outcomes"] for d in r["by_day"]), 3)
        self.assertEqual(next(d for d in r["by_day"] if d["day_pt"] == li["m4"]["date_pt"])["finished_outcomes"], 2)
        orphan = next(x for x in r["line_items"] if x.get("orphan"))     # a reviewed transcript-only item stays out of both the headline and the days
        labels.apply_review(r["line_items"], [dict(work_item_id=orphan["work_item_id"], category="Feature", reviewed_by="Alex", status="shipped")], "t")
        rollup.aggregate(r)
        self.assertEqual((r["totals"]["finished_outcomes"], sum(d["finished_outcomes"] for d in r["by_day"])), (3, 3))

    def test_project_scope_includes_worktrees_and_session_scope(self):
        r, _, _ = self.build(scope=evidence.Scope("project", S=W.start_epoch_ms, E=W.end_epoch_ms, project="claude-mem"))
        self.assertEqual({x["session_ids"][0] for x in r["line_items"]}, {"m1", "m2"}); self.assertEqual(r["unmatched_transcripts"]["count"], 0)
        r, _, _ = self.build(scope=evidence.Scope("session", session="cs1"))
        self.assertEqual(len(r["line_items"]), 1); self.assertEqual([d["day_pt"] for d in r["by_day"]], ["2026-09-18"])
        # a shared period usage.json: only cs1's two rows are priced, not cs4's or the orphan's
        self.assertEqual(r["spend"]["agent_estimated_usd"], round(fable_usd() + fable_usd(cw5=2000, cw1h=1000, cr=50000), 2))
        self.assertEqual(r["totals"]["tokens"]["api_calls"], 2); self.assertEqual(r["unmatched_transcripts"]["count"], 0)


class Cli(Fixture):
    def test_rollup_and_review_cli(self):
        out = os.path.join(self.tmp, "out"); os.makedirs(out)
        json.dump(dict(window=W.block(), collector={}, rows=self.rows), open(os.path.join(out, "usage.json"), "w"))
        pf = os.path.join(self.tmp, "prices.json"); json.dump(PRICES, open(pf, "w"))
        r = subprocess.run([sys.executable, _paths.ACR_PY, "rollup", "--start", "2026-09-18", "--end", "2026-09-21", "--out", out, "--prices", pf,
                            "--db", self.dbp, "--no-gh"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        for f in ("report.json", "line-items.csv", "evidence.json", "labels.review.json", "snapshot.db"):
            self.assertTrue(os.path.exists(os.path.join(out, f)), f)
        rep = json.load(open(os.path.join(out, "report.json")))
        self.assertEqual(rep["spend"]["measured_status"], "unavailable"); self.assertEqual(rep["labels"]["reviewed"], 0)
        rv = json.load(open(os.path.join(out, "labels.review.json")))
        rv["items"][0].update(category="Feature", reviewed_by="Alex")
        rf = os.path.join(self.tmp, "reviewed.json"); json.dump(rv, open(rf, "w"))
        r = subprocess.run([sys.executable, _paths.ACR_PY, "review", "--apply", rf, "--out", out], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        rep = json.load(open(os.path.join(out, "report.json")))
        self.assertEqual(rep["labels"], dict(reviewed=1, total=5)); self.assertEqual(rep["line_items"][0]["label_source"], "human")
        rv["items"][1].update(category="Feature", failure_type="Made-up type", reviewed_by="Alex"); json.dump(rv, open(rf, "w"))
        r = subprocess.run([sys.executable, _paths.ACR_PY, "review", "--apply", rf, "--out", out], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn("unknown failure type", r.stderr)

    def test_rollup_rejects_session_with_period(self):
        r = subprocess.run([sys.executable, _paths.ACR_PY, "rollup", "--session", "x", "--start", "2026-09-18", "--out", self.tmp], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn("--session", r.stderr)


if __name__ == "__main__":
    unittest.main()
