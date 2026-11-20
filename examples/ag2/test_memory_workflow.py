"""Live SDK checks; run only against a disposable Claude-Mem worker/database."""
import asyncio
from contextlib import asynccontextmanager
import os
from pathlib import Path
import socket
import socketserver
import sqlite3
import subprocess
from uuid import uuid4
import tempfile
import threading
import time
import unittest

from memory_workflow import ProjectMemory, remember


async def call(memory, name, arguments):
    return await memory.call(name, arguments)


@asynccontextmanager
async def client(project, **options):
    memory = ProjectMemory(os.environ["CLAUDE_MEM_MCP_SERVER"], project, **options)
    await memory.discover()
    yield memory


class MemoryIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_literal_comma_and_outer_space_project_keys(self):
        token = uuid4().hex
        for project in (f"api-{token},web-{token}", f" spaced-{token} "):
            with self.subTest(project=project):
                alias = project.split(",")[0].strip()
                async with client(alias) as memory:
                    foreign = await remember(memory, "Alias note", "Unrelated alias project note.")
                async with client(project) as memory:
                    own = await remember(memory, "Literal key note", "Keep the literal project key.")
                    timeline = await call(memory, "timeline", {"anchor": own["id"], "depth_before": 10, "depth_after": 10})
                    details = await call(memory, "get_observations", {"ids": [foreign["id"]]})
                self.assertEqual(own["project"], project)
                self.assertIn("Keep the literal project key.", own["details"])
                with sqlite3.connect(Path(os.environ["CLAUDE_MEM_DATA_DIR"]) / "claude-mem.db") as db:
                    self.assertEqual(db.execute("SELECT project FROM observations WHERE id=?", (own["id"],)).fetchone()[0], project)
                for name, value in [("index", own["index"]), ("timeline", timeline), ("foreign details", details)]:
                    with self.subTest(read=name):
                        self.assertNotIn(f"#{foreign['id']} ", value)
                        self.assertNotIn("Unrelated alias project note.", value)

    async def test_worktree_reads_stay_within_the_explicit_project(self):
        with tempfile.TemporaryDirectory(prefix="ag2 worktree ") as temporary:
            parent = Path(temporary) / ("parent-" + uuid4().hex)
            child = Path(temporary) / "feature"
            subprocess.run(["git", "init", "-q", str(parent)], check=True)
            subprocess.run(["git", "-C", str(parent), "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"], check=True)
            subprocess.run(["git", "-C", str(parent), "worktree", "add", "--detach", "-q", str(child)], check=True)
            project = parent.name + "/feature"
            async with client(parent.name) as memory:
                foreign = await remember(memory, "Parent private note", "Parent-only release decision.")
            original = Path.cwd()
            try:
                os.chdir(child)
                async with client(project) as memory:
                    own = await remember(memory, "Child decision", "Keep the child decision separate.")
                    timeline = await call(memory, "timeline", {"anchor": own["id"], "depth_before": 10, "depth_after": 10})
                    details = await call(memory, "get_observations", {"projects": [parent.name], "ids": [foreign["id"]]})
            finally:
                os.chdir(original)
            self.assertIn("Keep the child decision separate.", own["details"])
            for name, value in [("index", own["index"]), ("timeline", timeline), ("foreign details", details)]:
                with self.subTest(read=name):
                    self.assertNotIn(f"#{foreign['id']} ", value)
                    self.assertNotIn("Parent-only release decision.", value)

    async def test_native_round_trip_replay_and_project_override(self):
        async with client("ag2-project-a") as first:
            saved = await remember(first, "Release decision", "Run the smoke suite before release.")
            repeated = await remember(first, "Release decision", "Run the smoke suite before release.")
            self.assertEqual(saved["id"], repeated["id"])
            self.assertIn("Run the smoke suite before release.", saved["details"])
            async with client("ag2-project-b") as other:
                foreign = await remember(other, "Separate result", "Keep this project independent.")
            self.assertNotEqual(saved["id"], foreign["id"])
            outside = await call(first, "get_observations", {"ids": [foreign["id"]], "project": "ag2-project-b", "projects": ["ag2-project-b"]})
            self.assertEqual(outside, "No selected observations found.")
            index = await call(first, "search", {"query": "", "type": "observations", "project": "ag2-project-b"})
            self.assertIn(f"#{saved['id']} ", index)
            self.assertNotIn(f"#{foreign['id']} ", index)
        with sqlite3.connect(Path(os.environ["CLAUDE_MEM_DATA_DIR"]) / "claude-mem.db") as db:
            platform, session = db.execute("SELECT s.platform_source, s.content_session_id FROM observations o JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE o.id=?", (saved["id"],)).fetchone()
            self.assertEqual(platform, "ag2")
            self.assertTrue(session.startswith("manual-content-"))

    async def test_old_receipt_remains_recallable_after_search_page_moves(self):
        async with client("ag2-history") as memory:
            first = await remember(memory, "Original decision", "Preserve the old decision.")
            for index in range(6):
                await call(memory, "save_memory", {"title": f"Newer decision {index}", "text": f"Unrelated note {index}."})
            repeated = await remember(memory, "Original decision", "Preserve the old decision.")
            self.assertEqual(first["id"], repeated["id"])
            self.assertNotIn(f"#{first['id']} ", repeated["index"])
            self.assertIn("Preserve the old decision.", repeated["details"])

    async def test_real_worker_validation_is_not_success(self):
        async with client("ag2-validation") as memory:
            with self.assertRaisesRegex(RuntimeError, "save_memory failed"):
                await call(memory, "save_memory", {"text": " "})

    async def test_stopped_worker_reports_failure(self):
        with socket.socket() as sock, tempfile.TemporaryDirectory(prefix="ag2 worker down ") as data:
            sock.bind(("127.0.0.1", 0))
            env = dict(os.environ, CLAUDE_MEM_WORKER_HOST="127.0.0.1", CLAUDE_MEM_WORKER_PORT=str(sock.getsockname()[1]), CLAUDE_MEM_DATA_DIR=data)
            async with client("ag2-down", env=env) as memory:
                with self.assertRaisesRegex(RuntimeError, "search failed"):
                    await call(memory, "search", {"query": ""})

    async def test_native_request_has_a_deadline(self):
        stop = threading.Event()
        received = threading.Event()

        class SlowHandler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(8192)
                received.set()
                stop.wait(5)

        class SlowServer(socketserver.ThreadingTCPServer):
            daemon_threads = True

        with SlowServer(("127.0.0.1", 0), SlowHandler) as slow, tempfile.TemporaryDirectory(prefix="ag2 timeout ") as data:
            thread = threading.Thread(target=slow.serve_forever, daemon=True)
            thread.start()
            try:
                env = dict(os.environ, CLAUDE_MEM_WORKER_HOST="127.0.0.1", CLAUDE_MEM_WORKER_PORT=str(slow.server_address[1]), CLAUDE_MEM_DATA_DIR=data)
                async with client("ag2-slow", timeout=1, env=env) as memory:
                    started = time.monotonic()
                    with self.assertRaises((TimeoutError, RuntimeError)):
                        await call(memory, "search", {"query": ""})
                    self.assertTrue(received.is_set(), "The request must reach the local slow-worker fixture")
                    self.assertLess(time.monotonic() - started, 4)
            finally:
                stop.set()
                slow.shutdown()
                thread.join(timeout=2)

    def test_invalid_project_or_deadline(self):
        script = os.environ["CLAUDE_MEM_MCP_SERVER"]
        for timeout in (0, -1, float("nan"), float("inf")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                ProjectMemory(script, "example", timeout=timeout)
        with self.assertRaises(ValueError):
            ProjectMemory(script, " ")


if __name__ == "__main__":
    unittest.main()
