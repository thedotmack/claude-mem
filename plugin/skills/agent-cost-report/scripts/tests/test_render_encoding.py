"""Portable date formatting."""
import re
import unittest
from pathlib import Path

import _paths


class DateFormatting(unittest.TestCase):
    def test_day_label_uses_unpadded_day(self):
        from acr import render
        self.assertEqual(render.day_label("2026-10-02"), "Fri Oct 2")
        self.assertEqual(render.day_label("2026-10-02", short=True), "Oct 2")

    def test_date_pill_retains_single_day_and_range_labels(self):
        from acr import render
        scope = {"kind": "period"}
        cases = [
            ("2026-10-02", "2026-10-03", "Oct 2, 2026 (PT)"),
            ("2026-10-02", "2026-10-04", "Oct 2 – 3, 2026 (PT)"),
            ("2026-09-29", "2026-10-03", "Sep 29 – Oct 2, 2026 (PT)"),
        ]
        for start, end, expected in cases:
            with self.subTest(start=start, end=end):
                self.assertEqual(render.date_pill({"start_pt": start, "end_exclusive_pt": end}, scope), expected)

    def test_sources_use_no_platform_specific_strftime_flags(self):
        # "%-d" (no zero padding) is a glibc/BSD extension: Windows strftime raises
        # "ValueError: Invalid format string". Compose the day as f"{d:%b} {d.day}" instead.
        sources = [Path(_paths.ACR_PY), *sorted(Path(_paths.SCRIPTS, "acr").glob("*.py"))]
        hits = [f"{source.name}:{number}" for source in sources
                for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1)
                if re.search(r"%-[A-Za-z]", line)]
        self.assertEqual(hits, [])
