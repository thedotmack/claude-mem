"""Explicit notes and a two-executor recall workflow; no model client required."""
import argparse
import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from typing import Never

from agent_framework import MCPStdioTool, WorkflowBuilder, WorkflowContext, executor


def memory_connection() -> MCPStdioTool:
    script = Path(os.environ.get("CLAUDE_MEM_MCP_SERVER", ""))
    node = shutil.which("node")
    if not script.is_absolute() or not script.is_file() or not node:
        raise ValueError("Set the absolute CLAUDE_MEM_MCP_SERVER path and install Node.js.")
    return MCPStdioTool(
        name="claude-mem", command=node, args=[str(script)],
        env={**os.environ, "CLAUDE_MEM_RUNTIME": "worker", "CLAUDE_MEM_WORKER_AUTOSTART": "false"},
        allowed_tools=["save_memory", "search", "timeline", "get_observations"],
        load_prompts=False, request_timeout=10,
    )


def text_content(result) -> str:
    if isinstance(result, str):
        return result
    return "\n".join(item.text for item in result if item.type == "text" and item.text)


async def save_note(project: str, title: str, text: str) -> str:
    if not all(value.strip() for value in (project, title, text)):
        raise ValueError("Project, title and note text must be nonempty.")
    identity = hashlib.sha256(json.dumps([project, title, text], ensure_ascii=False).encode()).hexdigest()
    async with asyncio.timeout(30), memory_connection() as memory:
        return text_content(await memory.call_tool(
            "save_memory", project=project, title=title, text=text,
            metadata={"platformSource": "microsoft-agent-framework", "sourceFingerprint": f"ms-agent:{identity}"},
        ))


@dataclass
class SelectedNote:
    project: str
    query: str
    observation_id: int
    index: str = ""


async def recall_note(selected: SelectedNote) -> dict[str, str]:
    if not selected.project.strip() or not selected.query.strip() or selected.observation_id < 1:
        raise ValueError("Choose a project, query and positive observation ID.")
    async with asyncio.timeout(60), memory_connection() as memory:
        @executor(id="find_selected_memory")
        async def find_note(request: SelectedNote, ctx: WorkflowContext[SelectedNote]) -> None:
            index = text_content(await memory.call_tool(
                "search", project=request.project, query=request.query, type="observations", limit=20,
            ))
            # A known ID can be older than the index page. Detail reads carry
            # the same project; the page is context, not a save receipt.
            await ctx.send_message(SelectedNote(request.project, request.query, request.observation_id, index))

        @executor(id="read_selected_memory")
        async def read_note(request: SelectedNote, ctx: WorkflowContext[Never, dict[str, str]]) -> None:
            timeline = text_content(await memory.call_tool(
                "timeline", project=request.project, anchor=request.observation_id, depth_before=2, depth_after=2,
            ))
            details = text_content(await memory.call_tool(
                "get_observations", project=request.project, ids=[request.observation_id],
            ))
            await ctx.yield_output({"index": request.index, "timeline": timeline, "details": details})

        workflow = (WorkflowBuilder(start_executor=find_note, output_from=[read_note], max_iterations=3)
                    .add_edge(find_note, read_note).build())
        result = await workflow.run(selected)
        outputs = result.get_outputs()
        if len(outputs) != 1:
            raise RuntimeError("The recall workflow did not produce a completed result.")
        return outputs[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    save = actions.add_parser("save")
    for name in ("project", "title", "text"):
        save.add_argument(name)
    recall = actions.add_parser("recall")
    recall.add_argument("project")
    recall.add_argument("query")
    recall.add_argument("observation_id", type=int)
    args = parser.parse_args()
    try:
        if args.action == "save":
            print(asyncio.run(save_note(args.project, args.title, args.text)))
        else:
            result = asyncio.run(recall_note(SelectedNote(args.project, args.query, args.observation_id)))
            print(result["index"])
            print(result["timeline"])
            print(result["details"])
        return 0
    except Exception:
        print("Memory workflow failed. Check the worker, its data directory/port, and the selected project and observation ID.", file=sys.stderr)
        print("A timed-out save may have committed; retry the same project, title and text to reuse its note identity.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
