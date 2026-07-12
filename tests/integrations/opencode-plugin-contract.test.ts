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
    };
    posts.push(post);
    return respond(post);
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

  it("keeps the directory project last so the worker treats it as primary", async () => {
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
      const contextUrl = new URL(requests[0]);
      const projects = contextUrl.searchParams.get("projects")?.split(",");
      expect(projects).toEqual(["opencode", "x"]);
      expect(projects && projects[projects.length - 1]).toBe("x");
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

      const firstTransform = transform(
        { sessionID: "concurrent-context", model: {} as never },
        first,
      );
      await requestStarted;
      const secondTransform = transform(
        { sessionID: "concurrent-context", model: {} as never },
        second,
      );

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

  it("invalidates an in-flight context request when a session is deleted and reused", async () => {
    const originalFetch = globalThis.fetch;
    const releases: Array<(response: Response) => void> = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        releases.push(resolve);
      })) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const transform = plugin["experimental.chat.system.transform"];
      const oldOutput = { system: ["base"] };
      const reusedOutput = { system: ["base"] };
      const followerOutput = { system: ["base"] };

      const oldTransform = transform(
        { sessionID: "reused-context", model: {} as never },
        oldOutput,
      );
      expect(releases).toHaveLength(1);

      await plugin.event({
        event: { type: "session.deleted", properties: { sessionID: "reused-context" } },
      });
      const reusedTransform = transform(
        { sessionID: "reused-context", model: {} as never },
        reusedOutput,
      );
      expect(releases).toHaveLength(2);

      releases[0](new Response("# stale context", { status: 200 }));
      await oldTransform;

      let followerSettled = false;
      const followerTransform = transform(
        { sessionID: "reused-context", model: {} as never },
        followerOutput,
      ).then(() => {
        followerSettled = true;
      });
      await Promise.resolve();

      expect(releases).toHaveLength(2);
      expect(followerSettled).toBe(false);

      releases[1](new Response("# current context", { status: 200 }));
      await Promise.all([reusedTransform, followerTransform]);
      expect(reusedOutput.system).toEqual(["base", "# current context"]);
      expect(followerOutput.system).toEqual(["base", "# current context"]);

      const cachedOutput = { system: ["base"] };
      await transform(
        { sessionID: "reused-context", model: {} as never },
        cachedOutput,
      );
      expect(releases).toHaveLength(2);
      expect(cachedOutput.system).toEqual(["base", "# current context"]);
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

  it("captures and summarizes the latest completed assistant reply once", async () => {
    const posts: RecordedPost[] = [];
    const messageRequests: unknown[] = [];
    const restoreFetch = installFetchRecorder(posts);
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
      const observations = posts.filter((post) =>
        post.url.includes("/api/sessions/observations"),
      );
      const summaries = posts.filter((post) =>
        post.url.includes("/api/sessions/summarize"),
      );
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
      restoreFetch();
    }
  });

  it("serializes overlapping assistant lifecycle triggers", async () => {
    const posts: RecordedPost[] = [];
    let releaseObservation!: (response: Response) => void;
    let markObservationStarted!: () => void;
    const observationStarted = new Promise<void>((resolve) => {
      markObservationStarted = resolve;
    });
    let observationAttempts = 0;
    const restoreFetch = installFetchRecorder(posts, (post) => {
      if (post.url.includes("/api/sessions/observations")) {
        observationAttempts += 1;
        if (observationAttempts === 1) {
          markObservationStarted();
          return new Promise<Response>((resolve) => {
            releaseObservation = resolve;
          });
        }
      }
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    });

    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: "assistant-overlap",
                    role: "assistant",
                    time: { completed: 25 },
                  },
                  parts: [{ type: "text", text: "one serialized reply" }],
                },
              ],
            }),
          },
        },
      });

      const idlePromise = plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_overlap" } },
      });
      await observationStarted;
      const compactionPromise = plugin["experimental.session.compacting"]({
        sessionID: "ses_overlap",
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseObservation(new Response(JSON.stringify({ status: "queued" }), { status: 200 }));
      await Promise.all([idlePromise, compactionPromise]);

      expect(
        posts.filter((post) => post.url.includes("/api/sessions/observations")),
      ).toHaveLength(1);
      expect(
        posts.filter((post) => post.url.includes("/api/sessions/summarize")),
      ).toHaveLength(1);
    } finally {
      restoreFetch();
    }
  });

  it("retries a completed textless assistant message when usable text appears", async () => {
    const posts: RecordedPost[] = [];
    const latest = {
      info: {
        id: "assistant-retry",
        role: "assistant",
        time: { completed: 30 },
      },
      parts: [{ type: "text", text: "hidden", ignored: true }],
    };
    const restoreFetch = installFetchRecorder(posts);

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

      expect(
        posts.filter((post) => post.url.includes("/api/sessions/observations")),
      ).toHaveLength(1);
      expect(
        posts.filter((post) => post.url.includes("/api/sessions/summarize")),
      ).toHaveLength(1);
    } finally {
      restoreFetch();
    }
  });

  it("sends no lifecycle POST when no completed assistant reply exists", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

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
      restoreFetch();
    }
  });

  it("skips lifecycle POSTs when OpenCode message listing fails", async () => {
    const posts: RecordedPost[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const restoreFetch = installFetchRecorder(posts);

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
      restoreFetch();
    }
  });

  it("clears assistant deduplication state when a session is deleted", async () => {
    const posts: RecordedPost[] = [];
    const restoreFetch = installFetchRecorder(posts);

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

      expect(
        posts.filter((post) => post.url.includes("/api/sessions/observations")),
      ).toHaveLength(2);
      expect(
        posts.filter((post) => post.url.includes("/api/sessions/summarize")),
      ).toHaveLength(2);
    } finally {
      restoreFetch();
    }
  });

  it("retries only observation when observation delivery fails", async () => {
    const posts: RecordedPost[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let observationAttempts = 0;
    const restoreFetch = installFetchRecorder(posts, (post) => {
      if (post.url.includes("/api/sessions/observations")) {
        observationAttempts += 1;
        return new Response("unavailable", {
          status: observationAttempts === 1 ? 503 : 200,
        });
      }
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    });

    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        client: {
          session: {
            messages: async () => ({
              data: [
                {
                  info: {
                    id: "assistant-observation-retry",
                    role: "assistant",
                    time: { completed: 50 },
                  },
                  parts: [{ type: "text", text: "retry observation" }],
                },
              ],
            }),
          },
        },
      });

      await plugin["event"]({
        event: {
          type: "session.idle",
          properties: { sessionID: "ses_observation_retry" },
        },
      });
      await plugin["experimental.session.compacting"]({
        sessionID: "ses_observation_retry",
      });
      await plugin["event"]({
        event: {
          type: "session.idle",
          properties: { sessionID: "ses_observation_retry" },
        },
      });

      expect(
        posts.filter((post) => post.url.includes("/api/sessions/observations")),
      ).toHaveLength(2);
      expect(
        posts.filter((post) => post.url.includes("/api/sessions/summarize")),
      ).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        "[claude-mem] Worker POST /api/sessions/observations returned 503",
      );
    } finally {
      warn.mockRestore();
      restoreFetch();
    }
  });

  it("retries only summary when summary delivery fails", async () => {
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
              data: [
                {
                  info: {
                    id: "assistant-summary-retry",
                    role: "assistant",
                    time: { completed: 60 },
                  },
                  parts: [{ type: "text", text: "retry summary" }],
                },
              ],
            }),
          },
        },
      });

      await plugin["event"]({
        event: {
          type: "session.idle",
          properties: { sessionID: "ses_summary_retry" },
        },
      });
      await plugin["experimental.session.compacting"]({
        sessionID: "ses_summary_retry",
      });
      await plugin["event"]({
        event: {
          type: "session.idle",
          properties: { sessionID: "ses_summary_retry" },
        },
      });

      expect(
        posts.filter((post) => post.url.includes("/api/sessions/observations")),
      ).toHaveLength(1);
      expect(
        posts.filter((post) => post.url.includes("/api/sessions/summarize")),
      ).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(
        "[claude-mem] Worker POST /api/sessions/summarize failed: summary unavailable",
      );
    } finally {
      warn.mockRestore();
      restoreFetch();
    }
  });

  it("finishes a selected pending message before advancing to a newer latest reply", async () => {
    const posts: RecordedPost[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let snapshots = [
      {
        info: {
          id: "assistant-pending-a",
          role: "assistant",
          time: { completed: 70 },
        },
        parts: [{ type: "text", text: "reply A" }],
      },
    ];
    let observationAttempts = 0;
    const restoreFetch = installFetchRecorder(posts, (post) => {
      if (post.url.includes("/api/sessions/observations")) {
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
        event: { type: "session.idle", properties: { sessionID: "ses_pending" } },
      });

      snapshots = [
        ...snapshots,
        {
          info: {
            id: "assistant-never-selected",
            role: "assistant",
            time: { completed: 80 },
          },
          parts: [{ type: "text", text: "do not backfill" }],
        },
        {
          info: {
            id: "assistant-latest-b",
            role: "assistant",
            time: { completed: 90 },
          },
          parts: [{ type: "text", text: "reply B" }],
        },
      ];
      await plugin["experimental.session.compacting"]({ sessionID: "ses_pending" });
      await plugin["event"]({
        event: { type: "session.idle", properties: { sessionID: "ses_pending" } },
      });

      const observationTexts = posts
        .filter((post) => post.url.includes("/api/sessions/observations"))
        .map((post) => post.body.tool_response);
      const summaryTexts = posts
        .filter((post) => post.url.includes("/api/sessions/summarize"))
        .map((post) => post.body.last_assistant_message);
      expect(observationTexts).toEqual(["reply A", "reply A", "reply B"]);
      expect(summaryTexts).toEqual(["reply A", "reply B"]);
      expect(observationTexts).not.toContain("do not backfill");
      expect(summaryTexts).not.toContain("do not backfill");
      expect(warn).toHaveBeenCalledWith(
        "[claude-mem] Worker POST /api/sessions/observations returned 503",
      );
    } finally {
      warn.mockRestore();
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
              data: [
                {
                  info: {
                    id: "assistant-platform",
                    role: "assistant",
                    time: { completed: 50 },
                  },
                  parts: [{ type: "text", text: "completed platform reply" }],
                },
              ],
            }),
          },
        },
      });

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

      const assistantObservations = sessionPosts.filter(
        (post) => post.body.tool_name === "assistant_message",
      );
      const summaries = sessionPosts.filter((post) =>
        post.url.includes("/api/sessions/summarize"),
      );

      expect(sessionPosts.length).toBeGreaterThan(0);
      expect(assistantObservations).toHaveLength(2);
      expect(summaries).toHaveLength(2);
      for (const post of assistantObservations) {
        expect(post.body.tool_response).toBe("completed platform reply");
        expect(post.body.platformSource).toBe("opencode");
      }
      for (const post of summaries) {
        expect(post.body.last_assistant_message).toBe("completed platform reply");
        expect(post.body.platformSource).toBe("opencode");
      }

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
