"""Unit tests for the Hermes memory provider (hermes/claude-mem).

Hermes itself is not needed: a stand-in for `agent.memory_provider` carries the
same abstract base as Hermes, and a local HTTP server stands in for claude-mem.

Run: python3 -m unittest discover -s tests/hermes -v
"""

import abc
import importlib
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def install_hermes_stub():
    """The parts of Hermes the provider imports, with Hermes's abstract members."""

    class MemoryProvider(abc.ABC):
        @property
        @abc.abstractmethod
        def name(self):
            ...

        @abc.abstractmethod
        def is_available(self):
            ...

        @abc.abstractmethod
        def initialize(self, session_id, **kwargs):
            ...

        @abc.abstractmethod
        def get_tool_schemas(self):
            ...

    agent = types.ModuleType("agent")
    agent.__path__ = []
    memory_provider = types.ModuleType("agent.memory_provider")
    memory_provider.MemoryProvider = MemoryProvider
    agent.memory_provider = memory_provider
    sys.modules["agent"] = agent
    sys.modules["agent.memory_provider"] = memory_provider


install_hermes_stub()
sys.path.insert(0, os.path.join(REPO, "hermes"))
spec = importlib.util.spec_from_file_location(
    "claude_mem", os.path.join(REPO, "hermes", "claude-mem", "__init__.py"),
    submodule_search_locations=[os.path.join(REPO, "hermes", "claude-mem")])
claude_mem = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = claude_mem
spec.loader.exec_module(claude_mem)
client_module = importlib.import_module("claude_mem.client")


