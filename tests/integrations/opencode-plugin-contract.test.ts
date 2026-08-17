import { describe, it, expect, spyOn } from "bun:test";
import {
  ClaudeMemPlugin,
  parseSearchResponse,
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/index";

/**
 * Regression guard for plan-08 (OpenCode event-contract correctness) plus the
 * plan-23 OpenCode lifecycle rework from #3208: awaited POSTs with a bounded
 * timeout, completed-reply capture for every assistant message, idempotency
 * keys, and startup-context injection.
 */

const REAL_OPENCODE_HOOK_NAMES = new Set<string>([
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "experimental.chat.system.transform",
  "tool.execute.before",
  "permission.ask",
  "auth",
  "config",
  "tool",
]);

const PHANTOM_BUS_EVENT_NAMES = [
  "session.created",
  "message.updated",
  "session.compacted",
  "file.edited",
];

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

type RecordedPost = { url: string; body: Record<string, unknown>; signal?: AbortSignal | null };
type FetchResponder = (post: RecordedPost) => Response | Promise<Response>;

function installFetchRecorder(
  posts: RecordedPost[],
  respond: FetchResponder = () =>
    new Response(JSON.stringify({ status: "queued" }), { status: 200 }),
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const post = {
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
      signal: init?.signal ?? null,
    };
    posts.push(post);
    return respond(post);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function hangUntilAborted(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    });
  });
}

function assistantSnapshot(id: string, text: string, completed: number) {
  return {
    info: { id, role: "assistant", time: { completed } },
    parts: [{ type: "text", text }],
  };
}

