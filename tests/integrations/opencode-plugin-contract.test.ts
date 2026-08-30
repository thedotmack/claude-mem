import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as pluginEntry from "../../src/integrations/opencode-plugin/index";
import ClaudeMemPlugin from "../../src/integrations/opencode-plugin/index";
import {
  parseSearchResponse,
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/contract";

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
        { tool: "read", sessionID: "ses_1", callID: "c1", args: { path: "/a" } },
        { title: "Read", output: "file contents", metadata: {} },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(initPost, "tool.execute.after should lazily init the session").toBeTruthy();
      expect(obsPost, "tool.execute.after should POST an observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_name).toBe("read");
      expect(obsBody.tool_response).toBe("file contents");
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

      // init(tool) + observation(tool) + init(user prompt) + observation(assistant)
      // + summarize(compacting) + summarize(idle). The second init is the
      // re-post carrying the real user prompt after the tool-first lazy init
      // (#3803) — before that fix the prompt was dropped and this was 5.
      const workerPosts = posts.filter((p) => p.url.includes("/api/sessions/"));
      expect(workerPosts.length).toBe(6);
      for (const post of workerPosts) {
        expect(post.body.platform_source, `${post.url} must carry the platform source`).toBe(
          "opencode",
        );
      }
    } finally {
      restoreFetch();
    }
  });

  it("derives the project from the worktree basename, not project.name", async () => {
    captureFetch();
    try {
      const plugin = await ClaudeMemPlugin({
        ...pluginCtx,
        project: { name: "opencode", path: "/tmp/x" },
        directory: "/tmp/my-repo/sub/dir",
        worktree: "/tmp/my-repo",
      });
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_proj", callID: "c1" },
        { title: "Read", output: "x", metadata: {}, args: {} },
      );
      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      expect(initPost, "session init should fire").toBeTruthy();
      expect(initPost!.body.project).toBe("my-repo");
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
    // Activity-first lazy init marks the session initialized with an empty
    // prompt; the real prompt arriving afterwards via chat.message(user) must
    // still reach the worker instead of being suppressed.
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
      expect(
        initPosts.some((p) => p.body.prompt === "the real prompt"),
        "the real user prompt must reach the worker even after a tool-only lazy init",
      ).toBe(true);
    } finally {
      restoreFetch();
    }
  });

  it("initializes lazily exactly once for consecutive activity-only calls", async () => {
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
      expect(initPosts.length, "activity-only paths must init exactly once").toBe(1);
    } finally {
      restoreFetch();
    }
  });

  it("keys linked git worktrees by parent-repo/worktree-leaf", async () => {
    // Real worktree shape on disk: a `.git` FILE pointing into the parent
    // repo's .git/worktrees directory, exactly what git writes for
    // `git worktree add`.
    const base = mkdtempSync(join(tmpdir(), "claude-mem-wt-"));
    try {
      const parentRepo = join(base, "parent-repo");
      mkdirSync(join(parentRepo, ".git", "worktrees", "leaf-worktree"), { recursive: true });
      const worktreeDir = join(base, "leaf-worktree");
      mkdirSync(worktreeDir);
      writeFileSync(
        join(worktreeDir, ".git"),
        `gitdir: ${join(parentRepo, ".git", "worktrees", "leaf-worktree")}\n`,
        "utf-8",
      );

      captureFetch();
      try {
        const plugin = await ClaudeMemPlugin({ ...pluginCtx, worktree: worktreeDir });
        await plugin["tool.execute.after"](
          { tool: "read", sessionID: "ses_wt", callID: "c1" },
          { title: "Read", output: "x", metadata: {}, args: {} },
        );
        const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
        expect(initPost, "session init should fire").toBeTruthy();
        expect(initPost!.body.project).toBe("parent-repo/leaf-worktree");
      } finally {
        restoreFetch();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("still uses the bare basename for a plain (non-worktree) directory", async () => {
    // A `.git` DIRECTORY (a normal repo) is not a linked worktree; the
    // existing leaf-basename behaviour must be preserved.
    const base = mkdtempSync(join(tmpdir(), "claude-mem-plain-"));
    try {
      mkdirSync(join(base, ".git"), { recursive: true });

      captureFetch();
      try {
        const plugin = await ClaudeMemPlugin({ ...pluginCtx, worktree: base });
        await plugin["tool.execute.after"](
          { tool: "read", sessionID: "ses_plain", callID: "c1" },
          { title: "Read", output: "x", metadata: {}, args: {} },
        );
        const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
        expect(initPost, "session init should fire").toBeTruthy();
        expect(initPost!.body.project).toBe(basename(base));
      } finally {
        restoreFetch();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
