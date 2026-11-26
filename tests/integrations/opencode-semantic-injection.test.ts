import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCore,
  fetchSemanticForPrompt,
  semanticInjectionSettings,
} from "../../src/integrations/opencode-plugin/core";
import { createV1Hooks } from "../../src/integrations/opencode-plugin/v1";
import { setupV2, type OpenCodePluginContextV2, type V2BusEvent } from "../../src/integrations/opencode-plugin/v2";

describe("semantic injection settings", () => {
  it("is off by default with limit 5 and narrative format", () => {
    expect(semanticInjectionSettings({})).toEqual({
      enabled: false,
      limit: 5,
      format: "narrative",
    });
  });

  it("reads the enable flag case-insensitively", () => {
    expect(semanticInjectionSettings({ CLAUDE_MEM_SEMANTIC_INJECT: "TRUE" }).enabled).toBe(true);
  });

  it("clamps the limit to the worker's maximum", () => {
    expect(
      semanticInjectionSettings({
        CLAUDE_MEM_SEMANTIC_INJECT: "true",
        CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: "999",
      }).limit,
    ).toBe(20);
  });

  it("clamps the limit to at least one", () => {
    expect(
      semanticInjectionSettings({
        CLAUDE_MEM_SEMANTIC_INJECT: "true",
        CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: "0",
      }).limit,
    ).toBe(1);
  });

  it("falls back to 5 when limit is non-numeric", () => {
    expect(
      semanticInjectionSettings({
        CLAUDE_MEM_SEMANTIC_INJECT: "true",
        CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: "abc",
      }).limit,
    ).toBe(5);
  });

  it("accepts a custom index format", () => {
    expect(
      semanticInjectionSettings({
        CLAUDE_MEM_SEMANTIC_INJECT: "true",
        CLAUDE_MEM_SEMANTIC_INJECT_FORMAT: "index",
      }).format,
    ).toBe("index");
  });
});

describe("fetchSemanticForPrompt", () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  });

  it("posts to /api/context/semantic with normalized platformSource and 5000 ms timeout", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const timeoutCalls: number[] = [];
    const fakeSignal = new AbortController().signal;
    AbortSignal.timeout = ((ms: number) => {
      timeoutCalls.push(ms);
      return fakeSignal;
    }) as typeof AbortSignal.timeout;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ context: "## Relevant Past Work (semantic match)\n\n### Fix", count: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const settings = semanticInjectionSettings({ CLAUDE_MEM_SEMANTIC_INJECT: "true" });
    const promptText = "How did we fix the worker shutdown retry in the installer?";
    const result = await fetchSemanticForPrompt(promptText, "/repo", settings, "OpenCode");

    expect(result).toContain("## Relevant Past Work (semantic match)");
    expect(requests).toHaveLength(1);
    expect(requests[0].url.endsWith("/api/context/semantic")).toBe(true);
    expect(requests[0].init?.method).toBe("POST");
    expect(requests[0].init?.signal).toBe(fakeSignal);
    expect(timeoutCalls).toEqual([5000]);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      q: promptText,
      cwd: "/repo",
      limit: 5,
      format: "narrative",
      platformSource: "opencode",
    });
  });

  it("fails open with no retry storm on 500, thrown fetch, or empty context", async () => {
    const settings = semanticInjectionSettings({ CLAUDE_MEM_SEMANTIC_INJECT: "true" });
    const promptText = "Investigate why semantic injection returns empty on error";

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await fetchSemanticForPrompt(promptText, "/repo", settings, "opencode")).toBe("");
    expect(callCount).toBe(1);

    callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchSemanticForPrompt(promptText, "/repo", settings, "opencode")).toBe("");
    expect(callCount).toBe(1);

    callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({ context: "", count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    expect(await fetchSemanticForPrompt(promptText, "/repo", settings, "opencode")).toBe("");
    expect(callCount).toBe(1);
  });

  it("skips requests when prompt is shorter than 20 characters or setting is disabled", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({ context: "unused", count: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const enabled = semanticInjectionSettings({ CLAUDE_MEM_SEMANTIC_INJECT: "true" });
    expect(await fetchSemanticForPrompt("too short", "/repo", enabled, "opencode")).toBe("");
    expect(callCount).toBe(0);

    const disabled = semanticInjectionSettings({});
    expect(
      await fetchSemanticForPrompt("This prompt is definitely long enough to trigger", "/repo", disabled, "opencode"),
    ).toBe("");
    expect(callCount).toBe(0);
  });
});

