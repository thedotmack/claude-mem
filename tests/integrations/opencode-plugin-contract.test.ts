import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as pluginEntry from "../../src/integrations/opencode-plugin/index";
import ClaudeMemPlugin from "../../src/integrations/opencode-plugin/index";
import {
  parseSearchResponse,
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/contract";
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
  // (input: { sessionID?, model }, output: { system: string[] }) in OpenCode's
  // plugin Hooks type (packages/plugin/src/index.ts).
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
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

describe("OpenCode plugin event contract", () => {
  it("shipped bundle exports only a functional default factory", async () => {
    // Regression guard for #4197, coordinated with #3803: opencode's loader
    // iterates every named export of the plugin file and calls each as a
    // plugin factory. If a non-function export (e.g. the contract constants)
    // leaks into the bundle, the whole plugin fails to load with
    // "Plugin export is not a function".
    //
    // This must exercise the GENERATED bundle (the file users receive), not
    // the TypeScript entry: importing the entry cannot catch exports the
    // bundler itself introduces or leaks. It builds with the options
    // scripts/build-hooks.js uses (scripts/opencode-plugin-build-options.js),
    // into a temp dir so the test stays self-contained. #3803 moved the entry
    // module to a default-only export; this test pins the shipped artifact to
    // that contract.
    const { buildSync } = await import("esbuild");
    const { OPENCODE_PLUGIN_BUILD_OPTIONS } = await import("../../scripts/opencode-plugin-build-options.js");
    const dir = mkdtempSync(join(tmpdir(), "claude-mem-opencode-bundle-"));
    const outfile = join(dir, "index.js");
    try {
      buildSync({ ...OPENCODE_PLUGIN_BUILD_OPTIONS, outfile });
      const bundle = await import(pathToFileURL(outfile).href);
      const exportNames = Object.keys(bundle).sort();
      expect(exportNames).toEqual(["default"]);
      expect(typeof bundle.default).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a bundle that leaks a non-function export (negative control)", async () => {
    // Guards the guard: proves the assertion above can actually catch a
    // leaked non-function export, so a future green run is meaningful.
    const { buildSync } = await import("esbuild");
    const dir = mkdtempSync(join(tmpdir(), "claude-mem-opencode-bundle-neg-"));
    const entry = join(dir, "entry.ts");
    const outfile = join(dir, "index.js");
    try {
      writeFileSync(
        entry,
        "export const LEAKED = [1, 2, 3];\nexport default function plugin() { return {}; }\n",
      );
      buildSync({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        target: "node18",
        format: "esm",
        outfile,
        minify: true,
        logLevel: "error",
        external: [],
      });
      const bundle = await import(pathToFileURL(outfile).href);
      // Exact export list: proves the synthetic leak was actually emitted, so a
      // green run of this control is meaningful (per review feedback).
      expect(Object.keys(bundle).sort()).toEqual(["LEAKED", "default"]);
      expect(Array.isArray((bundle as Record<string, unknown>).LEAKED)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the worker port from persisted settings without importing worker-utils", () => {
    const source = readFileSync(
      "src/integrations/opencode-plugin/index.ts",
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
      const { default: ReloadedPlugin } = await import(
        `../../src/integrations/opencode-plugin/index.ts?opencode-settings-${Date.now()}`
      );
      const plugin = await ReloadedPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_45678", callID: "c1" },
        { title: "Read", output: "file contents", metadata: {}, args: { path: "/a" } },
      );

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
      const plugin = await ClaudeMemPlugin(pluginCtx);
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
      expect(initPost, "tool.execute.after must not manufacture a user prompt").toBeUndefined();
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
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const expectedPlatformSource = normalizePlatformSource("opencode");

      const postHookInvocations: Record<string, () => Promise<void>> = {
        "tool.execute.after": () => plugin["tool.execute.after"](
          { tool: "read", sessionID: "ses_contract_tool", callID: "c1" },
          { title: "Read", output: "tool output", metadata: {}, args: {} },
        ),
        "chat.message": () => plugin["chat.message"](
          {},
          {
            message: { role: "assistant", sessionID: "ses_contract_chat" },
            parts: [{ type: "text", text: "assistant output" }],
          },
        ),
        "experimental.session.compacting": () => plugin["experimental.session.compacting"]({ sessionID: "ses_contract_compact" }),
        event: () => plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_contract_idle" } } }),
        // Reads context (a GET); it writes nothing.
        "experimental.chat.system.transform": () => plugin["experimental.chat.system.transform"](
          { sessionID: "ses_contract_system" },
          { system: [] },
        ),
      };
      for (const hook of REGISTERED_OPENCODE_HOOKS) {
        const invoke = postHookInvocations[hook];
        expect(invoke, `registered hook "${hook}" must have a POST contract case`).toBeDefined();
        await invoke!();
      }

      const posts = requests.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(4);
      expect(posts.map((request) => request.url)).toEqual([
        expect.stringContaining("/api/sessions/observations"),
        expect.stringContaining("/api/sessions/observations"),
        expect.stringContaining("/api/sessions/summarize"),
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
      const plugin = await ClaudeMemPlugin(pluginCtx);
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

  it("does not read output args when input args are absent", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_output_fallback", callID: "c3" },
        { title: "Read", output: "ok", metadata: {}, args: { path: "/fallback" } },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect((obsPost!.body as Record<string, unknown>).tool_input).toEqual({});
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
      const plugin = await ClaudeMemPlugin(pluginCtx);
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
      const plugin = await ClaudeMemPlugin(pluginCtx);
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

  it("reads tool arguments from the hook INPUT, not the output (#3678)", async () => {
    // OpenCode passes tool arguments on the first hook argument; the output
    // never carries them. The old `output.args || {}` read shipped an empty
    // tool_input for every observation, and the compressor dismissed them
    // all — the "loads but captures nothing" symptom of #3678.
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
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "edit", sessionID: "ses_args", callID: "c2", args: { filePath: "/a/b.ts" } },
        { title: "Edit", output: "applied", metadata: {} },
      );
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(obsPost, "observation should POST").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_input).toEqual({ filePath: "/a/b.ts" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenCode plugin entry-module export contract", () => {
  // OpenCode's loader treats EVERY export of the plugin entry module as a
  // plugin factory: each must be a function, and each gets invoked. A
  // non-function export (the v13.x data constants) fails the whole plugin
  // load with "Plugin export is not a function"; an extra function export
  // would run as a second plugin instance. The data constants therefore live
  // in contract.ts, and this test pins the entry module to factory-only
  // exports (#3330).
  it("exports only the plugin factory (every export must be a function)", () => {
    const exports = Object.entries(pluginEntry);
    expect(exports.length, "the entry module must have exports").toBeGreaterThan(0);
    for (const [name, value] of exports) {
      expect(typeof value, `export "${name}" must be a function`).toBe("function");
    }
  });
});

describe("OpenCode plugin attribution contract", () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;

  const captureFetch = () => {
    posts.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;
  };

  const restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  it("sends platform_source=opencode on every worker POST", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        directory: "/tmp/repo",
        worktree: "/tmp/repo",
      });
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_src", callID: "c1" },
        { title: "Read", output: "x", metadata: {}, args: {} },
      );
      await plugin["chat.message"](
        {},
        { message: { role: "user", sessionID: "ses_src" }, parts: [{ type: "text", text: "hi" }] },
      );
      await plugin["chat.message"](
        {},
        { message: { role: "assistant", sessionID: "ses_src" }, parts: [{ type: "text", text: "hello" }] },
      );
      await plugin["experimental.session.compacting"]({ sessionID: "ses_src" });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_src" } } });

      // observation(tool) + init(user prompt) + observation(assistant) +
      // summarize(compacting) + summarize(idle). Only a real user prompt may
      // post init; all other endpoints create their session row themselves
      // (#3803).
      const workerPosts = posts.filter((p) => p.url.includes("/api/sessions/"));
      expect(workerPosts.length).toBe(5);
      for (const post of workerPosts) {
        expect(post.body.platform_source, `${post.url} must carry the platform source`).toBe(
          "opencode",
        );
      }
    } finally {
      restoreFetch();
    }
  });

  it("sends the checkout for the worker to key, never project.name", async () => {
    // project.name is "opencode" for every project. The worker keys the
    // session from the checkout with the same resolver it applies to the
    // plugin's observations (tests/worker/http/routes/session-routes-init-checkout.test.ts).
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        project: { name: "opencode", path: "/tmp/x" },
        directory: "/tmp/my-repo/sub/dir",
        worktree: "/tmp/my-repo",
      });
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_proj", callID: "c1", args: { path: "/a" } },
        { title: "Read", output: "x", metadata: {} },
      );
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_proj" },
          parts: [{ type: "text", text: "remember this project" }],
        },
      );
      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(initPost, "a real user prompt should initialize the session").toBeTruthy();
      expect(initPost!.body.project).toBeUndefined();
      expect(initPost!.body.cwd).toBe("/tmp/my-repo/sub/dir");
      expect(initPost!.body.cwd).toBe(obsPost!.body.cwd);
    } finally {
      restoreFetch();
    }
  });

  it("records the real user prompt at session init instead of [media prompt]", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_prompt" },
          parts: [{ type: "text", text: "investigate the flaky test" }],
        },
      );
      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      expect(initPost, "chat.message(user) should lazily init the session").toBeTruthy();
      expect(initPost!.body.prompt).toBe("investigate the flaky test");
    } finally {
      restoreFetch();
    }
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

