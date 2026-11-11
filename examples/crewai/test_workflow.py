"""Native CrewAI + real bundled-worker checks; no model or account needed."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

from memory_workflow import call_memory, memory_client, run_workflow
from crewai.telemetry.telemetry import Telemetry
from crewai.events.event_listener import event_listener

REPO = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bun = shutil.which("bun")
        if not bun:
            raise unittest.SkipTest("Install Bun to run the real bundled worker")
        cls.directory = tempfile.TemporaryDirectory(prefix="crewai memory ")
        cls.data = Path(cls.directory.name)
        cls.port = free_port()
        settings = {
            "CLAUDE_MEM_WORKER_PORT": str(cls.port),
            "CLAUDE_MEM_WORKER_HOST": "127.0.0.1",
            "CLAUDE_MEM_WORKER_AUTOSTART": "false",
            "CLAUDE_MEM_RUNTIME": "worker",
            "CLAUDE_MEM_CHROMA_ENABLED": "false",
            "CLAUDE_MEM_TRANSCRIPTS_ENABLED": "false",
            "CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH": "false",
            "CLAUDE_MEM_AUTO_UPDATE": "false",
            "CLAUDE_MEM_MEDIA_CAPTURE_ENABLED": "false",
            "CLAUDE_MEM_WORKER_IDLE_EXIT_SECONDS": "0",
            "CLAUDE_MEM_CLOUD_SYNC_HUB_URL": "",
            "CLAUDE_MEM_MEMORY_WATCH_ROOTS": "",
        }
        (cls.data / "settings.json").write_text(json.dumps(settings))
        cls.env = {key: os.environ[key] for key in ("PATH", "LANG", "TMPDIR", "SystemRoot") if key in os.environ}
        cls.env.update(settings)
        cls.env.update({
            "CLAUDE_MEM_DATA_DIR": str(cls.data),
            "CLAUDE_CONFIG_DIR": str(cls.data / "claude-config"),
            "XDG_CONFIG_HOME": str(cls.data / "config"),
            "CLAUDE_MEM_TELEMETRY": "false", "DO_NOT_TRACK": "1",
            "OTEL_SDK_DISABLED": "true", "CREWAI_TRACING_ENABLED": "false",
            "CLAUDE_MEM_MCP_SERVER": str(REPO / "plugin/scripts/mcp-server.cjs"),
        })
        cls.output = (cls.data / "worker.log").open("w")
        cls.worker = subprocess.Popen([bun, str(REPO / "plugin/scripts/worker-service.cjs"), "--daemon"],
                                      cwd=REPO, env=cls.env, stdout=cls.output, stderr=cls.output)
        cls.addClassCleanup(cls.cleanup)
        deadline = time.monotonic() + 45
        while True:
            if cls.worker.poll() is not None:
                raise RuntimeError("Worker exited before becoming ready")
            try:
                with urlopen(f"http://127.0.0.1:{cls.port}/api/readiness", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError("Worker did not become ready")
                time.sleep(0.1)
        cls.known = cls.post("/api/memory/save", {
            "project": "crewai-demo", "title": "quokkaharbor scheduler decision",
            "text": "The quokkaharbor scheduler writes dates in UTC.",
        })["id"]
        cls.foreign = cls.post("/api/memory/save", {
            "project": "another-project", "title": "quokkaharbor unrelated decision",
            "text": "The other quokkaharbor project uses a different schedule.",
        })["id"]

    @classmethod
    def cleanup(cls):
        cls.worker.terminate()
        try:
            cls.worker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.worker.kill()
            cls.worker.wait()
        cls.output.close()
        cls.directory.cleanup()

    @classmethod
    def post(cls, route, payload):
        request = Request(f"http://127.0.0.1:{cls.port}" + route,
                          data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def state(self):
        return {"project": "crewai-demo", "note": "Keep the quokkaharbor scheduler export in UTC.",
                "run_id": "verification-1"}

    def run_memory(self, state=None, env=None, timeout=10):
        with patch.dict(os.environ, env or self.env, clear=True):
            return asyncio.run(run_workflow(state or self.state(), timeout=timeout))

    def test_save_recall_and_repeat_beyond_recent_index(self):
        first = self.run_memory()
        for index in range(25):
            self.post("/api/memory/save", {"project": "crewai-demo", "text": f"Later scheduler note {index}"})
        second = self.run_memory()
        self.assertIn(self.state()["note"], first["recalled"])
        self.assertNotIn("unrelated decision", first["index"])
        self.assertEqual(first["saved_id"], second["saved_id"])
        self.assertIn(self.state()["note"], second["recalled"])
        self.assertNotRegex(second["index"], rf"\|\s*#{first['saved_id']}\s*\|")
        saved = self.post("/api/observations/batch", {"ids": [first["saved_id"]], "project": "crewai-demo"})
        self.assertEqual(saved[0]["narrative"], self.state()["note"])
        self.assertEqual(self.post("/api/observations/batch", {"ids": [first["saved_id"]], "project": "another-project"}), [])
        with sqlite3.connect(self.data / "claude-mem.db") as db:
            platform, session, flow_id = db.execute(
                "SELECT s.platform_source, s.content_session_id, json_extract(o.metadata, '$.crewaiFlowId') FROM observations o "
                "JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE o.id=?",
                (first["saved_id"],),
            ).fetchone()
            self.assertEqual(platform, "crewai")
            self.assertTrue(session.startswith("manual-content-"))
            self.assertEqual(flow_id, first["flow_id"])
        print(json.dumps({"native_flow": "passed", "saved_id": first["saved_id"], "repeat_id": second["saved_id"],
                          "flow_id": first["flow_id"], "newer_notes_before_repeat": 25}))

    def test_foreign_project_id_is_not_recalled(self):
        async def read_foreign():
            async with memory_client() as client:
                return await call_memory(client, "crewai-demo", "get_observations", ids=[self.foreign])
        with patch.dict(os.environ, self.env, clear=True):
            result = asyncio.run(read_foreign())
        self.assertNotIn("unrelated decision", result)
        self.assertNotRegex(result, rf"^#{self.foreign}\s+—")

    def test_native_tool_error_is_not_a_successful_save(self):
        async def rejected_save():
            async with memory_client() as client:
                return await call_memory(client, "crewai-demo", "save_memory", text=" ")
        with patch.dict(os.environ, self.env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "failed save_memory"):
                asyncio.run(rejected_save())

    def test_blank_project_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_memory({**self.state(), "project": " "})

    def test_stopped_worker_reports_failure(self):
        with self.assertRaises(Exception):
            self.run_memory(env={**self.env, "CLAUDE_MEM_WORKER_PORT": str(free_port())})

    def test_slow_save_is_bounded_and_not_retried(self):
        requested = []
        release = threading.Event()

        class SlowWorker(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

            def do_POST(self):
                requested.append(self.path)
                release.wait(5)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), SlowWorker)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        started = time.monotonic()
        try:
            with self.assertRaises(Exception):
                self.run_memory(env={**self.env, "CLAUDE_MEM_WORKER_PORT": str(server.server_port)}, timeout=1)
            self.assertLess(time.monotonic() - started, 10)
            self.assertEqual(requested, ["/api/memory/save"])
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_native_telemetry_is_disabled_before_import(self):
        self.assertTrue(Telemetry._is_telemetry_disabled())
        self.assertFalse(Telemetry().ready)
        self.assertEqual(os.environ["CREWAI_TRACING_ENABLED"], "false")
        self.assertFalse(event_listener.formatter.verbose)


if __name__ == "__main__":
    unittest.main(verbosity=2)

