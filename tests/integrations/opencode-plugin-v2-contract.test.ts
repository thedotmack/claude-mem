import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import {
  setupV2,
  extractResultText,
  extractRawKeyNames,
  enrichValidationError,
  type OpenCodePluginContextV2,
  type V2BusEvent,
  type V2ToolExecuteAfterEvent,
} from "../../src/integrations/opencode-plugin/v2";
import { MAX_ENRICHMENT_CHARS } from "../../src/integrations/opencode-plugin/tool-call-guidance";
import {
  REGISTERED_OPENCODE_V2_HOOKS,
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
  /** Subscriptions that finished: ended, failed, or closed by their signal. */
  closed = 0;
  private pending:
    | { resolve: (result: IteratorResult<V2BusEvent>) => void; reject: (error: Error) => void }
    | undefined;
  private buffered: V2BusEvent[] = [];

  subscribe = (options?: { signal?: AbortSignal }): AsyncIterable<V2BusEvent> => {
    this.subscriptions++;
    const signal = options?.signal;
    let finished = false;
    const finish = (): IteratorResult<V2BusEvent> => {
      if (!finished) {
        finished = true;
        this.closed++;
      }
      return { done: true, value: undefined };
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<V2BusEvent>> => {
          if (finished || signal?.aborted) return Promise.resolve(finish());
          const event = this.buffered.shift();
          if (event) return Promise.resolve({ done: false, value: event });
          return new Promise((resolve, reject) => {
            const entry = {
              resolve: (result: IteratorResult<V2BusEvent>) => resolve(result.done ? finish() : result),
              reject: (error: Error) => {
                finish();
                reject(error);
              },
            };
            this.pending = entry;
            signal?.addEventListener("abort", () => {
              if (this.pending === entry) this.pending = undefined;
              resolve(finish());
            }, { once: true });
          });
        },
      }),
    };
  };

  /** Subscriptions still open. */
  get open(): number {
    return this.subscriptions - this.closed;
  }

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
  hookCallbacks: Map<string, (event: any) => Promise<void>>;
  disposeCount: () => number;
} {
  const hooks: RegisteredHook[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const hookCallbacks = new Map<string, (event: any) => Promise<void>>();
  let disposed = 0;

  const ctx: OpenCodePluginContextV2 = {
    directory: "/tmp/x",
    client: {},
    tool: {
      hook: async (name, callback) => {
        hooks.push({ domain: "tool", name });
        hookCallbacks.set(`tool.${name}`, callback as (event: any) => Promise<void>);
        return { dispose: async () => { disposed++; } };
      },
      // The host exposes its tool catalog here. The default entry reproduces
      // the real work_state_write schema so a Code Mode call without `info`
      // can still be matched by the execute.before fallback.
      list: async () => [
        { id: "claude-mem_work_state_write", name: "work_state_write",
          input: { type: "object", required: ["list", "fields"] } },
      ],
      transform: async (callback) => {
        hooks.push({ domain: "tool", name: "transform" });
        callback({
          add: (tool) => { tools.push(tool as unknown as Record<string, unknown>); },
        });
        return { dispose: async () => { disposed++; } };
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks.push({ domain: "session", name });
        hookCallbacks.set(`session.${name}`, callback as (event: any) => Promise<void>);
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

  return { ctx, hooks, tools, hookCallbacks, disposeCount: () => disposed };
}

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

  it("registers the custom search tool through the V2 tool transform", async () => {
    const { ctx, tools } = createV2Context();
    await setupV2(ctx);

    expect(tools.map(tool => tool.name)).toEqual(["claude_mem_search", "claude_mem_timeline", "claude_mem_get_observations"]);
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

  it("registers execute.before without losing the other V2 hooks", async () => {
    const { ctx, hooks } = createV2Context();
    await setupV2(ctx);
    expect(hooks.map(h => `${h.domain}.${h.name}`)).toContain("tool.execute.before");
    expect(hooks.map(h => `${h.domain}.${h.name}`)).toContain("tool.execute.after");
    expect(REGISTERED_OPENCODE_V2_HOOKS).toEqual(expect.arrayContaining([
      { domain: "tool", hook: "execute.before" },
    ]));
  });

  it("keeps every other hook when the host rejects execute.before", async () => {
    const { ctx, hooks } = createV2Context();
    ctx.tool!.hook = (async (name: string, callback: any) => {
      if (name === "execute.before") throw new Error("unsupported hook");
      hooks.push({ domain: "tool", name });
      return { dispose: async () => {} };
    }) as any;
    const cleanup = await setupV2(ctx);
    expect(hooks.map(h => `${h.domain}.${h.name}`)).toContain("session.context");
    expect(hooks.map(h => `${h.domain}.${h.name}`)).not.toContain("tool.execute.before");
    await cleanup();
  });

  it("warns with key names only and posts nothing to the worker", async () => {
    const warn = spyOn(console, "warn");
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("{}", { status: 200 }));
    const { ctx, hookCallbacks } = createV2Context();
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "claude-mem_work_state_write", sessionID: "s1", agent: "primary",
      info: { name: "work_state_write", description: "write work state", input: { type: "object", required: ["list", "fields"] } },
      input: { list: "plans", secret: "do-not-log" },
    });
    const line = warn.mock.calls.flat().join(" ");
    expect(line).toContain("claude-mem_work_state_write");
    expect(line).toContain("fields");
    expect(line).not.toContain("do-not-log");
    expect(fetchSpy).not.toHaveBeenCalled();
    warn.mockRestore();
    fetchSpy.mockRestore();
  });

  it("stays silent on a call whose required keys are present", async () => {
    const warn = spyOn(console, "warn");
    const { ctx, hookCallbacks } = createV2Context();
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "claude-mem_work_state_write", sessionID: "s1", agent: "primary",
      info: { name: "work_state_write", input: { type: "object", required: ["list", "fields"] } },
      input: { list: "plans", fields: { task: "x" } },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores tools that do not belong to claude-mem", async () => {
    const warn = spyOn(console, "warn");
    const { ctx, hookCallbacks } = createV2Context();
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "shell", sessionID: "s1", agent: "primary", input: {},
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("finds the schema in the catalog when a Code Mode call has no info", async () => {
    const warn = spyOn(console, "warn");
    const { ctx, hookCallbacks } = createV2Context();
    // Un outil absent du catalogue factice par défaut : sans ce repli, aucune clé ne serait nommée.
    ctx.tool!.list = async () => [{
      id: "claude-mem_observation_add", name: "observation_add",
      input: { type: "object", required: ["content"] },
    }] as any;
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "claude-mem.observation_add", sessionID: "s1", agent: "primary",
      input: { list: "plans" },
    });
    expect(warn.mock.calls.flat().join(" ")).toContain("content");
    warn.mockRestore();
  });

  it("matches a catalog entry that only has a bare tool id", async () => {
    const warn = spyOn(console, "warn");
    const { ctx, hookCallbacks } = createV2Context();
    ctx.tool!.list = async () => [{
      id: "work_state_write",
      input: { type: "object", required: ["fields"] },
    }] as any;
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "work_state_write", sessionID: "s1", agent: "primary", input: { list: "plans" },
    });
    const warning = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    expect(warning).toContain("fields");
  });

  it("does not read the catalog when info.input supplies the schema", async () => {
    const warn = spyOn(console, "warn");
    let listCalls = 0;
    const { ctx, hookCallbacks } = createV2Context();
    ctx.tool!.list = async () => {
      listCalls++;
      return [{ id: "claude-mem_work_state_write", input: { type: "object", required: ["never"] } }] as any;
    };
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "claude-mem_work_state_write", sessionID: "s1-schema", agent: "primary",
      info: { name: "work_state_write", input: { type: "object", required: ["list", "fields"] } },
      input: { list: "plans" },
    });
    const warning = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    // The schema from info is the only one that drives the warning.
    expect(listCalls).toBe(0);
    expect(warning).toContain("fields");
    expect(warning).not.toContain("never");
  });

  it("recognises an opaque tool by info.name but ignores an unrelated info.name", async () => {
    const warn = spyOn(console, "warn");
    const { ctx, hookCallbacks } = createV2Context();
    await setupV2(ctx);
    // An opaque host tool name: only info.name identifies it as work_state_write.
    await hookCallbacks.get("tool.execute.before")!({
      tool: "external-host-tool", sessionID: "s1", agent: "primary",
      info: { name: "work_state_write", input: { type: "object", required: ["fields"] } },
      input: { list: "plans" },
    });
    const warning = warn.mock.calls.flat().join(" ");
    warn.mockClear();
    await hookCallbacks.get("tool.execute.before")!({
      tool: "execute", sessionID: "s1", agent: "primary",
      info: { name: "execute", input: { type: "object", required: ["fields"] } },
      input: { list: "plans" },
    });
    const unrelated = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    expect(warning).toContain("missing=fields");
    expect(unrelated).toBe("");
  });

  it("includes a bounded, value-free schema hint in the pre-validation warning", async () => {
    const warn = spyOn(console, "warn");
    const { ctx, hookCallbacks } = createV2Context();
    ctx.tool!.list = async () => [{
      id: "claude-mem_work_state_write",
      input: {
        type: "object",
        required: ["list"],
        properties: {
          list: {
            type: "array",
            description: "A very long description that must be cut down to the schema guidance bound because the trace must stay short and single line",
            enum: ["one", "two", "three"],
            format: "csv",
            minItems: 1,
            maxItems: 99,
            items: { type: "string" },
          },
        },
      },
    }] as any;
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "claude-mem_work_state_write", sessionID: "s1-hint", agent: "primary",
      input: { unrelated: "plans-do-not-log" },
    });
    const line = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    const hint = line.split(" hint=")[1] ?? "";
    expect(line).toContain("missing=list");
    expect(hint).toContain("array");
    expect(hint).toContain("minItems: 1");
    expect(hint.length).toBeLessThanOrEqual(200);
    expect(hint).not.toContain("\n");
    expect(line).not.toContain("plans-do-not-log");
  });

  it("omits the hint when the schema has no shape for the missing key", async () => {
    const warn = spyOn(console, "warn");
    const { ctx, hookCallbacks } = createV2Context();
    ctx.tool!.list = async () => [{
      id: "claude-mem_work_state_write",
      input: { type: "object", required: ["mystery"] },
    }] as any;
    await setupV2(ctx);
    await hookCallbacks.get("tool.execute.before")!({
      tool: "claude-mem_work_state_write", sessionID: "s1-nohint", agent: "primary",
      input: { unrelated: "secret-do-not-log" },
    });
    const line = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    expect(line).toContain("missing=mystery");
    expect(line).not.toContain("hint=");
    expect(line).not.toContain("secret-do-not-log");
  });

  it("disposes every registration and stops the event stream on cleanup", async () => {
    const { ctx, disposeCount } = createV2Context();
    const cleanup = await setupV2(ctx);

    // 5 hook registrations + 1 tool transform; the event stream is not a
    // registration but is aborted by the same cleanup. Nothing is disposed
    // until cleanup runs.
    expect(disposeCount()).toBe(0);

    await cleanup();
    expect(disposeCount()).toBe(6);
  });
});

