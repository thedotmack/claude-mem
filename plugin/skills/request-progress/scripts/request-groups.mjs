// src/services/work-view/request-groups.mjs
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync as mkdirSync4, readFileSync as readFileSync6, readdirSync, renameSync as renameSync2, statSync as statSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join7 } from "node:path";

// src/services/work-view/work-product.mjs
var FILE_KINDS = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".pdf": "document",
  ".docx": "document",
  ".pptx": "deck",
  ".key": "deck",
  ".xlsx": "spreadsheet",
  ".csv": "spreadsheet",
  ".html": "page"
};
var GIT_PREFIX = String.raw`(?:^|[;&|(\n])\s*(?:rtk\s+)?(?:\/usr\/bin\/)?git(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+`;
var FILE_EXTENSION_PATTERN = Object.keys(FILE_KINDS).map((extension) => `files_modified LIKE '%${extension}"%'`).join(" OR ");

// src/services/work-view/session-project.mjs
import { existsSync as existsSync7, realpathSync as realpathSync4 } from "node:fs";
import { homedir as homedir5, tmpdir as tmpdir2 } from "node:os";
import { basename as basename5, dirname as dirname5, join as join6, resolve as resolve2 } from "node:path";

// src/utils/project-name.ts
import path2 from "path";
import { existsSync as existsSync6, realpathSync as realpathSync3, statSync as statSync4 } from "fs";
import { homedir as homedir4, tmpdir } from "os";
import { execFileSync } from "child_process";

// src/shared/expand-home.ts
import { homedir } from "os";
import { join } from "path";
function expandHome(filePath, platform = process.platform, home = homedir()) {
  if (typeof filePath !== "string" || filePath.length === 0) return filePath;
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || platform === "win32" && filePath.startsWith("~\\")) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

// src/shared/paths.ts
import { join as join3, dirname as dirname2, basename as basename2 } from "path";
import { homedir as homedir2 } from "os";
import { existsSync as existsSync2, mkdirSync as mkdirSync2 } from "fs";
import { fileURLToPath } from "url";

// src/shared/atomic-json.ts
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "fs";
import { randomBytes } from "crypto";
import { basename, dirname, join as join2, resolve } from "path";

// src/shared/hook-io.ts
var pinnedBypassWrite = null;
function bypassWrite(chunk) {
  const writer = pinnedBypassWrite ?? process.stderr.write.bind(process.stderr);
  return writer(chunk);
}
function emitDiagnostic(line) {
  bypassWrite(line);
}
var pendingModelContext = Promise.resolve();