class FakeClaudeMem:
    """Records every request; `replies` maps a path prefix to (status, body)."""

    def __init__(self):
        self.requests = []
        self.replies = {}
        self.delay = 0.0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _handle(self):
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                owner.requests.append({
                    "method": self.command, "path": self.path, "body": body,
                    "authorization": self.headers.get("authorization"),
                })
                if owner.delay:
                    time.sleep(owner.delay)
                status, reply = 200, {}
                for prefix, answer in owner.replies.items():
                    if self.path.startswith(prefix):
                        status, reply = answer
                payload = reply.encode() if isinstance(reply, str) else json.dumps(reply).encode()
                try:
                    self.send_response(status)
                    self.send_header("content-type", "text/plain" if isinstance(reply, str) else "application/json")
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass  # the client gave up first (the hung-worker test)

            do_GET = _handle
            do_POST = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def paths(self):
        return [r["path"].split("?")[0] for r in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ProviderTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeClaudeMem()
        self.addCleanup(self.fake.close)
        self.cwd = tempfile.mkdtemp(prefix="hermes-project-")
        self.client = client_module.ClaudeMemClient(client_module.Config(self.fake.base))
        self.provider = claude_mem.ClaudeMemMemoryProvider(client=self.client)
        self.provider.initialize("sess-1", platform="cli", hermes_home="/tmp/h", cwd=self.cwd)
        self.addCleanup(self.provider.shutdown)

    def drain(self):
        self.assertTrue(self.client.flush(5.0), "queued writes did not finish")

    def test_a_turn_is_recorded_in_order(self):
        self.provider.on_turn_start(1, "Fix the failing login test")
        self.provider.record_tool_call("terminal", {"command": "npm test"}, {"exit": 1}, "sess-1", "call-7")
        self.provider.sync_turn("Fix the failing login test", "Fixed it", session_id="sess-1")
        self.provider.on_session_end([{"role": "user", "content": "x"},
                                      {"role": "assistant", "content": [{"type": "text", "text": "All green"}]}])
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init", "/api/sessions/observations", "/api/sessions/summarize"])
        init, observation, summary = (r["body"] for r in self.fake.requests)
        self.assertEqual(init, {"contentSessionId": "sess-1", "prompt": "Fix the failing login test",
                                "platformSource": "hermes", "cwd": self.cwd})
        self.assertEqual(observation["tool_name"], "terminal")
        self.assertEqual(observation["tool_input"], {"command": "npm test"})
        self.assertEqual(observation["tool_response"], '{"exit": 1}')
        self.assertEqual(observation["tool_use_id"], "call-7")
        self.assertEqual(observation["platformSource"], "hermes")
        self.assertEqual(observation["cwd"], self.cwd)
        self.assertEqual(summary["last_assistant_message"], "All green")
        self.assertEqual(summary["contentSessionId"], "sess-1")

    def test_a_private_last_turn_sends_no_summary_after_a_public_turn(self):
        self.provider.on_turn_start(1, "Fix the failing login test")
        self.provider.on_turn_start(2, "<private>rotate the prod key sk-live-123</private>")
        self.provider.on_session_end([{"role": "assistant", "content": "Rotated sk-live-123"}])
        self.drain()
        # The public first turn is recorded; the private last turn's reply never
        # leaves Hermes, so no summarize request carries it.
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])
        self.assertNotIn("sk-live-123", json.dumps([r["body"] for r in self.fake.requests]))

    def test_a_long_tool_result_is_capped(self):
        self.provider.on_turn_start(1, "read the log")
        self.provider.record_tool_call("read_file", {"path": "a.log"}, "x" * 5000, "sess-1")
        self.drain()
        self.assertEqual(len(self.fake.requests[1]["body"]["tool_response"]), 1000)

    def test_memory_tools_and_child_agents_are_not_recorded(self):
        self.provider.on_turn_start(1, "remember this")
        for name in ("memory", "memory_search", "mem_search", "mcp_claude_mem_search", "mcp_claude-mem_search", ""):
            self.provider.record_tool_call(name, {}, "r", "sess-1")
        self.provider.record_tool_call("terminal", {}, "r", "child-session")
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])

    def test_an_excluded_project_sends_nothing_more(self):
        self.fake.replies["/api/sessions/init"] = (200, {"skipped": True, "reason": "project_excluded"})
        self.provider.on_turn_start(1, "secret work")
        self.provider.record_tool_call("terminal", {}, "r", "sess-1")
        self.provider.on_memory_write("add", "memory", "a fact")
        self.provider.on_turn_start(2, "more secret work")
        self.provider.on_session_end([])
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])

    def test_tool_calls_after_a_failed_prompt_are_dropped(self):
        self.fake.replies["/api/sessions/init"] = (500, {"error": "boom"})
        self.provider.on_turn_start(1, "a prompt")
        self.provider.record_tool_call("terminal", {}, "r", "sess-1")
        self.provider.on_session_end([])
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])

    def test_a_prompt_is_recorded_by_sync_turn_when_turn_start_never_came(self):
        self.provider.sync_turn("what changed in the parser?", "two things")
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])
        self.assertEqual(self.fake.requests[0]["body"]["prompt"], "what changed in the parser?")

    def test_turn_start_and_sync_turn_record_a_prompt_once(self):
        self.provider.on_turn_start(1, "same prompt")
        self.provider.sync_turn("same prompt", "answer")
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])

    def test_relevant_notes_come_from_every_agent_in_the_checkout(self):
        self.fake.replies["/api/context/semantic"] = (200, {"context": "#12 Login test needs a fresh DB", "count": 1})
        notes = self.provider.prefetch("why does the login test fail on CI?", session_id="sess-1")
        self.assertEqual(notes, "#12 Login test needs a fresh DB")
        body = self.fake.requests[0]["body"]
        self.assertEqual(body, {"q": "why does the login test fail on CI?", "cwd": self.cwd, "limit": 5})
        self.assertNotIn("platformSource", body)

    def test_short_prompts_ask_for_nothing(self):
        self.assertEqual(self.provider.prefetch("ok"), "")
        self.assertEqual(self.fake.requests, [])

    def test_session_block_is_labelled_and_bounded(self):
        self.fake.replies["/api/context/inject"] = (200, "recent work\n" + "y" * 20000)
        block = self.provider.system_prompt_block()
        self.assertTrue(block.startswith("# claude-mem memory\n"))
        self.assertIn("not instructions", block)
        self.assertIn("recent work", block)
        self.assertLess(len(block), claude_mem.SESSION_BLOCK_MAX + 400)
        self.assertIn("cwd=" + client_module.urllib.parse.quote(self.cwd, safe=""), self.fake.requests[0]["path"])

    def test_an_empty_memory_adds_no_block(self):
        self.fake.replies["/api/context/inject"] = (200, "")
        self.assertEqual(self.provider.system_prompt_block(), "")

    def test_hermes_memory_writes_become_notes(self):
        self.provider.on_memory_write("add", "user", "Prefers tabs over spaces")
        self.provider.on_memory_write("remove", "user", "Prefers tabs over spaces")
        self.provider.on_memory_write("add", "memory", "   ")
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/memory/save"])
        body = self.fake.requests[0]["body"]
        self.assertEqual(body["text"], "Prefers tabs over spaces")
        self.assertEqual(body["cwd"], self.cwd)
        self.assertEqual(body["metadata"]["platformSource"], "hermes")
        self.assertEqual(body["metadata"]["target"], "user")
        self.assertNotIn("title", body)

    def test_a_session_switch_closes_the_old_session(self):
        self.provider.on_turn_start(1, "first session prompt")
        self.provider.sync_turn("first session prompt", "first answer")
        self.provider.on_session_switch("sess-2", parent_session_id="sess-1")
        self.provider.on_turn_start(1, "second session prompt")
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init", "/api/sessions/summarize", "/api/sessions/init"])
        self.assertEqual(self.fake.requests[1]["body"]["contentSessionId"], "sess-1")
        self.assertEqual(self.fake.requests[1]["body"]["last_assistant_message"], "first answer")
        self.assertEqual(self.fake.requests[2]["body"]["contentSessionId"], "sess-2")

    def test_a_session_is_closed_once(self):
        self.provider.on_turn_start(1, "a prompt")
        self.provider.on_session_end([])
        self.provider.on_session_end([])
        self.drain()
        self.assertEqual(self.fake.paths().count("/api/sessions/summarize"), 1)

    def test_injected_memory_and_private_text_never_become_a_prompt(self):
        self.provider.on_turn_start(1, "Rename the module <private>token abc123</private>\n"
                                       "<memory-context>[System note: recalled]\n#12 old note</memory-context>")
        self.provider.on_turn_start(2, "<memory-context>only recalled notes</memory-context>")
        self.provider.on_memory_write("add", "memory", "<private>secret</private>")
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])
        self.assertEqual(self.fake.requests[0]["body"]["prompt"], "Rename the module")

    def test_nested_and_unclosed_private_sections_are_removed_whole(self):
        self.provider.on_turn_start(1, "keep <private>outer <private>inner</private>secret</private> this")
        self.provider.record_tool_call("terminal", {"env": "<private>TOKEN</private>"},
                                       "start <private>" + "z" * 2000 + "</private> end", "sess-1")
        self.drain()
        self.assertEqual(self.fake.requests[0]["body"]["prompt"], "keep  this")
        self.assertEqual(self.fake.requests[1]["body"]["tool_input"], {"env": ""})
        self.assertEqual(self.fake.requests[1]["body"]["tool_response"], "start  end")

    def test_tools_of_a_wholly_private_prompt_are_not_recorded(self):
        self.provider.on_turn_start(1, "a public prompt")
        self.provider.on_turn_start(2, "<private>all of it</private>")
        self.provider.record_tool_call("terminal", {}, "r", "sess-1")
        self.drain()
        self.assertEqual(self.fake.paths(), ["/api/sessions/init"])

    def test_an_excluded_checkout_never_leaves_hermes(self):
        config = client_module.Config(self.fake.base, excluded_projects="other, " + os.path.basename(self.cwd))
        client = client_module.ClaudeMemClient(config)
        provider = claude_mem.ClaudeMemMemoryProvider(client=client)
        provider.initialize("sess-x", cwd=self.cwd)
        self.assertEqual(provider.system_prompt_block(), "")
        self.assertEqual(provider.prefetch("a prompt that is long enough to search"), "")
        provider.on_turn_start(1, "work")
        provider.record_tool_call("terminal", {}, "r", "sess-x")
        provider.on_memory_write("add", "memory", "note")
        provider.on_session_end([])
        self.assertTrue(client.flush(5.0))
        self.assertEqual(self.fake.requests, [])
        provider.shutdown()

    def test_overlapping_sections_are_removed_together(self):
        self.provider.on_turn_start(1, "run it")
        self.provider.record_tool_call("terminal", {}, "<system-reminder><private>a</system-reminder>SECRET</private>ok",
                                       "sess-1")
        self.drain()
        self.assertEqual(self.fake.requests[1]["body"]["tool_response"], "ok")

    def test_a_late_sync_of_the_previous_turn_records_no_prompt(self):
        self.provider.on_turn_start(1, "first prompt")
        self.provider.on_turn_start(2, "second prompt")
        self.provider.sync_turn("first prompt", "first answer")
        self.provider.sync_turn("second prompt", "second answer")
        self.drain()
        self.assertEqual([r["body"]["prompt"] for r in self.fake.requests], ["first prompt", "second prompt"])

    def test_scheduled_agents_recall_but_record_nothing(self):
        self.fake.replies["/api/context/semantic"] = (200, {"context": "#4 cron note", "count": 1})
        client = client_module.ClaudeMemClient(client_module.Config(self.fake.base))
        provider = claude_mem.ClaudeMemMemoryProvider(client=client)
        provider.initialize("cron-1", cwd=self.cwd, agent_context="cron")
        self.assertEqual(provider.prefetch("a prompt that is long enough to search"), "#4 cron note")
        provider.on_turn_start(1, "nightly job")
        provider.record_tool_call("terminal", {}, "r", "cron-1")
        claude_mem._on_post_tool_call(tool_name="terminal", args={}, result="r", session_id="cron-1")
        provider.on_memory_write("add", "memory", "note")
        provider.sync_turn("nightly job", "done")
        provider.on_session_end([])
        self.assertTrue(client.flush(5.0))
        self.assertEqual(self.fake.paths(), ["/api/context/semantic"])
        provider.shutdown()

    def test_runtime_cwd_wins_when_hermes_has_it(self):
        other = tempfile.mkdtemp(prefix="hermes-runtime-")
        runtime = types.ModuleType("agent.runtime_cwd")
        runtime.resolve_agent_cwd = lambda: other
        sys.modules["agent.runtime_cwd"] = runtime
        self.addCleanup(sys.modules.pop, "agent.runtime_cwd", None)
        self.provider.on_turn_start(1, "a prompt")
        self.drain()
        self.assertEqual(self.fake.requests[0]["body"]["cwd"], other)


