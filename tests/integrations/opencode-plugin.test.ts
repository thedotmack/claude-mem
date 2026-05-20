import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { ClaudeMemPlugin } from "../../src/integrations/opencode-plugin/index.ts";

interface CapturedPost {
  path: string;
  body: Record<string, unknown>;
}

const FAKE_CTX = {
  client: {},
  project: { name: "demo" },
  directory: "/tmp/demo",
  worktree: "/tmp/demo",
  serverUrl: new URL("http://127.0.0.1:1/"),
  $: {},
};

const realFetch = globalThis.fetch;
let captured: CapturedPost[] = [];

function installFetchSpy(): void {
  captured = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : (input as URL).toString();
    const url = new URL(urlStr);
    let parsedBody: Record<string, unknown> = {};
    if (init?.body && typeof init.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = {};
      }
    }
    captured.push({ path: url.pathname, body: parsedBody });
    return new Response("{}", { status: 200 }) as unknown as Response;
  }) as typeof fetch;
}

async function loadHooks(): Promise<Record<string, unknown>> {
  const hooks = await ClaudeMemPlugin(FAKE_CTX as Parameters<typeof ClaudeMemPlugin>[0]);
  return hooks as Record<string, unknown>;
}

async function flushFireAndForget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("opencode-plugin — OpenCode Hooks contract", () => {
  beforeEach(() => {
    installFetchSpy();
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
  });

  it("exposes hooks as FLAT top-level keys (not nested under a 'hooks' wrapper)", async () => {
    const hooks = await loadHooks();

    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
    expect(typeof hooks.event).toBe("function");

    expect((hooks as { hooks?: unknown }).hooks).toBeUndefined();
  });

  it("'event' hook uses OpenCode's single-arg contract: (input: { event }) => Promise<void>", async () => {
    const hooks = await loadHooks();
    const eventFn = hooks.event as (input: unknown) => Promise<void>;
    expect(eventFn.length).toBe(1);
  });

  it("'tool.execute.after' POSTs an observation and lazily initializes the session", async () => {
    const hooks = await loadHooks();
    const toolAfter = hooks["tool.execute.after"] as (
      input: unknown,
      output: unknown,
    ) => Promise<void>;

    await toolAfter(
      { tool: "read", sessionID: "s-tool", callID: "c1", args: { path: "/a" } },
      { title: "t", output: "OK", metadata: {} },
    );
    await flushFireAndForget();

    const paths = captured.map((c) => c.path);
    expect(paths).toContain("/api/sessions/init");
    expect(paths).toContain("/api/sessions/observations");

    const obs = captured.find((c) => c.path === "/api/sessions/observations");
    expect(obs?.body.tool_name).toBe("read");
    expect(obs?.body.cwd).toBe("/tmp/demo");
  });

  it("'chat.message' triggers session init once per sessionID", async () => {
    const hooks = await loadHooks();
    const chatMessage = hooks["chat.message"] as (input: unknown) => Promise<void>;

    await chatMessage({ sessionID: "s-chat" });
    await chatMessage({ sessionID: "s-chat" });
    await flushFireAndForget();

    const inits = captured.filter((c) => c.path === "/api/sessions/init");
    expect(inits.length).toBe(1);
    expect(inits[0]?.body.project).toBe("demo");
  });

  it("'experimental.session.compacting' lazy-inits the session but does NOT POST summarize (owned by session.compacted event)", async () => {
    const hooks = await loadHooks();
    const compacting = hooks["experimental.session.compacting"] as (
      input: unknown,
      output: unknown,
    ) => Promise<void>;

    await compacting({ sessionID: "s-comp" }, { context: [] });
    await flushFireAndForget();

    // Init MUST fire (defensive lazy init for compact-only sessions).
    expect(captured.find((c) => c.path === "/api/sessions/init")).toBeDefined();
    // Summarize MUST NOT fire from this hook — it is owned by the
    // `session.compacted` event branch to avoid a duplicate POST per cycle.
    expect(captured.find((c) => c.path === "/api/sessions/summarize")).toBeUndefined();
  });

  it("compacting hook + session.compacted event for the SAME session produces exactly one summarize POST (claude-mem#2503 P1)", async () => {
    const hooks = await loadHooks();
    const compacting = hooks["experimental.session.compacting"] as (
      input: unknown,
      output: unknown,
    ) => Promise<void>;
    const eventFn = hooks.event as (input: unknown) => Promise<void>;

    // OpenCode fires the hook DURING compaction, then the event AFTER. Replay
    // that exact sequence and assert the summarize endpoint is hit only once.
    await compacting({ sessionID: "s-cycle" }, { context: [] });
    await eventFn({
      event: { type: "session.compacted", properties: { sessionID: "s-cycle" } },
    });
    await flushFireAndForget();

    const summarizes = captured.filter((c) => c.path === "/api/sessions/summarize");
    expect(summarizes.length).toBe(1);
  });

  it("event(session.created) initializes the session and uses properties.info.id", async () => {
    const hooks = await loadHooks();
    const eventFn = hooks.event as (input: unknown) => Promise<void>;

    await eventFn({
      event: { type: "session.created", properties: { info: { id: "s-evt" } } },
    });
    await flushFireAndForget();

    const inits = captured.filter((c) => c.path === "/api/sessions/init");
    expect(inits.length).toBe(1);
  });

  it("event(message.updated) records an assistant observation; ignores user messages", async () => {
    const hooks = await loadHooks();
    const eventFn = hooks.event as (input: unknown) => Promise<void>;

    await eventFn({
      event: {
        type: "message.updated",
        properties: {
          info: { role: "user", sessionID: "s-msg", content: "hello" },
        },
      },
    });
    await flushFireAndForget();
    expect(captured.find((c) => c.path === "/api/sessions/observations")).toBeUndefined();

    await eventFn({
      event: {
        type: "message.updated",
        properties: {
          info: { role: "assistant", sessionID: "s-msg", content: "hi back" },
        },
      },
    });
    await flushFireAndForget();

    const obs = captured.find((c) => c.path === "/api/sessions/observations");
    expect(obs?.body.tool_name).toBe("assistant_message");
    expect(obs?.body.tool_response).toBe("hi back");
  });

  it("event(session.compacted) reads properties.sessionID and POSTs summarize", async () => {
    const hooks = await loadHooks();
    const eventFn = hooks.event as (input: unknown) => Promise<void>;

    await eventFn({
      event: { type: "session.compacted", properties: { sessionID: "s-cmp" } },
    });
    await flushFireAndForget();

    expect(captured.find((c) => c.path === "/api/sessions/summarize")).toBeDefined();
  });

  it("event(session.deleted) does not crash on the properties.info.id payload", async () => {
    const hooks = await loadHooks();
    const eventFn = hooks.event as (input: unknown) => Promise<void>;

    await eventFn({
      event: { type: "session.deleted", properties: { info: { id: "s-del" } } },
    });
    await flushFireAndForget();
  });

  it("event hook ignores unknown event types without throwing", async () => {
    const hooks = await loadHooks();
    const eventFn = hooks.event as (input: unknown) => Promise<void>;

    await eventFn({ event: { type: "unrelated.event", properties: {} } });
    await eventFn({ event: { type: "session.idle", properties: { sessionID: "x" } } });
    await flushFireAndForget();

    expect(captured.find((c) => c.path === "/api/sessions/init")).toBeUndefined();
    expect(captured.find((c) => c.path === "/api/sessions/observations")).toBeUndefined();
  });

  it("'tool' registry still exposes claude_mem_search", async () => {
    const hooks = await loadHooks();
    const tool = (hooks.tool as Record<string, { description?: string }>)?.claude_mem_search;
    expect(tool).toBeDefined();
    expect(typeof tool.description).toBe("string");
  });
});
