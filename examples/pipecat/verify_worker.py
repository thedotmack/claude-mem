"""Run against a disposable local worker; two harmless saved notes remain."""

import asyncio
import json
import os
from pathlib import Path
import re
import tempfile
from uuid import uuid4

from memory import RecallMemoryFrame, SaveMemoryFrame, memory_session, run_demo


async def verify():
    server = os.environ["CLAUDE_MEM_MCP_SERVER"]
    project = f"pipecat-check-{uuid4().hex},literal"
    note = "Use the amber region for the voice demo."
    with tempfile.TemporaryDirectory(prefix="pipecat checkout ") as cwd:
        async def save(selected_project):
            result = await run_demo(selected_project, SaveMemoryFrame(text=note, title="Voice demo decision"), server, cwd)
            assert result.success, result.text
            return int(re.search(r"#(\d+)", result.text)[1])

        first = await save(project)
        repeated = await save(project)
        other = await save(project + "-other")
        assert first == repeated and first != other
        recalled = await run_demo(project, RecallMemoryFrame(query="Voice demo decision", observation_id=first), server, cwd)
        assert recalled.success and note in recalled.text
        foreign = await run_demo(project, RecallMemoryFrame(query="Voice demo decision", observation_id=other), server, cwd)
        assert not foreign.success, "a recall anchored on another project's ID succeeded"
        # The scoped timeline rejects the foreign anchor first, so ask for the
        # details directly to check that selected-detail reads are scoped too.
        async with memory_session(server, cwd) as session:
            details = await session.call_tool("get_observations", arguments={
                "project": project, "projects": json.dumps([project], ensure_ascii=False), "ids": [other]})
        details_text = "\n".join(block.text for block in details.content if block.type == "text")
        assert not details.is_error and note not in details_text, "another project's details were returned"
        failed = await run_demo(project, SaveMemoryFrame(text=note), str(Path(cwd) / "missing-server.cjs"), cwd)
        assert not failed.success
        return {"first_id": first, "repeated_id": repeated, "other_project_id": other,
                "project_isolation": True, "paths_with_spaces": True, "failure_reported": True,
                "pipeline": "Pipecat 1.16.0", "model_requests": 0, "audio_recorded": False}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(verify())))
