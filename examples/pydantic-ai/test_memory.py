import asyncio
from pathlib import Path
import tempfile
import unittest

from fastmcp import FastMCP
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.mcp import MCPToolset

from memory import MEMORY_TOOLS, call_memory, memory_toolset, scoped_arguments


class ProjectArguments(unittest.TestCase):
    def test_project_scope_cannot_be_overridden_by_tool_arguments(self):
        for name in MEMORY_TOOLS:
            args = {"project": "other", "projects": ["other"], "text": "A safe note"}
            scoped = scoped_arguments(name, args, "owned")
            self.assertEqual(scoped["project"], "owned")
            self.assertNotIn("projects", scoped)
            self.assertEqual(args["project"], "other")

    def test_repeated_save_has_a_stable_project_scoped_fingerprint(self):
        args = {"text": " A safe note ", "title": " Note "}
        first = scoped_arguments("save_memory", args, "a")["metadata"]
        self.assertEqual(first, scoped_arguments("save_memory", args, "a")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", args, "b")["metadata"])
        self.assertNotEqual(first, scoped_arguments("save_memory", {**args, "text": "Changed"}, "a")["metadata"])
        self.assertEqual(first["platformSource"], "pydantic-ai")

    def test_invalid_input_fails_before_connection(self):
        with self.assertRaises(ValueError):
            scoped_arguments("save_memory", {"text": " "}, "a")
        with self.assertRaises(ValueError):
            scoped_arguments("search", {}, " ")
        with self.assertRaises(ValueError):
            scoped_arguments("smart_search", {}, "a")
        with self.assertRaises(ValueError):
            memory_toolset("a", "missing-server.cjs", ".")

    def test_paths_with_spaces_are_individual_subprocess_arguments(self):
        with tempfile.TemporaryDirectory(prefix="memory project ") as directory:
            server = Path(directory) / "mcp server.cjs"
            server.touch()
            memory = memory_toolset("a", str(server), directory)
            transport = memory.client.transport
            self.assertEqual(transport.args, [str(server)])
            self.assertEqual(transport.cwd, directory)

    def test_request_timeout_rejects_nonfinite_and_nonpositive_values(self):
        with tempfile.TemporaryDirectory() as directory:
            server = Path(directory) / "server.cjs"
            server.touch()
            for timeout in (float("nan"), float("inf"), float("-inf"), 0, -1):
                with self.subTest(timeout=timeout), self.assertRaisesRegex(ValueError, "finite and positive"):
                    memory_toolset("a", str(server), directory, timeout=timeout)


class NativeSdk(unittest.IsolatedAsyncioTestCase):
    async def test_agent_calls_the_native_mcp_toolset_with_bound_project(self):
        server = FastMCP("fixture")
        received = []

        @server.tool
        async def search(query: str, project: str) -> str:
            received.append((query, project))
            return "Known observation #17"

        async def process(_ctx, call, name, args):
            return await call(name, scoped_arguments(name, args, "owned"))

        memory = MCPToolset(server, process_tool_call=process, tool_error_behavior="error", max_retries=0)

        def model(messages, _info):
            results = [p for message in messages for p in message.parts if isinstance(p, ToolReturnPart)]
            if not results:
                return ModelResponse(parts=[ToolCallPart("search", {"query": "release", "project": "other"})])
            self.assertIn("#17", str(results[-1].content))
            return ModelResponse(parts=[TextPart("Verified")])

        agent = Agent(FunctionModel(model), toolsets=[memory.filtered(lambda _ctx, tool: tool.name in MEMORY_TOOLS)])
        result = await agent.run("Recall the release note", timeout=5)
        self.assertEqual(result.output, "Verified")
        self.assertEqual(received, [("release", "owned")])

    async def test_explicit_tool_errors_are_not_reported_as_empty_success(self):
        server = FastMCP("fixture")

        @server.tool
        async def search(query: str, project: str) -> str:
            raise ValueError("fixture unavailable")

        memory = MCPToolset(server, tool_error_behavior="error", max_retries=0)
        with self.assertRaises(Exception):
            await call_memory(memory, "owned", "search", {"query": "release"})

    async def test_request_timeout_bounds_a_stalled_tool(self):
        server = FastMCP("fixture")

        @server.tool
        async def search(query: str, project: str) -> str:
            await asyncio.sleep(5)
            return "late"

        memory = MCPToolset(server, read_timeout=0.05, tool_error_behavior="error", max_retries=0)
        with self.assertRaises(Exception):
            await asyncio.wait_for(call_memory(memory, "owned", "search", {"query": "release"}), 1)

    async def test_nontext_result_is_not_accepted_as_a_saved_memory(self):
        server = FastMCP("fixture")

        @server.tool
        async def search(query: str, project: str) -> dict:
            return {"unexpected": True}

        memory = MCPToolset(server, tool_error_behavior="error")
        with self.assertRaisesRegex(ValueError, "unexpected response"):
            await call_memory(memory, "owned", "search", {"query": "release"})


if __name__ == "__main__":
    unittest.main()