class FailSoftTest(unittest.TestCase):
    def test_a_stopped_worker_never_raises_and_never_stalls(self):
        config = client_module.Config("http://127.0.0.1:%d" % unused_port())
        client = client_module.ClaudeMemClient(config)
        provider = claude_mem.ClaudeMemMemoryProvider(client=client)
        provider.initialize("sess-down")
        self.addCleanup(provider.shutdown)
        # A refused TCP connection takes about two seconds on Windows. Bound
        # each read independently, rather than their sum plus a queued write.
        for read in (provider.system_prompt_block,
                     lambda: provider.prefetch("a prompt that is long enough to search")):
            started = time.monotonic()
            self.assertEqual(read(), "")
            self.assertLess(time.monotonic() - started, client_module.READ_TIMEOUT_S + 1.5)
        started = time.monotonic()
        provider.on_turn_start(1, "prompt")
        provider.record_tool_call("terminal", {}, "r", "sess-down")
        provider.on_memory_write("add", "memory", "note")
        provider.on_session_end([])
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(client.flush(client_module.WRITE_TIMEOUT_S + 1.5))
        # Three failures open the breaker: the next call does not touch the network.
        self.assertTrue(client.transport.breaker.open())
        started = time.monotonic()
        self.assertEqual(provider.system_prompt_block(), "")
        self.assertLess(time.monotonic() - started, 0.5)

    def test_a_hung_worker_costs_a_read_at_most_the_read_timeout(self):
        fake = FakeClaudeMem()
        self.addCleanup(fake.close)
        fake.delay = client_module.READ_TIMEOUT_S + 2
        provider = claude_mem.ClaudeMemMemoryProvider(client=client_module.ClaudeMemClient(client_module.Config(fake.base)))
        provider.initialize("sess-slow")
        started = time.monotonic()
        self.assertEqual(provider.prefetch("a prompt that is long enough to search"), "")
        self.assertLess(time.monotonic() - started, client_module.READ_TIMEOUT_S + 1.5)
        provider.shutdown()


