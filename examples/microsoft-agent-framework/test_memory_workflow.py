import asyncio
from contextlib import chdir
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

from agent_framework.exceptions import ToolExecutionException
from memory_workflow import SelectedNote, memory_connection, recall_note, save_note, text_content


class LiveWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for key in ("CLAUDE_MEM_MCP_SERVER", "CLAUDE_MEM_WORKER_PORT", "CLAUDE_MEM_DATA_DIR"):
            self.assertTrue(os.environ.get(key), f"Set {key} for an isolated live worker.")
        self.project = f"ms-agent-test-{uuid.uuid4()}"

    async def test_native_workflow_recall_and_duplicate_save(self):
        title, text = "Framework rollout decision", "Use the amber region for framework staging."
        saved = await save_note(self.project, title, text)
        identifier = int(re.search(r"Saved memory #(\d+)", saved)[1])
        repeated = await save_note(self.project, title, text)
        self.assertIn(f"already saved as #{identifier}.", repeated)
        output = await recall_note(SelectedNote(self.project, title, identifier))
        self.assertIn(title, output["timeline"])
        self.assertIn(text, output["details"])
        with sqlite3.connect(Path(os.environ["CLAUDE_MEM_DATA_DIR"]) / "claude-mem.db") as db:
            rows = db.execute("SELECT s.platform_source, o.narrative, s.content_session_id FROM observations o JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE o.project=?", (self.project,)).fetchall()
        self.assertEqual(rows, [("microsoft-agent-framework", text, f"manual-content-{self.project}-microsoft-agent-framework")])
        with self.assertRaises(ToolExecutionException):
            await recall_note(SelectedNote(self.project + "-other", title, identifier))

        async with memory_connection() as memory:
            for number in range(25):
                await memory.call_tool("save_memory", project=self.project,
                    title=f"Framework rollout decision {number}", text=f"Additional rollout decision number {number}.",
                    metadata={"platformSource": "microsoft-agent-framework"})
        older = await recall_note(SelectedNote(self.project, title, identifier))
        self.assertNotRegex(older["index"], rf"#{identifier}\b")
        self.assertIn(text, older["details"])

    async def test_native_tool_failure_is_not_a_successful_note(self):
        async with memory_connection() as memory:
            with self.assertRaises(ToolExecutionException):
                await memory.call_tool("save_memory", project=self.project, text="")
        with self.assertRaises(ValueError):
            await save_note("", "Invalid project", "Do not save.")

    async def test_script_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix="Framework MCP path ") as directory:
            script = Path(directory) / "memory server.cjs"
            shutil.copyfile(os.environ["CLAUDE_MEM_MCP_SERVER"], script)
            with patch.dict(os.environ, {"CLAUDE_MEM_MCP_SERVER": str(script)}):
                self.assertRegex(await save_note(self.project, "Path check", "A local explicit path check."), r"Saved memory #\d+")

    async def test_worktree_recall_excludes_its_parent_project(self):
        with tempfile.TemporaryDirectory(prefix="Framework worktree ") as directory:
            parent = Path(directory) / self.project
            checkout = Path(directory) / "feature checkout"
            subprocess.run(["git", "init", "-q", str(parent)], check=True)
            subprocess.run(["git", "-C", str(parent), "-c", "user.name=Memory Example",
                            "-c", "user.email=memory-example@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], check=True)
            subprocess.run(["git", "-C", str(parent), "worktree", "add", "-qb", "feature", str(checkout)], check=True)
            selected_project = f"{parent.name}/{checkout.name}"
            parent_note = "This decision belongs only to the parent project."
            title = "Framework inherited rollout"
            with chdir(checkout), patch.dict(os.environ, {"CLAUDE_MEM_PROJECT_NAME_SOURCE": "path", "CLAUDE_MEM_PROJECT_ENVIRONMENTS": "[]"}):
                parent_saved = await save_note(parent.name, title, parent_note)
                parent_id = int(re.search(r"Saved memory #(\d+)", parent_saved)[1])
                saved = await save_note(selected_project, title, "This is the worktree decision.")
                identifier = int(re.search(r"Saved memory #(\d+)", saved)[1])
                output = await recall_note(SelectedNote(selected_project, title, identifier))
                self.assertNotRegex(output["index"], rf"#{parent_id}\b")
                self.assertNotIn(parent_note, output["timeline"])
                self.assertIn("This is the worktree decision.", output["details"])
                async with memory_connection() as memory:
                    foreign_details = text_content(await memory.call_tool(
                        "get_observations", project=selected_project, projects=[selected_project], ids=[parent_id],
                    ))
                self.assertNotIn(parent_note, foreign_details)
                with self.assertRaises(ToolExecutionException):
                    await recall_note(SelectedNote(selected_project, title, parent_id))

    async def test_refused_worker_is_reported(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with patch.dict(os.environ, {"CLAUDE_MEM_WORKER_PORT": str(port)}):
            with self.assertRaises(ToolExecutionException):
                await save_note(self.project, "Worker unavailable", "This must not be acknowledged.")

    async def test_unresponsive_worker_has_a_deadline(self):
        clients = []
        async def accept(reader, writer):
            clients.append(writer)
        server = await asyncio.start_server(accept, "127.0.0.1", 0)
        started = time.monotonic()
        try:
            with patch.dict(os.environ, {"CLAUDE_MEM_WORKER_PORT": str(server.sockets[0].getsockname()[1])}):
                with self.assertRaises((ToolExecutionException, TimeoutError)):
                    await save_note(self.project, "Worker stalled", "No completed acknowledgement.")
            self.assertLess(time.monotonic() - started, 32)
        finally:
            for writer in clients:
                writer.close()
                await writer.wait_closed()
            server.close()
            await server.wait_closed()


class CliDiagnosticsTests(unittest.TestCase):
    def run_failure(self, changes):
        script = Path(__file__).with_name("memory_workflow.py")
        result = subprocess.run(
            [sys.executable, str(script), "save", "diagnostic-project", "private-diagnostic-title", "private-diagnostic-note"],
            env={**os.environ, **changes}, capture_output=True, text=True, timeout=40,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("save may have committed", result.stderr)
        self.assertNotIn("private-diagnostic-title", result.stderr)
        self.assertNotIn("private-diagnostic-note", result.stderr)
        self.assertNotIn("Traceback (most recent call last)", result.stderr)
        return result.stderr

    def test_missing_node_has_a_specific_cli_diagnostic(self):
        with tempfile.TemporaryDirectory(prefix="Framework empty PATH ") as directory:
            stderr = self.run_failure({"PATH": directory})
        self.assertIn("FileNotFoundError", stderr)
        self.assertIn("Node.js executable", stderr)

    def test_invalid_script_has_a_specific_cli_diagnostic(self):
        with tempfile.TemporaryDirectory(prefix="Framework missing script ") as directory:
            stderr = self.run_failure({"CLAUDE_MEM_MCP_SERVER": str(Path(directory) / "missing.cjs")})
        self.assertIn("FileNotFoundError", stderr)
        self.assertIn("MCP server script", stderr)

    def test_refused_worker_retains_the_native_cli_reason(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
            stderr = self.run_failure({"CLAUDE_MEM_WORKER_PORT": str(port)})
        self.assertIn("ToolExecutionException", stderr)
        self.assertIn("worker", stderr.lower())


if __name__ == "__main__":
    unittest.main()
