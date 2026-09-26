"""Regenerates tests/fixtures/report-*.json (1-day, 7-day, 30-day, empty period, single session) from the
test_rollup fixture DB, so the renderer tests never depend on the live database. Run from scripts/tests:
    python3 fixtures/make_report_fixtures.py
"""
import copy
import json
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import _paths  # noqa: E402,F401
import test_rollup as tr  # noqa: E402
from acr import evidence, period, rollup  # noqa: E402

EMPTY_GLOB = os.path.join(tempfile.mkdtemp(prefix="acr-noglob-"), "**", "*.jsonl")


def build(fx, start, end, scope=None, rows=None):
    W = period.resolve_window(start, end, now=tr.NOW) if start else None
    db = sqlite3.connect(fx.dbp); db.row_factory = sqlite3.Row
    try:
        sc = scope or evidence.Scope("period", S=W.start_epoch_ms, E=W.end_epoch_ms)
        usage = dict(window=(W.block() if W else period.session_block(sc.session, now=tr.NOW)), rows=copy.deepcopy(fx.rows if rows is None else rows))
        report, _, _ = rollup.build(usage, tr.PRICES, db, sc, usage["window"], now=tr.NOW, use_gh=False, remote=lambda cwd: None, glob_pattern=EMPTY_GLOB)
        return report
    finally:
        db.close()


def main():
    fx = tr.Fixture("setUp"); fx.setUp()
    try:
        out = {"report-1day": build(fx, "2026-09-18", "2026-09-19"), "report-7day": build(fx, "2026-09-18", "2026-09-25"),
               "report-30day": build(fx, "2026-09-01", "2026-10-01"), "report-empty": build(fx, "2026-08-01", "2026-08-03", rows=[]),
               "report-session": build(fx, None, None, evidence.Scope("session", session="cs1"))}
        for name, rep in out.items():
            with open(os.path.join(_paths.FIXTURES, name + ".json"), "w") as fh: json.dump(rep, fh, indent=1, default=str, sort_keys=True)
            print(name, rep["totals"]["sessions"], len(rep["by_day"]), rep["spend"]["agent_estimated_usd"])
    finally:
        fx.tearDown()


if __name__ == "__main__":
    main()
