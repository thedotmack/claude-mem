"""Phase 3 tests (plan 3.6, 3.7, 3.8): the renderer against the five report fixtures."""
import glob
import json
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_failed_render_keeps_the_previous_report(self):
        p = render.render_file(FIXTURES[0], self.tmp)
        with open(p, "rb") as fh: before = fh.read()
        self.assertIn(b"<!doctype html>", before)
        d = load(FIXTURES[0]); del d["line_items"]                          # malformed report.json: page() raises KeyError
        bad = os.path.join(self.tmp, "broken.json")
        with open(bad, "w", encoding="utf-8") as fh: json.dump(d, fh)
        with self.assertRaises(KeyError): render.render_file(bad, self.tmp)
        with open(p, "rb") as fh: self.assertEqual(fh.read(), before)       # not truncated to 0 bytes (#4250)

    def test_pdf_skipped_without_chrome(self):
        render.render_file(FIXTURES[0], self.tmp, print_mode=True)
        path, msg = render.pdf(self.tmp, chrome="no-such-browser-xyz")
        self.assertIsNone(path); self.assertIn("PDF skipped, HTML is canonical", msg)

    def test_usd2_is_the_only_formatter(self):
        src = open(os.path.join(_paths.SCRIPTS, "acr", "render.py")).read()
        self.assertNotIn("def " + "cen" + "ts", src); self.assertNotIn(chr(0xA2), src); self.assertEqual(render.usd2(1234.5), "$1,234.50")


def posix(path):
    return os.fspath(path).replace("\\", "/")


MAC_APP = "Google Chrome.app/Contents/MacOS/Google Chrome"
PDF = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


class FakeChrome:
    """subprocess.Popen stand-in: prints `pdf` to the --print-to-pdf= path (nothing when None), writes `stderr`, then
    exits with `exit_code`, or, like Chrome on macOS, keeps running until it is terminated (`exits=False`)."""
    def __init__(self, pdf=PDF, stderr=b"", exit_code=0, exits=True):
        self.pdf, self.stderr, self.exit_code, self.exits = pdf, stderr, exit_code, exits
        self.cmds, self.terminated, self.returncode = [], False, None

    def __call__(self, cmd, stdout=None, stderr=None):
        self.cmds.append(cmd); self.returncode = None
        if self.pdf is not None:
            with open(next(a for a in cmd if a.startswith("--print-to-pdf="))[len("--print-to-pdf="):], "wb") as fh: fh.write(self.pdf)
        stderr.write(self.stderr)
        return self

    def poll(self):
        if self.returncode is None and self.exits: self.returncode = self.exit_code
        return self.returncode

    def wait(self, timeout=None):
        return self.poll()

    def terminate(self):
        self.terminated, self.returncode = True, -15

    kill = terminate