describe("OpenCode V2 graceful degradation", () => {
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

  it("registers nothing and sends no write when location is absent", async () => {
    promptCallbacks.length = 0;
    const cwd = await captureCheckout({ session: recordingSession });
    expect(promptCallbacks.length).toBe(0);
    expect(cwd).toBeUndefined();
  });

  it("registers nothing and sends no write when location.directory is empty", async () => {
    promptCallbacks.length = 0;
    const cwd = await captureCheckout({ location: { directory: "" }, session: recordingSession });
    expect(promptCallbacks.length).toBe(0);
    expect(cwd).toBeUndefined();
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
  it.each([
    ["prefers text content blocks", { output: { exit: 0, truncated: false, output: "from output.output" }, content: [{ type: "text", text: "from content blocks" }] }, "from content blocks"],
    ["falls back to a string output", { output: "plain output" }, "plain output"],
    ["unwraps shell output", { output: { exit: 0, output: "shell stdout" } }, "shell stdout"],
    ["reads plain-string content", { content: "string content", output: { output: "stdout" } }, "string content"],
    ["passes bare strings through", "already text", "already text"],
    ["ignores undefined", undefined, ""],
    ["ignores null", null, ""],
    ["ignores an empty object", {}, ""],
  ] as const)("%s", (_label, result, expected) => {
    expect(extractResultText(result)).toBe(expected);
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

type SessionGet = NonNullable<NonNullable<OpenCodePluginContextV2["session"]>["get"]>;

function createV2Host(directory = "/work/project", sessionGet?: SessionGet) {
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
      ...(sessionGet ? { get: sessionGet } : {}),
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

function recordWorkerRequests(reply: (url: URL) => Response | undefined = () => undefined) {
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
    const custom = reply(url);
    if (custom) return custom;
    if (url.pathname === "/api/context/inject") return new Response("# memory context", { status: 200 });
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
    await host.call("session.context", { sessionID: "ses_bus_deleted", system: [] });
    expect(worker.to("/api/context/inject")).toHaveLength(1);

    host.stream.send(busEvent("session.deleted", "ses_bus_deleted", {}, null));
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_deleted", {}, null));
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_kept", {}, null));
    await until(() => worker.to("/api/sessions/summarize").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const summaries = worker.to("/api/sessions/summarize");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].body!.contentSessionId).toBe(keptInit.body!.contentSessionId);

    // Deletion clears cached context and reply tracking, not the host's ID.
    await host.call("session.context", { sessionID: "ses_bus_deleted", system: [] });
    expect(worker.to("/api/context/inject")).toHaveLength(2);
    await host.call("session.prompt", { sessionID: "ses_bus_deleted", prompt: { text: "After delete" } });
    const after = worker.to("/api/sessions/init").at(-1)!.body!.contentSessionId;
    expect(after).toBe(before);
  });

  it("subscribes again after the stream ends or fails", async () => {
    console.warn = () => {};
    const host = await start();
    await host.call("session.prompt", { sessionID: "ses_bus_resubscribe", prompt: { text: "Stay subscribed" } });
    await until(() => host.stream.waiting);

    host.stream.end();
    await until(() => host.stream.subscriptions === 2 && host.stream.waiting);
    expect(host.stream.open).toBe(1);
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_resubscribe"));
    await until(() => worker.to("/api/sessions/summarize").length === 1);

    host.stream.fail(new Error("connection reset"));
    await until(() => host.stream.subscriptions === 3 && host.stream.waiting);
    expect(host.stream.open).toBe(1);
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_resubscribe"));
    await until(() => worker.to("/api/sessions/summarize").length === 2);
  });

  it("closes the stream and stops resubscribing once cleanup runs", async () => {
    const host = createV2Host();
    const cleanup = await setupV2(host.ctx, { resubscribeDelayMs: 1 });
    await host.call("session.prompt", { sessionID: "ses_bus_cleanup", prompt: { text: "Before cleanup" } });
    await until(() => host.stream.waiting);
    expect(host.stream.open).toBe(1);

    await cleanup();
    expect(host.stream.open).toBe(0);

    // Nothing reads an event sent after cleanup, and nothing subscribes again.
    host.stream.send(busEvent("session.execution.succeeded", "ses_bus_cleanup", {}, null));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.stream.subscriptions).toBe(1);
    expect(worker.to("/api/sessions/summarize")).toHaveLength(0);
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

  it("pins the GA-verified V2 event names, so a renamed event fails loudly", () => {
    // Verified against anomalyco/opencode v2.0.32: the compaction flow
    // (`packages/core/src/session/compaction.ts`) publishes
    // `SessionEvent.Compaction.Ended` ("session.compaction.ended") on success.
    // The schema also defines an ephemeral `session.compacted`, but nothing
    // publishes it — the adapter must listen for the event that fires.
    expect(REAL_OPENCODE_V2_EVENT_TYPES).toContain("session.compaction.ended");
    expect(REAL_OPENCODE_V2_EVENT_TYPES).toContain("session.execution.succeeded");
    expect(REAL_OPENCODE_V2_EVENT_TYPES).toContain("session.text.ended");
    expect(REAL_OPENCODE_V2_EVENT_TYPES).toContain("session.deleted");
    expect(REAL_OPENCODE_V2_EVENT_TYPES).not.toContain("session.compacted");
    expect(REAL_OPENCODE_V2_EVENT_TYPES).not.toContain("session.idle");
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
          // The first session registration (prompt) fails after both tool
          // hooks (execute.before and execute.after) were registered.
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
      // Both tool registrations precede the failing prompt hook, and both are
      // disposed by register()'s rollback.
      expect(host.registered()).toBe(2);
      expect(host.disposed()).toBe(2);
      // Setup failed before it opened the event stream.
      expect(host.stream.subscriptions).toBe(0);
    });
  }
});

describe("OpenCode V2 callbacks drive the worker", () => {
  let worker: ReturnType<typeof recordWorkerRequests>;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    worker = recordWorkerRequests();
    cleanup = async () => {};
  });

  afterEach(async () => {
    await cleanup();
    worker.restore();
  });

  async function start(host = createV2Host()) {
    cleanup = await setupV2(host.ctx);
    return host;
  }

  // `execute.after` as @opencode/plugin 2.0.22 types it.
  function toolEvent(sessionID: string, outcome: Record<string, unknown>) {
    return {
      tool: "read",
      sessionID,
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { filePath: "src/parser.ts" },
      ...outcome,
    };
  }

  it("records a completed tool with its input, its text result and the checkout", async () => {
    const host = await start();
    await host.call("tool.execute.after", toolEvent("ses_cb_tool", {
      status: "completed",
      result: { output: "ignored", content: [{ type: "text", text: "export function parse() {}" }] },
    }));

    const [observation] = worker.to("/api/sessions/observations");
    expect(observation.body).toMatchObject({
      tool_name: "Read",
      tool_input: { filePath: "src/parser.ts" },
      tool_response: "export function parse() {}",
      cwd: "/work/project",
      platform_source: "opencode",
    });
    expect(observation.body!.contentSessionId).toBe("ses_cb_tool");
  });

  it("records a failed tool's error message, from an Error or a plain object", async () => {
    const host = await start();
    await host.call("tool.execute.after", toolEvent("ses_cb_error", {
      status: "error",
      error: { _tag: "Tool.Error", message: "ENOENT: src/parser.ts" },
    }));
    await host.call("tool.execute.after", toolEvent("ses_cb_error", {
      status: "error",
      error: new Error("permission denied"),
    }));

    expect(worker.to("/api/sessions/observations").map((request) => request.body!.tool_response)).toEqual([
      { is_error: true, error: "ENOENT: src/parser.ts" },
      { is_error: true, error: "permission denied" },
    ]);
  });

  it("starts the session with the user's prompt and the checkout", async () => {
    const host = await start();
    await host.call("session.prompt", {
      sessionID: "ses_cb_prompt",
      messageID: "msg_1",
      prompt: { text: "  Read the parser  " },
      delivery: "immediate",
    });

    const [init] = worker.to("/api/sessions/init");
    expect(init.body).toMatchObject({
      prompt: "Read the parser",
      cwd: "/work/project",
      platform_source: "opencode",
    });
    expect(init.body!.contentSessionId).toBe("ses_cb_prompt");
  });

  it("v2-explicit-model: sends the endpoint-ready model id from session.get on the first prompt", async () => {
    // V2 exposes the selected model through session.get. Read `model.id`, which
    // is endpoint-ready; `providerID/model.id` is a display key and must never
    // be forwarded as an inference model name.
    const host = await start(createV2Host("/work/project", async () => ({
      model: { providerID: "custom", id: "endpoint-model" },
    })));
    await host.call("session.prompt", {
      sessionID: "ses_v2_explicit",
      prompt: { text: "first prompt" },
    });

    const [init] = worker.to("/api/sessions/init");
    expect(init, "session.prompt must post session init").toBeTruthy();
    expect(init.body!.observerModel).toBe("endpoint-model");
    expect(init.body!.observerModel).not.toContain("custom/");
    // Pre-existing init fields must be untouched by the new one.
    expect(init.body!.prompt).toBe("first prompt");
    expect(init.body!.contentSessionId).toBe("ses_v2_explicit");
  });

  it("v2-default-model-omitted: omits observerModel when session.get has no model", async () => {
    // An object without `model` must leave the key out so the worker's global
    // CLAUDE_MEM_OPENAI_COMPAT_MODEL fallback applies. No fallback in V2.
    const host = await start(createV2Host("/work/project", async () => ({})));
    await host.call("session.prompt", {
      sessionID: "ses_v2_no_model",
      prompt: { text: "prompt" },
    });

    const [init] = worker.to("/api/sessions/init");
    expect(init, "session.prompt must post session init").toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(init.body, "observerModel")).toBe(false);
    expect(init.body!.prompt).toBe("prompt");
  });

  it("v2-default-model-omitted: omits observerModel when session.get is absent", async () => {
    // A beta host with no `session.get` at all must still capture the prompt.
    const host = await start();
    await host.call("session.prompt", {
      sessionID: "ses_v2_no_get",
      prompt: { text: "prompt" },
    });

    const [init] = worker.to("/api/sessions/init");
    expect(init, "session.prompt must post session init").toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(init.body, "observerModel")).toBe(false);
    expect(init.body!.prompt).toBe("prompt");
  });

  it("v2-model-read-failure: a throwing session.get never rejects the prompt", async () => {
    // Reading the model is best-effort: a failed read means no model, not a
    // failed prompt. Capture still posts the init without observerModel.
    const host = await start(createV2Host("/work/project", async () => {
      throw new Error("session.get unavailable");
    }));
    await expect(host.call("session.prompt", {
      sessionID: "ses_v2_get_throws",
      prompt: { text: "prompt" },
    })).resolves.toBeUndefined();

    const [init] = worker.to("/api/sessions/init");
    expect(init, "session.prompt must post session init").toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(init.body, "observerModel")).toBe(false);
  });

  it("v2-model-read-never-settles: a hanging session.get cannot hold the prompt hook", async () => {
    // The model read is best-effort and time-bounded. A get() promise that
    // never settles must not stall the hook before it posts session init.
    const host = await start(createV2Host("/work/project", () => new Promise<never>(() => {})));
    let guard: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      host.call("session.prompt", {
        sessionID: "ses_v2_get_hangs",
        prompt: { text: "prompt" },
      }).then(() => true),
      // Far above the 250 ms read budget, but bounded so a regression fails
      // instead of hanging the whole suite.
      new Promise<boolean>((resolve) => { guard = setTimeout(() => resolve(false), 2_000); }),
    ]).finally(() => { if (guard !== undefined) clearTimeout(guard); });

    expect(settled, "prompt hook must not wait forever on session.get").toBe(true);
    const [init] = worker.to("/api/sessions/init");
    expect(init, "session.prompt must post session init").toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(init.body, "observerModel")).toBe(false);
    expect(init.body!.prompt).toBe("prompt");
  });

  it("pushes memory onto the system prompt as one tagged text part", async () => {
    const host = await start();
    const event = { sessionID: "ses_cb_context", system: [{ type: "text", text: "base prompt" }] };
    await host.call("session.context", event);

    expect(event.system).toEqual([
      { type: "text", text: "base prompt" },
      { type: "text", text: "<claude-mem-context>\n# memory context\n</claude-mem-context>" },
    ]);
    const [inject] = worker.to("/api/context/inject");
    expect(inject.url.searchParams.get("cwd")).toBe("/work/project");
  });

  it("never stacks a second memory block when the same system list is built again", async () => {
    const host = await start();
    const event = { sessionID: "ses_cb_stack", system: [{ type: "text", text: "base prompt" }] };
    await host.call("session.context", event);
    await host.call("session.context", event);
    await host.call("session.context", event);

    expect(event.system.filter((part) => part.text?.startsWith("<claude-mem-context>"))).toHaveLength(1);
    expect(event.system[0]).toEqual({ type: "text", text: "base prompt" });
  });

  it("answers claude_mem_search through the worker's search endpoint", async () => {
    worker.restore();
    worker = recordWorkerRequests((url) =>
      url.pathname === "/api/search/observations"
        ? Response.json({ content: [{ type: "text", text: "1 observation" }] })
        : undefined);
    const host = await start();

    const result = await host.tools[0].execute({ query: "parser" });

    expect(result).toEqual({ content: "1 observation" });
    const [search] = worker.to("/api/search/observations");
    expect(search.url.searchParams.get("query")).toBe("parser");
  });
});

