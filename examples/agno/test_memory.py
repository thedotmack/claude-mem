from contextlib import asynccontextmanager
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agno.tools.function import FunctionCall, ToolResult
from mcp import StdioServerParameters

from memory import (MEMORY_TOOLS, call_memory, checked_text, memory_tools,
                    scoped_arguments)


@asynccontextmanager
async def fixture_tools(**kwargs):
    fixture = Path(__file__).with_name("fixture_server.py")
    params = StdioServerParameters(command=sys.executable, args=[str(fixture)])
    with patch("memory.StdioServerParameters", return_value=params):
        async with memory_tools("owned", str(fixture), str(fixture.parent), **kwargs) as tools:
            yield tools


class ProjectArguments(unittest.TestCase):
    def test_project_cannot_be_overridden(self):
        for name in MEMORY_TOOLS:
            args = {"project": "other", "projects": ["other"], "text": "Safe note"}
            result = scoped_arguments(name, args, "owned")
            self.assertEqual(result["project"], "owned")
            if name == "save_memory":
                self.assertNotIn("projects", result)
            else:
                self.assertEqual(result["projects"], json.dumps(["owned"]))
            self.assertEqual(args["project"], "other")

    def test_fingerprint_distinguishes_project_and_content(self):
        args = {"text": "Safe note", "title": "Note"}
        first = scoped_arguments("save_memory", args, "a")["metadata"]
        self.assertEqual(first, scoped_arguments("save_memory", args, "a")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", args, "b")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", {**args, "text": "Changed"}, "a")["metadata"])

    def test_pinned_sdk_error_results_are_not_success(self):
        for text in ("Error from MCP tool 'search': fixture", "MCP tool 'search' failed: timeout", "Error: connection closed", " "):
            with self.assertRaises(ValueError):
                checked_text("search", ToolResult(content=text))


    def test_literal_project_keys_do_not_alias_trimmed_or_split_keys(self):
        selected = " owned,web "
        for name in MEMORY_TOOLS:
            scoped = scoped_arguments(name, {"text": "Safe note", "projects": ["other"]}, selected)
            self.assertEqual(scoped["project"], selected)
            if name != "save_memory":
                self.assertIsInstance(scoped["projects"], str)
                self.assertEqual(json.loads(scoped["projects"]), [selected])
        identity = scoped_arguments("save_memory", {"text": "Safe note"}, selected)["metadata"]
        for alias in (selected.strip(), "owned", "web"):
            self.assertNotEqual(identity, scoped_arguments("save_memory", {"text": "Safe note"}, alias)["metadata"])


class NativeSdk(unittest.IsolatedAsyncioTestCase):
    async def test_native_function_executor_applies_scope_and_save_identity(self):
        async with fixture_tools() as memory:
            self.assertEqual(set(memory.functions), MEMORY_TOOLS)
            # This is the same native FunctionCall execution used by an Agno agent.
            execution = await FunctionCall(function=memory.functions["search"], arguments={
                "query": "release", "project": "other", "projects": ["other"],
            }).aexecute()
            self.assertEqual(execution.status, "success")
            self.assertEqual(json.loads(execution.result.content), {"query": "release", "project": "owned", "projects": json.dumps(["owned"])})
            saved = json.loads(await call_memory(memory, "save_memory", {"text": "Safe note", "title": "Note", "project": "other"}))
            self.assertEqual(saved["project"], "owned")
            self.assertEqual(saved["metadata"]["platformSource"], "agno")

    async def test_native_mcp_error_is_an_execution_failure(self):
        async with fixture_tools() as memory:
            execution = await FunctionCall(function=memory.functions["search"], arguments={"query": "error"}).aexecute()
            self.assertEqual(execution.status, "failure")
            with self.assertRaises(ValueError):
                await call_memory(memory, "search", {"query": "error"})

    async def test_stalled_request_is_bounded_and_not_success(self):
        async with fixture_tools(timeout=3) as memory:
            start = time.monotonic()
            with self.assertRaises(ValueError):
                await call_memory(memory, "search", {"query": "stall"})
            self.assertLess(time.monotonic() - start, 5)

    async def test_legitimate_notes_starting_with_sdk_error_prefixes_are_preserved(self):
        async with fixture_tools() as memory:
            for text in ("Error: historical failure", "Error from MCP tool 'save_memory': historical failure",
                         "MCP tool 'save_memory' failed: historical failure"):
                result = await call_memory(memory, "save_memory", {"text": text, "title": "Incident"})
                self.assertEqual(json.loads(result)["text"], text)

    async def test_invalid_inputs_and_deadlines_fail_before_connection(self):
        for name, args, project in [("search", {}, " "), ("unknown", {}, "a"), ("save_memory", {"text": " "}, "a")]:
            with self.assertRaises(ValueError):
                scoped_arguments(name, args, project)
        for field in ("timeout", "lifetime"):
            for seconds in (float("nan"), float("inf"), 0, -1):
                with self.subTest(field=field, seconds=seconds), self.assertRaises(ValueError):
                    async with memory_tools("a", __file__, str(Path(__file__).parent), **{field: seconds}):
                        self.fail("invalid deadline was accepted")

    async def test_unresponsive_stdio_connection_has_an_overall_deadline(self):
        with tempfile.TemporaryDirectory(prefix="agno project ") as directory:
            stalled = Path(directory) / "stalled server.py"
            stalled.write_text("import time; time.sleep(10)")
            params = StdioServerParameters(command=sys.executable, args=[str(stalled)], cwd=directory)
            start = time.monotonic()
            with patch("memory.StdioServerParameters", return_value=params), self.assertRaises(Exception):
                async with memory_tools("a", str(stalled), directory, lifetime=0.1):
                    self.fail("unresponsive server must not initialize")
            self.assertLess(time.monotonic() - start, 3)


if __name__ == "__main__":
    unittest.main()
