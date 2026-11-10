"""Phase 7.2 tests: shipped-file list, CHECKSUMS.txt, drift detection and --write against temp destinations."""
import os
import shutil
import subprocess
import tempfile
import unittest

import _paths  # noqa: F401
from acr import sync


class Sync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.src = os.path.join(self.tmp, "plugin", "skills", "agent-cost-report")
        os.makedirs(os.path.join(self.src, "scripts", "acr")); os.makedirs(os.path.join(self.src, "scripts", "__pycache__")); os.makedirs(os.path.join(self.src, "scripts", "tests"))
        for rel, body in (("SKILL.md", "# skill\n"), ("scripts/acr.py", "print(1)\n"), ("scripts/acr/x.py", "x = 1\n"), ("scripts/__pycache__/x.pyc", "junk"), ("scripts/tests/test_x.py", "not shipped\n"), ("README.md", "not shipped\n")):
            with open(os.path.join(self.src, rel), "w") as fh: fh.write(body)
        self.dests = [os.path.join(self.tmp, "house"), os.path.join(self.tmp, "mirror", "skills", "agent-cost-report")]

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_shipped_files_and_checksums(self):
        self.assertEqual(sync.shipped_files(self.src), ["SKILL.md", "scripts/acr.py", "scripts/acr/x.py"])
        lines = sync.write_checksums(self.src)
        self.assertEqual(len(lines), 3); self.assertTrue(all(len(l.split("  ")[0]) == 64 for l in lines))
        r = subprocess.run(["sha256sum", "-c", sync.CHECKSUMS], cwd=self.src, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_drift_then_write(self):
        out = []
        self.assertEqual(sync.run(dests=self.dests, src=self.src, out=out.append), 8)            # 4 files x 2 destinations missing
        self.assertTrue(all(l.startswith("DRIFT") for l in out))
        out.clear(); self.assertEqual(sync.run(write=True, dests=self.dests, src=self.src, out=out.append), 0)
        self.assertTrue(all(l.startswith("ok") for l in out))
        self.assertFalse(os.path.exists(os.path.join(self.dests[0], "README.md")))               # only shipped files are copied
        self.assertFalse(os.path.exists(os.path.join(self.dests[0], "scripts", "__pycache__")))
        self.assertFalse(os.path.exists(os.path.join(self.dests[0], "scripts", "tests")))
        with open(os.path.join(self.dests[1], "scripts", "acr", "x.py"), "w") as fh: fh.write("x = 2\n")
        self.assertEqual(sync.run(dests=self.dests, src=self.src, out=out.append), 1)




if __name__ == "__main__":
    unittest.main()
