"""Read the UTF-8 transcript contract under native Windows legacy encoding, and keep every text read and
write in the skill on an explicit encoding (the guard runs on every OS)."""
import argparse
import ast
import json
import os
import shutil
import subprocess
import sys
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
                mode = node.args[1] if len(node.args) > 1 else kw.get("mode")
                binary = isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "b" in mode.value
                text_open = isinstance(node.func, ast.Name) and node.func.id == "open" and not binary
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


@unittest.skipUnless(os.name == "nt", "Native Windows default-encoding regression")
class TranscriptEncoding(unittest.TestCase):
    def check_reader(self, kind):
        program = r'''
import json, locale, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
from acr import transcripts, behavior, wins, rules
encoding = locale.getpreferredencoding(False)
assert encoding.lower() != "utf-8", encoding
with tempfile.TemporaryDirectory() as folder:
    source = pathlib.Path(folder) / "session.jsonl"
    usage = {"input_tokens": 10, "output_tokens": 2}
    a = {"type": "assistant", "timestamp": "2026-09-18T12:00:00Z", "sessionId": "session",
         "cwd": "C:/workspace/中文", "requestId": "request", "message": {"id": "message", "usage": usage,
         "content": [{"type": "text", "text": "完成工作"}, {"type": "tool_use", "id": "tool", "name": "Bash",
         "input": {"command": "gh pr merge 42"}}]}}
    u = {"type": "user", "timestamp": "2026-09-18T12:00:01Z", "sessionId": "session",
         "message": {"content": [{"type": "tool_result", "tool_use_id": "tool", "content": "合并完成"}]}}
    source.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in (a, u))+"\n", encoding="utf-8")
    if sys.argv[2] == "codex":
        events = [{"type": "turn_context", "payload": {"model": "gpt-5-é"}},
                  {"type": "event_msg", "timestamp": "2026-09-18T12:00:00Z",
                   "payload": {"type": "token_count", "info": {"total_token_usage": usage}}}]
        source.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in events)+"\n", encoding="utf-8")
        rows, _ = transcripts.collect_codex(None, None, pattern=str(source))
        assert len(rows) == 1 and rows[0]["input"] == 10 and rows[0]["output"] == 2, repr(rows)
        assert rows[0]["model"] == "gpt-5-é", repr(rows[0]["model"])
    elif sys.argv[2] == "usage":
        rows, _ = transcripts.collect_claude(None, None, session="session", pattern=str(source))
        assert len(rows) == 1 and rows[0]["input"] == 10
        assert rows[0]["cwd"] == "C:/workspace/中文", repr(rows[0]["cwd"])
    elif sys.argv[2] == "behavior":
        sessions, _ = behavior.scan(None, None, session="session", pattern=str(source))
        turn = next(iter(sessions["session"]["turns"].values()))
        assert turn["text"] == "完成工作", repr(turn["text"])
    elif sys.argv[2] == "wins":
        items = list(wins.scan_transcripts([str(source)]))
        assert len(items) == 1
        assert items[0]["cwd"] == "C:/workspace/中文", repr(items[0]["cwd"])
        assert "合并完成" in items[0]["result"], repr(items[0]["result"])
    else:
        rule = pathlib.Path(folder) / "rules.md"
        rule.write_text("# 保留证据 (HARD — Alex 2026-09-18)\n", encoding="utf-8")
        items = rules.scan_rule_files(folder)
        assert len(items) == 1 and items[0]["name"] == "保留证据", repr(items)
'''
        result = subprocess.run(
            [sys.executable, "-X", "utf8=0", "-c", program, _paths.SCRIPTS, kind],
            env=dict(os.environ, PYTHONUTF8="0"), capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))

    def test_usage_retains_unicode_workspace(self):
        self.check_reader("usage")

    def test_behavior_retains_unicode_evidence(self):
        self.check_reader("behavior")

    def test_wins_retain_unicode_workspace_and_result(self):
        self.check_reader("wins")

    def test_rule_names_retain_unicode(self):
        self.check_reader("rules")

    def test_codex_retains_unicode_model(self):
        self.check_reader("codex")
