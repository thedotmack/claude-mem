"""Explicit project memory for SmolAgents through its existing MCP adapter."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any

from mcp import StdioServerParameters
from mcp.types import TextContent
from mcpadapt.core import MCPAdapt
from mcpadapt.smolagents_adapter import SmolAgentsAdapter


MEMORY_TOOLS = frozenset({"save_memory", "search", "timeline", "get_observations"})
DEMO_TITLE = "SmolAgents release checklist"
DEMO_NOTE = "Run the smoke suite before releasing the application."


def scoped_arguments(name: str, arguments: dict[str, Any], project: str) -> dict[str, Any]:
    if name not in MEMORY_TOOLS or not project.strip():
        raise ValueError("Choose a nonempty project and one of the four memory tools.")
    result = {**arguments, "project": project.strip()}
    if name != "save_memory":
        # An explicit singleton prevents checkout/worktree parent inheritance.
        result["projects"] = [project.strip()]
    else:
        result.pop("projects", None)
    if name == "save_memory":
        text, title = result.get("text"), result.get("title", "")
        if not isinstance(text, str) or not text.strip() or not isinstance(title, str):
            raise ValueError("A memory needs nonempty text and an optional text title.")
        fingerprint = hashlib.sha256(json.dumps(
            [project.strip(), title.strip(), text.strip()], ensure_ascii=False,
        ).encode()).hexdigest()
        result["metadata"] = {"integration": "smolagents", "platformSource": "smolagents",
                              "sourceFingerprint": f"smolagents-example-v1:{fingerprint}"}
    return result


class ProjectMemoryAdapter(SmolAgentsAdapter):
    """Keep native Tool conversion while binding project and preserving MCP errors."""

    def __init__(self, project: str):
        if not project.strip():
            raise ValueError("Choose a nonempty project.")
        super().__init__(structured_output=False)
        self.project = project.strip()

    def adapt(self, call, mcp_tool):
        if mcp_tool.name not in MEMORY_TOOLS:
            return None

        def scoped_call(arguments=None):
            result = call(scoped_arguments(mcp_tool.name, arguments or {}, self.project))
            # The stock adapter discards isError when extracting the first content item.
            if result.isError:
                raise ValueError("The MCP tool failed; no successful memory operation was confirmed.")
            if len(result.content) != 1 or not isinstance(result.content[0], TextContent):
                raise ValueError("Claude-Mem returned an unexpected response.")
            return result

        schema = mcp_tool.model_copy(deep=True)
        hidden = {"project", "projects", "metadata"}
        schema.inputSchema["properties"] = {key: value for key, value in schema.inputSchema["properties"].items() if key not in hidden}
        schema.inputSchema["required"] = [key for key in schema.inputSchema.get("required", []) if key not in hidden]
        tool = super().adapt(scoped_call, schema)
        for key, value in tool.inputs.items():
            value["nullable"] = key not in schema.inputSchema["required"]
        return tool


@contextmanager
def memory_tools(project: str, server: str, cwd: str, *, timeout: float = 30):
    if not project.strip() or not Path(server).is_file() or not Path(cwd).is_dir():
        raise ValueError("Set a project, an existing MCP server file and a working directory.")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("The timeout must be finite and positive.")
    params = StdioServerParameters(
        command="node", args=[str(Path(server).resolve())], cwd=str(Path(cwd).resolve()),
        env={**os.environ, "CLAUDE_MEM_RUNTIME": "worker", "CLAUDE_MEM_WORKER_AUTOSTART": "false"},
    )
    # Initialization and the first tool listing each have a request deadline.
    # Let their native stdio cleanup finish before MCPAdapt.start's watchdog
    # expires; equal deadlines can cancel that cleanup a second time.
    connection_budget = 2 * float(timeout) + 5
    if not math.isfinite(connection_budget):
        raise ValueError("The derived connection budget must be finite.")
    adapter = MCPAdapt(params, ProjectMemoryAdapter(project), connect_timeout=connection_budget,
                       client_session_timeout_seconds=float(timeout))
    try:
        # Explicit finally also closes a process if connection/discovery raises.
        adapter.start()
        tools = {tool.name: tool for tool in adapter.tools() if tool is not None}
        if set(tools) != MEMORY_TOOLS:
            raise ValueError("The selected MCP server does not provide all four memory tools.")
        yield tools
    finally:
        adapter.close()


def call_memory(tools, name: str, arguments: dict[str, Any]) -> str:
    if name not in MEMORY_TOOLS or name not in tools:
        raise ValueError("Choose one of the four connected memory tools.")
    result = tools[name](**arguments)
    if not isinstance(result, str) or not result.strip():
        raise ValueError("Claude-Mem returned an unexpected response.")
    return result


def demonstrate(project: str, server: str, cwd: str) -> dict[str, Any]:
    with memory_tools(project, server, cwd) as tools:
        saved = call_memory(tools, "save_memory", {"title": DEMO_TITLE, "text": DEMO_NOTE})
        match = re.search(r"(?:Saved memory #|Memory already saved as #)(\d+)", saved)
        if match is None:
            raise ValueError("Claude-Mem did not confirm a saved observation.")
        observation_id = int(match[1])
        call_memory(tools, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 5})
        # A repeated save may confirm an old ID outside the first search page/window.
        call_memory(tools, "timeline", {"anchor": observation_id, "depth_before": 0, "depth_after": 0})
        details = call_memory(tools, "get_observations", {"ids": [observation_id]})
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
        result = demonstrate(args.project, args.mcp_server, args.cwd)
    except (Exception, KeyboardInterrupt):
        print("Memory verification failed. Check the MCP file, project and worker with `npx claude-mem doctor`; no retry was queued.", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
