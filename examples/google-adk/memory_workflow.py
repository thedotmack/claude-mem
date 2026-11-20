"""Run a model-free Google ADK agent that recalls and explicitly saves project memory."""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

from google.adk.agents import BaseAgent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.events import Event
from google.adk.runners import InMemoryRunner
from google.adk.tools.mcp_tool import McpToolset, StdioConnectionParams
from google.adk.tools.tool_context import ToolContext
from google.genai import types
from mcp import StdioServerParameters

MEMORY_TOOLS = ["search", "timeline", "get_observations", "save_memory"]


class MemoryAgent(BaseAgent):
    memory_input: dict
    server_script: str
    worker_env: dict[str, str]
    request_timeout: float

    async def _run_async_impl(self, context):
        toolset = McpToolset(
            connection_params=StdioConnectionParams(
                server_params=StdioServerParameters(command="node", args=[self.server_script], env=self.worker_env),
                timeout=self.request_timeout,
            ),
            tool_filter=MEMORY_TOOLS,
        )
        try:
            tools = {tool.name: tool for tool in await toolset.get_tools(readonly_context=ReadonlyContext(context))}
            if tools.keys() != set(MEMORY_TOOLS):
                raise RuntimeError("The selected Claude-Mem worker MCP tools are unavailable")
            state = self.memory_input

            async def call(name, **values):
                args = {**values, "project": state["project"]}
                if name in ("search", "timeline", "get_observations"):
                    args["projects"] = json.dumps([state["project"]])
                result = await tools[name].run_async(
                    args=args,
                    tool_context=ToolContext(context, function_call_id="memory-" + name),
                )
                # ADK returns the MCP envelope as a dict, and may also return
                # a graceful error dict for transport failures. Neither is success.
                error = result.get("error")
                if error == "MCP tool execution failed: Request 'tools/call' timed out":
                    raise TimeoutError("The MCP request timed out")
                if result.get("isError") or result.get("is_error") or "error" in result:
                    raise RuntimeError("Claude-Mem reported a failed " + name + " request")
                return "\n".join(block["text"] for block in result.get("content", []) if block.get("type") == "text")

            index = await call("search", query=state["query"], type="observations", limit=20)
            if not re.search(rf"\|\s*#{state['observation_id']}\s*\|", index):
                raise RuntimeError("The selected observation is absent from this project's search page")
            timeline = await call("timeline", anchor=state["observation_id"], depth_before=1, depth_after=1)
            recalled = await call("get_observations", ids=[state["observation_id"]])
            if not re.search(rf"^#{state['observation_id']}\s+—", recalled, re.MULTILINE):
                raise RuntimeError("The selected observation is unavailable in this project")
            fingerprint = hashlib.sha256(json.dumps(
                ["google-adk", state["project"], state["run_id"], state["note"]],
                ensure_ascii=False, separators=(",", ":"),
            ).encode()).hexdigest()
            saved = await call("save_memory", text=state["note"], title="Google ADK handoff", metadata={
                "integration": "google-adk", "platformSource": "google-adk", "runId": state["run_id"],
                "adkSessionId": context.session.id, "sourceFingerprint": fingerprint,
            })
            match = re.search(r"(?:Saved memory|Memory already saved as) #(\d+)", saved)
            if not match:
                raise RuntimeError("Claude-Mem did not confirm that the handoff was saved")
            result = {**state, "index": index, "timeline": timeline, "recalled": recalled,
                      "saved": saved, "saved_id": int(match.group(1)), "adk_session_id": context.session.id}
            yield Event(author=self.name, content=types.Content(role="model", parts=[types.Part(text=json.dumps(result))]))
        finally:
            await toolset.close()


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
    agent = MemoryAgent(name="claude_mem_handoff", memory_input=state, server_script=str(script),
                        worker_env=env, request_timeout=timeout)
    runner = InMemoryRunner(agent=agent, app_name="claude_mem_example")
    async with asyncio.timeout(timeout * 8):
        try:
            session = await runner.session_service.create_session(
                app_name="claude_mem_example", user_id="local-user", session_id=state["run_id"],
            )
            result = None
            async for event in runner.run_async(
                user_id="local-user", session_id=session.id,
                new_message=types.Content(role="user", parts=[types.Part(text="Recall the selected note and save the supplied handoff.")]),
            ):
                if event.author == agent.name and event.is_final_response():
                    result = json.loads(event.content.parts[0].text)
            if result is None:
                raise RuntimeError("The ADK runner did not return a completed handoff")
            return result
        finally:
            await runner.close()


def failure_reason(error: BaseException) -> str:
    if isinstance(error, KeyError) and error.args == ("CLAUDE_MEM_MCP_SERVER",):
        return "CLAUDE_MEM_MCP_SERVER is not set. Select the installed MCP script."
    if isinstance(error, FileNotFoundError):
        return "The configured MCP script was not found. Check its path."
    if isinstance(error, TimeoutError):
        return "A memory request or the workflow timed out. Check worker responsiveness."
    if isinstance(error, KeyboardInterrupt):
        return "The workflow was cancelled."
    safe_messages = {
        "project, query, note and run_id must be nonempty",
        "observation_id and timeout must be positive and finite",
        "The selected Claude-Mem worker MCP tools are unavailable",
        "The selected observation is absent from this project's search page",
        "The selected observation is unavailable in this project",
        "Claude-Mem did not confirm that the handoff was saved",
        "The ADK runner did not return a completed handoff",
        *("Claude-Mem reported a failed " + name + " request" for name in MEMORY_TOOLS),
    }
    # Only known, content-free messages reach stderr. Native exceptions can
    # contain arguments, paths, or returned data that should not be echoed.
    if isinstance(error, (ValueError, RuntimeError)) and str(error) in safe_messages:
        return str(error) + "."
    return "The native ADK/MCP workflow did not complete. Check worker connectivity."


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("project", "query", "note", "run-id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--observation-id", type=int, required=True)
    parser.add_argument("--timeout", type=float, default=10, help="Seconds per MCP request (default: 10)")
    args = parser.parse_args()
    state = vars(args)
    timeout = state.pop("timeout")
    try:
        result = asyncio.run(run_workflow(state, timeout=timeout))
    except (Exception, KeyboardInterrupt) as error:
        print("Memory workflow failed: " + failure_reason(error) +
              " No successful save is assumed; inspect saved notes before retrying the same run ID.", file=sys.stderr)
        return 1
    print(json.dumps({key: result[key] for key in ("project", "recalled", "saved", "saved_id", "adk_session_id")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
