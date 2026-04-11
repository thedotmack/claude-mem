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
  it("registers service, commands, and event handlers on load", () => {
    const { api, logs, getService, getCommand, getEventHandlers } = createMockApi();
    claudeMemPlugin(api);

    assert.ok(getService(), "service should be registered");
    assert.equal(getService().id, "claude-mem-observation-feed");
    assert.ok(getCommand("claude_mem_feed"), "feed command should be registered");
    assert.ok(getCommand("claude_mem_status"), "status command should be registered");
    assert.ok(getEventHandlers("session_start").length > 0, "session_start handler registered");
    assert.ok(getEventHandlers("after_compaction").length > 0, "after_compaction handler registered");
    assert.ok(getEventHandlers("before_agent_start").length > 0, "before_agent_start handler registered");
    assert.ok(getEventHandlers("before_prompt_build").length > 0, "before_prompt_build handler registered");
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
      assert.ok(result.text.includes("Connection:"));
    });

    it("handles 'on' argument", async () => {
      const { api, logs, getCommand } = createMockApi({
        observationFeed: { enabled: false },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "on", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_feed on", config: {} });
      assert.ok(result.text.includes("enable requested"));
      assert.ok(logs.some((l) => l.includes("enable requested")));
    });

    it("handles 'off' argument", async () => {
      const { api, logs, getCommand } = createMockApi({
        observationFeed: { enabled: true },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "off", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_feed off", config: {} });
      assert.ok(result.text.includes("disable requested"));
      assert.ok(logs.some((l) => l.includes("disable requested")));
    });

    it("shows connection state in status output", async () => {
      const { api, getCommand } = createMockApi({
        observationFeed: { enabled: false, channel: "slack", to: "#general" },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler({ args: "", channel: "slack", isAuthorizedSender: true, commandBody: "/claude_mem_feed", config: {} });
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

  it("before_agent_start calls init for session privacy check", async () => {
    const { api, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    await fireEvent("before_agent_start", { prompt: "hello" }, {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const initRequests = receivedRequests.filter((r) => r.url === "/api/sessions/init");
    assert.equal(initRequests.length, 1, "before_agent_start should init session");
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

  it("claude_mem_status command reports worker health", async () => {
    const { api, getCommand } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    const statusCmd = getCommand("claude_mem_status");
    assert.ok(statusCmd, "status command should exist");

    const result = await statusCmd.handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_status", config: {} });
    assert.ok(result.text.includes("Status: ok"));
    assert.ok(result.text.includes(`Port: ${workerPort}`));
  });

  it("claude_mem_status reports unreachable when worker is down", async () => {
    workerServer.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { api, getCommand } = createMockApi({ workerPort: 59999 });
    claudeMemPlugin(api);

    const statusCmd = getCommand("claude_mem_status");
    const result = await statusCmd.handler({ args: "", channel: "telegram", isAuthorizedSender: true, commandBody: "/claude_mem_status", config: {} });
    assert.ok(result.text.includes("unreachable"));
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

  it("returns appendSystemContext from before_prompt_build", async () => {
    const { api, logs, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    const result = await fireEvent("before_prompt_build", {
      prompt: "Help me write a function",
      messages: [],
    }, { agentId: "main" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(contextRequest, "should request context from worker");
    assert.ok(contextRequest!.url!.includes("projects=openclaw"));

    assert.ok(result, "should return a result");
    assert.ok(result.appendSystemContext, "should return appendSystemContext");
    assert.ok(result.appendSystemContext.includes("Claude-Mem Context"), "should contain context");
    assert.ok(result.appendSystemContext.includes("Session 1"), "should contain timeline");
    assert.ok(logs.some((l) => l.includes("Context injected via system prompt")));
  });

  it("does not write MEMORY.md on before_agent_start", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "claude-mem-test-"));
    try {
      const { api, fireEvent } = createMockApi({ workerPort });
      claudeMemPlugin(api);

      await fireEvent("before_agent_start", {
        prompt: "Help me write a function",
      }, { sessionKey: "sync-test", workspaceDir: tmpDir });

      await new Promise((resolve) => setTimeout(resolve, 200));

      let memoryExists = true;
      try {
        await readFile(join(tmpDir, "MEMORY.md"), "utf-8");
      } catch {
        memoryExists = false;
      }
      assert.ok(!memoryExists, "MEMORY.md should not be created by before_agent_start");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not sync MEMORY.md on tool_result_persist", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "claude-mem-test-"));
    try {
      const { api, fireEvent } = createMockApi({ workerPort });
      claudeMemPlugin(api);

      await fireEvent("before_agent_start", {
        prompt: "Help me write a function",
      }, { sessionKey: "tool-sync", workspaceDir: tmpDir });

      await new Promise((resolve) => setTimeout(resolve, 200));

      await fireEvent("tool_result_persist", {
        toolName: "Read",
        params: { file_path: "/src/app.ts" },
        message: { content: [{ type: "text", text: "file contents" }] },
      }, { sessionKey: "tool-sync" });

      await new Promise((resolve) => setTimeout(resolve, 200));

      const contextRequests = receivedRequests.filter((r) => r.url?.startsWith("/api/context/inject"));
      assert.equal(contextRequests.length, 0, "tool_result_persist should not fetch context");

      let memoryExists = true;
      try {
        await readFile(join(tmpDir, "MEMORY.md"), "utf-8");
      } catch {
        memoryExists = false;
      }
      assert.ok(!memoryExists, "MEMORY.md should not be written by tool_result_persist");
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

    await new Promise((resolve) => setTimeout(resolve, 200));

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(!contextRequest, "should not fetch context when injection disabled");
    assert.equal(result, undefined, "should return undefined when injection disabled");
  });

  it("skips context injection for excluded agents", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, syncMemoryFileExclude: ["snarf"] });
    claudeMemPlugin(api);

    const result = await fireEvent("before_prompt_build", {
      prompt: "Help me",
      messages: [],
    }, { agentId: "snarf" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const contextRequest = receivedRequests.find((r) => r.url?.startsWith("/api/context/inject"));
    assert.ok(!contextRequest, "should not fetch context for excluded agent");
    assert.equal(result, undefined, "should return undefined for excluded agent");
  });

  it("injects context for non-excluded agents", async () => {
    const { api, fireEvent } = createMockApi({ workerPort, syncMemoryFileExclude: ["snarf"] });
    claudeMemPlugin(api);

    const result = await fireEvent("before_prompt_build", {
      prompt: "Help me",
      messages: [],
    }, { agentId: "main" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(result, "should return a result for non-excluded agent");
    assert.ok(result.appendSystemContext, "should inject context for non-excluded agent");
  });

  it("returns undefined when context is empty", async () => {
    contextResponse = "   ";
    const { api, logs, fireEvent } = createMockApi({ workerPort });
    claudeMemPlugin(api);

    const result = await fireEvent("before_prompt_build", {
      prompt: "Help me write a function",
      messages: [],
    }, { agentId: "main" });

    await new Promise((resolve) => setTimeout(resolve, 200));

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

    await new Promise((resolve) => setTimeout(resolve, 200));

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

    await new Promise((resolve) => setTimeout(resolve, 200));

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

describe("circuit breaker", () => {
  // Reset circuit breaker state before each test by firing gateway_start.
  // The circuit is module-level state, so tests would otherwise bleed into each other.
  beforeEach(async () => {
    const { api, fireEvent } = createMockApi({ workerPort: 59999 });
    claudeMemPlugin(api);
    await fireEvent("gateway_start", {}, {});
  });

  it("opens after threshold failures and stops further requests", async () => {
    const { api, logs, fireEvent } = createMockApi({ workerPort: 59999 });
    claudeMemPlugin(api);
    // Reset circuit inside the test body to guard against timers from preceding
    // tests (e.g. completionDelayMs timers) that may fire between beforeEach and here.
    await fireEvent("gateway_start", {}, {});

    // Fire threshold+1 calls so the circuit is open by the end of the loop
    // regardless of whether a concurrent timer fires at the exact boundary.
    for (let i = 0; i < 4; i++) {
      await fireEvent("before_agent_start", { prompt: "hello" }, { sessionKey: `cb-open-${i}` });
    }

    // Circuit is now OPEN. Subsequent calls must be silently dropped.
    const logCountBeforeDrop = logs.length;
    await fireEvent("before_agent_start", { prompt: "hello" }, { sessionKey: "cb-drop" });
    const noisyDropLogs = logs.slice(logCountBeforeDrop).filter(
      (l) => l.includes("failed") || l.includes("disabling")
    );
    assert.equal(noisyDropLogs.length, 0, "calls when circuit is open should be silently dropped");
  });

  it("logs individual failures while circuit is closed, then disabling when it opens", async () => {
    const { api, logs, fireEvent } = createMockApi({ workerPort: 59999 });
    claudeMemPlugin(api);
    await fireEvent("gateway_start", {}, {});
    const logsAfterReset = logs.length;

    // Fire exactly threshold (3) calls
    for (let i = 0; i < 3; i++) {
      await fireEvent("before_agent_start", { prompt: "hello" }, { sessionKey: `cb-log-${i}` });
    }

    const newLogs = logs.slice(logsAfterReset);
    // At least some failures should have been logged (circuit was active)
    assert.ok(newLogs.length > 0, "threshold calls should produce log output");
    // Exactly one disabling warning should appear
    const disablingLogs = newLogs.filter((l) => l.includes("disabling requests"));
    assert.equal(disablingLogs.length, 1, "should emit exactly one disabling warning when circuit opens");
    // The last call (the threshold-crossing one) should NOT log an individual failure
    const failureLogs = newLogs.filter((l) => l.includes("failed:"));
    assert.ok(failureLogs.length < 3, "threshold-crossing call should not log an individual failure");
  });

  it("resets on gateway_start, allowing connections again", async () => {
    const { api, logs, fireEvent } = createMockApi({ workerPort: 59999 });
    claudeMemPlugin(api);
    await fireEvent("gateway_start", {}, {});

    // Open the circuit by firing threshold+1 calls
    for (let i = 0; i < 4; i++) {
      await fireEvent("before_agent_start", { prompt: "hello" }, { sessionKey: `cb-reset-${i}` });
    }

    // Confirm circuit is open (call is silently dropped)
    const logCountWhileOpen = logs.length;
    await fireEvent("before_agent_start", { prompt: "hello" }, { sessionKey: "cb-while-open" });
    assert.equal(
      logs.slice(logCountWhileOpen).filter((l) => l.includes("failed") || l.includes("disabling")).length,
      0,
      "call while circuit is open should be silently dropped"
    );

    // gateway_start resets the circuit
    await fireEvent("gateway_start", {}, {});

    // Next call should attempt to connect again (not silently drop)
    const logCountAfterReset = logs.length;
    await fireEvent("before_agent_start", { prompt: "hello" }, { sessionKey: "cb-after-reset" });
    const newLogs = logs.slice(logCountAfterReset);
    assert.ok(
      newLogs.some((l) => l.includes("failed:") || l.includes("disabling")),
      "should attempt worker connection after gateway_start reset"
    );
  });

  it("HALF_OPEN allows only a single probe — non-2xx keeps circuit open, 2xx closes it", async () => {
    // ---- Phase 1: open the circuit via network failures (unreachable port) ----
    // Reset circuit state first
    const resetMock = createMockApi({ workerPort: 59999 });
    claudeMemPlugin(resetMock.api);
    await resetMock.fireEvent("gateway_start", {}, {});

    // Drive 4 failures to ensure circuit is OPEN
    for (let i = 0; i < 4; i++) {
      await resetMock.fireEvent("before_agent_start", { prompt: "probe-test" }, { sessionKey: `probe-phase1-${i}` });
    }

    // ---- Phase 2: advance clock so cooldown has elapsed ----
    // _circuitOpenedAt was set during Phase 1 using the real Date.now().
    // Advancing Date.now by 31s means the next circuitAllow call sees the cooldown elapsed.
    const realDateNow = Date.now.bind(Date);
    Date.now = () => realDateNow() + 31_000;

    try {
      // ---- Phase 3: non-2xx probe — circuit should stay OPEN ----
      // Start a server that returns 500 for all requests
      let serverA: Server | null = null;
      const portA: number = await new Promise((resolve) => {
        serverA = createServer((_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(500);
          res.end();
        });
        serverA!.listen(0, () => {
          const addr = serverA!.address();
          resolve((addr as any).port);
        });
      });

      // Reuse the same module-level circuit state — just change the worker port.
      // Create a new mock api instance pointed at server A (500 responder).
      const mockA = createMockApi({ workerPort: portA });
      claudeMemPlugin(mockA.api);
      // Do NOT fire gateway_start here — we want the OPEN circuit state from Phase 1.

      // The circuit is OPEN but the mocked clock says cooldown elapsed.
      // The next call should: transition to HALF_OPEN, set _halfOpenProbeInFlight=true,
      // send the probe to server A (which returns 500), then call circuitOnFailure
      // and re-open the circuit.
      const logCountAtProbe = mockA.logs.length;
      await mockA.fireEvent("before_agent_start", { prompt: "probe" }, { sessionKey: "probe-call-non2xx" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const probeALogs = mockA.logs.slice(logCountAtProbe);
      // After a 500 response, circuitOnFailure is called which logs "disabling requests"
      // (because state was HALF_OPEN) and logger.warn logs the 500 status.
      assert.ok(
        probeALogs.some((l) => l.includes("disabling") || l.includes("returned 500") || l.includes("Worker POST")),
        "non-2xx probe should keep circuit open (expected disabling or 500 status log)"
      );

      // Verify probe flag resets: a second call with cooldown elapsed should be allowed as a new probe
      // (i.e., _halfOpenProbeInFlight was cleared by circuitOnFailure).
      // But without advancing time further the circuit is OPEN again — so calls are dropped.
      const logCountAfterFailedProbe = mockA.logs.length;
      await mockA.fireEvent("before_agent_start", { prompt: "probe" }, { sessionKey: "probe-concurrent" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const droppedLogs = mockA.logs.slice(logCountAfterFailedProbe).filter(
        (l) => l.includes("failed") || l.includes("disabling")
      );
      assert.equal(droppedLogs.length, 0, "call should be silently dropped while circuit is OPEN again after failed probe");

      serverA!.close();

      // ---- Phase 4: 2xx probe — circuit should close ----
      // Re-open the circuit with fresh failures, then probe with a 200-returning server.
      // Reset circuit state first.
      const resetMock2 = createMockApi({ workerPort: 59999 });
      claudeMemPlugin(resetMock2.api);
      await resetMock2.fireEvent("gateway_start", {}, {});

      // Drive failures (still using mocked Date.now, but _circuitOpenedAt will be set to
      // the mocked time, so cooldown is NOT elapsed yet from the mocked perspective).
      // We need to temporarily restore real Date.now while opening the circuit, then
      // re-mock it for the probe.
      Date.now = realDateNow;
      for (let i = 0; i < 4; i++) {
        await resetMock2.fireEvent("before_agent_start", { prompt: "probe-test" }, { sessionKey: `probe-phase4-${i}` });
      }
      // Re-advance the clock past cooldown
      Date.now = () => realDateNow() + 31_000;

      let serverB: Server | null = null;
      const portB: number = await new Promise((resolve) => {
        serverB = createServer((_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessionDbId: 1, promptNumber: 1, skipped: false }));
        });
        serverB!.listen(0, () => {
          const addr = serverB!.address();
          resolve((addr as any).port);
        });
      });

      const mockB = createMockApi({ workerPort: portB });
      claudeMemPlugin(mockB.api);
      // Do NOT fire gateway_start — reuse OPEN circuit state from resetMock2.

      const logCountBeforeSuccessProbe = mockB.logs.length;
      await mockB.fireEvent("before_agent_start", { prompt: "probe" }, { sessionKey: "probe-call-2xx" });
      await new Promise((resolve) => setTimeout(resolve, 150));

      const successProbeLogs = mockB.logs.slice(logCountBeforeSuccessProbe);
      assert.ok(
        successProbeLogs.some((l) => l.includes("restored") || l.includes("circuit closed")),
        "2xx probe should close the circuit — expected 'restored' or 'circuit closed' log"
      );

      serverB!.close();
    } finally {
      Date.now = realDateNow;
    }
  });
});