// src/shared/atomic-json.ts
var IS_WINDOWS_PLATFORM = process.platform === "win32";
function stripUtf8Bom(raw) {
  return raw.replace(/^\uFEFF/, "");
}
function parseJsonWithBom(raw) {
  return JSON.parse(stripUtf8Bom(raw));
}
function readJsonFileWithBom(filepath) {
  return parseJsonWithBom(readFileSync(filepath, "utf-8"));
}
function ensureDirectoryExists(directoryPath) {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}
function physicalPathOf(filePath) {
  try {
    return realpathSync(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const parent = dirname(filePath);
    if (parent === filePath) return filePath;
    return join2(physicalPathOf(parent), basename(filePath));
  }
}
function resolveSymlinkWriteTarget(filePath) {
  let resolved = filePath;
  const followed = /* @__PURE__ */ new Set();
  try {
    while (lstatSync(resolved).isSymbolicLink()) {
      const absolute = resolve(resolved);
      if (followed.has(absolute)) {
        throw Object.assign(new Error(`Symlink loop at ${resolved}`), { code: "ELOOP" });
      }
      followed.add(absolute);
      try {
        return realpathSync(resolved);
      } catch (realpathErr) {
        if (realpathErr.code !== "ENOENT") throw realpathErr;
        const realpathError = realpathErr instanceof Error ? realpathErr : new Error(String(realpathErr));
        emitDiagnostic(`claude-mem: realpathSync failed for ${resolved}, resolving symlink manually: ${realpathError.message}
`);
        const linkTarget = readlinkSync(resolved);
        resolved = resolve(physicalPathOf(dirname(resolve(resolved))), linkTarget);
      }
    }
  } catch (err) {
    const code = err.code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
  return resolved;
}
var WINDOWS_RENAME_RETRY_CODES = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
var WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function renameWithWindowsRetry(from, to, rename = renameSync, onWindows = IS_WINDOWS_PLATFORM) {
  if (!onWindows) return rename(from, to);
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = err.code ?? "";
      if (attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length || !WINDOWS_RENAME_RETRY_CODES.has(code)) {
        throw err;
      }
      sleepSync(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}
function writeJsonFileAtomic(filepath, data, options = {}) {
  const resolved = resolveSymlinkWriteTarget(filepath);
  ensureDirectoryExists(dirname(resolved));
  const dir = dirname(resolved);
  const base = basename(resolved);
  const tmpPath = join2(dir, `.${base}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const payload = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf-8");
  let mode = options.mode;
  if (mode === void 0) {
    try {
      mode = statSync(resolved).mode & 511;
    } catch {
    }
  }
  let fd;
  try {
    fd = mode !== void 0 ? openSync(tmpPath, "w", mode) : openSync(tmpPath, "w");
    let written = 0;
    while (written < payload.length) {
      const n = writeSync(fd, payload, written, payload.length - written);
      if (n === 0) {
        throw new Error(`writeSync stalled at ${written}/${payload.length} bytes`);
      }
      written += n;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = void 0;
    renameWithWindowsRetry(tmpPath, resolved);
    if (!IS_WINDOWS_PLATFORM) {
      let dirFd;
      try {
        dirFd = openSync(dir, "r");
        fsyncSync(dirFd);
      } catch (dirSyncErr) {
        const dirSyncError = dirSyncErr instanceof Error ? dirSyncErr : new Error(String(dirSyncErr));
        emitDiagnostic(`claude-mem: directory fsync failed for ${dir}: ${dirSyncError.message}
`);
      } finally {
        if (dirFd !== void 0) {
          try {
            closeSync(dirFd);
          } catch {
          }
        }
      }
    }
  } catch (err) {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}

// src/shared/settings-document.ts
var isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function classifySettingsDocument(document) {
  const env = document.env;
  return isRecord(env) && Object.keys(env).some((key) => key.startsWith("CLAUDE_MEM_")) ? "nested" : "flat";
}
function settingsTarget(document) {
  return classifySettingsDocument(document) === "nested" ? document.env : document;
}
function withoutStaleRootCopies(document) {
  if (classifySettingsDocument(document) !== "nested") return document;
  return Object.fromEntries(Object.entries(document).filter(([key]) => !key.startsWith("CLAUDE_MEM_")));
}

// src/shared/paths.ts
function getDirname() {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return dirname2(fileURLToPath(import.meta.url));
}
var _dirname = getDirname();
function resolveDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  }
  const defaultDataDir = join3(homedir2(), ".claude-mem");
  const settingsPath = join3(defaultDataDir, "settings.json");
  try {
    if (existsSync2(settingsPath)) {
      const raw = readJsonFileWithBom(settingsPath);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultDataDir;
      const settings = settingsTarget(raw);
      if (typeof settings.CLAUDE_MEM_DATA_DIR === "string" && settings.CLAUDE_MEM_DATA_DIR) {
        return expandHome(settings.CLAUDE_MEM_DATA_DIR);
      }
    }
  } catch {
  }
  return defaultDataDir;
}
var DATA_DIR = resolveDataDir();
var DEFAULT_CLAUDE_CONFIG_DIR = join3(homedir2(), ".claude");
var CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR;
var MARKETPLACE_ROOT = join3(CLAUDE_CONFIG_DIR, "plugins", "marketplaces", "thedotmack");
var LOGS_DIR = join3(DATA_DIR, "logs");
var USER_SETTINGS_PATH = join3(DATA_DIR, "settings.json");
var DB_FILENAME = "claude-mem.db";
var DB_PATH = join3(DATA_DIR, DB_FILENAME);
var OBSERVER_SESSIONS_DIR = join3(DATA_DIR, "observer-sessions");
var OBSERVER_SESSIONS_PROJECT = basename2(OBSERVER_SESSIONS_DIR);
var paths = {
  dataDir: () => DATA_DIR,
  workerPid: () => join3(DATA_DIR, "worker.pid"),
  workerHeartbeat: () => join3(DATA_DIR, "worker-heartbeat.json"),
  // Phase 1b: identifier renamed to `server*`; the on-disk file basenames
  // remain `.server-beta.*` so existing installations keep finding their
  // pid/port/runtime state. Plan §1d will migrate the basenames.
  serverPid: () => join3(DATA_DIR, ".server-beta.pid"),
  serverPort: () => join3(DATA_DIR, ".server-beta.port"),
  serverRuntime: () => join3(DATA_DIR, ".server-beta.runtime.json"),
  settings: () => join3(DATA_DIR, "settings.json"),
  database: () => join3(DATA_DIR, DB_FILENAME),
  chroma: () => join3(DATA_DIR, "chroma"),
  combinedCerts: () => join3(DATA_DIR, "combined_certs.pem"),
  transcriptsConfig: () => join3(DATA_DIR, "transcript-watch.json"),
  transcriptsState: () => join3(DATA_DIR, "transcript-watch-state.json"),
  corpora: () => join3(DATA_DIR, "corpora"),
  supervisorRegistry: () => join3(DATA_DIR, "supervisor.json"),
  envFile: () => join3(DATA_DIR, ".env"),
  logsDir: () => LOGS_DIR
};

// src/shared/SettingsDefaultsManager.ts
import { readFileSync as readFileSync4, existsSync as existsSync4, writeFileSync } from "fs";
import { basename as basename3, dirname as dirname4, join as join5 } from "path";
import { homedir as homedir3, hostname } from "os";

// src/shared/hook-constants.ts
var SESSION_INIT_HOOK_CAP_MS = 15e3;
var HOOK_TIMEOUTS = {
  HEALTH_CHECK: 3e3,
  // Worker health check (3s — healthy worker responds in <100ms)
  API_REQUEST: 3e4,
  // Hook API calls should outlive health probes but stay below hook caps
  SESSION_INIT_HOOK_CAP: SESSION_INIT_HOOK_CAP_MS,
  SESSION_INIT_REQUEST: 1e4,
  // POSIX default for the whole session-init round-trip (plan-17 step 3): the cap minus the hook's own overhead; never Windows-scaled up
  SESSION_INIT_REQUEST_MAX: SESSION_INIT_HOOK_CAP_MS - 1e3,
  // Upper bound for CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS: process-exit margin below the cap
  HOOK_READINESS_WAIT: 1e4,
  // Per-hook wait for an already-starting worker to finish DB/search init
  POST_SPAWN_WAIT: 15e3,
  // Wait for daemon to start after spawn (starts in <1s on Linux, 6-8s on macOS with Chroma)
  READINESS_WAIT: 3e4,
  // Wait for DB + search init after spawn (typically <5s)
  PORT_IN_USE_WAIT: 3e3,
  // Wait when port occupied but health failing
  POWERSHELL_COMMAND: 1e4,
  // PowerShell process enumeration (10s - typically completes in <1s)
  WINDOWS_MULTIPLIER: 1.5
};
function hookProcessOverheadMs(platform = process.platform) {
  return platform === "win32" ? 8e3 : 5e3;
}
function defaultSessionInitRequestTimeoutMs(platform = process.platform) {
  return HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP - hookProcessOverheadMs(platform);
}
function getTimeout(baseTimeout) {
  return process.platform === "win32" ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER) : baseTimeout;
}

// src/utils/logger.ts
import { closeSync as closeSync2, existsSync as existsSync3, fstatSync, mkdirSync as mkdirSync3, openSync as openSync2, statSync as statSync2, writeSync as writeSync2 } from "fs";
import { dirname as dirname3, join as join4 } from "path";
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["DEBUG"] = 0] = "DEBUG";
  LogLevel2[LogLevel2["INFO"] = 1] = "INFO";
  LogLevel2[LogLevel2["WARN"] = 2] = "WARN";
  LogLevel2[LogLevel2["ERROR"] = 3] = "ERROR";
  LogLevel2[LogLevel2["SILENT"] = 4] = "SILENT";
  return LogLevel2;
})(LogLevel || {});
var errorSink = null;
var Logger = class {
  level = null;
  useColor;
  logFilePath = null;
  logFileInitialized = false;
  logFileDate = null;
  logFd = null;
  constructor() {
    this.useColor = process.stdout.isTTY ?? false;
  }
  ensureLogFileInitialized() {
    const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    if (this.logFileInitialized && this.logFileDate === date) return;
    const firstAttemptToday = this.logFileDate !== date;
    this.closeLogFd();
    this.logFileInitialized = false;
    this.logFileDate = date;
    try {
      const logsDir = paths.logsDir();
      if (!existsSync3(logsDir)) {
        mkdirSync3(logsDir, { recursive: true });
      }
      this.logFilePath = join4(logsDir, `claude-mem-${date}.log`);
      this.logFileInitialized = true;
    } catch (error) {
      if (firstAttemptToday) {
        console.error("[LOGGER] Failed to initialize log file:", error instanceof Error ? error.message : String(error));
      }
      this.logFilePath = null;
    }
  }
  closeLogFd() {
    if (this.logFd === null) return;
    try {
      closeSync2(this.logFd);
    } catch {
    }
    this.logFd = null;
  }
  /**
   * Appends through one file descriptor kept open for the whole day.
   * On-access antivirus can scan a file each time it is opened: Microsoft
   * Defender on macOS runs as an Endpoint Security client, and ES can hold an
   * open (AUTH_OPEN) but has no auth event for write or stat. Re-opening the
   * day log per line (appendFileSync) was measured at up to 2 s per open
   * under load; this runs on the worker's event loop, and in that state
   * /api/health went silent and the worker was reclaimed as wedged. Opening
   * once a day avoids the per-line open. The stat of the path detects an
   * external rename, delete or replace, and the next line re-opens the file.
   */
  appendLine(path3, text) {
    if (this.logFd !== null) {
      let current = false;
      try {
        const open = fstatSync(this.logFd);
        const onDisk = statSync2(path3);
        current = open.ino === onDisk.ino && open.dev === onDisk.dev;
      } catch {
      }
      if (!current) this.closeLogFd();
    }
    if (this.logFd === null) {
      mkdirSync3(dirname3(path3), { recursive: true });
      this.logFd = openSync2(path3, "a");
    }
    try {
      let bytes = Buffer.from(text, "utf8");
      while (bytes.length > 0) {
        const written = writeSync2(this.logFd, bytes);
        if (written <= 0) throw new Error("log write accepted 0 bytes");
        bytes = bytes.subarray(written);
      }
    } catch (error) {
      this.closeLogFd();
      throw error;
    }
  }
  getLevel() {
    if (this.level === null) {
      try {
        const settingsPath = paths.settings();
        if (existsSync3(settingsPath)) {
          const settings = settingsTarget(readJsonFileWithBom(settingsPath));
          const envLevel = (settings.CLAUDE_MEM_LOG_LEVEL || "INFO").toString().toUpperCase();
          this.level = LogLevel[envLevel] ?? 1 /* INFO */;
        } else {
          this.level = 1 /* INFO */;
        }
      } catch (error) {
        console.error("[LOGGER] Failed to load log level from settings:", error instanceof Error ? error.message : String(error));
        this.level = 1 /* INFO */;
      }
    }
    return this.level;
  }
  /**
   * Serialize a value to JSON without ever overflowing the stack.
   *
   * `JSON.stringify` recurses through the whole object graph, so a deeply
   * nested or self-referential payload throws `RangeError: Maximum call stack
   * size exceeded` — and logging must never crash its caller. This walks the
   * value to a fixed depth (cheap, bounded stack), replacing anything deeper,
   * any cycle, or any BigInt with a marker, then stringifies the pruned,
   * guaranteed-finite result.
   */
  safeStringify(data, indent, maxDepth = 6) {
    const seen = /* @__PURE__ */ new WeakSet();
    const prune = (rawValue, depth) => {
      if (typeof rawValue === "bigint") return `${rawValue}n`;
      if (rawValue === null || typeof rawValue !== "object") return rawValue;
      const toJSON = rawValue.toJSON;
      const value = typeof toJSON === "function" ? toJSON.call(rawValue) : rawValue;
      if (typeof value === "bigint") return `${value}n`;
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return "[Circular]";
      if (depth >= maxDepth) return Array.isArray(value) ? "[Array]" : "[Object]";
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((item) => prune(item, depth + 1));
        }
        const out = {};
        for (const key of Object.keys(value)) {
          try {
            out[key] = prune(value[key], depth + 1);
          } catch {
            out[key] = "[unreadable]";
          }
        }
        return out;
      } finally {
        seen.delete(value);
      }
    };
    try {
      return JSON.stringify(prune(data, 0), null, indent) ?? String(data);
    } catch {
      return Array.isArray(data) ? `[${data.length} items]` : "[unserializable]";
    }
  }
  formatData(data) {
    if (data === null || data === void 0) return "";
    if (typeof data === "string") return data;
    if (typeof data === "number") return data.toString();
    if (typeof data === "boolean") return data.toString();
    if (typeof data === "object") {
      if (data instanceof Error) {
        return this.getLevel() === 0 /* DEBUG */ ? `${data.message}
${data.stack}` : data.message;
      }
      if (Array.isArray(data)) {
        return `[${data.length} items]`;
      }
      const keys = Object.keys(data);
      if (keys.length === 0) return "{}";
      if (keys.length <= 3) {
        return this.safeStringify(data);
      }
      return `{${keys.length} keys: ${keys.slice(0, 3).join(", ")}...}`;
    }
    return String(data);
  }
  formatTool(toolName, toolInput) {
    if (!toolInput) return toolName;
    let input = toolInput;
    if (typeof toolInput === "string") {
      try {
        input = JSON.parse(toolInput);
      } catch {
        input = toolInput;
      }
    }
    if (input === null) return toolName;
    if (toolName === "Bash" && input.command) {
      return `${toolName}(${input.command})`;
    }
    if (input.file_path) {
      return `${toolName}(${input.file_path})`;
    }
    if (input.notebook_path) {
      return `${toolName}(${input.notebook_path})`;
    }
    if (toolName === "Glob" && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }
    if (toolName === "Grep" && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }
    if (input.url) {
      return `${toolName}(${input.url})`;
    }
    if (input.query) {
      return `${toolName}(${input.query})`;
    }
    if (toolName === "Task") {
      if (input.subagent_type) {
        return `${toolName}(${input.subagent_type})`;
      }
      if (input.description) {
        return `${toolName}(${input.description})`;
      }
    }
    if (toolName === "Skill" && input.skill) {
      return `${toolName}(${input.skill})`;
    }
    if (toolName === "LSP" && input.operation) {
      return `${toolName}(${input.operation})`;
    }
    return toolName;
  }
  formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  }
  log(level, component, message, context, data) {
    if (level < this.getLevel()) return;
    this.ensureLogFileInitialized();
    const timestamp = this.formatTimestamp(/* @__PURE__ */ new Date());
    const levelStr = LogLevel[level].padEnd(5);
    const componentStr = component.padEnd(6);
    let correlationStr = "";
    if (context?.correlationId) {
      correlationStr = `[${context.correlationId}] `;
    } else if (context?.sessionId) {
      correlationStr = `[session-${context.sessionId}] `;
    }
    let dataStr = "";
    if (data !== void 0 && data !== null) {
      if (data instanceof Error) {
        dataStr = this.getLevel() === 0 /* DEBUG */ ? `
${data.message}
${data.stack}` : ` ${data.message}`;
      } else if (this.getLevel() === 0 /* DEBUG */ && typeof data === "object") {
        dataStr = "\n" + this.safeStringify(data, 2);
      } else {
        dataStr = " " + this.formatData(data);
      }
    }
    let contextStr = "";
    if (context) {
      const { sessionId, memorySessionId, correlationId, ...rest } = context;
      if (Object.keys(rest).length > 0) {
        const pairs = Object.entries(rest).map(([k, v]) => {
          if (typeof v !== "object" || v === null || v instanceof Error || v instanceof Date) return `${k}=${v}`;
          return `${k}=${Array.isArray(v) ? this.safeStringify(v) : this.formatData(v)}`;
        });
        contextStr = ` {${pairs.join(", ")}}`;
      }
    }
    const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;
    if (this.logFilePath) {
      try {
        this.appendLine(this.logFilePath, logLine + "\n");
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        emitDiagnostic(`[LOGGER] Failed to write to log file: ${err.message}
${err.stack ?? ""}
`);
      }
    } else {
      emitDiagnostic(logLine + "\n");
    }
  }
  debug(component, message, context, data) {
    this.log(0 /* DEBUG */, component, message, context, data);
  }
  info(component, message, context, data) {
    this.log(1 /* INFO */, component, message, context, data);
  }
  warn(component, message, context, data) {
    this.log(2 /* WARN */, component, message, context, data);
  }
  /**
   * Installs (or clears, with null) the optional error sink. Called once by
   * worker/telemetry init to bridge logged errors into captureException without
   * the logger importing telemetry (no import cycle). Never throws.
   */
  setErrorSink(sink) {
    errorSink = sink;
  }
  error(component, message, context, data) {
    this.log(3 /* ERROR */, component, message, context, data);
    this.routeErrorToSink(message, context, data);
  }
  /**
   * Routes a logged Error through the optional error sink (captureException).
   * Only fires when `data` is an actual Error so we never ship arbitrary log
   * payloads as exceptions. Swallow-all: the sink failing (or being absent)
   * must never break logging. `failure()` delegates to `error()`, so it is
   * covered too — but it passes the same `data` object, so we de-dupe by only
   * routing from the single `error()` entry point.
   */
  routeErrorToSink(message, context, data) {
    try {
      if (!errorSink || !(data instanceof Error)) return;
      errorSink(data);
    } catch {
    }
  }
  dataIn(component, message, context, data) {
    this.info(component, `\u2192 ${message}`, context, data);
  }
  dataOut(component, message, context, data) {
    this.info(component, `\u2190 ${message}`, context, data);
  }
  success(component, message, context, data) {
    this.info(component, `\u2713 ${message}`, context, data);
  }
  failure(component, message, context, data) {
    this.error(component, `\u2717 ${message}`, context, data);
  }
};
var logger = new Logger();

// src/shared/openrouter-base-url.ts
function isOpenRouterApiUrl(apiUrl) {
  try {
    return new URL(apiUrl).hostname.toLowerCase() === "openrouter.ai";
  } catch {
    return false;
  }
}

// src/shared/SettingsDefaultsManager.ts
var LEGACY_TELEGRAM_TRIGGER_TYPES = "security_alert";
var LEGACY_CLOUD_SYNC_HUB_HOST = "sync-hub.black-pond-afbb.workers.dev";
var DIRECT_SUPABASE_CLOUD_SYNC_HUB_HOST = "ziczmqtpmaxbornfghye.supabase.co";
var CANONICAL_CLOUD_SYNC_HUB_URL = "https://sync.cmem.ai";
var RETIRED_OPENROUTER_DEFAULT_MODELS = /* @__PURE__ */ new Set([
  "xiaomi/mimo-v2-flash:free"
]);
function coercePersistedSettingValue(value) {
  return typeof value === "boolean" ? String(value) : value;
}
function hasRetiredOpenRouterDefault(flatSettings) {
  const model = flatSettings.CLAUDE_MEM_OPENROUTER_MODEL;
  if (typeof model !== "string" || !RETIRED_OPENROUTER_DEFAULT_MODELS.has(model.trim())) {
    return false;
  }
  const baseUrl = typeof flatSettings.CLAUDE_MEM_OPENROUTER_BASE_URL === "string" ? flatSettings.CLAUDE_MEM_OPENROUTER_BASE_URL.trim() : "";
  return baseUrl === "" || isOpenRouterApiUrl(baseUrl);
}
var DEFAULT_LLM_TIMEOUT_MS = 18e4;
var RAISED_DEADLINE_DEFAULTS = [
  // Seeded from #4125 (13.25.2) until #4278.
  { key: "CLAUDE_MEM_LLM_TIMEOUT_MS", legacy: "30000", markerTag: "llm-timeout-migrated-v1" },
  // Seeded from #4136 until the field pass got the same deadline.
  { key: "CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS", legacy: "30000", markerTag: "field-optimize-timeout-migrated-v1" }
];
function raisedDefaultMarkerPath(settingsPath, raised) {
  return join5(dirname4(settingsPath), `.${basename3(settingsPath)}.${raised.markerTag}`);
}
function markRaisedDefaultDone(settingsPath, raised) {
  try {
    writeFileSync(raisedDefaultMarkerPath(settingsPath, raised), (/* @__PURE__ */ new Date()).toISOString(), {
      encoding: "utf-8",
      mode: 384
    });
  } catch {
  }
}
var raisedDefaultFailuresReported = /* @__PURE__ */ new Set();
function migratedCloudSyncHubUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const hostname2 = new URL(trimmed).hostname;
    if (hostname2 === LEGACY_CLOUD_SYNC_HUB_HOST || hostname2 === DIRECT_SUPABASE_CLOUD_SYNC_HUB_HOST) {
      return CANONICAL_CLOUD_SYNC_HUB_URL;
    }
  } catch {
    return null;
  }
  return null;
}
var SettingsDefaultsManager = class {
  static DEFAULTS = {
    CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED: "true",
    CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: "true",
    // Explicit JSON [{path, project, platformSource?}]. Empty means no files imported.
    CLAUDE_MEM_MEMORY_WATCH_ROOTS: "",
    CLAUDE_MEM_MODEL: "claude-haiku-4-5-20251001",
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: "50",
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: "false",
    CLAUDE_MEM_CONTEXT_PROJECTS: "current",
    // 'current' = this checkout only; 'all' = SessionStart context spans every project
    CLAUDE_MEM_WORKER_PORT: String(37700 + (process.getuid?.() ?? 77) % 100),
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_WORKER_INGEST_TOKEN: "",
    CLAUDE_MEM_WORKER_INGEST_MAX_BYTES: "5242880",
    CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: "auto",
    CLAUDE_MEM_ALLOWED_ORIGINS: "",
    // Comma-separated browser origins allowed to call the worker
    // cross-origin besides http://localhost:* / http://127.0.0.1:*.
    // Their host names also pass the DNS-rebinding Host check.
    CLAUDE_MEM_PUBLIC_URL: "",
    // Browser-reachable base for the live-view URL when the
    // worker runs behind a port-forward (e.g.
    // https://37700.host.<user>.<domain>). Empty => localhost.
    CLAUDE_MEM_API_TIMEOUT_MS: String(getTimeout(HOOK_TIMEOUTS.API_REQUEST)),
    CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS: String(defaultSessionInitRequestTimeoutMs()),
    // 10s; 7s on Windows, whose hook start-up the budget never sees
    // Worker idle exit (opt-in; minimum 60): after this many seconds with no
    // session activity, no queued work, no open or recent requests and no AI
    // interaction, the worker shuts itself down through the graceful stop
    // sequence (shutdown_reason 'idle'). The next hook that reads memory
    // starts it again. Never armed with CLAUDE_MEM_WORKER_AUTOSTART=false or
    // while transcript watches run.
    CLAUDE_MEM_IDLE_EXIT_SEC: "0",
    CLAUDE_MEM_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
    CLAUDE_MEM_SKIP_BASH_PATTERNS: "",
    // Regex matched against a shell command (Bash; PowerShell; Codex exec_command); when it matches, the observation is skipped. Empty = capture every command. Use alternation for several patterns, e.g. ^(ls|cat|pwd)\b
    CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: "false",
    // #2736 — default off preserves current behavior; set 'true' to skip every subagent observation (recommended for heavy Dynamic Workflows users)
    CLAUDE_MEM_SKIP_AGENT_TYPES: "",
    // #2736 — default empty preserves current behavior; recommended value 'workflow-subagent' to drop Dynamic Workflows fan-out noise
    CLAUDE_MEM_CAPTURE_ADVISOR_CALLS: "false",
    // #3165 — opt-in: the Stop hook scans the transcript's tail for advisor calls and stores the advice locally (worker runtime only)
    // Deliberate divergence from the installer prompt: the interactive
    // provider prompt defaults to 'cmem' (the hosted observer), but headless
    // installs land here — no delivered key exists headlessly, so the settings
    // default stays 'claude'.
    CLAUDE_MEM_PROVIDER: "claude",
    CLAUDE_MEM_CODEX_MODEL: "",
    // Empty uses the Codex default model.
    CLAUDE_MEM_CODEX_PATH: "codex",
    CLAUDE_MEM_CODEX_REASONING_EFFORT: "low",
    CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS: "2",
    CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE: "8",
    CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS: "32000",
    CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE: "1",
    // Queued same-context events per Claude observer prompt (1-32). 1 = one event per prompt.
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: "subscription",
    // Default to logged-in Claude SDK auth (not API key)
    CLAUDE_MEM_GEMINI_API_KEY: "",
    // Empty by default, can be set via UI or env
    CLAUDE_MEM_GEMINI_API_KEYS: "",
    // Optional extra keys (newline/comma separated). Rotates on rate_limit/quota_exhausted/auth_invalid — see src/shared/api-key-pool.ts.
    CLAUDE_MEM_GEMINI_MODEL: "gemini-flash-latest",
    // Google-maintained alias → current GA Flash model (stays valid for new API keys)
    CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: "true",
    // Rate limiting ON by default for free tier users
    CLAUDE_MEM_OPENROUTER_API_KEY: "",
    // Empty by default, can be set via UI or env
    CLAUDE_MEM_OPENROUTER_API_KEYS: "",
    // Optional extra keys (newline/comma separated). Rotates on rate_limit/quota_exhausted/auth_invalid — see src/shared/api-key-pool.ts.
    // Default OpenRouter model (free tier). The same id is hard-coded in
    // src/ui/viewer/constants/settings.ts (DEFAULT_SETTINGS) and three times in
    // openclaw/install.sh (settings defaults, openrouter override, completion
    // summary); tests/shared/settings-defaults-manager.test.ts keeps them equal.
    // Changing it strands installs that were seeded with the old id: add that
    // id to RETIRED_OPENROUTER_DEFAULT_MODELS.
    CLAUDE_MEM_OPENROUTER_MODEL: "cohere/north-mini-code:free",
    CLAUDE_MEM_OPENROUTER_BASE_URL: "",
    // #2382/#2590/#2622/#2393 — optional OpenAI-compatible base URL (e.g. https://api.deepseek.com, http://localhost:1234/v1). Empty = default OpenRouter endpoint.
    CLAUDE_MEM_OPENROUTER_TEMPERATURE: "",
    CLAUDE_MEM_OPENROUTER_SITE_URL: "",
    // Optional: for OpenRouter analytics
    CLAUDE_MEM_OPENROUTER_APP_NAME: "claude-mem",
    // App name for OpenRouter analytics
    // JSON object of provider-specific request fields, e.g. {"reasoning":{"enabled":false}}.
    // Settings file or env only (never the HTTP settings API); never sent to the cmem gateway.
    CLAUDE_MEM_OPENROUTER_EXTRA_BODY: "",
    CLAUDE_MEM_OPENROUTER_REASONING_EFFORT: "",
    // none | minimal | low | medium | high. Empty disables reasoning on openrouter.ai and the cmem gateway. A set effort is openrouter.ai only.
    CLAUDE_MEM_OPENAI_COMPAT_PRESET: "",
    // Named endpoint preset for the openai-compatible provider (nvidia-nim, deepseek, groq, together, vllm, ollama, lmstudio). Empty = 'custom', configure the base URL by hand.
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: "",
    // Key for the openai-compatible provider. Never shares the OpenRouter key or its attribution headers.
    CLAUDE_MEM_OPENAI_COMPAT_API_KEYS: "",
    // Optional extra keys (newline/comma separated) for the openai-compatible provider.
    CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: "",
    // OpenAI-compatible base URL, e.g. https://integrate.api.nvidia.com/v1. Overrides the preset's base URL when set.
    CLAUDE_MEM_OPENAI_COMPAT_MODEL: "",
    // Model id passed verbatim. Empty = the preset's default model.
    CLAUDE_MEM_OPENAI_COMPAT_REASONING: "",
    // off | on. Empty = off: every openai-compatible request sends reasoning:{enabled:false}. "on" leaves reasoning to the endpoint.
    CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: "claude",
    // 'claude' (the Anthropic plan; '' means this too) | 'gemini' | 'openrouter' | 'openai-compatible' | 'off': where observer work goes while the selected provider cannot serve (spent allowance, rate limit or over capacity past its retries, outage, repeated unusable replies). Claude is used only when a Claude login or key exists
    CLAUDE_MEM_QUOTA_FALLBACK_MODEL: "",
    // Claude model for a Claude fallback run; '' = CLAUDE_MEM_MODEL and tier routing. Ignored for other fallbacks (only ClaudeProvider reads modelOverride)
    CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD: "",
    // '' (off) | 'subscription' | 'api-key': the Claude credential to run on while the primary one is held for quota. 'subscription': the Claude Code login, for a spent ANTHROPIC_API_KEY. 'api-key': ANTHROPIC_FALLBACK_API_KEY from .env, for a login that is spent or paused by the quota guard. Tried before CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER
    CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR: "0.95",
    // Quota guard (#4230): subscription observer stops at this utilization of the window. A provider rejection always stops it
    CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY: "0.93",
    CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS: "0.93",
    CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET: "0.92",
    CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE: "0.95",
    CLAUDE_MEM_DATA_DIR: join5(homedir3(), ".claude-mem"),
    CLAUDE_MEM_LOG_LEVEL: "INFO",
    CLAUDE_MEM_PYTHON_VERSION: "3.13",
    CLAUDE_CODE_PATH: "",
    // Empty means auto-detect via 'which claude'
    CLAUDE_MEM_CLAUDE_CONFIG_DIR: "",
    // #2753 — override CLAUDE_CONFIG_DIR for the keychain lookup + SDK subprocess only; empty = fall through to process.env.CLAUDE_CONFIG_DIR/default
    CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: "",
    // #4689 — transcript-only CLAUDE_CONFIG_DIR for the SDK subprocess (out of ~/.claude/projects); credentials stay on the default profile; only honored when CLAUDE_MEM_CLAUDE_CONFIG_DIR is empty
    CLAUDE_MEM_MODE: "code",
    // Default mode profile
    CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: "false",
    CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: "false",
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: "false",
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: "true",
    CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: "",
    // Comma-separated observation types to inject. Empty = every type in the active mode
    CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: "",
    // Comma-separated observation concepts to inject. Empty = every concept in the active mode
    CLAUDE_MEM_CONTEXT_FULL_COUNT: "0",
    CLAUDE_MEM_CONTEXT_FULL_FIELD: "narrative",
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: "10",
    CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: "true",
    CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: "false",
    CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY: "true",
    CLAUDE_MEM_REINFORCE_ALPHA: "0",
    // ACT-R reinforcement weight for SessionStart ranking. 0 = off (the N most recent observations, unchanged); >0 lets re-confirmed older observations climb into the window
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: "true",
    CLAUDE_MEM_WELCOME_HINT_ENABLED: "true",
    CLAUDE_MEM_WORK_STATE_ENABLED: "true",
    // 'false' = no work-state section at SessionStart and no work_state_* MCP tools, for hosts that track work their own way
    CLAUDE_MEM_FILE_READ_GATE_ENABLED: "true",
    // 'false' = never block a full-file Read; the file's observation timeline is still added as context
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: "false",
    CLAUDE_MEM_FOLDER_USE_LOCAL_MD: "false",
    // When true, writes to CLAUDE.local.md instead of CLAUDE.md
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: "true",
    CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: join5(homedir3(), ".claude-mem", "transcript-watch.json"),
    CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: "false",
    // Codex subagent rollouts through the transcript watch: each one's tool
    // calls are new observer spend (the gateway allowance, or the user's own
    // plan), so capture is opt-in (Wave 3 gate R4-5).
    CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: "false",
    CLAUDE_MEM_MAX_CONCURRENT_AGENTS: "2",
    // Max concurrent Claude SDK agent subprocesses
    CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS: "400000",
    // Retire an observer conversation past this size and start a fresh generation (#3800)
    CLAUDE_MEM_OBSERVER_THINKING: "disabled",
    // Observer thinking param: 'disabled' (shipped) | 'enabled[:budget]' | 'omit' — an always-thinking gateway upstream rejects 'disabled' with 400/1210 (#4732)
    CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW: "",
    // Observer model context window in tokens; '' = resolve it (OpenRouter catalogue, Gemini/Claude maps). Lowers the budget above to half the window (#3625)
    CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS: "4096",
    // max_tokens / max_completion_tokens / Gemini maxOutputTokens on every HTTP observer request (#3868)
    CLAUDE_MEM_OBSERVE_BARE_PROMPTS: "false",
    // 'true' restores one observer call per user prompt; 'false' carries the prompt on the next tool event's call
    CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: "3",
    // After N consecutive worker-unreachable hook invocations, show the worker-outage notice once per session (never blocks; plan-17)
    CLAUDE_MEM_REDACT_ENABLED: "false",
    // Opt-in auto-redaction of common secret patterns (see docs/public/usage/auto-redaction.mdx)
    CLAUDE_MEM_REDACT_DISABLED_BUILTINS: "",
    // CSV of built-in pattern names to disable, e.g. 'jwt,slack_token'
    CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: "[]",
    // JSON array of { name, regex } objects
    CLAUDE_MEM_REDACT_LOG_MATCHES: "false",
    // Log pattern,count per invocation (no payload)
    CLAUDE_MEM_REDACT_GENERIC_ENABLED: "false",
    // #4745 — opt-in: also redact un-prefixed credentials (password=, *_TOKEN=, *_SECRET=, *_API_KEY=, Authorization: Bearer)
    CLAUDE_MEM_EXCLUDED_PROJECTS: "",
    // Comma-separated glob patterns for excluded project paths
    CLAUDE_MEM_PROJECT_ENVIRONMENTS: "[]",
    // JSON array of {"name","patterns"}: directories matching an environment's globs share one project named after it
    CLAUDE_MEM_FOLDER_MD_EXCLUDE: "[]",
    // JSON array of folder paths to exclude from CLAUDE.md generation
    CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST: "[]",
    // #2400 — JSON array of glob patterns; when a folder matches AND its generated CLAUDE.md would be empty/skeleton, skip injection (avoids polluting non-content dirs with empty skeletons). Default [] preserves existing behavior.
    CLAUDE_MEM_SEMANTIC_INJECT: "false",
    // Inject relevant past observations on every UserPromptSubmit (experimental, disabled by default)
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: "5",
    // Top-N most relevant observations to inject per prompt
    CLAUDE_MEM_SEMANTIC_INJECT_FORMAT: "narrative",
    // 'narrative' = title + full narrative per match; 'index' = id + title + subtitle, expanded via get_observations
    CLAUDE_MEM_TIER_ROUTING_ENABLED: "true",
    // Route observations to models by complexity
    CLAUDE_MEM_TIER_SIMPLE_MODEL: "haiku",
    // Portable tier alias — works across Direct API, Bedrock, Vertex, Azure (see #1463)
    CLAUDE_MEM_TIER_SUMMARY_MODEL: "",
    // Empty = use default model for summaries
    CLAUDE_MEM_TIER_FAST_MODEL: "haiku",
    // #2289 — $TIER:fast resolves here (portable alias)
    CLAUDE_MEM_TIER_SMART_MODEL: "sonnet",
    // #2289 — $TIER:smart resolves here (portable alias)
    CLAUDE_MEM_CHROMA_ENABLED: "true",
    // Set to 'false' to disable Chroma and use SQLite-only search
    CLAUDE_MEM_CHROMA_MODE: "local",
    // 'local' uses persistent chroma-mcp via uvx, 'remote' connects to existing server
    CLAUDE_MEM_CHROMA_HOST: "127.0.0.1",
    CLAUDE_MEM_CHROMA_PORT: "8000",
    CLAUDE_MEM_CHROMA_SSL: "false",
    CLAUDE_MEM_CHROMA_API_KEY: "",
    CLAUDE_MEM_CHROMA_TENANT: "default_tenant",
    CLAUDE_MEM_CHROMA_DATABASE: "default_database",
    CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS: "120000",
    CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS: "600000",
    // Chroma embedding/index writes can exceed the MCP SDK's 60s default
    CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS: "5000",
    // Bound burst imports without changing normal live indexing
    // Embedding function used when creating the Chroma collection. 'default' is
    // the local all-MiniLM-L6-v2 (English-tuned). The pinned chroma-mcp also
    // accepts 'openai', 'cohere', 'jina', 'voyageai' and 'roboflow'; those are
    // API-backed, need the vendor's API key in the environment, and send your
    // memory text to that vendor. Any other value is rejected. Applies to new
    // collections only — changing it requires re-indexing.
    CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION: "default",
    // The server's search by meaning (pgvector): it embeds every observation
    // in process, existing rows in the background at startup. 'true'
    // turns it on and 'false' off. 'auto' turns it on for a new database and
    // leaves a database from before it keyword-only, so an upgrade adds no
    // embedding work until that deployment sets 'true'.
    CLAUDE_MEM_SERVER_VECTOR_SEARCH: "auto",
    // A server start that finds stored observations without vectors from the
    // current model (search by meaning just turned on, or the model changed)
    // embeds them in the background, which can take hours on a large store.
    // That start caps the embedder at this many CPU threads until the next
    // restart: empty is half the machine's threads, 0 is every thread.
    CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS: "",
    // Embedding model the server's search by meaning uses: a key of
    // EMBEDDING_MODELS in src/services/vector/models.ts, which lists them and
    // their vector widths. 'all-MiniLM-L6-v2' is Chroma's default
    // (English-tuned). Any other value is rejected. Changing it re-embeds
    // every observation, and search by meaning covers only rows already
    // re-embedded until that finishes.
    CLAUDE_MEM_EMBEDDING_MODEL: "all-MiniLM-L6-v2",
    CLAUDE_MEM_CHROMA_UVX_PATH: "",
    // Empty = search uv's install folders, then PATH (#4195)
    CLAUDE_MEM_SEARCH_RECENCY_DAYS: "90",
    // Date-less semantic search only ranks matches from the last N days (#4770). 0 = no window (every match eligible); an explicit dateStart/dateEnd always wins. Restart the worker after changing it
    // Worker-native cloud sync: credentials come from cmem.ai → Connect.
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: "",
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: "",
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: "",
    // sync-hub base URL (e.g. https://sync.cmem.ai). Empty = sync OFF
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: "",
    // Minted at first CloudSync start, then persisted back here
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: hostname(),
    // Human-readable label for the cmem.ai Devices panel
    CLAUDE_MEM_CLOUD_SYNC_WS: "true",
    // Live updates (Supabase Realtime `advance` broadcasts). 'false' disables live updates — sync stays fully correct, just poll-latency (prime directive #2)
    CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE: "40",
    // Drain page size; 200-op content pushes timed out under hub projection_busy
    CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS: "90000",
    // Content-push AbortSignal; matches hub PROJECTION_LEASE_MS (90s)
    CLAUDE_MEM_TEAMBRAIN_URL: "",
    // TeamBrain base URL (e.g. https://cmem.ai). Empty = TeamBrain OFF
    CLAUDE_MEM_TEAMBRAIN_TEAM_ID: "",
    // The team this install joined (teambrain share/leave default to it)
    CLAUDE_MEM_LLM_TIMEOUT_MS: String(DEFAULT_LLM_TIMEOUT_MS),
    // Per-attempt deadline for non-streamed observer requests (retry.ts); streamed OpenRouter/OpenAI-compatible requests use a 90s idle timeout + 300s cap (streamed-chat-completion.ts)
    CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS: String(DEFAULT_LLM_TIMEOUT_MS),
    // Oversized-field condensation deadline (field-optimizer.ts); a request to the same backend, so the same deadline
    CLAUDE_MEM_LLM_STREAM_IDLE_TIMEOUT_MS: "90000",
    // Streamed request idle window (streamed-chat-completion.ts): silence that ends a stream. Self-hosted backends queue behind a load balancer, and the queue wait reads as idle (#4737) — raise it there. Literal because shared cannot import from the worker; a drift test pins it to the shipped constant
    CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS: "120000",
    // A silent worker whose liveness heartbeat is younger than this is slow, not dead (10000-3600000).
    // Observation TV remote broadcast. EMPTY = OFF: the read-only guard is not
    // mounted and the worker behaves exactly as before. Set (with a non-loopback
    // CLAUDE_MEM_WORKER_HOST) to expose ONLY /tv, /tv.html, /stream and
    // GET /api/observations to holders of this secret. Mint with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
    CLAUDE_MEM_TV_TOKEN: "",
    // claude-mem sign-in funnel state: all empty until the installer's
    // browser-login step writes them.
    CLAUDE_MEM_PRO_TRIAL_EMAIL: "",
    // Email the sign-in link was sent to (don't-re-nag marker)
    CLAUDE_MEM_PRO_TRIAL_AT: "",
    // ISO timestamp of the last sign-in link send
    CLAUDE_MEM_PRO_TRIAL_STATE: "",
    // 'link_sent' (started, credentials never picked up) | 'active' (done)
    CLAUDE_MEM_PRO_TRIAL_ENDS_AT: "",
    // ISO date the free trial ends (from poll trial.ends_at); '' when absent
    CLAUDE_MEM_PRO_PLAN: "",
    // 'trial' | 'pro' | 'none' — plan reported by the poll on ready
    CLAUDE_MEM_PRO_FALLBACK_AT: "",
    // ISO timestamp when the cmem gateway terminally rejected the delivered key and memory fell back to the Anthropic plan; '' = no fallback. Event-driven only (never set from trial dates); cleared by a successful gateway response or fresh installer key material.
    CLAUDE_MEM_PRO_FALLBACK_MESSAGE: "",
    // The gateway's message for that rejection ('' = plan-neutral notice copy)
    CLAUDE_MEM_PRO_FALLBACK_ACTION: "",
    // The gateway's "what to do" for that rejection
    CLAUDE_MEM_PRO_FALLBACK_URL: "",
    // The gateway's link for that rejection ('' = the cmem.ai/pro renewal link)
    CLAUDE_MEM_PRO_MEMORY_KEY: "",
    // One-shot browser-pairing memory key, staged until provider selection (settings.json is chmod 0600 by the installer)
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: "",
    // Backend-supplied endpoint paired with CLAUDE_MEM_PRO_MEMORY_KEY
    CLAUDE_MEM_PRO_MEMORY_MODEL: "",
    // Backend-supplied model paired with CLAUDE_MEM_PRO_MEMORY_KEY
    CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH: "true",
    // 'false' = My Work never runs owner-goals / request-progress on its own (refresh.json in ~/.claude-mem/work-view)
    CLAUDE_MEM_TELEGRAM_ENABLED: "true",
    CLAUDE_MEM_TELEGRAM_BOT_TOKEN: "",
    CLAUDE_MEM_TELEGRAM_CHAT_ID: "",
    CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED: "true",
    // Session-end wrap-ups require an explicit project route before sending.
    CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED: "false",
    // Existing per-observation Telegram alerts are opt-in.
    CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES: "{}",
    // JSON project-to-Telegram-route map; entries may carry bot-token overrides.
    CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: "security_alert,sensitive",
    CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS: "",
    CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: "true",
    // Pilot agents: LFG + Orifice. Empty list = no writes.
    CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS: "521e962d-2ec3-4488-bfbc-54d5209ce118,95601360-61f7-4fd9-bb3a-2c976b2b85c0",
    CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: "decision,bugfix,security_alert,sensitive",
    CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS: "",
    // Optional brainbeat webhook: awareness-trigger matches are POSTed here
    // (off while empty). File/env only; both are masked on GET /api/settings.
    CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: "",
    CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET: "",
    // Live Grok Bot Memory INDEX. Worker writes zz-claude-mem-inject.md as
    // observations land. Default on; no-op when no Grok Bot seats exist.
    CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: "true",
    CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: "*",
    CLAUDE_MEM_GROK_BOT_INJECT_TIER: "episode",
    CLAUDE_MEM_GROK_BOT_INJECT_WINDOW: "80",
    CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK: "house",
    CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE: "",
    CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT: "",
    CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS: "160",
    CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS: "1500",
    CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE: "",
    CLAUDE_MEM_CCS_ALIGN_ENABLED: "true",
    CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS: "ccs-align",
    // Copy of the Grok needle list (D6). Same episodic needles, seat-owned cache.
    CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES: "decision,bugfix,security_alert,sensitive",
    // Phase 2 rules-shadow patch stays a Prioritizer flag, not a silent /do (D8).
    CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS: "false",
    CLAUDE_MEM_QUEUE_ENGINE: "sqlite",
    CLAUDE_MEM_REDIS_URL: "",
    CLAUDE_MEM_REDIS_HOST: "127.0.0.1",
    CLAUDE_MEM_REDIS_PORT: "6379",
    CLAUDE_MEM_REDIS_MODE: "external",
    CLAUDE_MEM_QUEUE_REDIS_PREFIX: `claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT ?? String(37700 + (process.getuid?.() ?? 77) % 100)}`,
    CLAUDE_MEM_AUTH_MODE: "api-key",
    CLAUDE_MEM_RUNTIME: "worker",
    // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
    // these first; the legacy `*_BETA_*` defaults below remain so existing
    // settings.json files still resolve correctly.
    CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT ?? String(37877 + (process.getuid?.() ?? 77) % 100)}`,
    // Default server runtime URL — UID-derived for multi-account isolation
    CLAUDE_MEM_SERVER_API_KEY: "",
    // Local hook API key, populated by installer when runtime=server
    CLAUDE_MEM_SERVER_PROJECT_ID: "",
    // Default Postgres project_id used by hooks when runtime=server
    CLAUDE_MEM_SERVER_BETA_URL: `http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT ?? String(37877 + (process.getuid?.() ?? 77) % 100)}`,
    // Legacy server-beta runtime URL — UID-derived for multi-account isolation
    CLAUDE_MEM_SERVER_BETA_API_KEY: "",
    // Legacy local hook API key (read as fallback when CLAUDE_MEM_SERVER_API_KEY unset)
    CLAUDE_MEM_SERVER_BETA_PROJECT_ID: "",
    // Legacy Postgres project_id (read as fallback when CLAUDE_MEM_SERVER_PROJECT_ID unset)
    CLAUDE_MEM_DEDUP_ENABLED: "false",
    // #3038 — opt-in; Tier-0 exact auto-merge + Tier-1 review-only candidates
    CLAUDE_MEM_DEDUP_COSINE_THRESHOLD: "0.80",
    // empirical near-dup sweet spot for short titles (F1≈0.95)
    CLAUDE_MEM_DEDUP_IDF_VETO_DF: "10",
    // token in <=10 project records vetoes the merge (Fellegi-Sunter blocking key)
    CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS: "2",
    // >=2 shared tokens before cosine (kills sparse-vector noise)
    CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS: "10",
    // cold-start gate: IDF unreliable below ~10 docs/project
    CLAUDE_MEM_DEDUP_MAX_SCAN: "2000",
    // per-insert candidate-scan cap (logged when exceeded)
    CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS: "50000",
    // dedup-scan skips a project with more rows than this (memory safety)
    CLAUDE_MEM_TOOL_USES_RETENTION_DAYS: "0",
    // 0 = keep forever (default); N = purge linked tool_uses older than N days at worker start
    CLAUDE_MEM_WORKER_AUTOSTART: "true",
    // 'false' = the worker is managed externally: hooks, the MCP server and `start` use a running worker but never launch, kill or recycle one.
    CLAUDE_MEM_PROJECT_NAME_SOURCE: "path"
    // 'path' (default) = folder/git-root basename; 'git-remote' = stable org/repo slug from the git `origin` URL (survives directory renames). Opt-in; default preserves existing behavior.
  };
  static getAllDefaults() {
    return { ...this.DEFAULTS };
  }
  static get(key) {
    const value = process.env[key] ?? this.DEFAULTS[key];
    if (key === "CLAUDE_MEM_WORKER_HOST") {
      return this.normalizeWorkerHost(value);
    }
    return value;
  }
  // 'localhost' resolves IPv6-first on modern Windows resolvers while
  // server.listen(port, 'localhost') binds ::1 only, so the hook client and
  // the worker can land on different loopback families (#2992). Pin the
  // documented IPv4 loopback so every consumer of the setting agrees.
  static normalizeWorkerHost(host) {
    return host === "localhost" ? "127.0.0.1" : host;
  }
  static finalizeSettings(settings, applyEnvOverrides) {
    const result = applyEnvOverrides ? this.applyEnvOverrides(settings) : settings;
    result.CLAUDE_MEM_WORKER_HOST = this.normalizeWorkerHost(result.CLAUDE_MEM_WORKER_HOST);
    return result;
  }
  static getInt(key) {
    const value = this.get(key);
    return parseInt(value, 10);
  }
  static applyEnvOverrides(settings) {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS)) {
      if (process.env[key] !== void 0) {
        result[key] = process.env[key];
      }
    }
    return result;
  }
  static loadFromFile(settingsPath, applyEnvOverrides = true, options = {}) {
    try {
      if (!existsSync4(settingsPath)) {
        const defaults = this.getAllDefaults();
        if (!options.readOnly) {
          try {
            writeJsonFileAtomic(settingsPath, defaults, { mode: 384 });
            for (const raised of RAISED_DEADLINE_DEFAULTS) markRaisedDefaultDone(settingsPath, raised);
            console.warn("[SETTINGS] Created settings file with defaults:", settingsPath);
          } catch (error) {
            console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:", settingsPath, error instanceof Error ? error.message : String(error));
          }
        }
        return this.finalizeSettings(defaults, applyEnvOverrides);
      }
      const settingsData = readFileSync4(settingsPath, "utf-8");
      const settings = parseJsonWithBom(settingsData);
      let flatSettings = settingsTarget(settings);
      const hasNestedEnv = flatSettings !== settings;
      const writableRoot = withoutStaleRootCopies(settings);
      const hasPeerRootKeys = hasNestedEnv && Object.keys(writableRoot).some((key) => key !== "env");
      if (hasNestedEnv) {
        if (!hasPeerRootKeys && !options.readOnly) {
          try {
            writeJsonFileAtomic(settingsPath, flatSettings, { mode: 384 });
            console.warn("[SETTINGS] Migrated settings file from nested to flat schema:", settingsPath);
          } catch (error) {
            console.warn("[SETTINGS] Failed to auto-migrate settings file:", settingsPath, error instanceof Error ? error.message : String(error));
          }
        }
      }
      if (flatSettings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES === LEGACY_TELEGRAM_TRIGGER_TYPES) {
        flatSettings = {
          ...flatSettings,
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES
        };
        if (!options.readOnly) {
          try {
            writeJsonFileAtomic(
              settingsPath,
              hasPeerRootKeys ? { ...writableRoot, env: flatSettings } : flatSettings,
              { mode: 384 }
            );
            console.warn("[SETTINGS] Migrated Telegram trigger types off the legacy default:", settingsPath);
          } catch (error) {
            console.warn("[SETTINGS] Failed to migrate Telegram trigger types:", settingsPath, error instanceof Error ? error.message : String(error));
          }
        }
      }
      if (hasRetiredOpenRouterDefault(flatSettings)) {
        const retiredModel = String(flatSettings.CLAUDE_MEM_OPENROUTER_MODEL).trim();
        flatSettings = {
          ...flatSettings,
          CLAUDE_MEM_OPENROUTER_MODEL: this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL
        };
        if (!options.readOnly) {
          try {
            writeJsonFileAtomic(
              settingsPath,
              hasPeerRootKeys ? { ...writableRoot, env: flatSettings } : flatSettings,
              { mode: 384 }
            );
            console.warn(
              `[SETTINGS] Migrated OpenRouter model off the retired default ${retiredModel} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,
              settingsPath
            );
          } catch (error) {
            console.warn("[SETTINGS] Failed to migrate the retired OpenRouter model:", settingsPath, error instanceof Error ? error.message : String(error));
          }
        }
      }
      const rewrittenHubUrl = migratedCloudSyncHubUrl(flatSettings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);
      if (rewrittenHubUrl !== null) {
        flatSettings = {
          ...flatSettings,
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: rewrittenHubUrl
        };
        if (!options.readOnly) {
          try {
            writeJsonFileAtomic(
              settingsPath,
              hasPeerRootKeys ? { ...writableRoot, env: flatSettings } : flatSettings,
              { mode: 384 }
            );
            console.warn("[SETTINGS] Migrated cloud sync hub URL to", rewrittenHubUrl, "from a retired hub host:", settingsPath);
          } catch (error) {
            console.warn("[SETTINGS] Failed to migrate cloud sync hub URL:", settingsPath, error instanceof Error ? error.message : String(error));
          }
        }
      }
      for (const raised of RAISED_DEADLINE_DEFAULTS) {
        if (existsSync4(raisedDefaultMarkerPath(settingsPath, raised))) continue;
        if (flatSettings[raised.key] !== raised.legacy) {
          if (!options.readOnly) markRaisedDefaultDone(settingsPath, raised);
          continue;
        }
        flatSettings = {
          ...flatSettings,
          [raised.key]: this.DEFAULTS[raised.key]
        };
        if (!options.readOnly) {
          try {
            writeJsonFileAtomic(
              settingsPath,
              hasPeerRootKeys ? { ...writableRoot, env: flatSettings } : flatSettings,
              { mode: 384 }
            );
            markRaisedDefaultDone(settingsPath, raised);
            console.warn(
              `[SETTINGS] Migrated ${raised.key} off the old ${raised.legacy}ms default to ${this.DEFAULTS[raised.key]}ms:`,
              settingsPath
            );
          } catch (error) {
            const reported = `${raised.key}\0${settingsPath}`;
            if (!raisedDefaultFailuresReported.has(reported)) {
              raisedDefaultFailuresReported.add(reported);
              console.warn(
                `[SETTINGS] Failed to migrate ${raised.key}; using the new default in memory (reported once per process):`,
                settingsPath,
                error instanceof Error ? error.message : String(error)
              );
            }
          }
        }
      }
      const result = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS)) {
        if (flatSettings[key] !== void 0) {
          result[key] = coercePersistedSettingValue(flatSettings[key]);
        }
      }
      return this.finalizeSettings(result, applyEnvOverrides);
    } catch (error) {
      console.warn("[SETTINGS] Failed to load settings, using defaults:", settingsPath, error instanceof Error ? error.message : String(error));
      const defaults = this.getAllDefaults();
      return this.finalizeSettings(defaults, applyEnvOverrides);
    }
  }
};

// src/utils/worktree.ts
import { existsSync as existsSync5, statSync as statSync3, readFileSync as readFileSync5 } from "fs";
import path from "path";
var NOT_A_WORKTREE = {
  isWorktree: false,
  isSubmodule: false,
  worktreeName: null,
  parentRepoPath: null,
  parentProjectName: null
};
function detectWorktree(cwd) {
  const gitPath = path.join(cwd, ".git");
  let stat;
  try {
    stat = statSync3(gitPath);
  } catch (error) {
    if (error instanceof Error && error.code !== "ENOENT") {
      logger.warn("GIT", "Unexpected error checking .git", { error: error instanceof Error ? error.message : String(error) });
    }
    return NOT_A_WORKTREE;
  }
  if (!stat.isFile()) {
    return NOT_A_WORKTREE;
  }
  let content;
  try {
    content = readFileSync5(gitPath, "utf-8").trim();
  } catch (error) {
    logger.warn("GIT", "Failed to read .git file", { error: error instanceof Error ? error.message : String(error) });
    return NOT_A_WORKTREE;
  }
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    return NOT_A_WORKTREE;
  }
  const gitdirPath = path.resolve(path.dirname(gitPath), match[1]);
  const worktreesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);
  if (worktreesMatch) {
    const parentRepoPath = worktreesMatch[1];
    return {
      isWorktree: true,
      isSubmodule: false,
      worktreeName: path.basename(cwd),
      parentRepoPath,
      parentProjectName: path.basename(parentRepoPath)
    };
  }
  const submoduleMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]modules[/\\](.+)$/);
  if (submoduleMatch) {
    const parentRepoPath = submoduleMatch[1];
    return {
      isWorktree: false,
      isSubmodule: true,
      worktreeName: path.basename(cwd),
      parentRepoPath,
      parentProjectName: path.basename(parentRepoPath)
    };
  }
  const bareWorktreeMatch = gitdirPath.match(/^(.+)[/\\]worktrees[/\\]([^/\\]+)$/);
  if (bareWorktreeMatch && existsSync5(path.join(gitdirPath, "commondir"))) {
    const parentRepoPath = bareWorktreeMatch[1];
    const parentProjectName = bareRepositoryProjectName(parentRepoPath);
    if (parentProjectName) {
      return {
        isWorktree: true,
        isSubmodule: false,
        worktreeName: path.basename(cwd),
        parentRepoPath,
        parentProjectName
      };
    }
  }
  return NOT_A_WORKTREE;
}
function bareRepositoryProjectName(bareRepoPath) {
  const name = path.basename(bareRepoPath).replace(/\.git$/, "");
  if (name && !name.startsWith(".")) return name;
  return path.basename(path.dirname(bareRepoPath)) || null;
}

// src/utils/project-environments.ts
import { realpathSync as realpathSync2 } from "fs";

// src/utils/project-filter.ts
import { basename as basename4 } from "path";
function globToRegex(pattern) {
  let expanded = expandHome(pattern.replace(/\\/g, "/"));
  expanded = expanded.replace(/\\/g, "/");
  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  regex = regex.replace(/(^|\/)\*\*(?=\/)/g, "$1<<<GLOBSTAR_DIR>>>").replace(/\*\*/g, "<<<GLOBSTAR>>>").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/<<<GLOBSTAR>>>/g, ".*").replace(/<<<GLOBSTAR_DIR>>>\//g, "(?:.*/)?");
  return new RegExp(`^${regex}$`);
}
function matchesGlobPattern(pattern, normalizedPath, pathBasename) {
  const regex = globToRegex(pattern);
  if (regex.test(normalizedPath) || regex.test(pathBasename)) return true;
  if (pattern.replace(/\\/g, "/").endsWith("/**")) {
    return globToRegex(pattern.slice(0, -3)).test(normalizedPath.replace(/\/+$/, ""));
  }
  return false;
}
function matchesAnyGlob(folderPath, patterns) {
  if (!patterns.length) return false;
  const normalizedPath = folderPath.replace(/\\/g, "/");
  const pathBasename = basename4(normalizedPath);
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    try {
      if (matchesGlobPattern(pattern, normalizedPath, pathBasename)) {
        return true;
      }
    } catch (error) {
      logger.warn("PROJECT_NAME", "Invalid glob pattern", { pattern, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
  }
  return false;
}

// src/utils/project-environments.ts
function parseProjectEnvironments(raw) {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value);
    } catch (error) {
      logger.warn("PROJECT_NAME", "CLAUDE_MEM_PROJECT_ENVIRONMENTS is not valid JSON; ignoring it", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }
  if (!Array.isArray(value)) {
    if (value !== void 0 && value !== null) {
      logger.warn("PROJECT_NAME", "CLAUDE_MEM_PROJECT_ENVIRONMENTS must be an array; ignoring it", {});
    }
    return [];
  }
  const environments = [];
  for (const entry of value) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    const patterns = Array.isArray(entry?.patterns) ? entry.patterns.filter((pattern) => typeof pattern === "string" && pattern.trim() !== "") : [];
    if (!name || patterns.length === 0) {
      logger.warn("PROJECT_NAME", "Ignoring a project environment without a name or patterns", { name });
      continue;
    }
    environments.push({ name, patterns });
  }
  return environments;
}
function realpathOrSelf(dir) {
  try {
    return realpathSync2(dir);
  } catch {
    return dir;
  }
}
function matchProjectEnvironment(dir, environments) {
  if (environments.length === 0) return null;
  const candidates = [.../* @__PURE__ */ new Set([dir, realpathOrSelf(dir)])].flatMap((candidate) => [candidate, `${candidate.replace(/[\\/]+$/, "")}/`]);
  for (const environment of environments) {
    if (candidates.some((candidate) => matchesAnyGlob(candidate, environment.patterns))) {
      return environment.name;
    }
  }
  return null;
}

// src/utils/project-name.ts
var UNKNOWN_PROJECT_NAME = "unknown-project";
function findGitRepoRoot(dir) {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    return root || null;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug("PROJECT_NAME", "git rev-parse failed, falling back to non-git root", { dir }, err);
    return null;
  }
}
var PROJECT_ROOT_MARKERS = [".claude-mem-project", ".claude-mem.json"];
var MAX_MARKER_WALK_DEPTH = 64;
function realpathOrSelf2(dir) {
  try {
    return realpathSync3(dir);
  } catch {
    return dir;
  }
}
function isWithin(child, parent) {
  const relative = path2.relative(parent, child);
  return relative === "" || !relative.startsWith("..") && !path2.isAbsolute(relative);
}
function markerWalkStops() {
  return [homedir4(), tmpdir(), CLAUDE_CONFIG_DIR].flatMap((dir) => {
    const resolved = path2.resolve(dir);
    return [resolved, realpathOrSelf2(resolved)];
  });
}
function findMarkerProjectRoot(dir) {
  const stops = markerWalkStops();
  let current = path2.resolve(dir);
  const configDirs = [path2.resolve(CLAUDE_CONFIG_DIR), realpathOrSelf2(path2.resolve(CLAUDE_CONFIG_DIR))];
  if (configDirs.some((configDir) => isWithin(current, configDir))) {
    return null;
  }
  for (let depth = 0; depth < MAX_MARKER_WALK_DEPTH; depth++) {
    if (stops.includes(current)) {
      return null;
    }
    const parent = path2.dirname(current);
    if (parent === current) {
      return null;
    }
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync6(path2.join(current, marker)))) {
      return current;
    }
    current = parent;
  }
  return null;
}
function projectNameFromSource(cwd, nameSource) {
  const basename6 = path2.basename(nameSource);
  if (basename6 === "") {
    const isWindows = process.platform === "win32";
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info("PROJECT_NAME", "Drive root detected", { cwd, projectName });
        return projectName;
      }
    }
    logger.warn("PROJECT_NAME", "Root directory detected, using fallback", { cwd });
    return UNKNOWN_PROJECT_NAME;
  }
  return basename6;
}
var PROJECT_NAME_SOURCE_SETTING = "CLAUDE_MEM_PROJECT_NAME_SOURCE";
var identitySettingsCache = null;
function settingsFileMtimeMs() {
  try {
    return statSync4(USER_SETTINGS_PATH).mtimeMs;
  } catch {
    return -1;
  }
}
function readIdentitySettings() {
  const mtimeMs = settingsFileMtimeMs();
  if (mtimeMs === -1) {
    return SettingsDefaultsManager.getAllDefaults();
  }
  if (identitySettingsCache && identitySettingsCache.mtimeMs === mtimeMs) {
    return identitySettingsCache.settings;
  }
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  identitySettingsCache = { mtimeMs: settingsFileMtimeMs(), settings };
  return settings;
}
function useGitRemoteProjectNames() {
  const source = process.env[PROJECT_NAME_SOURCE_SETTING] ?? readIdentitySettings().CLAUDE_MEM_PROJECT_NAME_SOURCE;
  return String(source ?? "path").trim().toLowerCase() === "git-remote";
}
var PROJECT_ENVIRONMENTS_SETTING = "CLAUDE_MEM_PROJECT_ENVIRONMENTS";
var environmentsCache = null;
function loadProjectEnvironments() {
  const raw = process.env[PROJECT_ENVIRONMENTS_SETTING] ?? readIdentitySettings().CLAUDE_MEM_PROJECT_ENVIRONMENTS;
  if (!environmentsCache || environmentsCache.raw !== raw) {
    environmentsCache = { raw, environments: parseProjectEnvironments(raw) };
  }
  return environmentsCache.environments;
}
function parseOriginUrlToSlug(url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  const isLocal = /^file:/i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith(".") || trimmed.startsWith("~") || trimmed.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(trimmed);
  if (isLocal) return null;
  const cleaned = trimmed.replace(/\/+$/, "").replace(/\.git$/i, "");
  const urlFormMatch = cleaned.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i);
  const scpFormMatch = urlFormMatch ? null : cleaned.match(/^(?:[^/@\s]+@)?[^:/\s]+:(?!\/\/)(.+)$/);
  const pathPart = urlFormMatch?.[1] ?? scpFormMatch?.[1];
  if (!pathPart) return null;
  const segments = pathPart.split("/").filter((segment) => segment && segment !== "_git");
  if (segments.length >= 2) return segments.slice(-2).join("/");
  if (segments.length === 1) return segments[0];
  return null;
}
function deriveSlugFromRemote(repoRoot) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    return parseOriginUrlToSlug(url);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug("PROJECT_NAME", "No usable origin remote, keeping the path-based name", { repoRoot }, err);
    return null;
  }
}
var remoteSlugByRepoRoot = /* @__PURE__ */ new Map();
function gitRemoteProjectSlug(repoRoot) {
  if (!useGitRemoteProjectNames()) return null;
  if (!remoteSlugByRepoRoot.has(repoRoot)) {
    remoteSlugByRepoRoot.set(repoRoot, deriveSlugFromRemote(repoRoot));
  }
  return remoteSlugByRepoRoot.get(repoRoot) ?? null;
}
function getProjectName(cwd, platform = process.platform) {
  if (!cwd || cwd.trim() === "") {
    logger.warn("PROJECT_NAME", "Empty cwd provided, using fallback", { cwd });
    return UNKNOWN_PROJECT_NAME;
  }
  const expanded = expandHome(cwd, platform);
  const environment = matchProjectEnvironment(expanded, loadProjectEnvironments());
  if (environment) {
    return environment;
  }
  const repoRoot = findGitRepoRoot(expanded);
  const slug = repoRoot ? gitRemoteProjectSlug(repoRoot) : null;
  if (slug) {
    return slug;
  }
  const nameSource = repoRoot ?? findMarkerProjectRoot(expanded) ?? expanded;
  return projectNameFromSource(cwd, nameSource);
}
function buildWorktreeProjectKey(parentProjectName, worktreeName) {
  return worktreeName === parentProjectName ? parentProjectName : `${parentProjectName}/${worktreeName}`;
}
function submoduleLeaf(info, repoRoot) {
  if (!info.isSubmodule || !info.parentRepoPath) return null;
  const relative = path2.relative(info.parentRepoPath, repoRoot);
  if (!relative || relative.startsWith("..") || path2.isAbsolute(relative)) return null;
  return relative.split(path2.sep).join("/");
}
function getProjectContext(cwd, platform = process.platform) {
  if (!cwd || cwd.trim() === "") {
    const fallback = getProjectName(cwd, platform);
    return { primary: fallback, parent: null, isWorktree: false, isSubmodule: false, allProjects: [fallback], keySource: "path" };
  }
  const expandedCwd = expandHome(cwd, platform);
  const repoRoot = findGitRepoRoot(expandedCwd);
  const pathContext = getPathProjectContext(cwd, expandedCwd, repoRoot);
  const slug = repoRoot ? gitRemoteProjectSlug(repoRoot) : null;
  const derivedContext = slug ? withPrimaryKey(pathContext, slug, "git-remote") : pathContext;
  const environment = matchProjectEnvironment(expandedCwd, loadProjectEnvironments());
  return environment ? withPrimaryKey(derivedContext, environment, "environment") : derivedContext;
}
function withPrimaryKey(context, primary, keySource) {
  return {
    primary,
    parent: null,
    isWorktree: context.isWorktree,
    isSubmodule: context.isSubmodule,
    allProjects: [...context.allProjects.filter((key) => key !== primary), primary],
    keySource
  };
}
function getPathProjectContext(cwd, expandedCwd, repoRoot) {
  const markerRoot = repoRoot ? null : findMarkerProjectRoot(expandedCwd);
  const cwdProjectName = projectNameFromSource(cwd, repoRoot ?? markerRoot ?? expandedCwd);
  const checkoutRoot = repoRoot ?? expandedCwd;
  const worktreeInfo = detectWorktree(checkoutRoot);
  if ((worktreeInfo.isWorktree || worktreeInfo.isSubmodule) && worktreeInfo.parentProjectName) {
    const parent = worktreeInfo.parentProjectName;
    let primary;
    let legacyKeys;
    if (worktreeInfo.isSubmodule) {
      primary = `${parent}/${submoduleLeaf(worktreeInfo, checkoutRoot) ?? cwdProjectName}`;
      legacyKeys = cwdProjectName !== parent ? [cwdProjectName] : [];
    } else {
      primary = buildWorktreeProjectKey(parent, cwdProjectName);
      legacyKeys = primary === parent ? [`${parent}/${cwdProjectName}`] : [];
    }
    return {
      primary,
      parent,
      isWorktree: worktreeInfo.isWorktree,
      isSubmodule: worktreeInfo.isSubmodule,
      allProjects: [.../* @__PURE__ */ new Set([parent, ...legacyKeys, primary])].filter((key) => key !== primary).concat(primary),
      keySource: "path"
    };
  }
  if (markerRoot && path2.resolve(markerRoot) !== path2.resolve(expandedCwd)) {
    const legacyKey = projectNameFromSource(cwd, expandedCwd);
    if (legacyKey !== cwdProjectName && legacyKey !== UNKNOWN_PROJECT_NAME) {
      return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [legacyKey, cwdProjectName], keySource: "path" };
    }
  }
  return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [cwdProjectName], keySource: "path" };
}

// src/services/work-view/session-project.mjs
var NO_PROJECT = "";
function projectRoot(project, gitRemoteNames = useGitRemoteProjectNames()) {
  if (typeof project !== "string") return null;
  return gitRemoteNames ? project : project.split("/")[0];
}
function upgradedGroupRoot(savedRoot, anchorRoot, memberRoots = []) {
  if (typeof savedRoot !== "string" || !savedRoot || savedRoot.includes("/")) return savedRoot;
  const widened = (root) => typeof root === "string" && root.startsWith(`${savedRoot}/`);
  if (widened(anchorRoot)) return anchorRoot;
  const candidates = new Set(memberRoots.filter(widened));
  return candidates.size === 1 ? [...candidates][0] : savedRoot;
}
var realpathOrSelf3 = (path3) => {
  try {
    return realpathSync4(path3);
  } catch {
    return path3;
  }
};
var TEMP_FOLDERS = [.../* @__PURE__ */ new Set([resolve2(tmpdir2()), realpathOrSelf3(resolve2(tmpdir2())), "/tmp", "/private/tmp"])];
var HOME = homedir5();
var TEMP_PROJECT_NAMES = new Set(TEMP_FOLDERS.map((folder) => basename5(folder)).filter((name) => name && name !== "tmp"));
var CODEX_SCRATCH = /[/\\]Documents[/\\]Codex[/\\]\d{4}-\d{2}-\d{2}(?:[/\\]|$)/;
function isAgentScratchFolder(folder) {
  if (typeof folder !== "string" || !folder) return false;
  if (CODEX_SCRATCH.test(folder)) return true;
  const absolute = resolve2(folder);
  return TEMP_FOLDERS.some((temp) => absolute === temp || absolute.startsWith(`${temp}/`));
}
var repoRootCache = /* @__PURE__ */ new Map();
function repoRootOf(path3) {
  const visited = [];
  let current = resolve2(path3), found = null;
  for (; ; ) {
    if (repoRootCache.has(current)) {
      found = repoRootCache.get(current);
      break;
    }
    visited.push(current);
    if (existsSync7(join6(current, ".git"))) {
      found = current;
      break;
    }
    const parent = dirname5(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of visited) repoRootCache.set(dir, found);
  return found;
}
var PATH_START = /(?:^|[\s"'`=:(])((?:~[/\\]|\/|[A-Za-z]:[/\\])[^\n\r"'`;|&<>()]*)/g;
var AGENT_HOMES = [".claude", ".codex", ".gemini", ".claude-mem", ".cursor"].map((name) => join6(HOME, name));
var isAgentHome = (path3) => AGENT_HOMES.some((home) => path3 === home || path3.startsWith(`${home}/`) || path3.startsWith(`${home}\\`));
var isAbsoluteOn = (path3, platform) => path3.startsWith("/") && !path3.startsWith("//") || platform === "win32" && /^[A-Za-z]:[/\\]/.test(path3);
function pathsIn(toolInput, platform = process.platform) {
  let parsed = toolInput;
  if (typeof toolInput === "string") {
    try {
      parsed = JSON.parse(toolInput);
    } catch {
      parsed = toolInput;
    }
  }
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(parsed);
  const paths2 = [];
  for (const text of strings) for (const match of text.matchAll(PATH_START)) {
    const raw = match[1].trim();
    const path3 = raw.startsWith("~/") || platform === "win32" && raw.startsWith("~\\") ? join6(HOME, raw.slice(2)) : raw;
    if (path3.length > 1 && isAbsoluteOn(path3, platform) && !isAgentHome(path3)) paths2.push(path3);
  }
  return paths2;
}
var checkoutForPath = (path3) => {
  let current = path3;
  while (current !== dirname5(current) && !existsSync7(current)) current = dirname5(current);
  return repoRootOf(current);
};
function folderNeedsProject(folder, storedProject) {
  if (!folder) return TEMP_PROJECT_NAMES.has(storedProject);
  if (existsSync7(folder)) return !repoRootOf(folder);
  return isAgentScratchFolder(folder);
}
function projectFromToolPaths(toolInputs) {
  const byRoot = /* @__PURE__ */ new Map(), nameOf = /* @__PURE__ */ new Map();
  for (const input of toolInputs) for (const path3 of pathsIn(input)) {
    const checkout = checkoutForPath(path3);
    if (!checkout) continue;
    if (!nameOf.has(checkout)) nameOf.set(checkout, getProjectContext(checkout).primary);
    const project = nameOf.get(checkout);
    const root = projectRoot(project);
    if (!byRoot.has(root)) byRoot.set(root, { count: 0, projects: /* @__PURE__ */ new Map() });
    const entry = byRoot.get(root);
    entry.count++;
    entry.projects.set(project, (entry.projects.get(project) ?? 0) + 1);
  }
  let best = null;
  for (const entry of byRoot.values()) if (!best || entry.count > best.count) best = entry;
  if (!best) return NO_PROJECT;
  return [...best.projects].sort((a, b) => b[1] - a[1])[0][0];
}
function safeAll(database, sql, params) {
  try {
    return database.prepare(sql).all(...params);
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return null;
    throw error;
  }
}
var derivedCache = /* @__PURE__ */ new Map();
var TOOL_SAMPLE = 400;
function deriveSessionProjects(database, sessions) {
  const result = /* @__PURE__ */ new Map();
  const ids = [...new Set(sessions.map((session) => session.id).filter((id) => id != null))];
  if (!ids.length) return result;
  const folders = /* @__PURE__ */ new Map();
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const rows = safeAll(database, `SELECT id, cwd FROM sdk_sessions WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
    if (rows === null) return result;
    for (const row of rows) folders.set(row.id, row.cwd || null);
  }
  const unknownFolderProjects = [...new Set(sessions.filter((session) => folders.has(session.id) && !folders.get(session.id) && typeof session.project === "string").map((session) => session.project))];
  const scratchProjects = /* @__PURE__ */ new Set();
  for (let index = 0; index < unknownFolderProjects.length; index += 500) {
    const chunk = unknownFolderProjects.slice(index, index + 500);
    for (const row of safeAll(database, `SELECT DISTINCT project, cwd FROM sdk_sessions WHERE project IN (${chunk.map(() => "?").join(",")}) AND cwd IS NOT NULL AND cwd <> ''`, chunk) ?? []) {
      if (isAgentScratchFolder(row.cwd)) scratchProjects.add(row.project);
    }
  }
  const needing = sessions.filter((session) => folders.has(session.id) && (folders.get(session.id) ? folderNeedsProject(folders.get(session.id), session.project) : folderNeedsProject(null, session.project) || scratchProjects.has(session.project)));
  if (!needing.length) return result;
  const needIds = [...new Set(needing.map((session) => session.id))];
  const heads = /* @__PURE__ */ new Map();
  for (let index = 0; index < needIds.length; index += 500) {
    const chunk = needIds.slice(index, index + 500);
    for (const row of safeAll(database, `SELECT session_db_id, MAX(id) AS head FROM tool_uses WHERE session_db_id IN (${chunk.map(() => "?").join(",")}) GROUP BY session_db_id`, chunk) ?? []) heads.set(row.session_db_id, row.head);
  }
  for (const id of needIds) {
    const head = heads.get(id) ?? 0;
    const cached = derivedCache.get(id);
    if (cached && cached.head === head) {
      result.set(id, cached.project);
      continue;
    }
    const calls = head ? safeAll(database, `SELECT substr(tool_input, 1, 4000) AS tool_input, cwd FROM tool_uses WHERE session_db_id = ? ORDER BY id DESC LIMIT ${TOOL_SAMPLE}`, [id]) ?? [] : [];
    const project = projectFromToolPaths(calls.flatMap((call) => [call.tool_input, ...call.cwd ? [JSON.stringify({ cwd: call.cwd })] : []]));
    derivedCache.set(id, { head, project });
    result.set(id, project);
  }
  return result;
}
function withDerivedProjects(database, sessions) {
  const derived = deriveSessionProjects(database, sessions);
  if (!derived.size) return sessions;
  return sessions.map((session) => derived.has(session.id) ? { ...session, project: derived.get(session.id), storedProject: session.project } : session);
}

// src/services/work-view/request-projection.mjs
function requestText(value, max = 1200) {
  if (typeof value !== "string") return null;
  const requestSection = value.match(/^\s*#{1,2}\s+My request\s*:\s*(?:\r?\n)?([\s\S]*)$/im);
  const text = (requestSection?.[1] ?? value).replace(/<(environment_context|instructions|system-reminder|turn_aborted|permissions|collaboration_mode|skills_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/^\s*#\s*AGENTS\.md instructions[^\n]*(?:\n|$)/gim, " ").replace(/<\/?pasted_content\b[^>]*>/gi, "").trim();
  if (/^\s*#{1,2}\s+Files mentioned by the user\s*:/i.test(text)) return null;
  if (!text || /^\s*<(?:environment_context|instructions|system-reminder)\b/i.test(text)) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}
function isHumanActionRequest(value) {
  const text = requestText(value);
  if (!text) return false;
  const plain = text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
  if (/^(?:please\s+)?read\s+(?:the\s+)?[\w./ -]*(?:AGENTS|KICKOFF|CLAUDE)\.md(?:\s+and\s+(?:follow|obey|read|apply)(?:\s+it|\s+the\s+instructions)?\s*)?[.!]?$/i.test(plain)) return false;
  if (/^(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|yes|no|sure|continue|go ahead|keep going|resume|done)[.!\s]*$/i.test(plain)) return false;
  if (/^(?:You are (?:Codex|an AI)|Available skills|Environment context)\b/i.test(plain)) return false;
  if (/^(?:(?:please|just)\s+)?make sure (?:this|that|it|everything) (?:is |will be |keeps? )?(?:working|works|ok|okay|correct)(?:[.!\s]*)$/i.test(plain)) return false;
  if (/^you can (?:def(?:initely)? )?do (?:real )?tests?[,;.!\s]/i.test(plain) && !/\b(?:fix|build|create|implement|change|update|rename|remove|add)\b/i.test(plain)) return false;
  if (/(?:^|\s)GOAL\s*:\s*\S/i.test(plain)) return true;
  if (ENGLISH_ACTION.test(plain)) return true;
  const opening = IMPERATIVE_OPENING.exec(plain);
  if (opening && !NOT_A_VERB.test(opening[1])) return true;
  if (/[^\x00-\x7F]/.test(plain)) return new RegExp("\\p{L}.*\\p{L}", "u").test(plain);
  return !ENGLISH_WORDS.test(plain) && (plain.match(/\b[a-z]{3,}\b/gi) ?? []).length >= 2;
}
var ENGLISH_ACTION = /\b(?:make|build|create|implement|design|fix|investigate|audit|review|write|rewrite|show|see|find|search|explain|compare|help|convert|add|remove|update|rename|run|test|verify|deploy|analyze|analyse|read|tell|open|generate|ship|merge|commit|push|release|publish|set up|i want|i need|can you|could you|would you|how (?:can|do|does|is)|what (?:is|are|does|did)|why (?:is|are|does|did)|do we|do you|(?:is|are|seems?|looks?) (?:broken|failing|wrong)|doesn'?t work|not working)\b/i;
var IMPERATIVE_OPENING = /^(?:please\s+)?([a-z]{3,})\s+(?:the|this|that|these|those|all|every|each|my|our|your|its|it|them|any|some|a|an)\b/i;
var NOT_A_VERB = /^(?:the|and|for|with|from|now|then|just|not|about|after|before|into|onto|over|under|like|also|here|there|when|where|what|which|who|why|how|but|yet|all|any|some|its|our|your|this|that|these|those|they|she|his|her|one|two|three)$/i;
var ENGLISH_WORDS = /\b(?:the|a|an|this|that|it|is|are|to|of|and|for|with|in|on|my|me|you|we|please|just|all|so|now|then|from|be|not)\b/i;
var isConversationKey = (value) => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed[0] === "conversation" && parsed.length === 3;
  } catch {
    return false;
  }
};
function conversationKey(session) {
  if (!session?.content_session_id || !session?.platform_source) return null;
  return JSON.stringify(["conversation", session.platform_source, session.content_session_id]);
}
function originalFor(session, prompts) {
  const ordered = prompts.filter((prompt) => prompt.session_db_id === session.id).sort((a, b) => (a.prompt_number ?? Infinity) - (b.prompt_number ?? Infinity) || (a.created_at_epoch ?? 0) - (b.created_at_epoch ?? 0) || a.id - b.id);
  const first = ordered.find((prompt) => isHumanActionRequest(prompt.prompt_text));
  if (isHumanActionRequest(session.user_prompt) && (!first || first.prompt_number > 1)) return { text: requestText(session.user_prompt), source: "session-initial-request", sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  if (first) return { text: requestText(first.prompt_text), source: "user-prompt", sourceId: first.id, url: `/api/work-view/evidence/prompt/${first.id}`, promptNumber: first.prompt_number, atEpoch: first.created_at_epoch ?? null };
  if (isHumanActionRequest(session.user_prompt)) return { text: requestText(session.user_prompt), source: "session-initial-request", sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  return null;
}

// src/services/work-view/owner-goals.mjs
var OWNER_GOALS_LIST = "owner-goals";

// src/services/work-view/request-groups.mjs
var DATA_DIR2 = process.env.CLAUDE_MEM_DATA_DIR || join7(homedir6(), ".claude-mem");
var LEDGER_DIR = join7(DATA_DIR2, "work-view");
var AGENT_WRITTEN_PROMPTS_FILE = "agent-written-prompts.json";
var DAY_MS = 864e5;
var GOALS_STALE_MS = DAY_MS;
var MAX_CONVERSATIONS_PER_LINKING_LIST = 8;
var PROGRESS_STATES = ["shipped", "in-progress", "stalled", "abandoned", "unknown"];
var PREFERENCE_KINDS = ["directive", "correction", "praise", "frustration"];
var USAGE_LEVELS = ["in-use", "some-use", "no-evidence", "unknown"];
var VALUE_LEVELS = ["high", "medium", "low", "unclear"];
var LINK_KINDS = ["shared-work-list", "shared-request-id", "agent-judgment"];
var MAX_READINGS = 20;
var iso = (epoch) => Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
var groupIdFor = (anchorConversationKey) => `g_${createHash("sha256").update(anchorConversationKey).digest("hex").slice(0, 12)}`;
function placeholders(values) {
  return values.map(() => "?").join(",");
}
function readCandidates(database, { sinceEpoch = 0, conversationKeys = null, fullAsks = false, excludedPromptIds = null }) {
  const columns = "SELECT id, platform_source, content_session_id, project, user_prompt, started_at_epoch FROM sdk_sessions";
  const pairs = conversationKeys?.map((key) => JSON.parse(key).slice(1));
  const stored = pairs ? pairs.length ? database.prepare(`${columns} WHERE (platform_source, content_session_id) IN (VALUES ${pairs.map(() => "(?, ?)").join(",")})`).all(...pairs.flat()) : [] : database.prepare(`${columns} WHERE started_at_epoch >= ?
        OR id IN (SELECT DISTINCT session_db_id FROM user_prompts WHERE created_at_epoch >= ?)
        OR id IN (SELECT DISTINCT session_db_id FROM tool_uses WHERE created_at_epoch >= ?)
        OR memory_session_id IN (SELECT DISTINCT memory_session_id FROM observations WHERE created_at_epoch >= ?)`).all(sinceEpoch, sinceEpoch, sinceEpoch, sinceEpoch);
  if (!stored.length) return [];
  const sessions = withDerivedProjects(database, stored);
  const ids = sessions.map((session) => session.id);
  const prompts = database.prepare(`SELECT id, session_db_id, prompt_number, ${fullAsks ? "prompt_text" : "substr(prompt_text, 1, 1200) AS prompt_text"}, created_at_epoch
    FROM user_prompts WHERE session_db_id IN (${placeholders(ids)})`).all(...ids);
  const writes = database.prepare(`SELECT session_db_id, tool_input, created_at_epoch FROM tool_uses
    WHERE tool_name LIKE '%work_state_write%' AND session_db_id IN (${placeholders(ids)})`).all(...ids);
  const observations = database.prepare(`SELECT s.id AS session_db_id, COUNT(*) AS count, MAX(o.created_at_epoch) AS last_epoch
    FROM observations o JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE s.id IN (${placeholders(ids)}) GROUP BY s.id`).all(...ids);
  const observationsBySession = new Map(observations.map((row) => [row.session_db_id, row]));
  const toolActivity = database.prepare(`SELECT session_db_id, MAX(created_at_epoch) AS last_epoch FROM tool_uses
    WHERE session_db_id IN (${placeholders(ids)}) GROUP BY session_db_id`).all(...ids);
  const lastToolUseBySession = new Map(toolActivity.map((row) => [row.session_db_id, row.last_epoch ?? 0]));
  const promptsBySession = /* @__PURE__ */ new Map();
  for (const prompt of prompts) {
    if (!promptsBySession.has(prompt.session_db_id)) promptsBySession.set(prompt.session_db_id, []);
    promptsBySession.get(prompt.session_db_id).push(prompt);
  }
  const candidates = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const key = conversationKey(session);
    const all = promptsBySession.get(session.id) ?? [];
    const own = all.filter((prompt) => !excludedPromptIds?.has(prompt.id));
    const openingRejected = all.some((prompt) => excludedPromptIds?.has(prompt.id) && (prompt.prompt_number === 1 || prompt.prompt_text === session.user_prompt));
    const original = key ? originalFor(openingRejected ? { ...session, user_prompt: null } : session, own) : null;
    if (!original) continue;
    own.sort((a, b) => a.created_at_epoch - b.created_at_epoch || a.id - b.id);
    const lastPrompt = own.at(-1)?.created_at_epoch ?? 0;
    const asks = own.filter((prompt) => isHumanActionRequest(prompt.prompt_text)).map((prompt) => ({ promptId: prompt.id, at: iso(prompt.created_at_epoch), text: requestText(prompt.prompt_text, fullAsks ? Infinity : 280) }));
    candidates.set(key, {
      conversationKey: key,
      platform: session.platform_source,
      project: session.project,
      startedAt: iso(original.atEpoch ?? session.started_at_epoch),
      startedAtEpoch: original.atEpoch ?? session.started_at_epoch,
      lastActivityEpoch: Math.max(lastPrompt, observationsBySession.get(session.id)?.last_epoch ?? 0, lastToolUseBySession.get(session.id) ?? 0, session.started_at_epoch ?? 0),
      firstAsk: requestText(original.text, 600),
      asks: fullAsks ? asks : asks.slice(0, 10),
      askCount: asks.length,
      original,
      workLists: [],
      requestIds: [],
      observationCount: observationsBySession.get(session.id)?.count ?? 0,
      sessionDbId: session.id
    });
  }
  const bySession = new Map([...candidates.values()].map((candidate) => [candidate.sessionDbId, candidate]));
  for (const write of writes) {
    const candidate = bySession.get(write.session_db_id);
    if (!candidate) continue;
    let input;
    try {
      input = JSON.parse(write.tool_input);
    } catch {
      continue;
    }
    if (typeof input?.list === "string" && !candidate.workLists.includes(input.list)) candidate.workLists.push(input.list);
    const requestId = input?.fields?.request_id;
    if (["string", "number"].includes(typeof requestId) && String(requestId).trim() && !candidate.requestIds.includes(String(requestId).trim())) candidate.requestIds.push(String(requestId).trim());
    candidate.lastActivityEpoch = Math.max(candidate.lastActivityEpoch, write.created_at_epoch ?? 0);
  }
  return [...candidates.values()].sort((a, b) => a.startedAtEpoch - b.startedAtEpoch).map(({ sessionDbId, lastActivityEpoch, ...candidate }) => ({ ...candidate, lastActivityAt: iso(lastActivityEpoch), lastActivityEpoch }));
}
function linkBackwards(candidates) {
  const parent = new Map(candidates.map((candidate) => [candidate.conversationKey, candidate.conversationKey]));
  const find = (key) => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const links = [];
  const skippedLists = [];
  const shared = (kind, field) => {
    const owners = /* @__PURE__ */ new Map();
    for (const candidate of candidates) for (const value of candidate[field]) {
      const scope = JSON.stringify([projectRoot(candidate.project), value]);
      if (!owners.has(scope)) owners.set(scope, { value, project: candidate.project, keys: [] });
      owners.get(scope).keys.push(candidate.conversationKey);
    }
    for (const { value, project, keys } of owners.values()) {
      if (keys.length < 2) continue;
      if (kind === "shared-work-list" && keys.length > MAX_CONVERSATIONS_PER_LINKING_LIST) {
        skippedLists.push({ list: value, project, conversations: keys.length });
        continue;
      }
      for (const key of keys.slice(1)) parent.set(find(key), find(keys[0]));
      links.push({ kind, conversations: keys, evidence: kind === "shared-work-list" ? `work list "${value}" in ${project}` : `request_id "${value}"` });
    }
  };
  shared("shared-request-id", "requestIds");
  shared("shared-work-list", "workLists");
  const groups = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const root = find(candidate.conversationKey);
    if (!groups.has(root)) groups.set(root, { conversations: [], links: [] });
    groups.get(root).conversations.push(candidate.conversationKey);
  }
  for (const link of links) groups.get(find(link.conversations[0])).links.push(link);
  return { proposedGroups: [...groups.values()], skippedLists };
}
function readGoals(database) {
  const rows = database.prepare("SELECT fields FROM work_state_entries WHERE list_name = ? ORDER BY id").all(OWNER_GOALS_LIST);
  const listState = {}, items = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const fields = JSON.parse(row.fields);
    const target = fields.task ? items.get(fields.task) ?? items.set(fields.task, {}).get(fields.task) : listState;
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete target[key];
      else target[key] = value;
    }
  }
  const goals = [...items.values()].filter((item) => !["done", "dropped"].includes(String(item.status).toLowerCase())).map((item) => ({
    goal: item.task,
    kind: item.goal_kind === "open-ask" ? "open-ask" : "priority",
    rank: Number(item.rank) || null,
    title: item.title ?? item.task,
    product: item.product ?? null,
    latestAt: item.latest_at ?? null,
    timesAsked: Number(item.times_asked) || null,
    // A later local refresh changes snapshot, so it cannot reuse an older hosted JSON evidence field.
    evidence: item.source === "hosted-intent" && item.hosted_snapshot === item.snapshot ? JSON.parse(item.evidence_json) : String(item.evidence ?? "").split("\n").filter(Boolean).map((line) => {
      const [at, ...quote] = line.split(" | ");
      return { at, quote: quote.join(" | ") };
    })
  })).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "priority" ? -1 : 1) || (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return { summary: listState.human_summary ?? null, generatedAt: listState.generated_at ?? null, mapPath: listState.map_path ?? null, goals };
}
function validateAlignment(input, { groups, goals }) {
  const goalNames = new Set(goals.map((goal) => goal.goal));
  if (!Array.isArray(input?.links)) throw new TypeError("Alignment needs a links array.");
  const links = {};
  for (const [index, link] of input.links.entries()) {
    if (!groups[link.groupId]) throw new TypeError(`links[${index}] has unknown group ${link.groupId}.`);
    if (!goalNames.has(link.goal)) throw new TypeError(`links[${index}].goal must be a current goal's exact "goal" value.`);
    (links[link.groupId] ??= []).push({ goal: link.goal, evidence: boundedText(link.evidence, 300, `links[${index}].evidence`) });
  }
  const unaligned = [...new Set(input.unaligned ?? [])];
  for (const groupId of unaligned) {
    if (!groups[groupId]) throw new TypeError(`unaligned has unknown group ${groupId}.`);
    if (links[groupId]) throw new TypeError(`Group ${groupId} is both linked and unaligned.`);
  }
  return { links, unaligned };
}
function readJson(path3, fallback) {
  try {
    return JSON.parse(readFileSync6(path3, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function writeJsonAtomic(path3, value) {
  mkdirSync4(join7(path3, ".."), { recursive: true });
  const temp = `${path3}.tmp`;
  writeFileSync2(temp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
  renameSync2(temp, path3);
}
var emptyGroups = () => ({ version: 1, updatedAt: null, conversations: {}, groups: {}, ignored: {} });
function applyGroupDecisions(stored, decisions, now = Date.now(), { projectOf = /* @__PURE__ */ new Map() } = {}) {
  if (!Array.isArray(decisions?.groups)) throw new TypeError("Decisions need a groups array.");
  const next = structuredClone(stored ?? emptyGroups());
  for (const [index, decision] of decisions.groups.entries()) {
    const label = `groups[${index}]`;
    if (typeof decision.title !== "string" || !decision.title.trim() || decision.title.length > 120) throw new TypeError(`${label}.title must be 1\u2013120 characters.`);
    if (!Array.isArray(decision.conversations) || !decision.conversations.length || !decision.conversations.every(isConversationKey)) throw new TypeError(`${label}.conversations must list conversation keys, earliest first.`);
    const links = decision.links ?? [];
    const members = new Set(decision.conversations);
    const parent = new Map(decision.conversations.map((key) => [key, key]));
    const find = (key) => {
      while (parent.get(key) !== key) key = parent.get(key);
      return key;
    };
    for (const link of links) {
      if (!LINK_KINDS.includes(link.kind)) throw new TypeError(`${label} has unknown link kind ${link.kind}.`);
      if (typeof link.evidence !== "string" || !link.evidence.trim()) throw new TypeError(`${label} has a link without evidence.`);
      if (!Array.isArray(link.conversations) || link.conversations.length < 2 || !link.conversations.every((key) => members.has(key))) throw new TypeError(`${label} has a link that must name 2+ of the group's own conversations.`);
      for (const key of link.conversations.slice(1)) parent.set(find(key), find(link.conversations[0]));
    }
    if (decision.conversations.length > 1 && !links.length) throw new TypeError(`${label} joins conversations without a recorded link.`);
    const unsupported = decision.conversations.filter((key) => find(key) !== find(decision.conversations[0]));
    if (unsupported.length) throw new TypeError(`${label} joins ${unsupported.join(", ")} without evidence linking it to the anchor.`);
    const id = groupIdFor(decision.conversations[0]);
    const allMembers = [.../* @__PURE__ */ new Set([...decision.conversations, ...Object.entries(next.conversations).filter(([key, groupId]) => groupId === id && !decision.conversations.includes(key)).map(([key]) => key)])];
    const storedRoot = upgradedGroupRoot(
      next.groups[id]?.projectRoot,
      projectRoot(projectOf.get(next.groups[id]?.anchor)),
      allMembers.map((key) => projectRoot(projectOf.get(key)))
    );
    const rootWasUnknown = storedRoot === NO_PROJECT;
    const roots = /* @__PURE__ */ new Map();
    for (const key of allMembers) {
      const root = projectRoot(projectOf.get(key));
      if (root == null || rootWasUnknown && root === NO_PROJECT && !decision.conversations.includes(key)) continue;
      roots.set(root, [...roots.get(root) ?? [], key]);
    }
    if (typeof storedRoot === "string" && !rootWasUnknown && !roots.has(storedRoot)) roots.set(storedRoot, []);
    if (roots.size > 1) throw new TypeError(`${label} joins conversations from different projects (${[...roots.keys()].map((root) => root || "no project").join(", ")}); a request stays inside one project root.`);
    const projectRootOfGroup = roots.size ? [...roots.keys()][0] : storedRoot ?? null;
    for (const key of decision.conversations) {
      next.conversations[key] = id;
      if (next.ignored) delete next.ignored[key];
    }
    next.groups[id] = { title: decision.title.trim(), anchor: decision.conversations[0], projectRoot: projectRootOfGroup, links, decidedAt: iso(now), anchorAsk: stored?.groups?.[id]?.anchor === decision.conversations[0] ? stored.groups[id].anchorAsk ?? null : null };
  }
  next.ignored ??= {};
  for (const [index, ignored] of (decisions.ignored ?? []).entries()) {
    if (!isConversationKey(ignored.conversation)) throw new TypeError(`ignored[${index}].conversation must be a conversation key.`);
    next.ignored[ignored.conversation] = boundedText(ignored.reason, 200, `ignored[${index}].reason`);
    delete next.conversations[ignored.conversation];
  }
  const used = new Set(Object.values(next.conversations));
  for (const id of Object.keys(next.groups)) if (!used.has(id)) delete next.groups[id];
  next.updatedAt = iso(now);
  return next;
}
var isIsoOrNull = (value) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
function boundedText(value, max, label, optional = false) {
  if (optional && (value == null || value === "")) return "";
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be 1\u2013${max} characters.`);
  if (value.length > max) throw new TypeError(`${label} is ${value.length} characters; it must be 1\u2013${max}. Cut at least ${value.length - max} characters.`);
  return value.trim();
}
var evidenceList = (value) => (Array.isArray(value) ? value : []).map(String).slice(0, 8);
function validateOutcome(outcome) {
  if (outcome == null) return null;
  if (typeof outcome !== "object" || Array.isArray(outcome)) throw new TypeError("outcome must be an object.");
  const leveled = (entry, levels, label) => {
    if (entry == null) return null;
    if (!levels.includes(entry.level)) throw new TypeError(`${label}.level must be one of ${levels.join(", ")}.`);
    return { level: entry.level, text: boundedText(entry.text, 400, `${label}.text`), evidence: evidenceList(entry.evidence) };
  };
  const regressions = outcome.regressions ?? [], changes = outcome.changes ?? [];
  if (!Array.isArray(regressions) || regressions.length > 10) throw new TypeError("outcome.regressions must be an array of at most 10.");
  if (!Array.isArray(changes) || changes.length > 12) throw new TypeError("outcome.changes must be an array of at most 12.");
  const dated = (value, label) => {
    if (!isIsoOrNull(value ?? null)) throw new TypeError(`${label} must be an ISO date or null.`);
    return value ?? null;
  };
  return {
    landed: outcome.landed == null ? null : { text: boundedText(outcome.landed.text, 400, "outcome.landed.text"), at: dated(outcome.landed.at, "outcome.landed.at"), evidence: evidenceList(outcome.landed.evidence) },
    usage: leveled(outcome.usage, USAGE_LEVELS, "outcome.usage"),
    value: leveled(outcome.value, VALUE_LEVELS, "outcome.value"),
    regressions: regressions.map((regression, index) => ({
      text: boundedText(regression.text, 300, `outcome.regressions[${index}].text`),
      at: dated(regression.at, `outcome.regressions[${index}].at`),
      fixedBy: boundedText(regression.fixedBy, 200, `outcome.regressions[${index}].fixedBy`, true) || null,
      evidence: evidenceList(regression.evidence)
    })),
    changes: changes.map((change, index) => ({
      what: boundedText(change.what, 200, `outcome.changes[${index}].what`),
      why: boundedText(change.why, 400, `outcome.changes[${index}].why`),
      at: dated(change.at, `outcome.changes[${index}].at`),
      evidence: evidenceList(change.evidence)
    }))
  };
}
function validateProgress(entry, knownGroups) {
  if (!entry || typeof entry !== "object") throw new TypeError("Progress must be an object.");
  if (!knownGroups[entry.groupId]) throw new TypeError(`Unknown group ${entry.groupId}.`);
  const basis = entry.reviewBasis;
  if (!basis || typeof basis.checkedThrough !== "string" || !Number.isFinite(Date.parse(basis.checkedThrough)) || !Array.isArray(basis.conversations) || !basis.conversations.length || !basis.conversations.every(isConversationKey)) {
    throw new TypeError("reviewBasis must be copied verbatim from `show` (checkedThrough and conversations).");
  }
  if (!PROGRESS_STATES.includes(entry.state)) throw new TypeError(`state must be one of ${PROGRESS_STATES.join(", ")}.`);
  if (!Number.isInteger(entry.percent) || entry.percent < 0 || entry.percent > 100) throw new TypeError("percent must be an integer 0\u2013100.");
  for (const field of ["startedAt", "shippedAt", "lastActivityAt"]) if (!isIsoOrNull(entry[field] ?? null)) throw new TypeError(`${field} must be an ISO date or null.`);
  if (entry.state === "shipped" && (entry.percent !== 100 || !entry.shippedAt)) throw new TypeError("A shipped request needs percent 100 and shippedAt.");
  if (entry.state !== "shipped" && entry.shippedAt) throw new TypeError("Only a shipped request has shippedAt.");
  const milestones = entry.milestones ?? [], preferences = entry.preferences ?? [];
  if (!Array.isArray(milestones) || milestones.length > 12) throw new TypeError("milestones must be an array of at most 12.");
  if (!Array.isArray(preferences) || preferences.length > 10) throw new TypeError("preferences must be an array of at most 10.");
  return {
    groupId: entry.groupId,
    state: entry.state,
    percent: entry.percent,
    startedAt: entry.startedAt ?? null,
    shippedAt: entry.shippedAt ?? null,
    lastActivityAt: entry.lastActivityAt ?? null,
    summary: boundedText(entry.summary, 280, "summary"),
    narrative: boundedText(entry.narrative, 1200, "narrative", true),
    milestones: milestones.map((milestone, index) => {
      if (!isIsoOrNull(milestone.at ?? null)) throw new TypeError(`milestones[${index}].at must be an ISO date or null.`);
      return { at: milestone.at ?? null, text: boundedText(milestone.text, 200, `milestones[${index}].text`), evidence: (milestone.evidence ?? []).map(String).slice(0, 6) };
    }),
    preferences: preferences.map((preference, index) => {
      if (!PREFERENCE_KINDS.includes(preference.kind)) throw new TypeError(`preferences[${index}].kind must be one of ${PREFERENCE_KINDS.join(", ")}.`);
      if (!isIsoOrNull(preference.at ?? null)) throw new TypeError(`preferences[${index}].at must be an ISO date or null.`);
      return { kind: preference.kind, preference: boundedText(preference.preference, 200, `preferences[${index}].preference`), quote: boundedText(preference.quote, 300, `preferences[${index}].quote`), at: preference.at ?? null };
    }),
    outcome: validateOutcome(entry.outcome),
    evidence: (entry.evidence ?? []).map(String).slice(0, 20),
    // What the reviewer actually saw: later activity or membership changes make it due again.
    reviewedThrough: new Date(Date.parse(basis.checkedThrough)).toISOString(),
    reviewedConversations: [...new Set(basis.conversations)].sort()
  };
}
function storyFacts(review) {
  return {
    state: review.state,
    percent: review.percent,
    startedAt: review.startedAt ?? null,
    shippedAt: review.shippedAt ?? null,
    milestones: review.milestones ?? [],
    preferences: review.preferences ?? [],
    outcome: review.outcome ?? null
  };
}
function appendReading(previous, reading) {
  const byAt = new Map((previous?.readings ?? []).filter((item) => Number.isFinite(Date.parse(item?.at)) && Number.isInteger(item?.percent)).map((item) => [item.at, item]));
  byAt.set(reading.at, { at: reading.at, percent: reading.percent });
  return [...byAt.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_READINGS);
}
function reviewIsCurrent(review, conversationKeys, lastActivityEpoch) {
  if (!review?.reviewedThrough || !Array.isArray(review.reviewedConversations)) return false;
  const current = [...new Set(conversationKeys)].sort();
  if (current.length !== review.reviewedConversations.length || current.some((key, index) => key !== review.reviewedConversations[index])) return false;
  return Date.parse(review.reviewedThrough) >= lastActivityEpoch;
}
var STORY_NARRATIVE_MAX = 12e3;
function validateStory(story) {
  const preferences = story?.preferences ?? [];
  if (!Array.isArray(preferences) || preferences.length > 30) throw new TypeError("preferences must be an array of at most 30.");
  return {
    narrative: boundedText(story?.narrative, STORY_NARRATIVE_MAX, "narrative"),
    preferences: preferences.map((preference, index) => ({
      preference: boundedText(preference.preference, 200, `preferences[${index}].preference`),
      kind: PREFERENCE_KINDS.includes(preference.kind) ? preference.kind : "directive",
      supportCount: Number.isInteger(preference.supportCount) && preference.supportCount > 0 ? preference.supportCount : 1,
      quotes: (preference.quotes ?? []).slice(0, 3).map((quote, quoteIndex) => ({ quote: boundedText(quote.quote, 300, `preferences[${index}].quotes[${quoteIndex}]`), at: isIsoOrNull(quote.at ?? null) ? quote.at ?? null : null }))
    }))
  };
}
function readLedger(dir = LEDGER_DIR) {
  const groups = readJson(join7(dir, "request-groups.json"), emptyGroups());
  const progress = {};
  let names = [];
  try {
    names = readdirSync(join7(dir, "progress")).filter((name) => /^g_[0-9a-f]{12}\.json$/.test(name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const entry = readJson(join7(dir, "progress", name), null);
    if (entry?.groupId && groups.groups[entry.groupId]) progress[entry.groupId] = { ...entry, title: groups.groups[entry.groupId].title };
  }
  return {
    groups,
    progress,
    story: readJson(join7(dir, "story.json"), null),
    alignment: readJson(join7(dir, "alignment.json"), null),
    refresh: readJson(join7(dir, "refresh.json"), null),
    agentWrittenPromptIds: new Set(readJson(join7(dir, AGENT_WRITTEN_PROMPTS_FILE), { promptIds: [] }).promptIds ?? [])
  };
}
function groupDetails(groupId, ledger, candidatesByKey) {
  const group = ledger.groups.groups[groupId];
  const conversations = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => candidatesByKey.get(key) ?? { conversationKey: key, outsideWindow: true });
  const loaded = conversations.filter((conversation) => !conversation.outsideWindow);
  return {
    groupId,
    title: group.title,
    links: group.links,
    anchorAsk: group.anchorAsk ?? null,
    startedAt: iso(Math.min(...loaded.map((conversation) => conversation.startedAtEpoch ?? Infinity))),
    lastActivityAt: iso(Math.max(0, ...loaded.map((conversation) => conversation.lastActivityEpoch ?? 0))),
    lastActivityEpoch: Math.max(0, ...loaded.map((conversation) => conversation.lastActivityEpoch ?? 0)),
    projects: [...new Set(loaded.map((conversation) => conversation.project))],
    conversations: conversations.map(({ lastActivityEpoch, startedAtEpoch, original, ...conversation }) => conversation),
    previousReview: ledger.progress[groupId] ?? null
  };
}
function pendingReviews(ledger, database, sinceEpoch) {
  const candidates = new Map(readCandidates(database, { sinceEpoch, excludedPromptIds: ledger.agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate]));
  const ungrouped = [...candidates.keys()].filter((key) => !ledger.groups.conversations[key] && !ledger.groups.ignored?.[key]).length;
  const ids = [...new Set([...candidates.keys()].map((key) => ledger.groups.conversations[key]).filter(Boolean))];
  const due = ids.map((id) => groupDetails(id, ledger, candidates)).filter((group) => !reviewIsCurrent(group.previousReview, group.conversations.map((conversation) => conversation.conversationKey), group.lastActivityEpoch)).sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch);
  return { due, ungrouped };
}
function goalsAddedSince(alignment, goalKeys) {
  const seen = new Set(alignment?.goals ?? goalKeys);
  return goalKeys.filter((goal) => !seen.has(goal));
}
function alignmentRecord(ledger, groupId) {
  const group = ledger.groups.groups[groupId], review = ledger.progress[groupId];
  return { groupId, title: group.title, firstAsk: group.anchorAsk?.text?.slice(0, 400) ?? null, state: review?.state ?? null, percent: review?.percent ?? null, summary: review?.summary ?? null };
}
function alignmentBasis(ledger, groupId) {
  const conversations = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => key).sort();
  return createHash("sha256").update(JSON.stringify({ ...alignmentRecord(ledger, groupId), conversations })).digest("hex").slice(0, 16);
}
function alignmentDue(ledger, goals) {
  if (!goals.goals.length) return [];
  const current = goals.goals.map((goal) => goal.goal);
  const links = ledger.alignment?.links ?? {}, unaligned = new Set(ledger.alignment?.unaligned ?? []), basis = ledger.alignment?.basis;
  if (goalsAddedSince(ledger.alignment, current).length) return Object.keys(ledger.groups.groups);
  const changed = (id) => basis != null && basis[id] !== alignmentBasis(ledger, id);
  return Object.keys(ledger.groups.groups).filter((id) => changed(id) || (links[id] ? links[id].some((link) => !current.includes(link.goal)) : !unaligned.has(id)));
}
function refreshNeeds({ dir = LEDGER_DIR, database, now = Date.now(), days = 14 }) {
  const ledger = readLedger(dir);
  const { due, ungrouped } = pendingReviews(ledger, database, now - days * DAY_MS);
  const goals = readGoals(database);
  const generated = Date.parse(goals.generatedAt ?? "");
  const goalsStale = !Number.isFinite(generated) || now - generated > GOALS_STALE_MS;
  const unaligned = alignmentDue(ledger, goals).length;
  return { due: due.length, ungrouped, goalsStale, unaligned, needed: Boolean(due.length || ungrouped || goalsStale || unaligned) };
}
function readInput(source) {
  return JSON.parse(readFileSync6(source === "-" ? 0 : source, "utf8"));
}
function textOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
}
function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`--${name} must be a positive integer.`);
  return value;
}
function openDatabase() {
  const path3 = process.env.CLAUDE_MEM_DB ?? join7(DATA_DIR2, "claude-mem.db");
  statSync5(path3);
  const database = new Database(path3, { readonly: true, create: false });
  database.exec("PRAGMA busy_timeout = 1500");
  return database;
}
function readConversationProjects(database, conversationKeys) {
  const pairs = [...new Set(conversationKeys)].filter(isConversationKey).map((key) => JSON.parse(key).slice(1));
  const sessions = [];
  for (let index = 0; index < pairs.length; index += 400) {
    const chunk = pairs.slice(index, index + 400);
    sessions.push(...database.prepare(`SELECT id, platform_source, content_session_id, project FROM sdk_sessions WHERE (platform_source, content_session_id) IN (VALUES ${chunk.map(() => "(?, ?)").join(",")})`).all(...chunk.flat()));
  }
  return new Map(withDerivedProjects(database, sessions).map((session) => [conversationKey(session), session.project]));
}
var GROUPING_BATCH = 20;
var CLOSED_STATES = /* @__PURE__ */ new Set(["shipped", "abandoned"]);
function groupingInput(ledger, database, { sinceEpoch, limit = GROUPING_BATCH }) {
  const candidates = readCandidates(database, { sinceEpoch, excludedPromptIds: ledger.agentWrittenPromptIds });
  const decided = (key) => Boolean(ledger.groups.conversations[key] || ledger.groups.ignored?.[key]);
  const fresh = candidates.filter((candidate) => !decided(candidate.conversationKey));
  if (!fresh.length) return { root: null, conversations: [], openRequests: [], proposedLinks: [], remaining: 0 };
  const root = projectRoot(fresh[0].project);
  const batch = fresh.filter((candidate) => projectRoot(candidate.project) === root).slice(0, limit);
  const inRoot = candidates.filter((candidate) => projectRoot(candidate.project) === root);
  const byKey = new Map(inRoot.map((candidate) => [candidate.conversationKey, candidate]));
  const rootIsStored = (group) => typeof group.projectRoot === "string" && group.projectRoot !== NO_PROJECT;
  const mayBeUpgraded = (group) => root.includes("/") && rootIsStored(group) && root.startsWith(`${group.projectRoot}/`);
  const anchorProjects = readConversationProjects(database, Object.values(ledger.groups.groups).filter((group) => !rootIsStored(group) || mayBeUpgraded(group)).map((group) => group.anchor));
  const groupRoot = (group) => rootIsStored(group) ? upgradedGroupRoot(group.projectRoot, projectRoot(anchorProjects.get(group.anchor))) : projectRoot(anchorProjects.get(group.anchor)) ?? group.projectRoot ?? null;
  const openRequests = Object.entries(ledger.groups.groups).filter(([groupId, group]) => groupRoot(group) === root && !CLOSED_STATES.has(ledger.progress[groupId]?.state)).map(([groupId, group]) => {
    const members = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => byKey.get(key)).filter(Boolean);
    const asks = members.flatMap((member) => member.asks).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return {
      groupId,
      title: group.title,
      anchor: group.anchor,
      anchorAsk: requestText(group.anchorAsk?.text ?? members[0]?.firstAsk ?? "", 400),
      recentAsks: asks.slice(0, 3).map((ask) => ask.text.slice(0, 200)),
      lastActivityEpoch: Math.max(0, ...members.map((member) => member.lastActivityEpoch ?? 0))
    };
  }).sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch).map(({ lastActivityEpoch, ...request }) => ({ ...request, lastActivityAt: iso(lastActivityEpoch) }));
  const batchKeys = new Set(batch.map((candidate) => candidate.conversationKey));
  const proposedLinks = linkBackwards(inRoot).proposedGroups.filter((group) => group.links.length && group.conversations.some((key) => batchKeys.has(key))).flatMap((group) => group.links).map((link) => ({ ...link, groups: [...new Set(link.conversations.map((key) => ledger.groups.conversations[key]).filter(Boolean))] }));
  return {
    root,
    conversations: batch.map((candidate) => ({ conversationKey: candidate.conversationKey, project: candidate.project, startedAt: candidate.startedAt, openingAsk: requestText(candidate.firstAsk, 400), workLists: candidate.workLists })),
    openRequests,
    proposedLinks,
    remaining: fresh.length - batch.length
  };
}
function runCli(argv, { dir = LEDGER_DIR, database = null, now = Date.now(), print = (value) => console.log(JSON.stringify(value, null, 2)) } = {}) {
  const [command, ...args] = argv;
  const db = () => database ?? openDatabase();
  const since = () => now - option(args, "days", 14) * DAY_MS;
  if (command === "candidates") {
    const wantedRoot = textOption(args, "project");
    const ledger = readLedger(dir);
    const stored = ledger.groups;
    const candidates = readCandidates(db(), { sinceEpoch: since(), excludedPromptIds: ledger.agentWrittenPromptIds }).filter((candidate) => !stored.ignored?.[candidate.conversationKey] && (wantedRoot == null || projectRoot(candidate.project) === wantedRoot));
    const { proposedGroups, skippedLists } = linkBackwards(candidates);
    const brief = args.includes("--brief");
    const shown = candidates.map(({ lastActivityEpoch, startedAtEpoch, original, ...candidate }) => {
      const currentGroup = stored.conversations[candidate.conversationKey] ?? null;
      return brief ? { conversationKey: candidate.conversationKey, project: candidate.project, startedAt: candidate.startedAt, lastActivityAt: candidate.lastActivityAt, firstAsk: candidate.firstAsk.slice(0, 200), laterAsks: candidate.asks.slice(1, 4).map((ask) => ask.text.slice(0, 120)), workLists: candidate.workLists, currentGroup } : { ...candidate, currentGroup };
    });
    return print({ candidates: shown, proposedGroups: proposedGroups.filter((group) => group.links.length), skippedLists, projects: [...new Set(candidates.map((candidate) => projectRoot(candidate.project)))] });
  }
  if (command === "grouping-input") return print(groupingInput(readLedger(dir), db(), { sinceEpoch: since(), limit: option(args, "limit", GROUPING_BATCH) }));
  if (command === "apply") {
    const database2 = db();
    const stored = readLedger(dir).groups;
    const decisions = readInput(args[0] ?? "-");
    const touched = (decisions?.groups ?? []).flatMap((group) => Array.isArray(group?.conversations) ? group.conversations : []).filter(isConversationKey);
    const touchedGroups = new Set(touched.map((key) => groupIdFor(key)));
    const existing = Object.entries(stored.conversations).filter(([, id]) => touchedGroups.has(id)).map(([key]) => key);
    const next = applyGroupDecisions(stored, decisions, now, { projectOf: readConversationProjects(database2, [...touched, ...existing]) });
    const missing = Object.values(next.groups).filter((group) => !group.anchorAsk).map((group) => group.anchor);
    const anchors = new Map(readCandidates(database2, { conversationKeys: missing, excludedPromptIds: readLedger(dir).agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate.original]));
    for (const group of Object.values(next.groups)) if (!group.anchorAsk && anchors.has(group.anchor)) group.anchorAsk = anchors.get(group.anchor);
    writeJsonAtomic(join7(dir, "request-groups.json"), next);
    return print({ groups: Object.keys(next.groups).length, conversations: Object.keys(next.conversations).length });
  }
  if (command === "pending" || command === "show") {
    const ledger = readLedger(dir);
    if (command === "show") {
      if (!ledger.groups.groups[args[0]]) throw new TypeError(`Unknown group ${args[0]}.`);
      const keys = Object.entries(ledger.groups.conversations).filter(([, id]) => id === args[0]).map(([key]) => key);
      const candidates = new Map(readCandidates(db(), { conversationKeys: keys, fullAsks: true, excludedPromptIds: ledger.agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate]));
      const details = groupDetails(args[0], ledger, candidates);
      const previous = details.previousReview;
      const amendSince = previous && reviewIsCurrent(previous, keys, 0) ? previous.reviewedThrough : null;
      const since2 = amendSince ? Date.parse(amendSince) : 0;
      const observations = db().prepare(`SELECT o.id, o.type, o.title, o.subtitle, o.created_at_epoch FROM observations o
        JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
        WHERE s.platform_source = ? AND s.content_session_id = ? AND o.created_at_epoch > ? ORDER BY o.created_at_epoch, o.id`);
      const conversations = details.conversations.map((conversation) => {
        const [, platform, sessionId] = JSON.parse(conversation.conversationKey);
        return {
          ...conversation,
          ...conversation.asks && amendSince ? { asks: conversation.asks.filter((ask) => Date.parse(ask.at) > since2) } : {},
          observations: observations.all(platform, sessionId, since2).map((row) => ({ id: row.id, at: iso(row.created_at_epoch), type: row.type, title: row.title, subtitle: row.subtitle }))
        };
      });
      return print({ ...details, conversations, mode: amendSince ? "amend" : "full", amendSince, reviewBasis: { checkedThrough: iso(now), conversations: keys.sort() } });
    }
    const { due, ungrouped } = pendingReviews(ledger, db(), since());
    const limit = option(args, "limit", 48);
    return print({ due: due.length, groups: due.slice(0, limit).map((group) => ({ groupId: group.groupId, title: group.title, lastActivityAt: group.lastActivityAt, conversations: group.conversations.length })), deferred: Math.max(0, due.length - limit), ungroupedConversations: ungrouped });
  }
  if (command === "record-progress") {
    const ledger = readLedger(dir);
    const reviewed = validateProgress(readInput(args[0] ?? "-"), ledger.groups.groups);
    const checkedAt = iso(now);
    const previous = ledger.progress[reviewed.groupId];
    const unchanged = previous && JSON.stringify(storyFacts(previous)) === JSON.stringify(storyFacts(reviewed));
    const entry = { ...reviewed, checkedAt, changedAt: unchanged ? previous.changedAt ?? previous.checkedAt : checkedAt, readings: appendReading(ledger.progress[reviewed.groupId], { at: checkedAt, percent: reviewed.percent }) };
    writeJsonAtomic(join7(dir, "progress", `${entry.groupId}.json`), entry);
    return print({ recorded: entry.groupId, state: entry.state, percent: entry.percent, readings: entry.readings.length });
  }
  if (command === "story-input") {
    const { groups, progress, story } = readLedger(dir);
    const reviews = Object.values(progress).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const writtenAt = Date.parse(story?.writtenAt ?? "");
    const update = Number.isFinite(writtenAt);
    const previousNarrativeChars = story?.narrative?.length ?? 0;
    return print({
      groups: Object.keys(groups.groups).length,
      update,
      narrativeLimit: STORY_NARRATIVE_MAX,
      previousNarrativeChars,
      roomChars: STORY_NARRATIVE_MAX - previousNarrativeChars,
      reviews: update ? reviews.filter((review) => Date.parse(review.changedAt ?? review.checkedAt) > writtenAt) : reviews,
      previousStory: story
    });
  }
  if (command === "record-story") {
    const story = { ...validateStory(readInput(args[0] ?? "-")), writtenAt: iso(now) };
    writeJsonAtomic(join7(dir, "story.json"), story);
    return print({ recorded: "story", preferences: story.preferences.length });
  }
  if (command === "align-input") {
    const ledger = readLedger(dir);
    const goals = readGoals(db());
    const due = alignmentDue(ledger, goals);
    const groups = due.map((groupId) => alignmentRecord(ledger, groupId));
    const previousLinks = Object.fromEntries(due.filter((id) => ledger.alignment?.links?.[id]).map((id) => [id, ledger.alignment.links[id]]));
    return print({ goals, groups, previous: ledger.alignment ? { alignedAt: ledger.alignment.alignedAt ?? null, links: previousLinks } : null });
  }
  if (command === "record-alignment") {
    const ledger = readLedger(dir);
    const goals = readGoals(db());
    const decided = validateAlignment(readInput(args[0] ?? "-"), { groups: ledger.groups.groups, goals: goals.goals });
    const decidedIds = /* @__PURE__ */ new Set([...Object.keys(decided.links), ...decided.unaligned]);
    const missing = alignmentDue(ledger, goals).filter((id) => !decidedIds.has(id));
    if (missing.length) throw new TypeError(`Every group align-input listed must appear in links or unaligned; missing ${missing.join(", ")}.`);
    const kept = (id) => ledger.groups.groups[id] && !decidedIds.has(id);
    const previous = ledger.alignment ?? {};
    const alignment = {
      links: { ...Object.fromEntries(Object.entries(previous.links ?? {}).filter(([id]) => kept(id))), ...decided.links },
      unaligned: [...(previous.unaligned ?? []).filter(kept), ...decided.unaligned],
      // Each decided group's basis, so a later change to the request makes it due again.
      basis: { ...Object.fromEntries(Object.entries(previous.basis ?? {}).filter(([id]) => kept(id))), ...Object.fromEntries([...decidedIds].map((id) => [id, alignmentBasis(ledger, id)])) },
      goals: goals.goals.map((goal) => goal.goal),
      alignedAt: iso(now)
    };
    writeJsonAtomic(join7(dir, "alignment.json"), alignment);
    return print({ aligned: Object.keys(decided.links).length, unaligned: decided.unaligned.length });
  }
  if (command === "refresh-needs") return print(refreshNeeds({ dir, database: db(), now, days: option(args, "days", 14) }));
  throw new TypeError("Usage: request-groups.mjs candidates|apply|pending|show|record-progress|story-input|record-story|align-input|record-alignment|refresh-needs (see file header).");
}

// src/services/work-view/request-groups-cli.mjs
try {
  runCli(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
