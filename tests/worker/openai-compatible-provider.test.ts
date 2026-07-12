import { describe, expect, it, spyOn } from "bun:test";
import {
  OpenAICompatibleProvider,
  type ProviderQueryResult,
} from "../../src/services/worker/OpenAICompatibleProvider.js";
import type { DatabaseManager } from "../../src/services/worker/DatabaseManager.js";
import type { SessionManager } from "../../src/services/worker/SessionManager.js";
import { ModeManager } from "../../src/services/domain/ModeManager.js";
import type {
  ActiveSession,
  ConversationMessage,
} from "../../src/services/worker-types.js";
import { logger } from "../../src/utils/logger.js";

interface TestConfig {
  apiKey: string;
  model: string;
}

class EmptyInitProvider extends OpenAICompatibleProvider<TestConfig> {
  protected readonly providerName = "TestProvider";
  protected readonly syntheticIdPrefix = "test";
  protected readonly forwardEmptyMessageResponse = false;

  protected getConfig(): TestConfig {
    return { apiKey: "test-key", model: "test-model" };
  }

  protected missingApiKeyError(): Error {
    return new Error("missing test key");
  }

  protected async query(
    _history: ConversationMessage[],
    _config: TestConfig,
  ): Promise<ProviderQueryResult> {
    return { content: "" };
  }

  protected estimateTokens(text: string): number {
    return text.length;
  }

  protected buildLastUsage(
    result: ProviderQueryResult,
  ): ActiveSession["lastUsage"] {
    return {
      input: result.inputTokens || 0,
      output: result.outputTokens || 0,
    };
  }
}

class ScriptedProvider extends OpenAICompatibleProvider<TestConfig> {
  protected readonly providerName = "TestProvider";
  protected readonly syntheticIdPrefix = "test";
  protected readonly forwardEmptyMessageResponse = true;
  readonly histories: ConversationMessage[][] = [];

  constructor(
    dbManager: DatabaseManager,
    sessionManager: SessionManager,
    private readonly responses: string[],
  ) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): TestConfig {
    return { apiKey: "test-key", model: "test-model" };
  }

  protected missingApiKeyError(): Error {
    return new Error("missing test key");
  }

  protected async query(
    history: ConversationMessage[],
    _config: TestConfig,
  ): Promise<ProviderQueryResult> {
    this.histories.push(history.map((message) => ({ ...message })));
    return { content: this.responses.shift() || "" };
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected buildLastUsage(): ActiveSession["lastUsage"] {
    return null;
  }
}

function createDbManager(): DatabaseManager {
  return {
    getSessionStore: () => ({
      ensureMemorySessionIdRegistered: () => {},
      storeObservations: () => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1_700_000_000_000,
      }),
    }),
    getChromaSync: () => null,
  } as unknown as DatabaseManager;
}

function activeModeSpy() {
  return spyOn(
    ModeManager.getInstance(),
    "getActiveMode",
  ).mockImplementation(() => ({
    observation_types: [],
    prompts: {},
  }) as ReturnType<ModeManager["getActiveMode"]>);
}

function createSession(): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: "content-1",
    memorySessionId: "memory-1",
    project: "test-project",
    platformSource: "opencode",
    userPrompt: "remember this",
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: "test",
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

describe("OpenAI-compatible provider initialization", () => {
  it("logs an allowed empty initialization response at debug severity", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const error = spyOn(logger, "error").mockImplementation(() => {});
    const success = spyOn(logger, "success").mockImplementation(() => {});
    const getActiveMode = activeModeSpy();
    const sessionManager = {
      getMessageIterator: async function* () {},
    } as unknown as SessionManager;
    const provider = new EmptyInitProvider(
      {} as DatabaseManager,
      sessionManager,
    );

    try {
      await provider.startSession(createSession());

      expect(debug).toHaveBeenCalledWith(
        "SDK",
        "Empty TestProvider init response - session may lack context",
        { sessionId: 1, model: "test-model" },
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      error.mockRestore();
      success.mockRestore();
      getActiveMode.mockRestore();
    }
  });

  it("stores a valid assistant response in history exactly once", async () => {
    const getActiveMode = activeModeSpy();
    const success = spyOn(logger, "success").mockImplementation(() => {});
    const sessionManager = {
      getMessageIterator: async function* () {},
      confirmClaimedMessages: async () => 0,
    } as unknown as SessionManager;
    const response = `<observation>
      <type>discovery</type>
      <title>Captured once</title>
      <facts></facts>
      <concepts></concepts>
      <files_read></files_read>
      <files_modified></files_modified>
    </observation>`;
    const provider = new ScriptedProvider(
      createDbManager(),
      sessionManager,
      [response],
    );
    const session = createSession();

    try {
      await provider.startSession(session);

      expect(session.conversationHistory).toHaveLength(2);
      expect(session.conversationHistory.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(session.conversationHistory[1].content).toBe(response);
    } finally {
      success.mockRestore();
      getActiveMode.mockRestore();
    }
  });

  it("bounds long observer sessions while retaining the initial and newest prompts", async () => {
    const getActiveMode = activeModeSpy();
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const success = spyOn(logger, "success").mockImplementation(() => {});
    const messages = Array.from({ length: 30 }, (_, index) => ({
      type: "observation" as const,
      tool_name: `tool-${index}`,
      tool_input: { index },
      tool_response: { result: index },
    }));
    const sessionManager = {
      getMessageIterator: async function* () {
        yield* messages;
      },
      confirmClaimedMessages: async () => 0,
    } as unknown as SessionManager;
    const provider = new ScriptedProvider(
      {} as DatabaseManager,
      sessionManager,
      Array.from({ length: messages.length + 1 }, () => ""),
    );
    const session = createSession();

    try {
      await provider.startSession(session);

      expect(Math.max(...provider.histories.map((history) => history.length))).toBeLessThanOrEqual(21);
      expect(session.conversationHistory).toHaveLength(21);
      expect(session.conversationHistory[0].content).toContain("remember this");
      expect(session.conversationHistory.at(-1)?.content).toContain("tool-29");
      expect(session.conversationHistory.every((message) => message.role === "user")).toBe(true);
      expect(debug).toHaveBeenCalledWith(
        "SDK",
        "TestProvider conversation history trimmed",
        expect.objectContaining({ retainedMessages: 21 }),
      );
    } finally {
      debug.mockRestore();
      warn.mockRestore();
      success.mockRestore();
      getActiveMode.mockRestore();
    }
  });
});
