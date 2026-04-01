# Python MCP Server Implementation Guide

Complete guide for building MCP servers with the Python SDK (FastMCP).

## Prerequisites

- Python 3.10+
- `uv` package manager (recommended) or pip
- `mcp[cli]` package

## Project Setup

### Installation

```bash
# Recommended: uv
uv add "mcp[cli]"

# Alternative: pip
pip install "mcp[cli]"
```

### Project Structure

```
my-service-mcp/
├── src/
│   └── my_service_mcp/
│       ├── __init__.py
│       ├── server.py       # Server setup and tool registration
│       ├── client.py       # API client wrapper
│       ├── tools/
│       │   ├── __init__.py
│       │   ├── issues.py
│       │   ├── repos.py
│       │   └── search.py
│       ├── models.py       # Pydantic models
│       └── errors.py       # Error utilities
├── pyproject.toml
├── README.md
└── tests/
    └── test_tools.py
```

### pyproject.toml

```toml
[project]
name = "my-service-mcp"
version = "1.0.0"
requires-python = ">=3.10"
dependencies = [
    "mcp[cli]>=1.6.0",
    "httpx>=0.27.0",
    "pydantic>=2.0.0",
]

[project.scripts]
my-service-mcp = "my_service_mcp.server:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

## Server Initialization

### Basic Server (stdio)

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "my-service-mcp",
    dependencies=["httpx", "pydantic"],
)

# Register tools here...

def main():
    mcp.run(transport="stdio")

if __name__ == "__main__":
    main()
```

### Streamable HTTP Server

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "my-service-mcp",
    stateless_http=True,
    host="0.0.0.0",
    port=3000,
)

# Register tools...

def main():
    mcp.run(transport="streamable-http")
```

## Tool Registration

### Basic Tool

```python
from mcp.server.fastmcp import FastMCP, Context

mcp = FastMCP("my-service-mcp")

@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    }
)
async def get_user(username: str) -> str:
    """Retrieve a user profile by username or ID.

    Args:
        username: The username or user ID to look up
    """
    client = get_api_client()
    user = await client.get_user(username)
    return json.dumps(user, indent=2)
```

### Tool with Pydantic Models

```python
from pydantic import BaseModel, Field

class ListIssuesInput(BaseModel):
    owner: str = Field(description="Repository owner")
    repo: str = Field(description="Repository name")
    state: str = Field(default="open", description="Filter: open, closed, or all")
    limit: int = Field(default=20, ge=1, le=100, description="Max results to return")
    cursor: str | None = Field(default=None, description="Pagination cursor from previous response")

class Issue(BaseModel):
    id: int
    title: str
    state: str
    author: str
    created_at: str
    url: str

class ListIssuesResult(BaseModel):
    issues: list[Issue]
    has_next_page: bool
    next_cursor: str | None = None

@mcp.tool(
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    }
)
async def list_issues(
    owner: str,
    repo: str,
    state: str = "open",
    limit: int = 20,
    cursor: str | None = None,
) -> str:
    """List issues for a repository with optional filters.

    Args:
        owner: Repository owner
        repo: Repository name
        state: Filter by state (open, closed, all)
        limit: Max results (1-100, default 20)
        cursor: Pagination cursor from previous response
    """
    client = get_api_client()
    result = await client.list_issues(owner, repo, state=state, limit=limit, cursor=cursor)

    output = ListIssuesResult(
        issues=[
            Issue(
                id=i["id"],
                title=i["title"],
                state=i["state"],
                author=i["user"]["login"],
                created_at=i["created_at"],
                url=i["html_url"],
            )
            for i in result["issues"]
        ],
        has_next_page=result["has_next_page"],
        next_cursor=result.get("next_cursor"),
    )
    return output.model_dump_json(indent=2)