describe("core semantic context cache and lifecycle", () => {
  const originalFetch = globalThis.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), "claude-mem-semantic-core-"));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    writeFileSync(
      join(tempDataDir, "settings.json"),
      JSON.stringify({ CLAUDE_MEM_SEMANTIC_INJECT: "true" }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  function stubSemanticFetch(handler: (query: string, callIndex: number) => Response | Promise<Response>) {
    const queries: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { q?: string };
      const query = body.q ?? "";
      queries.push(query);
      return handler(query, queries.length);
    }) as unknown as typeof fetch;
    return { queries };
  }

  it("replaces prompt A with prompt B in the same session, even when A failed inside the 60 s window", async () => {
    const { queries } = stubSemanticFetch((query, index) => {
      if (index === 1) return new Response("fail", { status: 500 });
      return new Response(
        JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### ${query}`, count: 1 }),
        { status: 200 },
      );
    });

    const core = createCore({ directory: "/repo" });
    core.primeSemanticContext("s-replace", "First long prompt that fails on worker lookup");
    expect(await core.semanticContext("s-replace")).toBe("");

    core.primeSemanticContext("s-replace", "Second long prompt on a different topic");
    const second = await core.semanticContext("s-replace");
    expect(second).toContain("## Relevant Past Work (semantic match)");
    expect(second).toContain("Second long prompt on a different topic");
    expect(queries).toHaveLength(2);
  });

  it("clears any stale semantic block when a subsequent prompt is shorter than 20 characters", async () => {
    const { queries } = stubSemanticFetch((query) =>
      new Response(JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### ${query}`, count: 1 }), {
        status: 200,
      }),
    );

    const core = createCore({ directory: "/repo" });
    core.primeSemanticContext("s-short", "Initial long prompt that populates the cache");
    expect(await core.semanticContext("s-short")).toContain("## Relevant Past Work (semantic match)");

    core.primeSemanticContext("s-short", "ok");
    expect(await core.semanticContext("s-short")).toBe("");
    expect(queries).toHaveLength(1);
  });

  it("reuses the cached semantic block across consecutive semanticContext calls without extra requests", async () => {
    const { queries } = stubSemanticFetch(() =>
      new Response(JSON.stringify({ context: "## Relevant Past Work (semantic match)\n\n### Cached", count: 1 }), {
        status: 200,
      }),
    );

    const core = createCore({ directory: "/repo" });
    core.primeSemanticContext("s-reuse", "Prompt long enough to be cached for this turn");
    expect(await core.semanticContext("s-reuse")).toContain("### Cached");
    expect(await core.semanticContext("s-reuse")).toContain("### Cached");
    expect(queries).toHaveLength(1);
  });

  it("clears cached semantic context via forgetSemanticContext, forgetMemoryContext, and forgetSession", async () => {
    const { queries } = stubSemanticFetch((_q, index) =>
      new Response(JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### Turn ${index}`, count: 1 }), {
        status: 200,
      }),
    );

    const core = createCore({ directory: "/repo" });
    const prompt = "Prompt long enough to test cache clearing methods";

    core.primeSemanticContext("s-forget", prompt);
    expect(await core.semanticContext("s-forget")).toContain("### Turn 1");
    core.forgetSemanticContext("s-forget");
    expect(await core.semanticContext("s-forget")).toBe("");

    core.primeSemanticContext("s-forget", prompt);
    expect(await core.semanticContext("s-forget")).toContain("### Turn 2");
    core.forgetMemoryContext("s-forget");
    expect(await core.semanticContext("s-forget")).toBe("");

    core.primeSemanticContext("s-forget", prompt);
    expect(await core.semanticContext("s-forget")).toContain("### Turn 3");
    core.forgetSession("s-forget");
    expect(await core.semanticContext("s-forget")).toBe("");
    expect(queries).toHaveLength(3);
  });

  it("caches a failed lookup for 60 s and refetches only when primed again after the window", async () => {
    const { queries } = stubSemanticFetch((_q, index) => {
      if (index === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ context: "## Relevant Past Work (semantic match)\n\n### Recovered", count: 1 }), {
        status: 200,
      });
    });

    const core = createCore({ directory: "/repo" });
    const prompt = "Prompt long enough to exercise the failure retry window";

    core.primeSemanticContext("s-window", prompt);
    expect(await core.semanticContext("s-window")).toBe("");
    expect(await core.semanticContext("s-window")).toBe("");
    core.primeSemanticContext("s-window", prompt);
    expect(await core.semanticContext("s-window")).toBe("");
    expect(queries).toHaveLength(1);

    setSystemTime(Date.now() + 60_001);
    expect(await core.semanticContext("s-window")).toBe("");
    expect(queries).toHaveLength(1);

    core.primeSemanticContext("s-window", prompt);
    expect(await core.semanticContext("s-window")).toContain("### Recovered");
    expect(queries).toHaveLength(2);
  });

  it("strips private tags before checking length, caching, or querying, and clears stale cache if nothing remains", async () => {
    const { queries } = stubSemanticFetch((query) =>
      new Response(JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### ${query}`, count: 1 }), {
        status: 200,
      }),
    );

    const core = createCore({ directory: "/repo" });
    core.primeSemanticContext(
      "s-private",
      "Public context question long enough <private>secret token 12345</private>",
    );
    const first = await core.semanticContext("s-private");
    expect(first).toContain("Public context question long enough");
    expect(queries).toEqual(["Public context question long enough"]);

    core.primeSemanticContext("s-private", "<private>only private secret text here that is long</private>");
    expect(await core.semanticContext("s-private")).toBe("");
    expect(queries).toHaveLength(1);
  });

  it("refetches when the same prompt is primed on a subsequent user turn after a successful lookup", async () => {
    const { queries } = stubSemanticFetch((_q, index) =>
      new Response(JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### Turn ${index}`, count: 1 }), {
        status: 200,
      }),
    );

    const core = createCore({ directory: "/repo" });
    const prompt = "Repeated question across two turns in the same session";

    core.primeSemanticContext("s-repeat", prompt);
    expect(await core.semanticContext("s-repeat")).toContain("### Turn 1");
    expect(await core.semanticContext("s-repeat")).toContain("### Turn 1");
    expect(queries).toHaveLength(1);

    core.primeSemanticContext("s-repeat", prompt);
    expect(await core.semanticContext("s-repeat")).toContain("### Turn 2");
    expect(queries).toHaveLength(2);
  });

  it("evicts the oldest cached entry when exceeding 1000 sessions", async () => {
    const { queries } = stubSemanticFetch((query) =>
      new Response(JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### ${query}`, count: 1 }), {
        status: 200,
      }),
    );

    const core = createCore({ directory: "/repo" });
    for (let i = 0; i < 1005; i++) {
      core.primeSemanticContext(`s-evict-${i}`, `Prompt number ${i} long enough for eviction test`);
    }
    expect(await core.semanticContext("s-evict-0")).toBe("");
    expect(await core.semanticContext("s-evict-1004")).toContain("Prompt number 1004");
    expect(queries).toHaveLength(1005);
  });
});

