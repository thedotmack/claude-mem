"""Native MCP fixture for tests; never connects to a worker or a model."""

import asyncio
import json
from fastmcp import FastMCP

server = FastMCP("Agno memory test")


@server.tool
async def search(query: str, project: str) -> str:
    if query == "error":
        raise ValueError("fixture unavailable")
    if query == "stall":
        await asyncio.sleep(10)
    return json.dumps({"query": query, "project": project})


@server.tool
async def save_memory(text: str, title: str, project: str, metadata: dict) -> str:
    return json.dumps({"text": text, "title": title, "project": project, "metadata": metadata})


@server.tool
async def timeline(anchor: int, project: str) -> str:
    return str(anchor)


@server.tool
async def get_observations(ids: list[int], project: str) -> str:
    return json.dumps({"ids": ids, "project": project})


@server.tool
async def unrelated_tool() -> str:
    return "must not be offered to the agent"


if __name__ == "__main__":
    server.run(transport="stdio", show_banner=False)