class RegisterTest(unittest.TestCase):
    def test_register_adds_the_provider_and_a_post_tool_call_hook(self):
        fake = FakeClaudeMem()
        self.addCleanup(fake.close)
        registered = {"providers": [], "hooks": []}
        ctx = types.SimpleNamespace(
            register_memory_provider=registered["providers"].append,
            register_hook=lambda name, fn: registered["hooks"].append((name, fn)),
        )
        claude_mem.register(ctx)
        self.assertEqual(len(registered["providers"]), 1)
        self.assertEqual(registered["providers"][0].name, "claude-mem")
        self.assertEqual([name for name, _ in registered["hooks"]], ["post_tool_call"])
        hook = registered["hooks"][0][1]

        # Before initialize (Hermes's discovery probes call register too), the hook does nothing.
        hook(tool_name="terminal", args={}, result="r", session_id="s")
        provider = claude_mem.ClaudeMemMemoryProvider(client=client_module.ClaudeMemClient(client_module.Config(fake.base)))
        provider.initialize("s")
        provider.on_turn_start(1, "run it")
        hook(tool_name="terminal", args={"command": "ls"}, result="a b", session_id="s", tool_call_id="t1",
             task_id="x", turn_id="y", duration_ms=3, status="ok")
        provider._client.flush(5.0)
        self.assertEqual([r["path"] for r in fake.requests], ["/api/sessions/init", "/api/sessions/observations"])
        provider.shutdown()
        hook(tool_name="terminal", args={}, result="r", session_id="s")
        time.sleep(0.1)
        self.assertEqual(len(fake.requests), 2)

    def test_tool_calls_reach_the_provider_of_their_own_session(self):
        fake = FakeClaudeMem()
        self.addCleanup(fake.close)
        hooks = []
        claude_mem.register(types.SimpleNamespace(register_memory_provider=lambda p: None,
                                                register_hook=lambda name, fn: hooks.append(fn)))
        hook = hooks[0]
        # Each provider owns its client, as it does when Hermes creates it.
        first_client = client_module.ClaudeMemClient(client_module.Config(fake.base))
        second_client = client_module.ClaudeMemClient(client_module.Config(fake.base))
        first = claude_mem.ClaudeMemMemoryProvider(client=first_client)
        second = claude_mem.ClaudeMemMemoryProvider(client=second_client)
        first.initialize("gateway-a")
        second.initialize("gateway-b")
        first.on_turn_start(1, "prompt for session a")
        second.on_turn_start(1, "prompt for session b")
        hook(tool_name="terminal", args={}, result="from a", session_id="gateway-a")
        hook(tool_name="terminal", args={}, result="from b", session_id="gateway-b")
        hook(tool_name="terminal", args={}, result="from a child", session_id="child-of-a")
        self.assertTrue(first_client.flush(5.0))
        second.shutdown()
        hook(tool_name="terminal", args={}, result="a again", session_id="gateway-a")
        hook(tool_name="terminal", args={}, result="b after shutdown", session_id="gateway-b")
        first.on_session_switch("gateway-a2")
        first.on_turn_start(1, "prompt after switch")
        hook(tool_name="terminal", args={}, result="a2", session_id="gateway-a2")
        self.assertTrue(first_client.flush(5.0))
        tools = [(r["body"]["contentSessionId"], r["body"]["tool_response"])
                 for r in fake.requests if r["path"] == "/api/sessions/observations"]
        # The two providers send on their own threads, so only the order
        # within one provider is fixed.
        self.assertEqual(sorted(tools), sorted([("gateway-a", "from a"), ("gateway-b", "from b"),
                                                ("gateway-a", "a again"), ("gateway-a2", "a2")]))
        first_order = [t for t in tools if t[0].startswith("gateway-a")]
        self.assertEqual(first_order, [("gateway-a", "from a"), ("gateway-a", "a again"), ("gateway-a2", "a2")])
        first.shutdown()

    def test_a_ctx_without_hooks_still_registers_the_provider(self):
        providers = []
        claude_mem.register(types.SimpleNamespace(register_memory_provider=providers.append))
        self.assertEqual(len(providers), 1)


