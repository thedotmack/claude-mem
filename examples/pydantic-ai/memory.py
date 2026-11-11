"""Explicit project memory through Pydantic AI's native MCP toolset."""

import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any

from fastmcp.client.transports import StdioTransport
from pydantic_ai.mcp import MCPToolset


MEMORY_TOOLS = frozenset({"save_memory", "search", "timeline", "get_observations"})
DEMO_TITLE = "Pydantic AI release checklist"
DEMO_NOTE = "Run the smoke suite before releasing the application."


def scoped_arguments(name: str, arguments: dict[str, Any], project: str) -> dict[str, Any]:
    """Bind every operation to the caller's project, including detail reads."""
    if name not in MEMORY_TOOLS or not project.strip():
        raise ValueError("Choose a nonempty project and one of the four memory tools.")
    result = {**arguments, "project": project.strip()}
    result.pop("projects", None)
    if name == "save_memory":
        text = result.get("text")
        title = result.get("title", "")
        if not isinstance(text, str) or not text.strip() or not isinstance(title, str):
            raise ValueError("A memory needs nonempty text and an optional text title.")
        # The existing save contract deduplicates a fingerprint within project and platform.
        fingerprint = hashlib.sha256(json.dumps(
            [project.strip(), title.strip(), text.strip()], ensure_ascii=False,
        ).encode()).hexdigest()
        result["metadata"] = {
            "integration": "pydantic-ai",
            "platformSource": "pydantic-ai",
            "sourceFingerprint": f"pydantic-ai-example-v1:{fingerprint}",
        }
    return result


def memory_toolset(project: str, server: str, cwd: str, *, timeout: float = 30) -> MCPToolset:
    """Use an installed Claude-Mem MCP bundle and an already-running local worker."""
    if not project.strip() or not Path(server).is_file() or not Path(cwd).is_dir():
        raise ValueError("Set a project, an existing MCP server file and a working directory.")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("The request timeout must be finite and positive.")

    async def process_tool_call(_ctx, call_tool, name, arguments):
        return await call_tool(name, scoped_arguments(name, arguments, project))

    return MCPToolset(
        StdioTransport(
            command="node", args=[str(Path(server).resolve())], cwd=str(Path(cwd).resolve()),
            env={**os.environ, "CLAUDE_MEM_RUNTIME": "worker", "CLAUDE_MEM_WORKER_AUTOSTART": "false"},
        ),
        id="claude-mem", init_timeout=timeout, read_timeout=timeout,
        tool_error_behavior="error", max_retries=0, include_instructions=False,
        process_tool_call=process_tool_call,
    )


async def call_memory(memory: MCPToolset, project: str, name: str, arguments: dict[str, Any]) -> str:
    result = await memory.direct_call_tool(name, scoped_arguments(name, arguments, project))
    if not isinstance(result, str):
        raise ValueError("Claude-Mem returned an unexpected response; no success was confirmed.")
    return result


async def demonstrate(memory: MCPToolset, project: str) -> dict[str, Any]:
    """Exercise the actual SDK and memory tools without making a model request."""
    async with memory:
        names = {tool.name for tool in await memory.list_tools()}
        if not MEMORY_TOOLS <= names:
            raise ValueError("The selected MCP server does not provide the worker memory tools.")
        saved = await call_memory(memory, project, "save_memory", {"title": DEMO_TITLE, "text": DEMO_NOTE})
        match = re.search(r"(?:Saved memory #|Memory already saved as #)(\d+)", saved)
        if match is None:
            raise ValueError("Claude-Mem did not confirm a saved observation.")
        observation_id = int(match[1])
        index = await call_memory(memory, project, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 5})
        if not re.search(rf"#{observation_id}\b", index):
            raise ValueError("The saved observation was not found in this project's search index.")
        await call_memory(memory, project, "timeline", {"anchor": observation_id, "depth_before": 0, "depth_after": 0})
        details = await call_memory(memory, project, "get_observations", {"ids": [observation_id]})
        if DEMO_NOTE not in details:
            raise ValueError("The selected observation could not be recalled.")
        return {"project": project, "observation_id": observation_id, "recalled": True, "model_requests": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--mcp-server", default=os.environ.get("CLAUDE_MEM_MCP_SERVER", ""))
    args = parser.parse_args()
    try:
        memory = memory_toolset(args.project, args.mcp_server, args.cwd)
        result = asyncio.run(asyncio.wait_for(demonstrate(memory, args.project), timeout=60))
    except (Exception, KeyboardInterrupt):
        print("Memory verification failed. Check the MCP file, project and worker with `npx claude-mem doctor`; no retry was queued.", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
