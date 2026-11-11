from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from mcp.client.stdio import StdioServerParameters, stdio_client
from strands import Agent
from strands.models import Model

from memory import (MEMORY_TOOLS, ProjectMemoryHook, agent_tools, call_memory,
                    memory_client, response_text, scoped_arguments)


class NoModelRequests(Model):
    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def stream(self, *args, **kwargs):
        raise AssertionError("This test must not request a model")
        yield  # pragma: no cover

    async def structured_output(self, *args, **kwargs):
        raise AssertionError("This test must not request a model")
        yield  # pragma: no cover


@contextmanager
def fixture_client(**kwargs):
    fixture = Path(__file__).with_name("fixture_server.py")
    params = StdioServerParameters(command=sys.executable, args=[str(fixture)])
    with patch("memory.stdio_client", lambda _params: stdio_client(params)):
        with memory_client(str(fixture), str(fixture.parent), **kwargs) as client:
            yield client


class ProjectArguments(unittest.TestCase):
    def test_model_arguments_cannot_change_the_project(self):
        for name in MEMORY_TOOLS:
            args = {"project": "other", "projects": ["other"], "text": "Safe note"}
            result = scoped_arguments(name, args, "owned")
            self.assertEqual(result["project"], "owned")
            self.assertNotIn("projects", result)
            self.assertEqual(args["project"], "other")

    def test_replay_fingerprint_distinguishes_project_and_content(self):
        args = {"text": "Safe note", "title": "Note"}
        first = scoped_arguments("save_memory", args, "a")["metadata"]
        self.assertEqual(first, scoped_arguments("save_memory", args, "a")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", args, "b")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", {**args, "text": "Changed"}, "a")["metadata"])

    def test_invalid_arguments_and_deadlines_fail_before_connecting(self):
        for name, args, project in [("search", {}, " "), ("unknown", {}, "a"), ("save_memory", {"text": " "}, "a")]:
            with self.assertRaises(ValueError):
                scoped_arguments(name, args, project)
        for field in ("timeout", "lifetime"):
            for seconds in (float("nan"), float("inf"), 0, -1):
                with self.subTest(field=field, seconds=seconds), self.assertRaises(ValueError):
                    memory_client(__file__, str(Path(__file__).parent), **{field: seconds})

    def test_error_and_nontext_results_are_not_success(self):
        for result in ({"status": "error", "content": [{"text": "failed"}]},
                       {"status": "success", "content": []},
                       {"status": "success", "content": [{"image": {}}]}):
            with self.assertRaises(ValueError):
                response_text(result)


class NativeSdk(unittest.TestCase):
    def test_agent_executor_runs_the_project_hook_and_only_memory_tools(self):
        with fixture_client() as client:
            tools = agent_tools(client)
            self.assertEqual({tool.tool_name for tool in tools}, MEMORY_TOOLS)
            agent = Agent(model=NoModelRequests(), tools=tools, hooks=[ProjectMemoryHook("owned")], callback_handler=None)
            result = agent.tool.search(query="release", project="other", projects=["other"])
            self.assertEqual(json.loads(response_text(result)), {"query": "release", "project": "owned"})
            saved = json.loads(response_text(agent.tool.save_memory(text="Safe note", title="Note", project="other")))
            self.assertEqual(saved["project"], "owned")
            self.assertEqual(saved["metadata"]["platformSource"], "strands-agents")

    def test_native_mcp_tool_error_is_a_failure(self):
        with fixture_client() as client, self.assertRaises(ValueError):
            call_memory(client, "owned", "search", {"query": "error"})

    def test_native_tool_request_has_a_deadline(self):
        with fixture_client() as client:
            start = time.monotonic()
            with self.assertRaises(ValueError):
                call_memory(client, "owned", "search", {"query": "stall"}, timeout=0.05)
            self.assertLess(time.monotonic() - start, 2)

    def test_connection_lifetime_also_bounds_an_unresponsive_stdio_server(self):
        with tempfile.TemporaryDirectory(prefix="strands project ") as directory:
            stalled = Path(directory) / "stalled server.py"
            stalled.write_text("import time; time.sleep(10)")
            params = StdioServerParameters(command=sys.executable, args=[str(stalled)], cwd=directory)
            start = time.monotonic()
            with patch("memory.stdio_client", lambda _params: stdio_client(params)), self.assertRaises(Exception):
                with memory_client(str(stalled), directory, timeout=1, lifetime=0.1):
                    self.fail("unresponsive server must not initialize")
            self.assertLess(time.monotonic() - start, 3)


if __name__ == "__main__":
    unittest.main()