class SettingsTest(unittest.TestCase):
    def write_settings(self, doc, bom=False):
        directory = tempfile.mkdtemp(prefix="claude_mem-data-")
        with open(os.path.join(directory, "settings.json"), "w", encoding="utf-8-sig" if bom else "utf-8") as handle:
            json.dump(doc, handle)
        return directory

    def test_worker_address_from_nested_settings_with_a_bom(self):
        directory = self.write_settings({"env": {"CLAUDE_MEM_WORKER_PORT": "39123"}}, bom=True)
        config = client_module.Config.resolve({"CLAUDE_MEM_DATA_DIR": directory})
        self.assertEqual(config.worker_base, "http://127.0.0.1:39123")
        self.assertFalse(config.server)

    def test_environment_wins_over_settings(self):
        directory = self.write_settings({"CLAUDE_MEM_WORKER_PORT": "39123", "CLAUDE_MEM_WORKER_HOST": "::1"})
        config = client_module.Config.resolve({"CLAUDE_MEM_DATA_DIR": directory, "CLAUDE_MEM_WORKER_PORT": "39999"})
        self.assertEqual(config.worker_base, "http://[::1]:39999")

    def test_default_port_follows_the_uid(self):
        directory = self.write_settings({})
        config = client_module.Config.resolve({"CLAUDE_MEM_DATA_DIR": directory})
        self.assertEqual(config.worker_base, "http://127.0.0.1:" + str(37700 + (os.getuid() if hasattr(os, "getuid") else 77) % 100))

    def test_server_needs_all_three_settings(self):
        partial = self.write_settings({"CLAUDE_MEM_RUNTIME": "server", "CLAUDE_MEM_SERVER_URL": "https://m.example",
                                       "CLAUDE_MEM_SERVER_API_KEY": "k"})
        self.assertFalse(client_module.Config.resolve({"CLAUDE_MEM_DATA_DIR": partial}).server)
        full = self.write_settings({"CLAUDE_MEM_RUNTIME": "server-beta", "CLAUDE_MEM_SERVER_BETA_URL": "https://m.example/",
                                    "CLAUDE_MEM_SERVER_API_KEY": "k", "CLAUDE_MEM_SERVER_PROJECT_ID": "p"})
        config = client_module.Config.resolve({"CLAUDE_MEM_DATA_DIR": full})
        self.assertTrue(config.server)
        self.assertEqual(config.server_url, "https://m.example")

    def test_a_missing_or_broken_settings_file_means_defaults(self):
        directory = tempfile.mkdtemp(prefix="claude_mem-data-")
        with open(os.path.join(directory, "settings.json"), "w") as handle:
            handle.write("{not json")
        self.assertEqual(client_module.load_settings({"CLAUDE_MEM_DATA_DIR": directory}), {})