```

### Tool with Context and Error Handling

```python
@mcp.tool(
    annotations={
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    }
)
async def create_issue(
    ctx: Context,
    owner: str,
    repo: str,
    title: str,
    body: str | None = None,
    labels: list[str] | None = None,
) -> str:
    """Create a new issue in a repository.

    Args:
        owner: Repository owner
        repo: Repository name
        title: Issue title (required)
        body: Issue body in Markdown
        labels: Labels to apply to the issue
    """
    client = get_api_client()

    await ctx.info(f"Creating issue in {owner}/{repo}...")

    try:
        issue = await client.create_issue(
            owner, repo, title=title, body=body, labels=labels
        )
        return json.dumps({
            "id": issue["id"],
            "number": issue["number"],
            "url": issue["html_url"],
            "title": issue["title"],
        }, indent=2)
    except ApiError as e:
        if e.status == 404:
            raise McpError(
                ErrorCode.InvalidParams,
                f"Repository {owner}/{repo} not found. Check the owner and repo name."
            )
        if e.status == 422:
            raise McpError(
                ErrorCode.InvalidParams,
                f"Validation failed: {e.message}. Check that labels exist and title is not empty."
            )
        raise McpError(
            ErrorCode.InternalError,
            f"Failed to create issue: {e.message}"
        )
```

### Using Context for Logging and Progress

```python
@mcp.tool()
async def sync_all_repos(ctx: Context, org: str) -> str:
    """Sync metadata for all repositories in an organization.

    Args:
        org: Organization name
    """
    client = get_api_client()
    repos = await client.list_org_repos(org)

    results = []
    for i, repo in enumerate(repos):
        await ctx.report_progress(i, len(repos))
        await ctx.info(f"Syncing {repo['name']}...")
        metadata = await client.get_repo_metadata(org, repo["name"])
        results.append(metadata)

    return json.dumps({"synced": len(results), "repos": results}, indent=2)
```

## API Client Pattern

```python
# src/my_service_mcp/client.py
import httpx
import os

class ApiError(Exception):
    def __init__(self, status: int, message: str, url: str):
        self.status = status
        self.message = message
        self.url = url
        super().__init__(f"API {status}: {message}")

class ApiClient:
    def __init__(self):
        self.token = os.environ.get("SERVICE_API_TOKEN")
        if not self.token:
            raise ValueError(
                "SERVICE_API_TOKEN environment variable is required. "
                "Get your token at https://service.example.com/settings/tokens"
            )
        self.base_url = os.environ.get("SERVICE_API_URL", "https://api.service.example.com")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def _request(self, method: str, path: str, **kwargs):
        response = await self._client.request(method, path, **kwargs)
        if not response.is_success:
            raise ApiError(response.status_code, response.text, str(response.url))
        return response.json()

    async def get_user(self, username: str):
        return await self._request("GET", f"/users/{username}")

    async def list_issues(self, owner: str, repo: str, **opts):
        params = {k: v for k, v in opts.items() if v is not None}
        return await self._request("GET", f"/repos/{owner}/{repo}/issues", params=params)

    async def create_issue(self, owner: str, repo: str, **data):
        return await self._request("POST", f"/repos/{owner}/{repo}/issues", json=data)

# Singleton pattern
_client: ApiClient | None = None

def get_api_client() -> ApiClient:
    global _client
    if _client is None:
        _client = ApiClient()
    return _client
```

## Resources (Data Exposure)

```python
@mcp.resource("repos://{owner}/{repo}")
async def get_repo_resource(owner: str, repo: str) -> str:
    """Repository metadata as a resource."""
    client = get_api_client()
    repo_data = await client.get_repo(owner, repo)
    return json.dumps(repo_data, indent=2)
```

## Prompts (Reusable Templates)

```python
from mcp.server.fastmcp.prompts import base

@mcp.prompt()
def review_issue(issue_number: int, repo: str) -> list[base.Message]:
    """Generate a prompt for reviewing a GitHub issue."""
    return [
        base.UserMessage(
            content=f"Please review issue #{issue_number} in {repo}. "
            f"Summarize the problem, suggest a fix, and estimate complexity."
        )
    ]
```

## Quality Checklist

Before shipping, verify:

- [ ] All tools have docstrings with Args section
- [ ] Pydantic models used for complex inputs/outputs
- [ ] Annotations set on every tool
- [ ] Error handling uses `McpError` with actionable messages
- [ ] Pagination implemented with `cursor` and `limit`
- [ ] API client validates token on initialization
- [ ] Environment variables documented in README
- [ ] `python -m py_compile server.py` succeeds
- [ ] Tested with MCP Inspector
- [ ] Context used for logging and progress where appropriate
- [ ] No hardcoded credentials
- [ ] No duplicated code across tools
- [ ] Type hints on all function signatures