describe("OpenCode plugin prompt and worktree contract (#3803)", () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;

  const captureFetch = () => {
    posts.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;
  };

  const restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };

  it("records the real user prompt even when a tool ran before it", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_toolfirst", callID: "c1" },
        { title: "Read", output: "x", metadata: {}, args: {} },
      );
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_toolfirst" },
          parts: [{ type: "text", text: "the real prompt" }],
        },
      );
      const initPosts = posts.filter((p) => p.url.includes("/api/sessions/init"));
      expect(initPosts.length, "only the real user prompt may post init").toBe(1);
      expect(initPosts[0]!.body.prompt).toBe("the real prompt");
      expect(posts.some((p) => p.body.prompt === "")).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  it("does not initialize consecutive activity-only calls", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_lazy", callID: "c1" },
        { title: "Read", output: "x", metadata: {}, args: {} },
      );
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_lazy", callID: "c2" },
        { title: "Read", output: "y", metadata: {}, args: {} },
      );
      const initPosts = posts.filter((p) => p.url.includes("/api/sessions/init"));
      const observationPosts = posts.filter((p) => p.url.includes("/api/sessions/observations"));
      expect(initPosts.length, "activity-only paths must not post init").toBe(0);
      expect(observationPosts.length, "activity-only paths must still post observations").toBe(2);
    } finally {
      restoreFetch();
    }
  });

  it("does not initialize an empty user message", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_empty_prompt" },
          parts: [{ type: "image" }, { type: "text", text: "" }],
        },
      );
      const initPosts = posts.filter((p) => p.url.includes("/api/sessions/init"));
      expect(initPosts.length, "empty user messages must not post init").toBe(0);
    } finally {
      restoreFetch();
    }
  });

  it("summarizes compaction and idle events without initializing a prompt", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["experimental.session.compacting"]({ sessionID: "ses_summarize_only" });
      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "ses_summarize_only" } },
      });
      const initPosts = posts.filter((p) => p.url.includes("/api/sessions/init"));
      const summarizePosts = posts.filter((p) => p.url.includes("/api/sessions/summarize"));
      expect(initPosts.length, "summarize-only paths must not post init").toBe(0);
      expect(summarizePosts.length, "both events must post summarize").toBe(2);
    } finally {
      restoreFetch();
    }
  });

  it("initializes each separate user prompt", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_two_prompts" },
          parts: [{ type: "text", text: "first prompt" }],
        },
      );
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_two_prompts" },
          parts: [{ type: "text", text: "second prompt" }],
        },
      );
      const initPosts = posts.filter((p) => p.url.includes("/api/sessions/init"));
      expect(initPosts.length).toBe(2);
      expect(initPosts.map((p) => p.body.prompt)).toEqual(["first prompt", "second prompt"]);
    } finally {
      restoreFetch();
    }
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
    const pluginSource = readFileSync("src/integrations/opencode-plugin/index.ts", "utf8");
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
      const plugin = await ClaudeMemPlugin(pluginCtx);
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

