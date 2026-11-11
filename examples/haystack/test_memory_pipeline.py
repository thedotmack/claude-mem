import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

from memory_pipeline import memory_tools, recall_note, save_note
from haystack.core.errors import PipelineRuntimeError
from haystack.tools.errors import ToolInvocationError
from haystack_integrations.tools.mcp import MCPInvocationError


class LivePipelineTests(unittest.TestCase):
    def setUp(self):
        for key in ("CLAUDE_MEM_MCP_SERVER", "CLAUDE_MEM_WORKER_PORT", "CLAUDE_MEM_DATA_DIR"):
            self.assertTrue(os.environ.get(key), f"Set {key} for an isolated live worker.")
        self.project = f"haystack-test-{uuid.uuid4()}"

    def test_native_pipeline_reads_a_selected_note_and_preserves_identity(self):
        title, text = "Haystack release decision", "Use the violet region for the retrieval service."
        saved = save_note(self.project, title, text)
        identifier = int(re.search(r"Saved memory #(\d+)", saved)[1])
        self.assertIn(f"already saved as #{identifier}.", save_note(self.project, title, text))
        output = recall_note(self.project, title, identifier)
        self.assertRegex(output["index"], rf"#{identifier}\b")
        self.assertIn(title, output["timeline"])
        self.assertIn(text, output["details"])
        with sqlite3.connect(Path(os.environ["CLAUDE_MEM_DATA_DIR"]) / "claude-mem.db") as db:
            rows = db.execute("SELECT s.platform_source, o.narrative, s.content_session_id FROM observations o JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE o.project=?", (self.project,)).fetchall()
        self.assertEqual(rows, [("haystack", text, f"manual-content-{self.project}-haystack")])
        with self.assertRaises(PipelineRuntimeError):
            recall_note(self.project + "-other", title, identifier)

        with memory_tools() as tools:
            for number in range(25):
                tools["save_memory"].invoke(project=self.project, title=f"Haystack release decision {number}",
                    text=f"Additional release decision number {number}.", metadata={"platformSource": "haystack"})
        old = recall_note(self.project, title, identifier)
        self.assertNotRegex(old["index"], rf"#{identifier}\b")
        self.assertIn(text, old["details"])

    def test_native_mcp_errors_are_not_successful_notes(self):
        with memory_tools() as tools:
            with self.assertRaises(ToolInvocationError) as error:
                tools["save_memory"].invoke(project=self.project, text="")
            self.assertIsInstance(error.exception.__cause__, MCPInvocationError)
        with self.assertRaises(ValueError):
            save_note("", "Missing project", "Do not save.")

    def test_absolute_bundle_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix="Haystack MCP path ") as directory:
            script = Path(directory) / "memory server.cjs"
            shutil.copyfile(os.environ["CLAUDE_MEM_MCP_SERVER"], script)
            with patch.dict(os.environ, {"CLAUDE_MEM_MCP_SERVER": str(script)}):
                self.assertRegex(save_note(self.project, "Path check", "A local explicit path check."), r"Saved memory #\d+")

    def test_refused_worker_is_reported(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with patch.dict(os.environ, {"CLAUDE_MEM_WORKER_PORT": str(port)}):
            with self.assertRaises(ToolInvocationError) as error:
                save_note(self.project, "Worker unavailable", "No completed acknowledgement.")
            self.assertIsInstance(error.exception.__cause__, MCPInvocationError)

    def test_unresponsive_worker_has_an_invocation_deadline(self):
        with socket.socket() as stalled:
            stalled.bind(("127.0.0.1", 0))
            stalled.listen(5)
            started = time.monotonic()
            with patch.dict(os.environ, {"CLAUDE_MEM_WORKER_PORT": str(stalled.getsockname()[1])}):
                with self.assertRaises(ToolInvocationError) as error:
                    save_note(self.project, "Worker stalled", "No completed acknowledgement.")
                self.assertIsInstance(error.exception.__cause__, TimeoutError)
            self.assertLess(time.monotonic() - started, 22)


if __name__ == "__main__":
    unittest.main()
