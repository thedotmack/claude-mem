import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import claudeMemPlugin from "./index.js";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function createMockApi(pluginConfigOverride: Record<string, any> = {}) {
  const logs: string[] = [];
  const sentMessages: Array<{ to: string; text: string; channel: string; opts?: any }> = [];

  let registeredService: any = null;
  const registeredCommands: Map<string, any> = new Map();
  const eventHandlers: Map<string, Function[]> = new Map();

  const api = {
    id: "claude-mem",
    name: "Claude-Mem (Persistent Memory)",
    version: "1.0.0",
    source: "/test/extensions/claude-mem/dist/index.js",
    config: {},
    pluginConfig: pluginConfigOverride,
    logger: {
      info: (message: string) => { logs.push(message); },
      warn: (message: string) => { logs.push(message); },
      error: (message: string) => { logs.push(message); },
      debug: (message: string) => { logs.push(message); },
    },
    registerService: (service: any) => {
      registeredService = service;
    },
    registerCommand: (command: any) => {
      registeredCommands.set(command.name, command);
    },
    on: (event: string, callback: Function) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(callback);
    },
    runtime: {
      channel: {
        telegram: {
          sendMessageTelegram: async (to: string, text: string) => {
            sentMessages.push({ to, text, channel: "telegram" });
          },
        },
        discord: {
          sendMessageDiscord: async (to: string, text: string) => {
            sentMessages.push({ to, text, channel: "discord" });
          },
        },
        signal: {
          sendMessageSignal: async (to: string, text: string) => {
            sentMessages.push({ to, text, channel: "signal" });
          },
        },
        slack: {
          sendMessageSlack: async (to: string, text: string) => {
            sentMessages.push({ to, text, channel: "slack" });
          },
        },
        whatsapp: {
          sendMessageWhatsApp: async (to: string, text: string, opts?: { verbose: boolean }) => {
            sentMessages.push({ to, text, channel: "whatsapp", opts });
          },
        },
        line: {
          sendMessageLine: async (to: string, text: string) => {
            sentMessages.push({ to, text, channel: "line" });
          },
        },
      },
    },
  };

  return {
    api: api as any,
    logs,
    sentMessages,
    getService: () => registeredService,
    getCommand: (name?: string) => {
      if (name) return registeredCommands.get(name);
      return registeredCommands.get("claude_mem_feed");
    },
    getEventHandlers: (event: string) => eventHandlers.get(event) || [],
    fireEvent: async (event: string, data: any, ctx: any = {}) => {
      const handlers = eventHandlers.get(event) || [];
      let lastResult: any;
      for (const handler of handlers) {
        lastResult = await handler(data, ctx);
      }
      return lastResult;
    },
  };
}

