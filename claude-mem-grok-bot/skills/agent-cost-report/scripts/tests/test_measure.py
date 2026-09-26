"""Phase 4 tests (plan 4.3): mocked urlopen for the unavailable / ok / error paths, the bucket-vs-window
rule, and the no-key-material guard."""
import datetime as dt
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error

import _paths  # noqa: F401
from acr import measure, period, render

KEY = "sk-or-v1-testkeytestkeytestkeytestkey0000"
UTC = dt.timezone.utc


class FakeResp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False


def ok_opener(req, timeout=0):
    assert req.get_header("Authorization") == f"Bearer {KEY}"
    return FakeResp(json.dumps(dict(data=dict(usage=123.45, usage_daily=1.5, usage_weekly=42.25, usage_monthly=99.0, limit=None, limit_remaining=None, is_free_tier=False))).encode())


def http_error(req, timeout=0):
    raise urllib.error.HTTPError(req.full_url, 401, "unauthorized", {}, None)


class Measure(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def read(self):
        with open(os.path.join(self.tmp, "measured.json")) as fh: return fh.read()

    def test_unavailable_without_key(self):
        out = measure.measure(self.tmp, env={}, opener=lambda *a, **k: self.fail("must not call the endpoint"))
        self.assertEqual(out, dict(status="unavailable", reason="OPENROUTER_API_KEY not provided")); self.assertIn('"unavailable"', self.read())

    def test_ok_writes_buckets_and_no_key_material(self):
        now = dt.datetime(2026, 9, 26, 12, 0, tzinfo=UTC)
        out = measure.measure(self.tmp, env={"OPENROUTER_API_KEY": KEY}, opener=ok_opener, now=now)
        self.assertEqual((out["status"], out["usage_weekly"], out["usage_monthly"], out["usage_lifetime"], out["key_hint"]), ("ok", 42.25, 99.0, 123.45, None))
        txt = self.read(); self.assertNotIn("sk-", txt); self.assertNotIn(KEY[-8:], txt); self.assertNotIn("Bearer", txt)

    def test_error_keeps_http_status_only(self):
        out = measure.measure(self.tmp, env={"OPENROUTER_API_KEY": KEY}, opener=http_error)
        self.assertEqual(out, dict(status="error", http_status=401)); self.assertNotIn("sk-", self.read())

    def test_cli_unavailable_exit_zero(self):
        env = {k: v for k, v in os.environ.items() if k != "OPENROUTER_API_KEY"}
        r = subprocess.run([sys.executable, _paths.ACR_PY, "measure-openrouter", "--out", self.tmp], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr); self.assertIn("status=unavailable", r.stdout)


class Bucket(unittest.TestCase):
    def measured(self, fetched):
        return dict(status="ok", fetched_at_utc=fetched.isoformat(timespec="seconds"), usage_weekly=42.25, usage_monthly=99.0)

    def window(self, start, end):
        return period.resolve_window(start, end).block()

    def test_weekly_bucket_covers_window(self):
        w = self.window("2026-09-22", "2026-09-24")                         # Tue-Wed PT, inside the UTC week of Mon 21 Sep
        b = measure.bucket_rule(self.measured(dt.datetime(2026, 9, 25, 12, 0, tzinfo=UTC)), w)
        self.assertEqual((b["bucket"], b["usd"], b["covers_window"]), ("usage_weekly", 42.25, True)); self.assertIn("week Mon 21 Sep", b["label"]); self.assertIsNone(b["note"])

    def test_window_not_finished_is_reference_only(self):
        w = self.window("2026-09-22", "2026-09-27")                         # ends after "now"
        b = measure.bucket_rule(self.measured(dt.datetime(2026, 9, 25, 12, 0, tzinfo=UTC)), w)
        self.assertFalse(b["covers_window"]); self.assertIn("shown for reference", b["note"])

    def test_window_before_week_uses_month_or_reference(self):
        w = self.window("2026-09-18", "2026-09-26")                         # starts before Mon 21 Sep UTC; month bucket (Sep 1) covers it once now >= end
        b = measure.bucket_rule(self.measured(dt.datetime(2026, 9, 27, 12, 0, tzinfo=UTC)), w)
        self.assertEqual((b["bucket"], b["usd"], b["covers_window"]), ("usage_monthly", 99.0, True))
        w2 = self.window("2026-08-28", "2026-09-02")                        # crosses the month boundary: reference only
        b2 = measure.bucket_rule(self.measured(dt.datetime(2026, 9, 27, 12, 0, tzinfo=UTC)), w2)
        self.assertFalse(b2["covers_window"])

    def test_apply_and_render_measured(self):
        fx = os.path.join(_paths.FIXTURES, "report-7day.json")
        with open(fx) as fh: d = json.load(fh)
        measure.apply(d, dict(status="unavailable")); self.assertEqual((d["spend"]["agent_measured_usd"], d["spend"]["measured_status"]), (None, "unavailable"))
        measure.apply(d, dict(status="error", http_status=500)); self.assertIsNone(d["spend"]["agent_measured_usd"]); self.assertIn("error", d["spend"]["measured_status"])
        h = render.page(d); self.assertIn("Measured provider spend: unavailable", h); self.assertNotIn("$0.00<span class=\"est meas\"", h)
        fetched = dt.datetime(2026, 10, 2, 12, 0, tzinfo=UTC)               # month bucket Oct 1 does not cover a Sep window: reference only
        measure.apply(d, self.measured(fetched), now=fetched)
        self.assertIsNone(d["spend"]["agent_measured_usd"]); self.assertIn("reference", d["spend"]["measured_status"])
        h = render.page(d); self.assertIn("shown for reference", h); self.assertIn("MEASURED", h)
        for li in d["line_items"]: self.assertEqual(li["cost_basis"] in ("estimated_usage", "extrapolated"), True)
        fetched = dt.datetime(2026, 9, 27, 12, 0, tzinfo=UTC)               # Sep month bucket covers the Sep 18-25 window
        measure.apply(d, self.measured(fetched), now=fetched)
        self.assertEqual((d["spend"]["agent_measured_usd"], d["spend"]["measured_status"]), (99.0, "ok (period bucket)"))
        h = render.page(d); self.assertGreaterEqual(h.count("MEASURED"), 1); self.assertIn("note-taker calls", h); self.assertIn("$99.00", h)


class SessionScope(unittest.TestCase):
    def test_session_window_without_bounds_is_reference_only_not_a_crash(self):
        ok = dict(status="ok", fetched_at_utc="2026-09-25T19:00:00+00:00", usage_weekly=12.5, usage_monthly=40.0)
        b = measure.bucket_rule(ok, period.session_block("cs1"))
        self.assertEqual((b["covers_window"], b["usd"], b["bucket"]), (False, 12.5, "usage_weekly")); self.assertIn("reference only", b["note"])
        report = dict(window=period.session_block("cs1"), spend=dict(agent_estimated_usd=1.0))
        s = measure.apply(report, ok)
        self.assertIsNone(s["agent_measured_usd"]); self.assertTrue(s["measured_status"].startswith("reference only"))


if __name__ == "__main__":
    unittest.main()