describe("OpenCode plugin event contract", () => {
  it("only registers hooks that are part of OpenCode's real contract", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);

    for (const key of hookKeys) {
      expect(
        REAL_OPENCODE_HOOK_NAMES.has(key),
        `hook "${key}" is not a real OpenCode hook name`,
      ).toBe(true);
    }

    for (const hook of REGISTERED_OPENCODE_HOOKS) {
      expect(REAL_OPENCODE_HOOK_NAMES.has(hook)).toBe(true);
    }

    expect(hookKeys).toContain("tool.execute.after");
    expect(hookKeys).toContain("chat.message");
    expect(hookKeys).toContain("experimental.session.compacting");
    expect(hookKeys).toContain("experimental.chat.system.transform");
    expect(hookKeys).toContain("event");
  });

  it("does not register the phantom bus event names as hooks", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(hookKeys).not.toContain(phantom);
    }
  });

  it("only reacts to real bus event types", () => {
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.idle");
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.deleted");
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(REAL_OPENCODE_EVENT_TYPES as readonly string[]).not.toContain(phantom);
    }
  });

  it("posts tool observations with args, platformSource, and an idempotency key", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        {
          tool: "read",
          sessionID: "ses_tool_contract",
          callID: "c1",
          args: { path: "/a" },
        },
        { title: "Read", output: "file contents", metadata: {} },
      );

      expect(posts.some((post) => post.url.includes("/api/sessions/init"))).toBe(false);
      const observation = posts.find((post) =>
        post.url.includes("/api/sessions/observations"),
      );
      expect(observation?.body.tool_name).toBe("read");
      expect(observation?.body.tool_input).toEqual({ path: "/a" });
      expect(observation?.body.tool_response).toBe("file contents");
      expect(observation?.body.platformSource).toBe("opencode");
      expect(String(observation?.body.idempotencyKey)).toContain(":tool:c1");
      expect(observation?.body.toolUseId).toBe(observation?.body.idempotencyKey);
      expect(observation?.signal).toBeTruthy();
    } finally {
      restoreFetch();
    }
  });

  it("still reads tool args from output.args for older OpenCode shapes", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_legacy_args", callID: "c-legacy" },
        { title: "Read", output: "file contents", metadata: {}, args: { path: "/a" } },
      );

      const observation = posts.find((post) =>
        post.url.includes("/api/sessions/observations"),
      );
      expect(observation?.body.tool_input).toEqual({ path: "/a" });
    } finally {
      restoreFetch();
    }
  });

  it("posts every real user turn with one stable content-session ID", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

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
      expect(initPosts[0].body.platformSource).toBe("opencode");
      expect(initPosts[0].body.idempotencyKey).toBeTruthy();
    } finally {
      restoreFetch();
    }
  });

  it("does not treat assistant chat.message events as session prompts", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["chat.message"](
        { sessionID: "ses_assistant_chat" },
        {
          message: { id: "asst-stream", role: "assistant", sessionID: "ses_assistant_chat" },
          parts: [{ type: "text", text: "partial stream" }],
        },
      );

      expect(posts).toEqual([]);
    } finally {
      restoreFetch();
    }
  });

  it("uses the media marker only when a user turn has no usable text", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

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
      restoreFetch();
    }
  });

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

  it("does not block when a worker POST hangs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hangUntilAborted as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const start = Date.now();
      await plugin["chat.message"](
        { sessionID: "ses_post_hang" },
        {
          message: { id: "user-hang", role: "user", sessionID: "ses_post_hang" },
          parts: [{ type: "text", text: "should time out" }],
        },
      );
      expect(Date.now() - start).toBeLessThan(7000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);

  it("logs a non-success worker POST once without rejecting the hook", async () => {
    const originalFetch = globalThis.fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () =>
      new Response("unavailable", { status: 503 })) as typeof fetch;

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
      expect(warn).toHaveBeenCalledWith(
        "[claude-mem] Worker POST /api/sessions/init returned 503",
      );
    } finally {
      warn.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("injects cached startup context and keeps the directory project last", async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response("# remembered context", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const transform = plugin["experimental.chat.system.transform"];
      const first = { system: ["base"] };
      const second = { system: ["base"] };
      await transform({ sessionID: "context-session" }, first);
      await transform({ sessionID: "context-session" }, second);

      expect(first.system).toEqual(["base", "# remembered context"]);
      expect(second.system).toEqual(["base", "# remembered context"]);
      expect(requests.filter((url) => url.includes("/api/context/inject"))).toHaveLength(1);
      const contextUrl = new URL(requests[0]);
      const projects = contextUrl.searchParams.get("projects")?.split(",");
      expect(projects?.[0]).toBe("opencode");
      expect(projects?.at(-1)).toBe("x");
      expect(contextUrl.searchParams.get("platformSource")).toBe("opencode");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("deduplicates an in-flight startup-context request per session", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    let releaseRequest!: (response: Response) => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    globalThis.fetch = (() => {
      requestCount += 1;
      markRequestStarted();
      return new Promise<Response>((resolve) => {
        releaseRequest = resolve;
      });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const transform = plugin["experimental.chat.system.transform"];
      const first = { system: ["base"] };
      const second = { system: ["base"] };

      const firstTransform = transform({ sessionID: "concurrent-context" }, first);
      await requestStarted;
      const secondTransform = transform({ sessionID: "concurrent-context" }, second);

      await Promise.resolve();
      expect(requestCount).toBe(1);

      releaseRequest(new Response("# shared context", { status: 200 }));
      await Promise.all([firstTransform, secondTransform]);
      expect(first.system).toEqual(["base", "# shared context"]);
      expect(second.system).toEqual(["base", "# shared context"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not block when worker context fetch hangs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hangUntilAborted as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const output = { system: ["base"] };
      const start = Date.now();
      await plugin["experimental.chat.system.transform"](
        { sessionID: "hang-session" },
        output,
      );
      expect(Date.now() - start).toBeLessThan(7000);
      expect(output.system).toEqual(["base"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);

  it("does not submit summaries without completed assistant text", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);

      await plugin["experimental.session.compacting"]({ sessionID: "ses_compact_empty" });
      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_idle_empty" } },
      });

      expect(posts.filter((post) => post.url.includes("/api/sessions/summarize"))).toEqual([]);
    } finally {
      restoreFetch();
    }
  });

  it("captures every completed assistant reply, not only the latest", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);
    const ctx = {
      ...pluginCtx,
      client: {
        session: {
          messages: async () => ({
            data: [
              assistantSnapshot("assistant-old", "old reply", 10),
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
          }),
        },
      },
    };

    try {
      const plugin = await ClaudeMemPlugin(ctx);
      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_all_replies" } },
      });

      const observations = posts.filter((post) =>
        post.url.includes("/api/sessions/observations"),
      );
      const summaries = posts.filter((post) =>
        post.url.includes("/api/sessions/summarize"),
      );
      expect(observations.map((post) => post.body.tool_response)).toEqual([
        "old reply",
        "first answer line\nsecond answer line",
      ]);
      expect(summaries.map((post) => post.body.last_assistant_message)).toEqual([
        "old reply",
        "first answer line\nsecond answer line",
      ]);
      expect(new Set(observations.map((post) => post.body.idempotencyKey)).size).toBe(2);
      expect(new Set(summaries.map((post) => post.body.idempotencyKey)).size).toBe(2);
      expect(String(summaries[0].body.idempotencyKey)).toContain(":summarize");
      expect(summaries[0].body.toolUseId).toBe(summaries[0].body.idempotencyKey);
    } finally {
      restoreFetch();
    }
  });

  it("retries a failed older reply after a newer one arrives", async () => {
    const posts: RecordedPost[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let snapshots = [assistantSnapshot("assistant-pending-a", "reply A", 70)];
    let observationAttempts = 0;
    const restoreFetch = installFetchRecorder(posts, (post) => {
      if (post.url.includes("/api/sessions/observations") && post.body.tool_response === "reply A") {
        observationAttempts += 1;
        if (observationAttempts === 1) {
          return new Response("unavailable", { status: 503 });
        }
      }
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    });

    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        client: {
          session: {
            messages: async () => ({ data: snapshots }),
          },
        },
      });

      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_pending_all" } },
      });

      snapshots = [
        ...snapshots,
        assistantSnapshot("assistant-middle", "reply middle", 80),
        assistantSnapshot("assistant-latest-b", "reply B", 90),
      ];
      await plugin["experimental.session.compacting"]({ sessionID: "ses_pending_all" });

      const observationTexts = posts
        .filter((post) => post.url.includes("/api/sessions/observations"))
        .map((post) => post.body.tool_response);
      expect(observationTexts).toContain("reply A");
      expect(observationTexts).toContain("reply middle");
      expect(observationTexts).toContain("reply B");
      expect(warn).toHaveBeenCalledWith(
        "[claude-mem] Worker POST /api/sessions/observations returned 503",
      );
    } finally {
      warn.mockRestore();
      restoreFetch();
    }
  });

  it("retries only the failed summary while keeping observation complete", async () => {
    const posts: RecordedPost[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let summaryAttempts = 0;
    const restoreFetch = installFetchRecorder(posts, (post) => {
      if (post.url.includes("/api/sessions/summarize")) {
        summaryAttempts += 1;
        if (summaryAttempts === 1) throw new Error("summary unavailable");
      }
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    });

    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        client: {
          session: {
            messages: async () => ({
              data: [assistantSnapshot("assistant-summary-retry", "retry summary", 60)],
            }),
          },
        },
      });

      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_summary_retry" } },
      });
      await plugin["experimental.session.compacting"]({
        sessionID: "ses_summary_retry",
      });

      expect(
        posts.filter((post) => post.url.includes("/api/sessions/observations")),
      ).toHaveLength(1);
      const summaries = posts.filter((post) =>
        post.url.includes("/api/sessions/summarize"),
      );
      expect(summaries).toHaveLength(2);
      expect(summaries[0].body.idempotencyKey).toBe(summaries[1].body.idempotencyKey);
    } finally {
      warn.mockRestore();
      restoreFetch();
    }
  });

  it("clears assistant delivery state when a session is deleted", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        client: {
          session: {
            messages: async () => ({
              data: [assistantSnapshot("assistant-deleted", "gone soon", 5)],
            }),
          },
        },
      });

      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_deleted" } },
      });
      const beforeDelete = posts.length;
      await plugin["event"]({
        event: { type: "session.deleted", properties: { sessionID: "ses_deleted" } },
      });
      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_deleted" } },
      });
      expect(posts.length).toBeGreaterThan(beforeDelete);
    } finally {
      restoreFetch();
    }
  });

  it("every lifecycle POST body carries platformSource=opencode", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        client: {
          session: {
            messages: async () => ({
              data: [assistantSnapshot("assistant-platform", "completed platform reply", 50)],
            }),
          },
        },
      });

      await plugin["chat.message"](
        { sessionID: "ses_platform" },
        {
          message: { id: "user-platform", role: "user", sessionID: "ses_platform" },
          parts: [{ type: "text", text: "hello" }],
        },
      );
      await plugin["tool.execute.after"](
        {
          tool: "read",
          sessionID: "ses_platform",
          callID: "c1",
          args: { path: "/a" },
        },
        { title: "Read", output: "file contents", metadata: {} },
      );
      await plugin["experimental.session.compacting"]({ sessionID: "ses_platform" });

      const sessionPosts = posts.filter(
        (p) =>
          p.url.includes("/api/sessions/init") ||
          p.url.includes("/api/sessions/observations") ||
          p.url.includes("/api/sessions/summarize"),
      );
      expect(sessionPosts.length).toBeGreaterThan(0);
      for (const post of sessionPosts) {
        expect(
          post.body.platformSource,
          `POST ${post.url} must carry platformSource=opencode`,
        ).toBe("opencode");
      }
    } finally {
      restoreFetch();
    }
  });
});

