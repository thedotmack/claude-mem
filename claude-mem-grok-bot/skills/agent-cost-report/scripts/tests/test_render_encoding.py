"""Native file rendering under a legacy Windows code page."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _paths


class NativeEncoding(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows code-page regression")
    def test_html_output_is_utf8_with_legacy_process_encoding(self):
        fixture = Path(_paths.FIXTURES) / "report-empty.json"
        data = json.loads(fixture.read_text(encoding="utf-8"))
        # A valid empty single-session report has no period date labels.
        # This isolates file encoding from the separate Windows strftime defect.
        data["scope"]["kind"] = "session"
        data["window"]["start_pt"] = None
        data["generated_at_pt"] = "中文 report"
        data["by_day"] = []
        data["timeline"] = {"wins_by_day": [], "mistakes_by_day": []}
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "report.json"
            source.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            script = """
import locale, pathlib, sys
sys.path.insert(0, sys.argv[1])
from acr import render
assert locale.getencoding().lower() != "utf-8", locale.getencoding()
for print_mode in (False, True):
    path = render.render_file(sys.argv[2], sys.argv[3], print_mode=print_mode)
    text = pathlib.Path(path).read_text(encoding="utf-8")
    assert '<meta charset="utf-8">' in text
    assert '‹' in text and '›' in text
    assert '中文 report' in text
"""
            process = subprocess.run(
                [sys.executable, "-X", "utf8=0", "-c", script, _paths.SCRIPTS, str(source), folder],
                capture_output=True, env=dict(os.environ, PYTHONUTF8="0"),
            )
            self.assertEqual(process.returncode, 0, process.stderr.decode("utf-8", errors="replace"))


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