describe("claudeMemPlugin", () => {
  it("registers the service without a transcript transform", () => {
    const { api, getService, getEventHandlers } = createMockApi();
    claudeMemPlugin(api);
    assert.equal(getService().id, "claude-mem-observation-feed");
    assert.equal(getEventHandlers("tool_result_persist").length, 0, "transcript transforms must not duplicate completed observations");
  });

  describe("service start", () => {
    for (const [label, config, message] of [
      ["feed not enabled", {}, "feed disabled"],
      ["enabled is false", { observationFeed: { enabled: false } }, "feed disabled"],
      ["channel is missing", { observationFeed: { enabled: true, to: "123" } }, "misconfigured"],
      ["to is missing", { observationFeed: { enabled: true, channel: "telegram" } }, "misconfigured"],
    ] as const) {
      it(`logs when ${label}`, async () => {
        const { api, logs, getService } = createMockApi(config);
        claudeMemPlugin(api);
        await getService().start({});
        assert.ok(logs.some((line) => line.includes(message)));
      });
    }
  });

  describe("service stop", () => {
    it("logs disconnection on stop", async () => {
      const { api, logs, getService } = createMockApi({});
      claudeMemPlugin(api);

      await getService().stop({});
      assert.ok(logs.some((l) => l.includes("feed stopped")));
    });
  });

  describe("command handler", () => {
    it("returns not configured when no feedConfig", async () => {
      const { api, getCommand } = createMockApi({});
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_feed", config: {} });
      assert.ok(result.text.includes("not configured"));
    });

    it("returns status when no args", async () => {
      const { api, getCommand } = createMockApi({
        observationFeed: { enabled: true, channel: "telegram", to: "123" },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_feed", config: {} });
      assert.ok(result.text.includes("Enabled: yes"));
      assert.ok(result.text.includes("Channel: telegram"));
      assert.ok(result.text.includes("Target: 123"));
      assert.ok(result.text.includes("Connection: disconnected"));
    });

  });
});

describe("Observation I/O event handlers", () => {
  let workerServer: Server;
  let workerPort: number;
  let receivedRequests: Array<{ method: string; url: string; body: any }> = [];

  function startWorkerMock(): Promise<number> {
    return new Promise((resolve) => {
      workerServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk.toString(); });
        req.on("end", () => {
          let parsedBody: any = null;
          try { parsedBody = JSON.parse(body); } catch {}

          receivedRequests.push({
            method: req.method || "GET",
            url: req.url || "/",
            body: parsedBody,
          });

          if (req.url === "/api/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          if (req.url === "/api/sessions/init") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessionDbId: 1, promptNumber: 1, skipped: false }));
            return;
          }

          if (req.url === "/api/sessions/observations") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "queued" }));
            return;
          }

          if (req.url === "/api/sessions/summarize") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "queued" }));
            return;
          }

          if (req.url?.startsWith("/api/context/inject")) {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("# Claude-Mem Context\n\n## Timeline\n- Session 1: Did some work");
            return;
          }

          // The worker answers these routes in the MCP tool shape.
          if (req.url?.startsWith("/api/search/observations")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ content: [{ type: "text", text: "| #12 | Fix JWT refresh |" }] }));
            return;
          }

          if (req.url?.startsWith("/api/context/recent")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ content: [{ type: "text", text: "## Session S4: Added token rotation" }] }));
            return;
          }

          if (req.url?.startsWith("/api/timeline/by-query")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ content: [{ type: "text", text: "Anchor #12: Fix JWT refresh" }] }));
            return;
          }

          if (req.url === "/stream") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            return;
          }

          res.writeHead(404);
          res.end();
        });
      });
      workerServer.listen(0, () => {
        const address = workerServer.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        }
      });
    });
  }

  beforeEach(async () => {
    receivedRequests = [];
    workerPort = await startWorkerMock();
  });

  afterEach(() => {
    workerServer?.close();
  });

  it("session_start sends session init to worker", async () => {
    const { api, logs, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", {
      sessionId: "test-session-1",
    }, { sessionKey: "agent-1" });

    const initRequests = receivedRequests.filter((r) => r.url === "/api/sessions/init");
    assert.equal(initRequests.length, 1, "should init once on session_start");
    const initRequest = initRequests[0];
    assert.ok(initRequest, "should send init request to worker");
    assert.equal(initRequest!.body.project, "openclaw");
    assert.ok(initRequest!.body.contentSessionId.startsWith("openclaw-agent-1-"));
    assert.ok(logs.some((l) => l.includes("Session initialized")));
  });

  it("after_compaction re-inits session on worker", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("after_compaction", { messageCount: 5, compactedCount: 3 }, {});

    const initRequests = receivedRequests.filter((r) => r.url === "/api/sessions/init");
    assert.equal(initRequests.length, 1, "should re-init after compaction");
  });

  it("after_tool_call skips memory_ tools", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("after_tool_call", {
      toolName: "memory_search",
      params: {},
    }, {});

    await fireEvent("after_tool_call", { toolName: "Read", params: {}, result: "sentinel" }, {});
    await waitFor(() => receivedRequests.some((r) => r.body?.tool_response === "sentinel"));
    const observations = receivedRequests.filter((r) => r.url === "/api/sessions/observations");
    assert.equal(observations.length, 1, "should skip memory_ tools");
    assert.equal(observations[0].body.tool_name, "Read");
  });

  for (const [toolName, params, result] of [
    ["Bash", { command: "ls" }, { content: [{ type: "text", text: "x".repeat(2000) }] }],
    ["custom_tool", { owned: true }, "x".repeat(2000)],
  ] as const) {
    it(`after_tool_call truncates ${toolName} responses`, async () => {
      const { api, fireEvent } = createMockApi({ workerPort });
      claudeMemPlugin(api);
      await fireEvent("after_tool_call", { toolName, params, result }, { sessionKey: "long-result" });
      await waitFor(() => receivedRequests.some((r) => r.url === "/api/sessions/observations"));
      const request = receivedRequests.find((r) => r.url === "/api/sessions/observations")!;
      assert.equal(request.body.tool_response, "x".repeat(1000));
      assert.equal(request.body.tool_name, toolName);
      assert.deepEqual(request.body.tool_input, params);
    });
  }

  for (const [label, result, expected] of [
    ["a private span crossing the cap", `${"a".repeat(990)}<private>${"SECRET".repeat(20)}</private>tail`, `${"a".repeat(990)}tail`],
    ["an unclosed private span", `${"a".repeat(990)}<private>${"SECRET".repeat(20)}`, "a".repeat(990)],
    ["nested private spans", "before<private>SECRET<private>INNER</private>SECRET</private>after", "beforeafter"],
    ["private content in text blocks", { content: [{ type: "text", text: "before<private>SECRET</private>after" }] }, "beforeafter"],
  ] as const) {
    it(`after_tool_call removes ${label} before truncating`, async () => {
      const { api, fireEvent } = createMockApi({ workerPort });
      claudeMemPlugin(api);
      await fireEvent("after_tool_call", { toolName: "read", result }, { sessionKey: "private-result" });
      await waitFor(() => receivedRequests.some((r) => r.url === "/api/sessions/observations"));
      const request = receivedRequests.find((r) => r.url === "/api/sessions/observations")!;
      assert.equal(request.body.tool_response, expected);
    });
  }

  it("after_tool_call keeps a failed call's error text", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);
    await fireEvent("after_tool_call", {
      toolName: "read", params: { path: "/x" }, error: "ENOENT: no such file",
    }, { sessionKey: "failed-read" });
    await waitFor(() => receivedRequests.some((r) => r.url === "/api/sessions/observations"));
    const request = receivedRequests.find((r) => r.url === "/api/sessions/observations");
    assert.ok(request);
    assert.equal(request.body.tool_name, "Read");
    assert.match(request.body.tool_response, /ENOENT: no such file/);
  });

  it("after_tool_call records a call from a host build that omits params", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);
    await fireEvent("after_tool_call", { toolName: "read", result: "contents" }, { sessionKey: "no-params" });
    await waitFor(() => receivedRequests.some((r) => r.url === "/api/sessions/observations"));
    const request = receivedRequests.find((r) => r.url === "/api/sessions/observations");
    assert.ok(request);
    assert.deepEqual(request.body.tool_input, {});
    assert.equal(request.body.tool_response, "contents");
  });

  it("agent_end sends summarize and complete to worker", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "summarize-test" });

    await fireEvent("agent_end", {
      messages: [
        { role: "user", content: "help me" },
        { role: "assistant", content: "Here is the solution..." },
      ],
    }, { sessionKey: "summarize-test" });

    const summarizeRequest = receivedRequests.find((r) => r.url === "/api/sessions/summarize");
    assert.ok(summarizeRequest, "should send summarize to worker");
    assert.equal(summarizeRequest!.body.last_assistant_message, "Here is the solution...");
    assert.ok(summarizeRequest!.body.contentSessionId.startsWith("openclaw-summarize-test-"));

    const completeRequest = receivedRequests.find((r) => r.url === "/api/sessions/complete");
    assert.ok(!completeRequest, "should not send complete (worker self-completes)");
  });

  it("agent_end extracts text from array content", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "array-content" });

    await fireEvent("agent_end", {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        },
      ],
    }, { sessionKey: "array-content" });

    const summarizeRequest = receivedRequests.find((r) => r.url === "/api/sessions/summarize");
    assert.ok(summarizeRequest, "should send summarize");
    assert.equal(summarizeRequest!.body.last_assistant_message, "First part\nSecond part");
  });

  it("uses custom project name from config", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, project: "my-project" });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, {});

    const initRequest = receivedRequests.find((r) => r.url === "/api/sessions/init");
    assert.ok(initRequest, "should send init");
    assert.equal(initRequest!.body.project, "my-project");
  });

  it("stamps platformSource openclaw on session init, observation and summarize posts", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "source-test" });
    await fireEvent("after_tool_call", {
      toolName: "Read",
      params: { file_path: "/src/index.ts" },
      result: { content: [{ type: "text", text: "contents" }] },
    }, { sessionKey: "source-test" });
    await fireEvent("agent_end", {
      messages: [{ role: "assistant", content: "done" }],
    }, { sessionKey: "source-test" });

    await waitFor(() => receivedRequests.some((r) => r.url === "/api/sessions/observations"));
    for (const url of ["/api/sessions/init", "/api/sessions/observations", "/api/sessions/summarize"]) {
      const request = receivedRequests.find((r) => r.url === url);
      assert.ok(request, `should send ${url}`);
      assert.equal(request!.body.platformSource, "openclaw", url);
    }
  });

  it("claude_mem_status command reports worker health", async () => {
    const { api, getCommand } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    const statusCmd = getCommand("claude_mem_status");
    assert.ok(statusCmd, "status command should exist");

    const result = await statusCmd.handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_status", config: {} });
    assert.ok(result.text.includes("Status: ok"));
    assert.ok(result.text.includes(`Port: ${workerPort}`));
  });

  it("search, recent and timeline commands render the worker's text result", async () => {
    const { api, getCommand } = createMockApi({ workerPort });
    claudeMemPlugin(api);
    const ctx = (args: string) => ({ args, channel: "telegram", isAuthorizedSender: true, commandBody: "", config: {} });

    const search = await getCommand("claude-mem-search").handler(ctx("jwt"));
    assert.ok(search.includes("| #12 | Fix JWT refresh |"), search);
    assert.ok(!search.includes("No results found."), search);

    const recent = await getCommand("claude-mem-recent").handler(ctx(""));
    assert.ok(recent.includes("## Session S4: Added token rotation"), recent);

    const timeline = await getCommand("claude-mem-timeline").handler(ctx("jwt"));
    assert.ok(timeline.includes("Anchor #12: Fix JWT refresh"), timeline);
  });

  it("claude-mem-search keeps a one-word numeric query and reads a trailing number as the limit", async () => {
    const { api, getCommand } = createMockApi({ workerPort });
    claudeMemPlugin(api);
    const ctx = (args: string) => ({ args, channel: "telegram", isAuthorizedSender: true, commandBody: "", config: {} });
    const searched = () => receivedRequests.filter((r) => r.url.startsWith("/api/search/observations")).at(-1)!.url;

    const result = await getCommand("claude-mem-search").handler(ctx("4019"));
    assert.equal(searched(), "/api/search/observations?query=4019&limit=10");
    assert.ok(result.startsWith('Claude-Mem Search: "4019"'), result);

    await getCommand("claude-mem-search").handler(ctx("port 4019 3"));
    assert.equal(searched(), "/api/search/observations?query=port%204019&limit=3");
  });

  it("claude_mem_status reports unreachable when worker is down", async () => {
    const { api, getCommand } = createMockApi({ workerPort: await unusedPort() });
    claudeMemPlugin(api);

    const statusCmd = getCommand("claude_mem_status");
    const result = await statusCmd.handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_status", config: {} });
    assert.ok(result.text.includes("unreachable"));
  });

  it("reuses same contentSessionId for same sessionKey", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "reuse-test" });

    await fireEvent("after_tool_call", {
      toolName: "Read",
      params: { file_path: "/src/index.ts" },
      result: { content: [{ type: "text", text: "contents" }] },
    }, { sessionKey: "reuse-test" });

    const initRequest = receivedRequests.find((r) => r.url === "/api/sessions/init");
    await waitFor(() => receivedRequests.some((r) => r.url === "/api/sessions/observations"));
    const obsRequest = receivedRequests.find((r) => r.url === "/api/sessions/observations");
    assert.ok(initRequest && obsRequest, "both requests should exist");
    assert.equal(
      initRequest!.body.contentSessionId,
      obsRequest!.body.contentSessionId,
      "should reuse contentSessionId for same sessionKey"
    );
  });
});