describe("V1 adapter per-prompt semantic injection", () => {
  const originalFetch = globalThis.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), "claude-mem-semantic-v1-"));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    writeFileSync(
      join(tempDataDir, "settings.json"),
      JSON.stringify({ CLAUDE_MEM_SEMANTIC_INJECT: "true" }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  function stubV1Worker() {
    let semanticCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/context/semantic")) {
        semanticCalls++;
        return new Response(
          JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### Match ${semanticCalls}`, count: 1 }),
          { status: 200 },
        );
      }
      if (url.includes("/api/context/inject")) {
        return new Response("Recency context block", { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    return { getSemanticCalls: () => semanticCalls };
  }

  it("injects semantic block alongside recency context on system.transform when enabled", async () => {
    const tracker = stubV1Worker();
    const hooks = createV1Hooks({ directory: "/repo-v1" });

    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-s1" },
      parts: [{ type: "text", text: "Prompt long enough to trigger V1 semantic recall" }],
    });

    const out = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-s1" }, out);

    expect(out.system[0]).toBe("base");
    expect(out.system).toContain("Recency context block");
    expect(out.system.some((entry) => entry.includes("## Relevant Past Work (semantic match)"))).toBe(true);
    expect(tracker.getSemanticCalls()).toBe(1);
  });

  it("skips semantic requests and injection when disabled", async () => {
    writeFileSync(join(tempDataDir, "settings.json"), JSON.stringify({ CLAUDE_MEM_SEMANTIC_INJECT: "false" }));
    const tracker = stubV1Worker();
    const hooks = createV1Hooks({ directory: "/repo-v1-off" });

    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-s2" },
      parts: [{ type: "text", text: "Prompt long enough even though setting is off" }],
    });

    const out = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-s2" }, out);

    expect(out.system).toEqual(["base", "Recency context block"]);
    expect(tracker.getSemanticCalls()).toBe(0);
  });

  it("skips semantic injection when sessionID is absent on system.transform", async () => {
    const tracker = stubV1Worker();
    const hooks = createV1Hooks({ directory: "/repo-v1-nosid" });

    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-s3" },
      parts: [{ type: "text", text: "Prompt primed for session v1-s3 only" }],
    });

    const out = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({}, out);

    expect(out.system.some((entry) => entry.includes("## Relevant Past Work (semantic match)"))).toBe(false);
    expect(tracker.getSemanticCalls()).toBe(1);
  });

  it("clears cached semantic block on compaction and session.deleted, and refetches on next prompt", async () => {
    const tracker = stubV1Worker();
    const hooks = createV1Hooks({ directory: "/repo-v1-clear" });

    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-s4" },
      parts: [{ type: "text", text: "First prompt before compaction clears the cache" }],
    });
    const out1 = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-s4" }, out1);
    expect(out1.system.some((entry) => entry.includes("### Match 1"))).toBe(true);

    await hooks["experimental.session.compacting"]({ sessionID: "v1-s4" });
    const outAfterCompact = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-s4" }, outAfterCompact);
    expect(outAfterCompact.system.some((entry) => entry.includes("## Relevant Past Work"))).toBe(false);
    expect(tracker.getSemanticCalls()).toBe(1);

    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-s4" },
      parts: [{ type: "text", text: "Second prompt after compaction primes fresh recall" }],
    });
    const out2 = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-s4" }, out2);
    expect(out2.system.some((entry) => entry.includes("### Match 2"))).toBe(true);
    expect(tracker.getSemanticCalls()).toBe(2);

    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "v1-s4" } } });
    const outAfterDelete = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-s4" }, outAfterDelete);
    expect(outAfterDelete.system.some((entry) => entry.includes("## Relevant Past Work"))).toBe(false);
    expect(tracker.getSemanticCalls()).toBe(2);

    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-s4" },
      parts: [{ type: "text", text: "Third prompt after deletion primes fresh recall" }],
    });
    const out3 = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-s4" }, out3);
    expect(out3.system.some((entry) => entry.includes("### Match 3"))).toBe(true);
    expect(tracker.getSemanticCalls()).toBe(3);
  });

  it("clears previous semantic block on an image-only / empty-text user turn without calling init or semantic", async () => {
    let initCalls = 0;
    let semanticCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/sessions/init")) {
        initCalls++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/context/semantic")) {
        semanticCalls++;
        return new Response(
          JSON.stringify({ context: "## Relevant Past Work (semantic match)\n\n### Prior", count: 1 }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const hooks = createV1Hooks({ directory: "/repo-v1-img" });
    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-img" },
      parts: [{ type: "text", text: "Prompt long enough to populate semantic context" }],
    });
    const out1 = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-img" }, out1);
    expect(out1.system.some((entry) => entry.includes("### Prior"))).toBe(true);
    expect(initCalls).toBe(1);
    expect(semanticCalls).toBe(1);

    await hooks["chat.message"]({}, {
      message: { role: "user", sessionID: "v1-img" },
      parts: [{ type: "image" as unknown as "text" }],
    });
    const out2 = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "v1-img" }, out2);
    expect(out2.system.some((entry) => entry.includes("## Relevant Past Work"))).toBe(false);
    expect(initCalls).toBe(1);
    expect(semanticCalls).toBe(1);
  });
});

