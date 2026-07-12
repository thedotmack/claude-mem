import { describe, it, expect, spyOn } from "bun:test";
import {
  ClaudeMemPlugin,
  parseSearchResponse,
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/index";

/**
 * Regression guard for plan-08 (OpenCode event-contract correctness).
 *
 * The old plugin subscribed to bus event names that do not exist in OpenCode
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`,
 * `session.deleted` on a `(name, payload)` switch) and parsed `data.items`
 * instead of the worker's real `data.content` blocks — so it captured nothing
 * and search always returned "No results". These tests fail CI if either
 * contract regresses.
 */

// The real OpenCode plugin hook names. Anything the plugin returns as a hook
// key must be in this allowlist; a future typo (e.g. "session.created") fails.
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
  // `tool` is the custom-tool registration map, part of the plugin return shape.
  "tool",
]);

// Bus event names the old code used that DO NOT exist in OpenCode's contract.
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

type RecordedPost = { url: string; body: Record<string, unknown> };

function installFetchRecorder(posts: RecordedPost[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
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

    // The exported allowlist of hooks we bind to must itself be real.
    for (const hook of REGISTERED_OPENCODE_HOOKS) {
      expect(REAL_OPENCODE_HOOK_NAMES.has(hook)).toBe(true);
    }

    // The capture-critical hooks must be present.
    expect(hookKeys).toContain("tool.execute.after");
    expect(hookKeys).toContain("chat.message");
    expect(hookKeys).toContain("experimental.session.compacting");
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
    // session.idle / session.deleted are real OpenCode bus events; the phantom
    // names must never appear in the reacted-to allowlist.
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.idle");
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.deleted");
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(REAL_OPENCODE_EVENT_TYPES as readonly string[]).not.toContain(phantom);
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
      expect(initPosts[0].body.project).toBe("x");
      expect(initPosts[0].body.platformSource).toBe("opencode");
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

  it("posts tool observations with input.args and does not create an empty prompt", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

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
      const observation = posts.find((post) =>
        post.url.includes("/api/sessions/observations"),
      );
      expect(observation?.body.tool_name).toBe("read");
      expect(observation?.body.tool_input).toEqual({ path: "/a" });
      expect(observation?.body.tool_response).toBe("file contents");
      expect(observation?.body.platformSource).toBe("opencode");
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

  it("injects directory-scoped context into every system prompt build", async () => {
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
      await transform({ sessionID: "context-session", model: {} as never }, first);
      await transform({ sessionID: "context-session", model: {} as never }, second);

      expect(first.system).toEqual(["base", "# remembered context"]);
      expect(second.system).toEqual(["base", "# remembered context"]);
      expect(requests.filter((url) => url.includes("/api/context/inject"))).toHaveLength(1);
      expect(requests[0]).toContain("projects=x%2Copencode");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not block when worker fetch hangs (bounded transform)", async () => {
    const originalFetch = globalThis.fetch;
    // Stub fetch to hang forever BUT respect AbortSignal so the timeout path
    // can actually reject the in-flight request.
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        });
      })) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const transform = plugin["experimental.chat.system.transform"];
      const output = { system: ["base"] };

      const start = Date.now();
      await transform({ sessionID: "hang-session", model: {} as never }, output);
      const elapsed = Date.now() - start;

      // Hook must complete in bounded time (WORKER_GET_TIMEOUT_MS + margin),
      // not block for the OS TCP timeout (~75s).
      expect(elapsed).toBeLessThan(7000);
      // Context was null (fetch never resolved), so nothing pushed.
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

  it("every lifecycle POST body carries platformSource=opencode", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);

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

      await plugin["experimental.session.compacting"]({ sessionID: "ses_compact" });
      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_idle" } },
      });

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
        searchSignal = init?.signal;
      }
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "Found remembered auth context" }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const result = await plugin.tool.claude_mem_search.execute({ query: "auth" });

      expect(searchSignal).toBeUndefined();
      expect(result).toContain("remembered auth context");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses the worker's real data.content blocks and returns the rows", () => {
    // This is exactly what SearchManager.searchObservations returns on a hit.
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
    // The pre-fix worker contract was wrongly assumed to be { items: [...] }.
    // A client that still reads data.items would render rows here; the real
    // client reads data.content, so this is correctly reported as no results.
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
