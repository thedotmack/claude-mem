import { afterEach, afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
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
    const urls: string[] = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetches += 1;
      urls.push(String(url));
      return new Response(JSON.stringify({ status: "ok", pid: 4242 }), { status: 200 });
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
    // The liveness probe must hit the worker's dedicated /health endpoint,
    // not the bare base URL (any service on the port would answer "/").
    expect(urls[0]).toContain("/health");
  });

  it("treats a non-worker HTTP service on the port as down and launches", async () => {
    const mod = await freshPluginModule();
    let starts = 0;
    const urls: string[] = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      // A different service (or the viewer-less base route) answering 200 with
      // HTML must not count as a healthy claude-mem worker.
      return new Response("<html>not claude-mem</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as FetchStub;

    const ready = await mod.ensureWorkerRunning({
      startWorker: () => {
        starts += 1;
      },
      timeoutMs: 30,
      pollIntervalMs: 5,
    });

    expect(ready).toBe(false);
    expect(starts).toBe(1);
    expect(urls.every((url) => url.includes("/health"))).toBe(true);
  });

  it("treats a 200 with an unexpected payload as down and launches", async () => {
    const mod = await freshPluginModule();
    let starts = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      // Right status code, wrong contract: not the { status: "ok", ... }
      // payload /health serves, so the worker is not considered alive.
      return new Response(JSON.stringify({ status: "degraded" }), { status: 200 });
    }) as FetchStub;

    const ready = await mod.ensureWorkerRunning({
      startWorker: () => {
        starts += 1;
      },
      timeoutMs: 30,
      pollIntervalMs: 5,
    });

    expect(ready).toBe(false);
    expect(starts).toBe(1);
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

/**
 * Regression guard (Copilot review on fix/opencode-plugin-ensure-worker): a
 * start command that spawns but then dies with a non-zero code — e.g. npx
 * cannot resolve the CLI, Bun is missing, the worker script is gone — must be
 * treated as a launch failure. Without the `exit` handler the ensure loop
 * burns the full readiness timeout with launchFailed=false and the memoized
 * false result blocks every later plugin initialization from retrying.
 */
describe("OpenCode worker start exit handling", () => {
  // Snapshot the real module BEFORE mock.module mutates the live namespace
  // (bun's mock.module is process-global and sticky; re-register the real
  // module in afterAll so later test files see the original).
  const realChildProcess = require("node:child_process");

  interface FakeChild {
    listeners: Record<string, (...args: unknown[]) => void>;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    unref: () => void;
  }

  let spawned: FakeChild[] = [];

  function installSpawnMock(): void {
    const fakeSpawn = (
      _command: string,
      _args?: readonly string[],
      _options?: Record<string, unknown>,
    ): FakeChild => {
      const listeners: Record<string, (...args: unknown[]) => void> = {};
      const child: FakeChild = {
        listeners,
        on: (event, listener) => {
          listeners[event] = listener;
        },
        unref: () => {},
      };
      spawned.push(child);
      return child;
    };
    const moduleMock = { ...realChildProcess, spawn: fakeSpawn };
    mock.module("node:child_process", () => moduleMock);
    mock.module("child_process", () => moduleMock);
  }

  beforeAll(() => {
    installSpawnMock();
  });

  afterAll(() => {
    mock.module("node:child_process", () => realChildProcess);
    mock.module("child_process", () => realChildProcess);
  });

  // The default starter resolves inside the (async) ensure IIFE, so poll for
  // the mock spawn to have run before emitting child events.
  async function waitForSpawns(count: number): Promise<void> {
    for (let i = 0; i < 200 && spawned.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(spawned.length).toBeGreaterThanOrEqual(count);
  }

  it("treats a non-zero exit as a launch failure and resets the guard", async () => {
    const mod = await freshPluginModule();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw connectionRefused();
    }) as FetchStub;
    try {
      spawned = [];
      const startedAt = Date.now();
      const readyPromise = mod.ensureWorkerRunning({ timeoutMs: 5000, pollIntervalMs: 10 });
      await waitForSpawns(1);
      // `npx` spawned fine but the start command died (e.g. CLI not installed).
      spawned[0].listeners["exit"]?.(1, null);

      const ready = await readyPromise;
      expect(ready).toBe(false);
      // The failed exit must short-circuit the wait, not burn the 5s timeout.
      expect(Date.now() - startedAt).toBeLessThan(2000);

      // The one-shot guard must have reset: a later init spawns again.
      const secondPromise = mod.ensureWorkerRunning({ timeoutMs: 5000, pollIntervalMs: 10 });
      await waitForSpawns(2);
      spawned[1].listeners["exit"]?.(1, null);
      const second = await secondPromise;
      expect(second).toBe(false);
      expect(spawned).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("treats a signal-killed start process (null code) as a launch failure", async () => {
    const mod = await freshPluginModule();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw connectionRefused();
    }) as FetchStub;
    try {
      spawned = [];
      const readyPromise = mod.ensureWorkerRunning({ timeoutMs: 5000, pollIntervalMs: 10 });
      await waitForSpawns(1);
      spawned[0].listeners["exit"]?.(null, "SIGKILL");

      const ready = await readyPromise;
      expect(ready).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("keeps waiting when the start command exits 0 (daemonized launch)", async () => {
    const mod = await freshPluginModule();
    let fetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches <= 3) throw connectionRefused();
      return new Response(JSON.stringify({ status: "ok", pid: 4242 }), { status: 200 });
    }) as FetchStub;
    try {
      spawned = [];
      const readyPromise = mod.ensureWorkerRunning({ timeoutMs: 5000, pollIntervalMs: 10 });
      await waitForSpawns(1);
      // `claude-mem start` daemonizes the worker and exits 0 on success — a
      // clean exit must NOT count as a launch failure; the readiness poll
      // keeps going until /health answers.
      spawned[0].listeners["exit"]?.(0, null);

      const ready = await readyPromise;
      expect(ready).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
