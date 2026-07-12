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

ModeManager.getInstance().loadMode("code");

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
    }
  });
});
