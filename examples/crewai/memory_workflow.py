"""Save an explicit project note and recall its receipt through a native CrewAI Flow."""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

# Set both controls before importing CrewAI: telemetry and tracing are separate.
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["CREWAI_TRACING_ENABLED"] = "false"

from crewai.flow.flow import Flow, listen, start
from crewai.events.event_listener import event_listener
from crewai.mcp.client import MCPClient
from crewai.mcp.transports import StdioTransport
from pydantic import BaseModel, Field

MEMORY_TOOLS = {"search", "timeline", "get_observations", "save_memory"}

# The standalone example prints its final result, not native MCP argument panels.
event_listener.formatter.verbose = False


async def call_memory(client: MCPClient, project: str, name: str, **values) -> str:
    if name in ("search", "timeline", "get_observations"):
        values["projects"] = json.dumps([project])
    result = await client.call_tool_result(name, {**values, "project": project})
    # call_tool() returns text alone; retain the MCP error flag before using it.
    if result.is_error:
        raise RuntimeError("Claude-Mem reported a failed " + name + " request")
    return result.content


class MemoryState(BaseModel):
    project: str = ""
    note: str = ""
    run_id: str = ""
    saved_id: int = 0
    saved: str = ""
    index: str = ""
    timeline: str = ""
    recalled: str = ""


class MemoryFlow(Flow[MemoryState]):
    client: MCPClient = Field(exclude=True)

    @start()
    async def remember(self):
        state = self.state
        fingerprint = hashlib.sha256(json.dumps(
            ["crewai", state.project, state.run_id, state.note],
            ensure_ascii=False, separators=(",", ":"),
        ).encode()).hexdigest()
        state.saved = await call_memory(
            self.client, state.project, "save_memory", text=state.note,
            title="CrewAI handoff", metadata={
                "integration": "crewai", "platformSource": "crewai",
                "runId": state.run_id, "crewaiFlowId": state.id,
                "sourceFingerprint": fingerprint,
            },
        )
        match = re.search(r"(?:Saved memory|Memory already saved as) #(\d+)", state.saved)
        if not match:
            raise RuntimeError("Claude-Mem did not confirm that the handoff was saved")
        state.saved_id = int(match.group(1))
        return state.saved_id

    @listen(remember)
    async def recall(self, saved_id):
        state = self.state
        state.index = await call_memory(
            self.client, state.project, "search", query="", type="observations", limit=20,
        )
        # A repeated save may return an older ID outside the recent index. Its
        # confirmed receipt remains the target for project-scoped detail reads.
        state.timeline = await call_memory(
            self.client, state.project, "timeline", anchor=saved_id, depth_before=1, depth_after=1,
        )
        state.recalled = await call_memory(
            self.client, state.project, "get_observations", ids=[saved_id],
        )
        if not re.search(rf"^#{saved_id}\s+—", state.recalled, re.MULTILINE):
            raise RuntimeError("The confirmed observation is unavailable in this project")
        return {**state.model_dump(), "flow_id": state.id}


def memory_client(timeout: float = 10) -> MCPClient:
    script = Path(os.environ["CLAUDE_MEM_MCP_SERVER"]).expanduser().resolve(strict=True)
    keys = {"CLAUDE_MEM_DATA_DIR", "CLAUDE_MEM_WORKER_HOST", "CLAUDE_MEM_WORKER_PORT",
            "CLAUDE_MEM_MODES_DIR", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "PATH", "LANG",
            "LC_ALL", "SystemRoot", "WINDIR", "TMPDIR", "DO_NOT_TRACK"}
    env = {key: value for key, value in os.environ.items() if key in keys}
    env.update(CLAUDE_MEM_RUNTIME="worker", CLAUDE_MEM_WORKER_AUTOSTART="false")
    return MCPClient(
        StdioTransport(command="node", args=[str(script)], env=env),
        connect_timeout=timeout, execution_timeout=timeout, discovery_timeout=timeout,
        max_retries=1,  # CrewAI counts attempts here: one means no retry.
    )


async def run_workflow(state: dict, *, timeout: float = 10) -> dict:
    if any(not state.get(key, "").strip() for key in ("project", "note", "run_id")):
        raise ValueError("project, note and run_id must be nonempty")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be positive and finite")
    async with asyncio.timeout(timeout * 8):
        async with memory_client(timeout) as client:
            available = {tool["name"] for tool in await client.list_tools()}
            if not MEMORY_TOOLS.issubset(available):
                raise RuntimeError("The selected Claude-Mem worker MCP tools are unavailable")
            flow = MemoryFlow(
                initial_state=MemoryState(**state), client=client,
                tracing=False, suppress_flow_events=True, memory=None,
            )
            return await flow.kickoff_async()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("project", "note", "run-id"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        result = asyncio.run(run_workflow(vars(args)))
    except (Exception, KeyboardInterrupt):
        print("Memory workflow failed. Check the worker, MCP script path and project; "
              "no successful save is assumed. Inspect your worker logs before retrying the same run ID.", file=sys.stderr)
        return 1
    print(json.dumps({key: result[key] for key in ("project", "recalled", "saved", "saved_id", "flow_id")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
