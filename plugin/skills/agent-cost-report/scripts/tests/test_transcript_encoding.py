"""Keep every text read and write in the skill on an explicit encoding."""
import argparse
import ast
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import _paths


class ExplicitEncoding(unittest.TestCase):
    def test_every_text_open_and_text_subprocess_names_an_encoding(self):
        # Without encoding=, Python uses the locale codec: cp936 or cp1252 on Windows, which mangles or rejects
        # the UTF-8 in transcripts, rule files, gh output, reviewed labels, the CSV and the spot-check sheet (#4250).
        missing = []
        for source in [Path(_paths.ACR_PY), *sorted(Path(_paths.SCRIPTS, "acr").glob("*.py"))]:
            for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
                if not isinstance(node, ast.Call): continue
                kw = {k.arg: k.value for k in node.keywords}
                if "encoding" in kw: continue
                method = node.func.attr if isinstance(node.func, ast.Attribute) else None
                mode_index = 0 if method == "open" else 1
                mode = node.args[mode_index] if len(node.args) > mode_index else kw.get("mode")
                binary = isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "b" in mode.value
                text_open = not binary and ((isinstance(node.func, ast.Name) and node.func.id == "open") or method == "open")
                text_open = text_open or method in ("read_text", "write_text")
                text_run = any(isinstance(kw.get(k), ast.Constant) and kw[k].value is True for k in ("text", "universal_newlines"))
                if text_open or text_run: missing.append(f"{source.name}:{node.lineno}")
        self.assertEqual(missing, [])

    def test_review_apply_accepts_a_reviewed_file_saved_with_a_bom(self):
        from acr import rollup
        tmp = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, tmp, True)
        shutil.copy(os.path.join(_paths.FIXTURES, "report-7day.json"), os.path.join(tmp, "report.json"))
        reviewed = dict(reviewed_by="Alex", items=[dict(work_item_id="WI-1", category="Feature", title="Résumé — naïve ✓")])
        with open(os.path.join(tmp, "reviewed.json"), "wb") as fh:          # what a Windows editor saves: UTF-8 with a BOM
            fh.write(b"\xef\xbb\xbf" + json.dumps(reviewed, ensure_ascii=False).encode("utf-8"))
        rollup.run_review(argparse.Namespace(out=tmp, apply=os.path.join(tmp, "reviewed.json")))
        with open(os.path.join(tmp, "report.json"), encoding="utf-8") as fh: item = next(li for li in json.load(fh)["line_items"] if li["work_item_id"] == "WI-1")
        self.assertEqual((item["reviewed_by"], item["label_source"], item["title"]), ("Alex", "human", "Résumé — naïve ✓"))
