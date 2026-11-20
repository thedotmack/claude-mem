"""Native Google ADK + real bundled-worker checks; no model or account needed."""
import asyncio
from contextlib import chdir, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from uuid import uuid4

from memory_workflow import run_workflow

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
        cls.directory = tempfile.TemporaryDirectory(prefix="google-adk memory ")
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
            "CLAUDE_MEM_MCP_SERVER": str(REPO / "plugin/scripts/mcp-server.cjs"),
        })
        cls.output = (cls.data / "worker.log").open("w")
        cls.worker = subprocess.Popen([bun, "-e", 'const {WorkerService}=require("./plugin/scripts/worker-service.cjs"); '
                                      'new WorkerService().start().catch(error => { console.error(error); process.exit(1); });'],
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
            "project": "google-adk-demo", "title": "quokkaharbor scheduler decision",
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

    @contextmanager
    def worktree_scope(self):
        with tempfile.TemporaryDirectory(prefix="scope-parent-", dir=self.data) as directory:
            parent = Path(directory)
            checkout = parent / "topic"
            def git(*args):
                subprocess.run(["git", *args], cwd=parent, env=self.env, check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            git("init", "-q", "--initial-branch=main")
            git("-c", "user.name=Memory scope test", "-c", "user.email=scope@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Fixture")
            git("worktree", "add", "-q", "--detach", str(checkout), "HEAD")
            project = parent.name + "/topic"
            parent_id = self.post("/api/memory/save", {
                "project": parent.name, "title": "scopeboundarytoken parent-only marker",
                "text": "The parent-only marker must stay outside the chosen project.",
            })["id"]
            child_id = self.post("/api/memory/save", {
                "project": project, "title": "scopeboundarytoken child decision",
                "text": "The child checkout uses the scoped decision.",
            })["id"]
            with chdir(checkout):
                yield project, parent_id, child_id

    def state(self):
        return {"project": "google-adk-demo", "query": "quokkaharbor", "observation_id": self.known,
                "note": "Next run: keep the quokkaharbor scheduler export in UTC.", "run_id": "verification-1"}

    def run_memory(self, state=None, env=None, timeout=10):
        with patch.dict(os.environ, env or self.env, clear=True):
            return asyncio.run(run_workflow(state or self.state(), timeout=timeout))

    def run_cli(self, env=None, observation_id=None, timeout=10):
        return subprocess.run([
            sys.executable, str(REPO / "examples/google-adk/memory_workflow.py"),
            "--project", "google-adk-demo", "--query", "quokkaharbor",
            "--observation-id", str(observation_id or self.known),
            "--run-id", "diagnostic-" + uuid4().hex,
            "--note", "diagnostic private marker", "--timeout", str(timeout),
        ], cwd=REPO, env=env or self.env, text=True, capture_output=True, timeout=15)

    def test_recall_save_and_deliberate_repeat(self):
        first = self.run_memory()
        second = self.run_memory()
        self.assertIn("writes dates in UTC", first["recalled"])
        self.assertNotIn("unrelated decision", first["index"])
        self.assertEqual(first["saved_id"], second["saved_id"])
        self.assertEqual(first["adk_session_id"], "verification-1")
        saved = self.post("/api/observations/batch", {"ids": [first["saved_id"]], "project": "google-adk-demo"})
        self.assertEqual(saved[0]["narrative"], self.state()["note"])
        self.assertEqual(self.post("/api/observations/batch", {"ids": [first["saved_id"]], "project": "another-project"}), [])
        with sqlite3.connect(self.data / "claude-mem.db") as db:
            platform, session, adk_session = db.execute(
                "SELECT s.platform_source, s.content_session_id, json_extract(o.metadata, '$.adkSessionId') FROM observations o "
                "JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE o.id=?",
                (first["saved_id"],),
            ).fetchone()
            self.assertEqual(platform, "google-adk")
            self.assertTrue(session.startswith("manual-content-"))
            self.assertEqual(adk_session, first["adk_session_id"])
        print(json.dumps({"native_agent": "passed", "known_id": self.known, "saved_id": first["saved_id"], "repeat_id": second["saved_id"]}))

    def test_foreign_selected_id_cannot_authorize_a_save(self):
        run_id = "foreign-id-" + uuid4().hex
        state = {**self.state(), "observation_id": self.foreign, "run_id": run_id,
                 "note": "This foreign-observation handoff must not be saved: " + run_id}
        with sqlite3.connect(self.data / "claude-mem.db") as db:
            before = db.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
        with self.assertRaisesRegex(RuntimeError, "^The selected observation is absent from this project's search page$"):
            self.run_memory(state)
        with sqlite3.connect(self.data / "claude-mem.db") as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], before)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM observations WHERE narrative=? OR json_extract(metadata, '$.runId')=?",
                (state["note"], run_id),
            ).fetchone()[0], 0)

    def test_cli_explains_expected_failures_without_echoing_notes(self):
        missing_setting = {key: value for key, value in self.env.items() if key != "CLAUDE_MEM_MCP_SERVER"}
        cases = [
            (missing_setting, "CLAUDE_MEM_MCP_SERVER is not set"),
            ({**self.env, "CLAUDE_MEM_MCP_SERVER": str(self.data / "missing-script.cjs")}, "configured MCP script was not found"),
            (self.env, "selected observation is absent from this project's search page"),
        ]
        for env, reason in cases:
            with self.subTest(reason=reason):
                result = self.run_cli(env=env, observation_id=self.foreign)
                self.assertEqual(result.returncode, 1)
                self.assertIn(reason, result.stderr)
                self.assertNotIn("diagnostic private marker", result.stderr)

    def test_worktree_scoped_recall_excludes_parent(self):
        with self.worktree_scope() as (project, _, child_id):
            state = {**self.state(), "project": project, "query": "scopeboundarytoken",
                     "observation_id": child_id, "run_id": "worktree-" + uuid4().hex}
            result = self.run_memory(state)
            self.assertNotIn("parent-only marker", result["index"])
            self.assertNotIn("parent-only marker", result["timeline"])
            self.assertIn("child checkout", result["recalled"])

    def test_worktree_parent_cannot_authorize_a_save(self):
        with self.worktree_scope() as (project, parent_id, _):
            run_id = "worktree-reject-" + uuid4().hex
            state = {**self.state(), "project": project, "query": "scopeboundarytoken",
                     "observation_id": parent_id, "run_id": run_id, "note": "Do not save: " + run_id}
            with sqlite3.connect(self.data / "claude-mem.db") as db:
                before = db.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
            with self.assertRaisesRegex(RuntimeError, "^The selected observation is absent from this project's search page$"):
                self.run_memory(state)
            with sqlite3.connect(self.data / "claude-mem.db") as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], before)
                self.assertEqual(db.execute(
                    "SELECT COUNT(*) FROM observations WHERE narrative=? OR json_extract(metadata, '$.runId')=?",
                    (state["note"], run_id),
                ).fetchone()[0], 0)

    def test_verbatim_project_keys_are_isolated(self):
        for form in ("comma", "outer-space", "json-like"):
            with self.subTest(form=form):
                key = "exact-key-" + uuid4().hex
                project = key + ",other" if form == "comma" else " " + key + " " if form == "outer-space" else json.dumps([key])
                shadows = [key, "other"] if form == "comma" else [key]
                foreign_ids = [self.post("/api/memory/save", {
                    "project": shadow, "title": "exactkeytoken shadow-only marker",
                    "text": "The shadow-only marker belongs to a different project key.",
                })["id"] for shadow in shadows]
                known = self.post("/api/memory/save", {
                    "project": project, "title": "exactkeytoken chosen key decision",
                    "text": "This is the chosen project's exact key.",
                })["id"]
                state = {**self.state(), "project": project, "query": "exactkeytoken",
                         "observation_id": known, "run_id": "exact-" + uuid4().hex}
                result = self.run_memory(state)
                self.assertEqual(result["project"], project)
                self.assertNotIn("shadow-only marker", result["index"])
                self.assertNotIn("shadow-only marker", result["timeline"])
                self.assertNotIn("shadow-only marker", result["recalled"])

    def test_blank_project_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_memory({**self.state(), "project": " "})

    def test_stopped_worker_reports_failure(self):
        with self.assertRaises(Exception):
            self.run_memory(env={**self.env, "CLAUDE_MEM_WORKER_PORT": str(free_port())})

    def test_slow_worker_is_bounded(self):
        requested = []
        release = threading.Event()

        class SlowWorker(BaseHTTPRequestHandler):
            def do_GET(self):
                requested.append(self.path)
                if self.path.startswith("/api/health"):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"status":"ok"}')
                    return
                release.wait(5)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), SlowWorker)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                self.run_memory(env={**self.env, "CLAUDE_MEM_WORKER_PORT": str(server.server_port)}, timeout=1)
            self.assertLess(time.monotonic() - started, 10)
            result = self.run_cli(env={**self.env, "CLAUDE_MEM_WORKER_PORT": str(server.server_port)}, timeout=1)
            self.assertEqual(result.returncode, 1)
            self.assertIn("Memory workflow failed: A memory request or the workflow timed out", result.stderr)
            self.assertNotIn("diagnostic private marker", result.stderr)
            self.assertTrue(any(path.startswith("/api/search") for path in requested))
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main(verbosity=2)
