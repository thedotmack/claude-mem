"""Run against a disposable worker: saves two harmless project observations."""

import asyncio
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from uuid import uuid4

from memory import DEMO_NOTE, DEMO_TITLE, call_memory, demonstrate, memory_toolset


async def verify():
    run_id = uuid4().hex
    server = os.environ["CLAUDE_MEM_MCP_SERVER"]
    with tempfile.TemporaryDirectory(prefix="pydantic project ") as directory:
        parent = Path(directory) / f" pydantic-sdk-verify-{run_id},parent-{run_id}"
        checkout = Path(directory) / "checkout with spaces "
        subprocess.run(["git", "init", "-q", str(parent)], check=True)
        subprocess.run(["git", "-C", str(parent), "-c", "commit.gpgsign=false", "-c", "user.name=Memory Example",
                        "-c", "user.email=memory-example@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], check=True)
        subprocess.run(["git", "-C", str(parent), "worktree", "add", "-qb", "feature", str(checkout)], check=True)
        project_a, project_b = f"{parent.name}/{checkout.name}", parent.name
        directory = str(checkout)
        os.environ["CLAUDE_MEM_PROJECT_NAME_SOURCE"] = "path"
        os.environ["CLAUDE_MEM_PROJECT_ENVIRONMENTS"] = "[]"
        # Real stdio launch from a directory with spaces, not a mocked transport.
        first = memory_toolset(project_a, server, directory)
        second = memory_toolset(project_b, server, directory)
        a = await demonstrate(first, project_a)
        async with first:
            initial_index = await call_memory(first, project_a, "search", {
                "query": DEMO_TITLE, "type": "observations", "limit": 5,
            })
            assert f'#{a["observation_id"]}' in initial_index, "initial note was not indexed"
            for number in range(6):
                await call_memory(first, project_a, "save_memory", {
                    "title": DEMO_TITLE, "text": f"Additional release check {number}.",
                })
        repeated = await demonstrate(first, project_a)
        b = await demonstrate(second, project_b)
        assert a["observation_id"] == repeated["observation_id"], "repeated save was duplicated"
        assert a["observation_id"] != b["observation_id"], "projects shared a saved observation"
        aliases = [project_a.strip(), *(part.strip() for part in project_a.split(","))]
        alias_results = []
        for alias in aliases:
            alias_results.append(await demonstrate(memory_toolset(alias, server, directory), alias))
        foreign_ids = [b["observation_id"], *(result["observation_id"] for result in alias_results)]
        assert len({a["observation_id"], *foreign_ids}) == 5, "literal project was aliased to a parent, split or trimmed key"
        async with first:
            inherited_index = await call_memory(first, project_a, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 20})
            inherited_timeline = await call_memory(first, project_a, "timeline", {"anchor": a["observation_id"], "depth_before": 10, "depth_after": 10})
            foreign = await call_memory(first, project_a, "get_observations", {
                "ids": foreign_ids, "project": project_b,
            })
        for identifier in foreign_ids:
            assert not re.search(rf'#{identifier}\b', inherited_index), "parent or alias project entered the search index"
            assert not re.search(rf'#{identifier}\b', inherited_timeline), "parent or alias project entered the timeline"
        assert DEMO_NOTE not in foreign, "another project's detail was returned"
        assert Path(directory).is_dir()
        return {"project_a": project_a, "project_b": project_b, "repeated_id": a["observation_id"], "other_project_id": b["observation_id"],
                "project_isolation": True, "worktree_parent_isolation": True, "literal_key_isolation": True, "observations_per_run": 11, "paths_with_spaces": True, "newer_notes": 6, "model_requests": 0}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(asyncio.wait_for(verify(), 90))))
