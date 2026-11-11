"""Recall a selected observation and save a handoff through a model-free LangGraph."""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import TypedDict

from fastmcp import Client
from fastmcp.client.transports import StdioTransport
from langchain.mcp import MCPAdapter
from langgraph.graph import END, START, StateGraph


class MemoryState(TypedDict, total=False):
    project: str
    query: str
    observation_id: int
    note: str
    run_id: str
    index: str
    timeline: str
    recalled: str
    saved: str
    saved_id: int


def text_content(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(block["text"] for block in content
                     if isinstance(block, dict) and block.get("type") == "text")


async def run_workflow(state: MemoryState, *, timeout: float = 10) -> MemoryState:
    if any(not state.get(key, "").strip() for key in ("project", "query", "note", "run_id")):
        raise ValueError("project, query, note and run_id must be nonempty")
    if state.get("observation_id", 0) <= 0 or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("observation_id and timeout must be positive")
    script = Path(os.environ["CLAUDE_MEM_MCP_SERVER"]).expanduser().resolve(strict=True)
    # Keep the selected worker/data directory and its existing settings. This
    # example never starts a worker, changes configuration, or retries a save.
    keys = {"CLAUDE_MEM_DATA_DIR", "CLAUDE_MEM_WORKER_HOST", "CLAUDE_MEM_WORKER_PORT",
            "CLAUDE_MEM_MODES_DIR", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "PATH", "LANG",
            "LC_ALL", "SystemRoot", "WINDIR", "TMPDIR", "DO_NOT_TRACK"}
    env = {key: value for key, value in os.environ.items() if key in keys}
    env.update(CLAUDE_MEM_RUNTIME="worker", CLAUDE_MEM_WORKER_AUTOSTART="false")
    client = Client(StdioTransport(command="node", args=[str(script)], env=env,
                                   keep_alive=False), timeout=timeout, init_timeout=timeout)

    # The adapter owns its subprocess for the entire graph. An outer bound
    # covers discovery and cleanup as well as the individual MCP call timeout.
    async with asyncio.timeout(timeout * 8):
        async with MCPAdapter(client) as adapter:
            discovered = await adapter.list_tools()
            names = {"search", "timeline", "get_observations", "save_memory"}
            tools = {tool.name: tool for tool in discovered if tool.name in names}
            if tools.keys() != names:
                raise RuntimeError("The selected Claude-Mem worker MCP tools are unavailable")

            async def call(name: str, values: dict) -> str:
                message = await tools[name].ainvoke({
                    "type": "tool_call", "id": "memory-" + name, "name": name, "args": values,
                })
                if message.status != "success":
                    raise RuntimeError("Claude-Mem reported a failed " + name + " request")
                return text_content(message.content)

            async def recall(s: MemoryState) -> dict:
                # An explicit list prevents checkout aliases/parent projects
                # from widening this application's caller-selected boundary.
                scope = {"project": s["project"], "projects": json.dumps([s["project"]])}
                index = await call("search", {**scope, "query": s["query"], "type": "observations", "limit": 20})
                # The caller chooses one known ID; never let returned text choose
                # a different project, tool, or action.
                if not re.search(rf"\|\s*#{s['observation_id']}\s*\|", index):
                    raise RuntimeError("The selected observation is absent from this project's search page")
                timeline = await call("timeline", {**scope, "anchor": s["observation_id"], "depth_before": 1, "depth_after": 1})
                recalled = await call("get_observations", {**scope, "ids": [s["observation_id"]]})
                if not re.search(rf"^#{s['observation_id']}\s+—", recalled, re.MULTILINE):
                    raise RuntimeError("The selected observation is unavailable in this project")
                return {"index": index, "timeline": timeline, "recalled": recalled}

            async def remember(s: MemoryState) -> dict:
                # Explicit run identity + content makes a deliberate rerun safe,
                # using the worker's existing sourceFingerprint contract.
                fingerprint = hashlib.sha256(json.dumps(
                    ["langgraph", s["project"], s["run_id"], s["note"]],
                    ensure_ascii=False, separators=(",", ":"),
                ).encode()).hexdigest()
                saved = await call("save_memory", {
                    "project": s["project"], "text": s["note"],
                    "title": "LangGraph handoff", "metadata": {
                        "integration": "langgraph", "platformSource": "langgraph", "runId": s["run_id"],
                        "sourceFingerprint": fingerprint,
                    },
                })
                match = re.search(r"(?:Saved memory|Memory already saved as) #(\d+)", saved)
                if not match:
                    raise RuntimeError("Claude-Mem did not confirm that the handoff was saved")
                return {"saved": saved, "saved_id": int(match.group(1))}

            graph = StateGraph(MemoryState)
            graph.add_node("recall", recall)
            graph.add_node("remember", remember)
            graph.add_edge(START, "recall")
            graph.add_edge("recall", "remember")
            graph.add_edge("remember", END)
            return await graph.compile().ainvoke(state)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("project", "query", "note", "run-id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--observation-id", type=int, required=True)
    args = parser.parse_args()
    try:
        result = asyncio.run(run_workflow(vars(args)))
    except (Exception, KeyboardInterrupt):
        print("Memory workflow failed. Check the worker, MCP script path, project and selected ID; "
              "no successful save is assumed. Inspect your worker logs before retrying the same run ID.", file=sys.stderr)
        return 1
    print(json.dumps({key: result[key] for key in ("project", "recalled", "saved", "saved_id")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
