# TypeScript MCP Server Implementation Guide

Complete guide for building MCP servers with the TypeScript SDK.

## Prerequisites

- Node.js 18+ (or Bun/Deno)
- TypeScript 5+
- `@modelcontextprotocol/sdk` (v1.x recommended, v2 expected Q1 2026)

## Project Setup

### Package.json

```json
{
  "name": "my-service-mcp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "inspect": "npx @modelcontextprotocol/inspector node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.0.0",
    "@types/node": "^20.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

### Project Structure

```
my-service-mcp/
├── src/
│   ├── index.ts          # Entry point, server setup
│   ├── tools/            # Tool implementations
│   │   ├── issues.ts
│   │   ├── repos.ts
│   │   └── search.ts
│   ├── client.ts         # API client wrapper
│   ├── errors.ts         # Error handling utilities
│   └── types.ts          # Shared types
├── package.json
├── tsconfig.json
└── README.md
```

## Server Initialization

### stdio Transport (Local)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "my-service-mcp",
  version: "1.0.0",
});

// Register tools here...

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Streamable HTTP Transport (Remote)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

const app = express();
app.use(express.json());

// Stateless mode - each request is independent
app.post("/mcp", async (req, res) => {
  const server = new McpServer({
    name: "my-service-mcp",
    version: "1.0.0",
  });

  // Register tools...

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000);
```

## Tool Registration

### Basic Tool

```typescript
import { z } from "zod";

server.registerTool(
  "get_user",
  {
    title: "Get User",
    description: "Retrieve a user profile by username or ID.",
    inputSchema: {
      username: z.string().describe("The username or user ID to look up"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ username }) => {
    const user = await apiClient.getUser(username);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(user, null, 2),
        },
      ],
    };
  }
);
```

### Tool with Output Schema (Structured Content)

```typescript
server.registerTool(
  "list_issues",
  {
    title: "List Issues",
    description: "List issues for a repository with optional filters.",
    inputSchema: {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      state: z.enum(["open", "closed", "all"]).default("open").describe("Filter by state"),
      limit: z.number().min(1).max(100).default(20).describe("Max results to return"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    outputSchema: {
      issues: z.array(z.object({
        id: z.number(),
        title: z.string(),
        state: z.string(),
        author: z.string(),
        createdAt: z.string(),
        url: z.string(),
      })),
      hasNextPage: z.boolean(),
      nextCursor: z.string().optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ owner, repo, state, limit, cursor }) => {
    const result = await apiClient.listIssues(owner, repo, { state, limit, cursor });

    return {
      structuredContent: {
        issues: result.issues.map((i) => ({
          id: i.id,
          title: i.title,
          state: i.state,
          author: i.user.login,
          createdAt: i.created_at,
          url: i.html_url,
        })),
        hasNextPage: result.hasNextPage,
        nextCursor: result.nextCursor,
      },
      content: [
        {
          type: "text",
          text: `Found ${result.issues.length} issues. ${result.hasNextPage ? "More available." : "No more results."}`,
        },
      ],
    };
  }
);
```

### Tool with Error Handling

```typescript
server.registerTool(
  "create_issue",
  {
    title: "Create Issue",
    description: "Create a new issue in a repository.",
    inputSchema: {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      title: z.string().min(1).describe("Issue title"),
      body: z.string().optional().describe("Issue body in Markdown"),
      labels: z.array(z.string()).optional().describe("Labels to apply"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ owner, repo, title, body, labels }) => {
    try {
      const issue = await apiClient.createIssue(owner, repo, { title, body, labels });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: issue.id,
              number: issue.number,
              url: issue.html_url,
              title: issue.title,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 404) {
          return {
            content: [{ type: "text", text: `Repository ${owner}/${repo} not found. Check the owner and repo name.` }],
            isError: true,
          };
        }
        if (error.status === 422) {
          return {
            content: [{ type: "text", text: `Validation failed: ${error.message}. Check that labels exist and title is not empty.` }],
            isError: true,
          };
        }
      }
      return {
        content: [{ type: "text", text: `Failed to create issue: ${error instanceof Error ? error.message : "Unknown error"}` }],
        isError: true,
      };
    }
  }
);
```

## API Client Pattern

```typescript
// src/client.ts
export class ApiClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new ApiError(response.status, await response.text(), url);
    }

    return response.json() as Promise<T>;
  }

  async getUser(username: string) {
    return this.request(`/users/${encodeURIComponent(username)}`);
  }

  async listIssues(owner: string, repo: string, opts: ListOptions) {
    const params = new URLSearchParams();
    if (opts.state) params.set("state", opts.state);
    if (opts.limit) params.set("per_page", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    return this.request(`/repos/${owner}/${repo}/issues?${params}`);
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string
  ) {
    super(`API ${status}: ${body}`);
  }
}
```

## Quality Checklist

Before shipping, verify:

- [ ] All tools have clear, concise descriptions
- [ ] Input schemas use Zod with `.describe()` on every field
- [ ] Output schemas defined for tools returning structured data
- [ ] Annotations set correctly on every tool
- [ ] Error responses use `isError: true` and include actionable messages
- [ ] Pagination implemented with `cursor` and `limit` parameters
- [ ] API client validates credentials on startup
- [ ] Environment variables documented in README
- [ ] `npm run build` succeeds without errors
- [ ] Tested with MCP Inspector
- [ ] No hardcoded credentials or secrets
- [ ] No duplicated code across tools
