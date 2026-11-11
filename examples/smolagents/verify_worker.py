"""Run against a disposable worker; eight harmless observations remain stored."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from uuid import uuid4

from memory import DEMO_NOTE, DEMO_TITLE, call_memory, demonstrate, memory_tools


def verify():
    run_id = uuid4().hex
    with tempfile.TemporaryDirectory(prefix="smolagents project ") as directory:
        parent = Path(directory) / f"smolagents-verify-{run_id}"
        checkout = Path(directory) / "checkout with spaces"
        subprocess.run(["git", "init", "-q", str(parent)], check=True)
        subprocess.run(["git", "-C", str(parent), "-c", "user.name=Memory Example",
                        "-c", "user.email=memory-example@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], check=True)
        subprocess.run(["git", "-C", str(parent), "worktree", "add", "-qb", "feature", str(checkout)], check=True)
        project_a, project_b = f"{parent.name}/{checkout.name}", parent.name
        directory = str(checkout)
        os.environ["CLAUDE_MEM_PROJECT_NAME_SOURCE"] = "path"
        os.environ["CLAUDE_MEM_PROJECT_ENVIRONMENTS"] = "[]"
        server = os.environ["CLAUDE_MEM_MCP_SERVER"]
        a = demonstrate(project_a, server, directory)
        with memory_tools(project_a, server, directory) as tools:
            index = call_memory(tools, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 5})
            assert f'#{a["observation_id"]}' in index, "initial note was not indexed"
            for number in range(6):
                call_memory(tools, "save_memory", {"title": DEMO_TITLE, "text": f"Additional release check {number}."})
        repeated = demonstrate(project_a, server, directory)
        b = demonstrate(project_b, server, directory)
        assert a["observation_id"] == repeated["observation_id"], "repeated save was duplicated"
        assert a["observation_id"] != b["observation_id"], "projects shared a saved observation"
        with memory_tools(project_a, server, directory) as tools:
            inherited_index = call_memory(tools, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 20})
            inherited_timeline = call_memory(tools, "timeline", {"anchor": a["observation_id"], "depth_before": 10, "depth_after": 10})
            foreign = call_memory(tools, "get_observations", {"ids": [b["observation_id"]], "project": project_b})
        assert not re.search(rf'#{b["observation_id"]}\b', inherited_index), "parent project entered the search index"
        assert not re.search(rf'#{b["observation_id"]}\b', inherited_timeline), "parent project entered the timeline"
        assert DEMO_NOTE not in foreign, "another project's detail was returned"
        return {"project_a": project_a, "project_b": project_b, "repeated_id": a["observation_id"], "other_project_id": b["observation_id"],
                "project_isolation": True, "worktree_parent_isolation": True, "paths_with_spaces": True, "newer_notes": 6, "model_requests": 0}


if __name__ == "__main__":
    print(json.dumps(verify()))