describe("before_prompt_build context injection", () => {
  let workerServer: Server;
  let workerPort: number;
  let receivedRequests: Array<{ method: string; url: string; body: any }> = [];
  let contextResponse = "# Claude-Mem Context\n\n## Timeline\n- Session 1: Did some work";

  function startWorkerMock(): Promise<number> {
    return new Promise((resolve) => {
      workerServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk.toString(); });
        req.on("end", () => {
          let parsedBody: any = null;
          try { parsedBody = JSON.parse(body); } catch {}

          receivedRequests.push({
            method: req.method || "GET",
            url: req.url || "/",
            body: parsedBody,
          });

          if (req.url?.startsWith("/api/context/inject")) {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(contextResponse);
            return;
          }

          if (req.url === "/api/sessions/init") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessionDbId: 1, promptNumber: 1, skipped: false }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        });
      });
      workerServer.listen(0, () => {
        const address = workerServer.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        }
      });
    });
  }

  beforeEach(async () => {
    receivedRequests = [];
    contextResponse = "# Claude-Mem Context\n\n## Timeline\n- Session 1: Did some work";
    workerPort = await startWorkerMock();
  });

  afterEach(async () => {
    workerServer?.close();
  });

  it("does not write MEMORY.md or fetch context during capture", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "claude-mem-test-"));
    try {
      const { api, fireEvent } = createMockApi({ workerPort });
      claudeMemPlugin(api);
      const ctx = { sessionKey: "tool-sync", workspaceDir: tmpDir };
      await fireEvent("before_agent_start", { prompt: "Help me write a function" }, ctx);
      await assert.rejects(readFile(join(tmpDir, "MEMORY.md"), "utf-8"), { code: "ENOENT" });
      await fireEvent("after_tool_call", {
        toolName: "Read", params: { file_path: "/src/app.ts" },
        result: { content: [{ type: "text", text: "file contents" }] },
      }, ctx);
      await waitFor(() => receivedRequests.some((r) => r.url === "/api/sessions/observations"));
      assert.equal(receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject")).length, 0);
      await assert.rejects(readFile(join(tmpDir, "MEMORY.md"), "utf-8"), { code: "ENOENT" });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips context injection when syncMemoryFile is false", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, syncMemoryFile: false });
    claudeMemPlugin(api);

    const result = await fireEvent("before_prompt_build", {
      prompt: "Help me write a function",
      messages: [],
    }, { agentId: "main" });

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(!contextRequest, "should not fetch context when injection disabled");
    assert.equal(result, undefined, "should return undefined when injection disabled");
  });

  it("injects context only for non-excluded agents", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, syncMemoryFileExclude: ["snarf"] });
    claudeMemPlugin(api);
    const excluded = await fireEvent("before_prompt_build", { prompt: "Help me", messages: [] }, { agentId: "snarf" });
    assert.equal(excluded, undefined, "should return undefined for excluded agent");
    assert.ok(!receivedRequests.some((r) => r.url?.startsWith("/api/context/inject")));
    const included = await fireEvent("before_prompt_build", { prompt: "Help me", messages: [] }, { agentId: "main" });
    assert.ok(included?.appendSystemContext, "should inject context for non-excluded agent");
  });

  it("returns undefined when context is empty", async () => {
    contextResponse = "   ";
    const { api, logs, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    const result = await fireEvent("before_prompt_build", {
      prompt: "Help me write a function",
      messages: [],
    }, { agentId: "main" });

    assert.equal(result, undefined, "should return undefined for empty context");
    assert.ok(!logs.some((l) => l.includes("Context injected")), "should not log injection for empty context");
  });

  it("uses custom project name in context inject URL", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, project: "my-bot" });
    claudeMemPlugin(api);

    await fireEvent("before_prompt_build", {
      prompt: "Help me write a function",
      messages: [],
    }, { agentId: "main" });

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(contextRequest, "should request context");
    assert.ok(contextRequest!.url!.includes("projects=my-bot"), "should use custom project name");
  });

  it("includes agent-scoped project in context request", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("before_prompt_build", {
      prompt: "Help me",
      messages: [],
    }, { agentId: "debugger" });

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(contextRequest, "should request context");
    const url = decodeURIComponent(contextRequest!.url!);
    assert.ok(url.includes("openclaw,openclaw-debugger"), "should include both base and agent-scoped projects");
  });
});

