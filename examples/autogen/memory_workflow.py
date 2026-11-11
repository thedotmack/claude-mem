"""Explicit project memory through AutoGen's native MCP workbench."""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

from autogen_ext.tools.mcp import McpWorkbench, StdioServerParams

MEMORY_TOOLS = frozenset({"save_memory", "search", "timeline", "get_observations"})


class MemoryWorkbench(McpWorkbench):
    """Offer only memory tools and bind every call to an application-owned project."""

    def __init__(self, script, project, *, timeout=10, env=None):
        if not project.strip() or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("A project and finite positive timeout are required")
        self.project, self.timeout = project, timeout
        script = Path(script).expanduser().resolve(strict=True)
        keys = {"PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "WINDIR", "DO_NOT_TRACK",
                "CLAUDE_MEM_DATA_DIR", "CLAUDE_MEM_WORKER_HOST", "CLAUDE_MEM_WORKER_PORT",
                "CLAUDE_MEM_MODES_DIR", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"}
        child_env = {key: value for key, value in (os.environ if env is None else env).items() if key in keys}
        child_env.update(CLAUDE_MEM_RUNTIME="worker", CLAUDE_MEM_WORKER_AUTOSTART="false")
        super().__init__(StdioServerParams(command="node", args=[str(script)], env=child_env,
                                          read_timeout_seconds=timeout))

    async def list_tools(self):
        async with asyncio.timeout(self.timeout):
            tools = [tool for tool in await super().list_tools() if tool["name"] in MEMORY_TOOLS]
        if {tool["name"] for tool in tools} != MEMORY_TOOLS:
            raise RuntimeError("The installed server does not provide the four memory tools")
        return tools

    async def call_tool(self, name, arguments=None, cancellation_token=None, call_id=None):
        if name not in MEMORY_TOOLS:
            raise ValueError("Only the four memory tools are available")
        values = {**(arguments or {}), "project": self.project}
        values.pop("projects", None)
        if name != "save_memory":
            # JSON keeps literal commas exact across the MCP query-string transport.
            # The explicit list also prevents parent/worktree scope expansion.
            values["projects"] = json.dumps([self.project])
        if name == "save_memory":
            fingerprint = hashlib.sha256(json.dumps(
                [self.project, values.get("title", ""), values.get("text", "")], ensure_ascii=False,
            ).encode()).hexdigest()
            values["metadata"] = {"integration": "autogen", "platformSource": "autogen",
                                  "sourceFingerprint": "autogen-example-v1:" + fingerprint}
        async with asyncio.timeout(self.timeout):
            return await super().call_tool(name, values, cancellation_token, call_id)


async def call_text(workbench, name, arguments):
    result = await workbench.call_tool(name, arguments)
    if result.is_error:
        raise RuntimeError(name + " failed; check the local worker before retrying")
    if not result.result or any(part.type != "TextResultContent" for part in result.result):
        raise RuntimeError("Unexpected memory tool response")
    return result.to_text()


async def remember(workbench, title, text):
    if not title.strip() or not text.strip():
        raise ValueError("Provide a title and an explicit note")
    await workbench.list_tools()
    receipt = await call_text(workbench, "save_memory", {"title": title, "text": text})
    match = re.search(r"(?:Saved memory|Memory already saved as) #(\d+)", receipt)
    if match is None:
        raise RuntimeError("The worker did not confirm a saved observation")
    observation_id = int(match[1])
    index = await call_text(workbench, "search", {"query": "", "type": "observations", "limit": 5})
    # A repeat may refer to an older note outside the current search page.
    await call_text(workbench, "timeline", {"anchor": observation_id, "depth_before": 0, "depth_after": 0})
    details = await call_text(workbench, "get_observations", {"ids": [observation_id]})
    if not re.search(rf"^#{observation_id}\s+—", details, re.MULTILINE):
        raise RuntimeError("The confirmed observation is unavailable in this project")
    return {"id": observation_id, "project": workbench.project, "index": index, "details": details}


async def run(args):
    async with asyncio.timeout(60):
        async with MemoryWorkbench(args.mcp_server, args.project) as workbench:
            return await remember(workbench, args.title, args.text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-server", default=os.environ.get("CLAUDE_MEM_MCP_SERVER", ""))
    for name in ("project", "title", "text"):
        parser.add_argument("--" + name, required=True)
    try:
        result = asyncio.run(run(parser.parse_args()))
    except (Exception, KeyboardInterrupt):
        print("Memory workflow failed. Check the MCP path, project and local worker; no success is assumed or retry queued.", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
