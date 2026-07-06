import { execSync, spawn } from "child_process";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { USER_SETTINGS_PATH } from "../../shared/paths.js";
import { DatabaseManager } from "./DatabaseManager.js";
import { SessionManager } from "./SessionManager.js";
import { logger } from "../../utils/logger.js";
import {
  buildInitPrompt,
  buildObservationPrompt,
  buildSummaryPrompt,
  buildContinuationPrompt,
} from "../../sdk/prompts.js";
import type { ActiveSession, ConversationMessage } from "../worker-types.js";
import { ModeManager } from "../domain/ModeManager.js";
import type { ModeConfig } from "../domain/types.js";
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef,
} from "./agents/index.js";
import type { ProviderQueryResult } from "./OpenAICompatibleProvider.js";

/**
 * Configuration for a generic CLI provider driven by an external binary
 * (e.g. `kimi`). The provider spawns the binary with `-p <prompt>`, parses
 * the session id from stdout, and resumes via `resumeFlag <session_id>`.
 */
export interface GenericCliConfig {
  cmd: string;                  // e.g. "kimi"
  baseArgs: string[];           // 不含 -p <prompt>（运行时拼）
  outputFormat: "text" | "stream-json";
  resumeFlag: string;           // Task 1 实测确认："-r" 或 "-S"
  sessionIdRegex: RegExp;       // 从 stdout 抓 session_id
  providerName: string;         // 日志/telemetry 用
  syntheticIdPrefix: string;    // memorySessionId 前缀
}

/**
 * Kimi Code CLI configuration.
 *
 * `resumeFlag = "-r"`: Task 1 实测确认 `kimi -r <session_id>` 与
 * `kimi -S <session_id>` 都能 resume 并 exit 0；`-r` / `--resume` 是
 * `-S` / `--session` 的别名。详见 Zettelkasten/Kimi Code 本地 Session
 * 持久化与 Token 用量记录.md。
 */
export const KIMI_CLI_CONFIG: GenericCliConfig = {
  cmd: "kimi",
  baseArgs: ["--output-format", "text"],
  outputFormat: "text",
  resumeFlag: "-r",
  sessionIdRegex: /session_([a-f0-9-]+)/,
  providerName: "kimi-cli",
  syntheticIdPrefix: "kimi",
};

/**
 * Returns true when the user has selected the generic CLI provider via
 * `CLAUDE_MEM_PROVIDER=generic-cli` in settings. Mirrors the shape of
 * `isOpenRouterSelected` / `isGeminiSelected`.
 */
export function isGenericCliSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === "generic-cli";
}

/**
 * Returns true when the configured CLI binary is on PATH. Used as a
 * preflight check before attempting to spawn the provider.
 */
