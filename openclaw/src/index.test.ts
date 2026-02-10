import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import claudeMemPlugin from "./index.js";

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
      return registeredCommands.get("claude-mem-feed");
    },
    getEventHandlers: (event: string) => eventHandlers.get(event) || [],
    fireEvent: async (event: string, data: any, ctx: any = {}) => {
      const handlers = eventHandlers.get(event) || [];
      for (const handler of handlers) {
        await handler(data, ctx);
      }
    },
  };
}

describe("claudeMemPlugin", () => {
  it("registers service, commands, and event handlers on load", () => {
    const { api, logs, getService, getCommand, getEventHandlers } = createMockApi();
    claudeMemPlugin(api);

    assert.ok(getService(), "service should be registered");
    assert.equal(getService().id, "claude-mem-observation-feed");
    assert.ok(getCommand("claude-mem-feed"), "feed command should be registered");
    assert.ok(getCommand("claude-mem-status"), "status command should be registered");
    assert.ok(getEventHandlers("session_start").length > 0, "session_start handler registered");
    assert.ok(getEventHandlers("after_compaction").length > 0, "after_compaction handler registered");
    assert.ok(getEventHandlers("before_agent_start").length > 0, "before_agent_start handler registered");
    assert.ok(getEventHandlers("tool_result_persist").length > 0, "tool_result_persist handler registered");
    assert.ok(getEventHandlers("agent_end").length > 0, "agent_end handler registered");
    assert.ok(getEventHandlers("gateway_start").length > 0, "gateway_start handler registered");
    assert.ok(logs.some((l) => l.includes("plugin loaded")));
  });

  describe("service start", () => {
    it("logs disabled when feed not enabled", async () => {
      const { api, logs, getService } = createMockApi({});
      claudeMemPlugin(api);

      await getService().start({});
      assert.ok(logs.some((l) => l.includes("feed disabled")));
    });

    it("logs disabled when enabled is false", async () => {
      const { api, logs, getService } = createMockApi({
        observationFeed: { enabled: false },
      });
      claudeMemPlugin(api);

      await getService().start({});
      assert.ok(logs.some((l) => l.includes("feed disabled")));
    });

    it("logs misconfigured when channel is missing", async () => {
      const { api, logs, getService } = createMockApi({
        observationFeed: { enabled: true, to: "123" },
      });
      claudeMemPlugin(api);

      await getService().start({});
      assert.ok(logs.some((l) => l.includes("misconfigured")));
    });

    it("logs misconfigured when to is missing", async () => {
      const { api, logs, getService } = createMockApi({
        observationFeed: { enabled: true, channel: "telegram" },
      });
      claudeMemPlugin(api);

      await getService().start({});
      assert.ok(logs.some((l) => l.includes("misconfigured")));
    });
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

      const result = await getCommand().handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude-mem-feed", config: {} });
      assert.ok(result.includes("not configured"));
    });

    it("returns status when no args", async () => {
      const { api, getCommand } = createMockApi({
        observationFeed: { enabled: true, channel: "telegram", to: "123" },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude-mem-feed", config: {} });
      assert.ok(result.includes("Enabled: yes"));
      assert.ok(result.includes("Channel: telegram"));
      assert.ok(result.includes("Target: 123"));
      assert.ok(result.includes("Connection:"));
    });

    it("handles 'on' argument", async () => {
      const { api, logs, getCommand } = createMockApi({
        observationFeed: { enabled: false },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "on", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude-mem-feed on", config: {} });
      assert.ok(result.includes("enable requested"));
      assert.ok(logs.some((l) => l.includes("enable requested")));
    });

    it("handles 'off' argument", async () => {
      const { api, logs, getCommand } = createMockApi({
        observationFeed: { enabled: true },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "off", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude-mem-feed off", config: {} });
      assert.ok(result.includes("disable requested"));
      assert.ok(logs.some((l) => l.includes("disable requested")));
    });

    it("shows connection state in status output", async () => {
      const { api, getCommand } = createMockApi({
        observationFeed: { enabled: false, channel: "slack", to: "#general" },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "", channel: "slack", isAuthorizedSender: true, commandBody: "/claude-mem-feed", config: {} });
      assert.ok(result.includes("Connection: disconnected"));
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

          // Handle different endpoints
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

          if (req.url === "/api/sessions/complete") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "completed" }));
            return;
          }

          if (req.url?.startsWith("/api/context/inject")) {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("# Claude-Mem Context\n\n## Timeline\n- Session 1: Did some work");
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

    // Wait for HTTP request
    await new Promise((resolve) => setTimeout(resolve, 100));

    const initRequest = receivedRequests.find((r) => r.url === "/api/sessions/init");
    assert.ok(initRequest, "should send init request to worker");
    assert.equal(initRequest!.body.project, "openclaw");
    assert.ok(initRequest!.body.contentSessionId.startsWith("openclaw-agent-1-"));
    assert.ok(logs.some((l) => l.includes("Session initialized")));
  });

  it("session_start calls init on worker", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "test-session-1" }, {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const initRequests = receivedRequests.filter((r) => r.url === "/api/sessions/init");
    assert.equal(initRequests.length, 1, "should init on session_start");
  });

  it("after_compaction re-inits session on worker", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("after_compaction", { messageCount: 5, compactedCount: 3 }, {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const initRequests = receivedRequests.filter((r) => r.url === "/api/sessions/init");
    assert.equal(initRequests.length, 1, "should re-init after compaction");
  });

  it("before_agent_start does not call init", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", { prompt: "hello" }, {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const initRequests = receivedRequests.filter((r) => r.url === "/api/sessions/init");
    assert.equal(initRequests.length, 0, "before_agent_start should not init");
  });

  it("tool_result_persist sends observation to worker", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    // Establish contentSessionId via session_start
    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "test-agent" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Fire tool result event
    await fireEvent("tool_result_persist", {
      toolName: "Read",
      params: { file_path: "/src/index.ts" },
      message: {
        content: [{ type: "text", text: "file contents here..." }],
      },
    }, { sessionKey: "test-agent" });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const obsRequest = receivedRequests.find((r) => r.url === "/api/sessions/observations");
    assert.ok(obsRequest, "should send observation to worker");
    assert.equal(obsRequest!.body.tool_name, "Read");
    assert.deepEqual(obsRequest!.body.tool_input, { file_path: "/src/index.ts" });
    assert.equal(obsRequest!.body.tool_response, "file contents here...");
    assert.ok(obsRequest!.body.contentSessionId.startsWith("openclaw-test-agent-"));
  });

  it("tool_result_persist skips memory_ tools", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("tool_result_persist", {
      toolName: "memory_search",
      params: {},
    }, {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    const obsRequest = receivedRequests.find((r) => r.url === "/api/sessions/observations");
    assert.ok(!obsRequest, "should skip memory_ tools");
  });

  it("tool_result_persist truncates long responses", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    const longText = "x".repeat(2000);
    await fireEvent("tool_result_persist", {
      toolName: "Bash",
      params: { command: "ls" },
      message: {
        content: [{ type: "text", text: longText }],
      },
    }, {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    const obsRequest = receivedRequests.find((r) => r.url === "/api/sessions/observations");
    assert.ok(obsRequest, "should send observation");
    assert.equal(obsRequest!.body.tool_response.length, 1000, "should truncate to 1000 chars");
  });

  it("agent_end sends summarize and complete to worker", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    // Establish session
    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "summarize-test" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Fire agent end
    await fireEvent("agent_end", {
      messages: [
        { role: "user", content: "help me" },
        { role: "assistant", content: "Here is the solution..." },
      ],
    }, { sessionKey: "summarize-test" });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const summarizeRequest = receivedRequests.find((r) => r.url === "/api/sessions/summarize");
    assert.ok(summarizeRequest, "should send summarize to worker");
    assert.equal(summarizeRequest!.body.last_assistant_message, "Here is the solution...");
    assert.ok(summarizeRequest!.body.contentSessionId.startsWith("openclaw-summarize-test-"));

    const completeRequest = receivedRequests.find((r) => r.url === "/api/sessions/complete");
    assert.ok(completeRequest, "should send complete to worker");
    assert.ok(completeRequest!.body.contentSessionId.startsWith("openclaw-summarize-test-"));
  });

  it("agent_end extracts text from array content", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "array-content" });
    await new Promise((resolve) => setTimeout(resolve, 100));

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

    await new Promise((resolve) => setTimeout(resolve, 100));

    const summarizeRequest = receivedRequests.find((r) => r.url === "/api/sessions/summarize");
    assert.ok(summarizeRequest, "should send summarize");
    assert.equal(summarizeRequest!.body.last_assistant_message, "First part\nSecond part");
  });

  it("uses custom project name from config", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, project: "my-project" });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const initRequest = receivedRequests.find((r) => r.url === "/api/sessions/init");
    assert.ok(initRequest, "should send init");
    assert.equal(initRequest!.body.project, "my-project");
  });

  it("claude-mem-status command reports worker health", async () => {
    const { api, getCommand } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    const statusCmd = getCommand("claude-mem-status");
    assert.ok(statusCmd, "status command should exist");

    const result = await statusCmd.handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude-mem-status", config: {} });
    assert.ok(result.includes("Status: ok"));
    assert.ok(result.includes(`Port: ${workerPort}`));
  });

  it("claude-mem-status reports unreachable when worker is down", async () => {
    workerServer.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { api, getCommand } = createMockApi({ workerPort: 59999 });
    claudeMemPlugin(api);

    const statusCmd = getCommand("claude-mem-status");
    const result = await statusCmd.handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude-mem-status", config: {} });
    assert.ok(result.includes("unreachable"));
  });

  it("reuses same contentSessionId for same sessionKey", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("session_start", { sessionId: "s1" }, { sessionKey: "reuse-test" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await fireEvent("tool_result_persist", {
      toolName: "Read",
      params: { file_path: "/src/index.ts" },
      message: { content: [{ type: "text", text: "contents" }] },
    }, { sessionKey: "reuse-test" });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const initRequest = receivedRequests.find((r) => r.url === "/api/sessions/init");
    const obsRequest = receivedRequests.find((r) => r.url === "/api/sessions/observations");
    assert.ok(initRequest && obsRequest, "both requests should exist");
    assert.equal(
      initRequest!.body.contentSessionId,
      obsRequest!.body.contentSessionId,
      "should reuse contentSessionId for same sessionKey"
    );
  });
});

