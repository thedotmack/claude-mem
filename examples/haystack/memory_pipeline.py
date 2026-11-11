"""A Haystack pipeline component for selected, project-scoped local memory."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

# Keep the demonstration local unless the caller has chosen Haystack telemetry.
os.environ.setdefault("HAYSTACK_TELEMETRY_ENABLED", "false")
from haystack import Pipeline, component
from haystack_integrations.tools.mcp import MCPToolset, StdioServerInfo


@contextmanager
def memory_tools():
    script = Path(os.environ.get("CLAUDE_MEM_MCP_SERVER", ""))
    node = shutil.which("node")
    if not script.is_absolute() or not script.is_file() or not node:
        raise ValueError("Set an absolute CLAUDE_MEM_MCP_SERVER path and install Node.js.")
    toolset = MCPToolset(
        server_info=StdioServerInfo(command=node, args=[str(script)], max_retries=0,
            env={**os.environ, "CLAUDE_MEM_RUNTIME": "worker", "CLAUDE_MEM_WORKER_AUTOSTART": "false"}),
        tool_names=["save_memory", "search", "timeline", "get_observations"],
        connection_timeout=10, invocation_timeout=10,
    )
    try:
        toolset.warm_up()
        yield {tool.name: tool for tool in toolset}
    finally:
        toolset.close()


def text_result(result: str) -> str:
    # MCPTool.invoke returns the MCP envelope as JSON, not just note text.
    payload = json.loads(result)
    if payload.get("isError"):
        raise RuntimeError("The memory tool reported an error.")
    return "\n".join(item["text"] for item in payload.get("content", []) if item.get("type") == "text")


def save_note(project: str, title: str, text: str) -> str:
    if not all(value.strip() for value in (project, title, text)):
        raise ValueError("Project, title and note text must be nonempty.")
    identity = hashlib.sha256(json.dumps([project, title, text], ensure_ascii=False).encode()).hexdigest()
    with memory_tools() as tools:
        return text_result(tools["save_memory"].invoke(project=project, title=title, text=text,
            metadata={"platformSource": "haystack", "sourceFingerprint": f"haystack:{identity}"}))


@component
class ProjectMemory:
    """Read a caller-selected observation through Haystack's native MCP tools."""

    @component.output_types(index=str, timeline=str, details=str)
    def run(self, project: str, query: str, observation_id: int):
        if not project.strip() or not query.strip() or observation_id < 1:
            raise ValueError("Choose a project, query and positive observation ID.")
        with memory_tools() as tools:
            # Explicit projects prevents checkout inheritance from widening
            # this component's application-selected scope in a Git worktree.
            index = text_result(tools["search"].invoke(project=project, projects=[project], query=query, type="observations", limit=20))
            # The ID may come from an earlier search or acknowledged save and
            # need not appear on the current index page. Keep the project on
            # both follow-up reads instead of widening the query.
            timeline = text_result(tools["timeline"].invoke(project=project, projects=[project], anchor=observation_id, depth_before=2, depth_after=2))
            details = text_result(tools["get_observations"].invoke(project=project, projects=[project], ids=[observation_id]))
            return {"index": index, "timeline": timeline, "details": details}


def recall_note(project: str, query: str, observation_id: int) -> dict[str, str]:
    pipeline = Pipeline()
    pipeline.add_component("project_memory", ProjectMemory())
    return pipeline.run({"project_memory": {"project": project, "query": query, "observation_id": observation_id}})["project_memory"]


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
            print(save_note(args.project, args.title, args.text))
        else:
            result = recall_note(args.project, args.query, args.observation_id)
            for name in ("index", "timeline", "details"):
                print(result[name])
        return 0
    except Exception:
        print("Memory operation failed. Check the worker, its data directory/port, and the selected project and observation ID.", file=sys.stderr)
        print("A timed-out save may have committed; repeating the same project, title and text reuses its note identity.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
