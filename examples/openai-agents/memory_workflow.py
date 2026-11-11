"""Explicit project memory through the OpenAI Agents SDK's local MCP client."""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

from agents.mcp import MCPServerStdio, create_static_tool_filter

MEMORY_TOOLS = ["save_memory", "search", "timeline", "get_observations"]


def memory_server(script: str, timeout: float = 10, env=None) -> MCPServerStdio:
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be a positive finite number")
    path = Path(script).expanduser().resolve(strict=True)
    source = os.environ if env is None else env
    # Local worker settings only; no model credentials are needed by this client.
    keys = {"CLAUDE_MEM_DATA_DIR", "CLAUDE_MEM_WORKER_HOST", "CLAUDE_MEM_WORKER_PORT",
            "CLAUDE_MEM_MODES_DIR", "CLAUDE_CONFIG_DIR", "PATH", "LANG", "LC_ALL",
            "SystemRoot", "WINDIR", "DO_NOT_TRACK"}
    child_env = {key: value for key, value in source.items() if key in keys}
    child_env.update(CLAUDE_MEM_RUNTIME="worker", CLAUDE_MEM_WORKER_AUTOSTART="false")
    return MCPServerStdio(
        name="Claude-Mem",
        params={"command": "node", "args": [str(path)], "env": child_env},
        client_session_timeout_seconds=timeout,
        max_retry_attempts=0,
        tool_filter=create_static_tool_filter(allowed_tool_names=MEMORY_TOOLS),
    )


async def call(server: MCPServerStdio, name: str, arguments: dict) -> str:
    if name in {"search", "timeline", "get_observations"}:
        project = arguments.get("project")
        if not isinstance(project, str) or not project.strip():
            raise ValueError("Choose an explicit project for memory reads")
        # Prevent the MCP checkout helper from adding parent/worktree read keys.
        arguments = {**arguments, "projects": [project]}
    result = await server.call_tool(name, arguments)
    if result.is_error:
        raise RuntimeError(f"{name} failed; check the worker connection and arguments")
    return "\n".join(block.text for block in result.content if block.type == "text")


async def remember(server: MCPServerStdio, project: str, title: str, text: str) -> dict:
    if not project.strip() or not title.strip() or not text.strip():
        raise ValueError("project, title and text must be nonempty")
    project, title, text = project.strip(), title.strip(), text.strip()
    available = {tool.name for tool in await server.list_tools()}
    if not set(MEMORY_TOOLS) <= available:
        raise RuntimeError("The selected MCP server does not expose the required memory tools")
    fingerprint = hashlib.sha256(json.dumps([project, title, text], ensure_ascii=False).encode()).hexdigest()
    saved = await call(server, "save_memory", {
        "project": project, "title": title, "text": text,
        "metadata": {"integration": "openai-agents-sdk", "platformSource": "openai-agents",
                     "sourceFingerprint": "openai-agents:" + fingerprint},
    })
    match = re.search(r"(?:Saved memory|Memory already saved as) #(\d+)\b", saved)
    if match is None:
        raise RuntimeError("The save did not return a confirmed observation ID")
    observation_id = int(match[1])
    # A replay may point to a note older than the recent page. Its save receipt
    # already confirms the selected ID; falling off that page is not a failure.
    index = await call(server, "search", {"query": "", "project": project, "type": "observations", "limit": 20})
    await call(server, "timeline", {"anchor": observation_id, "project": project, "depth_before": 0, "depth_after": 0})
    details = await call(server, "get_observations", {"ids": [observation_id], "project": project})
    if not re.search(rf"#{observation_id}\b", details):
        raise RuntimeError("The selected observation could not be retrieved")
    return {"id": observation_id, "project": project, "index": index, "details": details}


async def run(args):
    # One task owns connect, calls and cleanup; the context manager closes its child.
    async with asyncio.timeout(60):
        async with memory_server(args.mcp_server, args.timeout) as server:
            return await remember(server, args.project, args.title, args.text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-server", default=os.environ.get("CLAUDE_MEM_MCP_SERVER"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--timeout", type=float, default=10)
    args = parser.parse_args()
    if not args.mcp_server:
        parser.error("set --mcp-server to the installed plugin/scripts/mcp-server.cjs")
    try:
        result = asyncio.run(run(args))
    except (Exception, KeyboardInterrupt) as error:
        print(f"Memory workflow failed ({type(error).__name__}). Check the MCP path and running local worker; no automatic retry was made.", file=sys.stderr)
        return 1
    print(result["index"])
    print(result["details"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
