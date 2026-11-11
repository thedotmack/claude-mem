"""Verify against a disposable worker; eight harmless observations remain stored."""

import asyncio
import json
import os
import re
import tempfile

from memory import DEMO_NOTE, DEMO_TITLE, call_memory, demonstrate, memory_tools


async def verify():
    with tempfile.TemporaryDirectory(prefix="agno project ") as directory:
        server = os.environ["CLAUDE_MEM_MCP_SERVER"]
        a = await demonstrate("agno-verify-a", server, directory)
        async with memory_tools("agno-verify-a", server, directory) as memory:
            index = await call_memory(memory, "search", {"query": DEMO_TITLE, "type": "observations", "limit": 5})
            assert f'#{a["observation_id"]}' in index, "initial note was not indexed"
            for number in range(6):
                text = ("Error: historical failure", "Error from MCP tool 'get_observations': historical failure",
                        "MCP tool 'get_observations' failed: historical failure")[number] if number < 3 else f"Additional release check {number}."
                saved = await call_memory(memory, "save_memory", {"title": DEMO_TITLE, "text": text})
                receipt = re.search(r"(?:Saved memory #|Memory already saved as #)(\d+)", saved)
                assert receipt, "additional save did not return a receipt"
                details = await call_memory(memory, "get_observations", {"ids": [int(receipt[1])]})
                assert text in details, "legitimate error-prefixed note was rejected"
        repeated = await demonstrate("agno-verify-a", server, directory)
        b = await demonstrate("agno-verify-b", server, directory)
        assert a["observation_id"] == repeated["observation_id"], "repeated save was duplicated"
        assert a["observation_id"] != b["observation_id"], "projects shared a saved observation"
        async with memory_tools("agno-verify-a", server, directory) as memory:
            foreign = await call_memory(memory, "get_observations", {"ids": [b["observation_id"]], "project": "agno-verify-b"})
        assert DEMO_NOTE not in foreign, "another project's detail was returned"
        return {"repeated_id": a["observation_id"], "other_project_id": b["observation_id"],
                "project_isolation": True, "paths_with_spaces": True, "error_prefixed_notes": True,
                "newer_notes": 6, "model_requests": 0}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(verify())))
