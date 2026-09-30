import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import ClaudeMemPlugin from "../../src/integrations/opencode-plugin/index";
import { serverV1, V1_EVENT_TYPES, V1_HOOKS } from "../../src/integrations/opencode-plugin/v1";
import { setupV2, V2_EVENT_TYPES, type OpenCodeV2PluginContext } from "../../src/integrations/opencode-plugin/v2";
import { parseSearchResponse } from "../../src/integrations/opencode-plugin/worker";
import {
  loadWithOpenCodeV1_18,
  loadWithOpenCodeV1Legacy,
  loadWithOpenCodeV2,
} from "../fixtures/hosts/opencode-loaders";
import { normalizePlatformSource } from "../../src/shared/platform-source";
import { isConnectionRefusedError } from "../../src/shared/connection-errors";

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
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

describe("OpenCode 1.x server hooks", () => {
  it("reads the worker port from persisted settings without importing worker-utils", () => {
    const source = readFileSync(
      "src/integrations/opencode-plugin/worker.ts",
      "utf8",
    );

    expect(source).not.toContain('from "../../shared/worker-utils.js"');
    expect(source).toContain('SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_WORKER_PORT');
  });

  it("uses the persisted worker port in OpenCode worker requests", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "claude-mem-opencode-settings-"));
    const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    const originalPort = process.env.CLAUDE_MEM_WORKER_PORT;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    writeFileSync(
      join(dataDir, "settings.json"),
      JSON.stringify({ CLAUDE_MEM_WORKER_PORT: "45678" }),
    );

    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      // worker.ts resolves the worker URL at load time, so load a fresh copy.
      const { workerPostFireAndForget } = await import(
        `../../src/integrations/opencode-plugin/worker.ts?opencode-settings-${Date.now()}`
      );
      workerPostFireAndForget("/api/sessions/observations", { contentSessionId: "ses_45678" });

      expect(seenUrls.some((url) => url.startsWith("http://127.0.0.1:45678/"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
      if (originalPort === undefined) delete process.env.CLAUDE_MEM_WORKER_PORT;
      else process.env.CLAUDE_MEM_WORKER_PORT = originalPort;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("only registers hooks that are part of OpenCode's real contract", async () => {
    const plugin = await serverV1(pluginCtx);
    const hookKeys = Object.keys(plugin);

    for (const key of hookKeys) {
      expect(
        REAL_OPENCODE_HOOK_NAMES.has(key),
        `hook "${key}" is not a real OpenCode hook name`,
      ).toBe(true);
    }

    // The exported allowlist of hooks we bind to must itself be real.
    for (const hook of V1_HOOKS) {
      expect(REAL_OPENCODE_HOOK_NAMES.has(hook)).toBe(true);
    }

    // The capture-critical hooks must be present.
    expect(hookKeys).toContain("tool.execute.after");
    expect(hookKeys).toContain("chat.message");
    expect(hookKeys).toContain("experimental.session.compacting");
    expect(hookKeys).toContain("event");
  });

  it("does not register the phantom bus event names as hooks", async () => {
    const plugin = await serverV1(pluginCtx);
    const hookKeys = Object.keys(plugin);
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(hookKeys).not.toContain(phantom);
    }
  });

  it("only reacts to real bus event types", () => {
    // session.idle / session.deleted are real OpenCode bus events; the phantom
    // names must never appear in the reacted-to allowlist.
    expect(V1_EVENT_TYPES).toContain("session.idle");
    expect(V1_EVENT_TYPES).toContain("session.deleted");
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(V1_EVENT_TYPES as readonly string[]).not.toContain(phantom);
    }
  });

  it("posts observations to the worker via tool.execute.after", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await serverV1(pluginCtx);
      const toolAfter = plugin["tool.execute.after"];
      await toolAfter(
        {
          tool: "read",
          sessionID: "ses_input_only",
          callID: "c1",
          // Matches the issue-author's captured OpenCode payload: args are on input.
          args: { path: "/a" },
        },
        { title: "Read", output: "file contents", metadata: {} },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(initPost, "tool.execute.after should lazily init the session").toBeTruthy();
      expect(obsPost, "tool.execute.after should POST an observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_name).toBe("read");
      expect(obsBody.tool_input).toEqual({ path: "/a" });
      expect(obsBody.tool_response).toBe("file contents");
      expect(obsBody.platformSource).toBe(normalizePlatformSource("opencode"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stamps every session-write POST and leaves GET and deletion unchanged", async () => {
    const requests: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        method: init?.method || "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "No observations found" }] }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      const plugin = await serverV1(pluginCtx);
      const expectedPlatformSource = normalizePlatformSource("opencode");

      const postHookInvocations: Record<string, () => Promise<void>> = {
        "tool.execute.after": () => plugin["tool.execute.after"](
          { tool: "read", sessionID: "ses_contract_tool", callID: "c1" },
          { title: "Read", output: "tool output", metadata: {}, args: {} },
        ),
        "chat.message": () => plugin["chat.message"](
          { sessionID: "ses_contract_chat" },
          {
            message: { role: "user", sessionID: "ses_contract_chat" },
            parts: [{ type: "text", text: "user prompt" }],
          },
        ),
        "experimental.session.compacting": () => plugin["experimental.session.compacting"]({ sessionID: "ses_contract_compact" }),
        event: () => plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_contract_idle" } } }),
      };
      for (const hook of V1_HOOKS) {
        const invoke = postHookInvocations[hook];
        expect(invoke, `registered hook "${hook}" must have a POST contract case`).toBeDefined();
        await invoke!();
      }

      const posts = requests.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(7);
      expect(posts.map((request) => request.url)).toEqual([
        expect.stringContaining("/api/sessions/init"),
        expect.stringContaining("/api/sessions/observations"),
        expect.stringContaining("/api/sessions/init"),
        expect.stringContaining("/api/sessions/init"),
        expect.stringContaining("/api/sessions/summarize"),
        expect.stringContaining("/api/sessions/init"),
        expect.stringContaining("/api/sessions/summarize"),
      ]);
      for (const post of posts) {
        expect(post.body?.platformSource).toBe(expectedPlatformSource);
      }

      const postCountBeforeSearchAndDeletion = posts.length;
      await plugin.tool.claude_mem_search.execute({ query: "auth" });
      await plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_contract_idle" } } });
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(
        postCountBeforeSearchAndDeletion,
      );
      expect(requests.at(-1)?.method).toBe("GET");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers input args when both hook payloads contain arguments", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await serverV1(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "write", sessionID: "ses_precedence", callID: "c2", args: { path: "/input" } },
        { title: "Write", output: "ok", metadata: {}, args: { path: "/output" } },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect((obsPost!.body as Record<string, unknown>).tool_input).toEqual({ path: "/input" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retains output args as the fallback when input args are absent", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await serverV1(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_output_fallback", callID: "c3" },
        { title: "Read", output: "ok", metadata: {}, args: { path: "/fallback" } },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect((obsPost!.body as Record<string, unknown>).tool_input).toEqual({ path: "/fallback" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses an empty object when neither hook payload contains args", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await serverV1(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "list", sessionID: "ses_empty_fallback", callID: "c4" },
        { title: "List", output: "ok", metadata: {} },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect((obsPost!.body as Record<string, unknown>).tool_input).toEqual({});
      expect((obsPost!.body as Record<string, unknown>).tool_name).toBe("list");
      expect((obsPost!.body as Record<string, unknown>).tool_response).toBe("ok");
      expect((obsPost!.body as Record<string, unknown>).cwd).toBe("/tmp/x");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the selected empty input object when output args are also present", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await serverV1(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_empty_input", callID: "c5", args: {} },
        { title: "Read", output: "ok", metadata: {}, args: { path: "/output" } },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect((obsPost!.body as Record<string, unknown>).tool_input).toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenCode 1.x session attribution (#4275)", () => {
  function recordPosts() {
    const posts: Array<{ url: string; body: Record<string, any> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return posts;
  }
  const originalFetch = globalThis.fetch;

  it("names the project after the git root, not a fixed 'opencode'", async () => {
    const posts = recordPosts();
    try {
      const plugin = await serverV1({ directory: "/work/repo/packages/app", worktree: "/work/repo" });
      await plugin["chat.message"]({ sessionID: "ses_root" }, {
        message: { role: "user", sessionID: "ses_root" },
        parts: [{ type: "text", text: "hi" }],
      });
      expect(posts[0].body.project).toBe("repo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the working directory outside a repository", async () => {
    const posts = recordPosts();
    try {
      const plugin = await serverV1({ directory: "/scratch/notes", worktree: "/" });
      await plugin["chat.message"]({ sessionID: "ses_noroot" }, {
        message: { role: "user", sessionID: "ses_noroot" },
        parts: [{ type: "text", text: "hi" }],
      });
      expect(posts[0].body.project).toBe("notes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records the user's prompt text, excluding synthetic parts", async () => {
    const posts = recordPosts();
    try {
      const plugin = await serverV1(pluginCtx);
      await plugin["chat.message"]({ sessionID: "ses_prompt" }, {
        message: { role: "user", sessionID: "ses_prompt" },
        parts: [
          { type: "text", text: "fix the login bug" },
          { type: "text", text: "<injected context>", synthetic: true },
          { type: "file" },
        ],
      });
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toContain("/api/sessions/init");
      expect(posts[0].body.prompt).toBe("fix the login bug");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not add an empty prompt when a tool runs after the prompt", async () => {
    const posts = recordPosts();
    try {
      const plugin = await serverV1(pluginCtx);
      await plugin["chat.message"]({ sessionID: "ses_order" }, {
        message: { role: "user", sessionID: "ses_order" },
        parts: [{ type: "text", text: "list files" }],
      });
      await plugin["tool.execute.after"](
        { tool: "bash", sessionID: "ses_order", callID: "c1", args: { command: "ls" } },
        { title: "Bash", output: "a b", metadata: {} },
      );
      expect(posts.map((post) => new URL(post.url).pathname)).toEqual([
        "/api/sessions/init",
        "/api/sessions/observations",
      ]);
      expect(posts[1].body.contentSessionId).toBe(posts[0].body.contentSessionId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenCode plugin module contract across host generations", () => {
  const hostLoaders = {
    "OpenCode 2.x": (mod: Record<string, unknown>) => loadWithOpenCodeV2(mod),
    "OpenCode 1.18": (mod: Record<string, unknown>) => loadWithOpenCodeV1_18(mod),
    "OpenCode 1.x legacy": (mod: Record<string, unknown>) => loadWithOpenCodeV1Legacy(mod),
  };

  function expectLoadsEverywhere(mod: Record<string, unknown>) {
    expect(loadWithOpenCodeV2(mod)).toMatchObject({ id: "claude-mem", kind: "setup", entry: setupV2 });
    expect(loadWithOpenCodeV1_18(mod)).toEqual([serverV1]);
    expect(loadWithOpenCodeV1Legacy(mod)).toEqual([serverV1]);
  }

  it("the source entry module loads on every OpenCode generation", async () => {
    const mod = await import("../../src/integrations/opencode-plugin/index");
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(mod.default).toBe(ClaudeMemPlugin);
    expect("effect" in ClaudeMemPlugin).toBe(false);
    expectLoadsEverywhere(mod);
  });

  it("the built bundle exports only its default definition and loads on every generation", async () => {
    const bundlePath = join(process.cwd(), "dist/opencode-plugin/index.js");
    if (!existsSync(bundlePath)) {
      console.warn("dist/opencode-plugin/index.js not built; run the build to check the shipped bundle");
      return;
    }
    const bundle = await import(`${bundlePath}?bundle-${Date.now()}`);
    expect(Object.keys(bundle)).toEqual(["default"]);
    expect(loadWithOpenCodeV2(bundle)).toMatchObject({ id: "claude-mem", kind: "setup" });
    expect(loadWithOpenCodeV1_18(bundle)).toHaveLength(1);
    expect(loadWithOpenCodeV1Legacy(bundle)).toHaveLength(1);
  });

  it("negative control: a V1 factory module is refused by OpenCode 2.x", () => {
    const v1Only = { default: serverV1 };
    expect(() => hostLoaders["OpenCode 2.x"](v1Only)).toThrow("must export a default definition");
    expect(hostLoaders["OpenCode 1.x legacy"](v1Only)).toEqual([serverV1]);
  });

  it("negative control: a leaked non-function export is refused by the 1.x legacy loader", () => {
    const leaked = { default: serverV1, EVENT_TYPES: ["session.idle"] };
    expect(() => hostLoaders["OpenCode 1.x legacy"](leaked)).toThrow("Plugin export is not a function");
  });

  it("negative control: a V2-only definition is refused by OpenCode 1.18", () => {
    const v2Only = { default: { id: "claude-mem", setup: setupV2 } };
    expect(() => hostLoaders["OpenCode 1.18"](v2Only)).toThrow("must default export an object with server()");
  });
});

type Callback = (event: any) => void | Promise<void>;

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, any> | null;
}

/** Push-driven async iterable standing in for ctx.event.subscribe(). */
function eventChannel() {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(event: any) {
      queue.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    iterable(signal?: AbortSignal): AsyncIterable<any> {
      signal?.addEventListener("abort", () => {
        closed = true;
        wake?.();
      });
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queue.length) {
              yield queue.shift();
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => (wake = resolve));
            wake = null;
          }
        },
      };
    },
  };
}

function stubContext() {
  const sessionHooks = new Map<string, Callback>();
  const toolHooks = new Map<string, Callback>();
  const tools = new Map<string, any>();
  const events = eventChannel();
  const disposed: string[] = [];
  let subscribeSignal: AbortSignal | undefined;

  const registration = (name: string) => ({
    dispose: async () => {
      disposed.push(name);
    },
  });

  const ctx = {
    location: { directory: "/tmp/x/sub", project: { directory: "/tmp/x" } },
    session: {
      hook: async (name: string, callback: Callback) => {
        sessionHooks.set(name, callback);
        return registration(`session.${name}`);
      },
    },
    tool: {
      hook: async (name: string, callback: Callback) => {
        toolHooks.set(name, callback);
        return registration(`tool.${name}`);
      },
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: any) => tools.set(tool.name, tool) });
        return registration("tool.transform");
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => {
        subscribeSignal = options?.signal;
        return events.iterable(options?.signal);
      },
    },
  } as unknown as OpenCodeV2PluginContext;

  return {
    ctx,
    sessionHooks,
    toolHooks,
    tools,
    events,
    disposed,
    signal: () => subscribeSignal,
  };
}

const originalFetchV2 = globalThis.fetch;
let requests: RecordedRequest[] = [];

function recordFetch(responseBody: unknown = { status: "queued" }) {
  requests = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      method: init?.method || "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
}

const posts = () => requests.filter((request) => request.method === "POST");
const postsTo = (path: string) => posts().filter((request) => request.url.endsWith(path));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  globalThis.fetch = originalFetchV2;
});

describe("OpenCode 2.x setup hooks", () => {
  it("registers the prompt, compaction and execute.after hooks, the search tool, and one event subscription", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);

    expect([...stub.sessionHooks.keys()].sort()).toEqual(["compaction", "prompt"]);
    expect([...stub.toolHooks.keys()]).toEqual(["execute.after"]);
    expect([...stub.tools.keys()]).toEqual(["claude_mem_search"]);
    expect(stub.signal()).toBeDefined();

    await cleanup();
    expect(stub.signal()!.aborted).toBe(true);
    expect(stub.disposed.sort()).toEqual([
      "session.compaction",
      "session.prompt",
      "tool.execute.after",
      "tool.transform",
    ]);
  });

  it("reacts only to its declared bus event types", () => {
    expect([...V2_EVENT_TYPES]).toEqual(["session.text.ended", "session.execution.succeeded", "session.deleted"]);
  });

  it("initializes the session with the prompt text and the project directory name", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);

    await stub.sessionHooks.get("prompt")!({
      sessionID: "ses_prompt",
      messageID: "msg_1",
      prompt: { text: "fix the login bug" },
      delivery: "immediate",
    });

    const [init] = postsTo("/api/sessions/init");
    expect(init.body).toMatchObject({
      project: "x",
      prompt: "fix the login bug",
      platformSource: normalizePlatformSource("opencode"),
    });
    expect(init.body!.contentSessionId).toStartWith("opencode-ses_prompt-");
    await cleanup();
  });

  it("posts a completed tool run as an observation, lazily initializing unseen sessions", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);

    await stub.toolHooks.get("execute.after")!({
      tool: "read",
      sessionID: "ses_tool",
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      input: { path: "/a" },
      status: "completed",
      result: { content: [{ type: "text", text: "file contents" }, { type: "file", uri: "file:///a", mime: "text/plain" }] },
    });

    expect(posts().map((request) => new URL(request.url).pathname)).toEqual([
      "/api/sessions/init",
      "/api/sessions/observations",
    ]);
    const observation = postsTo("/api/sessions/observations")[0].body!;
    expect(observation).toMatchObject({
      tool_name: "read",
      tool_input: { path: "/a" },
      tool_response: "file contents",
      tool_use_id: "call_1",
      cwd: "/tmp/x/sub",
      platformSource: normalizePlatformSource("opencode"),
    });
    expect(observation.contentSessionId).toBe(postsTo("/api/sessions/init")[0].body!.contentSessionId);
    await cleanup();
  });

  it("records string content, structured output, and errors as the tool response", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);
    const after = stub.toolHooks.get("execute.after")!;
    const base = { sessionID: "ses_shapes", agent: "build", messageID: "m", input: {} };

    await after({ ...base, tool: "bash", id: "c1", status: "completed", result: { content: "ok" } });
    await after({ ...base, tool: "glob", id: "c2", status: "completed", result: { output: { files: ["a"] } } });
    await after({ ...base, tool: "edit", id: "c3", status: "error", error: { message: "denied" } });

    expect(postsTo("/api/sessions/observations").map((request) => request.body!.tool_response)).toEqual([
      "ok",
      '{"files":["a"]}',
      "Error: denied",
    ]);
    // Only the first activity for a session initializes it.
    expect(postsTo("/api/sessions/init")).toHaveLength(1);
    await cleanup();
  });

  it("truncates tool responses to 1000 characters", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);

    await stub.toolHooks.get("execute.after")!({
      tool: "read",
      sessionID: "ses_long",
      agent: "build",
      messageID: "m",
      id: "c1",
      input: {},
      status: "completed",
      result: { content: "x".repeat(5000) },
    });

    expect(postsTo("/api/sessions/observations")[0].body!.tool_response).toHaveLength(1000);
    await cleanup();
  });

  it("summarizes on compaction without supplying a compaction result", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);
    const event: Record<string, unknown> = { sessionID: "ses_compact", messages: [], system: [], options: {} };

    await stub.sessionHooks.get("compaction")!(event);

    expect(postsTo("/api/sessions/summarize")).toHaveLength(1);
    expect(event.result).toBeUndefined();
    await cleanup();
  });

  it("reacts to session.text.ended, session.execution.succeeded and session.deleted bus events only", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);

    stub.events.push({ type: "session.text.ended", data: { sessionID: "ses_bus", text: "assistant output" } });
    stub.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_bus" } });
    // V1-only, phantom and unrelated events must not produce worker writes.
    stub.events.push({ type: "session.idle", data: { sessionID: "ses_bus" } });
    stub.events.push({ type: "session.created", data: { sessionID: "ses_bus" } });
    stub.events.push({ type: "session.text.delta", data: { sessionID: "ses_bus", text: "partial" } });
    await flush();

    expect(posts().map((request) => new URL(request.url).pathname)).toEqual([
      "/api/sessions/init",
      "/api/sessions/observations",
      "/api/sessions/summarize",
    ]);
    const observation = postsTo("/api/sessions/observations")[0].body!;
    expect(observation).toMatchObject({ tool_name: "assistant_message", tool_response: "assistant output" });

    // session.deleted forgets the mapping: the next activity re-initializes
    // under a fresh content session id.
    const firstId = observation.contentSessionId;
    stub.events.push({ type: "session.deleted", data: { sessionID: "ses_bus" } });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 2));
    stub.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_bus" } });
    await flush();

    const inits = postsTo("/api/sessions/init");
    expect(inits).toHaveLength(2);
    expect(inits[1].body!.contentSessionId).not.toBe(firstId);
    await cleanup();
  });

  it("stamps every write with the opencode platform source", async () => {
    recordFetch();
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);

    await stub.sessionHooks.get("prompt")!({ sessionID: "ses_stamp", messageID: "m", prompt: { text: "hi" } });
    await stub.toolHooks.get("execute.after")!({
      tool: "read", sessionID: "ses_stamp", agent: "build", messageID: "m", id: "c", input: {},
      status: "completed", result: { content: "ok" },
    });
    await stub.sessionHooks.get("compaction")!({ sessionID: "ses_stamp" });
    stub.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_stamp" } });
    await flush();

    expect(posts()).toHaveLength(4);
    for (const post of posts()) {
      expect(post.body!.platformSource).toBe(normalizePlatformSource("opencode"));
    }
    await cleanup();
  });

  it("the search tool issues a GET and returns the worker's text blocks", async () => {
    recordFetch({ content: [{ type: "text", text: 'Found 1 observation(s) matching "auth"' }] });
    const stub = stubContext();
    const cleanup = await setupV2(stub.ctx);
    const search = stub.tools.get("claude_mem_search")!;

    expect(search.input).toMatchObject({ type: "object", required: ["query"] });
    const result = await search.execute({ query: "auth" });

    expect(result).toEqual({ content: 'Found 1 observation(s) matching "auth"' });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toContain("/api/search/observations?query=auth&limit=10");
    expect(await search.execute({ query: "" })).toEqual({ content: "Please provide a search query." });
    await cleanup();
  });
});

