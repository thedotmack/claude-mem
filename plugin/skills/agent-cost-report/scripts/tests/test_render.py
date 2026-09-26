"""Phase 3 tests (plan 3.6, 3.7, 3.8): the renderer against the five report fixtures."""
import glob
import json
import os
import re
import shutil
import tempfile
import unittest

import _paths  # noqa: F401
from acr import render

FIXTURES = sorted(glob.glob(os.path.join(_paths.FIXTURES, "report-*.json")))
MONEY = re.compile(r"\$[0-9,]*\.[0-9]*")
TWO_DEC = re.compile(r"\$[0-9,]*\.[0-9][0-9]")


def load(path):
    with open(path) as fh: return json.load(fh)


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.assertEqual(len(FIXTURES), 5, FIXTURES)
        self.pages = {os.path.basename(f): render.page(load(f)) for f in FIXTURES}

    def test_no_script_or_external_resources(self):
        for name, h in self.pages.items():
            self.assertNotRegex(h, r"<script|<link|@import|url\(http|src=\"http", name)
            self.assertEqual(h.count("url("), h.count("url(#"), name)

    def test_dollars_two_decimals_no_cent_sign(self):
        for name, h in self.pages.items():
            body = re.sub(r'<span class="ex">.*?</span>', "", h)
            bad = [m for m in MONEY.findall(body) if not TWO_DEC.fullmatch(m)]
            self.assertEqual(bad, [], name); self.assertNotIn(chr(0xA2), h, name)   # no cent sign anywhere
            self.assertIn("Measured provider spend: unavailable", h, name)

    def test_layout_order_tiles_and_links(self):
        for name, h in self.pages.items():
            i_hero, i_wm, i_rib = h.find('class="hero'), h.find('class="wins-mistakes'), h.find('class="ribbon')
            self.assertTrue(0 <= i_hero < i_wm, name)
            self.assertTrue(i_rib == -1 or i_wm < i_rib, name)               # the ribbon is absent only when nothing is priced
            self.assertLessEqual(h.count('class="behavior-tile'), 4, name)
            self.assertEqual(h.count("Cost of mistakes"), 1, name)
            for frag in set(re.findall(r'href="#((?:win|mistakes)-[^"]+)"', h)): self.assertIn(f'id="{frag}"', h, f"{name}: {frag}")
            d = h.find('<details id="details"'); u = h.find("Upper bound")
            self.assertTrue(u == -1 or u > d, name)

    def test_day_chart_and_empty_days(self):
        one, empty, thirty = self.pages["report-1day.json"], self.pages["report-empty.json"], self.pages["report-30day.json"]
        self.assertEqual(one.count('class="cax"'), 1 + 1)                     # one day column label + one timeline label
        self.assertIn("no agent work", empty); self.assertIn("Nothing finished yet", empty)
        self.assertIn("No merged PR or published version found", empty)
        self.assertGreater(thirty.count("no agent work"), 20)

    def test_every_money_figure_in_hero_has_a_tag(self):
        for name, h in self.pages.items():
            hero = h[h.find('class="hero'): h.find('class="wins-mistakes')]
            self.assertGreaterEqual(hero.count('class="est'), len(MONEY.findall(hero)) - 1, name)   # the "each" figure shares the hero tag

    def test_deterministic(self):
        for f in FIXTURES: self.assertEqual(render.page(load(f)), render.page(load(f)))


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_render_file_and_print_mode(self):
        p = render.render_file(FIXTURES[0], self.tmp)
        self.assertTrue(p.endswith("report.html")); self.assertIn('<details id="details" >', open(p).read())
        q = render.render_file(FIXTURES[0], self.tmp, print_mode=True)
        self.assertTrue(q.endswith("report.print.html")); self.assertIn('<details id="details" open>', open(q).read())

    def test_pdf_skipped_without_chrome(self):
        render.render_file(FIXTURES[0], self.tmp, print_mode=True)
        path, msg = render.pdf(self.tmp, chrome="no-such-browser-xyz")
        self.assertIsNone(path); self.assertIn("PDF skipped, HTML is canonical", msg)

    def test_usd2_is_the_only_formatter(self):
        src = open(os.path.join(_paths.SCRIPTS, "acr", "render.py")).read()
        self.assertNotIn("def " + "cen" + "ts", src); self.assertNotIn(chr(0xA2), src); self.assertEqual(render.usd2(1234.5), "$1,234.50")


class Excerpts(unittest.TestCase):
    def test_top_example_episode_is_listed_once(self):
        d = load(os.path.join(_paths.FIXTURES, "report-1day.json")); day = d["timeline"]["mistakes_by_day"][0]
        ep = dict(episode_id="EP-1", session="cs-ep", ts_pt="2026-09-18 10:00 PT", day_pt=day["day_pt"], pattern="P12_unclear", messages_n=1, low_usd=0.2, high_usd=0.3,
                  cost_status="measured_tokens", alex_minutes=1.0, model=None, model_status="assumed", source="claude-code", device="local", excerpt="UNIQUE-EXCERPT-MARKER", wasted_keys=[])
        d["behavior"]["episodes"] = [ep]
        day["top_examples"] = [dict(mistake_id="MK-x", episode_id=ep["episode_id"], pattern=ep["pattern"], content_session_id=ep["session"], ts_pt=ep["ts_pt"])]
        h = render.page(d)
        self.assertEqual(h.count("UNIQUE-EXCERPT-MARKER"), 1); self.assertIn(ep["cost_status"], h)


class Unmeasured(unittest.TestCase):
    def test_no_ratio_never_prints_zero_extrapolated(self):
        li = dict(has_transcript=False, cost_extrapolated=None, attributed_usd=0.0, cost_basis="extrapolated")
        self.assertEqual((render._li_money(li), render._li_basis(li)), ("unmeasured", "unmeasured (no ratio)"))
        li = dict(has_transcript=False, cost_extrapolated=1.5, attributed_usd=1.5, cost_basis="extrapolated")
        self.assertEqual((render._li_money(li), render._li_basis(li)), ("$1.50", "extrapolated"))
        d = load(FIXTURES[0]); d["spend"]["extrapolated_unmeasured_usd"] = None; d["spend"]["extrapolation_basis"] = "n/a (no measured session to derive a ratio from)"
        for li in d["line_items"]:
            if not li.get("has_transcript"): li["cost_extrapolated"] = None; li["attributed_usd"] = 0.0
        h = render.page(d)
        self.assertIn("unavailable (no measured session to derive a ratio from)", h); self.assertNotIn("$0.00 <span class=\"est extra\">", h)


if __name__ == "__main__":
    unittest.main()
