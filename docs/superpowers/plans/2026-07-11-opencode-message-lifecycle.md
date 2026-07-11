# OpenCode Message Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claude-mem capture real OpenCode 1.17.18 user prompts, tool arguments, completed assistant replies, and summaries deterministically without emitting false initialization errors.

**Architecture:** Keep the integration in the existing OpenCode plugin module. Treat `chat.message` as the user-turn hook, use `client.session.messages` as the canonical assistant snapshot at idle/compaction, await every non-fatal worker write, and deduplicate assistant lifecycle work by OpenCode message ID. Correct the provider's valid empty-init log severity independently.

**Tech Stack:** TypeScript 6, Bun tests, OpenCode 1.17.18 plugin/SDK contracts, Fetch API, esbuild, SQLite.

## Global Constraints

- Target the installed OpenCode `1.17.18` contract only; do not add compatibility branches for unverified versions.
- Do not change the database schema, worker protocol, viewer, installer, MCP registration, provider configuration, or default-only production entrypoint.
- Keep `[media prompt]` only for genuinely textless user messages.
- Never submit a summary without non-empty completed assistant text.
- Lifecycle write and OpenCode message-list failures remain non-fatal.
- Keep the existing 1,000-session state bound and clear all per-session state on deletion.
- Preserve explicit memory search behavior and the five-second startup-context GET timeout.
- Follow red-green TDD and commit each independently testable task.

---

## File Map

- Modify `src/integrations/opencode-plugin/index.ts`: align hook types, user/tool capture, awaited worker POSTs, canonical assistant lookup, deduplication, and state cleanup.
- Modify `tests/integrations/opencode-plugin-contract.test.ts`: encode OpenCode 1.17.18 lifecycle behavior and worker-request guarantees.
- Modify `src/services/worker/OpenAICompatibleProvider.ts`: downgrade valid empty initialization results from error to debug.
- Create `tests/worker/openai-compatible-provider.test.ts`: verify empty initialization severity through the provider's public session lifecycle.
- Verify `tests/integration/opencode-installer.test.ts`: guard installation behavior without changing it.
- Verify `src/integrations/opencode-plugin/entry.ts`: guard the unchanged default-only production export.

### Task 1: Deterministic User And Tool Writes

**Files:**
- Modify: `tests/integrations/opencode-plugin-contract.test.ts:1-270`
- Modify: `src/integrations/opencode-plugin/index.ts:47-204,217-282,304-335`

**Interfaces:**
- Consumes: OpenCode `chat.message(input, output)`, where `input.sessionID` is authoritative and `output.parts` contains the user message parts.
- Consumes: OpenCode `tool.execute.after(input, output)`, where `input.args` contains tool arguments.
- Produces: `workerPost(path: string, body: Record<string, unknown>): Promise<void>`.
- Produces: `getTextContent(parts: OpenCodePart[]): string`.
- Produces: one `/api/sessions/init` POST per user turn and no synthetic init POST from tool, idle, or compaction hooks.

- [ ] **Step 1: Update the OpenCode test fixture and write failing prompt/tool tests**

Change the Bun import and base client fixture, replace the old tool/init tests, and add the following contract cases:

```ts
import { describe, it, expect, spyOn } from "bun:test";

const pluginCtx = {
  client: {
    session: {
      messages: async () => ({ data: [] }),
    },
  },
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

it("posts every real user turn with one stable content-session ID", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const chatMessage = plugin["chat.message"];

    await chatMessage(
      { sessionID: "ses_prompts" },
      {
        message: { id: "user-1", role: "user", sessionID: "ses_prompts" },
        parts: [
          { type: "text", text: "first line" },
          { type: "text", text: "second line" },
        ],
      },
    );
    await chatMessage(
      { sessionID: "ses_prompts" },
      {
        message: { id: "user-2", role: "user", sessionID: "ses_prompts" },
        parts: [{ type: "text", text: "follow-up" }],
      },
    );

    const initPosts = posts.filter((post) => post.url.includes("/api/sessions/init"));
    expect(initPosts).toHaveLength(2);
    expect(initPosts.map((post) => post.body.prompt)).toEqual([
      "first line\nsecond line",
      "follow-up",
    ]);
    expect(initPosts[0].body.contentSessionId).toBe(initPosts[1].body.contentSessionId);
    expect(initPosts[0].body.project).toBe("x");
    expect(initPosts[0].body.platformSource).toBe("opencode");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("uses the media marker only when a user turn has no usable text", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    await plugin["chat.message"](
      { sessionID: "ses_media" },
      {
        message: { id: "user-media", role: "user", sessionID: "ses_media" },
        parts: [
          { type: "file" },
          { type: "text", text: "   " },
        ],
      },
    );

    const initPost = posts.find((post) => post.url.includes("/api/sessions/init"));
    expect(initPost?.body.prompt).toBe("[media prompt]");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("posts tool observations with input.args and does not create an empty prompt", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    await plugin["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses_tool",
        callID: "call-1",
        args: { path: "/a" },
      },
      { title: "Read", output: "file contents", metadata: {} },
    );

    expect(posts.some((post) => post.url.includes("/api/sessions/init"))).toBe(false);
    const observation = posts.find((post) => post.url.includes("/api/sessions/observations"));
    expect(observation?.body.tool_name).toBe("read");
    expect(observation?.body.tool_input).toEqual({ path: "/a" });
    expect(observation?.body.tool_response).toBe("file contents");
    expect(observation?.body.platformSource).toBe("opencode");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

Update the existing `every lifecycle POST body carries platformSource=opencode` case so it sends a user hook contract instead of an assistant contract, passes `args` on the tool input, removes `args` from the tool output, and only requires at least one lifecycle request before checking every body:

```ts
await plugin["chat.message"](
  { sessionID: "ses_obs" },
  {
    message: { id: "user-platform", role: "user", sessionID: "ses_obs" },
    parts: [{ type: "text", text: "hello" }],
  },
);
await plugin["tool.execute.after"](
  {
    tool: "read",
    sessionID: "ses_obs",
    callID: "c1",
    args: { path: "/a" },
  },
  { title: "Read", output: "file contents", metadata: {} },
);

