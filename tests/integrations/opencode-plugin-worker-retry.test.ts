import { describe, expect, it } from "bun:test";
import ClaudeMemPlugin from "../../src/integrations/opencode-plugin/index";
import * as pluginEntry from "../../src/integrations/opencode-plugin/index";
import { REFUSED_RETRY_DELAYS_MS, retryWhileRefused } from "../../src/integrations/opencode-plugin/worker-retry";

// #4091: OpenCode-only users have nothing that starts the worker before the
// first hooks fire; the MCP server OpenCode launches (#3621) starts it. A
// capture POST refused while it boots is retried in the background.

const pluginCtx = {
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

function refusal(): Error {
  return Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
    code: "ConnectionRefused",
  });
}

describe("retryWhileRefused", () => {
  it("stops at the first attempt that reaches the worker", async () => {
    let attempts = 0;
    await retryWhileRefused(async () => ++attempts < 3, [1, 1, 1, 1, 1]);
    expect(attempts).toBe(3);
  });

  it("gives up after its delays", async () => {
    let attempts = 0;
    await retryWhileRefused(async () => {
      attempts++;
      return true;
    }, [1, 1, 1]);
    expect(attempts).toBe(3);
  });

  it("spends about ten seconds in all", () => {
    const total = REFUSED_RETRY_DELAYS_MS.reduce((sum, delayMs) => sum + delayMs, 0);
    expect(total).toBeGreaterThanOrEqual(8_000);
    expect(total).toBeLessThanOrEqual(12_000);
  });
});

describe("OpenCode capture while the worker starts (#4091)", () => {
  it("does not hold the hook, and lands the observation once the worker answers", async () => {
    const originalFetch = globalThis.fetch;
    const delivered: string[] = [];
    let workerUp = false;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (!workerUp) throw refusal();
      delivered.push(new URL(String(url)).pathname);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin.server(pluginCtx);
      const startedAt = Date.now();
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_booting", callID: "c1", args: { path: "/a" } },
        { title: "Read", output: "file contents", metadata: {} },
      );
      expect(Date.now() - startedAt).toBeLessThan(REFUSED_RETRY_DELAYS_MS[0]);
      expect(delivered).toEqual([]);

      workerUp = true;
      await new Promise((resolve) => setTimeout(resolve, REFUSED_RETRY_DELAYS_MS[0] + 200));
      expect(delivered).toEqual(["/api/sessions/observations"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the entry module's only export the plugin definition", () => {
    expect(Object.keys(pluginEntry)).toEqual(["default"]);
    expect(typeof (ClaudeMemPlugin as unknown as Record<string, unknown>).server).toBe("function");
    expect(typeof (ClaudeMemPlugin as unknown as Record<string, unknown>).setup).toBe("function");
  });
});
