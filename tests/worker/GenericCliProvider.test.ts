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
  runWithTransientRetry,
  DEFAULT_TRANSIENT_MAX_RETRIES,
  queryWithContentRetry,
  DEFAULT_CONTENT_MAX_RETRIES,
  SKIP_SUMMARY_FALLBACK,
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

  it("strips trailing resume marker line from content but keeps prose + XML (Task 4 review fix)", () => {
    const raw = `• thinking prose...\n<observation><type>discovery</type><title>x</title></observation>\nTo resume this session: kimi -r session_abc-123-def`;
    const result = parseCliOutput(raw, KIMI_CLI_CONFIG);
    // sessionId still extracted from the original raw
    expect(result.sessionId).toBe("session_abc-123-def");
    // content keeps prose + XML
    expect(result.content).toContain("• thinking prose...");
    expect(result.content).toContain("<observation>");
    expect(result.content).toContain("<type>discovery</type>");
    // content no longer carries the resume marker line
    expect(result.content).not.toContain("To resume this session:");
    expect(result.content).not.toContain("session_abc-123-def");
    // no dangling trailing newline left behind
    expect(result.content.endsWith("\n")).toBe(false);
  });

  it("does not strip a mid-content mention of the marker phrase (only trailing line)", () => {
    const raw = `To resume this session: mentioned mid-text\n<observation><type>bugfix</type></observation>`;
    const result = parseCliOutput(raw, KIMI_CLI_CONFIG);
    // marker phrase present but NOT at tail → not stripped (no real session_id either)
    expect(result.content).toContain("To resume this session: mentioned mid-text");
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

// ---------------------------------------------------------------------------
// Task 5: runWithTransientRetry (transport-layer retry)
// ---------------------------------------------------------------------------
//
// Ported from loop-engine/src/adapters/transient.ts (simplified: no API-status
// detection — kimi text mode has no structured error envelope; we retry purely
// on non-zero exit). Throws (timeout/ENOENT) are NOT retried at this layer —
// they bubble to handleSessionError. See task-5-report.md for rationale.

describe("runWithTransientRetry", () => {
  it("retries spawn on non-zero exit, succeeds within N", async () => {
    let calls = 0;
    const flaky: SpawnFn = async () => {
      calls++;
      if (calls < 3) return { stdout: "", stderr: "err", exitCode: 1 };
      return {
        stdout:
          "<observation><type>discovery</type><title>ok</title></observation>",
        stderr: "",
        exitCode: 0,
      };
    };
    const result = await runWithTransientRetry(() => flaky("kimi", []), {
      maxRetries: 3,
      baseDelayMs: 1,
      isTransient: (r) => r.exitCode !== 0,
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toBe(3);
  });

  it("exhausts retries and returns last failure", async () => {
    const alwaysFail: SpawnFn = async () => ({
      stdout: "",
      stderr: "err",
      exitCode: 1,
    });
    const result = await runWithTransientRetry(() => alwaysFail("kimi", []), {
      maxRetries: 2,
      baseDelayMs: 1,
      isTransient: (r) => r.exitCode !== 0,
    });
    expect(result.exitCode).toBe(1);
  });

  it("calls fn exactly maxRetries+1 times when always-transient", async () => {
    let calls = 0;
    const alwaysFail: SpawnFn = async () => {
      calls++;
      return { stdout: "", stderr: "err", exitCode: 1 };
    };
    await runWithTransientRetry(() => alwaysFail("kimi", []), {
      maxRetries: 3,
      baseDelayMs: 1,
      isTransient: (r) => r.exitCode !== 0,
    });
    // 1 initial + 3 retries = 4 total attempts
    expect(calls).toBe(4);
  });

  it("maxRetries=0 means single attempt, no retry even if transient (resumeId case)", async () => {
    let calls = 0;
    const alwaysFail: SpawnFn = async () => {
      calls++;
      return { stdout: "", stderr: "err", exitCode: 1 };
    };
    const result = await runWithTransientRetry(() => alwaysFail("kimi", []), {
      maxRetries: 0,
      baseDelayMs: 1,
      isTransient: (r) => r.exitCode !== 0,
    });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  it("does not retry when isTransient returns false (exit 0)", async () => {
    let calls = 0;
    const ok: SpawnFn = async () => {
      calls++;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    const result = await runWithTransientRetry(() => ok("kimi", []), {
      maxRetries: 3,
      baseDelayMs: 1,
      isTransient: (r) => r.exitCode !== 0,
    });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it("exponential backoff: baseDelayMs * 2^attempt via sleepFn", async () => {
    // Inject a recording sleepFn to verify backoff schedule without real timers.
    const sleeps: number[] = [];
    const recordingSleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let calls = 0;
    const alwaysFail: SpawnFn = async () => {
      calls++;
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    await runWithTransientRetry(() => alwaysFail("kimi", []), {
      maxRetries: 3,
      baseDelayMs: 500,
      isTransient: (r) => r.exitCode !== 0,
      sleepFn: recordingSleep,
    });
    // 3 retries → 3 sleeps: 500*2^0=500, 500*2^1=1000, 500*2^2=2000
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("no sleep after final attempt (last failure returned immediately)", async () => {
    const sleeps: number[] = [];
    const recordingSleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const alwaysFail: SpawnFn = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    });
    await runWithTransientRetry(() => alwaysFail("kimi", []), {
      maxRetries: 2,
      baseDelayMs: 100,
      isTransient: (r) => r.exitCode !== 0,
      sleepFn: recordingSleep,
    });
    // 2 retries → 2 sleeps (after attempt 0 and after attempt 1; no sleep
    // after the final attempt 2)
    expect(sleeps).toEqual([100, 200]);
  });

  it("isTransient omitted means no retry (returns first result immediately)", async () => {
    // When isTransient is omitted, the loop returns immediately on the first
    // result regardless of shape — verifies the `!isTransient` short-circuit.
    // Callers must pass an explicit isTransient to get retry behavior (the
    // production injection always does: `r => r.exitCode !== 0`).
    let calls = 0;
    const once: SpawnFn = async () => {
      calls++;
      return { stdout: "x", stderr: "", exitCode: 0 };
    };
    const result = await runWithTransientRetry(() => once("kimi", []), {
      maxRetries: 3,
      baseDelayMs: 1,
    });
    expect(calls).toBe(1);
    expect(result.stdout).toBe("x");
  });

  it("DEFAULT_TRANSIENT_MAX_RETRIES is 3", () => {
    expect(DEFAULT_TRANSIENT_MAX_RETRIES).toBe(3);
  });
});

// Injection-into-query integration: prove query() wraps spawnFn with retry and
// honors resumeSessionId → maxRetries=0. query() is protected, so drive via
// startSession.

describe("GenericCliProvider query() transient retry injection", () => {
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

  it("init (no resumeId): retries spawn on non-zero exit, succeeds, captures session", async () => {
    let calls = 0;
    const flaky: SpawnFn = async () => {
      calls++;
      if (calls < 2) return { stdout: "", stderr: "blip", exitCode: 1 };
      return { stdout: INIT_STDOUT, stderr: "", exitCode: 0 };
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: flaky,
    });
    const session = createSession();

    await provider.startSession(session, mockWorker);

    // 1 transient failure + 1 success = 2 spawn calls (no resumeId → retries allowed)
    expect(calls).toBe(2);
    // session captured from the successful attempt's stdout
    expect(session.memorySessionId).toBe("session_abc-123");
  });

  it("resume (memorySessionId set): maxRetries=0 → single attempt, no retry on failure", async () => {
    let calls = 0;
    const alwaysFail: SpawnFn = async () => {
      calls++;
      return { stdout: "", stderr: "perm", exitCode: 1 };
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: alwaysFail,
    });
    // Pre-set a real-shaped session id → init will resume (not fresh spawn),
    // and resumeId truthy → maxRetries=0 (no transport retry, defer to
    // Task 6 content-layer retry / fallback).
    const session = createSession({
      memorySessionId: "session_deadbeef-1234",
      lastPromptNumber: 2,
    });

    await expect(provider.startSession(session, mockWorker)).rejects.toThrow(
      /exited with code 1/,
    );
    // exactly ONE spawn call — no retries despite non-zero exit
    expect(calls).toBe(1);
  });

  it("fresh spawn (no resumeId): exhausts 3 retries then surfaces non-zero exit", async () => {
    let calls = 0;
    const alwaysFail: SpawnFn = async () => {
      calls++;
      return { stdout: "", stderr: "down", exitCode: 1 };
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: alwaysFail,
    });
    const session = createSession();

    await expect(provider.startSession(session, mockWorker)).rejects.toThrow(
      /exited with code 1/,
    );
    // 1 initial + 3 retries (DEFAULT_TRANSIENT_MAX_RETRIES) = 4 total
    expect(calls).toBe(4);
  });

  it("thrown spawn error (timeout/ENOENT) is NOT retried at transport layer", async () => {
    // Throws bypass the exitCode-based retry loop and bubble immediately —
    // documented limitation (see task-5-report.md). Prevents retrying
    // permanent errors like ENOENT.
    let calls = 0;
    const boom: SpawnFn = async () => {
      calls++;
      throw new Error("kimi ENOENT");
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: boom,
    });
    const session = createSession();

    await expect(provider.startSession(session, mockWorker)).rejects.toThrow(
      /kimi ENOENT/,
    );
    // single call — throw propagated without retry
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 6: 内容层 retry + fallback (queryWithContentRetry)
// ---------------------------------------------------------------------------
//
// Brief: /data/vault/.superpowers/sdd/task-6-brief.md
// Reference: /data/code/self/loop-engine/src/engine.ts:720-790 (retry loop with
//   failedAttempts + diagnostics pairing), /data/code/self/loop-engine/src/sink.ts:15-23
//   (留底哲学: attempts[i] = 第 i 次失败原始输出, diagnostics[i] = 针对它发出的纠错 prompt)
//
// Three test groups:
//   1. standalone queryWithContentRetry() — unit tests of the retry loop
//   2. GenericCliProvider.queryWithContentRetry() method — wrapper around the
//      standalone that injects the provider's queryOnce
//   3. query() integration via startSession — proves the wrapper is wired in
//      and that retry drives a second spawn with `-r <sid> -p <correction>`

describe("queryWithContentRetry (standalone)", () => {
  it("first-call valid → 0 attempts, 0 diagnostics, returns content as-is", async () => {
    const validXml = "<observation><type>discovery</type><title>x</title></observation>";
    const calls: { sid: string | null; prompt: string }[] = [];
    const queryOnce = async (sid: string | null, prompt: string) => {
      calls.push({ sid, prompt });
      return { content: validXml, sessionId: "session_init" as string | null };
    };
    const result = await queryWithContentRetry(queryOnce, "init-prompt", null);
    expect(calls.length).toBe(1);
    expect(calls[0].sid).toBeNull();
    expect(calls[0].prompt).toBe("init-prompt");
    expect(result.result.content).toBe(validXml);
    expect(result.attempts).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("invalid → resume + correction → valid (1 attempt + 1 diagnostic留底)", async () => {
    const outputs = [
      "I will help you with that", // prose → parseAgentXml invalid
      "<observation><type>discovery</type><title>recovered</title></observation>",
    ];
    let i = 0;
    const calls: { sid: string | null; prompt: string }[] = [];
    const queryOnce = async (sid: string | null, prompt: string) => {
      calls.push({ sid, prompt });
      const out = outputs[i++];
      return { content: out, sessionId: `session_${i}` as string | null };
    };
    const result = await queryWithContentRetry(queryOnce, "init-prompt", null);
    // 2 calls: initial + 1 retry
    expect(calls.length).toBe(2);
    // retry uses the SESSION captured from the first call (same session resume)
    expect(calls[1].sid).toBe("session_1");
    // retry uses the CORRECTION prompt (not initial)
    expect(calls[1].prompt).not.toBe("init-prompt");
    expect(calls[1].prompt).toContain("schema");
    // valid content surfaced
    expect(result.result.content).toContain("<type>discovery</type>");
    expect(result.result.content).toContain("recovered");
    // 1 attempt + 1 diagnostic — paired留底 (sink.ts:15-23 contract)
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toBe("I will help you with that");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toBe(calls[1].prompt);
    // sessionId propagated to final captured id
    expect(result.result.sessionId).toBe("session_2");
  });

  it("retry exhausted → returns skip_summary fallback (xml_failed_after_retries)", async () => {
    const alwaysProse = async () => ({
      content: "no xml here, just prose",
      sessionId: "session_x" as string | null,
    });
    const result = await queryWithContentRetry(alwaysProse, "p", null, 2);
    expect(result.result.content).toContain("<skip_summary");
    expect(result.result.content).toContain("xml_failed_after_retries");
    // Comprehensive留底 (brief impl sketch: push BEFORE if/else, so all 3
    // invalid outputs are captured; corrections only emitted when retrying,
    // so 2 — final failure has no paired correction because we gave up).
    // Asymmetry documents itself: attempts=N+1, diagnostics=N when fallback hit.
    expect(result.attempts).toHaveLength(3);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("DEFAULT_CONTENT_MAX_RETRIES is 2 (3 total tries: initial + 2 retries)", async () => {
    expect(DEFAULT_CONTENT_MAX_RETRIES).toBe(2);
  });

  it("maxContentRetries=0 → single attempt, no retry, immediate fallback if invalid", async () => {
    let calls = 0;
    const alwaysInvalid = async () => {
      calls++;
      return { content: "nope", sessionId: null as string | null };
    };
    const result = await queryWithContentRetry(alwaysInvalid, "p", null, 0);
    expect(calls).toBe(1);
    expect(result.result.content).toContain("<skip_summary");
    expect(result.attempts).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(0); // no retries → no correction prompts emitted
  });

  it("maxContentRetries=1 → 2 total tries (initial + 1 retry) before fallback", async () => {
    let calls = 0;
    const alwaysInvalid = async () => {
      calls++;
      return { content: "bad", sessionId: null as string | null };
    };
    const result = await queryWithContentRetry(alwaysInvalid, "p", null, 1);
    expect(calls).toBe(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.result.content).toContain("<skip_summary");
  });

  it("valid on 3rd try → 2 attempts + 2 diagnostics留底", async () => {
    // NOTE: bare <observation><type>...</type></observation> with no title /
    // narrative / facts is parsed as INVALID (parser drops empty observations
    // — see parser.ts "Skipping empty observation"). Fixture must include a
    // title (or other non-empty field) to actually be valid.
    const outputs = [
      "bad1",
      "bad2",
      "<observation><type>bugfix</type><title>fix</title></observation>",
    ];
    let i = 0;
    const queryOnce = async () => {
      const out = outputs[i++];
      return { content: out, sessionId: null as string | null };
    };
    const result = await queryWithContentRetry(queryOnce, "p", null, 2);
    expect(i).toBe(3);
    expect(result.attempts).toHaveLength(2);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.attempts[0]).toBe("bad1");
    expect(result.attempts[1]).toBe("bad2");
    expect(result.result.content).toContain("<type>bugfix</type>");
  });

  it("sessionId propagated through retries (each retry uses prior captured sid)", async () => {
    const sids: (string | null)[] = [];
    const queryOnce = async (sid: string | null) => {
      sids.push(sid);
      // emit a different sessionId each call to verify propagation
      return { content: "bad", sessionId: `session_${sids.length}` as string | null };
    };
    await queryWithContentRetry(queryOnce, "p", "session_seed", 1);
    // call 0: sid = seed (initial)
    // call 1: sid = session_1 (captured from call 0)
    expect(sids).toEqual(["session_seed", "session_1"]);
  });

  it("throws inside queryOnce propagate (no swallow at content layer)", async () => {
    const boom = async () => {
      throw new Error("kimi ENOENT");
    };
    expect(queryWithContentRetry(boom, "p", null)).rejects.toThrow(/ENOENT/);
  });

  it("SKIP_SUMMARY_FALLBACK constant matches parser.ts:48 recognized shape", () => {
    // parser.ts:48 /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/ must match
    expect(SKIP_SUMMARY_FALLBACK).toBe('<skip_summary reason="xml_failed_after_retries" />');
    // sanity: parser would treat this as valid (skipped summary)
  });
});

// ---------------------------------------------------------------------------
// GenericCliProvider.queryWithContentRetry() method
// ---------------------------------------------------------------------------

describe("GenericCliProvider.queryWithContentRetry() method", () => {
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

  it("invalid → resume + correction → valid: drives 2 spawns with -r sid + correction prompt", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const outputs = [
      "I will help you" + "\nTo resume this session: kimi -r session_abc",
      "<observation><type>discovery</type><title>recovered</title></observation>" +
        "\nTo resume this session: kimi -r session_abc",
    ];
    let i = 0;
    const spawnFn: SpawnFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: outputs[i++], stderr: "", exitCode: 0 };
    };
    const { mockDbManager, mockSessionManager } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: spawnFn,
    });
    const result = await provider.queryWithContentRetry("user-prompt", null);
    // 2 spawns: initial fresh, retry with -r session_abc
    expect(calls.length).toBe(2);
    // call 0: fresh (no resume flag)
    expect(calls[0].args).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
    expect(calls[0].args).toContain("user-prompt");
    // call 1: resume with captured sid, prompt is the CORRECTION (not "user-prompt")
    expect(calls[1].args[0]).toBe(KIMI_CLI_CONFIG.resumeFlag);
    expect(calls[1].args[1]).toBe("session_abc");
    const pIdx = calls[1].args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(1);
    expect(calls[1].args[pIdx + 1]).not.toBe("user-prompt");
    expect(calls[1].args[pIdx + 1]).toContain("schema");
    // valid content surfaced
    expect(result.result.content).toContain("<type>discovery</type>");
    expect(result.attempts).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toBe(calls[1].args[pIdx + 1]);
  });

  it("retry exhausted → skip_summary fallback (provider method)", async () => {
    const alwaysProse: SpawnFn = async () => ({
      stdout: "no xml" + "\nTo resume this session: kimi -r session_x",
      stderr: "",
      exitCode: 0,
    });
    const { mockDbManager, mockSessionManager } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: alwaysProse,
    });
    const result = await provider.queryWithContentRetry("p", null, 2);
    expect(result.result.content).toBe(SKIP_SUMMARY_FALLBACK);
    // Comprehensive留底: 3 invalid outputs captured, 2 corrections emitted
    expect(result.attempts).toHaveLength(3);
    expect(result.diagnostics).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// query() integration via startSession — proves content retry is wired into
// the production init/observation/summary paths
// ---------------------------------------------------------------------------

describe("GenericCliProvider query() content retry injection", () => {
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

  it("init invalid → resume + correction → valid: 2 spawns, captures session, no throw", async () => {
    const calls: { args: string[] }[] = [];
    const outputs = [
      "prose only, no XML" + "\nTo resume this session: kimi -r session_abc-123",
      "<observation><type>discovery</type><title>init</title><narrative>n</narrative></observation>" +
        "\nTo resume this session: kimi -r session_abc-123",
    ];
    let i = 0;
    const spawnFn: SpawnFn = async (_cmd, args) => {
      calls.push({ args });
      return { stdout: outputs[i++], stderr: "", exitCode: 0 };
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: spawnFn,
    });
    const session = createSession();

    await provider.startSession(session, mockWorker);

    // 2 spawns: invalid initial + valid retry
    expect(calls.length).toBe(2);
    // retry uses resume flag + captured sid
    expect(calls[1].args[0]).toBe(KIMI_CLI_CONFIG.resumeFlag);
    expect(calls[1].args[1]).toBe("session_abc-123");
    // session id captured (from the FIRST successful capture — init's stdout)
    expect(session.memorySessionId).toBe("session_abc-123");
    // content retry was logged
    const warnCalls = loggerSpies[2].mock.calls;
    const retryLog = warnCalls.find(
      (c: any[]) => typeof c[1] === "string" && c[1].includes("content retry"),
    );
    expect(retryLog).toBeDefined();
  });

  it("init always invalid → skip_summary fallback forwarded to processAgentResponse (no throw)", async () => {
    const alwaysProse: SpawnFn = async () => ({
      stdout: "no xml at all" + "\nTo resume this session: kimi -r session_abc-123",
      stderr: "",
      exitCode: 0,
    });
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: alwaysProse,
    });
    const session = createSession();

    // CRITICAL: does NOT throw — fallback skip_summary is forwarded to
    // processAgentResponse which recognizes it as valid (parser.ts:48)
    await provider.startSession(session, mockWorker);

    // 3 spawns (initial + 2 retries; maxContentRetries=2)
    expect(session.memorySessionId).toBe("session_abc-123");
  });

  it("Task 4/5 contract preserved: valid init still triggers NO content retry", async () => {
    const calls: { args: string[] }[] = [];
    const spawnFn: SpawnFn = async (_cmd, args) => {
      calls.push({ args });
      return { stdout: INIT_STDOUT, stderr: "", exitCode: 0 };
    };
    const { mockDbManager, mockSessionManager, mockWorker } = createStubs();
    const provider = new GenericCliProvider(mockDbManager, mockSessionManager, {
      spawn: spawnFn,
    });
    const session = createSession();

    await provider.startSession(session, mockWorker);

    // exactly ONE spawn — valid XML, no content retry triggered
    expect(calls.length).toBe(1);
    expect(session.memorySessionId).toBe("session_abc-123");
  });
});
