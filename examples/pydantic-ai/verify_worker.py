"""Run against a disposable worker: saves two harmless project observations."""

import asyncio
import json
import os
from pathlib import Path
import tempfile

from memory import DEMO_NOTE, DEMO_TITLE, call_memory, demonstrate, memory_toolset


async def verify():
    server = os.environ["CLAUDE_MEM_MCP_SERVER"]
    with tempfile.TemporaryDirectory(prefix="pydantic project ") as directory:
        # Real stdio launch from a directory with spaces, not a mocked transport.
        first = memory_toolset("pydantic-sdk-verify-a", server, directory)
        second = memory_toolset("pydantic-sdk-verify-b", server, directory)
        a = await demonstrate(first, "pydantic-sdk-verify-a")
        async with first:
            initial_index = await call_memory(first, "pydantic-sdk-verify-a", "search", {
                "query": DEMO_TITLE, "type": "observations", "limit": 5,
            })
            assert f'#{a["observation_id"]}' in initial_index, "initial note was not indexed"
            for number in range(6):
                await call_memory(first, "pydantic-sdk-verify-a", "save_memory", {
                    "title": DEMO_TITLE, "text": f"Additional release check {number}.",
                })
        repeated = await demonstrate(first, "pydantic-sdk-verify-a")
        b = await demonstrate(second, "pydantic-sdk-verify-b")
        assert a["observation_id"] == repeated["observation_id"], "repeated save was duplicated"
        assert a["observation_id"] != b["observation_id"], "projects shared a saved observation"
        async with first:
            foreign = await call_memory(first, "pydantic-sdk-verify-a", "get_observations", {
                "ids": [b["observation_id"]], "project": "pydantic-sdk-verify-b",
            })
        assert DEMO_NOTE not in foreign, "another project's detail was returned"
        assert Path(directory).is_dir()
        return {"repeated_id": a["observation_id"], "other_project_id": b["observation_id"],
                "project_isolation": True, "paths_with_spaces": True, "newer_notes": 6, "model_requests": 0}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(asyncio.wait_for(verify(), 90))))