class ChromeLookup(unittest.TestCase):
    """pdf() on every OS with sys.platform, PATH, the install check and the Chrome process patched: the default
    lookup per platform, and how a Chrome that exits, fails, hangs or keeps running after printing is handled."""
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="acr pdf #")          # a space and a '#' must survive into the file URL
        self.addCleanup(shutil.rmtree, self.tmp, True)
        with open(os.path.join(self.tmp, "report.print.html"), "w", encoding="utf-8") as fh: fh.write("<p>report</p>")

    def pdf(self, platform, on_path=(), installed=(), env=None, chrome="google-chrome", fake=None):
        fake = fake or FakeChrome()
        with patch("sys.platform", platform), patch("shutil.which", lambda name: "/usr/bin/" + name if name in on_path else None), \
                patch("os.path.isfile", lambda p: posix(p) in installed), patch.dict(os.environ, env or {}), patch("subprocess.Popen", fake), \
                patch.object(render, "CHROME_EXIT_GRACE_S", 0.05), patch.object(render, "CHROME_TIMEOUT_S", 0.3):
            path, msg = render.pdf(self.tmp, chrome=chrome)
        return path, msg, [posix(cmd[0]) for cmd in fake.cmds], fake

    def mac(self, **kw):
        return self.pdf("darwin", installed=("/Applications/" + MAC_APP,), **kw)

    def test_linux_default_is_google_chrome_on_path(self):
        self.assertEqual(self.pdf("linux", on_path=("google-chrome",))[2], ["/usr/bin/google-chrome"])
        path, msg, exes, _ = self.pdf("linux", installed=("/Applications/" + MAC_APP,))
        self.assertEqual((path, exes), (None, [])); self.assertIn("PDF skipped, HTML is canonical", msg)

    def test_macos_default_finds_the_app_bundle_off_path(self):
        self.assertEqual(self.mac()[2], ["/Applications/" + MAC_APP])
        user_app = posix(os.path.join(os.path.expanduser("~"), "Applications", *MAC_APP.split("/")))
        self.assertEqual(self.pdf("darwin", installed=(user_app,))[2], [user_app])
        self.assertEqual(self.pdf("darwin", on_path=("google-chrome",), installed=("/Applications/" + MAC_APP,))[2], ["/usr/bin/google-chrome"])

    def test_windows_default_finds_installed_chrome_off_path(self):
        env = {"PROGRAMFILES": r"C:\Program Files", "PROGRAMFILES(X86)": r"C:\Program Files (x86)", "LOCALAPPDATA": r"C:\Users\u\AppData\Local"}
        local = "C:/Users/u/AppData/Local/Google/Chrome/Application/chrome.exe"
        self.assertEqual(self.pdf("win32", installed=(local,), env=env)[2], [local])
        self.assertEqual(self.pdf("win32", on_path=("chrome",), installed=(local,), env=env)[2], ["/usr/bin/chrome"])

    def test_explicit_chrome_is_never_substituted(self):
        path, msg, exes, _ = self.mac(chrome="no-such-browser-xyz")
        self.assertEqual((path, exes), (None, [])); self.assertIn("PDF skipped", msg)

    def test_chrome_gets_a_file_uri(self):
        path, msg, _, fake = self.mac()
        self.assertEqual(msg, f"pdf: {path}")
        url = fake.cmds[0][-1]
        self.assertEqual(url, Path(self.tmp, "report.print.html").resolve().as_uri())
        self.assertIn("%23", url); self.assertNotIn(" ", url)              # a raw '#' would start a URL fragment

    def test_chrome_that_keeps_running_after_printing_is_stopped(self):
        path, msg, _, fake = self.mac(fake=FakeChrome(exits=False))      # Chrome on macOS writes the PDF, then never exits
        self.assertEqual((path, msg, fake.terminated), (os.path.join(self.tmp, "report.pdf"), f"pdf: {path}", True))
        with open(path, "rb") as fh: self.assertEqual(fh.read(), PDF)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, ".chrome-profile")))

    def test_failed_print_reports_stderr_and_keeps_the_last_pdf(self):
        with open(os.path.join(self.tmp, "report.pdf"), "wb") as fh: fh.write(PDF)
        path, msg, _, _ = self.mac(fake=FakeChrome(pdf=b"%PDF-1.4 cut short", stderr=b"\xff\xfe bad flag \xe2\x80\x94 exiting", exit_code=1))
        self.assertIsNone(path); self.assertIn("PDF skipped, HTML is canonical (chrome exit 1:", msg); self.assertIn("bad flag — exiting", msg)
        with open(os.path.join(self.tmp, "report.pdf"), "rb") as fh: self.assertEqual(fh.read(), PDF)   # not replaced by a partial print

    def test_chrome_that_never_prints_times_out(self):
        path, msg, _, fake = self.mac(fake=FakeChrome(pdf=None, exits=False))
        self.assertEqual((path, msg, fake.terminated), (None, "PDF skipped, HTML is canonical (chrome timed out)", True))


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
