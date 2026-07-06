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
 * Result of a CLI query. `content` carries stdout with the trailing
 * `To resume this session: ...` marker line stripped (prose +
 * `<observation>` XML remain) so it can be pushed verbatim into
 * `session.conversationHistory`; `sessionId` is the pre-extracted handle
 * for resume (parsed from the original raw stdout before stripping).
 */
export interface CliQueryResult {
  content: string;          // stdout（含 observation XML + 可能 prose，marker 已 strip）
  sessionId: string | null; // 从末尾 regex 抓（基于原始 raw）
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

/**
 * Regex matching the kimi-emitted resume marker line that always appears at
 * the tail of stdout: `To resume this session: kimi -r session_xxx`.
 *
 * Stripped from `parseCliOutput`'s returned `content` because that content is
 * pushed verbatim into `session.conversationHistory` as the assistant message
 * (see handleInitResponse / processObservationMessage / processSummaryMessage);
 * leaving the marker in place would inject resume-handle noise into every
 * subsequent prompt and bloat token usage.
 *
 * Anchored to end-of-string (`$`) without the `s` flag so it only matches a
 * trailing marker line and never a mid-content mention of the phrase. Eats
 * the preceding newline (and any trailing spaces/CR) so the result doesn't
 * end on a dangling blank line.
 */
const RESUME_MARKER_TAIL_RE = /[ \t]*\r?\n?To resume this session: [^\r\n]*$/;

/**
 * 从 CLI 原始 stdout 抽取 `content` + `sessionId`。
 *
 * - `content`：stdout 去掉末尾 `To resume this session: ...` marker 行后的
 *   prose + `<observation>` XML。该 content 会被原样 push 进
 *   `session.conversationHistory` 的 assistant message，strip 掉 marker 避免
 *   把 resume handle 噪音喂进后续 prompt（也省 token）。
 * - `sessionId`：从 **原始 `raw`**（未 strip）用 `config.sessionIdRegex` 抓
 *   **完整 "session_xxx"（含前缀）**，便于直接喂 `-r <sessionId>` /
 *   `-S <sessionId>`。无匹配返回 null。strip 只影响 content，不影响抽取。
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
    content: raw.replace(RESUME_MARKER_TAIL_RE, ""),
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

// ---------------------------------------------------------------------------
// Task 5: 传输层 retry（runWithTransientRetry 移植）
// ---------------------------------------------------------------------------
//
// 移植自 loop-engine/src/adapters/transient.ts 的 runWithTransientRetry，
// 但做了简化：kimi `--output-format text` 无结构化错误信封（loop-engine 的
// 版本要嗅探 is_error / NDJSON error 事件里的 api_error_status），这里只
// 按 exitCode 判定。brief 的注入点就是 `isTransient: r => r.exitCode !== 0`。
//
// **关键语义**：
//   - 原地重发同一调用（fresh spawn，非 resume），用满次数仍失败 → 返回末次结果
//   - exponential backoff：baseDelayMs * 2^attempt（attempt 从 0 起）
//   - resumeId 存在时 maxRetries=0（避免与 Task 6 内容层 retry 叠加 ——
//     resume 重放要求确定性，参考 loop-engine opencode.ts:194）
//   - sleepFn 可注入，便于测试 backoff 时序（loop-engine 同款设计）
//
// **不重试 throws**：defaultSpawn 在超时 / spawn error 事件时 reject，这些
// 异常会穿透本层直接上浮到 handleSessionError。理由：throws 里混了 ENOENT
// 这类永久错误，盲重试只是拖慢暴露（3.5s + 把"binary 缺失"伪装成"网络抖"）。
// 若后续要覆盖超时重试，应加 `isTransientError?: (e: unknown) => boolean`
// 显式白名单，而非无差别 catch。见 task-5-report.md「Known limitations」。

/** 传输层 retry 默认上限（fresh spawn 场景）。 */
export const DEFAULT_TRANSIENT_MAX_RETRIES = 3;

/** 传输层 retry 默认 base delay（ms），实际退避 = base * 2^attempt。 */
export const DEFAULT_TRANSIENT_BASE_DELAY_MS = 500;

type TransientRetryOpts<T> = {
  maxRetries: number;
  baseDelayMs: number;
  /** 命中返回 true 则重试；省略表示永不重试（首次结果即最终结果）。 */
  isTransient?: (r: T) => boolean;
  /** 退避 sleep 注入点（测试用）；默认 `setTimeout(resolve, ms)`。 */
  sleepFn?: (ms: number) => Promise<void>;
};

const defaultTransientSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 瞬时错误退避重试循环（移植自 loop-engine runWithTransientRetry，简化版）。
 *
 * 循环 `attempt = 0..maxRetries`：每次 await fn()，若结果非 transient 立即
 * 返回；否则（且未到末次）按 `baseDelayMs * 2^attempt` 退避后再试。用满
 * 次数仍 transient 则返回末次结果（交由调用方决定是否抛错 —— query() 里
 * 就是 `if (exitCode !== 0) throw`）。
 *
 * **不 catch fn() 抛出的异常**：throws 直接上浮，不进入重试。这样 ENOENT
 * / SIGKILL 等永久错误不会被伪装成瞬时错误浪费退避时间。
 *
 * @param fn   单次尝试（无参，闭包捕获 spawn 调用）
 * @param opts maxRetries / baseDelayMs / isTransient / sleepFn
 * @returns    末次结果（成功或末次失败）
 */
export async function runWithTransientRetry<T>(
  fn: () => Promise<T>,
  opts: TransientRetryOpts<T>,
): Promise<T> {
  const {
    maxRetries,
    baseDelayMs,
    isTransient,
    sleepFn = defaultTransientSleep,
  } = opts;
  let last: T | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await fn();
    // 非 transient（或 isTransient 省略）→ 首次即最终，直接返回
    if (!isTransient || !isTransient(last)) return last;
    // 末次（attempt === maxRetries）不再退避，跳出返回 last
    if (attempt < maxRetries) {
      const delay = baseDelayMs * 2 ** attempt;
      await sleepFn(delay);
    }
  }
  return last as T;
}

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
   *
   * Visibility is `protected` (not `private`) so Task 6's outer
   * `queryWithContentRetry` wrapper — living in a sibling module or a
   * thin subclass — can call `query` directly without exposing it on the
   * public API.
   */
  protected async query(
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

    const { stdout, exitCode } = await runWithTransientRetry(
      () => this.spawnFn(this.config.cmd, args),
      {
        // resumeId 存在时 maxRetries=0：避免与 Task 6 内容层 retry 叠加
        // （resume 重放要求确定性，参考 loop-engine opencode.ts:194）。
        // fresh spawn 才走传输层 retry（DEFAULT_TRANSIENT_MAX_RETRIES=3）。
        maxRetries: resumeSessionId ? 0 : DEFAULT_TRANSIENT_MAX_RETRIES,
        baseDelayMs: DEFAULT_TRANSIENT_BASE_DELAY_MS,
        // 只按 exitCode 判定；throws（timeout/ENOENT）穿透本层不重试。
        isTransient: (r) => r.exitCode !== 0,
      },
    );
    const parsed = parseCliOutput(stdout, this.config);

    if (exitCode !== 0) {
      // 末次尝试仍非零退出（传输层 retry 已用尽，或 resumeId 场景 maxRetries=0
      // 直接走到这里）—— 上浮到 handleSessionError 分类处理。
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