describe("V2 adapter per-prompt semantic injection", () => {
  const originalFetch = globalThis.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), "claude-mem-semantic-v2-"));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    writeFileSync(
      join(tempDataDir, "settings.json"),
      JSON.stringify({ CLAUDE_MEM_SEMANTIC_INJECT: "true" }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  function createRecordingV2Host() {
    const sessionHooks = new Map<string, (event: unknown) => Promise<void> | void>();
    let emitBusEvent: ((event: V2BusEvent) => void) | undefined;

    const context: OpenCodePluginContextV2 = {
      directory: "",
      location: { directory: "/repo-v2" },
      session: {
        hook: async (name, callback) => {
          sessionHooks.set(name, callback as (event: unknown) => Promise<void> | void);
          return { dispose: async () => {} };
        },
      },
      event: {
        subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
          [Symbol.asyncIterator]: () => {
            const queue: V2BusEvent[] = [];
            let waiter: ((res: IteratorResult<V2BusEvent>) => void) | undefined;
            emitBusEvent = (event) => {
              if (waiter) {
                const resolve = waiter;
                waiter = undefined;
                resolve({ done: false, value: event });
              } else {
                queue.push(event);
              }
            };
            return {
              next: () => {
                if (signal?.aborted) return Promise.resolve({ done: true, value: undefined });
                const nextEvent = queue.shift();
                if (nextEvent) return Promise.resolve({ done: false, value: nextEvent });
                return new Promise<IteratorResult<V2BusEvent>>((resolve) => {
                  waiter = resolve;
                  signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
                });
              },
            };
          },
        }),
      },
    };

    return { context, sessionHooks, emitBus: (event: V2BusEvent) => emitBusEvent?.(event) };
  }

  it("injects recency and semantic blocks in one tagged part, avoids stacking, and clears on compaction/delete", async () => {
    let semanticCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/context/semantic")) {
        semanticCalls++;
        return new Response(
          JSON.stringify({ context: `## Relevant Past Work (semantic match)\n\n### V2 Match ${semanticCalls}`, count: 1 }),
          { status: 200 },
        );
      }
      if (url.includes("/api/context/inject")) {
        return new Response("V2 recency context", { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const host = createRecordingV2Host();
    const cleanup = await setupV2(host.context, { resubscribeDelayMs: 5 });
    try {
      const promptHook = host.sessionHooks.get("prompt")!;
      const contextHook = host.sessionHooks.get("context")!;
      const compactionHook = host.sessionHooks.get("compaction")!;

      await promptHook({ sessionID: "v2-s1", prompt: { text: "Prompt long enough to prime V2 semantic recall" } });
      const system: Array<{ type: string; text?: string }> = [{ type: "text", text: "base" }];
      await contextHook({ sessionID: "v2-s1", system });
      await contextHook({ sessionID: "v2-s1", system });

      expect(system).toHaveLength(2);
      expect(system[1].text).toContain("V2 recency context");
      expect(system[1].text).toContain("## Relevant Past Work (semantic match)");
      expect(system[1].text).toContain("### V2 Match 1");
      expect(semanticCalls).toBe(1);

      await compactionHook({ sessionID: "v2-s1" });
      await contextHook({ sessionID: "v2-s1", system });
      expect(system[1].text).not.toContain("## Relevant Past Work (semantic match)");
      expect(semanticCalls).toBe(1);

      await promptHook({ sessionID: "v2-s1", prompt: { text: "Second V2 prompt after compaction primes fresh recall" } });
      await contextHook({ sessionID: "v2-s1", system });
      expect(system[1].text).toContain("### V2 Match 2");
      expect(semanticCalls).toBe(2);

      host.emitBus({ type: "session.deleted", data: { sessionID: "v2-s1" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await contextHook({ sessionID: "v2-s1", system });
      expect(system[1].text).not.toContain("## Relevant Past Work (semantic match)");
      expect(semanticCalls).toBe(2);

      await promptHook({ sessionID: "v2-s1", prompt: { text: "Third V2 prompt after deletion primes fresh recall" } });
      await contextHook({ sessionID: "v2-s1", system });
      expect(system[1].text).toContain("### V2 Match 3");
      expect(semanticCalls).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("clears semantic block on image-only user turn and removes stale tagged part when both recency and semantic are empty", async () => {
    let semanticCalls = 0;
    let initCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/sessions/init")) {
        initCalls++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/context/semantic")) {
        semanticCalls++;
        return new Response(
          JSON.stringify({ context: "## Relevant Past Work (semantic match)\n\n### Semantic Only", count: 1 }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const host = createRecordingV2Host();
    const cleanup = await setupV2(host.context, { resubscribeDelayMs: 5 });
    try {
      const promptHook = host.sessionHooks.get("prompt")!;
      const contextHook = host.sessionHooks.get("context")!;

      await promptHook({ sessionID: "v2-img", prompt: { text: "Prompt long enough for semantic-only V2 block" } });
      const system: Array<{ type: string; text?: string }> = [{ type: "text", text: "base" }];
      await contextHook({ sessionID: "v2-img", system });
      expect(system).toHaveLength(2);
      expect(system[1].text).toContain("### Semantic Only");

      await promptHook({ sessionID: "v2-img", prompt: { text: "" } });
      await contextHook({ sessionID: "v2-img", system });
      expect(system).toEqual([{ type: "text", text: "base" }]);
      expect(initCalls).toBe(1);
      expect(semanticCalls).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
