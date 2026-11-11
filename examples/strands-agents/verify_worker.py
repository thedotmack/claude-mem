"""Run against a disposable worker; eight harmless observations remain stored."""

import json
import os
import tempfile

from memory import DEMO_NOTE, DEMO_TITLE, call_memory, demonstrate, memory_client


def verify():
    with tempfile.TemporaryDirectory(prefix="strands project ") as directory:
        server = os.environ["CLAUDE_MEM_MCP_SERVER"]
        first = memory_client(server, directory)
        a = demonstrate(first, "strands-verify-a")
        with first:
            index = call_memory(first, "strands-verify-a", "search", {"query": DEMO_TITLE, "type": "observations", "limit": 5})
            assert f'#{a["observation_id"]}' in index, "initial note was not indexed"
            for number in range(6):
                call_memory(first, "strands-verify-a", "save_memory", {"title": DEMO_TITLE, "text": f"Additional release check {number}."})
        repeated = demonstrate(first, "strands-verify-a")
        b = demonstrate(memory_client(server, directory), "strands-verify-b")
        assert a["observation_id"] == repeated["observation_id"], "repeated save was duplicated"
        assert a["observation_id"] != b["observation_id"], "projects shared a saved observation"
        with first:
            foreign = call_memory(first, "strands-verify-a", "get_observations", {"ids": [b["observation_id"]], "project": "strands-verify-b"})
        assert DEMO_NOTE not in foreign, "another project's detail was returned"
        return {"repeated_id": a["observation_id"], "other_project_id": b["observation_id"],
                "project_isolation": True, "paths_with_spaces": True, "newer_notes": 6, "model_requests": 0}


if __name__ == "__main__":
    print(json.dumps(verify()))
