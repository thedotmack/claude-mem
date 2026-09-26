import datetime as dt
import unittest

import _paths  # noqa: F401
from acr import period
from acr.period import PT

H = 3600 * 1000


class DefaultWindow(unittest.TestCase):
    def test_default_last_7_full_pt_days_fixed_clock(self):
        now = dt.datetime(2026, 9, 25, 16, 42, tzinfo=PT)
        w = period.resolve_window(now=now)
        self.assertEqual(w.start_pt, "2026-09-18")
        self.assertEqual(w.end_exclusive_pt, "2026-09-25")
        self.assertFalse(w.partial_last_day)
        self.assertEqual(w.generated_at_pt, "2026-09-25 16:42 PT")
        self.assertEqual(w.start.utcoffset(), dt.timedelta(hours=-7))  # PDT, from zoneinfo
        self.assertEqual(w.end_epoch_ms - w.start_epoch_ms, 7 * 24 * H)
        b = w.block()
        self.assertEqual(set(b), {"start_pt", "end_exclusive_pt", "start_epoch_ms", "end_epoch_ms",
                                  "generated_at_pt", "partial_last_day"})
        self.assertEqual(b["start_epoch_ms"], int(dt.datetime(2026, 9, 18, tzinfo=PT).timestamp() * 1000))

    def test_default_accepts_a_utc_clock(self):
        now = dt.datetime(2026, 9, 26, 3, 0, tzinfo=dt.timezone.utc)  # still 2026-09-25 20:00 PT
        w = period.resolve_window(now=now)
        self.assertEqual((w.start_pt, w.end_exclusive_pt), ("2026-09-18", "2026-09-25"))

    def test_explicit_end_after_today_is_partial(self):
        now = dt.datetime(2026, 9, 25, 16, 42, tzinfo=PT)
        w = period.resolve_window("2026-09-18", "2026-09-26", now=now)
        self.assertTrue(w.partial_last_day)
        self.assertEqual(w.end_epoch_ms - w.start_epoch_ms, 8 * 24 * H)

    def test_explicit_end_equal_today_is_not_partial(self):
        now = dt.datetime(2026, 9, 25, 16, 42, tzinfo=PT)
        self.assertFalse(period.resolve_window("2026-09-18", "2026-09-25", now=now).partial_last_day)

    def test_only_start_given_defaults_end_to_today(self):
        now = dt.datetime(2026, 9, 25, 9, 0, tzinfo=PT)
        w = period.resolve_window(start="2026-09-01", now=now)
        self.assertEqual((w.start_pt, w.end_exclusive_pt), ("2026-09-01", "2026-09-25"))

    def test_bad_inputs(self):
        now = dt.datetime(2026, 9, 25, 9, 0, tzinfo=PT)
        with self.assertRaises(ValueError):
            period.resolve_window("2026-09-25", "2026-09-25", now=now)
        with self.assertRaises(ValueError):
            period.parse_day("2026-09-25T10:00")
        with self.assertRaises(ValueError):
            period.parse_day("2026-09-25+00:00")


class DstBoundary(unittest.TestCase):
    """US DST ends Sunday 2026-11-01 02:00 PT; PT windows are calendar days, so epoch spans change."""

    def test_default_window_across_fall_back(self):
        now = dt.datetime(2026, 11, 4, 10, 0, tzinfo=PT)
        w = period.resolve_window(now=now)
        self.assertEqual((w.start_pt, w.end_exclusive_pt), ("2026-10-28", "2026-11-04"))
        self.assertEqual(w.start.utcoffset(), dt.timedelta(hours=-7))  # PDT
        self.assertEqual(w.end.utcoffset(), dt.timedelta(hours=-8))    # PST
        self.assertEqual(w.end_epoch_ms - w.start_epoch_ms, (7 * 24 + 1) * H)
        self.assertFalse(w.partial_last_day)

    def test_single_day_containing_fall_back_is_25_hours(self):
        w = period.resolve_window("2026-11-01", "2026-11-02", now=dt.datetime(2026, 11, 5, tzinfo=PT))
        self.assertEqual(w.end_epoch_ms - w.start_epoch_ms, 25 * H)
        self.assertEqual(w.start.isoformat(), "2026-11-01T00:00:00-07:00")
        self.assertEqual(w.end.isoformat(), "2026-11-02T00:00:00-08:00")

    def test_default_window_ending_on_dst_day(self):
        now = dt.datetime(2026, 11, 1, 12, 0, tzinfo=PT)  # afternoon of the switch day (PST)
        w = period.resolve_window(now=now)
        self.assertEqual((w.start_pt, w.end_exclusive_pt), ("2026-10-25", "2026-11-01"))
        self.assertEqual(w.end.utcoffset(), dt.timedelta(hours=-7))  # midnight was still PDT
        self.assertEqual(w.end_epoch_ms - w.start_epoch_ms, 7 * 24 * H)


class SessionBlock(unittest.TestCase):
    def test_session_block_has_null_bounds(self):
        b = period.session_block("abc", now=dt.datetime(2026, 9, 25, 16, 42, tzinfo=PT))
        self.assertIsNone(b["start_pt"]); self.assertIsNone(b["end_epoch_ms"])
        self.assertEqual(b["session"], "abc"); self.assertFalse(b["partial_last_day"])
        self.assertEqual(b["generated_at_pt"], "2026-09-25 16:42 PT")


if __name__ == "__main__":
    unittest.main()
