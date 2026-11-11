"""Live SDK checks. Run against a disposable local worker, never a personal database."""
import asyncio
import os
from pathlib import Path
import socket
import socketserver
import sqlite3
import tempfile
import threading
import time
import unittest

from mcp import MCPError
from mcp_types import REQUEST_TIMEOUT
from memory_workflow import MEMORY_TOOLS, call, memory_server, remember


class MemoryWorkflowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.script = os.environ["CLAUDE_MEM_MCP_SERVER"]

    async def test_real_sdk_round_trip_and_replay(self):
        async with memory_server(self.script) as server:
            self.assertEqual({tool.name for tool in await server.list_tools()}, set(MEMORY_TOOLS))
            first = await remember(server, "openai-example", "SQLite decision", "Use WAL for concurrent readers.")
            repeated = await remember(server, "openai-example", "SQLite decision", "Use WAL for concurrent readers.")
            self.assertEqual(first["id"], repeated["id"])
            self.assertIn(f"#{first['id']} ", first["index"])
            self.assertIn("Use WAL for concurrent readers.", first["details"])
            unrelated = await call(server, "get_observations", {"ids": [first["id"]], "project": "other-project"})
            self.assertEqual(unrelated, "No selected observations found.")
            other = await remember(server, "other-project", "SQLite decision", "Keep this project's independent result.")
            self.assertNotEqual(first["id"], other["id"])
            index = await call(server, "search", {"query": "", "project": "openai-example", "type": "observations"})
            self.assertNotIn(f"#{other['id']} ", index)
        with sqlite3.connect(Path(os.environ["CLAUDE_MEM_DATA_DIR"]) / "claude-mem.db") as db:
            platform, session = db.execute("SELECT s.platform_source, s.content_session_id FROM observations o JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE o.id=?", (first["id"],)).fetchone()
            self.assertEqual(platform, "openai-agents")
            self.assertTrue(session.startswith("manual-content-"))

    async def test_old_replay_uses_its_confirmed_id_after_recent_page_moves(self):
        async with memory_server(self.script) as server:
            first = await remember(server, "openai-history", "Original decision", "Keep the original result.")
            for index in range(25):
                await call(server, "save_memory", {"project": "openai-history", "title": f"Newer decision {index}", "text": f"Unrelated newer note {index}."})
            repeated = await remember(server, "openai-history", "Original decision", "Keep the original result.")
            self.assertEqual(first["id"], repeated["id"])
            self.assertNotIn(f"#{first['id']} ", repeated["index"])
            self.assertIn("Keep the original result.", repeated["details"])

    async def test_invalid_save_is_not_reported_as_success(self):
        async with memory_server(self.script) as server:
            with self.assertRaisesRegex(RuntimeError, "save_memory failed"):
                await call(server, "save_memory", {"project": "openai-example", "text": " "})

    async def test_stopped_worker_reports_failure(self):
        # Bound socket reserves a port without accepting connections.
        with socket.socket() as sock, tempfile.TemporaryDirectory(prefix="openai worker down ") as data:
            sock.bind(("127.0.0.1", 0))
            env = dict(os.environ, CLAUDE_MEM_WORKER_PORT=str(sock.getsockname()[1]), CLAUDE_MEM_DATA_DIR=data)
            async with memory_server(self.script, env=env) as server:
                with self.assertRaisesRegex(RuntimeError, "search failed"):
                    await call(server, "search", {"project": "openai-example"})

    async def test_slow_worker_has_a_request_deadline(self):
        stop = threading.Event()

        class SlowHandler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(8192)
                stop.wait(5)

        class SlowServer(socketserver.ThreadingTCPServer):
            daemon_threads = True

        with SlowServer(("127.0.0.1", 0), SlowHandler) as slow, tempfile.TemporaryDirectory(prefix="openai worker timeout ") as data:
            thread = threading.Thread(target=slow.serve_forever, daemon=True)
            thread.start()
            try:
                env = dict(os.environ, CLAUDE_MEM_WORKER_PORT=str(slow.server_address[1]), CLAUDE_MEM_DATA_DIR=data)
                async with memory_server(self.script, timeout=1, env=env) as server:
                    await server.list_tools()
                    started = time.monotonic()
                    with self.assertRaises(MCPError) as raised:
                        await call(server, "search", {"project": "openai-example"})
                    self.assertEqual(raised.exception.code, REQUEST_TIMEOUT)
                    self.assertLess(time.monotonic() - started, 4)
            finally:
                stop.set()
                slow.shutdown()
                thread.join(timeout=2)

    def test_rejects_unbounded_timeout(self):
        for value in (0, -1, float("inf"), float("nan")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                memory_server(self.script, timeout=value)


if __name__ == "__main__":
    unittest.main()