describe("MEMORY.md context sync", () => {
  let workerServer: Server;
  let workerPort: number;
  let receivedRequests: Array<{ method: string; url: string; body: any }> = [];
  let tmpDir: string;
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
    tmpDir = await mkdtemp(join(tmpdir(), "claude-mem-test-"));
  });

  afterEach(async () => {
    workerServer?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes MEMORY.md to workspace on before_agent_start", async () => {
    const { api, logs, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", {
      prompt: "Help me write a function",
    }, { sessionKey: "sync-test", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(contextRequest, "should request context from worker");
    assert.ok(contextRequest!.url!.includes("projects=openclaw"));

    const memoryContent = await readFile(join(tmpDir, "MEMORY.md"), "utf-8");
    assert.ok(memoryContent.includes("Claude-Mem Context"), "MEMORY.md should contain context");
    assert.ok(memoryContent.includes("Session 1"), "MEMORY.md should contain timeline");
    assert.ok(logs.some((l) => l.includes("MEMORY.md synced")));
  });

  it("syncs MEMORY.md on every before_agent_start call", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", {
      prompt: "First prompt for this agent",
    }, { sessionKey: "agent-a", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const firstContextRequests = receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject"));
    assert.equal(firstContextRequests.length, 1, "first call should fetch context");

    await fireEvent("before_agent_start", {
      prompt: "Second prompt for same agent",
    }, { sessionKey: "agent-a", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const allContextRequests = receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject"));
    assert.equal(allContextRequests.length, 2, "should re-fetch context on every call");
  });

  it("syncs MEMORY.md on tool_result_persist via fire-and-forget", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    // Init session to register workspace dir
    await fireEvent("before_agent_start", {
      prompt: "Help me write a function",
    }, { sessionKey: "tool-sync", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const preToolContextRequests = receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject"));
    assert.equal(preToolContextRequests.length, 1, "before_agent_start should sync once");

    // Fire tool result — should trigger another MEMORY.md sync
    await fireEvent("tool_result_persist", {
      toolName: "Read",
      params: { file_path: "/src/app.ts" },
      message: { content: [{ type: "text", text: "file contents" }] },
    }, { sessionKey: "tool-sync" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const postToolContextRequests = receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject"));
    assert.equal(postToolContextRequests.length, 2, "tool_result_persist should trigger another sync");

    const memoryContent = await readFile(join(tmpDir, "MEMORY.md"), "utf-8");
    assert.ok(memoryContent.includes("Claude-Mem Context"), "MEMORY.md should be updated");
  });

  it("skips MEMORY.md sync when syncMemoryFile is false", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, syncMemoryFile: false });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", {
      prompt: "Help me write a function",
    }, { sessionKey: "no-sync", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(!contextRequest, "should not fetch context when sync disabled");
  });

  it("skips MEMORY.md sync when no workspaceDir in context", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", {
      prompt: "Help me write a function",
    }, { sessionKey: "no-workspace" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(!contextRequest, "should not fetch context without workspaceDir");
  });

  it("skips writing MEMORY.md when context is empty", async () => {
    contextResponse = "   ";
    const { api, logs, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", {
      prompt: "Help me write a function",
    }, { sessionKey: "empty-ctx", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(!logs.some((l) => l.includes("MEMORY.md synced")), "should not log sync for empty context");
  });

  it("gateway_start resets sync tracking so next agent re-syncs", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    // First sync
    await fireEvent("before_agent_start", {
      prompt: "Help me write a function",
    }, { sessionKey: "agent-1", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const firstContextRequests = receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject"));
    assert.equal(firstContextRequests.length, 1);

    // Gateway restart
    await fireEvent("gateway_start", {}, {});

    // Second sync after gateway restart — same workspace should re-sync
    await fireEvent("before_agent_start", {
      prompt: "Help me after gateway restart",
    }, { sessionKey: "agent-1", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const allContextRequests = receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject"));
    assert.equal(allContextRequests.length, 2, "should re-fetch context after gateway restart");
  });

  it("uses custom project name in context inject URL", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, project: "my-bot" });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", {
      prompt: "Help me write a function",
    }, { sessionKey: "proj-test", workspaceDir: tmpDir });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(contextRequest, "should request context");
    assert.ok(contextRequest!.url!.includes("projects=my-bot"), "should use custom project name");
  });
});