class CheckoutProjectTest(unittest.TestCase):
    def git(self, *args):
        import subprocess
        subprocess.run(["git", *args], check=True, capture_output=True)

    def test_keys_match_the_claude_code_hooks_in_path_mode(self):
        root = tempfile.mkdtemp(prefix="hermes-keys-")
        repo = os.path.join(root, "shop-api")
        os.makedirs(os.path.join(repo, "src"))
        self.git("init", "-q", repo)
        self.git("-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q",
                 "--allow-empty", "-m", "init")
        self.assertEqual(client_module.checkout_project(os.path.join(repo, "src")), "shop-api")
        tree = os.path.join(root, "fix-prices")
        self.git("-C", repo, "worktree", "add", "-q", tree)
        self.assertEqual(client_module.checkout_project(tree), "shop-api/fix-prices")
        plain = os.path.join(root, "notes")
        os.makedirs(plain)
        self.assertEqual(client_module.checkout_project(plain), "notes")


class RecallPrivacyTest(unittest.TestCase):
    def test_protected_sections_never_leave_either_recall_runtime(self):
        fake = FakeClaudeMem()
        self.addCleanup(fake.close)
        for server in (False, True):
            config = client_module.Config(fake.base, fake.base, "key", "project") if server else client_module.Config(fake.base)
            client = client_module.ClaudeMemClient(config)
            self.addCleanup(client.close)
            path = "/v1/context" if server else "/api/context/semantic"
            fake.replies[path] = (200, {"context": "recalled note"})
            for tag in ("private", "memory-context", "claude-mem-context", "system_instruction",
                        "system-instruction", "persisted-output", "system-reminder"):
                with self.subTest(server=server, tag=tag):
                    fake.requests.clear()
                    query = "Investigate parser failures <%s>confidentialtoken</%s>" % (tag, tag)
                    self.assertEqual(client.relevant_notes(REPO, query), "recalled note")
                    self.assertEqual(fake.paths(), [path])
                    body = fake.requests[0]["body"]
                    self.assertNotIn("confidentialtoken", json.dumps(body))
                    self.assertEqual(body["query" if server else "q"],
                                     "investigate or parser or failures" if server else "Investigate parser failures")

    def test_private_or_short_public_prompts_make_no_recall_request(self):
        fake = FakeClaudeMem()
        self.addCleanup(fake.close)
        for server in (False, True):
            config = client_module.Config(fake.base, fake.base, "key", "project") if server else client_module.Config(fake.base)
            client = client_module.ClaudeMemClient(config)
            self.addCleanup(client.close)
            for query in ("<private>confidential parser details</private>",
                          "  <memory-context>previously recalled details</memory-context>  ",
                          "<private>outer <private>inner</private> secret</private>",
                          "<private>unclosed confidential details",
                          "parser <private>confidential parser details</private>"):
                with self.subTest(server=server, query=query):
                    fake.requests.clear()
                    self.assertEqual(client.relevant_notes(REPO, query), "")
                    self.assertEqual(fake.requests, [])


