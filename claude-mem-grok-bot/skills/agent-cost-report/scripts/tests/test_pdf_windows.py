"""Native PDF controls for the ordinary Windows Chrome installation."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import _paths  # noqa: F401
from acr import render


@unittest.skipUnless(sys.platform == "win32", "requires actual Windows Chrome installation")
class WindowsChromePdf(unittest.TestCase):
    def setUp(self):
        candidates = [Path(os.environ[key]) / "Google/Chrome/Application/chrome.exe"
                      for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")
                      if key in os.environ]
        self.chrome = next((p for p in candidates if p.is_file()), None)
        if self.chrome is None:
            if os.environ.get("ACR_EXPECT_WINDOWS_CHROME") == "1":
                self.fail("Windows CI must provide Chrome for the native PDF regressions")
            self.skipTest("Chrome is optional and is not installed in a standard Windows location")
        print("native Chrome:", self.chrome, "google-chrome on PATH:", shutil.which("google-chrome"))
        self.tmp = tempfile.TemporaryDirectory(prefix="acr-native-pdf-")
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        (self.out / "report.print.html").write_text("<!doctype html><html><body>Native agent report</body></html>", encoding="utf-8")

    def test_default_discovers_installed_chrome_and_produces_pdf(self):
        # Exercise installed-file discovery even when the runner exposes a
        # chrome PATH alias. Keep Windows system tools, but no browser folders.
        system_path = str(Path(os.environ["SystemRoot"]) / "System32")
        with patch.dict(os.environ, {"PATH": system_path}):
            self.assertIsNone(shutil.which("google-chrome"))
            self.assertIsNone(shutil.which("chrome"))
            path, message = render.pdf(str(self.out))
        self.assertIsNotNone(path, message)
        self.assertTrue(Path(path).read_bytes().startswith(b"%PDF-"))
        self.assertFalse((self.out / ".chrome-profile").exists())

    def test_explicit_missing_browser_does_not_substitute_installed_chrome(self):
        path, message = render.pdf(str(self.out), chrome="acr-browser-that-does-not-exist")
        self.assertIsNone(path)
        self.assertIn("PDF skipped", message)
        self.assertFalse((self.out / "report.pdf").exists())

    def test_explicit_chrome_path_still_produces_pdf(self):
        path, message = render.pdf(str(self.out), chrome=str(self.chrome))
        self.assertIsNotNone(path, message)
        self.assertTrue(Path(path).read_bytes().startswith(b"%PDF-"))


if __name__ == "__main__":
    unittest.main()