describe("SSE stream integration", () => {
  let server: Server;
  let serverPort: number;
  let serverResponses: ServerResponse[] = [];

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
    serverPort = await startSSEServer();
  });

  afterEach(() => {
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

    await getService().start({});

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(logs.some((l) => l.includes("Connecting to SSE stream")));

    // Send an SSE event
    const observation = {
      type: "new_observation",
      observation: {
        id: 1,
        title: "Test Observation",
        subtitle: "Found something interesting",
        type: "discovery",
        project: "test",
        prompt_number: 1,
        created_at_epoch: Date.now(),
      },
      timestamp: Date.now(),
    };

    for (const res of serverResponses) {
      res.write(`data: ${JSON.stringify(observation)}\n\n`);
    }

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].channel, "telegram");
    assert.equal(sentMessages[0].to, "12345");
    assert.ok(sentMessages[0].text.includes("Test Observation"));
    assert.ok(sentMessages[0].text.includes("Found something interesting"));

    await getService().stop({});
  });

  it("filters out non-observation events", async () => {
    const { api, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "discord", to: "channel-id" },
    });
    claudeMemPlugin(api);

    await getService().start({});
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Send non-observation events
    for (const res of serverResponses) {
      res.write(`data: ${JSON.stringify({ type: "processing_status", isProcessing: true })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "session_started", sessionId: "abc" })}\n\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sentMessages.length, 0, "non-observation events should be filtered");

    await getService().stop({});
  });

  it("handles observation with null subtitle", async () => {
    const { api, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "telegram", to: "999" },
    });
    claudeMemPlugin(api);

    await getService().start({});
    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const res of serverResponses) {
      res.write(
        `data: ${JSON.stringify({
          type: "new_observation",
          observation: { id: 2, title: "No Subtitle", subtitle: null },
          timestamp: Date.now(),
        })}\n\n`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes("No Subtitle"));
    assert.ok(!sentMessages[0].text.includes("null"));

    await getService().stop({});
  });

  it("handles observation with null title", async () => {
    const { api, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "telegram", to: "999" },
    });
    claudeMemPlugin(api);

    await getService().start({});
    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const res of serverResponses) {
      res.write(
        `data: ${JSON.stringify({
          type: "new_observation",
          observation: { id: 3, title: null, subtitle: "Has subtitle" },
          timestamp: Date.now(),
        })}\n\n`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes("Untitled"));

    await getService().stop({});
  });

  it("uses custom workerPort from config", async () => {
    const { api, logs, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "telegram", to: "12345" },
    });
    claudeMemPlugin(api);

    await getService().start({});
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(logs.some((l) => l.includes(`127.0.0.1:${serverPort}`)));

    await getService().stop({});
  });

  it("logs unknown channel type", async () => {
    const { api, logs, sentMessages, getService } = createMockApi({
      workerPort: serverPort,
      observationFeed: { enabled: true, channel: "matrix", to: "room-id" },
    });
    claudeMemPlugin(api);

    await getService().start({});
    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const res of serverResponses) {
      res.write(
        `data: ${JSON.stringify({
          type: "new_observation",
          observation: { id: 4, title: "Test", subtitle: null },
          timestamp: Date.now(),
        })}\n\n`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sentMessages.length, 0);
    assert.ok(logs.some((l) => l.includes("Unsupported channel type: matrix")));

    await getService().stop({});
  });
});
