import { describe, it, expect, mock, beforeAll } from "bun:test";
import { ClaudeMemPlugin } from "../src/index";
import { WorkerClient } from "../src/worker-client";

// Mock the WorkerClient methods
mock.module("../src/worker-client", () => {
  return {
    WorkerClient: {
      isHealthy: mock(() => Promise.resolve(true)),
      ensureRunning: mock(() => Promise.resolve(true)),
      sessionInit: mock(() => Promise.resolve({ sessionDbId: 1, promptNumber: 1 })),
      sendObservation: mock(() => Promise.resolve()),
      summarize: mock(() => Promise.resolve()),
      completeSession: mock(() => Promise.resolve()),
      search: mock(() => Promise.resolve("Found some memory")),
    },
  };
});

describe("ClaudeMemPlugin", () => {
  let pluginInstance: any;
  const mockContext: any = {
    project: { name: "test-project", path: "/tmp/test" },
    client: {},
    $: {},
  };

  beforeAll(async () => {
    pluginInstance = await ClaudeMemPlugin(mockContext);
  });

  it("should register hooks", () => {
    expect(pluginInstance["session.created"]).toBeDefined();
    expect(pluginInstance["tool.execute.before"]).toBeDefined();
    expect(pluginInstance["tool.execute.after"]).toBeDefined();
    expect(pluginInstance["session.idle"]).toBeDefined();
    expect(pluginInstance["tool"]).toBeDefined();
    expect(pluginInstance["tool"]["mem-search"]).toBeDefined();
  });

  it("should initialize session on session.created", async () => {
    const mockSession = { id: "sess-123", messages: [] };
    await pluginInstance["session.created"](mockSession);

    // Verify WorkerClient.sessionInit was called
    expect(WorkerClient.sessionInit).toHaveBeenCalled();
  });

  it("should send observation on tool.execute.after", async () => {
    // Setup session first
    await pluginInstance["session.created"]({ id: "sess-123", messages: [] });

    const callID = "call-123";
    const toolArgs = { path: "foo.txt" };

    // Simulate before hook to store args
    // Corrected signature match: input, args
    const inputBefore = { tool: "readFile", sessionID: "sess-123", callID };
    const argsBefore = { args: toolArgs };
    await pluginInstance["tool.execute.before"](inputBefore, argsBefore);

    const inputAfter = { tool: "readFile", sessionID: "sess-123", callID };
    const output = { title: "Read File", output: "content", metadata: {} };

    await pluginInstance["tool.execute.after"](inputAfter, output);

    expect(WorkerClient.sendObservation).toHaveBeenCalledWith(
      "sess-123",
      "readFile",
      toolArgs,
      "content",
      "/tmp/test"
    );
  });

  it("should execute mem-search tool", async () => {
    const result = await pluginInstance["tool"]["mem-search"].execute({ query: "bugs" });
    expect(result).toBe("Found some memory");
    expect(WorkerClient.search).toHaveBeenCalledWith("bugs", "test-project");
  });
});