expect(sessionPosts.length).toBeGreaterThan(0);
for (const post of sessionPosts) {
  expect(post.body.platformSource, `POST ${post.url} must carry platformSource=opencode`).toBe(
    "opencode",
  );
}
```

- [ ] **Step 2: Run the focused contract tests and verify the new cases fail**

Run:

```bash
rtk bun test tests/integrations/opencode-plugin-contract.test.ts
```

Expected: FAIL because `chat.message` rejects user messages, tool arguments are read from `output.args`, and tool activity still creates an empty init prompt.

- [ ] **Step 3: Add failing awaited-request and HTTP-status tests**

Add these cases to the OpenCode event-contract describe block:

```ts
it("awaits lifecycle POST completion", async () => {
  let releaseResponse: ((response: Response) => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    })) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    let completed = false;
    const hookPromise = plugin["chat.message"](
      { sessionID: "ses_await" },
      {
        message: { id: "user-await", role: "user", sessionID: "ses_await" },
        parts: [{ type: "text", text: "wait for persistence" }],
      },
    ).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    releaseResponse?.(new Response(JSON.stringify({ status: "queued" }), { status: 200 }));
    await hookPromise;
    expect(completed).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("logs a non-success worker POST once without rejecting the hook", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    await plugin["chat.message"](
      { sessionID: "ses_status" },
      {
        message: { id: "user-status", role: "user", sessionID: "ses_status" },
        parts: [{ type: "text", text: "non-fatal" }],
      },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[claude-mem] Worker POST /api/sessions/init returned 503");
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 4: Run the focused tests and verify the request tests fail**

Run:

```bash
rtk bun test tests/integrations/opencode-plugin-contract.test.ts
```

Expected: FAIL because the current fire-and-forget helper resolves hooks before `fetch` and ignores non-success responses.

- [ ] **Step 5: Implement the minimal user/tool/write contract**

Replace the local hook types and request helper with:

```ts
interface OpenCodePart {
  type: string;
  text?: string;
  ignored?: boolean;
}

interface OpenCodeMessageSnapshot {
  info: {
    id: string;
    role: string;
    time?: { completed?: number };
    summary?: boolean;
  };
  parts: OpenCodePart[];
}

interface OpenCodeClient {
  session: {
    messages(options: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<{ data?: OpenCodeMessageSnapshot[] }>;
  };
}

interface OpenCodePluginContext {
  client: OpenCodeClient;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface ChatMessageInput {
  sessionID: string;
}

interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  parts: OpenCodePart[];
}

async function workerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
  }
}

function getTextContent(parts: OpenCodePart[]): string {
  return parts
    .filter(
      (part) =>
        part.type === "text" &&
        part.ignored !== true &&
        typeof part.text === "string" &&
        part.text.trim().length > 0,
    )
    .map((part) => part.text as string)
    .join("\n");
}
```

Delete `initializedSessionIds` and `ensureSessionInitialized`. In `getOrCreateContentSessionId`, remove the `initializedSessionIds.delete(oldestKey)` eviction line.

Replace the tool and user hooks with:

```ts
"tool.execute.after": async (
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
): Promise<void> => {
  const contentSessionId = getOrCreateContentSessionId(input.sessionID);
  await workerPost("/api/sessions/observations", {
    contentSessionId,
    tool_name: input.tool,
    tool_input: input.args || {},
    tool_response: truncate(output.output || ""),
    cwd: ctx.directory,
    platformSource: OPENCODE_PLATFORM_SOURCE,
  });
},

"chat.message": async (
  input: ChatMessageInput,
  output: ChatMessageOutput,
): Promise<void> => {
  const contentSessionId = getOrCreateContentSessionId(input.sessionID);
  const prompt = getTextContent(output.parts) || "[media prompt]";

  await workerPost("/api/sessions/init", {
    contentSessionId,
    project: projectName,
    platformSource: OPENCODE_PLATFORM_SOURCE,
    prompt,
  });
},
```

Until Task 2 replaces summary handling, change both current summary hooks to use `getOrCreateContentSessionId` and `await workerPost`, and change `session.deleted` cleanup to remove only the content-session and context entries. Change all remaining lifecycle call sites from `workerPostFireAndForget` to `await workerPost`.

- [ ] **Step 6: Run focused tests and root typechecking**

Run:

```bash
rtk bun test tests/integrations/opencode-plugin-contract.test.ts
rtk npm run typecheck:root
```

Expected: both commands PASS. The OpenCode contract suite has no failures, and TypeScript emits no diagnostics.

- [ ] **Step 7: Commit deterministic prompt and tool capture**

```bash
rtk git add src/integrations/opencode-plugin/index.ts tests/integrations/opencode-plugin-contract.test.ts
rtk git commit -m "fix: capture OpenCode user prompts deterministically"
```

### Task 2: Canonical Assistant Capture And Deduplication

**Files:**
- Modify: `tests/integrations/opencode-plugin-contract.test.ts:53-300`
- Modify: `src/integrations/opencode-plugin/index.ts:47-185,212-355`

**Interfaces:**
- Consumes: `ctx.client.session.messages({ path: { id }, query: { directory } })`, returning `{ data?: Array<{ info, parts }> }`.
- Consumes: `getTextContent(parts: OpenCodePart[]): string` from Task 1.
- Produces: `captureAssistantLifecycle(sessionID: string): Promise<void>` inside the plugin closure.
- Produces: `processedAssistantMessageIdsBySessionId: Map<string, string>` bounded by the content-session map.
- Produces: exactly one assistant observation and one summary per completed assistant reply ID.

- [ ] **Step 1: Write failing canonical assistant and deduplication tests**

Add these cases to the OpenCode event-contract describe block:

```ts
it("captures and summarizes the latest completed assistant reply once", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const messageRequests: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  const ctx = {
    ...pluginCtx,
    client: {
      session: {
        messages: async (options: unknown) => {
          messageRequests.push(options);
          return {
            data: [
              {
                info: {
                  id: "assistant-old",
                  role: "assistant",
                  time: { completed: 10 },
                },
                parts: [{ type: "text", text: "old reply" }],
              },
              {
                info: {
                  id: "assistant-latest",
                  role: "assistant",
                  time: { completed: 20 },
                },
                parts: [
                  { type: "text", text: "first answer line" },
                  { type: "text", text: "ignored", ignored: true },
                  { type: "text", text: "second answer line" },
                ],
              },
            ],
          };
        },
      },
    },
  };

  try {
    const plugin = await ClaudeMemPlugin(ctx);
    await plugin["event"]({
      event: { type: "session.idle", properties: { sessionID: "ses_assistant" } },
    });
    await plugin["experimental.session.compacting"]({ sessionID: "ses_assistant" });

    expect(messageRequests).toEqual([
      { path: { id: "ses_assistant" }, query: { directory: "/tmp/x" } },
      { path: { id: "ses_assistant" }, query: { directory: "/tmp/x" } },
    ]);
    const observations = posts.filter((post) => post.url.includes("/api/sessions/observations"));
    const summaries = posts.filter((post) => post.url.includes("/api/sessions/summarize"));
    expect(observations).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(observations[0].body.tool_name).toBe("assistant_message");
    expect(observations[0].body.tool_response).toBe(
      "first answer line\nsecond answer line",
    );
    expect(summaries[0].body.last_assistant_message).toBe(
      "first answer line\nsecond answer line",
    );
    expect(observations[0].body.contentSessionId).toBe(
      summaries[0].body.contentSessionId,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("retries a completed textless assistant message when usable text appears", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const latest = {
    info: {
      id: "assistant-retry",
      role: "assistant",
      time: { completed: 30 },
    },
    parts: [{ type: "text", text: "hidden", ignored: true }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin({
      ...pluginCtx,
      client: {
        session: {
          messages: async () => ({ data: [latest] }),
        },
      },
    });

    await plugin["event"]({
      event: { type: "session.idle", properties: { sessionID: "ses_retry" } },
    });
    expect(posts).toHaveLength(0);

    latest.parts = [{ type: "text", text: "now complete", ignored: false }];
    await plugin["experimental.session.compacting"]({ sessionID: "ses_retry" });

    expect(posts.filter((post) => post.url.includes("/api/sessions/observations"))).toHaveLength(1);
    expect(posts.filter((post) => post.url.includes("/api/sessions/summarize"))).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Add failing error, completion, and cleanup tests**

Add these cases:

```ts
it("sends no lifecycle POST when no completed assistant reply exists", async () => {
  const posts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    posts.push(String(url));
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin({
      ...pluginCtx,
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "user-1", role: "user", time: { completed: 1 } },
                parts: [{ type: "text", text: "question" }],
              },
              {
                info: { id: "assistant-running", role: "assistant", time: {} },
                parts: [{ type: "text", text: "partial" }],
              },
            ],
          }),
        },
      },
    });

    await plugin["event"]({
      event: { type: "session.idle", properties: { sessionID: "ses_incomplete" } },
    });
    expect(posts).toHaveLength(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("skips lifecycle POSTs when OpenCode message listing fails", async () => {
  const posts: string[] = [];
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  globalThis.fetch = (async (url: string | URL | Request) => {
    posts.push(String(url));
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin({
      ...pluginCtx,
      client: {
        session: {
          messages: async () => {
            throw new Error("OpenCode unavailable");
          },
        },
      },
    });

    await plugin["event"]({
      event: { type: "session.idle", properties: { sessionID: "ses_api_error" } },
    });
    expect(posts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[claude-mem] OpenCode message list failed for ses_api_error: OpenCode unavailable",
    );
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

it("clears assistant deduplication state when a session is deleted", async () => {
  const posts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    posts.push(String(url));
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin({
      ...pluginCtx,
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: "assistant-delete",
                  role: "assistant",
                  time: { completed: 40 },
                },
                parts: [{ type: "text", text: "reply" }],
              },
            ],
          }),
        },
      },
    });

    const idleEvent = {
      event: { type: "session.idle", properties: { sessionID: "ses_delete" } },
    };
    await plugin["event"](idleEvent);
    await plugin["event"]({
      event: { type: "session.deleted", properties: { sessionID: "ses_delete" } },
    });
    await plugin["event"](idleEvent);

    expect(posts.filter((url) => url.includes("/api/sessions/observations"))).toHaveLength(2);
    expect(posts.filter((url) => url.includes("/api/sessions/summarize"))).toHaveLength(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 3: Run the focused suite and verify assistant cases fail**

Run:

```bash
rtk bun test tests/integrations/opencode-plugin-contract.test.ts
```

Expected: FAIL because idle and compaction still send empty summaries, never query OpenCode messages, do not capture assistant observations, and have no message-ID deduplication.

- [ ] **Step 4: Implement canonical lookup, capture, and deduplication**

Add the deduplication map next to the existing session maps:

```ts
const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
const processedAssistantMessageIdsBySessionId = new Map<string, string>();
const MAX_SESSION_MAP_ENTRIES = 1000;
const contextBySessionId = new Map<string, string>();
```

When `getOrCreateContentSessionId` evicts `oldestKey`, clear all matching state:

```ts
contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
processedAssistantMessageIdsBySessionId.delete(oldestKey);
contextBySessionId.delete(oldestKey);
```

Inside `ClaudeMemPlugin`, immediately after the loading log, add:

```ts
const captureAssistantLifecycle = async (sessionID: string): Promise<void> => {
  let snapshots: OpenCodeMessageSnapshot[];
  try {
    const response = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    });
    snapshots = response.data || [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[claude-mem] OpenCode message list failed for ${sessionID}: ${message}`);
    return;
  }

  const latestAssistant = snapshots
    .filter(
      (snapshot) =>
        snapshot.info.role === "assistant" &&
        snapshot.info.summary !== true &&
        typeof snapshot.info.time?.completed === "number",
    )
    .sort(
      (left, right) =>
        (right.info.time?.completed || 0) - (left.info.time?.completed || 0),
    )[0];
  if (!latestAssistant) return;
  if (
    processedAssistantMessageIdsBySessionId.get(sessionID) === latestAssistant.info.id
  ) {
    return;
  }

  const messageText = getTextContent(latestAssistant.parts);
  if (!messageText) return;

  const contentSessionId = getOrCreateContentSessionId(sessionID);
  await workerPost("/api/sessions/observations", {
    contentSessionId,
    tool_name: "assistant_message",
    tool_input: {},
    tool_response: messageText,
    cwd: ctx.directory,
    platformSource: OPENCODE_PLATFORM_SOURCE,
  });
  await workerPost("/api/sessions/summarize", {
    contentSessionId,
    last_assistant_message: messageText,
    platformSource: OPENCODE_PLATFORM_SOURCE,
  });
  processedAssistantMessageIdsBySessionId.set(sessionID, latestAssistant.info.id);
};
```

Replace compaction handling with:

```ts
"experimental.session.compacting": async (
  input: SessionCompactingInput,
): Promise<void> => {
  await captureAssistantLifecycle(input.sessionID);
},
```

Replace the `session.idle` and `session.deleted` cases with:

```ts
case "session.idle": {
  await captureAssistantLifecycle(sessionID);
  break;
}
case "session.deleted": {
  contentSessionIdsByOpenCodeSessionId.delete(sessionID);
  processedAssistantMessageIdsBySessionId.delete(sessionID);
  contextBySessionId.delete(sessionID);
  break;
}
```

- [ ] **Step 5: Run focused tests and root typechecking**

Run:

```bash
rtk bun test tests/integrations/opencode-plugin-contract.test.ts
rtk npm run typecheck:root
```

Expected: both commands PASS. Repeated idle/compaction events emit one assistant observation and one summary per assistant message ID, and empty or unavailable snapshots emit neither.

- [ ] **Step 6: Commit assistant lifecycle capture**

```bash
rtk git add src/integrations/opencode-plugin/index.ts tests/integrations/opencode-plugin-contract.test.ts
rtk git commit -m "fix: capture completed OpenCode assistant replies"
```

### Task 3: Valid Empty Initialization Logging

**Files:**
- Create: `tests/worker/openai-compatible-provider.test.ts`
- Modify: `src/services/worker/OpenAICompatibleProvider.ts:159-180`

**Interfaces:**
- Consumes: `OpenAICompatibleProvider.startSession(session, worker?)`.
- Produces: a `logger.debug("SDK", ...)` event for an empty successful initialization response.
- Preserves: existing warning behavior for empty observation and summary responses.

- [ ] **Step 1: Write the failing provider lifecycle test**

Create `tests/worker/openai-compatible-provider.test.ts`:

```ts
import { describe, expect, it, spyOn } from "bun:test";
import {
  OpenAICompatibleProvider,
  type ProviderQueryResult,
} from "../../src/services/worker/OpenAICompatibleProvider.js";
import type { DatabaseManager } from "../../src/services/worker/DatabaseManager.js";
import type { SessionManager } from "../../src/services/worker/SessionManager.js";
import type {
  ActiveSession,
  ConversationMessage,
} from "../../src/services/worker-types.js";
import { logger } from "../../src/utils/logger.js";