describe("OpenCode search client response-shape contract", () => {
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

describe("isConnectionRefusedError (worker-down warning suppression)", () => {
  // The plugin stays quiet when the worker is simply not running. OpenCode
  // hosts plugins under Bun, whose fetch rejects a refused connection with
  // code 'ConnectionRefused' and no 'ECONNREFUSED' anywhere in the message;
  // Node's undici puts ECONNREFUSED only on error.cause. A regression to
  // message-only matching would spam a warning on every event while the
  // worker is down.
  it("recognizes Bun's ConnectionRefused shape", () => {
    const bunRefusal = Object.assign(
      new Error("Unable to connect. Is the computer able to access the url?"),
      { code: "ConnectionRefused" }
    );
    expect(isConnectionRefusedError(bunRefusal)).toBe(true);
  });

  it("recognizes undici's fetch failed with cause ECONNREFUSED", () => {
    const undiciRefusal = new TypeError("fetch failed");
    (undiciRefusal as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:37777"),
      { code: "ECONNREFUSED" }
    );
    expect(isConnectionRefusedError(undiciRefusal)).toBe(true);
  });

  it("recognizes a legacy message-embedded ECONNREFUSED", () => {
    expect(isConnectionRefusedError(new Error("connect ECONNREFUSED 127.0.0.1:37777"))).toBe(true);
  });

  it("recognizes a refusal nested in an AggregateError (happy-eyeballs dual-stack connect)", () => {
    const aggregate = new AggregateError(
      [
        Object.assign(new Error("connect ECONNRESET ::1:37777"), { code: "ECONNRESET" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:37777"), { code: "ECONNREFUSED" }),
      ],
      "all attempts failed",
    );
    const wrapped = new TypeError("fetch failed");
    (wrapped as { cause?: unknown }).cause = aggregate;
    expect(isConnectionRefusedError(wrapped)).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    expect(isConnectionRefusedError(new Error("TLS handshake exploded"))).toBe(false);
    expect(isConnectionRefusedError(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(false);
    expect(isConnectionRefusedError("string error")).toBe(false);
  });

  it("keeps the plugin bundle free of worker-only modules (dependency-free shared helper)", () => {
    const pluginSource = readFileSync("src/integrations/opencode-plugin/worker.ts", "utf8");
    expect(pluginSource).toContain('from "../../shared/connection-errors.js"');
    const helperSource = readFileSync("src/shared/connection-errors.ts", "utf8");
    expect(helperSource).not.toMatch(/^import /m);
  });

  it("stays quiet on a Bun-shaped refusal but still warns on a real failure", async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const plugin = await serverV1(pluginCtx);
      const runTool = () => plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_refused", callID: "c1" },
        { title: "Read", output: "file contents", metadata: {}, args: { path: "/a" } },
      );

      globalThis.fetch = (async () => {
        throw Object.assign(
          new Error("Unable to connect. Is the computer able to access the url?"),
          { code: "ConnectionRefused" },
        );
      }) as typeof fetch;
      await runTool();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnings).toEqual([]);

      globalThis.fetch = (async () => {
        throw new Error("TLS handshake exploded");
      }) as typeof fetch;
      await runTool();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnings.some((line) => line.includes("TLS handshake exploded"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });
});