export function isGenericCliAvailable(): boolean {
  try {
    execSync(`which ${KIMI_CLI_CONFIG.cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Task 3: spawn + stdout parse
// ---------------------------------------------------------------------------

/**
 * Result of a CLI query. `content` carries the full stdout (prose +
 * `<observation>` XML + resume marker) so downstream parser.ts can apply
 * its own regex; `sessionId` is the pre-extracted handle for resume.
 */
export interface CliQueryResult {
  content: string;          // stdout（含 observation XML + 可能 prose）
  sessionId: string | null; // 从末尾 regex 抓
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

/**
 * 从 CLI 原始 stdout 抽取 `content` + `sessionId`。
 *
 * - `content`：整个 stdout（含 prose + `<observation>` XML + resume marker）。
 *   parser.ts 的 observation regex 会自行过滤——这里不截断。
 * - `sessionId`：从 `config.sessionIdRegex` 抓 **完整 "session_xxx"（含前缀）**，
 *   便于直接喂 `-r <sessionId>` / `-S <sessionId>`。无匹配返回 null。
 *
 * 注：用 `match()[0]`（整段匹配）而非 `match()[1]`（捕获组），让 regex 后续
 * 若改成无捕获组也不破坏行为。
 */
export function parseCliOutput(
  raw: string,
  config: GenericCliConfig,
): Pick<CliQueryResult, "content" | "sessionId"> {
  const m = raw.match(config.sessionIdRegex);
  return {
    content: raw,
    sessionId: m ? m[0] : null,
  };
}

/**
 * 可注入的 spawn 函数签名。生产用 `defaultSpawn`，测试可注入 mock。
 *
 * kimi `-p` 响应实测 30-60s（Task 1）；调用方应在 worker 层再叠一层
 * `Promise.race` / 上层 timeout 兜底，此处仅作 child 进程级保护。
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * 默认 spawn 实现。
 *
 * **超时保护（Task 1 必加）**：kimi `-p` 响应 30-60s 是常态，但若进程挂死
 * （网络阻塞 / OAuth 失效卡输入 / 上游不返回），worker 会无限等待。
 * 这里硬编码 `DEFAULT_SPAWN_TIMEOUT_MS = 120_000`（≥120s）上限：
 *   1. spawn 后启动 `timer = setTimeout(...)`
 *   2. 到点 `child.kill("SIGTERM")`（先礼后兵），并 reject（TIMEOUT）
 *   3. 正常 `close` 先到 → `clearTimeout(timer)`，resolve
 *   4. SIGTERM 后 5s 仍未退出 → `child.kill("SIGKILL")` 强清理（防 zombie）
 *
 * `stdio: ["ignore","pipe","pipe"]`：stdin 关闭（kimi `-p` 不读 stdin，
 * 见 loop-engine kimicode.ts），stdout/stderr 管道收集。
 */
export const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;
const SPAWN_SIGTERM_GRACE_MS = 5_000;

export const defaultSpawn: SpawnFn = (cmd, args) => {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let stdout = "";
    let stderr = "";

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const elapsed = Date.now() - startedAt;
      // 先 SIGTERM 礼貌退出
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      // grace 5s 仍不退 → SIGKILL 兜底（防 zombie）
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }, SPAWN_SIGTERM_GRACE_MS).unref?.();
      reject(
        new Error(
          `defaultSpawn timeout after ${elapsed}ms (cmd=${cmd} ${args.join(" ")})`,
        ),
      );
    }, DEFAULT_SPAWN_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
    });
  });
};

/**
 * 构造 kimi CLI 调用参数。
 *
 * - **首次**：`["-p", prompt, ...baseArgs]`
 * - **retry / resume**：resumeFlag + sid 放在 **最前**（kimi `-r/-S` 必须在 `-p` 前，
 *   与 loop-engine `buildKimiArgs` 一致），其余同首次。
 *
 * 注：本函数只拼装参数，不调用 spawn。调用方负责 `defaultSpawn(cmd, args)`。
 *
 * @param prompt         用户 prompt 文本
 * @param config         CLI 配置（提供 `baseArgs`、`resumeFlag`）
 * @param resumeSessionId 可选；非空则前置 `[resumeFlag, sid]`
 */
export function buildKimiArgs(
  prompt: string,
  config: GenericCliConfig,
  resumeSessionId?: string | null,
): string[] {
  const args = ["-p", prompt, ...config.baseArgs];
  if (resumeSessionId) {
    args.unshift(config.resumeFlag, resumeSessionId);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Task 4: GenericCliProvider session lifecycle
// ---------------------------------------------------------------------------
//
// 镜像 `OpenAICompatibleProvider.startSession` 的骨架（init / observation /
// summary loop + cumulative token accounting + abort-aware error handling +
// history truncation），但 **不继承** OpenAICompatibleProvider —— abstract
// 成员（`getConfig()`、`missingApiKeyError()`、`query(history, config)`）
// 假设 HTTP 传输，与 CLI spawn 模型不匹配。复制骨架后只改 `query()`：
//
//   - 不是 HTTP：拼最后一条 user message 作 prompt → `buildKimiArgs` →
//     `defaultSpawn` → `parseCliOutput`
//   - **关键差异**：CLI 有 session 概念，每次 query 后若 `parsed.sessionId`
//     非空，**更新 `session.memorySessionId`** 并写 DB。OpenAICompatibleProvider
//     不这样做（HTTP 无 session 概念，memorySessionId 是一次合成的）
//   - 传给 query 的 resumeSessionId = `session.memorySessionId`（首次
//     undefined → fresh spawn；后续 resume）

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100_000;

/**
 * Estimate token count for a single message body. kimi text 模式不返
 * usage，沿用 OpenAICompatibleProvider 的 chars/4 粗估（与 Gemini 的
 * `estimateTokens` 同思路）。
 */
function estimateTokensHeuristic(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Returns true iff `id` looks like a real kimi-emitted session id (matches
 * `config.sessionIdRegex`). Used to distinguish captured `session_xxx`
 * handles from the synthetic placeholder (`kimi-content-1-<ts>`) that
 * `startSession` stamps before the first query returns.
 */
function isRealCliSessionId(
  id: string | null | undefined,
  config: GenericCliConfig,
): boolean {
  return !!id && config.sessionIdRegex.test(id);
}

export class GenericCliProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private readonly spawnFn: SpawnFn;
  private readonly config: GenericCliConfig;

  constructor(
    dbManager: DatabaseManager,
    sessionManager: SessionManager,
    opts?: { spawn?: SpawnFn; config?: GenericCliConfig },
  ) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
    this.spawnFn = opts?.spawn ?? defaultSpawn;
    this.config = opts?.config ?? KIMI_CLI_CONFIG;
  }

  /**
   * Issue one CLI invocation: extract the last user message as the prompt,
   * spawn `<cmd> [resumeFlag sid] -p <prompt> ...baseArgs`, parse stdout
   * into content + sessionId.
   *
   * Task 4 keeps this simple — Task 5 wraps `spawnFn` with transient retry,
   * Task 6 wraps `query` with content-retry + provider fallback. Signatures
   * are kept (prompt + resumeSessionId) → (content + sessionId) so those
   * wrappers can compose cleanly.
   */
  private async query(
    history: ConversationMessage[],
    resumeSessionId?: string | null,
  ): Promise<ProviderQueryResult & { sessionId: string | null }> {
    // kimi -p 是单 prompt —— 不像 HTTP 把 history 一起送。靠 resume
    // session 保持上下文（首选，token 省）。如果 session 还没建立
    // （首次 init），就发最后一条 user message 起会话。
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";
    const args = buildKimiArgs(prompt, this.config, resumeSessionId);

    logger.debug("SDK", `Querying ${this.config.providerName} CLI`, {
      cmd: this.config.cmd,
      hasResume: !!resumeSessionId,
      resumeSessionId: resumeSessionId ?? null,
      promptChars: prompt.length,
    });

    const { stdout, exitCode } = await this.spawnFn(this.config.cmd, args);
    const parsed = parseCliOutput(stdout, this.config);

    if (exitCode !== 0) {
      // surface non-zero exit so handleSessionError can classify; Task 5
      // will introduce structured classification.
      throw new Error(
        `${this.config.providerName} CLI exited with code ${exitCode}: ${stdout.slice(-400)}`,
      );
    }

    // tokensUsed: kimi text 模式不返 usage，用 chars/4 粗估（OpenAICompatibleProvider 同思路）。
    // 累计到 cumulativeInput/Output（70/30 split）。lastUsage 留 null —— 不
    // 想把估算伪装成真实用量进 telemetry（与 OpenAICompatibleProvider.buildLastUsage
    // 「只在有真数据时填」的契约一致）。
    const tokensUsed = Math.ceil(stdout.length / 4);

    return {
      content: parsed.content,
      tokensUsed,
      servedModel: this.config.cmd,
      sessionId: parsed.sessionId,
    };
  }

  /**
   * 镜像 OpenAICompatibleProvider.startSession：生成 synthetic
   * memorySessionId（实际捕获会发生在首次 query 之后）→ init/continuation
   * prompt → for await message of getMessageIterator → observation/summary。
   *
   * 差异：
   *   - 不调 `getConfig()` / `missingApiKeyError()`（CLI 无 API key 概念）
   *   - 每次 query 后若 `parsed.sessionId` 非空，更新 `session.memorySessionId`
   *     并写 DB（OpenAICompatibleProvider 不这样做 —— HTTP 无 session 概念，
   *     memorySessionId 是合成的）
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const model = this.config.cmd;
    session.lastModelId = model;

    // 注：CLI 不需要合成的 memorySessionId（kimi 自己生成 session_xxx）。
    // 但 OpenAICompatibleProvider 这里生成一个合成 id 是为了在 init 失败的
    // 情况下也有一个占位 id —— 我们沿用同样逻辑，让首次 query 后由真实
    // session_xxx 覆盖。
    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `${this.config.syntheticIdPrefix}-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager
        .getSessionStore()
        .updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info(
        "SESSION",
        `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=${this.config.providerName}`,
      );
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt =
      session.lastPromptNumber === 1
        ? buildInitPrompt(
            session.project,
            session.contentSessionId,
            session.userPrompt,
            mode,
          )
        : buildContinuationPrompt(
            session.userPrompt,
            session.lastPromptNumber,
            session.contentSessionId,
            mode,
          );

    session.conversationHistory.push({ role: "user", content: initPrompt });

    try {
      session.lastPromptSentAt = Date.now();
      session.lastGeneratorSource = "init";
      // Only resume if memorySessionId looks like a REAL captured kimi
      // session_xxx. The synthetic placeholder generated above (e.g.
      // "kimi-content-1-1700000000") doesn't match the regex and would be
      // rejected by `kimi -r`. Continuation prompts (lastPromptNumber > 1)
      // arrive with a real session_xxx from the prior worker run → resume.
      const initResumeId = isRealCliSessionId(session.memorySessionId, this.config)
        ? session.memorySessionId
        : null;
      const initResponse = await this.query(
        session.conversationHistory,
        initResumeId,
      );
      await this.handleInitResponse(initResponse, session, worker, model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error(
          "SDK",
          `${this.config.providerName} init query failed`,
          { sessionId: session.sessionDbId, model },
          error,
        );
      } else {
        logger.error(
          "SDK",
          `${this.config.providerName} init query failed with non-Error`,
          { sessionId: session.sessionDbId, model },
          new Error(String(error)),
        );
      }
      return this.handleSessionError(error, session, worker);
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(
        session.sessionDbId,
      )) {
        session.pendingAgentId = message.agentId ?? null;
        session.pendingAgentType = message.agentType ?? null;

        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === "observation") {
          await this.processObservationMessage(
            session,
            message,
            worker,
            originalTimestamp,
            lastCwd,
          );
        } else if (message.type === "summarize") {
          await this.processSummaryMessage(
            session,
            message,
            worker,
            mode,
            originalTimestamp,
            lastCwd,
          );
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error(
          "SDK",
          `${this.config.providerName} message loop failed`,
          { sessionId: session.sessionDbId, model },
          error,
        );
      } else {
        logger.error(
          "SDK",
          `${this.config.providerName} message loop failed with non-Error`,
          { sessionId: session.sessionDbId, model },
          new Error(String(error)),
        );
      }
      return this.handleSessionError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success(
      "SDK",
      `${this.config.providerName} agent completed`,
      {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
      },
    );
  }

  /**
   * After a query returns, if `parsed.sessionId` is non-null, update
   * `session.memorySessionId` and write through to DB. Returns true if
   * updated (for logging).
   */
  private captureMemorySessionId(
    sessionId: string | null,
    session: ActiveSession,
  ): boolean {
    if (!sessionId) return false;
    if (sessionId === session.memorySessionId) return false;

    const previousId = session.memorySessionId;
    session.memorySessionId = sessionId;
    this.dbManager
      .getSessionStore()
      .updateMemorySessionId(session.sessionDbId, sessionId);
    const label = previousId
      ? `MEMORY_ID_CHANGED | sessionDbId=${session.sessionDbId} | from=${previousId} | to=${sessionId}`
      : `MEMORY_ID_CAPTURED | sessionDbId=${session.sessionDbId} | memorySessionId=${sessionId}`;
    logger.info("SESSION", label, {
      sessionId: session.sessionDbId,
      memorySessionId: sessionId,
      previousId,
    });
    return true;
  }

  private async handleInitResponse(
    initResponse: ProviderQueryResult & { sessionId: string | null },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string,
  ): Promise<void> {
    // **关键差异（vs OpenAICompatibleProvider）**：CLI 返回真实 session_id，
    // 覆盖掉 startSession 里那个合成占位 id。
    this.captureMemorySessionId(initResponse.sessionId, session);

    if (initResponse.content) {
      session.conversationHistory.push({
        role: "assistant",
        content: initResponse.content,
      });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(initResponse);
      await processAgentResponse(
        initResponse.content,
        session,
        this.dbManager,
        this.sessionManager,
        worker,
        tokensUsed,
        null,
        this.config.providerName,
        undefined,
        initResponse.servedModel ?? model,
      );
    } else {
      logger.error(
        "SDK",
        `Empty ${this.config.providerName} init response - session may lack context`,
        { sessionId: session.sessionDbId, model },
      );
    }
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: {
      prompt_number?: number;
      tool_name?: string;
      tool_input?: unknown;
      tool_response?: unknown;
      cwd?: string;
    },
    worker: WorkerRef | undefined,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error(
        "Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.",
      );
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd,
    });

    session.conversationHistory.push({ role: "user", content: obsPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = "ingest";
    // 传当前 memorySessionId 作 resumeSessionId —— kimi 会用真实
    // session_xxx resume（init 时捕获的）。
    const obsResponse = await this.query(
      session.conversationHistory,
      session.memorySessionId,
    );
    // 若 kimi 在 obs 响应里返回了新的 session_id（重定向 / 失效后新建），
    // 捕获之；否则保留原值。
    this.captureMemorySessionId(obsResponse.sessionId, session);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({
        role: "assistant",
        content: obsResponse.content,
      });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(obsResponse);
    }

    // kimi text 模式经常返回 prose + XML 杂糅 —— 即便 content 形如空也
    // forward 给 processAgentResponse，让 parser/invalid-output 分类器判
    // 定（与 OpenRouterProvider 的 forwardEmptyMessageResponse=true 同思路，
    // 不像 Gemini 那样静默丢）
    await processAgentResponse(
      obsResponse.content || "",
      session,
      this.dbManager,
      this.sessionManager,
      worker,
      tokensUsed,
      originalTimestamp,
      this.config.providerName,
      lastCwd,
      obsResponse.servedModel ?? this.config.cmd,
    );
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    worker: WorkerRef | undefined,
    mode: ModeConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error(
        "Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.",
      );
    }

    const summaryPrompt = buildSummaryPrompt(
      {
        id: session.sessionDbId,
        memory_session_id: session.memorySessionId,
        project: session.project,
        user_prompt: session.userPrompt,
        last_assistant_message: message.last_assistant_message || "",
      },
      mode,
    );

    session.conversationHistory.push({ role: "user", content: summaryPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = "summarize";
    const summaryResponse = await this.query(
      session.conversationHistory,
      session.memorySessionId,
    );
    this.captureMemorySessionId(summaryResponse.sessionId, session);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({
        role: "assistant",
        content: summaryResponse.content,
      });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      session.lastUsage = this.buildLastUsage(summaryResponse);
    }

    await processAgentResponse(
      summaryResponse.content || "",
      session,
      this.dbManager,
      this.sessionManager,
      worker,
      tokensUsed,
      originalTimestamp,
      this.config.providerName,
      lastCwd,
      summaryResponse.servedModel ?? this.config.cmd,
    );
  }

  /**
   * Build session.lastUsage from a query result. kimi text 模式无 usage
   * 数据，**永远返回 null** —— 不把 chars/4 估算伪装成真实 input/output
   * 进 telemetry（OpenAICompatibleProvider.buildLastUsage 的「只在 provider
   * 真报数据时填 input/output」契约）。
   *
   * 注：cumulative token counters 仍会累加 tokensUsed（粗估），因为它们用于
   * history truncation 阈值，而非单次事件计费。
   */
  private buildLastUsage(
    _result: ProviderQueryResult,
  ): ActiveSession["lastUsage"] {
    return null;
  }

  /**
   * Truncate history when it grows past the configured limits. Mirrors
   * `OpenAICompatibleProvider.truncateHistory` with `requireNonEmptyToTruncate
   * = false` (OpenRouter behavior) so truncation kicks in as soon as either
   * limit is exceeded.
   *
   * Currently unused in the simple lifecycle (kimi -p only sends the last
   * user message, so history size doesn't directly bloat the wire) but
   * exported so Task 6 (content retry) can reuse it when constructing
   * smaller retry prompts.
   */
  private truncateHistory(
    history: ConversationMessage[],
    maxContextMessages: number = DEFAULT_MAX_CONTEXT_MESSAGES,
    maxEstimatedTokens: number = DEFAULT_MAX_ESTIMATED_TOKENS,
  ): ConversationMessage[] {
    if (history.length <= maxContextMessages) {
      const totalTokens = history.reduce(
        (sum, m) => sum + estimateTokensHeuristic(m.content),
        0,
      );
      if (totalTokens <= maxEstimatedTokens) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = estimateTokensHeuristic(msg.content);

      const overLimit =
        truncated.length >= maxContextMessages ||
        tokenCount + msgTokens > maxEstimatedTokens;
      if (truncated.length > 0 && overLimit) {
        logger.warn(
          "SDK",
          "Context window truncated to prevent runaway costs",
          {
            originalMessages: history.length,
            keptMessages: truncated.length,
            droppedMessages: i + 1,
            estimatedTokens: tokenCount,
            tokenLimit: maxEstimatedTokens,
          },
        );
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }

  private handleSessionError(
    error: unknown,
    session: ActiveSession,
    _worker?: WorkerRef,
  ): never {
    if (isAbortError(error)) {
      logger.warn("SDK", `${this.config.providerName} agent aborted`, {
        sessionId: session.sessionDbId,
      });
      throw error;
    }

    logger.failure(
      "SDK",
      `${this.config.providerName} agent error`,
      { sessionDbId: session.sessionDbId },
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  }
}
