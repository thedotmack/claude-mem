import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import pluginEntry from "../../src/integrations/opencode-plugin/index";
import {
  setupV2,
  extractResultText,
  type OpenCodePluginContextV2,
  type V2BusEvent,
} from "../../src/integrations/opencode-plugin/v2";
import {
  REGISTERED_OPENCODE_HOOKS,
  REGISTERED_OPENCODE_V2_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
  REAL_OPENCODE_V2_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/contract";

/**
 * OpenCode V2 plugin contract.
 *
 * V2 replaced the returned-hooks-object API with `Plugin.define`: the module's
 * default export is `{ id, setup }`, validated with `Schema.Struct`, and
 * `setup(ctx)` registers behavior imperatively. A V1 hooks object is rejected
 * with "Plugin must export a default definition with an id and an effect or
 * setup function", and the host does not translate one API into the other.
 *
 * These tests pin the V2 registration surface: every hook the V1 adapter binds
 * must have a V2 counterpart, so a capture path cannot silently regress to
 * nothing (the "loads but captures nothing" failure mode of #3678 / #2435).
 */

interface RegisteredHook {
  domain: string;
  name: string;
}

/**
 * A stand-in for `ctx.event.subscribe()` shaped like the host's stream: each
 * subscription stays pending until an event arrives, finishes when its signal
 * aborts, and can be ended or failed to exercise the resubscribe path.
 */
class FakeEventStream {
  subscriptions = 0;
  private pending:
    | { resolve: (result: IteratorResult<V2BusEvent>) => void; reject: (error: Error) => void }
    | undefined;
  private buffered: V2BusEvent[] = [];

  subscribe = (options?: { signal?: AbortSignal }): AsyncIterable<V2BusEvent> => {
    this.subscriptions++;
    const signal = options?.signal;
    let closed = false;
    const done = (): IteratorResult<V2BusEvent> => ({ done: true, value: undefined });
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<V2BusEvent>> => {
          if (closed || signal?.aborted) return Promise.resolve(done());
          const event = this.buffered.shift();
          if (event) return Promise.resolve({ done: false, value: event });
          return new Promise((resolve, reject) => {
            this.pending = {
              resolve: (result) => {
                if (result.done) closed = true;
                resolve(result);
              },
              reject,
            };
            signal?.addEventListener("abort", () => resolve(done()), { once: true });
          });
        },
      }),
    };
  };

  send(event: V2BusEvent): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) pending.resolve({ done: false, value: event });
    else this.buffered.push(event);
  }

  end(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  get waiting(): boolean {
    return this.pending !== undefined;
  }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function createV2Context(
  overrides: Partial<OpenCodePluginContextV2> = {},
): {
  ctx: OpenCodePluginContextV2;
  hooks: RegisteredHook[];
  tools: Array<Record<string, unknown>>;
  disposeCount: () => number;
} {
  const hooks: RegisteredHook[] = [];
  const tools: Array<Record<string, unknown>> = [];
  let disposed = 0;

  const ctx: OpenCodePluginContextV2 = {
    directory: "/tmp/x",
    client: {},
    tool: {
      hook: async (name, _callback) => {
        hooks.push({ domain: "tool", name });
        return { dispose: async () => { disposed++; } };
      },
      transform: async (callback) => {
        hooks.push({ domain: "tool", name: "transform" });
        callback({
          add: (tool) => { tools.push(tool as unknown as Record<string, unknown>); },
        });
        return { dispose: async () => { disposed++; } };
      },
    },
    session: {
      hook: async (name, _callback) => {
        hooks.push({ domain: "session", name });
        return { dispose: async () => { disposed++; } };
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => {
        hooks.push({ domain: "event", name: "subscribe" });
        // Pending until cleanup aborts it; the bus is exercised by its own tests.
        return new FakeEventStream().subscribe(options);
      },
    },
    ...overrides,
  };

  return { ctx, hooks, tools, disposeCount: () => disposed };
}

describe("OpenCode V2 plugin definition", () => {
  it("default-exports a definition object V2's Schema.Struct accepts", () => {
    // `pluginEntry` IS the default export (imported with `default`).
    const definition = pluginEntry as unknown as Record<string, unknown>;

    // Schema.Struct({ id: Schema.String, setup: ... }) — id must be a string.
    expect(typeof definition).toBe("object");
    expect(typeof definition.id).toBe("string");
    expect(definition.id).toBe("claude-mem");
    expect(typeof definition.setup).toBe("function");
    // V1 (1.18.29+) reads this instead; V2 ignores it.
    expect(typeof definition.server).toBe("function");
  });
});

describe("OpenCode V2 hook registration", () => {
  it("registers every V2 hook in the contract", async () => {
    const { ctx, hooks } = createV2Context();
    await setupV2(ctx);

    const registered = hooks.map((h) => `${h.domain}.${h.name}`).sort();
    const expected = REGISTERED_OPENCODE_V2_HOOKS
      .map((h) => `${h.domain}.${h.hook}`)
      .sort();

    expect(registered).toEqual(expected);
  });

  it("covers every capture path the V1 adapter binds", async () => {
    // Each V1 hook must have a V2 counterpart. A missing one means claude-mem
    // silently stops capturing that kind of activity under V2.
    const { ctx, hooks } = createV2Context();
    await setupV2(ctx);
    const registered = new Set(hooks.map((h) => `${h.domain}.${h.name}`));

    // tool.execute.after  -> tool.execute.after
    expect(registered.has("tool.execute.after")).toBe(true);
    // chat.message (user) -> session.prompt
    expect(registered.has("session.prompt")).toBe(true);
    // experimental.chat.system.transform -> session.context
    expect(registered.has("session.context")).toBe(true);
    // experimental.session.compacting -> session.compaction
    expect(registered.has("session.compaction")).toBe(true);
    // event -> event.subscribe
    expect(registered.has("event.subscribe")).toBe(true);
  });

  it("keeps the V1 contract allowlist and the V2 registry in agreement", () => {
    // Same coverage, two notations: 5 V1 hook names vs 6 V2 registrations
    // (the extra one is the custom-tool transform, which V1 expressed as the
    // `tool` key on the returned object rather than a hook name).
    expect(REGISTERED_OPENCODE_HOOKS.length).toBe(5);
    expect(REGISTERED_OPENCODE_V2_HOOKS.length).toBe(6);
    expect(REAL_OPENCODE_EVENT_TYPES).toEqual(["session.idle", "session.deleted"]);
  });

  it("registers the custom search tool through the V2 tool transform", async () => {
    const { ctx, tools } = createV2Context();
    await setupV2(ctx);

    expect(tools.length).toBe(1);
    const tool = tools[0];
    expect(tool.name).toBe("claude_mem_search");
    expect(typeof tool.description).toBe("string");
    // JSON Schema object with a required `query`, matching the V1 zod arg.
    const input = tool.input as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(input.type).toBe("object");
    expect(input.properties).toHaveProperty("query");
    expect(input.required).toEqual(["query"]);
    expect(typeof tool.execute).toBe("function");
  });

  it("disposes every registration and stops the event stream on cleanup", async () => {
    const { ctx, disposeCount } = createV2Context();
    const cleanup = await setupV2(ctx);

    // 4 hook registrations + 1 tool transform; the event stream is not a
    // registration but is aborted by the same cleanup. Nothing is disposed
    // until cleanup runs.
    expect(disposeCount()).toBe(0);

    await cleanup();
    expect(disposeCount()).toBe(5);
  });
});

describe("OpenCode V2 graceful degradation", () => {
  it("loads and cleans up on a context with no hook surfaces", async () => {
    // The plugin API is still beta and the context is read defensively: a host
    // that lacks a domain must degrade to a no-op, never to a failed load.
    const cleanup = await setupV2({ directory: "/tmp/x" });
    expect(typeof cleanup).toBe("function");
    await cleanup();
  });

  it("registers nothing but still returns a cleanup on a partial context", async () => {
    const { ctx, hooks } = createV2Context({
      tool: undefined,
      session: undefined,
      event: undefined,
    });
    const cleanup = await setupV2(ctx);
    expect(hooks.length).toBe(0);
    await expect(cleanup()).resolves.toBeUndefined();
  });
});

describe("OpenCode V2 checkout resolution", () => {
  // V1 read `ctx.directory`; V2 nests it under `ctx.location`. Sending an
  // undefined cwd makes the worker drop every write with "Missing cwd when
  // ingesting observation" — the session row is still created, so it looks
  // like it works while nothing is ever recorded.
  async function captureCheckout(
    context: Partial<OpenCodePluginContextV2>,
  ): Promise<string | undefined> {
    const originalFetch = globalThis.fetch;
    const posts: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const cleanup = await setupV2(context);
      // Replay a real prompt through the captured hook, so the worker write
      // (and its `cwd`) actually happens.
      for (const callback of promptCallbacks) {
        await callback({ sessionID: "ses_checkout", prompt: { text: "checkout probe" } });
      }
      await cleanup();
      return posts[0]?.cwd as string | undefined;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const promptCallbacks: Array<(event: unknown) => Promise<void> | void> = [];
  const recordingSession = {
    hook: async (name: string, callback: (event: unknown) => Promise<void> | void) => {
      if (name === "prompt") promptCallbacks.push(callback);
      return { dispose: async () => {} };
    },
  };

  it("sends the checkout from ctx.location.directory", async () => {
    promptCallbacks.length = 0;
    const cwd = await captureCheckout({
      location: { directory: "C:/repo/sub" },
      session: recordingSession,
    });
    expect(cwd).toBe("C:/repo/sub");
  });

  it("falls back to an empty string when location is absent, never undefined", async () => {
    promptCallbacks.length = 0;
    const cwd = await captureCheckout({ session: recordingSession });
    expect(cwd).toBe("");
  });

  it("ignores a top-level ctx.directory, which V2 does not provide", async () => {
    promptCallbacks.length = 0;
    const cwd = await captureCheckout({
      location: { directory: "C:/repo" },
      directory: "C:/stale-v1-value",
      session: recordingSession,
    } as Partial<OpenCodePluginContextV2>);
    expect(cwd).toBe("C:/repo");
  });
});

describe("OpenCode V2 tool result extraction", () => {
  // Observed on v2.0.22: `result` is an object
  // `{ output: { exit, truncated, output }, content: [{ type: "text", text }] }`,
  // where `output` is tool-specific (an object for shell). V1 handed over
  // `output.output` as a plain string.
  it("prefers the text content blocks", () => {
    expect(
      extractResultText({
        output: { exit: 0, truncated: false, output: "from output.output" },
        content: [{ type: "text", text: "from content blocks" }],
      }),
    ).toBe("from content blocks");
  });

  it("falls back to a string output", () => {
    expect(extractResultText({ output: "plain output" })).toBe("plain output");
  });

  it("unwraps a nested shell-shaped output", () => {
    expect(extractResultText({ output: { exit: 0, output: "shell stdout" } })).toBe("shell stdout");
  });

  it("passes a bare string result through", () => {
    expect(extractResultText("already text")).toBe("already text");
  });

  it("returns empty rather than the string 'undefined' for an unusable result", () => {
    // The pre-fix fallback produced errorMessage(undefined) === "undefined",
    // which the worker then stored as the tool response verbatim.
    expect(extractResultText(undefined)).toBe("");
    expect(extractResultText(null)).toBe("");
    expect(extractResultText({})).toBe("");
  });
});

/**
 * A V2 host that keeps every callback setupV2 registers, so tests can drive
 * them with the events OpenCode sends, and records every worker request.
 */
interface WorkerRequest {
  method: string;
  path: string;
  url: URL;
  body: Record<string, any> | null;
}

type Callback = (event: any) => Promise<void> | void;

function createV2Host(directory = "/work/project") {
  const callbacks = new Map<string, Callback>();
  const tools: Array<Record<string, any>> = [];
  const stream = new FakeEventStream();
  const ctx: OpenCodePluginContextV2 = {
    directory: "",
    location: { directory },
    tool: {
      hook: async (name, callback) => {
        callbacks.set(`tool.${name}`, callback as Callback);
        return { dispose: async () => {} };
      },
      transform: async (callback) => {
        callback({ add: (tool) => { tools.push(tool as Record<string, any>); } });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, callback) => {
        callbacks.set(`session.${name}`, callback as Callback);
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: stream.subscribe },
  };
  const call = async (name: string, event: unknown) => {
    const callback = callbacks.get(name);
    if (!callback) throw new Error(`no ${name} callback registered`);
    await callback(event);
  };
  return { ctx, call, stream, tools };
}

function recordWorkerRequests(contextReply = "# memory context") {
  const requests: WorkerRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.pathname === "/api/context/inject") return new Response(contextReply, { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return {
    requests,
    to: (path: string) => requests.filter((request) => request.path === path),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

// Envelopes as `@opencode/schema` 2.0.22 defines them: `{ type, data, location }`.
function busEvent(
  type: string,
  sessionID: string,
  data: Record<string, unknown> = {},
  location: { directory: string } | null = { directory: "/work/project" },
): V2BusEvent {
  return { type, data: { sessionID, ...data }, location };
}

describe("OpenCode V2 event bus", () => {
  let worker: ReturnType<typeof recordWorkerRequests>;
  let cleanups: Array<() => Promise<void>>;
  const originalWarn = console.warn;

  beforeEach(() => {
    worker = recordWorkerRequests();
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    worker.restore();
    console.warn = originalWarn;
  });

  async function start(host = createV2Host()) {
    cleanups.push(await setupV2(host.ctx, { resubscribeDelayMs: 1 }));
    return host;
  }

  it("summarizes a finished turn with the reply from session.text.ended, even when the event has no location", async () => {
    const host = await start();
    await host.call("session.prompt", { sessionID: "ses_bus_turn", prompt: { text: "Read the parser" } });
    host.stream.send(busEvent("session.text.ended", "ses_bus_turn", { text: "Parser checked", ordinal: 0 }));
    // OpenCode 2.0.23 sends session.execution.* with location: null (#4519).
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_turn", {}, null));

    await until(() => worker.to("/api/sessions/summarize").length === 1);
    const [init] = worker.to("/api/sessions/init");
    const [summary] = worker.to("/api/sessions/summarize");
    expect(summary.body).toMatchObject({
      contentSessionId: init.body!.contentSessionId,
      last_assistant_message: "Parser checked",
      cwd: "/work/project",
      platform_source: "opencode",
    });
  });

  it("summarizes when a compaction ends, and never on the deprecated session.idle", async () => {
    const host = await start();
    await host.call("session.prompt", { sessionID: "ses_bus_compact", prompt: { text: "Long task" } });
    host.stream.send(busEvent("session.idle", "ses_bus_compact"));
    host.stream.send(busEvent("session.compaction.ended", "ses_bus_compact", { text: "compacted" }));

    await until(() => worker.to("/api/sessions/summarize").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(worker.to("/api/sessions/summarize")).toHaveLength(1);
  });

  it("ignores another checkout's events and sessions it captured nothing for", async () => {
    const host = await start();
    await host.call("session.prompt", { sessionID: "ses_bus_mine", prompt: { text: "Mine" } });
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_mine", {}, { directory: "/work/other" }));
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_unknown", {}, null));
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_mine", {}, null));

    // Events are handled in order, so once the last one summarized the first
    // two were already skipped.
    await until(() => worker.to("/api/sessions/summarize").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(worker.to("/api/sessions/summarize")).toHaveLength(1);
  });

  it("forgets a deleted session even when the event has no location", async () => {
    const host = await start();
    await host.call("session.prompt", { sessionID: "ses_bus_deleted", prompt: { text: "Before delete" } });
    await host.call("session.prompt", { sessionID: "ses_bus_kept", prompt: { text: "Kept" } });
    const [deletedInit, keptInit] = worker.to("/api/sessions/init");
    const before = deletedInit.body!.contentSessionId;

    host.stream.send(busEvent("session.deleted", "ses_bus_deleted", {}, null));
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_deleted", {}, null));
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_kept", {}, null));
    await until(() => worker.to("/api/sessions/summarize").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const summaries = worker.to("/api/sessions/summarize");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].body!.contentSessionId).toBe(keptInit.body!.contentSessionId);

    // The session mapping is gone too: a new prompt starts a new content session.
    await host.call("session.prompt", { sessionID: "ses_bus_deleted", prompt: { text: "After delete" } });
    const after = worker.to("/api/sessions/init").at(-1)!.body!.contentSessionId;
    expect(after).not.toBe(before);
  });

  it("subscribes again after the stream ends or fails", async () => {
    console.warn = () => {};
    const host = await start();
    await host.call("session.prompt", { sessionID: "ses_bus_resubscribe", prompt: { text: "Stay subscribed" } });
    await until(() => host.stream.waiting);

    host.stream.end();
    await until(() => host.stream.subscriptions === 2 && host.stream.waiting);
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_resubscribe"));
    await until(() => worker.to("/api/sessions/summarize").length === 1);

    host.stream.fail(new Error("connection reset"));
    await until(() => host.stream.subscriptions === 3 && host.stream.waiting);
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_resubscribe"));
    await until(() => worker.to("/api/sessions/summarize").length === 2);
  });

  it("stops reading and resubscribing once cleanup runs", async () => {
    const host = createV2Host();
    const cleanup = await setupV2(host.ctx, { resubscribeDelayMs: 1 });
    await until(() => host.stream.waiting);

    await cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.stream.subscriptions).toBe(1);
  });

  it("keeps the cached memory across a finished turn and drops it on compaction", async () => {
    const host = await start();
    const contextEvent = () => ({ sessionID: "ses_bus_cache", system: [] as Array<{ type: string; text?: string }> });
    const injects = () => worker.to("/api/context/inject").length;
    await host.call("session.prompt", { sessionID: "ses_bus_cache", prompt: { text: "Cache me" } });

    await host.call("session.context", contextEvent());
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_cache", {}, null));
    await until(() => worker.to("/api/sessions/summarize").length === 1);
    await host.call("session.context", contextEvent());
    expect(injects()).toBe(1);

    await host.call("session.compaction", { sessionID: "ses_bus_cache" });
    await host.call("session.context", contextEvent());
    expect(injects()).toBe(2);
  });

  it("reacts only to the event types in the V2 contract", () => {
    const source = readFileSync("src/integrations/opencode-plugin/v2.ts", "utf8");
    const handled = [...source.matchAll(/case "([a-z.]+)":/g)].map((match) => match[1]).sort();
    expect(handled).toEqual([...REAL_OPENCODE_V2_EVENT_TYPES].sort());
  });
});

describe("OpenCode V2 setup failure", () => {
  function failingHost(failure: "reject" | "throw") {
    const stream = new FakeEventStream();
    let registered = 0;
    let disposed = 0;
    const ctx: OpenCodePluginContextV2 = {
      directory: "",
      location: { directory: "/work/project" },
      tool: {
        hook: async () => {
          registered++;
          return { dispose: async () => { disposed++; } };
        },
      },
      session: {
        hook: (name: string) => {
          // The first session registration (prompt) fails after the tool hook
          // was already registered.
          if (name === "prompt") {
            if (failure === "throw") throw new Error("hook rejected");
            return Promise.reject(new Error("hook rejected"));
          }
          registered++;
          return Promise.resolve({ dispose: async () => { disposed++; } });
        },
      },
      event: { subscribe: stream.subscribe },
    };
    return { ctx, stream, registered: () => registered, disposed: () => disposed };
  }

  for (const failure of ["reject", "throw"] as const) {
    it(`disposes the registrations made before a later one fails (${failure})`, async () => {
      const host = failingHost(failure);
      await expect(setupV2(host.ctx)).rejects.toThrow("hook rejected");
      expect(host.registered()).toBe(1);
      expect(host.disposed()).toBe(1);
      // Setup failed before it opened the event stream.
      expect(host.stream.subscriptions).toBe(0);
    });
  }
});
