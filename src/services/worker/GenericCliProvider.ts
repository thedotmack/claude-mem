import { execSync } from "child_process";
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
