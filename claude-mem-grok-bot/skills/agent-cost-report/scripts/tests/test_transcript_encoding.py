"""Read the UTF-8 transcript contract under native Windows legacy encoding."""
import os
import subprocess
import sys
import unittest

import _paths


@unittest.skipUnless(os.name == "nt", "Native Windows default-encoding regression")
class TranscriptEncoding(unittest.TestCase):
    def check_reader(self, kind):
        program = r''' 
import json, locale, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
from acr import transcripts, behavior, wins, rules
assert locale.getencoding().lower() != "utf-8", locale.getencoding()
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
    if sys.argv[2] == "usage":
        rows, _ = transcripts.collect_claude(None, None, session="session", pattern=str(source))
        assert len(rows) == 1 and rows[0]["input"] == 10
        assert rows[0]["cwd"] == "C:/workspace/中文", repr(rows[0]["cwd"])
    elif sys.argv[2] == "behavior":
        sessions = behavior.scan(None, None, session="session", pattern=str(source))
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
