from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from mcp import StdioServerParameters
from mcp.types import CallToolResult, TextContent, Tool as MCPTool
from mcpadapt.core import MCPAdapt
from smolagents import Model, ToolCallingAgent
from smolagents.models import ChatMessage, ChatMessageToolCall, ChatMessageToolCallFunction

from memory import MEMORY_TOOLS, ProjectMemoryAdapter, call_memory, memory_tools, scoped_arguments


@contextmanager
def fixture_tools(**kwargs):
    fixture = Path(__file__).with_name("fixture_server.py")
    params = StdioServerParameters(command=sys.executable, args=[str(fixture)])
    with patch("memory.StdioServerParameters", return_value=params):
        with memory_tools("owned", str(fixture), str(fixture.parent), **kwargs) as tools:
            yield tools


class DeterministicModel(Model):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def generate(self, messages, **kwargs):
        self.calls += 1
        name, args = ("search", {"query": "release"}) if self.calls == 1 else ("final_answer", {"answer": "Verified"})
        if self.calls == 2:
            assert '"project": "owned"' in str(messages), "native agent did not receive the scoped tool result"
        return ChatMessage(role="assistant", tool_calls=[ChatMessageToolCall(
            id=str(self.calls), type="function", function=ChatMessageToolCallFunction(name=name, arguments=args),
        )])


class ProjectArguments(unittest.TestCase):
    def test_project_override_and_fingerprint_identity(self):
        for name in MEMORY_TOOLS:
            args = {"project": "other", "projects": ["other"], "text": "Safe note"}
            result = scoped_arguments(name, args, "owned")
            self.assertEqual(result["project"], "owned")
            self.assertNotIn("projects", result)
            self.assertEqual(args["project"], "other")
        first = scoped_arguments("save_memory", {"text": "Safe note"}, "a")["metadata"]
        self.assertEqual(first, scoped_arguments("save_memory", {"text": "Safe note"}, "a")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", {"text": "Safe note"}, "b")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", {"text": "Changed"}, "a")["metadata"])

    def test_native_error_bit_is_checked_before_text_conversion(self):
        definition = MCPTool(name="search", inputSchema={"type": "object", "properties": {"query": {"type": "string"}}})
        result = CallToolResult(isError=True, content=[TextContent(type="text", text="A plausible successful answer")])
        tool = ProjectMemoryAdapter("a").adapt(lambda _args: result, definition)
        with self.assertRaises(ValueError):
            tool(query="release")
        result.isError = False
        self.assertEqual(tool(query="release"), "A plausible successful answer")

    def test_invalid_inputs_and_deadlines_fail_before_connection(self):
        for name, args, project in [("search", {}, " "), ("unknown", {}, "a"), ("save_memory", {"text": " "}, "a")]:
            with self.assertRaises(ValueError):
                scoped_arguments(name, args, project)
        for seconds in (float("nan"), float("inf"), 0, -1):
            with self.subTest(seconds=seconds), self.assertRaises(ValueError):
                with memory_tools("a", __file__, str(Path(__file__).parent), timeout=seconds):
                    self.fail("invalid deadline was accepted")


class NativeSdk(unittest.TestCase):
    def test_native_agent_runs_scoped_tools_without_provider_requests(self):
        with fixture_tools() as tools:
            self.assertEqual(set(tools), MEMORY_TOOLS)
            for tool in tools.values():
                self.assertNotIn("project", tool.inputs)
                self.assertNotIn("metadata", tool.inputs)
            agent = ToolCallingAgent(tools=list(tools.values()), model=DeterministicModel(),
                                     max_steps=2, add_base_tools=False, verbosity_level=0)
            self.assertEqual(agent.run("Recall the release note"), "Verified")

    def test_direct_calls_also_enforce_project_and_save_identity(self):
        with fixture_tools() as tools:
            result = json.loads(call_memory(tools, "search", {"query": "release", "project": "other", "projects": ["other"]}))
            self.assertEqual(result["project"], "owned")
            saved = json.loads(call_memory(tools, "save_memory", {"title": "Note", "text": "Safe note"}))
            self.assertEqual(saved["metadata"]["platformSource"], "smolagents")

    def test_native_mcp_tool_errors_are_not_successful_strings(self):
        with fixture_tools() as tools, self.assertRaises(ValueError):
            call_memory(tools, "search", {"query": "error"})

    def test_stalled_request_is_bounded(self):
        with fixture_tools(timeout=3) as tools:
            start = time.monotonic()
            with self.assertRaises(Exception):
                call_memory(tools, "search", {"query": "stall"})
            self.assertLess(time.monotonic() - start, 5)

    def test_failed_connection_is_bounded_and_cleaned_up(self):
        with tempfile.TemporaryDirectory(prefix="smol project ") as directory:
            stalled = Path(directory) / "stalled server.py"
            child_pid = Path(directory) / "child.pid"
            stalled.write_text(
                "import os, time\nfrom pathlib import Path\n"
                "Path('child.pid').write_text(str(os.getpid()))\ntime.sleep(10)\n"
            )
            params = StdioServerParameters(command=sys.executable, args=[str(stalled)], cwd=directory)
            adapters = []

            def native_adapter(*args, **kwargs):
                adapter = MCPAdapt(*args, **kwargs)
                adapters.append(adapter)
                return adapter

            try:
                start = time.monotonic()
                with patch("memory.StdioServerParameters", return_value=params), \
                        patch("memory.MCPAdapt", side_effect=native_adapter), \
                        self.assertRaises(TimeoutError):
                    with memory_tools("a", str(stalled), directory, timeout=0.1):
                        self.fail("unresponsive server must not initialize")
                self.assertLess(time.monotonic() - start, 3)
                self.assertTrue(child_pid.is_file(), "the actual stdio child must have started")
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(child_pid.read_text()), 0)
                self.assertTrue(adapters[0].loop.is_closed(), "the native client loop must also close")
            finally:
                # Keep a failing cleanup regression from leaking its fixture process.
                for adapter in adapters:
                    if not adapter.loop.is_closed():
                        adapter.close()


if __name__ == "__main__":
    unittest.main()
