"""Recall a selected observation and save a handoff with a LlamaIndex Workflow."""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

from llama_index.core.workflow import Event, StartEvent, StopEvent, Workflow, step
from llama_index.tools.mcp import McpToolSpec
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

MEMORY_TOOLS = ["search", "timeline", "get_observations", "save_memory"]


class Recalled(Event):
    state: dict
    index: str
    timeline: str
    recalled: str


class MemoryWorkflow(Workflow):
    def __init__(self, tools, *, timeout):
        super().__init__(timeout=timeout)
        self.tools = tools

    async def call(self, name, **values):
        output = await self.tools[name].acall(**values)
        # FunctionTool wraps the raw MCP result; its outer is_error flag does
        # not by itself express a server-reported MCP execution error.
        result = output.raw_output
        if output.is_error or result.is_error:
            raise RuntimeError("Claude-Mem reported a failed " + name + " request")
        return "\n".join(block.text for block in result.content if block.type == "text")

    @step
    async def recall(self, event: StartEvent) -> Recalled:
        state = event.state
        index = await self.call("search", query=state["query"], type="observations", limit=20)
        if not re.search(rf"\|\s*#{state['observation_id']}\s*\|", index):
            raise RuntimeError("The selected observation is absent from this project's search page")
        timeline = await self.call("timeline", anchor=state["observation_id"], depth_before=1, depth_after=1)
        recalled = await self.call("get_observations", ids=[state["observation_id"]])
        if not re.search(rf"^#{state['observation_id']}\s+—", recalled, re.MULTILINE):
            raise RuntimeError("The selected observation is unavailable in this project")
        return Recalled(state=state, index=index, timeline=timeline, recalled=recalled)

    @step
    async def remember(self, event: Recalled) -> StopEvent:
        state = event.state
        fingerprint = hashlib.sha256(json.dumps(
            ["llamaindex", state["project"], state["run_id"], state["note"]],
            ensure_ascii=False, separators=(",", ":"),
        ).encode()).hexdigest()
        saved = await self.call("save_memory", text=state["note"], title="LlamaIndex handoff", metadata={
            "integration": "llamaindex", "platformSource": "llamaindex", "runId": state["run_id"],
            "sourceFingerprint": fingerprint,
        })
        match = re.search(r"(?:Saved memory|Memory already saved as) #(\d+)", saved)
        if not match:
            raise RuntimeError("Claude-Mem did not confirm that the handoff was saved")
        return StopEvent(result={**state, "index": event.index, "timeline": event.timeline,
                                 "recalled": event.recalled, "saved": saved, "saved_id": int(match.group(1))})


async def run_workflow(state: dict, *, timeout: float = 10) -> dict:
    if any(not state.get(key, "").strip() for key in ("project", "query", "note", "run_id")):
        raise ValueError("project, query, note and run_id must be nonempty")
    if state.get("observation_id", 0) <= 0 or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("observation_id and timeout must be positive and finite")
    script = Path(os.environ["CLAUDE_MEM_MCP_SERVER"]).expanduser().resolve(strict=True)
    keys = {"CLAUDE_MEM_DATA_DIR", "CLAUDE_MEM_WORKER_HOST", "CLAUDE_MEM_WORKER_PORT",
            "CLAUDE_MEM_MODES_DIR", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "PATH", "LANG",
            "LC_ALL", "SystemRoot", "WINDIR", "TMPDIR", "DO_NOT_TRACK"}
    env = {key: value for key, value in os.environ.items() if key in keys}
    env.update(CLAUDE_MEM_RUNTIME="worker", CLAUDE_MEM_WORKER_AUTOSTART="false")
    parameters = StdioServerParameters(command="node", args=[str(script)], env=env)
    # LlamaIndex accepts an initialized MCP session, so all workflow steps share
    # one bounded connection and close the subprocess with the workflow.
    async with asyncio.timeout(timeout * 8):
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write, read_timeout_seconds=timeout) as session:
                await session.initialize()
                spec = McpToolSpec(client=session, allowed_tools=MEMORY_TOOLS,
                                   global_partial_params={"project": state["project"]})
                tools = {tool.metadata.name: tool for tool in await spec.to_tool_list_async()}
                if tools.keys() != set(MEMORY_TOOLS):
                    raise RuntimeError("The selected Claude-Mem worker MCP tools are unavailable")
                workflow = MemoryWorkflow(tools, timeout=timeout * 6)
                return await workflow.run(state=state)


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
