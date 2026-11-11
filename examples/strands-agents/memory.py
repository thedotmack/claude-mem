"""Explicit project memory using Strands Agents' native MCP client and hooks."""

import argparse
from contextlib import asynccontextmanager
from datetime import timedelta
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any
from uuid import uuid4

import anyio
from mcp.client.stdio import StdioServerParameters, stdio_client
from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry
from strands.tools.mcp import MCPClient


MEMORY_TOOLS = frozenset({"save_memory", "search", "timeline", "get_observations"})
DEMO_TITLE = "Strands release checklist"
DEMO_NOTE = "Run the smoke suite before releasing the application."


def positive_seconds(value: float) -> float:
    if not math.isfinite(value) or value <= 0:
        raise ValueError("A deadline must be finite and positive.")
    return value


def scoped_arguments(name: str, arguments: dict[str, Any], project: str) -> dict[str, Any]:
    if name not in MEMORY_TOOLS or not project.strip():
        raise ValueError("Choose a nonempty project and one of the four memory tools.")
    result = {**arguments, "project": project.strip()}
    result.pop("projects", None)
    if name == "save_memory":
        text, title = result.get("text"), result.get("title", "")
        if not isinstance(text, str) or not text.strip() or not isinstance(title, str):
            raise ValueError("A memory needs nonempty text and an optional text title.")
        fingerprint = hashlib.sha256(json.dumps(
            [project.strip(), title.strip(), text.strip()], ensure_ascii=False,
        ).encode()).hexdigest()
        result["metadata"] = {"integration": "strands-agents", "platformSource": "strands-agents",
                              "sourceFingerprint": f"strands-example-v1:{fingerprint}"}
    return result


class ProjectMemoryHook(HookProvider):
    """Apply the same project boundary to direct and model-selected agent tools."""

    def __init__(self, project: str):
        if not project.strip():
            raise ValueError("Choose a nonempty project.")
        self.project = project.strip()

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeToolCallEvent, self.before_tool)

    def before_tool(self, event: BeforeToolCallEvent) -> None:
        name = event.tool_use["name"]
        if name in MEMORY_TOOLS:
            event.tool_use["input"] = scoped_arguments(name, event.tool_use["input"], self.project)


def memory_client(server: str, cwd: str, *, timeout: float = 30, lifetime: float = 120) -> MCPClient:
    """Open a bounded stdio connection to the existing local worker MCP bundle."""
    if not Path(server).is_file() or not Path(cwd).is_dir():
        raise ValueError("Set an existing MCP server file and working directory.")
    positive_seconds(timeout)
    positive_seconds(lifetime)
    params = StdioServerParameters(
        command="node", args=[str(Path(server).resolve())], cwd=str(Path(cwd).resolve()),
        env={**os.environ, "CLAUDE_MEM_RUNTIME": "worker", "CLAUDE_MEM_WORKER_AUTOSTART": "false"},
    )

    @asynccontextmanager
    async def transport():
        # Also bounds tools/list, for which MCPClient exposes no per-call timeout.
        with anyio.fail_after(lifetime):
            async with stdio_client(params) as streams:
                yield streams

    return MCPClient(transport, startup_timeout=timeout, tool_filters={"allowed": sorted(MEMORY_TOOLS)},
                     continue_on_error=False)


def agent_tools(memory: MCPClient, *, timeout: float = 30):
    tools = memory.list_tools_sync()
    for tool in tools:
        tool.timeout = timedelta(seconds=positive_seconds(timeout))
    if {tool.tool_name for tool in tools} != MEMORY_TOOLS:
        raise ValueError("The selected MCP server does not provide all four memory tools.")
    return tools


def response_text(result: dict[str, Any]) -> str:
    content = result.get("content")
    if result.get("status") != "success" or not isinstance(content, list) or not content:
        raise ValueError("Claude-Mem did not confirm a successful tool response.")
    if any(not isinstance(block.get("text"), str) for block in content):
        raise ValueError("Claude-Mem returned an unexpected response.")
    return "\n".join(block["text"] for block in content)


def call_memory(memory: MCPClient, project: str, name: str, arguments: dict[str, Any], *, timeout: float = 30) -> str:
    result = memory.call_tool_sync(str(uuid4()), name, scoped_arguments(name, arguments, project),
                                   read_timeout_seconds=timedelta(seconds=positive_seconds(timeout)))
    return response_text(result)


def demonstrate(memory: MCPClient, project: str) -> dict[str, Any]:
    with memory:
        agent_tools(memory)
        saved = call_memory(memory, project, "save_memory", {"title": DEMO_TITLE, "text": DEMO_NOTE})
        match = re.search(r"(?:Saved memory #|Memory already saved as #)(\d+)", saved)
        if match is None:
            raise ValueError("Claude-Mem did not confirm a saved observation.")
        observation_id = int(match[1])
        call_memory(memory, project, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 5})
        # A repeated save can return an old ID outside the search page/date window.
        call_memory(memory, project, "timeline", {"anchor": observation_id, "depth_before": 0, "depth_after": 0})
        details = call_memory(memory, project, "get_observations", {"ids": [observation_id]})
        if DEMO_NOTE not in details:
            raise ValueError("The confirmed observation could not be recalled.")
        return {"project": project, "observation_id": observation_id, "recalled": True, "model_requests": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--mcp-server", default=os.environ.get("CLAUDE_MEM_MCP_SERVER", ""))
    args = parser.parse_args()
    try:
        if not args.project.strip():
            raise ValueError("Choose a nonempty project.")
        result = demonstrate(memory_client(args.mcp_server, args.cwd), args.project)
    except (Exception, KeyboardInterrupt):
        print("Memory verification failed. Check the MCP file, project and worker with `npx claude-mem doctor`; no retry was queued.", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