describe("OpenCode V2 setup with a context that is not a plugin context", () => {
  it("silently ignores the host registry without registering hooks or calling the worker", async () => {
    const worker = recordWorkerRequests();
    const originalLog = console.log;
    const originalWarn = console.warn;
    const logs: string[] = [];
    const warnings: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    let registered = 0;
    try {
      // The shape OpenCode 1.18.35 passes on its extra setup() calls (#4878).
      const hostRegistry = {
        options: {}, agent: {}, aisdk: {}, catalog: {}, command: {},
        integration: {}, plugin: {}, reference: {}, skill: {},
        tool: { hook: async () => { registered++; return { dispose: async () => {} }; } },
      } as unknown as OpenCodePluginContextV2;
      const cleanup = await setupV2(hostRegistry);
      await cleanup();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      worker.restore();
    }
    expect(logs.filter((line) => line.includes("OpenCode plugin loading"))).toEqual([]);
    expect(warnings).toEqual([]);
    expect(registered).toBe(0);
    expect(worker.requests).toEqual([]);
  });
});

/**
 * Raw keys of a Code Mode call are visible only on the outer `execute.before`
 * (`inputKeys:["code"]`), while the error the model sees is the nested
 * `execute.after` (`status:"error"`, `event.error.message`). The outer
 * `execute.after` is `status:"completed"` without an error and runs last, so
 * it can neither read nor enrich anything.
 */