describe("OpenCode plugin lifecycle (#3208)", () => {
  type Request = { method: string; url: URL; body: Record<string, unknown> | null; signal: unknown };

  function captureRequests(
    requests: Request[],
    reply: (url: URL) => Response = () => new Response("{}", { status: 200 }),
  ): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method || "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        signal: init?.signal,
      });
      return reply(url);
    }) as typeof fetch;
  }

  it("injects memory context into the system prompt once per session, keyed by the checkout", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    captureRequests(requests, (url) =>
      url.pathname === "/api/context/inject" ? new Response("# memory context", { status: 200 }) : new Response("{}"));
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const transform = plugin["experimental.chat.system.transform"];

      const firstTurn = { system: ["base prompt"] };
      await transform({ sessionID: "ses_ctx_a" }, firstTurn);
      const secondTurn = { system: ["base prompt"] };
      await transform({ sessionID: "ses_ctx_a" }, secondTurn);
      await transform({ sessionID: "ses_ctx_b" }, { system: [] });

      expect(firstTurn.system).toEqual(["base prompt", "# memory context"]);
      expect(secondTurn.system).toEqual(["base prompt", "# memory context"]);
      const injects = requests.filter((request) => request.url.pathname === "/api/context/inject");
      expect(injects).toHaveLength(2);
      expect(injects[0].url.searchParams.get("cwd")).toBe(pluginCtx.directory);
      expect(injects[0].url.searchParams.get("projects")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("remembers a failed context fetch for a minute, then tries again (R5-7)", async () => {
    // A hung or failing worker must cost one bounded request a minute, not the
    // full request timeout on every system prompt OpenCode builds.
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const originalNow = Date.now;
    console.warn = () => {};
    const requests: Request[] = [];
    let workerUp = false;
    let now = 1_000_000;
    Date.now = () => now;
    captureRequests(requests, () => (workerUp ? new Response("# late context") : new Response("down", { status: 503 })));
    const injects = () => requests.filter((request) => request.url.pathname === "/api/context/inject").length;
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const transform = plugin["experimental.chat.system.transform"];

      const failed = { system: [] as string[] };
      await transform({ sessionID: "ses_ctx_retry" }, failed);
      await new Promise((resolve) => setTimeout(resolve, 0));
      workerUp = true;

      now += 59_000;
      const withinTheMinute = { system: [] as string[] };
      await transform({ sessionID: "ses_ctx_retry" }, withinTheMinute);
      expect(injects()).toBe(1);

      now += 2_000;
      const afterTheMinute = { system: [] as string[] };
      await transform({ sessionID: "ses_ctx_retry" }, afterTheMinute);

      expect(failed.system).toEqual([]);
      expect(withinTheMinute.system).toEqual([]);
      expect(afterTheMinute.system).toEqual(["# late context"]);
      expect(injects()).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      Date.now = originalNow;
    }
  });

  it("sends the latest completed assistant reply when the session idles or compacts", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    captureRequests(requests);
    const listed: unknown[] = [];
    const client = {
      session: {
        async messages(options: { path: { id: string } }) {
          listed.push(options);
          return {
            data: [
              { info: { role: "user", time: { completed: 1 } }, parts: [{ type: "text", text: "fix the bug" }] },
              { info: { role: "assistant", time: { completed: 2 } }, parts: [{ type: "text", text: "first reply" }] },
              { info: { role: "assistant", time: { completed: 3 } }, parts: [{ type: "text", text: "final reply" }] },
              { info: { role: "assistant", summary: true, time: { completed: 4 } }, parts: [{ type: "text", text: "a compaction summary" }] },
              { info: { role: "assistant", time: {} }, parts: [{ type: "text", text: "still streaming" }] },
            ],
          };
        },
      },
    };
    try {
      const plugin = await ClaudeMemPlugin({ ...pluginCtx, client });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_reply" } } });
      await plugin["experimental.session.compacting"]({ sessionID: "ses_reply" });

      const summaries = requests.filter((request) => request.url.pathname === "/api/sessions/summarize");
      expect(summaries.map((request) => request.body?.last_assistant_message)).toEqual(["final reply", "final reply"]);
      // The checkout rides along so the worker can skip an excluded one (R5-1).
      expect(summaries.map((request) => request.body?.cwd)).toEqual([pluginCtx.directory, pluginCtx.directory]);
      expect(listed).toEqual([
        { path: { id: "ses_reply" }, query: { directory: pluginCtx.directory } },
        { path: { id: "ses_reply" }, query: { directory: pluginCtx.directory } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bounds every worker request with a timeout signal", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    captureRequests(requests);
    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_bounded", callID: "c1", args: {} },
        { title: "Read", output: "x", metadata: {} },
      );
      await plugin["experimental.chat.system.transform"]({ sessionID: "ses_bounded" }, { system: [] });
      await plugin.tool.claude_mem_search.execute({ query: "auth" });

      expect(requests.length).toBeGreaterThanOrEqual(3);
      for (const request of requests) {
        expect(request.signal).toBeInstanceOf(AbortSignal);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
