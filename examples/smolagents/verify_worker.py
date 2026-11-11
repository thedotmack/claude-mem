"""Run against a disposable worker; eight harmless observations remain stored."""

import json
import os
import tempfile
from uuid import uuid4

from memory import DEMO_NOTE, DEMO_TITLE, call_memory, demonstrate, memory_tools


def verify():
    run_id = uuid4().hex
    project_a, project_b = f"smolagents-verify-{run_id}-a", f"smolagents-verify-{run_id}-b"
    with tempfile.TemporaryDirectory(prefix="smolagents project ") as directory:
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
            foreign = call_memory(tools, "get_observations", {"ids": [b["observation_id"]], "project": project_b})
        assert DEMO_NOTE not in foreign, "another project's detail was returned"
        return {"project_a": project_a, "project_b": project_b, "repeated_id": a["observation_id"], "other_project_id": b["observation_id"],
                "project_isolation": True, "paths_with_spaces": True, "newer_notes": 6, "model_requests": 0}


if __name__ == "__main__":
    print(json.dumps(verify()))
