import { describe, it, expect } from "bun:test";
import pluginEntry from "../../src/integrations/opencode-plugin/index";
import { setupV2, extractResultText, type OpenCodePluginContextV2 } from "../../src/integrations/opencode-plugin/v2";
import {
  REGISTERED_OPENCODE_HOOKS,
  REGISTERED_OPENCODE_V2_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
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
        return (async function* () {
          // Never yields: the bus consumer is exercised by its own test.
          void options;
        })();
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
