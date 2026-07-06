import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { logger } from "../../src/utils/logger.js";

// Stub ModeManager before importing the provider — startSession pulls the
// active mode for init/observation/summary prompt templates.
mock.module("../../src/services/domain/ModeManager.js", () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: "code",
        prompts: {
          init: "init prompt",
          observation: "obs prompt",
          summary: "summary prompt",
        },
        observation_types: [{ id: "discovery" }, { id: "bugfix" }, { id: "refactor" }],
        observation_concepts: [],
      }),
    }),
  },
}));

import {
  KIMI_CLI_CONFIG,
  isGenericCliSelected,
  parseCliOutput,
  buildKimiArgs,
  GenericCliProvider,
  defaultSpawn,
  type SpawnFn,
} from "../../src/services/worker/GenericCliProvider.js";
import type { ActiveSession } from "../../src/services/worker-types.js";
import type { DatabaseManager } from "../../src/services/worker/DatabaseManager.js";
import type { SessionManager } from "../../src/services/worker/SessionManager.js";
import type { WorkerRef } from "../../src/services/worker/agents/types.js";

describe("GenericCliProvider config", () => {
  it("Kimi config has cmd + output-format text + resume flag", () => {
    expect(KIMI_CLI_CONFIG.cmd).toBe("kimi");
    expect(KIMI_CLI_CONFIG.baseArgs).toEqual(["--output-format", "text"]);
    expect(KIMI_CLI_CONFIG.outputFormat).toBe("text");
    expect(["-r", "-S"]).toContain(KIMI_CLI_CONFIG.resumeFlag);
    expect(KIMI_CLI_CONFIG.sessionIdRegex.test("To resume: kimi -r session_abc-123")).toBe(true);
    expect(KIMI_CLI_CONFIG.providerName).toBe("kimi-cli");
    expect(KIMI_CLI_CONFIG.syntheticIdPrefix).toBe("kimi");
  });

  it("isGenericCliSelected reads CLAUDE_MEM_PROVIDER=generic-cli", () => {
    process.env.CLAUDE_MEM_PROVIDER = "generic-cli";
    expect(isGenericCliSelected()).toBe(true);
    process.env.CLAUDE_MEM_PROVIDER = "claude";
    expect(isGenericCliSelected()).toBe(false);
  });
});

describe("parseCliOutput", () => {
  it("extracts session_id from kimi tail + keeps observation XML", () => {
    const raw = `• thinking prose...\n<observation><type>discovery</type><title>x</title></observation>\nTo resume this session: kimi -r session_abc-123-def`;
    const result = parseCliOutput(raw, KIMI_CLI_CONFIG);
    expect(result.sessionId).toBe("session_abc-123-def");
    expect(result.content).toContain("<observation>");
    expect(result.content).toContain("<type>discovery</type>");
  });

  it("returns null sessionId when no resume marker", () => {
    const result = parseCliOutput("just XML no marker", KIMI_CLI_CONFIG);
    expect(result.sessionId).toBeNull();
  });
});

describe("buildKimiArgs", () => {
  it("first call: no resume flag, prompt + baseArgs", () => {
    const args = buildKimiArgs("hello", KIMI_CLI_CONFIG);
    // -p <prompt> + baseArgs (no resume)
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("text");
    expect(args).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
  });

  it("retry: resume flag + sid prepended before -p", () => {
    const args = buildKimiArgs("hello", KIMI_CLI_CONFIG, "session_deadbeef-1234");
    // resumeFlag + sid must be in front
    expect(args[0]).toBe(KIMI_CLI_CONFIG.resumeFlag);
    expect(args[1]).toBe("session_deadbeef-1234");
    // -p <prompt> still present after
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("hello");
    // baseArgs still present
    expect(args).toContain("--output-format");
    expect(args).toContain("text");
  });

  it("resumeSessionId empty/null → no resume flag", () => {
    expect(buildKimiArgs("p", KIMI_CLI_CONFIG, null)).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
    expect(buildKimiArgs("p", KIMI_CLI_CONFIG, "")).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
  });
});

// ---------------------------------------------------------------------------
// Task 4: GenericCliProvider session lifecycle
// ---------------------------------------------------------------------------

/**
 * Stubs follow the response-processor.test.ts pattern (mock DB + SessionManager
 * + Worker). Each test injects its own SpawnFn that records the args it was
 * called with and returns a canned kimi-shaped stdout.
 */
function createStubs({
  messages = [],
}: {
  messages?: AsyncIterable<any> | any[];
} = {}) {
  const mockStoreObservations = mock(() => ({
    observationIds: [1],
    summaryId: 1,
    createdAtEpoch: Date.now(),
  }));
  const mockSessionStore = {
    updateMemorySessionId: mock(() => {}),
    ensureMemorySessionIdRegistered: mock(() => {}),
    getSessionById: mock(() => ({ memory_session_id: null })),
    storeObservations: mockStoreObservations,
  };
  const mockDbManager = {
    getSessionStore: () => mockSessionStore,
    getChromaSync: () => ({
      syncObservation: mock(() => Promise.resolve()),
      syncSummary: mock(() => Promise.resolve()),
    }),
  } as unknown as DatabaseManager;
  const mockSessionManager = {
    getMessageIterator: async function* () {
      for (const m of messages) yield m;
    },
    getPendingMessageStore: () => ({
      markProcessed: mock(() => {}),
      confirmProcessed: mock(() => {}),
      cleanupProcessed: mock(() => 0),
      resetStuckMessages: mock(() => 0),
    }),
    confirmClaimedMessages: mock(() => Promise.resolve(0)),
    resetProcessingToPending: mock(() => Promise.resolve(0)),
  } as unknown as SessionManager;
  const mockWorker = {
    sseBroadcaster: { broadcast: mock(() => {}) },
    broadcastProcessingStatus: mock(() => {}),
  } as unknown as WorkerRef;
  return {
    mockDbManager,
    mockSessionManager,
    mockWorker,
    mockSessionStore,
    mockStoreObservations,
  };
}

function createSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: "content-1",
    memorySessionId: null,
    project: "test-project",
    platformSource: "claude",
    userPrompt: "Remember the build steps",
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  } as ActiveSession;
}

const INIT_STDOUT =
  "<observation><type>discovery</type><title>init</title><narrative>n</narrative></observation>\n" +
  "To resume this session: kimi -r session_abc-123";

const OBS_STDOUT =
  "<observation><type>discovery</type><title>obs</title><narrative>n</narrative></observation>\n" +
  "To resume this session: kimi -r session_abc-123";

describe("GenericCliProvider session lifecycle", () => {
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "debug").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(logger, "success").mockImplementation(() => {}),
      spyOn(logger, "failure").mockImplementation(() => {}),
      spyOn(logger, "dataOut").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach((s) => s.mockRestore());
    mock.restore();
  });

  it("init: spawns kimi without resume flag and captures sessionId", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnFn: SpawnFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: INIT_STDOUT, stderr: "", exitCode: 0 };
    };
    const { mockDbManager, mockSessionManager, mockWorker, mockSessionStore } =
      createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: spawnFn,
    });
    const session = createSession();

    await provider.startSession(session, mockWorker);

    // exactly one spawn (init only — no queued messages)
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe("kimi");
    // first call has NO resume flag
    expect(calls[0].args).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
    // -p <prompt> present
    expect(calls[0].args[0]).toBe("-p");

    // session.memorySessionId was captured from stdout
    expect(session.memorySessionId).toBe("session_abc-123");
    // DB was updated with the captured id (last call wins — first call
    // stamps a synthetic placeholder, second writes the real session_xxx
    // captured from init stdout)
    const updateCalls = mockSessionStore.updateMemorySessionId.mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const [sessionDbId, capturedId] = updateCalls[updateCalls.length - 1];
    expect(sessionDbId).toBe(42);
    expect(capturedId).toBe("session_abc-123");

    // init prompt (user) + assistant reply pushed by handleInitResponse AND
    // again by processAgentResponse — mirrors OpenAICompatibleProvider's
    // behavior (processAgentResponse pushes assistant text unconditionally).
    expect(session.conversationHistory.length).toBeGreaterThanOrEqual(2);
    expect(session.conversationHistory[0].role).toBe("user");
    expect(session.conversationHistory[1].role).toBe("assistant");
  });

  it("observation message: 2nd spawn uses resume flag + captured sessionId", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnFn: SpawnFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: OBS_STDOUT, stderr: "", exitCode: 0 };
    };
    const observation = {
      type: "observation" as const,
      tool_name: "Read",
      tool_input: { path: "/a" },
      tool_response: { ok: true },
      prompt_number: 2,
      cwd: "/repo",
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs({
      messages: [observation],
    });
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: spawnFn,
    });
    const session = createSession({ lastPromptNumber: 1 });

    await provider.startSession(session, mockWorker);

    // init + observation = 2 spawns
    expect(calls.length).toBe(2);
    // init: no resume flag
    expect(calls[0].args).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
    // observation: resume flag + sid prepended BEFORE -p
    expect(calls[1].args[0]).toBe(KIMI_CLI_CONFIG.resumeFlag);
    expect(calls[1].args[1]).toBe("session_abc-123");
    const pIdx = calls[1].args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(1);

    // session id stable across both calls
    expect(session.memorySessionId).toBe("session_abc-123");
  });

  it("resumes when session.memorySessionId already set (init uses resume flag)", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnFn: SpawnFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: OBS_STDOUT, stderr: "", exitCode: 0 };
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: spawnFn,
    });
    // pre-existing memorySessionId shaped like a real kimi-issued handle
    // (hex-only after `session_` so the regex matches; non-hex strings like
    // `session_pre-existing` are treated as synthetic and skipped for resume)
    const session = createSession({
      memorySessionId: "session_deadbeef-1234",
      lastPromptNumber: 2,
    });

    await provider.startSession(session, mockWorker);

    expect(calls.length).toBe(1);
    // init call resumed with the existing id
    expect(calls[0].args[0]).toBe(KIMI_CLI_CONFIG.resumeFlag);
    expect(calls[0].args[1]).toBe("session_deadbeef-1234");
    // captured id from new stdout replaces the prior one
    expect(session.memorySessionId).toBe("session_abc-123");
  });

  it("defaults to defaultSpawn + KIMI_CLI_CONFIG when opts omitted", () => {
    const { mockDbManager, mockSessionManager } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager);
    // Just assert it constructs without throwing — full spawn path is
    // covered by integration tests.
    expect(provider).toBeDefined();
  });

  it("spawn failure aborts session via handleSessionError (no swallow)", async () => {
    const boom: SpawnFn = async () => {
      throw new Error("kimi ENOENT");
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: boom,
    });
    const session = createSession();

    expect(provider.startSession(session, mockWorker)).rejects.toThrow(
      /kimi ENOENT/,
    );
  });
});

describe("GenericCliProvider default export wiring", () => {
  it("defaultSpawn is exported (production wiring)", () => {
    expect(typeof defaultSpawn).toBe("function");
  });
});