describe("OpenCode V2 raw keys from the execute script", () => {
  let worker: ReturnType<typeof recordWorkerRequests>;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    worker = recordWorkerRequests();
    cleanup = async () => {};
  });

  afterEach(async () => {
    await cleanup();
    worker.restore();
  });

  async function start() {
    const host = createV2Host();
    cleanup = await setupV2(host.ctx);
    return host;
  }

  const sessionID = "ses_raw_keys";
  const agent = "primary";

  function outerBefore(code: string, input: Record<string, unknown> = { code }) {
    return { tool: "execute", sessionID, agent, input };
  }

  function nestedEvent(
    error: { message: string },
    tool = "claude-mem_work_state_write",
  ) {
    return { tool, sessionID, agent, status: "error", error, input: { list: "x" } };
  }

  describe("literal extraction", () => {
    it("reads top-level names only from recognized literal calls", () => {
      const code = 'await tools["claude-mem"].work_state_write({list:"x", items:[1], "fields":{task:"y"}});';
      expect(extractRawKeyNames(code)).toEqual(["fields", "items", "list"]);
    });

    it("names another claude-mem tool's real keys, without a hard-coded list", () => {
      const code = 'tools["claude-mem"].observation_add({content:"x", secret:"do-not-log"});';
      // `secret` is a key *name* here; the value `do-not-log` is never returned.
      expect(extractRawKeyNames(code)).toEqual(["content", "secret"]);
    });

    it("ignores dynamic inputs, computed keys, unrelated tools and oversized scripts", () => {
      expect(extractRawKeyNames('const input = {items:1}; tools["claude-mem"].work_state_write(input);')).toEqual([]);
      expect(extractRawKeyNames('tools["claude-mem"].work_state_write({[key]:1});')).toEqual([]);
      expect(extractRawKeyNames('shell({items:1});')).toEqual([]);
      expect(extractRawKeyNames(`tools["claude-mem"].work_state_write({items:1});${" ".repeat(8 * 1024)}`)).toEqual([]);
    });

    it("ignores a literal call written in a line comment", () => {
      const code = [
        '// tools["claude-mem"].work_state_write({commented:1});',
        'const input = {real:1}; tools["claude-mem"].work_state_write(input);',
      ].join("\n");
      expect(extractRawKeyNames(code)).toEqual([]);
    });

    it("ignores a literal call written in a string", () => {
      const code = `const note = 'tools["claude-mem"].work_state_write({quoted:1})'; const input = {real:1}; tools["claude-mem"].work_state_write(input);`;
      expect(extractRawKeyNames(code)).toEqual([]);
    });

    it("ignores a literal call written in a block comment or a plain template", () => {
      expect(extractRawKeyNames('/* tools["claude-mem"].work_state_write({blocked:1}) */ const input = {}; tools["claude-mem"].work_state_write(input);')).toEqual([]);
      expect(extractRawKeyNames('`tools["claude-mem"].work_state_write({templated:1})`')).toEqual([]);
    });

    it("keeps a real call inside a template interpolation", () => {
      const code = '`prefix ${tools["claude-mem"].work_state_write({interpolated:1})}`';
      expect(extractRawKeyNames(code)).toEqual(["interpolated"]);
    });

    it("keeps a real call after a regex containing quotes", () => {
      const code = `const pattern = /['"]/; tools["claude-mem"].work_state_write({items:1});`;
      expect(extractRawKeyNames(code)).toEqual(["items"]);
    });

    it("keeps a real call after a regex with a slash inside a character class", () => {
      const code = `const pattern = /[a/b]/; tools["claude-mem"].work_state_write({items:2});`;
      expect(extractRawKeyNames(code)).toEqual(["items"]);
    });

    it("keeps a real call after a regex with an escaped slash", () => {
      const code = String.raw`const pattern = /a\/b/; tools["claude-mem"].work_state_write({items:3});`;
      expect(extractRawKeyNames(code)).toEqual(["items"]);
    });

    it("treats a division as code, not as the start of a regex", () => {
      const code = `const ratio = width / height; tools["claude-mem"].work_state_write({items:4});`;
      expect(extractRawKeyNames(code)).toEqual(["items"]);
    });

    it("ignores a pseudo-call written inside a regex literal", () => {
      const code = `const pattern = /tools["claude-mem"].work_state_write({list:1})/; const input = {real:1}; tools["claude-mem"].work_state_write(input);`;
      expect(extractRawKeyNames(code)).toEqual([]);
    });
  });

  it("names the raw key at the nested after, never the value, and captures the original error first", async () => {
    const host = await start();
    const error = { message: "Invalid arguments for tool: unexpected key" };
    const warn = spyOn(console, "warn");

    await host.call("tool.execute.before", outerBefore(
      'tools["claude-mem"].work_state_write({list:"x", items:[{secret:"do-not-log"}]})',
    ));
    await host.call("tool.execute.after", nestedEvent(error));

    const warning = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    expect(error.message).toContain("items");
    expect(error.message).not.toContain("do-not-log");
    expect(warning).not.toContain("do-not-log");
    // The observation keeps the message the host gave us before enrichment.
    expect(worker.to("/api/sessions/observations")[0].body!.tool_response).toEqual({
      is_error: true,
      error: "Invalid arguments for tool: unexpected key",
    });
  });

  it("adds no name for a non-literal script", async () => {
    const host = await start();
    const code = 'const payload = {items:1}; tools["claude-mem"].work_state_write(payload);';
    await host.call("tool.execute.before", outerBefore(code));
    const error = { message: "Invalid arguments" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("Invalid arguments");
  });

  it("merges names from several offending calls and bounds the merged list to three", async () => {
    const host = await start();
    const code = [
      'await tools["claude-mem"].work_state_write({list:"x", zeta:1});',
      'await tools["claude-mem"].work_state_write({list:"x", beta:2});',
      'await tools["claude-mem"].work_state_write({list:"x", alpha:3, gamma:4});',
    ].join("\n");
    await host.call("tool.execute.before", outerBefore(code));
    const error = { message: "Invalid arguments" };
    await host.call("tool.execute.after", nestedEvent(error));
    for (const name of ["alpha", "beta", "gamma"]) expect(error.message).toContain(name);
    expect(error.message).not.toContain("zeta");
  });

  it("names the real key of another claude-mem tool from its own script", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore(
      'tools["claude-mem"].observation_add({content:"x", secret:"do-not-log"})',
    ));
    const error = { message: "Invalid arguments" };
    await host.call("tool.execute.after", nestedEvent(error, "claude-mem_observation_add"));
    expect(error.message).toContain("content");
    // The second literal key is named too; only its *value* stays out.
    expect(error.message).toContain("secret");
    expect(error.message).not.toContain("do-not-log");
  });

  it("runs before -> nested error after -> outer completed after, and consumes the entry once", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore('tools["claude-mem"].work_state_write({items:1})'));

    const error = { message: "nested failure" };
    await host.call("tool.execute.after", nestedEvent(error));
    const afterNested = error.message;
    expect(afterNested).toContain("items");

    // The outer execute.after is status:"completed" and must not enrich.
    const outerResult = { content: [{ type: "text", text: "done" }] };
    await host.call("tool.execute.after", {
      tool: "execute", sessionID, agent, status: "completed", result: outerResult,
    });
    expect(error.message).toBe(afterNested);
    expect(outerResult.content[0].text).toBe("done");

    // No stale entry survives the nested after: a later direct call is untouched.
    const later = { message: "direct failure" };
    await host.call("tool.execute.after", nestedEvent(later));
    expect(later.message).toBe("direct failure");
  });

  it("drops a previous script's names when the next script yields none", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore('tools["claude-mem"].work_state_write({first:1})'));
    await host.call("tool.execute.before", outerBefore(
      'const input = {second:1}; tools["claude-mem"].work_state_write(input);',
    ));
    const error = { message: "Invalid arguments" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("Invalid arguments");
    expect(error.message).not.toContain("first");
  });

  it("purges an unconsumed entry when the outer execute finishes", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore('tools["claude-mem"].work_state_write({items:1})'));
    await host.call("tool.execute.after", {
      tool: "execute", sessionID, agent, status: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
    const error = { message: "later failure" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("later failure");
  });

  it("purges an unconsumed entry on a completed nested claude-mem after", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore('tools["claude-mem"].work_state_write({items:1})'));
    await host.call("tool.execute.after", {
      tool: "claude-mem_work_state_write", sessionID, agent, status: "completed",
      result: { content: [] },
    });
    const error = { message: "later failure" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("later failure");
  });

  it("never sources names from session.tool.called", async () => {
    const host = await start();
    host.stream.send({
      type: "session.tool.called",
      data: { sessionID, agent, input: { items: 1 } },
      location: { directory: "/work/project" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const error = { message: "bus-only failure" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("bus-only failure");
    expect(readFileSync("src/integrations/opencode-plugin/v2.ts", "utf8")).not.toContain("session.tool.called");
  });

  it("clears a pending entry when the session is deleted", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore('tools["claude-mem"].work_state_write({items:1})'));
    host.stream.send(busEvent("session.deleted", sessionID, {}, null));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const error = { message: "after delete" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("after delete");
  });

  it("forgets an unconsumed entry at the end of the turn", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore(
      'if (false) tools["claude-mem"].work_state_write({items:1})',
    ));
    host.stream.send(busEvent("session.execution.succeeded", sessionID, {}, null));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const error = { message: "direct failure after the turn" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("direct failure after the turn");
  });

  it("forgets an unconsumed entry when compaction ends", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore('tools["claude-mem"].work_state_write({items:1})'));
    host.stream.send(busEvent("session.compaction.ended", sessionID, {}, null));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const error = { message: "direct failure after compaction" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("direct failure after compaction");
  });

  it("does not purge at a text.ended that precedes the nested after", async () => {
    const host = await start();
    await host.call("tool.execute.before", outerBefore('tools["claude-mem"].work_state_write({items:1})'));
    host.stream.send(busEvent("session.text.ended", sessionID, { text: "tool call coming" }, null));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const error = { message: "Invalid arguments" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toContain("items");
  });

  it("never deposits names from a non-execute tool's code", async () => {
    const host = await start();
    await host.call("tool.execute.before", {
      tool: "shell",
      sessionID,
      agent,
      input: { code: 'grep -R \'tools["claude-mem"].work_state_write({list,items})\' src/' },
    });
    const error = { message: "Invalid arguments" };
    await host.call("tool.execute.after", nestedEvent(error));
    expect(error.message).toBe("Invalid arguments");
  });
});

