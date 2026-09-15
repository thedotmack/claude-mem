import { afterEach, describe, expect, it } from "bun:test";
import {
  resolveWorkerStartInvocation,
} from "../../src/integrations/opencode-plugin/index";

/**
 * Regression guard for the OpenCode worker auto-start (PR feedback on
 * fix/opencode-plugin-ensure-worker):
 *
 * 1. The capture hooks must only be exposed after the worker-start attempt has
 *    run and the worker is verified healthy (or the bounded wait gave up), so
 *    early `tool.execute.after` / `chat.message` events are not dropped on
 *    ECONNREFUSED while the health check is still in flight.
 * 2. The one-shot guard must reset when the launch fails, so a later plugin
 *    initialization retries instead of leaving capture disabled for the rest
 *    of the process.
 * 3. The launch must use the repository's Windows-aware invocation so the
 *    npm `npx.cmd` PATH shim is executable on Windows.
 */

const pluginCtx = {
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

let importCounter = 0;

// Each test gets a fresh module instance so the memoized worker-ensure state
// (and module-level settings) start clean, same cache-busting pattern as the
// plugin contract tests.
function freshPluginModule() {
  importCounter += 1;
  return import(
    `../../src/integrations/opencode-plugin/index.ts?worker-ensure-${Date.now()}-${importCounter}`
  );
}

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function connectionRefused(): Error {
  return new Error("fetch failed: ECONNREFUSED");
}

describe("OpenCode plugin worker auto-start", () => {
  let originalFetch: typeof fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves true without launching when the worker is already alive", async () => {
    const mod = await freshPluginModule();
    let starts = 0;
    let fetches = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as FetchStub;

    const ready = await mod.ensureWorkerRunning({
      startWorker: () => {
        starts += 1;
      },
      timeoutMs: 50,
      pollIntervalMs: 5,
    });

    expect(ready).toBe(true);
    expect(starts).toBe(0);
    expect(fetches).toBe(1);
  });

  it("launches the worker and resolves true once it responds", async () => {
    const mod = await freshPluginModule();
    let starts = 0;
    let fetches = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches <= 2) throw connectionRefused();
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as FetchStub;

    const ready = await mod.ensureWorkerRunning({
      startWorker: () => {
        starts += 1;
      },
      timeoutMs: 200,
      pollIntervalMs: 5,
    });

    expect(ready).toBe(true);
    expect(starts).toBe(1);
  });

  it("resets the one-shot guard when the launch fails so a later init retries", async () => {
    const mod = await freshPluginModule();
    let launches = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw connectionRefused();
    }) as FetchStub;

    const starter = (markLaunchFailed: () => void) => {
      launches += 1;
      markLaunchFailed();
    };

    const first = await mod.ensureWorkerRunning({
      startWorker: starter,
      timeoutMs: 50,
      pollIntervalMs: 5,
    });
    expect(first).toBe(false);
    expect(launches).toBe(1);

    const second = await mod.ensureWorkerRunning({
      startWorker: starter,
      timeoutMs: 50,
      pollIntervalMs: 5,
    });
    expect(second).toBe(false);
    expect(launches).toBe(2);
  });

  it("memoizes the attempt so concurrent initializations launch only once", async () => {
    const mod = await freshPluginModule();
    let launches = 0;
    let fetches = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches <= 2) throw connectionRefused();
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as FetchStub;

    const starter = () => {
      launches += 1;
    };
    const [first, second] = await Promise.all([
      mod.ensureWorkerRunning({ startWorker: starter, timeoutMs: 200, pollIntervalMs: 5 }),
      mod.ensureWorkerRunning({ startWorker: starter, timeoutMs: 200, pollIntervalMs: 5 }),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(launches).toBe(1);
  });

  it("resolves false after the bounded timeout when the worker never responds", async () => {
    const mod = await freshPluginModule();
    let launches = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw connectionRefused();
    }) as FetchStub;

    const ready = await mod.ensureWorkerRunning({
      startWorker: () => {
        launches += 1;
      },
      timeoutMs: 30,
      pollIntervalMs: 5,
    });

    expect(ready).toBe(false);
    expect(launches).toBe(1);
  });

  it("exposes the capture hooks only after the worker is verified healthy", async () => {
    const mod = await freshPluginModule();
    let workerHealthy = false;
    let fetches = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches <= 2) throw connectionRefused();
      workerHealthy = true;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as FetchStub;

    const plugin = await mod.default(pluginCtx);

    expect(workerHealthy).toBe(true);
    expect(Object.keys(plugin)).toContain("tool.execute.after");
    expect(Object.keys(plugin)).toContain("chat.message");
  });
});

describe("OpenCode worker start invocation (Windows shims)", () => {
  it("wraps the resolved npx.cmd shim in a cmd.exe verbatim invocation", () => {
    const invocation = resolveWorkerStartInvocation(
      "win32",
      () => "C:\\Program Files\\nodejs\\npx.cmd",
    );

    expect(invocation.command).toBe(process.env.ComSpec ?? "cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("npx.cmd");
    expect(invocation.args[3]).toContain("claude-mem");
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
    expect(invocation.options.stdio).toBe("ignore");
  });

  it("falls back to npx.cmd when no shim is found on Windows", () => {
    const invocation = resolveWorkerStartInvocation("win32", () => null);

    expect(invocation.command).toBe(process.env.ComSpec ?? "cmd.exe");
    expect(invocation.args[3]).toContain("npx.cmd");
  });

  it("spawns bare npx directly on non-Windows platforms", () => {
    const invocation = resolveWorkerStartInvocation("darwin", () => null);

    expect(invocation.command).toBe("npx");
    expect(invocation.args).toEqual(["claude-mem", "start"]);
    expect(invocation.options.stdio).toBe("ignore");
    expect(invocation.options.windowsVerbatimArguments).toBeUndefined();
  });
});
