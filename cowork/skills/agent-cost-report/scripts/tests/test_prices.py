import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import _paths
from acr import prices

SAMPLE = os.path.join(_paths.FIXTURES, "prices_sample.json")


class Norm(unittest.TestCase):
    def test_norm_rules(self):
        self.assertEqual(prices.norm("claude-fable-5-1"), "anthropic/claude-fable-5.1")
        self.assertEqual(prices.norm("claude-sonnet-4-5-20250929"), "anthropic/claude-sonnet-4.5")
        self.assertEqual(prices.norm("gpt-5-codex"), "openai/gpt-5-codex")
        self.assertEqual(prices.norm("gemini-2.5-pro"), "google/gemini-2.5-pro")
        self.assertEqual(prices.norm("anthropic/claude-opus-5.5"), "anthropic/claude-opus-5.5")
        self.assertEqual(prices.norm("alias-x", aliases={"alias-x": "vendor/real"}), "vendor/real")


class Rate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = prices.load(SAMPLE)["models"]

    def test_explicit_cache_write_1h_is_used(self):
        r = prices.rate("anthropic/claude-opus-5.5", self.models)
        self.assertEqual(r["cache_write_1h"], 30.0)
        self.assertEqual(r["price_source"]["cache_write_1h"], "listed")
        self.assertEqual(r["price_source"], {"cache_read": "listed", "cache_write": "listed", "cache_write_1h": "listed"})

    def test_cache_write_1h_falls_back_to_2x_input(self):
        r = prices.rate("claude-fable-5-1", self.models)
        self.assertEqual(r["key"], "anthropic/claude-fable-5.1")
        self.assertEqual(r["input_usd_per_mtok"], 10.0)
        self.assertEqual(r["output_usd_per_mtok"], 50.0)
        self.assertEqual(r["cache_read"], 0.25)
        self.assertEqual(r["cache_write"], 12.5)
        self.assertEqual(r["cache_write_1h"], 20.0)
        self.assertEqual(r["price_source"]["cache_write_1h"], "input*2")
        self.assertEqual(r["source"], "openrouter-public-list")

    def test_cache_read_and_write_fallbacks(self):
        r = prices.rate("claude-sonnet-4-5-20250929", self.models)
        self.assertAlmostEqual(r["cache_read"], 0.3)
        self.assertAlmostEqual(r["cache_write"], 3.75)
        self.assertEqual(r["cache_write_1h"], 6.0)
        self.assertEqual(r["price_source"], {"cache_read": "input*0.1", "cache_write": "input*1.25", "cache_write_1h": "input*2"})

    def test_unpriced(self):
        self.assertIsNone(prices.rate("<synthetic>", self.models))
        self.assertIsNone(prices.rate("", self.models))
        self.assertIsNone(prices.rate(None, self.models))
        self.assertIsNone(prices.rate("unknown-model-9", self.models))
        self.assertIsNone(prices.rate("gpt-5-codex", self.models))  # listed but input is null


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="acr-prices-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ensure_with_saved_prices_writes_outdir_copy(self):
        path, p = prices.ensure(self.tmp, prices_file=SAMPLE)
        self.assertEqual(path, os.path.join(self.tmp, "prices.json"))
        with open(path) as fh:
            d = json.load(fh)
        self.assertEqual(d["models"]["anthropic/claude-fable-5.1"]["input"], 10.0)
        self.assertEqual(d["source"], prices.SOURCE_URL)
        self.assertEqual(d["loaded_from"], os.path.abspath(SAMPLE))

    def test_offline_fetch_is_an_error_not_zero(self):
        with self.assertRaises(prices.PriceError):
            prices.ensure(self.tmp, url="http://127.0.0.1:9/models")  # nothing listens here
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "prices.json")))

    def test_bad_prices_file(self):
        bad = os.path.join(self.tmp, "bad.json")
        with open(bad, "w") as fh:
            fh.write('{"nope": 1}')
        with self.assertRaises(prices.PriceError):
            prices.load(bad)
        with self.assertRaises(prices.PriceError):
            prices.load(os.path.join(self.tmp, "missing.json"))


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="acr-cli-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_acr(self, *argv):
        return subprocess.run([sys.executable, _paths.ACR_PY, *argv], capture_output=True, text=True)

    def test_prices_offline_exits_nonzero_with_clear_error(self):
        r = self.run_acr("prices", "--out", self.tmp, "--url", "http://127.0.0.1:9/models")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("could not fetch", r.stderr)
        self.assertIn("--prices", r.stderr)

    def test_prices_from_saved_file(self):
        r = self.run_acr("prices", "--out", self.tmp, "--prices", SAMPLE)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("4 models", r.stdout)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "prices.json")))

    def test_every_subcommand_is_wired(self):
        r = self.run_acr("--help")
        for cmd in ("collect", "prices", "rollup", "review", "render", "pdf", "measure-openrouter", "sync-check"): self.assertIn(cmd, r.stdout, cmd)

    def test_collect_rejects_session_with_period(self):
        r = self.run_acr("collect", "--session", "x", "--start", "2026-09-18", "--out", self.tmp)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--session", r.stderr)


if __name__ == "__main__":
    unittest.main()
