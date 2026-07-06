import { execSync, spawn } from "child_process";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { USER_SETTINGS_PATH } from "../../shared/paths.js";

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
