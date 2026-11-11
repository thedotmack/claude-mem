"""Explicit memory using AG2 1.x's MCPToolkit and native tool events."""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

from ag2.context import ConversationContext
from ag2.events import TextInput, ToolCallEvent, ToolErrorEvent
from ag2.stream import MemoryStream
from ag2.tools import MCPStdioServerConfig, MCPToolkit

MEMORY_TOOLS = frozenset({"save_memory", "search", "timeline", "get_observations"})


class ProjectMemory:
    """Run explicit tool events; each SDK operation closes its own MCP session."""

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
        self.toolkit = MCPToolkit(MCPStdioServerConfig(
            command="node", args=[str(script)], env=child_env,
            allowed_tools=sorted(MEMORY_TOOLS), protocol_mode="legacy",
        ))
        self.context = ConversationContext(MemoryStream())
        self.tools = {}

    async def discover(self):
        async with asyncio.timeout(self.timeout):
            await self.toolkit.schemas(self.context)
        self.tools = {tool.name: tool for tool in self.toolkit.tools}
        if self.tools.keys() != MEMORY_TOOLS:
            raise RuntimeError("The installed MCP server lacks the four memory tools")
        return self.tools

    async def call(self, name, arguments):
        if name not in MEMORY_TOOLS:
            raise ValueError("Only explicit memory operations are available")
        if not self.tools:
            await self.discover()
        values = {**arguments, "project": self.project}
        values.pop("projects", None)
        if name != "save_memory":
            # JSON keeps literal commas exact across the MCP query-string transport.
            # The explicit list also prevents parent/worktree scope expansion.
            values["projects"] = json.dumps([self.project])
        if name == "save_memory":
            fingerprint = hashlib.sha256(json.dumps(
                [self.project, values.get("title", ""), values.get("text", "")], ensure_ascii=False,
            ).encode()).hexdigest()
            values["metadata"] = {"integration": "ag2", "platformSource": "ag2",
                                  "sourceFingerprint": "ag2-example-v1:" + fingerprint}
        event = ToolCallEvent(name, arguments=json.dumps(values))
        async with asyncio.timeout(self.timeout):
            result = await self.tools[name](event, self.context)
        if isinstance(result, ToolErrorEvent):
            raise RuntimeError(name + " failed; check the local worker before retrying")
        if not result.result.parts or any(not isinstance(part, TextInput) for part in result.result.parts):
            raise RuntimeError("Unexpected memory tool response")
        return "\n".join(part.content for part in result.result.parts)


async def remember(memory, title, text):
    if not title.strip() or not text.strip():
        raise ValueError("Provide a title and an explicit note")
    receipt = await memory.call("save_memory", {"title": title, "text": text})
    match = re.search(r"(?:Saved memory|Memory already saved as) #(\d+)", receipt)
    if match is None:
        raise RuntimeError("The worker did not confirm a saved observation")
    observation_id = int(match[1])
    index = await memory.call("search", {"query": "", "type": "observations", "limit": 5})
    await memory.call("timeline", {"anchor": observation_id, "depth_before": 0, "depth_after": 0})
    details = await memory.call("get_observations", {"ids": [observation_id]})
    if not re.search(rf"^#{observation_id}\s+—", details, re.MULTILINE):
        raise RuntimeError("The confirmed observation is unavailable in this project")
    return {"id": observation_id, "project": memory.project, "index": index, "details": details}


async def run(args):
    async with asyncio.timeout(60):
        memory = ProjectMemory(args.mcp_server, args.project)
        return await remember(memory, args.title, args.text)


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