class ServerModeTest(unittest.TestCase):
    def test_events_go_to_the_hosted_server_with_the_key(self):
        fake = FakeClaudeMem()
        self.addCleanup(fake.close)
        fake.replies["/v1/sessions/start"] = (200, {"session": {"id": "srv-1"}})
        fake.replies["/v1/context"] = (200, {"context": "#3 hosted note", "observations": []})
        config = client_module.Config("http://127.0.0.1:1", fake.base, "key-1", "proj-1", skip_tools="Todo, clarify")
        client = client_module.ClaudeMemClient(config)
        provider = claude_mem.ClaudeMemMemoryProvider(client=client)
        provider.initialize("sess-s", cwd="/work/app")
        provider.on_turn_start(1, "deploy the app")
        provider.record_tool_call("terminal", {"command": "make deploy <private>TOKEN=xyz</private>"}, "done", "sess-s")
        provider.record_tool_call("todo", {}, "skipped by CLAUDE_MEM_SKIP_TOOLS", "sess-s")
        provider.on_memory_write("add", "memory", "Deploys need VPN")
        provider.on_session_end([{"role": "assistant", "content": "Deployed"}])
        self.assertTrue(client.flush(5.0))
        self.assertEqual(fake.paths(), ["/v1/sessions/start", "/v1/events", "/v1/events", "/v1/memories",
                                        "/v1/sessions/start", "/v1/events", "/v1/sessions/srv-1/end"])
        self.assertTrue(all(r["authorization"] == "Bearer key-1" for r in fake.requests))
        start, prompt, tool, note, _, last, _ = (r["body"] for r in fake.requests)
        self.assertEqual(start["projectId"], "proj-1")
        self.assertEqual(start["metadata"]["prompt"], "deploy the app")
        # Every prompt is its own event; it does not start a generation by itself.
        self.assertEqual(fake.requests[1]["path"], "/v1/events?generate=false")
        self.assertEqual(prompt["eventType"], "user_prompt")
        self.assertEqual(prompt["payload"]["prompt"], "deploy the app")
        self.assertEqual(tool["eventType"], "tool_use")
        self.assertEqual(tool["payload"]["tool_name"], "terminal")
        self.assertEqual(tool["payload"]["tool_input"], {"command": "make deploy "})
        self.assertEqual(note["content"], "Deploys need VPN")
        # The checkout's key labels hosted writes, so project-scoped reads find them.
        self.assertEqual(start["metadata"]["project"], "app")
        self.assertEqual(note["metadata"]["project"], "app")
        self.assertEqual(last["eventType"], "assistant_message")
        self.assertEqual(last["payload"]["last_assistant_message"], "Deployed")

        fake.requests.clear()
        notes = provider.prefetch("how do we deploy <private>password hunter2</private> the application?")
        self.assertEqual(notes, "#3 hosted note")
        self.assertEqual(fake.requests[0]["body"]["folderProjects"], ["app"])
        query = fake.requests[0]["body"]["query"]
        self.assertNotIn("hunter2", query)
        self.assertIn("deploy or application", query)
        provider.shutdown()

    def test_a_private_last_turn_still_ends_the_server_session(self):
        fake = FakeClaudeMem()
        self.addCleanup(fake.close)
        fake.replies["/v1/sessions/start"] = (200, {"session": {"id": "srv-2"}})
        config = client_module.Config("http://127.0.0.1:1", fake.base, "key-1", "proj-1")
        client = client_module.ClaudeMemClient(config)
        provider = claude_mem.ClaudeMemMemoryProvider(client=client)
        self.addCleanup(provider.shutdown)
        provider.initialize("sess-p", cwd="/work/app")
        provider.on_turn_start(1, "deploy the app")
        provider.on_turn_start(2, "<private>use password hunter2</private>")
        provider.on_session_end([{"role": "assistant", "content": "Logged in with hunter2"}])
        self.assertTrue(client.flush(5.0))
        # The private turn's assistant message is dropped, but the session the
        # public turn opened is still ended on the server.
        self.assertEqual(fake.paths(), ["/v1/sessions/start", "/v1/events",
                                        "/v1/sessions/start", "/v1/sessions/srv-2/end"])
        self.assertNotIn("hunter2", json.dumps([r["body"] for r in fake.requests]))


if __name__ == "__main__":
    unittest.main()