/**
 * Same-turn enrichment of the error the model sees. The host's validation
 * message is the only source of issue paths; the tool schema supplies literal
 * shape guidance. No value is logged or fabricated, and the host's error
 * object is mutated in place after the observation has been captured.
 */
describe("OpenCode V2 validation issues enrichment", () => {
  const schema = {
    type: "object",
    properties: {
      fields: { type: "object", description: 'Keys to set. Include "task" to update a to-do item.' },
      status: { type: "string", description: "Current state", enum: ["todo", "done"] },
      list: { type: "string", description: "List name" },
    },
    required: ["fields", "status"],
  };

  function hostMessage(details: string[], provided: unknown): string {
    return [
      'Invalid arguments for tool "work_state_write":',
      ...details,
      "",
      "Arguments provided:",
      JSON.stringify(provided, null, 2),
      "",
      "Update the arguments and call the tool again.",
    ].join("\n");
  }

  function event(message: string, error?: Record<string, unknown>, inputSchema: unknown = schema): V2ToolExecuteAfterEvent {
    return {
      status: "error",
      tool: "claude-mem_work_state_write",
      info: { name: "work_state_write", input: inputSchema },
      input: { list: "x" },
      error: error ?? { message },
    } as V2ToolExecuteAfterEvent;
  }

  it("guides a real host message from its parsed issue path", () => {
    const original = hostMessage(["- fields: Missing key"], { list: "x" });
    const error = { message: original };
    expect(enrichValidationError(event(original, error), [])).toBe(true);
    expect(error.message).toContain("fields: Missing key");
    expect(error.message).toContain('object — Keys to set. Include "task" to update a to-do item.');
    expect(error.message).not.toContain("do-not-log");
  });

  it("keeps the parsed status path and its literal enum hint", () => {
    const original = hostMessage(['- status: Invalid option: expected one of "todo"|"done"'], { fields: {} });
    const error = { message: original };
    expect(enrichValidationError(event(original, error), [])).toBe(true);
    expect(error.message).toContain('status: Invalid option: expected one of "todo"|"done"');
    expect(error.message).toContain("one of: todo, done");
  });

  it("preserves a nested issue path with its literal schema hint", () => {
    const nestedSchema = {
      type: "object",
      properties: { fields: { type: "object", properties: { task: { type: "string", description: "Task title" } } } },
    };
    const original = hostMessage(["- fields.task: Missing key"], { fields: {} });
    const error = { message: original };
    expect(enrichValidationError(event(original, error, nestedSchema), [])).toBe(true);
    expect(error.message).toContain("fields.task: Missing key");
    expect(error.message).toContain("string — Task title");
  });

  it("leaves a non-validation error untouched", () => {
    const original = "permission denied";
    const error = { message: original };
    expect(enrichValidationError(event(original, error), [])).toBe(false);
    expect(error.message).toBe(original);
  });

  it("names undeclared keys from Arguments provided without their values", () => {
    const original = hostMessage(["- items: Missing key"], { secret: "do-not-log", extra: 1 });
    const error = { message: original };
    expect(enrichValidationError(event(original, error), [])).toBe(true);
    expect(error.message).toContain("undeclared: extra, secret");
    expect(error.message.slice(original.length)).not.toContain("do-not-log");
  });

  it("skips an oversized or malformed Arguments provided block without throwing", () => {
    const huge = "x".repeat(9 * 1024);
    const oversized = `Invalid arguments for tool "x":\n- items: Missing key\n\nArguments provided:\n{"secret":"${huge}"}\n\nUpdate the arguments and call the tool again.`;
    const errorOversized = { message: oversized };
    expect(() => enrichValidationError(event(oversized, errorOversized), [])).not.toThrow();
    expect(errorOversized.message.slice(oversized.length)).not.toContain("undeclared:");
    expect(errorOversized.message.slice(oversized.length)).not.toContain(huge);

    const malformed = 'Invalid arguments for tool "x":\n- items: Missing key\n\nArguments provided:\n{not json\n\nUpdate the arguments and call the tool again.';
    const errorMalformed = { message: malformed };
    expect(() => enrichValidationError(event(malformed, errorMalformed), [])).not.toThrow();
    expect(errorMalformed.message).not.toContain("undeclared:");
  });

  it("formulates a typed reissue instruction from guidanceForPaths", () => {
    const original = hostMessage(["- fields: Missing key"], { list: "x" });
    const error = { message: original };
    expect(enrichValidationError(event(original, error), [])).toBe(true);
    expect(error.message).toContain('Reissue work_state_write with fields: object — Keys to set. Include "task" to update a to-do item.');
  });

  it.each([
    "<tool-repair>third party prefix</tool-repair>",
    "[external-agent] unknown prefix",
  ])("keeps the third-party prefix %s intact and appends ours last", (prefix) => {
    const original = `${prefix}\n${hostMessage(["- fields: Missing key"], { list: "x" })}`;
    const error = {
      _tag: "Tool.Error",
      message: original,
      error: { cause: "third-party" },
      metadata: { source: "third-party" },
    } as unknown as Record<string, unknown> & { message: string };
    const wrapped = event(original, error);
    expect(enrichValidationError(wrapped, ["items"])).toBe(true);
    expect(error.message.startsWith(prefix)).toBe(true);
    expect(error.message.indexOf("Raw keys from execute: items")).toBeGreaterThan(error.message.indexOf(prefix));
    expect(error.message.indexOf("Reissue ")).toBeGreaterThan(error.message.indexOf(prefix));
    expect((error as { _tag?: string })._tag).toBe("Tool.Error");
    expect((error as { error?: unknown }).error).toEqual({ cause: "third-party" });
    expect((error as { metadata?: unknown }).metadata).toEqual({ source: "third-party" });
    expect(wrapped.error).toBe(error);
  });

  it("does not enrich a policy refusal carrying <private>", () => {
    const original = "Permission denied <private>secret</private>";
    const error = { message: original };
    expect(enrichValidationError(event(original, error), ["items"])).toBe(false);
    expect(error.message).toBe(original);
  });

  it("mutates only the error message, never input, status or the error object", () => {
    const original = hostMessage(["- fields: Missing key"], { list: "x" });
    const input = { list: "x" };
    const error = { message: original };
    const wrapped = { ...event(original, error), input };
    expect(enrichValidationError(wrapped, ["items"])).toBe(true);
    expect(wrapped.input).toBe(input);
    expect(wrapped.status).toBe("error");
    expect(wrapped.error).toBe(error);
  });

  it("does not throw when the host error cannot be mutated", () => {
    const original = hostMessage(["- fields: Missing key"], { list: "x" });
    const error = Object.freeze({ message: original });
    expect(enrichValidationError(event(original, error), [])).toBe(false);
    expect(error.message).toBe(original);
  });

  it("prioritizes a missing root key and root value errors over nested paths, then the host counter", () => {
    const nestedSchema = {
      type: "object",
      properties: { fields: { type: "object", properties: { task: { type: "string" } } } },
    };
    const original = [
      'Invalid arguments for tool "work_state_write":',
      "- fields.task: Missing key",
      '- status: Invalid option: expected one of "todo"|"done"',
      "- fields: Missing key",
      '- list: Invalid option: expected one of "a"|"b"',
      "- ...and 2 more issues",
      "",
      "Arguments provided:",
      "{}",
      "",
      "Update the arguments and call the tool again.",
    ].join("\n");
    const error = { message: original };
    expect(enrichValidationError(event(original, error, nestedSchema), [])).toBe(true);
    const added = error.message.slice(original.length);
    const fields = added.indexOf("- fields: Missing key");
    const status = added.indexOf("- status: Invalid option");
    const list = added.indexOf("- list: Invalid option");
    const counter = added.indexOf("- ...and 2 more issues");
    expect(fields).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(fields);
    expect(list).toBeGreaterThan(status);
    expect(counter).toBeGreaterThan(list);
    // Two root value errors and one missing root key fill the three lines.
    expect(added).not.toContain("- fields.task: Missing key");
  });

  it("claims no raw key on a direct call with shape guidance only", () => {
    const original = hostMessage(["- fields: Missing key"], { list: "x" });
    const error = { message: original };
    expect(enrichValidationError(event(original, error), [])).toBe(true);
    expect(error.message).toContain("fields");
    expect(error.message).not.toContain("Raw keys from execute:");
  });

  it("bounds the added text to MAX_ENRICHMENT_CHARS", () => {
    const long = "x".repeat(500);
    const wideSchema = { type: "object", properties: { fields: { type: "object", description: long } } };
    const original = [
      'Invalid arguments for tool "work_state_write":',
      "- fields: Missing key",
      ...Array.from({ length: 5 }, (_, index) => `- field${index}: ${long}`),
      "- ...and 2 more issues",
      "",
      "Arguments provided:",
      '{"secret":"do-not-log"}',
      "",
      "Update the arguments and call the tool again.",
    ].join("\n");
    const error = { message: original };
    expect(enrichValidationError(event(original, error, wideSchema), ["alpha", "beta", "gamma"])).toBe(true);
    const added = error.message.slice(original.length);
    expect(added.length).toBeLessThanOrEqual(MAX_ENRICHMENT_CHARS);
    expect(added.slice(1).startsWith("Reissue work_state_write with fields: object")).toBe(true);
    expect(added).not.toContain("do-not-log");
  });
});