interface TestConfig {
  apiKey: string;
  model: string;
}

class EmptyInitProvider extends OpenAICompatibleProvider<TestConfig> {
  protected readonly providerName = "TestProvider";
  protected readonly syntheticIdPrefix = "test";
  protected readonly forwardEmptyMessageResponse = false;

  protected getConfig(): TestConfig {
    return { apiKey: "test-key", model: "test-model" };
  }

  protected missingApiKeyError(): Error {
    return new Error("missing test key");
  }

  protected async query(
    _history: ConversationMessage[],
    _config: TestConfig,
  ): Promise<ProviderQueryResult> {
    return { content: "" };
  }

  protected estimateTokens(text: string): number {
    return text.length;
  }

  protected buildLastUsage(
    result: ProviderQueryResult,
  ): ActiveSession["lastUsage"] {
    return {
      input: result.inputTokens || 0,
      output: result.outputTokens || 0,
    };
  }
}

function createSession(): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: "content-1",
    memorySessionId: "memory-1",
    project: "test-project",
    platformSource: "opencode",
    userPrompt: "remember this",
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: "test",
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

describe("OpenAI-compatible provider initialization", () => {
  it("logs an allowed empty initialization response at debug severity", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const error = spyOn(logger, "error").mockImplementation(() => {});
    const success = spyOn(logger, "success").mockImplementation(() => {});
    const sessionManager = {
      getMessageIterator: async function* () {},
    } as unknown as SessionManager;
    const provider = new EmptyInitProvider(
      {} as DatabaseManager,
      sessionManager,
    );

    try {
      await provider.startSession(createSession());

      expect(debug).toHaveBeenCalledWith(
        "SDK",
        "Empty TestProvider init response - session may lack context",
        { sessionId: 1, model: "test-model" },
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      error.mockRestore();
      success.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
rtk bun test tests/worker/openai-compatible-provider.test.ts
```

Expected: FAIL because the empty initialization branch calls `logger.error` and never calls `logger.debug`.

- [ ] **Step 3: Change only the valid empty-init severity**

In `OpenAICompatibleProvider.handleInitResponse`, replace the empty branch with:

```ts
} else {
  logger.debug("SDK", `Empty ${this.providerName} init response - session may lack context`, {
    sessionId: session.sessionDbId,
    model,
  });
}
```

Do not change `processObservationMessage` or `processSummaryMessage`; their empty-response warnings protect queued-work recovery.

- [ ] **Step 4: Run provider tests and root typechecking**

Run:

```bash
rtk bun test tests/worker/openai-compatible-provider.test.ts
rtk npm run typecheck:root
```

Expected: both commands PASS, with no TypeScript diagnostics.

- [ ] **Step 5: Commit the log-severity correction**

```bash
rtk git add src/services/worker/OpenAICompatibleProvider.ts tests/worker/openai-compatible-provider.test.ts
rtk git commit -m "fix: accept empty observer initialization results"
```

### Task 4: Regression, Build, Install, And Live Verification

**Files:**
- Verify: `tests/integrations/opencode-plugin-contract.test.ts`
- Verify: `tests/integration/opencode-installer.test.ts`
- Verify: `tests/worker/openai-compatible-provider.test.ts`
- Verify: `src/integrations/opencode-plugin/entry.ts`
- Build: `dist/opencode-plugin/index.js`
- Install: `/Users/samuelzhang/.config/opencode/plugins/claude-mem.js`

**Interfaces:**
- Consumes: all source and tests from Tasks 1-3.
- Produces: a default-only OpenCode bundle whose installed SHA-256 equals the built artifact.
- Produces: live OpenCode 1.17.18 evidence for real prompt text, assistant capture, summary generation, platform classification, queue drain, and vector-backed search.

- [ ] **Step 1: Run the focused and installer regression suites**

Run:

```bash
rtk bun test tests/integrations/opencode-plugin-contract.test.ts tests/integration/opencode-installer.test.ts tests/worker/openai-compatible-provider.test.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run root typechecking and inspect the intended diff**

Run:

```bash
rtk npm run typecheck:root
rtk git diff --check
rtk git status --short
rtk git diff -- src/integrations/opencode-plugin/index.ts src/services/worker/OpenAICompatibleProvider.ts tests/integrations/opencode-plugin-contract.test.ts tests/worker/openai-compatible-provider.test.ts
```

Expected: typechecking and `git diff --check` PASS. Status contains no unintended tracked files; `.serena/` remains untouched.

- [ ] **Step 3: Build the production artifacts and verify the OpenCode export**

Run:

```bash
rtk node scripts/build-hooks.js
rtk node -e "import('./dist/opencode-plugin/index.js').then((entry) => { const keys = Object.keys(entry); console.log(JSON.stringify({ keys, defaultType: typeof entry.default })); if (JSON.stringify(keys) !== JSON.stringify(['default']) || typeof entry.default !== 'function') process.exit(1); })"
```

Expected: the build exits successfully and export verification prints:

```json
{"keys":["default"],"defaultType":"function"}
```

- [ ] **Step 4: Install the exact bundle and verify artifact identity**

First verify the destination directory, then copy and hash:

```bash
rtk ls "/Users/samuelzhang/.config/opencode/plugins"
rtk cp "dist/opencode-plugin/index.js" "/Users/samuelzhang/.config/opencode/plugins/claude-mem.js"
rtk shasum -a 256 "dist/opencode-plugin/index.js" "/Users/samuelzhang/.config/opencode/plugins/claude-mem.js"
```

Expected: both SHA-256 lines are identical.

- [ ] **Step 5: Restart the rebuilt worker and check readiness**

Run:

```bash
rtk bun plugin/scripts/worker-service.cjs restart
rtk curl --fail --silent "http://127.0.0.1:37701/api/health/readiness"
```

Expected: restart succeeds and readiness returns `{"status":"ready","mcpReady":true}`.

- [ ] **Step 6: Run a uniquely tagged OpenCode 1.17.18 lifecycle**

Verify the approved temporary parent exists, create an isolated fixture, then run OpenCode with the installed external plugin enabled:

```bash
rtk ls "/var/folders/l2/1kn891795176fdh5kd3y84hc0000gn/T/opencode"
FIXTURE_DIR="$(rtk mktemp -d /var/folders/l2/1kn891795176fdh5kd3y84hc0000gn/T/opencode/claude-mem-lifecycle.XXXXXX)"
RUN_TAG="OpenCodeLifecycle$(rtk date +%s)"
rtk opencode run --dir "$FIXTURE_DIR" --format json --print-logs "Remember the unique marker $RUN_TAG, then reply with: assistant marker $RUN_TAG"
```

Expected: OpenCode reports version `1.17.18`, loads claude-mem without an export error, exits successfully, and emits an assistant response containing the unique marker.

- [ ] **Step 7: Verify prompt text, platform classification, queue drain, and generated memory**

Use the printed `RUN_TAG` from Step 6:

```bash
rtk sqlite3 "/Users/samuelzhang/.claude-mem/claude-mem.db" "SELECT s.platform_source, p.prompt_number, p.prompt_text FROM user_prompts p JOIN sdk_sessions s ON s.id = p.session_db_id WHERE p.prompt_text LIKE '%${RUN_TAG}%' ORDER BY p.id DESC LIMIT 1;"
rtk sqlite3 "/Users/samuelzhang/.claude-mem/claude-mem.db" "SELECT COUNT(*) FROM pending_messages WHERE status IN ('pending', 'processing') AND content_session_id = (SELECT content_session_id FROM user_prompts WHERE prompt_text LIKE '%${RUN_TAG}%' ORDER BY id DESC LIMIT 1);"
rtk sqlite3 "/Users/samuelzhang/.claude-mem/claude-mem.db" "SELECT o.type, o.title, o.narrative FROM observations o JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE s.platform_source = 'opencode' AND (o.text LIKE '%${RUN_TAG}%' OR o.title LIKE '%${RUN_TAG}%' OR o.narrative LIKE '%${RUN_TAG}%') ORDER BY o.id DESC LIMIT 5;"
rtk sqlite3 "/Users/samuelzhang/.claude-mem/claude-mem.db" "SELECT ss.request, ss.completed, ss.notes FROM session_summaries ss JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id WHERE s.platform_source = 'opencode' AND (ss.request LIKE '%${RUN_TAG}%' OR ss.completed LIKE '%${RUN_TAG}%' OR ss.notes LIKE '%${RUN_TAG}%') ORDER BY ss.id DESC LIMIT 1;"
```

Expected: the prompt row contains the full real prompt rather than `[media prompt]`; its platform is `opencode`; pending/processing count reaches `0`; an observation and summary associated with the tagged run are present.

- [ ] **Step 8: Verify vector-backed search and absence of the former empty-summary error**

Run:

```bash
rtk curl --fail --silent --get --data-urlencode "query=${RUN_TAG}" --data-urlencode "limit=10" "http://127.0.0.1:37701/api/search/observations"
LOG_FILE="/Users/samuelzhang/.claude-mem/logs/claude-mem-$(rtk date +%Y-%m-%d).log"
rtk grep "Missing last_assistant_message in session for summary prompt" "$LOG_FILE"
```

Expected: search returns the tagged observation. The grep command returns no lines created by the tagged run; inspect timestamps if older historical matches remain.

- [ ] **Step 9: Run final repository checks and review all task commits**

Run:

```bash
rtk git status --short
rtk git diff --check
rtk git log --oneline -8
```

Expected: only unrelated pre-existing `.serena/` remains untracked, no whitespace errors are reported, and the three task commits appear above the design and plan commits.
