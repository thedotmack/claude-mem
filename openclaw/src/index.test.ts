import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import claudeMemPlugin from "./index.js";

function createMockApi(configOverride: Record<string, any> = {}) {
  const logs: string[] = [];
  const sentMessages: Array<{ to: string; text: string; channel: string }> = [];

  let registeredService: any = null;
  let registeredCommand: any = null;

  const api = {
    getConfig: () => configOverride,
    log: (message: string) => {
      logs.push(message);
    },
    registerService: (service: any) => {
      registeredService = service;
    },
    registerCommand: (command: any) => {
      registeredCommand = command;
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
          sendMessageWhatsApp: async (to: string, text: string) => {
            sentMessages.push({ to, text, channel: "whatsapp" });
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
    getCommand: () => registeredCommand,
  };
}

describe("claudeMemPlugin", () => {
  it("registers service and command on load", () => {
    const { api, logs, getService, getCommand } = createMockApi();
    claudeMemPlugin(api);

    assert.ok(getService(), "service should be registered");
    assert.equal(getService().id, "claude-mem-observation-feed");
    assert.ok(getCommand(), "command should be registered");
    assert.equal(getCommand().name, "claude-mem-feed");
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

      const result = await getCommand().handler([], {});
      assert.ok(result.includes("not configured"));
    });

    it("returns status when no args", async () => {
      const { api, getCommand } = createMockApi({
        observationFeed: { enabled: true, channel: "telegram", to: "123" },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler([], {});
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

      const result = await getCommand().handler(["on"], {});
      assert.ok(result.includes("enable requested"));
      assert.ok(logs.some((l) => l.includes("enable requested")));
    });

    it("handles 'off' argument", async () => {
      const { api, logs, getCommand } = createMockApi({
        observationFeed: { enabled: true },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler(["off"], {});
      assert.ok(result.includes("disable requested"));
      assert.ok(logs.some((l) => l.includes("disable requested")));
    });

    it("shows connection state in status output", async () => {
      const { api, getCommand } = createMockApi({
        observationFeed: { enabled: false, channel: "slack", to: "#general" },
      });
      claudeMemPlugin(api);

      const result = await getCommand().handler([], {});
      assert.ok(result.includes("Connection: disconnected"));
    });
  });
});

describe("SSE stream integration", () => {
  let server: Server;
  let serverPort: number;
  let serverResponses: ServerResponse[] = [];

  function startSSEServer(): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
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

    assert.ok(logs.some((l) => l.includes(`localhost:${serverPort}`)));

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
    assert.ok(logs.some((l) => l.includes("Unknown channel type: matrix")));

    await getService().stop({});
  });
});