describe("SSE stream integration", () => {
  let server: Server;
  let serverPort: number;
  let serverResponses: ServerResponse[] = [];
  let services: any[] = [];

  function startSSEServer(): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url !== "/stream") {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        serverResponses.push(res);
      });
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        }
      });
    });
  }

  beforeEach(async () => {
    serverResponses = [];
    services = [];
    serverPort = await startSSEServer();
  });

  afterEach(async () => {
    for (const service of services) await service.stop({});
    for (const res of serverResponses) {
      try {
        res.end();
      } catch {}
    }
    server?.close();
  });

  it("connects to SSE stream and receives new_observation events", async () => {
    const { api, logs, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "telegram", to: "12345" },
    });
    claudeMemPlugin(api);
    services.push(getService());

    await getService().start({});
    await waitFor(() => serverResponses.length === 1);

    assert.ok(logs.some((l) => l.includes("Connecting to SSE stream")));

    const observation = {
      type: "new_observation",
      observation: {
        id: 1,
        title: "Test Observation",
        subtitle: "Found something interesting",
        type: "discovery",
        project: "test",
        prompt_number: 1,
        narrative: "Discovery observations should keep routine feed messages compact.",
        facts: JSON.stringify(["Routine detail should not be shown"]),
        concepts: JSON.stringify(["compact-feed"]),
        created_at_epoch: Date.now(),
      },
      timestamp: Date.now(),
    };

    for (const res of serverResponses) {
      res.write(`data: ${JSON.stringify(observation)}\n\n`);
    }

    await waitFor(() => sentMessages.length === 1);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].channel, "telegram");
    assert.equal(sentMessages[0].to, "12345");
    assert.ok(sentMessages[0].text.includes("Test Observation"));
    assert.ok(sentMessages[0].text.includes("Found something interesting"));
    assert.ok(!sentMessages[0].text.includes("Narrative"));
    assert.ok(!sentMessages[0].text.includes("Routine detail should not be shown"));
    assert.ok(!sentMessages[0].text.includes("compact-feed"));
    assert.ok(sentMessages[0].text.length <= 900);

  });

  it("keeps important feed messages more complete", async () => {
    const { api, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "telegram", to: "12345" },
    });
    claudeMemPlugin(api);
    services.push(getService());

    await getService().start({});
    await waitFor(() => serverResponses.length === 1);

    for (const res of serverResponses) {
      res.write(
        `data: ${JSON.stringify({
          type: "new_observation",
          observation: {
            id: 2,
            title: "Important Bugfix",
            subtitle: "Fixed a regression",
            type: "bugfix",
            project: "test",
            prompt_number: 1,
            narrative: "This fuller context should stay visible for important feed messages.",
            facts: JSON.stringify([
              "Important fact one is preserved",
              "Important fact two is preserved",
              "Important fact three is preserved",
            ]),
            concepts: JSON.stringify(["important-feed"]),
            created_at_epoch: Date.now(),
          },
          timestamp: Date.now(),
        })}\n\n`
      );
    }

    await waitFor(() => sentMessages.length === 1);

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes("Narrative"));
    assert.ok(sentMessages[0].text.includes("This fuller context should stay visible"));
    assert.ok(sentMessages[0].text.includes("Important fact three is preserved"));
    assert.ok(sentMessages[0].text.includes("Concepts: important-feed"));
    assert.ok(sentMessages[0].text.length <= 2200);

  });

  it("filters out non-observation events", async () => {
    const { api, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "discord", to: "channel-id" },
    });
    claudeMemPlugin(api);
    services.push(getService());

    await getService().start({});
    await waitFor(() => serverResponses.length === 1);

    for (const res of serverResponses) {
      res.write(`data: ${JSON.stringify({ type: "processing_status", isProcessing: true })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "session_started", sessionId: "abc" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "new_observation", observation: { id: 99, title: "Sentinel" } })}\n\n`);
    }

    await waitFor(() => sentMessages.length === 1);
    assert.equal(sentMessages.length, 1, "only the sentinel observation should be delivered");
    assert.ok(sentMessages[0].text.includes("Sentinel"));

  });

  it("handles observations with null titles and subtitles", async () => {
    const { api, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "telegram", to: "999" },
    });
    claudeMemPlugin(api);
    services.push(getService());
    await getService().start({});
    await waitFor(() => serverResponses.length === 1);
    for (const observation of [
      { id: 2, title: "No Subtitle", subtitle: null },
      { id: 3, title: null, subtitle: "Has subtitle" },
    ]) {
      serverResponses[0].write(`data: ${JSON.stringify({ type: "new_observation", observation, timestamp: Date.now() })}\n\n`);
    }
    await waitFor(() => sentMessages.length === 2);
    assert.equal(sentMessages.length, 2);
    assert.ok(sentMessages[0].text.includes("No Subtitle"));
    assert.ok(!sentMessages[0].text.includes("null"));
    assert.ok(sentMessages[1].text.includes("Untitled"));
  });

  it("logs unknown channel type", async () => {
    const { api, logs, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "matrix", to: "room-id" },
    });
    claudeMemPlugin(api);
    services.push(getService());

    await getService().start({});
    await waitFor(() => serverResponses.length === 1);

    for (const res of serverResponses) {
      res.write(
        `data: ${JSON.stringify({
          type: "new_observation",
          observation: { id: 4, title: "Test", subtitle: null },
          timestamp: Date.now(),
        })}\n\n`
      );
    }

    await waitFor(() => logs.some((line) => line.includes("Unsupported channel type: matrix")));
    assert.equal(sentMessages.length, 0);
    assert.ok(logs.some((l) => l.includes("Unsupported channel type: matrix")));

  });
});

