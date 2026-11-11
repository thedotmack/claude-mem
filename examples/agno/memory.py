"""Explicit project memory with Agno's native MCPTools and FunctionCall."""

import argparse
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import sys
from typing import Any

from agno.tools.function import FunctionCall, ToolResult
from agno.tools.mcp import MCPTools
from mcp import StdioServerParameters


MEMORY_TOOLS = frozenset({"save_memory", "search", "timeline", "get_observations"})
DEMO_TITLE = "Agno release checklist"
DEMO_NOTE = "Run the smoke suite before releasing the application."


def scoped_arguments(name: str, arguments: dict[str, Any], project: str) -> dict[str, Any]:
    if name not in MEMORY_TOOLS or not project.strip():
        raise ValueError("Choose a nonempty project and one of the four memory tools.")
    result = {**arguments, "project": project}
    if name != "save_memory":
        # JSON preserves commas/whitespace across GET queries and prevents inheritance.
        result["projects"] = json.dumps([project], ensure_ascii=False)
    else:
        result.pop("projects", None)
    if name == "save_memory":
        text, title = result.get("text"), result.get("title", "")
        if not isinstance(text, str) or not text.strip() or not isinstance(title, str):
            raise ValueError("A memory needs nonempty text and an optional text title.")
        fingerprint = hashlib.sha256(json.dumps(
            [project, title.strip(), text.strip()], ensure_ascii=False,
        ).encode()).hexdigest()
        result["metadata"] = {"integration": "agno", "platformSource": "agno",
                              "sourceFingerprint": f"agno-example-v1:{fingerprint}"}
    return result


def checked_text(name: str, result: ToolResult) -> str:
    if not isinstance(result, ToolResult) or not result.content.strip():
        raise ValueError("Claude-Mem returned an unexpected response.")
    # Agno 3.1.12 converts MCP is_error and transport failures into ToolResult text.
    # Its FunctionCall status alone therefore cannot confirm a successful MCP call.
    if result.content.startswith((f"Error from MCP tool '{name}':", f"MCP tool '{name}' failed:", "Error:")):
        raise ValueError("The MCP tool failed; no successful memory operation was confirmed.")
    return result.content


def project_hook(project: str):
    if not project.strip():
        raise ValueError("Choose a nonempty project.")

    async def bind_project(function_name, function_call, arguments):
        scoped = scoped_arguments(function_name, arguments, project)
        # Agno executes this same mapping. Replacing only next-call kwargs is insufficient.
        arguments.clear()
        arguments.update(scoped)
        result = await function_call(**arguments)
        checked_text(function_name, result)
        return result

    return bind_project


@asynccontextmanager
async def memory_tools(project: str, server: str, cwd: str, *, timeout: float = 30, lifetime: float = 120):
    if not project.strip() or not Path(server).is_file() or not Path(cwd).is_dir():
        raise ValueError("Set a project, an existing MCP server file and a working directory.")
    if any(not math.isfinite(value) or value <= 0 for value in (timeout, lifetime)):
        raise ValueError("Deadlines must be finite and positive.")
    params = StdioServerParameters(
        command="node", args=[str(Path(server).resolve())], cwd=str(Path(cwd).resolve()),
        env={**os.environ, "CLAUDE_MEM_RUNTIME": "worker", "CLAUDE_MEM_WORKER_AUTOSTART": "false"},
    )
    # Include connection/discovery in the overall deadline, not only tool requests.
    async with asyncio.timeout(lifetime):
        async with MCPTools(server_params=params, transport="stdio", timeout_seconds=timeout,
                            include_tools=sorted(MEMORY_TOOLS), refresh_connection=False) as memory:
            if set(memory.functions) != MEMORY_TOOLS:
                raise ValueError("The selected MCP server does not provide all four memory tools.")
            for function in memory.functions.values():
                function.tool_hooks = [project_hook(project)]
            yield memory


async def call_memory(memory: MCPTools, name: str, arguments: dict[str, Any]) -> str:
    if name not in MEMORY_TOOLS or name not in memory.functions:
        raise ValueError("Choose one of the four connected memory tools.")
    execution = await FunctionCall(function=memory.functions[name], arguments=dict(arguments)).aexecute()
    if execution.status != "success":
        raise ValueError("Memory tool execution failed; no success was confirmed.")
    return checked_text(name, execution.result)


async def demonstrate(project: str, server: str, cwd: str) -> dict[str, Any]:
    async with memory_tools(project, server, cwd) as memory:
        saved = await call_memory(memory, "save_memory", {"title": DEMO_TITLE, "text": DEMO_NOTE})
        match = re.search(r"(?:Saved memory #|Memory already saved as #)(\d+)", saved)
        if match is None:
            raise ValueError("Claude-Mem did not confirm a saved observation.")
        observation_id = int(match[1])
        await call_memory(memory, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 5})
        # A repeated save may return an older ID outside the first search page/window.
        await call_memory(memory, "timeline", {"anchor": observation_id, "depth_before": 0, "depth_after": 0})
        details = await call_memory(memory, "get_observations", {"ids": [observation_id]})
        if DEMO_NOTE not in details:
            raise ValueError("The confirmed observation could not be recalled.")
        return {"project": project, "observation_id": observation_id, "recalled": True, "model_requests": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--mcp-server", default=os.environ.get("CLAUDE_MEM_MCP_SERVER", ""))
    args = parser.parse_args()
    # CLI-only logging setup; importing this module leaves application logging alone.
    logging.getLogger("agno").handlers = [logging.StreamHandler(sys.stderr)]
    try:
        result = asyncio.run(demonstrate(args.project, args.mcp_server, args.cwd))
    except (Exception, KeyboardInterrupt):
        print("Memory verification failed. Check the MCP file, project and worker with `npx claude-mem doctor`; no retry was queued.", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