describe("OpenCode 1.17 plugin export contract", () => {
  it("exports exactly 'default' and the default export is a function", async () => {
    const entry = await import("../../src/integrations/opencode-plugin/entry");
    const keys = Object.keys(entry);
    expect(keys).toEqual(["default"]);
    expect(typeof entry.default).toBe("function");
  });
});

describe("OpenCode search client response-shape contract", () => {
  it("does not apply the startup-context timeout to explicit searches", async () => {
    let searchSignal: AbortSignal | null | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/search/observations")) {
        searchSignal = init?.signal ?? null;
      }
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "Found remembered auth context" }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const result = await plugin.tool.claude_mem_search.execute({ query: "auth" });

      expect(searchSignal).toBeFalsy();
      expect(result).toContain("remembered auth context");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses the worker's real data.content blocks and returns the rows", () => {
    const workerResponse = JSON.stringify({
      content: [
        {
          type: "text",
          text:
            'Found 2 observation(s) matching "auth"\n\n| # | Title |\n|---|---|\n1. Added login flow\n2. Fixed token refresh',
        },
      ],
    });

    const rendered = parseSearchResponse(workerResponse, "auth");
    expect(rendered).toContain("Found 2 observation(s)");
    expect(rendered).toContain("Added login flow");
    expect(rendered).toContain("Fixed token refresh");
    expect(rendered).not.toContain("No results");
  });

  it("does NOT parse the old data.items shape (regression guard)", () => {
    const oldShape = JSON.stringify({
      items: [{ title: "should-not-render" }, { title: "also-not" }],
    });
    const rendered = parseSearchResponse(oldShape, "auth");
    expect(rendered).toContain("No results");
    expect(rendered).not.toContain("should-not-render");
  });

  it("returns a clear no-results message for the worker's empty-content shape", () => {
    const emptyResponse = JSON.stringify({
      content: [{ type: "text", text: 'No observations found matching "zzz"' }],
    });
    const rendered = parseSearchResponse(emptyResponse, "zzz");
    expect(rendered).toContain("No observations found");
  });
});