describe("circuit breaker", () => {
  beforeEach(async () => {
    const { api, fireEvent } = createMockApi({ workerPort: await unusedPort() });
    claudeMemPlugin(api);
    await fireEvent("gateway_start", {}, {});
  });

  it("counts requests through open, reset and half-open states", async () => {
    let hits = 0;
    let status = 500;
    let hold = false;
    const held: ServerResponse[] = [];
    const server = createServer((_req, res) => {
      hits++;
      if (hold) held.push(res);
      else {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { api, fireEvent } = createMockApi({ workerPort: (server.address() as { port: number }).port });
    claudeMemPlugin(api);
    const realDateNow = Date.now;
    let now = realDateNow();
    Date.now = () => now;
    const pending: Promise<unknown>[] = [];
    let call = 0;
    const send = () => fireEvent("before_agent_start", { prompt: "probe" }, { sessionKey: `breaker-${call++}` });
    try {
      for (let i = 0; i < 3; i++) await send();
      assert.equal(hits, 3);
      await send();
      assert.equal(hits, 3, "open circuit must suppress network requests");

      await fireEvent("gateway_start", {}, {});
      for (let i = 0; i < 3; i++) await send();
      assert.equal(hits, 6, "gateway_start must admit requests again");

      now += 31_000;
      hold = true;
      const probe = send();
      pending.push(probe);
      await waitFor(() => hits === 7);
      let suppressedFinished = false;
      const suppressed = send().then(() => { suppressedFinished = true; });
      pending.push(suppressed);
      await waitFor(() => suppressedFinished);
      assert.equal(hits, 7, "half-open state must admit only the in-flight probe");
      held.shift()!.writeHead(500).end("{}");
      await probe;
      await send();
      assert.equal(hits, 7, "failed probe must reopen the circuit");

      hold = false;
      status = 200;
      now += 31_000;
      await send();
      assert.equal(hits, 8, "cooldown must admit a new probe");
      await send();
      assert.equal(hits, 9, "successful probe must close the circuit");
    } finally {
      Date.now = realDateNow;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(pending);
    }
  });

  it("logs individual failures while circuit is closed, then disabling when it opens", async () => {
    const { api, logs, fireEvent } = createMockApi({ workerPort: await unusedPort() });
    claudeMemPlugin(api);
    await fireEvent("gateway_start", {}, {});
    const logsAfterReset = logs.length;

    for (let i = 0; i < 3; i++) {
      await fireEvent("before_agent_start", { prompt: "hello" }, { sessionKey: `cb-log-${i}` });
    }

    const newLogs = logs.slice(logsAfterReset);
    assert.ok(newLogs.length > 0, "threshold calls should produce log output");
    const disablingLogs = newLogs.filter((l) => l.includes("disabling requests"));
    assert.equal(disablingLogs.length, 1, "should emit exactly one disabling warning when circuit opens");
    const failureLogs = newLogs.filter((l) => l.includes("failed:"));
    assert.ok(failureLogs.length < 3, "threshold-crossing call should not log an individual failure");
  });

});
