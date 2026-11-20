"""Native MCP fixture for tests; never connects to a worker or a model."""

import asyncio
import json
import os
from mcp.server.fastmcp import FastMCP

server = FastMCP("SmolAgents memory test")


# MCP 1 FastMCP decodes JSON-string arguments before validating their types.
@server.tool()
async def search(query: str, project: str, projects: list[str] | None = None) -> str:
    if query == "pid":
        return json.dumps({"pid": os.getpid()})
    if query == "error":
        raise ValueError("fixture unavailable")
    if query == "stall":
        await asyncio.sleep(10)
    return json.dumps({"query": query, "project": project, "projects": projects})


@server.tool()
async def save_memory(text: str, title: str, project: str, metadata: dict) -> str:
    return json.dumps({"text": text, "title": title, "project": project, "metadata": metadata})


@server.tool()
async def timeline(anchor: int, project: str, projects: list[str] | None = None) -> str:
    return str(anchor)


@server.tool()
async def get_observations(ids: list[int], project: str, projects: list[str] | None = None) -> str:
    return json.dumps({"ids": ids, "project": project})


@server.tool()
async def unrelated_tool() -> str:
    return "must not be offered to the agent"


if __name__ == "__main__":
    server.run(transport="stdio")
