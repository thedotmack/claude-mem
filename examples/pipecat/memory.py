"""Explicit, project-scoped memory operations in a Pipecat frame pipeline."""

import argparse
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pipecat.frames.frames import DataFrame, EndFrame, TextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import WorkerRunner
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class SaveMemoryFrame(DataFrame):
    """Created by the application only after the user selects text to preserve."""

    text: str
    title: str = "Selected Pipecat transcript"


@dataclass
class RecallMemoryFrame(DataFrame):
    query: str
    observation_id: int


@dataclass
class MemoryResultFrame(TextFrame):
    success: bool = True


@asynccontextmanager
async def memory_session(server: str, cwd: str):
    script, directory = Path(server), Path(cwd)
    node = shutil.which("node")
    if not script.is_absolute() or not script.is_file() or not directory.is_dir() or not node:
        raise ValueError("Choose an absolute MCP script, an existing checkout and Node.js.")
    params = StdioServerParameters(command=node, args=[str(script)], cwd=str(directory.resolve()),
        env={**os.environ, "CLAUDE_MEM_RUNTIME": "worker", "CLAUDE_MEM_WORKER_AUTOSTART": "false"})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def checked_call(session, name: str, arguments: dict) -> str:
    result = await session.call_tool(name, arguments=arguments)
    if result.is_error:
        raise RuntimeError("The memory tool reported a failure.")
    text = "\n".join(block.text for block in result.content if block.type == "text")
    if not text.strip():
        raise RuntimeError("The memory tool returned no readable result.")
    return text


async def execute_memory(project: str, frame, server: str, cwd: str) -> str:
    if not isinstance(project, str) or not project.strip():
        raise ValueError("Choose a nonempty project.")
    if isinstance(frame, SaveMemoryFrame):
        if not isinstance(frame.text, str) or not frame.text.strip() or not isinstance(frame.title, str):
            raise ValueError("Choose nonempty selected text and a text title.")
        fingerprint = hashlib.sha256(json.dumps([project, frame.title.strip(), frame.text.strip()], ensure_ascii=False).encode()).hexdigest()
    elif isinstance(frame, RecallMemoryFrame):
        if not isinstance(frame.query, str) or not frame.query.strip() or type(frame.observation_id) is not int or frame.observation_id < 1:
            raise ValueError("Choose a query and a positive observation ID from a prior search or save.")
    else:
        raise ValueError("Choose an explicit memory operation.")

    # Bound connection and calls; the SDK separately bounds subprocess shutdown.
    async with asyncio.timeout(10):
        async with memory_session(server, cwd) as session:
            if isinstance(frame, SaveMemoryFrame):
                text = await checked_call(session, "save_memory", {
                    "project": project, "title": frame.title, "text": frame.text,
                    "metadata": {"platformSource": "pipecat", "sourceFingerprint": f"pipecat-example-v1:{fingerprint}"},
                })
                if not re.match(r"(?:Saved memory #|Memory already saved as #)\d+", text):
                    raise RuntimeError("The worker did not acknowledge a saved memory.")
                return text
            # JSON keeps literal commas and whitespace in one project key and
            # prevents inherited worktree projects from widening selected reads.
            scope = {"project": project, "projects": json.dumps([project], ensure_ascii=False)}
            index = await checked_call(session, "search", {**scope, "query": frame.query, "type": "observations", "limit": 20})
            timeline = await checked_call(session, "timeline", {**scope, "anchor": frame.observation_id, "depth_before": 2, "depth_after": 2})
            details = await checked_call(session, "get_observations", {**scope, "ids": [frame.observation_id]})
            return "\n\n".join([index, timeline, details])


class ProjectMemory(FrameProcessor):
    def __init__(self, project: str, server: str, cwd: str, *, enabled: bool = True):
        super().__init__()
        self.project, self.server, self.cwd, self.enabled = project, server, cwd, enabled

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, (SaveMemoryFrame, RecallMemoryFrame)):
            if not self.enabled:
                result = MemoryResultFrame(text="Memory is disabled. No operation was performed.", success=False)
            else:
                try:
                    text = await execute_memory(self.project, frame, self.server, self.cwd)
                    result = MemoryResultFrame(text=text)
                except Exception:
                    result = MemoryResultFrame(text="Memory could not confirm this operation. Check the worker connection before trying again.", success=False)
            await self.push_frame(result, direction)
        else:
            await self.push_frame(frame, direction)


async def run_demo(project: str, frame, server: str, cwd: str) -> MemoryResultFrame:
    class ResultCollector(FrameProcessor):
        result = None

        async def process_frame(self, received, direction):
            await super().process_frame(received, direction)
            if isinstance(received, MemoryResultFrame):
                self.result = received
            await self.push_frame(received, direction)

    collector = ResultCollector()
    worker = PipelineWorker(Pipeline([ProjectMemory(project, server, cwd), collector]),
        enable_rtvi=False, enable_turn_tracking=False)
    await worker.queue_frames([frame, EndFrame()])
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()
    if collector.result is None:
        raise RuntimeError("The pipeline returned no memory result.")
    return collector.result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--server", default=os.environ.get("CLAUDE_MEM_MCP_SERVER", ""))
    parser.add_argument("--cwd", default=os.getcwd())
    actions = parser.add_subparsers(dest="action", required=True)
    save = actions.add_parser("save")
    save.add_argument("text")
    save.add_argument("--title", default="Selected Pipecat transcript")
    recall = actions.add_parser("recall")
    recall.add_argument("query")
    recall.add_argument("observation_id", type=int)
    args = parser.parse_args()
    frame = SaveMemoryFrame(text=args.text, title=args.title) if args.action == "save" else RecallMemoryFrame(query=args.query, observation_id=args.observation_id)
    result = asyncio.run(run_demo(args.project, frame, args.server, args.cwd))
    print(json.dumps({"success": result.success, "text": result.text}))
    return 0 if result.success else 1


if __name__ == "__main__":
    sys.exit(main())
