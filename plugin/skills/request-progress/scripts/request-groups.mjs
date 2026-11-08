var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

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
var init_expand_home = __esm({
  "src/shared/expand-home.ts"() {
    "use strict";
  }
});

// src/shared/hook-constants.ts
function hookProcessOverheadMs(platform = process.platform) {
  return platform === "win32" ? 8e3 : 5e3;
}
function defaultSessionInitRequestTimeoutMs(platform = process.platform) {
  return HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP - hookProcessOverheadMs(platform);
}
function getTimeout(baseTimeout) {
  return process.platform === "win32" ? Math.round(baseTimeout * HOOK_TIMEOUTS.WINDOWS_MULTIPLIER) : baseTimeout;
}
var SESSION_INIT_HOOK_CAP_MS, HOOK_TIMEOUTS;
var init_hook_constants = __esm({
  "src/shared/hook-constants.ts"() {
    "use strict";
    SESSION_INIT_HOOK_CAP_MS = 15e3;
    HOOK_TIMEOUTS = {
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
  }
});

// src/shared/install-port.ts
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2, resolve, win32 } from "path";
function defaultDataDir() {
  return process.env.CLAUDE_MEM_DATA_DIR || join2(homedir2(), ".claude-mem");
}
function readSettings(dataDir) {
  const settingsPath = join2(expandHome(dataDir), "settings.json");
  if (!existsSync(settingsPath)) return null;
  try {
    const document = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    const nested = document.env;
    return nested && typeof nested === "object" && !Array.isArray(nested) && Object.keys(nested).some((key) => key.startsWith("CLAUDE_MEM_")) ? nested : document;
  } catch {
    return null;
  }
}
function hasLegacyWindowsWorkerPort(dataDir) {
  return readSettings(dataDir)?.CLAUDE_MEM_WORKER_PORT === LEGACY_WINDOWS_WORKER_PORT;
}
function hasLegacyWindowsServerPort(dataDir) {
  const settings2 = readSettings(dataDir);
  return ["CLAUDE_MEM_SERVER_URL", "CLAUDE_MEM_SERVER_BETA_URL"].some((key) => {
    const value = settings2?.[key];
    if (typeof value !== "string") return false;
    try {
      return new URL(value).port === String(LEGACY_WINDOWS_SERVER_PORT);
    } catch {
      return false;
    }
  });
}
function getInstallPortOffset(dataDir = defaultDataDir(), options = {}) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === void 0 ? typeof process.getuid === "function" ? process.getuid() : null : options.uid;
  if (uid !== null) return (uid % 100 + 100) % 100;
  if (platform === "win32" && hasLegacyWindowsWorkerPort(dataDir)) return LEGACY_WINDOWS_PORT_OFFSET;
  const expandedDataDir = expandHome(dataDir, platform);
  let normalizedDataDir = platform === "win32" ? win32.resolve(expandedDataDir) : resolve(expandedDataDir);
  if (platform === "win32") normalizedDataDir = normalizedDataDir.toLowerCase();
  return createHash("sha256").update(normalizedDataDir, "utf8").digest().readUInt32BE(0) % 100;
}
function getDefaultWorkerPort(dataDir, options) {
  return WORKER_PORT_BASE + getInstallPortOffset(dataDir, options);
}
function getDefaultServerPort(dataDir = defaultDataDir(), options = {}) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === void 0 ? typeof process.getuid === "function" ? process.getuid() : null : options.uid;
  if (platform === "win32" && uid === null && hasLegacyWindowsServerPort(dataDir)) {
    return LEGACY_WINDOWS_SERVER_PORT;
  }
  return SERVER_PORT_BASE + getInstallPortOffset(dataDir, options);
}
var WORKER_PORT_BASE, SERVER_PORT_BASE, LEGACY_WINDOWS_WORKER_PORT, LEGACY_WINDOWS_PORT_OFFSET, LEGACY_WINDOWS_SERVER_PORT;
var init_install_port = __esm({
  "src/shared/install-port.ts"() {
    "use strict";
    init_expand_home();
    WORKER_PORT_BASE = 37700;
    SERVER_PORT_BASE = 37877;
    LEGACY_WINDOWS_WORKER_PORT = "37777";
    LEGACY_WINDOWS_PORT_OFFSET = 77;
    LEGACY_WINDOWS_SERVER_PORT = 37954;
  }
});

// src/shared/hook-io.ts
function bypassWrite(chunk) {
  const writer = pinnedBypassWrite ?? process.stderr.write.bind(process.stderr);
  return writer(chunk);
}
function emitDiagnostic(line) {
  bypassWrite(line);
}
var pinnedBypassWrite, pendingModelContext;
var init_hook_io = __esm({
  "src/shared/hook-io.ts"() {
    "use strict";
    pinnedBypassWrite = null;
    pendingModelContext = Promise.resolve();
  }
});

// src/shared/atomic-json.ts
import {
  closeSync,
  existsSync as existsSync3,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync3,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "fs";
import { randomBytes } from "crypto";
import { basename, dirname, join as join4, resolve as resolve2 } from "path";
function stripUtf8Bom(raw) {
  return raw.replace(/^\uFEFF/, "");
}
function parseJsonWithBom(raw) {
  return JSON.parse(stripUtf8Bom(raw));
}
function readJsonFileWithBom(filepath) {
  return parseJsonWithBom(readFileSync3(filepath, "utf-8"));
}
function ensureDirectoryExists(directoryPath) {
  if (!existsSync3(directoryPath)) {
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
    return join4(physicalPathOf(parent), basename(filePath));
  }
}
function resolveSymlinkWriteTarget(filePath) {
  let resolved = filePath;
  const followed = /* @__PURE__ */ new Set();
  try {
    while (lstatSync(resolved).isSymbolicLink()) {
      const absolute = resolve2(resolved);
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
        resolved = resolve2(physicalPathOf(dirname(resolve2(resolved))), linkTarget);
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
function writeBufferAtomic(filepath, payload, options = {}) {
  const resolved = resolveSymlinkWriteTarget(filepath);
  ensureDirectoryExists(dirname(resolved));
  const dir = dirname(resolved);
  const base = basename(resolved);
  const tmpPath = join4(dir, `.${base}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
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
    if (mode !== void 0 && !IS_WINDOWS_PLATFORM) fchmodSync(fd, mode);
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
function writeJsonFileAtomic(filepath, data, options = {}) {
  writeBufferAtomic(filepath, Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf-8"), options);
}
var IS_WINDOWS_PLATFORM, WINDOWS_RENAME_RETRY_CODES, WINDOWS_RENAME_RETRY_DELAYS_MS;
var init_atomic_json = __esm({
  "src/shared/atomic-json.ts"() {
    "use strict";
    init_hook_io();
    IS_WINDOWS_PLATFORM = process.platform === "win32";
    WINDOWS_RENAME_RETRY_CODES = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
    WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];
  }
});

// src/shared/settings-document.ts
import { existsSync as existsSync4, renameSync as renameSync2 } from "fs";
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
function cloneDocument(document) {
  return JSON.parse(JSON.stringify(document));
}
function loadDocument(path4) {
  if (!existsSync4(path4)) return { exists: false };
  try {
    const parsed = readJsonFileWithBom(path4);
    if (!isRecord(parsed)) return { exists: true, error: new Error("settings.json must contain a JSON object") };
    return { exists: true, document: parsed };
  } catch (error) {
    return { exists: true, error };
  }
}
function unusedQuarantinePath(path4) {
  const base = `${path4}.corrupt-${Date.now()}`;
  let candidate = base;
  for (let suffix = 1; existsSync4(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}
function updateSettingsDocument(path4, updates, seed = {}, mutate, options = {}) {
  let loaded = loadDocument(path4);
  let quarantinedTo;
  if (loaded.error) {
    if (!options.quarantineCorrupt) return { status: "refused", error: loaded.error };
    quarantinedTo = unusedQuarantinePath(path4);
    try {
      renameSync2(path4, quarantinedTo);
    } catch (error) {
      return { status: "refused", error };
    }
    loaded = { exists: false };
  }
  const cloned = cloneDocument(loaded.document ?? seed);
  if (!isRecord(cloned)) return { status: "refused", error: new Error("settings seed must be an object") };
  const document = withoutStaleRootCopies(cloned);
  const target = settingsTarget(document);
  Object.assign(target, updates);
  mutate?.(target);
  if (loaded.exists && JSON.stringify(document) === JSON.stringify(loaded.document)) {
    return { status: "unchanged", document };
  }
  try {
    writeJsonFileAtomic(path4, document, { mode: SETTINGS_FILE_MODE });
    return { status: loaded.exists ? "updated" : "created", document, quarantinedTo };
  } catch (error) {
    if (quarantinedTo && restoreQuarantined(quarantinedTo, path4)) quarantinedTo = void 0;
    return { status: "refused", document: loaded.document, error, quarantinedTo };
  }
}
function restoreQuarantined(quarantinedTo, path4) {
  if (existsSync4(path4)) return false;
  try {
    renameSync2(quarantinedTo, path4);
    return true;
  } catch {
    return false;
  }
}
var isRecord, SETTINGS_FILE_MODE;
var init_settings_document = __esm({
  "src/shared/settings-document.ts"() {
    "use strict";
    init_atomic_json();
    isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    SETTINGS_FILE_MODE = 384;
  }
});

// src/shared/paths.ts
import { join as join5, dirname as dirname2, basename as basename2 } from "path";
import { homedir as homedir4 } from "os";
import { existsSync as existsSync5, mkdirSync as mkdirSync2 } from "fs";
import { fileURLToPath } from "url";
function getDirname() {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return dirname2(fileURLToPath(import.meta.url));
}
function resolveDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  }
  const defaultDataDir2 = join5(homedir4(), ".claude-mem");
  const settingsPath = join5(defaultDataDir2, "settings.json");
  try {
    if (existsSync5(settingsPath)) {
      const raw = readJsonFileWithBom(settingsPath);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultDataDir2;
      const settings2 = settingsTarget(raw);
      if (typeof settings2.CLAUDE_MEM_DATA_DIR === "string" && settings2.CLAUDE_MEM_DATA_DIR) {
        return expandHome(settings2.CLAUDE_MEM_DATA_DIR);
      }
    }
  } catch {
  }
  return defaultDataDir2;
}
var _dirname, DATA_DIR, DEFAULT_CLAUDE_CONFIG_DIR, CLAUDE_CONFIG_DIR, MARKETPLACE_ROOT, LOGS_DIR, USER_SETTINGS_PATH, DB_FILENAME, DB_PATH, OBSERVER_SESSIONS_DIR, OBSERVER_SESSIONS_PROJECT, paths;
var init_paths = __esm({
  "src/shared/paths.ts"() {
    "use strict";
    init_atomic_json();
    init_settings_document();
    init_expand_home();
    init_expand_home();
    _dirname = getDirname();
    DATA_DIR = resolveDataDir();
    DEFAULT_CLAUDE_CONFIG_DIR = join5(homedir4(), ".claude");
    CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR;
    MARKETPLACE_ROOT = join5(CLAUDE_CONFIG_DIR, "plugins", "marketplaces", "thedotmack");
    LOGS_DIR = join5(DATA_DIR, "logs");
    USER_SETTINGS_PATH = join5(DATA_DIR, "settings.json");
    DB_FILENAME = "claude-mem.db";
    DB_PATH = join5(DATA_DIR, DB_FILENAME);
    OBSERVER_SESSIONS_DIR = join5(DATA_DIR, "observer-sessions");
    OBSERVER_SESSIONS_PROJECT = basename2(OBSERVER_SESSIONS_DIR);
    paths = {
      dataDir: () => DATA_DIR,
      workerPid: () => join5(DATA_DIR, "worker.pid"),
      workerHeartbeat: () => join5(DATA_DIR, "worker-heartbeat.json"),
      // Phase 1b: identifier renamed to `server*`; the on-disk file basenames
      // remain `.server-beta.*` so existing installations keep finding their
      // pid/port/runtime state. Plan §1d will migrate the basenames.
      serverPid: () => join5(DATA_DIR, ".server-beta.pid"),
      serverPort: () => join5(DATA_DIR, ".server-beta.port"),
      serverRuntime: () => join5(DATA_DIR, ".server-beta.runtime.json"),
      settings: () => join5(DATA_DIR, "settings.json"),
      database: () => join5(DATA_DIR, DB_FILENAME),
      // Automatic snapshot target (BackupManager). Nested under backups/auto so
      // the manager's retention sweep never touches the legacy one-off backups
      // that live directly in backups/.
      backups: () => join5(DATA_DIR, "backups", "auto"),
      // A restore staged by `npx claude-mem restore`, applied by the next worker
      // boot before it opens the database, and the outcome of the last one.
      pendingRestore: () => join5(DATA_DIR, "backups", "restore-pending.json"),
      lastRestore: () => join5(DATA_DIR, "backups", "last-restore.json"),
      chroma: () => join5(DATA_DIR, "chroma"),
      combinedCerts: () => join5(DATA_DIR, "combined_certs.pem"),
      transcriptsConfig: () => join5(DATA_DIR, "transcript-watch.json"),
      transcriptsState: () => join5(DATA_DIR, "transcript-watch-state.json"),
      corpora: () => join5(DATA_DIR, "corpora"),
      supervisorRegistry: () => join5(DATA_DIR, "supervisor.json"),
      envFile: () => join5(DATA_DIR, ".env"),
      logsDir: () => LOGS_DIR
    };
  }
});

// src/utils/logger.ts
import { closeSync as closeSync2, existsSync as existsSync6, fstatSync, mkdirSync as mkdirSync3, openSync as openSync2, statSync as statSync2, writeSync as writeSync2 } from "fs";
import { dirname as dirname3, join as join6 } from "path";
function escapeLineBreaks(value) {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}
function escapeStackText(stack) {
  return "  " + stack.replace(/\r/g, "\\r").replace(/\n(?![ \t]+at )/g, "\\n");
}
var LogLevel, errorSink, Logger, logger;
var init_logger = __esm({
  "src/utils/logger.ts"() {
    "use strict";
    init_paths();
    init_hook_io();
    init_atomic_json();
    init_settings_document();
    LogLevel = /* @__PURE__ */ ((LogLevel2) => {
      LogLevel2[LogLevel2["DEBUG"] = 0] = "DEBUG";
      LogLevel2[LogLevel2["INFO"] = 1] = "INFO";
      LogLevel2[LogLevel2["WARN"] = 2] = "WARN";
      LogLevel2[LogLevel2["ERROR"] = 3] = "ERROR";
      LogLevel2[LogLevel2["SILENT"] = 4] = "SILENT";
      return LogLevel2;
    })(LogLevel || {});
    errorSink = null;
    Logger = class {
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
        const date2 = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
        if (this.logFileInitialized && this.logFileDate === date2) return;
        const firstAttemptToday = this.logFileDate !== date2;
        this.closeLogFd();
        this.logFileInitialized = false;
        this.logFileDate = date2;
        try {
          const logsDir = paths.logsDir();
          if (!existsSync6(logsDir)) {
            mkdirSync3(logsDir, { recursive: true });
          }
          this.logFilePath = join6(logsDir, `claude-mem-${date2}.log`);
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
      appendLine(path4, text5) {
        if (this.logFd !== null) {
          let current = false;
          try {
            const open = fstatSync(this.logFd);
            const onDisk = statSync2(path4);
            current = open.ino === onDisk.ino && open.dev === onDisk.dev;
          } catch {
          }
          if (!current) this.closeLogFd();
        }
        if (this.logFd === null) {
          mkdirSync3(dirname3(path4), { recursive: true });
          this.logFd = openSync2(path4, "a");
        }
        try {
          let bytes2 = Buffer.from(text5, "utf8");
          while (bytes2.length > 0) {
            const written = writeSync2(this.logFd, bytes2);
            if (written <= 0) throw new Error("log write accepted 0 bytes");
            bytes2 = bytes2.subarray(written);
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
            if (existsSync6(settingsPath)) {
              const settings2 = settingsTarget(readJsonFileWithBom(settingsPath));
              const envLevel = (settings2.CLAUDE_MEM_LOG_LEVEL || "INFO").toString().toUpperCase();
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
      formatTimestamp(date2) {
        const year = date2.getFullYear();
        const month = String(date2.getMonth() + 1).padStart(2, "0");
        const day = String(date2.getDate()).padStart(2, "0");
        const hours = String(date2.getHours()).padStart(2, "0");
        const minutes = String(date2.getMinutes()).padStart(2, "0");
        const seconds = String(date2.getSeconds()).padStart(2, "0");
        const ms = String(date2.getMilliseconds()).padStart(3, "0");
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
          correlationStr = `[${escapeLineBreaks(String(context.correlationId))}] `;
        } else if (context?.sessionId) {
          correlationStr = `[session-${escapeLineBreaks(String(context.sessionId))}] `;
        }
        let dataStr = "";
        if (data !== void 0 && data !== null) {
          if (data instanceof Error) {
            dataStr = ` ${escapeLineBreaks(data.message)}`;
            if (this.getLevel() === 0 /* DEBUG */ && data.stack) {
              dataStr += `
${escapeStackText(data.stack)}`;
            }
          } else if (this.getLevel() === 0 /* DEBUG */ && typeof data === "object") {
            dataStr = "\n" + this.safeStringify(data, 2);
          } else {
            dataStr = " " + escapeLineBreaks(this.formatData(data));
          }
        }
        let contextStr = "";
        if (context) {
          const { sessionId, memorySessionId, correlationId, ...rest } = context;
          if (Object.keys(rest).length > 0) {
            const pairs = Object.entries(rest).map(([k, v]) => {
              if (typeof v !== "object" || v === null || v instanceof Error || v instanceof Date) {
                return `${escapeLineBreaks(k)}=${escapeLineBreaks(String(v))}`;
              }
              return `${escapeLineBreaks(k)}=${escapeLineBreaks(Array.isArray(v) ? this.safeStringify(v) : this.formatData(v))}`;
            });
            contextStr = ` {${pairs.join(", ")}}`;
          }
        }
        const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${escapeLineBreaks(message)}${contextStr}${dataStr}`;
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
    logger = new Logger();
  }
});

// src/shared/openrouter-base-url.ts
function isHttpUrl(value) {
  try {
    return HTTP_URL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
function warnUnusableBaseUrl(value) {
  if (lastWarnedBaseUrl === value) return;
  lastWarnedBaseUrl = value;
  logger.warn("SDK", "CLAUDE_MEM_OPENROUTER_BASE_URL is not an http(s) URL; requests to it will fail until it is fixed", { baseUrl: value });
}
function resolveOpenRouterChatCompletionsUrl(baseUrl) {
  const trimmed = (baseUrl ?? "").trim();
  if (!trimmed) {
    return DEFAULT_OPENROUTER_API_URL;
  }
  if (!isHttpUrl(trimmed)) {
    warnUnusableBaseUrl(trimmed);
    const normalized = trimmed.replace(TRAILING_SLASHES, "");
    return normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH) ? normalized : `${normalized}${CHAT_COMPLETIONS_PATH}`;
  }
  const url = new URL(trimmed);
  const path4 = url.pathname.replace(TRAILING_SLASHES, "");
  url.pathname = path4.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH) ? path4 : `${path4}${CHAT_COMPLETIONS_PATH}`;
  return url.href;
}
function isOpenRouterApiUrl(apiUrl) {
  try {
    return new URL(apiUrl).hostname.toLowerCase() === "openrouter.ai";
  } catch {
    return false;
  }
}
var DEFAULT_OPENROUTER_API_URL, CHAT_COMPLETIONS_PATH, HTTP_URL_PROTOCOLS, TRAILING_SLASHES, lastWarnedBaseUrl;
var init_openrouter_base_url = __esm({
  "src/shared/openrouter-base-url.ts"() {
    "use strict";
    init_logger();
    DEFAULT_OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
    CHAT_COMPLETIONS_PATH = "/chat/completions";
    HTTP_URL_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
    TRAILING_SLASHES = /\/+$/;
    lastWarnedBaseUrl = null;
  }
});

// src/shared/SettingsDefaultsManager.ts
import { readFileSync as readFileSync6, existsSync as existsSync7, writeFileSync } from "fs";
import { basename as basename3, dirname as dirname4, join as join7 } from "path";
import { homedir as homedir5, hostname } from "os";
import { parseEnv } from "util";
function coercePersistedSettingValue(value) {
  return typeof value === "boolean" ? String(value) : value;
}
function envFileSetsAnthropicBaseUrl(settingsPath) {
  const envFile = process.env.CLAUDE_MEM_ENV_FILE ?? join7(dirname4(settingsPath), ".env");
  try {
    if (!existsSync7(envFile)) return false;
    const parsed = parseEnv(stripUtf8Bom(readFileSync6(envFile, "utf-8")));
    return Boolean(parsed.ANTHROPIC_BASE_URL);
  } catch {
    return true;
  }
}
function hasPinnedShippedHaiku(flatSettings, settingsPath) {
  const model = flatSettings.CLAUDE_MEM_MODEL;
  if (typeof model !== "string" || !PINNED_SHIPPED_HAIKU_MODELS.has(model.trim())) {
    return false;
  }
  const authMethod = typeof flatSettings.CLAUDE_MEM_CLAUDE_AUTH_METHOD === "string" ? flatSettings.CLAUDE_MEM_CLAUDE_AUTH_METHOD.trim() : "";
  return authMethod !== "gateway" && !envFileSetsAnthropicBaseUrl(settingsPath);
}
function hasRetiredOpenRouterDefault(flatSettings) {
  const model = flatSettings.CLAUDE_MEM_OPENROUTER_MODEL;
  if (typeof model !== "string" || !RETIRED_OPENROUTER_DEFAULT_MODELS.has(model.trim())) {
    return false;
  }
  const baseUrl = typeof flatSettings.CLAUDE_MEM_OPENROUTER_BASE_URL === "string" ? flatSettings.CLAUDE_MEM_OPENROUTER_BASE_URL.trim() : "";
  return baseUrl === "" || isOpenRouterApiUrl(baseUrl);
}
function raisedDefaultMarkerPath(settingsPath, raised) {
  return join7(dirname4(settingsPath), `.${basename3(settingsPath)}.${raised.markerTag}`);
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
var LEGACY_TELEGRAM_TRIGGER_TYPES, LEGACY_CLOUD_SYNC_HUB_HOST, DIRECT_SUPABASE_CLOUD_SYNC_HUB_HOST, CANONICAL_CLOUD_SYNC_HUB_URL, RETIRED_OPENROUTER_DEFAULT_MODELS, PINNED_SHIPPED_HAIKU_MODELS, DEFAULT_LLM_TIMEOUT_MS, CHANGED_SHIPPED_DEFAULTS, raisedDefaultFailuresReported, SettingsDefaultsManager;
var init_SettingsDefaultsManager = __esm({
  "src/shared/SettingsDefaultsManager.ts"() {
    "use strict";
    init_hook_constants();
    init_atomic_json();
    init_openrouter_base_url();
    init_settings_document();
    init_expand_home();
    init_install_port();
    LEGACY_TELEGRAM_TRIGGER_TYPES = "security_alert";
    LEGACY_CLOUD_SYNC_HUB_HOST = "sync-hub.black-pond-afbb.workers.dev";
    DIRECT_SUPABASE_CLOUD_SYNC_HUB_HOST = "ziczmqtpmaxbornfghye.supabase.co";
    CANONICAL_CLOUD_SYNC_HUB_URL = "https://sync.cmem.ai";
    RETIRED_OPENROUTER_DEFAULT_MODELS = /* @__PURE__ */ new Set([
      "xiaomi/mimo-v2-flash:free"
    ]);
    PINNED_SHIPPED_HAIKU_MODELS = /* @__PURE__ */ new Set([
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5"
    ]);
    DEFAULT_LLM_TIMEOUT_MS = 18e4;
    CHANGED_SHIPPED_DEFAULTS = [
      // Seeded from #4125 (13.25.2) until #4278.
      { key: "CLAUDE_MEM_LLM_TIMEOUT_MS", legacy: "30000", markerTag: "llm-timeout-migrated-v1", unit: "ms", applyOnlyWhenSaved: false },
      // Seeded from #4136 until the field pass got the same deadline.
      { key: "CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS", legacy: "30000", markerTag: "field-optimize-timeout-migrated-v1", unit: "ms", applyOnlyWhenSaved: false },
      // Seeded 'false' from #4341 (image capture, off) until capture became on by
      // default. No viewer switch existed before then, so a saved 'false' is almost
      // always the seeded value. A 'false' typed by hand reads the same and moves
      // too; typing it changed nothing while 'false' was the default. After this
      // one move, a 'false' saved by the "Keep images" switch or by hand stays.
      { key: "CLAUDE_MEM_MEDIA_CAPTURE_ENABLED", legacy: "false", markerTag: "media-capture-default-on-v1", unit: "", applyOnlyWhenSaved: true }
    ];
    raisedDefaultFailuresReported = /* @__PURE__ */ new Set();
    SettingsDefaultsManager = class {
      static DEFAULTS = {
        CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED: "true",
        CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: "true",
        // Explicit JSON [{path, project, platformSource?}]. Empty means no files imported.
        CLAUDE_MEM_MEMORY_WATCH_ROOTS: "",
        // Never a dated id: `haiku` is Claude Code's alias for the newest Haiku, so the
        // note-taker moves to each new (cheaper) release on its own. See CLAUDE.md, Model policy.
        CLAUDE_MEM_MODEL: "haiku",
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: "50",
        CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: "false",
        CLAUDE_MEM_CONTEXT_PROJECTS: "current",
        // 'current' = this checkout only; 'all' = SessionStart context spans every project
        CLAUDE_MEM_WORKER_PORT: String(getDefaultWorkerPort()),
        CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
        CLAUDE_MEM_WORKER_URL: "",
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
        CLAUDE_MEM_DELIVERABLES_ENABLED: "true",
        // 'false' = the Stop hook neither copies deliverables into the bucket nor records them; files already in the bucket stay
        // Deliberate divergence from the installer prompt: the interactive
        // provider prompt defaults to 'cmem' (the hosted observer), but headless
        // installs land here — no delivered key exists headlessly, so the settings
        // default stays 'claude'.
        CLAUDE_MEM_PROVIDER: "claude",
        CLAUDE_MEM_PROVIDER_BY_SOURCE: "",
        CLAUDE_MEM_OBSERVER_ENABLED: "true",
        // 'false' disables new observation and session-summary capture calls
        // Image capture is on: the viewer's "Keep images" switch turns it off.
        // No total local cap, by the owner's call (2026-11-05): each image is
        // bounded (MEDIA_LIMITS in media-contract.ts: 3 MiB canonical, 256 KiB
        // model copy), an event keeps at most 4, and the local database and
        // transcripts have no total cap either. Images stay until their event is
        // deleted. Installs seeded with 'false' move once (CHANGED_SHIPPED_DEFAULTS).
        CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: "true",
        // Stays off: sending images to the observer model is separate and paid.
        CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: "false",
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
        CLAUDE_MEM_OPENAI_COMPAT_OBSERVATION_BATCH_SIZE: "1",
        // Queued same-context events per observer prompt (1-32); opt-in.
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
        CLAUDE_MEM_DATA_DIR: join7(homedir5(), ".claude-mem"),
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
        CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: join7(homedir5(), ".claude-mem", "transcript-watch.json"),
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
        // Observer thinking param: 'disabled' (shipped) | 'adaptive' | 'enabled[:budget]' | 'omit' — an always-thinking gateway upstream rejects 'disabled' with 400/1210 (#4732)
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
        // #4745 — opt-in: also redact un-prefixed credentials (password=, *_TOKEN=, *_SECRET=, *_API_KEY=, Authorization: Bearer, Authorization: Basic)
        CLAUDE_MEM_EXCLUDED_PROJECTS: "",
        // Comma-separated glob patterns for excluded project paths
        CLAUDE_MEM_PROJECT_ENVIRONMENTS: "[]",
        // JSON array of {"name","patterns","inherit"?}: directories matching an environment's globs share one project named after it; an explicit inherit list replaces the derived read keys ([] reads only the environment)
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
        CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING: "false",
        // 'true' keeps pulling with no sessions running instead of suspending after an hour (the cloud viewer replica, which runs no hooks)
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
        // Installer email opt-in: empty until someone shares an email.
        CLAUDE_MEM_ONLINE_SIGNUP_EMAIL: "",
        CLAUDE_MEM_ONLINE_SIGNUP_NOTE: "",
        CLAUDE_MEM_ONLINE_SIGNUP_AT: "",
        CLAUDE_MEM_ONLINE_SIGNUP_SENT: "",
        // 'true' once the waitlist accepted it, 'false' to retry next install
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
        CLAUDE_MEM_WORK_VIEW_REFRESH_INTERVAL_MIN: "10",
        // Minutes between My Work's scheduled checks (each is a read-only database look; an agent runs only when something is due). 1440 = once a day. Read when the worker starts.
        CLAUDE_MEM_WORK_VIEW_SHARED_STATE: "false",
        // Enable only after all local/cloud readers understand reserved My Work records.
        CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: "",
        // '' uses OpenRouter only when it is the primary provider; openrouter/openai-compatible explicitly select that provider; off disables generated My Work copy
        CLAUDE_MEM_WORK_VIEW_COPY_MODEL: "",
        // Optional model override for generated My Work copy; empty uses the selected provider's configured model
        CLAUDE_MEM_WORK_VIEW_AGENT: "",
        // Which agent runs the My Work refresh: '' follows CLAUDE_MEM_PROVIDER and stays on one agent; claude-code/codex/gemini pick one; off runs none; all falls through every logged-in agent (#5189)
        CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL: "",
        // #5164 — model for every My Work refresh step on Claude Code (an alias like 'haiku'); empty keeps haiku/sonnet per step
        CLAUDE_MEM_WORK_VIEW_CODEX_MODEL: "",
        // #5164 — same for Codex; empty keeps the per-step table
        CLAUDE_MEM_WORK_VIEW_GEMINI_MODEL: "",
        // #5164 — same for Gemini; empty keeps flash-lite/flash per step
        CLAUDE_MEM_WORK_VIEW_TEXT_LANGUAGE: "",
        // Language for My Work's generated text (titles, reviews, story), such as 'Turkish'. Never detected by a model; empty lets the skills pick the owner's language
        // Automatic local DB snapshots (BackupManager). Off by default; opt-in.
        CLAUDE_MEM_BACKUP_ENABLED: "false",
        CLAUDE_MEM_BACKUP_INTERVAL_HOURS: "24",
        // Snapshot cadence in hours
        CLAUDE_MEM_BACKUP_RETAIN_COUNT: "7",
        // Keep the N most-recent snapshots
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
        CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: "false",
        // Opt-in agent IDs. Empty list = no writes.
        CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS: "",
        CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: "decision,bugfix,security_alert,sensitive",
        CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS: "",
        // Optional brainbeat webhook: awareness-trigger matches are POSTed here
        // (off while empty). File/env only; both are masked on GET /api/settings.
        CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: "",
        CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET: "",
        // Optional Notion export: each new observation is upserted into a Notion
        // database. Off by default; a no-op until the token and database id are set.
        // The token is file/env only and masked on GET /api/settings.
        CLAUDE_MEM_NOTION_ENABLED: "false",
        CLAUDE_MEM_NOTION_TOKEN: "",
        CLAUDE_MEM_NOTION_DATABASE_ID: "",
        CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES: "true",
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
        CLAUDE_MEM_QUEUE_REDIS_PREFIX: `claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT ?? String(getDefaultWorkerPort())}`,
        CLAUDE_MEM_AUTH_MODE: "api-key",
        CLAUDE_MEM_RUNTIME: "worker",
        // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
        // these first; the legacy `*_BETA_*` defaults below remain so existing
        // settings.json files still resolve correctly.
        CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT ?? String(getDefaultServerPort())}`,
        // Default server runtime URL — aligned with the per-install port fallback
        CLAUDE_MEM_SERVER_API_KEY: "",
        // Local hook API key, populated by installer when runtime=server
        CLAUDE_MEM_SERVER_PROJECT_ID: "",
        // Default Postgres project_id used by hooks when runtime=server
        CLAUDE_MEM_SERVER_BETA_URL: `http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT ?? String(getDefaultServerPort())}`,
        // Legacy server-beta runtime URL — aligned with the per-install port fallback
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
        CLAUDE_MEM_LOG_RETENTION_DAYS: "30",
        // 30 days of daily logs; 0 = keep forever. Today's and yesterday's files are always kept
        CLAUDE_MEM_WORKER_AUTOSTART: "true",
        // 'false' = the worker is managed externally: hooks, the MCP server and `start` use a running worker but never launch, kill or recycle one.
        CLAUDE_MEM_PROJECT_NAME_SOURCE: "path"
        // 'path' (default) = folder/git-root basename; 'git-remote' = stable org/repo slug from the git `origin` URL (survives directory renames). Opt-in; default preserves existing behavior.
      };
      static getAllDefaults() {
        return { ...this.DEFAULTS };
      }
      static defaultsForSettingsPath(settingsPath) {
        const defaults = { ...this.DEFAULTS };
        const dataDir = dirname4(settingsPath);
        const workerPort = String(getDefaultWorkerPort(dataDir));
        const serverPort = process.env.CLAUDE_MEM_SERVER_PORT ?? String(getDefaultServerPort(dataDir));
        defaults.CLAUDE_MEM_WORKER_PORT = workerPort;
        defaults.CLAUDE_MEM_QUEUE_REDIS_PREFIX = `claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT ?? workerPort}`;
        defaults.CLAUDE_MEM_SERVER_URL = `http://127.0.0.1:${serverPort}`;
        defaults.CLAUDE_MEM_SERVER_BETA_URL = `http://127.0.0.1:${serverPort}`;
        return defaults;
      }
      static get(key) {
        const value = process.env[key] ?? this.DEFAULTS[key];
        if (key === "CLAUDE_MEM_WORKER_HOST") {
          return this.normalizeWorkerHost(value);
        }
        if (key === "CLAUDE_MEM_DATA_DIR") {
          return expandHome(value);
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
      static finalizeSettings(settings2, applyEnvOverrides) {
        const result = applyEnvOverrides ? this.applyEnvOverrides(settings2) : settings2;
        result.CLAUDE_MEM_WORKER_HOST = this.normalizeWorkerHost(result.CLAUDE_MEM_WORKER_HOST);
        const dataDir = result.CLAUDE_MEM_DATA_DIR?.trim();
        if (dataDir && result.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH === this.DEFAULTS.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH) {
          result.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH = join7(expandHome(dataDir), "transcript-watch.json");
        }
        return result;
      }
      static getInt(key) {
        const value = this.get(key);
        return parseInt(value, 10);
      }
      static applyEnvOverrides(settings2) {
        const result = { ...settings2 };
        for (const key of Object.keys(this.DEFAULTS)) {
          if (process.env[key] !== void 0) {
            result[key] = process.env[key];
          }
        }
        return result;
      }
      static loadFromFile(settingsPath, applyEnvOverrides = true, options = {}) {
        try {
          const defaults = this.defaultsForSettingsPath(settingsPath);
          if (!existsSync7(settingsPath)) {
            if (!options.readOnly) {
              try {
                writeJsonFileAtomic(settingsPath, defaults, { mode: 384 });
                for (const raised of CHANGED_SHIPPED_DEFAULTS) markRaisedDefaultDone(settingsPath, raised);
                console.warn("[SETTINGS] Created settings file with defaults:", settingsPath);
              } catch (error) {
                console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:", settingsPath, error instanceof Error ? error.message : String(error));
              }
            }
            return this.finalizeSettings(defaults, applyEnvOverrides);
          }
          const settingsData = readFileSync6(settingsPath, "utf-8");
          const settings2 = parseJsonWithBom(settingsData);
          let flatSettings = settingsTarget(settings2);
          const hasNestedEnv = flatSettings !== settings2;
          const writableRoot = withoutStaleRootCopies(settings2);
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
          if (hasPinnedShippedHaiku(flatSettings, settingsPath)) {
            const pinnedModel = String(flatSettings.CLAUDE_MEM_MODEL).trim();
            flatSettings = {
              ...flatSettings,
              CLAUDE_MEM_MODEL: this.DEFAULTS.CLAUDE_MEM_MODEL
            };
            if (!options.readOnly) {
              try {
                writeJsonFileAtomic(
                  settingsPath,
                  hasPeerRootKeys ? { ...writableRoot, env: flatSettings } : flatSettings,
                  { mode: 384 }
                );
                console.warn(
                  `[SETTINGS] Migrated Claude model off the pinned ${pinnedModel} to ${this.DEFAULTS.CLAUDE_MEM_MODEL}:`,
                  settingsPath
                );
              } catch (error) {
                console.warn("[SETTINGS] Failed to migrate the pinned Claude model:", settingsPath, error instanceof Error ? error.message : String(error));
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
          for (const raised of CHANGED_SHIPPED_DEFAULTS) {
            if (existsSync7(raisedDefaultMarkerPath(settingsPath, raised))) continue;
            if (flatSettings[raised.key] !== raised.legacy) {
              if (!options.readOnly) markRaisedDefaultDone(settingsPath, raised);
              continue;
            }
            if (options.readOnly && raised.applyOnlyWhenSaved) continue;
            const beforeMove = flatSettings;
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
                  `[SETTINGS] Migrated ${raised.key} off the old ${raised.legacy}${raised.unit} default to ${this.DEFAULTS[raised.key]}${raised.unit}:`,
                  settingsPath
                );
              } catch (error) {
                if (raised.applyOnlyWhenSaved) flatSettings = beforeMove;
                const reported = `${raised.key}\0${settingsPath}`;
                if (!raisedDefaultFailuresReported.has(reported)) {
                  raisedDefaultFailuresReported.add(reported);
                  console.warn(
                    raised.applyOnlyWhenSaved ? `[SETTINGS] Failed to migrate ${raised.key}; keeping the saved ${raised.legacy} (reported once per process):` : `[SETTINGS] Failed to migrate ${raised.key}; using the new default in memory (reported once per process):`,
                    settingsPath,
                    error instanceof Error ? error.message : String(error)
                  );
                }
              }
            }
          }
          const result = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (flatSettings[key] !== void 0) {
              result[key] = coercePersistedSettingValue(flatSettings[key]);
            }
          }
          return this.finalizeSettings(result, applyEnvOverrides);
        } catch (error) {
          console.warn("[SETTINGS] Failed to load settings, using defaults:", settingsPath, error instanceof Error ? error.message : String(error));
          const defaults = this.defaultsForSettingsPath(settingsPath);
          return this.finalizeSettings(defaults, applyEnvOverrides);
        }
      }
    };
  }
});

// src/services/work-view/work-product.mjs
import { statSync as statSync3 } from "node:fs";
import { basename as basename4, extname, isAbsolute } from "node:path";
import { createHash as createHash2 } from "node:crypto";
function safeWebUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
function isLocalPath(value, isAbsolutePath = isAbsolute) {
  return typeof value === "string" && isAbsolutePath(value) && !value.includes("\0") && !value.split(/[\\/]/).includes("..");
}
function fileKind(path4) {
  return isLocalPath(path4) ? FILE_KINDS[extname(path4).toLowerCase()] ?? null : null;
}
function kindForUrl(url, fallback) {
  const { hostname: hostname2, pathname } = new URL(url);
  if (hostname2 === "github.com" && /\/pull\/\d+/.test(pathname)) return "pull-request";
  if (/\.(?:vercel\.app|netlify\.app|pages\.dev)$/.test(hostname2)) return "deployment";
  const extension = FILE_KINDS[extname(pathname).toLowerCase()];
  return extension ?? fallback;
}
function parse(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function urlsIn(value, found = []) {
  if (typeof value === "string") {
    const url = safeWebUrl(value);
    if (url) found.push(url);
  } else if (Array.isArray(value)) for (const item of value) urlsIn(item, found);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) if (/url$/i.test(key) || typeof item === "object") urlsIn(item, found);
  }
  return found;
}
function githubRepo(remote) {
  const match = typeof remote === "string" ? remote.trim().match(GITHUB_REMOTE) : null;
  return match ? `${match[1]}/${match[2]}` : null;
}
function gitUrl(product) {
  if (!product.repo) return void 0;
  return product.kind === "commit" ? `https://github.com/${product.repo}/commit/${product.sha}` : `https://github.com/${product.repo}/tree/${product.branch}`;
}
function outputText(call, response) {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") return [response.stdout, response.stderr].filter((part) => typeof part === "string").join("\n");
  return typeof call.tool_response === "string" ? call.tool_response : "";
}
function commitSubjects(command2) {
  const starts = [...command2.matchAll(gitPattern(String.raw`commit\b`, "g"))].map((match) => match.index);
  return starts.map((start, index) => {
    const invocation = command2.slice(start, starts[index + 1]);
    const inline = invocation.match(/\s-[a-zA-Z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
    const heredoc = invocation.match(/\s-F\s+-\s*<<-?\s*['"]?\w+['"]?\n([^\n]*)/);
    const text5 = inline ? (inline[1] ?? inline[2]).replace(/\\(.)/g, "$1") : heredoc?.[1];
    return short(text5?.split("\n")[0]);
  });
}
function commitsFrom(command2, response, out) {
  const commits = /* @__PURE__ */ new Map();
  const add = (sha, branch, subject) => {
    const key = sha.slice(0, 7);
    const known = commits.get(key);
    commits.set(key, { sha: known?.sha.length > sha.length ? known.sha : sha, branch: branch ?? known?.branch ?? null, subject: subject ?? known?.subject ?? null });
  };
  const recorded = response?.gitOperation?.commit;
  const subjects = commitSubjects(command2);
  if (!subjects.length && !recorded?.sha) return [];
  for (const [, ref, sha, subject] of out.matchAll(new RegExp(String.raw`^\[(.+?)(?: \(root-commit\))? (${SHA})\] (.+)$`, "gm"))) {
    add(sha, ref.startsWith("detached HEAD") ? null : ref, short(subject));
  }
  if (typeof recorded?.sha === "string" && new RegExp(`^${SHA}$`).test(recorded.sha)) add(recorded.sha, typeof recorded.branch === "string" ? recorded.branch : null, null);
  if (!commits.size) {
    const rtkSha = subjects.length === 1 ? out.match(new RegExp(`^ok (${SHA})$`, "m"))?.[1] : null;
    if (rtkSha) add(rtkSha, null, subjects[0]);
    else {
      const printed = [...out.matchAll(new RegExp(`^(${SHA}) (.+)$`, "gm"))].map(([, sha, subject]) => [sha, short(subject)]);
      for (const subject of subjects) {
        const match = subject && printed.find(([, printedSubject]) => printedSubject === subject);
        if (match) add(match[0], null, subject);
      }
    }
  }
  return [...commits.values()];
}
function pushTarget(command2) {
  const args = command2.match(gitPattern(String.raw`push((?:[ \t]+(?:"[^"]*"|'[^']*'|[^\s;&|)]+))*)`))?.[1];
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean).map(unquote);
  if (tokens.some((token) => ["-d", "--delete", "--tags", "--mirror", "--all"].includes(token))) return null;
  const [remote, refspec] = tokens.filter((token) => !token.startsWith("-"));
  const branch = refspec && !refspec.startsWith(":") ? refspec.replace(/^\+/, "").split(":").at(-1).replace(/^refs\/heads\//, "") : null;
  return { repo: githubRepo(remote), branch: branch && branch !== "HEAD" ? branch : null };
}
function pushesFrom(command2, response, out) {
  const runs = gitPattern(String.raw`push\b`).test(command2);
  const recorded = typeof response?.gitOperation?.push?.branch === "string" ? response.gitOperation.push.branch : null;
  if (!runs && !recorded) return [];
  const target = runs ? pushTarget(command2) : null;
  const pushes = /* @__PURE__ */ new Map();
  let repo = null;
  for (const line of out.split("\n")) {
    const remote = line.match(/^To (\S+)$/);
    if (remote) {
      repo = githubRepo(remote[1]);
      continue;
    }
    const ref = line.match(new RegExp(String.raw`^\s*[ +*=]?\s*(?:${SHA}\.\.\.?(${SHA})|\[new branch\])\s+(\S+)\s+->\s+(\S+)`));
    if (!ref) continue;
    const branch2 = ref[3].replace(/^refs\/heads\//, "");
    pushes.set(branch2, { branch: branch2, repo: repo ?? target?.repo ?? null, heads: ref[1] ? [ref[1]] : [] });
  }
  const branch = recorded ?? target?.branch;
  if (!pushes.size && branch && !/\[rejected\]|failed to push|^fatal:/m.test(out)) pushes.set(branch, { branch, repo: target?.repo ?? null, heads: [] });
  return [...pushes.values()];
}
function createdBranchesFrom(command2, out) {
  if (/^fatal:/m.test(out)) return [];
  return [...command2.matchAll(gitPattern(String.raw`(?:checkout\s+-[bB]|switch\s+-[cC])\s+("[^"]+"|'[^']+'|[^\s;&|)]+)`, "g"))].map((match) => ({ branch: unquote(match[1]), repo: null, heads: [] }));
}
function pullRequestFrom(command2, response, out, { atEpoch, sourceRef: sourceRef2 }) {
  if (!/(?:^|[;&|(\n])\s*(?:rtk\s+)?gh\s+pr\s+create\b/.test(command2)) return [];
  const printed = out.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/m)?.[0];
  const url = safeWebUrl(response?.gitOperation?.pr?.url ?? printed);
  if (!url) return [];
  const title = command2.match(/--title\s+(?:"([^"]+)"|'([^']+)')/);
  return [{ kind: "pull-request", title: short(title?.[1] ?? title?.[2]) ?? `PR #${url.split("/").at(-1)}`, url, atEpoch, sourceRef: sourceRef2 }];
}
function gitProductsFromCommand(command2, response, out, { atEpoch = null, sourceRef: sourceRef2 = null } = {}) {
  const pushes = pushesFrom(command2, response, out);
  const branches = new Map([...createdBranchesFrom(command2, out), ...pushes].map((branch) => [branch.branch, branch]));
  const products = [];
  for (const commit of commitsFrom(command2, response, out)) {
    const pushed = commit.branch && pushes.find((push) => push.branch === commit.branch) || pushes.find((push) => push.heads.some((head) => head.startsWith(commit.sha.slice(0, 7)))) || (!commit.branch && pushes.length === 1 ? pushes[0] : null);
    products.push({ kind: "commit", title: commit.subject ? `${commit.sha.slice(0, 7)} ${commit.subject}` : commit.sha.slice(0, 7), sha: commit.sha, branch: commit.branch ?? pushed?.branch ?? null, repo: pushed?.repo ?? null, atEpoch, sourceRef: sourceRef2 });
  }
  for (const branch of branches.values()) products.push({ kind: "branch", title: branch.branch, branch: branch.branch, repo: branch.repo, heads: branch.heads, atEpoch, sourceRef: sourceRef2 });
  return products.map((product) => ({ ...product, url: gitUrl(product) }));
}
function productsFromToolUse(call) {
  const input = parse(call.tool_input) ?? {}, response = parse(call.tool_response);
  const sourceRef2 = { kind: "tool-use", id: call.id };
  const atEpoch = call.created_at_epoch ?? null;
  if (call.tool_name === "Bash" && typeof input.command === "string") {
    const out = outputText(call, response);
    return [...pullRequestFrom(input.command, response, out, { atEpoch, sourceRef: sourceRef2 }), ...gitProductsFromCommand(input.command, response, out, { atEpoch, sourceRef: sourceRef2 })];
  }
  const publisher = PUBLISHING_TOOLS.find((tool) => tool.match.test(call.tool_name));
  if (!publisher || !response) return [];
  if (call.tool_name === "Artifact" && (input.action ?? "publish") !== "publish") return [];
  if (call.tool_name === "Artifact" && input.asset) return [];
  const urls = [...new Set(urlsIn(response))].filter((url) => !/\/(?:api|oauth)\//.test(new URL(url).pathname));
  const title = short(response.title ?? input.title ?? input.name) ?? (isLocalPath(input.file_path) ? basename4(input.file_path) : null);
  return urls.slice(0, 1).map((url) => ({ kind: kindForUrl(url, publisher.kind), title: title ?? new URL(url).hostname, url, atEpoch, sourceRef: sourceRef2 }));
}
function productsFromObservation(observation) {
  const files = parse(observation.files_modified);
  if (!Array.isArray(files)) return [];
  return files.flatMap((path4, index) => {
    const kind = fileKind(path4);
    const title = /^index\.\w+$/i.test(basename4(path4)) ? basename4(path4.slice(0, -basename4(path4).length - 1)) || basename4(path4) : basename4(path4);
    return kind ? [{ kind, title, path: path4, atEpoch: observation.created_at_epoch ?? null, sourceRef: { kind: "observation", id: observation.id, index } }] : [];
  });
}
function isWorkProductField(field) {
  return WORK_PRODUCT_FIELDS.has(field) || /_url$/.test(field);
}
function productsFromFields(fields, { atEpoch = null, sourceRef: sourceRef2 = null } = {}) {
  const products = [];
  let index = 0;
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (!isWorkProductField(field)) continue;
    const decoded = WORK_PRODUCT_FIELDS.has(field) && typeof value === "string" && /^\s*[[{]/.test(value) ? parse(value) ?? value : value;
    const values2 = WORK_PRODUCT_FIELDS.has(field) ? Array.isArray(decoded) ? decoded : [decoded] : typeof value === "string" ? [value] : [];
    for (const value2 of values2) {
      const entry = value2 && typeof value2 === "object" && !Array.isArray(value2) ? value2 : { url: value2 };
      const url = safeWebUrl(entry.url ?? entry.link);
      const path4 = isLocalPath(entry.path) ? entry.path : isLocalPath(entry.url) ? entry.url : null;
      const kind = short(entry.kind), title = short(entry.title ?? entry.name);
      const ref = sourceRef2 && { ...sourceRef2, index: index++ };
      if (url) products.push({ kind: kind ?? kindForUrl(url, LEGACY_KINDS[field] ?? "link"), title: title ?? new URL(url).hostname, url, field, atEpoch, sourceRef: ref });
      else if (path4 && (kind || fileKind(path4))) products.push({ kind: kind ?? fileKind(path4), title: title ?? basename4(path4), path: path4, field, atEpoch, sourceRef: ref });
    }
  }
  return products;
}
function localProductId(ref) {
  if (!ref || !["observation", "work-state", "deliverable"].includes(ref.kind) || typeof ref.device !== "string" || !ref.device || !/^\d+$/.test(String(ref.row ?? "")) || ref.index !== void 0 && (!Number.isSafeInteger(ref.index) || ref.index < 0)) return null;
  return `local_${createHash2("sha256").update(JSON.stringify([ref.kind, ref.device, String(ref.row), ref.index ?? 0])).digest("hex")}`;
}
function mergeProducts(lists, limit = 60) {
  const products = lists.flat();
  const pushesByBranch = /* @__PURE__ */ new Map(), repoByHead = /* @__PURE__ */ new Map(), repoBySource = /* @__PURE__ */ new Map();
  for (const product of products) if (product.kind === "branch" && product.repo) {
    if (!pushesByBranch.has(product.branch)) pushesByBranch.set(product.branch, []);
    pushesByBranch.get(product.branch).push(product);
    for (const head of product.heads ?? []) repoByHead.set(head.slice(0, 7), product.repo);
  }
  const sourceKey = (product) => product.sourceRef ? `${product.sourceRef.kind}:${product.sourceRef.id}` : null;
  const pushedAfter = (product) => pushesByBranch.get(product.branch)?.find((push) => product.kind === "branch" || (push.atEpoch ?? 0) >= (product.atEpoch ?? 0))?.repo;
  const repoOf = (product) => product.repo ?? pushedAfter(product) ?? (product.sha ? repoByHead.get(product.sha.slice(0, 7)) : void 0) ?? null;
  for (const product of products) if (product.kind === "commit" && repoOf(product) && sourceKey(product)) repoBySource.set(sourceKey(product), repoOf(product));
  const unique = /* @__PURE__ */ new Map();
  for (const product of products.sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0))) {
    const key = productKey(product);
    if (unique.has(key)) continue;
    const isGit = product.kind === "commit" || product.kind === "branch";
    const repo = isGit && !product.repo ? repoOf(product) ?? (product.kind === "commit" ? repoBySource.get(sourceKey(product)) : null) : null;
    unique.set(key, repo ? { ...product, repo, url: gitUrl({ ...product, repo }) } : product);
  }
  return [...unique.values()].slice(0, limit);
}
function productsFromDeliverable(row) {
  if (!Number.isSafeInteger(row?.id) || row.id < 1 || typeof row.bucket_path !== "string" || !row.bucket_path) return [];
  const name = basename4(row.bucket_path);
  return [{
    kind: short(row.kind) ?? fileKind(row.bucket_path) ?? "file",
    title: short(row.title) ?? name,
    url: `/api/deliverables/${row.id}/${encodeURIComponent(name)}`,
    bucketPath: row.bucket_path,
    sourcePath: typeof row.source_path === "string" ? row.source_path : null,
    deliverable: true,
    atEpoch: row.created_at_epoch ?? null,
    sourceRef: { kind: "deliverable", id: row.id }
  }];
}
function bucketFileAvailable(product) {
  if (typeof product?.bucketPath !== "string" || !product.bucketPath) return false;
  try {
    return statSync3(product.bucketPath).isFile();
  } catch {
    return false;
  }
}
function copyCoversSource(copy, sourcePath) {
  if (typeof copy?.atEpoch !== "number" || !bucketFileAvailable(copy)) return false;
  try {
    const source = statSync3(sourcePath);
    return !source.isFile() || source.mtimeMs <= copy.atEpoch;
  } catch {
    return true;
  }
}
function servableFile(product) {
  if (!product?.path || !fileKind(product.path)) return null;
  try {
    return statSync3(product.path).isFile() ? product.path : null;
  } catch {
    return null;
  }
}
function fileUrl(product) {
  const ref = product.sourceRef;
  return product.path && ref ? `/api/work-view/file/${ref.kind}/${ref.id}/${ref.index ?? 0}` : null;
}
function productIndexClauses(database) {
  if (!database) return {};
  let clauses = productIndexes.get(database);
  if (clauses) return clauses;
  clauses = {};
  for (const [table, index] of [["tool_uses", "idx_tool_uses_created_at_epoch"], ["observations", "idx_observations_created"]]) {
    const found = database.prepare(`PRAGMA index_list('${table}')`).all().find((row) => row.name === index && row.partial === 0);
    if (found && database.prepare(`PRAGMA index_info('${index}')`).all()[0]?.name === "created_at_epoch") {
      clauses[table] = ` INDEXED BY ${index}`;
    }
  }
  productIndexes.set(database, clauses);
  return clauses;
}
function selectiveProductIndexClauses(database, sinceEpoch, limit) {
  if (!(sinceEpoch > 0) || !Number.isSafeInteger(limit) || limit <= 0) return {};
  const sampleSize = Math.min(limit, 128);
  const indexes = productIndexClauses(database);
  const selected = {};
  for (const [lane, table, predicate] of [
    ["publishing", "tool_uses", PUBLISHING_PRODUCT_PREDICATE],
    ["git", "tool_uses", GIT_PRODUCT_PREDICATE],
    ["observations", "observations", FILE_EXTENSION_PATTERN]
  ]) {
    const clause = indexes[table];
    if (!clause) continue;
    const columns = table === "tool_uses" ? "tool_name, tool_input, created_at_epoch" : "files_modified, created_at_epoch";
    let sample;
    try {
      sample = database.prepare(`SELECT COUNT(*) AS sampled,
        COALESCE(SUM(CASE WHEN created_at_epoch >= ? AND (${predicate}) THEN 1 ELSE 0 END), 0) AS matches
        FROM (SELECT ${columns} FROM ${table} ORDER BY id DESC LIMIT ?)
      `).get(sinceEpoch, sampleSize);
    } catch (error) {
      if (/no such (table|column)/i.test(String(error.message))) continue;
      throw error;
    }
    if (sample.matches * 4 >= sample.sampled && sample.sampled > 0) continue;
    const estimatedIdScan = limit * sampleSize / Math.max(1, sample.matches);
    const budget = Math.min(128e3, Math.floor(estimatedIdScan / 2));
    const candidates = database.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${table}${clause} WHERE created_at_epoch >= ? LIMIT ?
    )`).get(sinceEpoch, budget + 1).count;
    if (candidates <= budget) selected[lane] = clause;
  }
  return selected;
}
function readProductRecords(read, sinceEpoch, limit = 2e3, { database } = {}) {
  const indexes = selectiveProductIndexClauses(database, sinceEpoch, limit);
  const publishingCalls = read(`SELECT id, session_db_id, prompt_number, tool_name, tool_input, tool_response, created_at_epoch FROM tool_uses${indexes.publishing ?? ""}
    WHERE created_at_epoch >= ? AND ${PUBLISHING_PRODUCT_PREDICATE}
    ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  const gitCalls = read(`SELECT id, session_db_id, prompt_number, tool_name, tool_input, tool_response, created_at_epoch FROM tool_uses${indexes.git ?? ""}
    WHERE created_at_epoch >= ? AND ${GIT_PRODUCT_PREDICATE}
    ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  const productCalls = [...publishingCalls, ...gitCalls];
  const productObservations = read(`SELECT id, memory_session_id, prompt_number, files_modified, created_at_epoch FROM observations${indexes.observations ?? ""}
    WHERE created_at_epoch >= ? AND (${FILE_EXTENSION_PATTERN}) ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  const productDeliverables = read(`SELECT id, project, content_session_id, platform_source, title, kind, source_path, bucket_path, created_at_epoch
    FROM deliverables WHERE created_at_epoch >= ? ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  return { productCalls, productObservations, productDeliverables };
}
var FILE_KINDS, PUBLISHING_TOOLS, WORK_PRODUCT_FIELDS, LEGACY_KINDS, MAX_TITLE, short, GIT_PREFIX, gitPattern, GITHUB_REMOTE, SHA, unquote, productKey, FILE_EXTENSION_PATTERN, PUBLISHING_PRODUCT_PREDICATE, GIT_PRODUCT_PREDICATE, productIndexes;
var init_work_product = __esm({
  "src/services/work-view/work-product.mjs"() {
    "use strict";
    FILE_KINDS = {
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
    PUBLISHING_TOOLS = [
      { match: /^Artifact$/, kind: "artifact" },
      { match: /notion-create-pages$/, kind: "page" },
      { match: /Claude_Docs__(?:batch|create)$/, kind: "document" },
      { match: /chatgpt_space__create_page$/, kind: "page" },
      { match: /sites__save_version_and_deploy/, kind: "deployment" }
    ];
    WORK_PRODUCT_FIELDS = /* @__PURE__ */ new Set(["work_product", "work_products", "deliverable", "deliverables"]);
    LEGACY_KINDS = { docs_url: "documentation", documentation_url: "documentation", promo_url: "promotion", announcement_url: "promotion", pr_url: "pull-request", deck_url: "deck", artifact_url: "artifact" };
    MAX_TITLE = 140;
    short = (value) => {
      const text5 = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      return text5 ? text5.length > MAX_TITLE ? `${text5.slice(0, MAX_TITLE - 1).trimEnd()}\u2026` : text5 : null;
    };
    GIT_PREFIX = String.raw`(?:^|[;&|(\n])\s*(?:rtk\s+)?(?:\/usr\/bin\/)?git(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+`;
    gitPattern = (subcommand, flags = "") => new RegExp(GIT_PREFIX + subcommand, flags);
    GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
    SHA = "[0-9a-f]{7,40}";
    unquote = (token) => token.replace(/^(["'])(.*)\1$/, "$2");
    productKey = (product) => product.kind === "commit" && product.sha ? `commit:${product.sha.slice(0, 7)}` : product.kind === "branch" && product.branch ? `branch:${product.branch}` : product.productId ?? product.url ?? product.path;
    FILE_EXTENSION_PATTERN = Object.keys(FILE_KINDS).map((extension) => `files_modified LIKE '%${extension}"%'`).join(" OR ");
    PUBLISHING_PRODUCT_PREDICATE = `(tool_name IN ('Artifact', 'mcp__claude_ai_Notion__notion-create-pages', 'mcp__claude_ai_Claude_Docs__batch', 'mcp__claude_ai_Claude_Docs__create')
  OR tool_name LIKE '%chatgpt_space__create_page' OR tool_name LIKE '%sites__save_version_and_deploy%'
  OR (tool_name = 'Bash' AND tool_input LIKE '%gh pr create%'))`;
    GIT_PRODUCT_PREDICATE = `tool_name = 'Bash' AND tool_input LIKE '%git%' AND tool_input NOT LIKE '%gh pr create%'
  AND (tool_input LIKE '%commit%' OR tool_input LIKE '%push%' OR tool_input LIKE '%checkout -b%' OR tool_input LIKE '%switch -c%')`;
    productIndexes = /* @__PURE__ */ new WeakMap();
  }
});

// src/utils/worktree.ts
import { existsSync as existsSync8, statSync as statSync4, readFileSync as readFileSync7 } from "fs";
import path from "path";
function detectWorktree(cwd) {
  const gitPath = path.join(cwd, ".git");
  let stat;
  try {
    stat = statSync4(gitPath);
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
    content = readFileSync7(gitPath, "utf-8").trim();
  } catch (error) {
    logger.warn("GIT", "Failed to read .git file", { error: error instanceof Error ? error.message : String(error) });
    return NOT_A_WORKTREE;
  }
  const match = content.match(/^gitdir:\s*(.+)$/s);
  if (!match) {
    return NOT_A_WORKTREE;
  }
  const gitdirPath = path.resolve(path.dirname(gitPath), match[1]);
  const worktreesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/s);
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
  const submoduleMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]modules[/\\](.+)$/s);
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
  const bareWorktreeMatch = gitdirPath.match(/^(.+)[/\\]worktrees[/\\]([^/\\]+)$/s);
  if (bareWorktreeMatch && existsSync8(path.join(gitdirPath, "commondir"))) {
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
var NOT_A_WORKTREE;
var init_worktree = __esm({
  "src/utils/worktree.ts"() {
    "use strict";
    init_logger();
    NOT_A_WORKTREE = {
      isWorktree: false,
      isSubmodule: false,
      worktreeName: null,
      parentRepoPath: null,
      parentProjectName: null
    };
  }
});

// src/utils/project-filter.ts
import { basename as basename5 } from "path";
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
  const pathBasename = basename5(normalizedPath);
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
var init_project_filter = __esm({
  "src/utils/project-filter.ts"() {
    "use strict";
    init_expand_home();
    init_logger();
  }
});

// src/utils/project-environments.ts
import { realpathSync as realpathSync2 } from "fs";
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
    if ("inherit" in entry) {
      const inherit = entry.inherit;
      if (!Array.isArray(inherit) || inherit.some((key) => typeof key !== "string" || !key.trim() || key.includes(","))) {
        throw new Error(`CLAUDE_MEM_PROJECT_ENVIRONMENTS: inherit for "${name}" must be an array of non-empty project names without commas`);
      }
      environments.push({ name, patterns, inherit: [...new Set(inherit.map((key) => key.trim()))] });
    } else {
      environments.push({ name, patterns });
    }
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
      return environment;
    }
  }
  return null;
}
var init_project_environments = __esm({
  "src/utils/project-environments.ts"() {
    "use strict";
    init_project_filter();
    init_logger();
  }
});

// src/utils/project-name.ts
import path2 from "path";
import { existsSync as existsSync9, realpathSync as realpathSync3, statSync as statSync5 } from "fs";
import { homedir as homedir6, tmpdir } from "os";
import { execFileSync } from "child_process";
function findGitRepoRoot(dir) {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).replace(/\n$/, "");
    return root || null;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug("PROJECT_NAME", "git rev-parse failed, falling back to non-git root", { dir }, err);
    return null;
  }
}
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
  return [homedir6(), tmpdir(), CLAUDE_CONFIG_DIR].flatMap((dir) => {
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
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync9(path2.join(current, marker)))) {
      return current;
    }
    current = parent;
  }
  return null;
}
function projectNameFromSource(cwd, nameSource) {
  const basename8 = path2.basename(nameSource);
  if (basename8 === "") {
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
  return basename8;
}
function settingsFileMtimeMs() {
  try {
    return statSync5(USER_SETTINGS_PATH).mtimeMs;
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
  const settings2 = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  identitySettingsCache = { mtimeMs: settingsFileMtimeMs(), settings: settings2 };
  return settings2;
}
function useGitRemoteProjectNames() {
  const source = process.env[PROJECT_NAME_SOURCE_SETTING] ?? readIdentitySettings().CLAUDE_MEM_PROJECT_NAME_SOURCE;
  return String(source ?? "path").trim().toLowerCase() === "git-remote";
}
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
    return environment.name;
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
  if (!relative || relative === ".." || relative.startsWith(`..${path2.sep}`) || path2.isAbsolute(relative)) return null;
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
  return environment ? withPrimaryKey(derivedContext, environment.name, "environment", environment.inherit) : derivedContext;
}
function withPrimaryKey(context, primary, keySource, readKeys = context.allProjects) {
  return {
    primary,
    parent: null,
    isWorktree: context.isWorktree,
    isSubmodule: context.isSubmodule,
    allProjects: [...new Set(readKeys.filter((key) => key !== primary)), primary],
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
      const leaf = submoduleLeaf(worktreeInfo, checkoutRoot);
      primary = `${parent}/${leaf ?? cwdProjectName}`;
      legacyKeys = cwdProjectName !== parent ? [cwdProjectName] : [];
      if (leaf?.startsWith("..") && leaf !== cwdProjectName) {
        legacyKeys.push(`${parent}/${cwdProjectName}`);
      }
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
var UNKNOWN_PROJECT_NAME, PROJECT_ROOT_MARKERS, MAX_MARKER_WALK_DEPTH, PROJECT_NAME_SOURCE_SETTING, identitySettingsCache, PROJECT_ENVIRONMENTS_SETTING, environmentsCache, remoteSlugByRepoRoot;
var init_project_name = __esm({
  "src/utils/project-name.ts"() {
    "use strict";
    init_expand_home();
    init_paths();
    init_SettingsDefaultsManager();
    init_logger();
    init_worktree();
    init_project_environments();
    UNKNOWN_PROJECT_NAME = "unknown-project";
    PROJECT_ROOT_MARKERS = [".claude-mem-project", ".claude-mem.json"];
    MAX_MARKER_WALK_DEPTH = 64;
    PROJECT_NAME_SOURCE_SETTING = "CLAUDE_MEM_PROJECT_NAME_SOURCE";
    identitySettingsCache = null;
    PROJECT_ENVIRONMENTS_SETTING = "CLAUDE_MEM_PROJECT_ENVIRONMENTS";
    environmentsCache = null;
    remoteSlugByRepoRoot = /* @__PURE__ */ new Map();
  }
});

// src/services/work-view/session-project.mjs
import { existsSync as existsSync10, realpathSync as realpathSync4 } from "node:fs";
import { homedir as homedir7, tmpdir as tmpdir2 } from "node:os";
import { basename as basename6, dirname as dirname5, join as join8, resolve as resolve3 } from "node:path";
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
function isAgentScratchFolder(folder) {
  if (typeof folder !== "string" || !folder) return false;
  if (CODEX_SCRATCH.test(folder)) return true;
  const absolute = resolve3(folder);
  return TEMP_FOLDERS.some((temp) => absolute === temp || absolute.startsWith(`${temp}/`));
}
function repoRootOf(path4) {
  const visited = [];
  let current = resolve3(path4), found = null;
  for (; ; ) {
    if (repoRootCache.has(current)) {
      found = repoRootCache.get(current);
      break;
    }
    visited.push(current);
    if (existsSync10(join8(current, ".git"))) {
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
  for (const text5 of strings) for (const match of text5.matchAll(PATH_START)) {
    const raw = match[1].trim();
    const path4 = raw.startsWith("~/") || platform === "win32" && raw.startsWith("~\\") ? join8(HOME, raw.slice(2)) : raw;
    if (path4.length > 1 && isAbsoluteOn(path4, platform) && !isAgentHome(path4)) paths2.push(path4);
  }
  return paths2;
}
function folderNeedsProject(folder, storedProject) {
  if (!folder) return TEMP_PROJECT_NAMES.has(storedProject);
  if (existsSync10(folder)) return !repoRootOf(folder);
  return isAgentScratchFolder(folder);
}
function projectFromToolPaths(toolInputs) {
  const byRoot = /* @__PURE__ */ new Map(), nameOf = /* @__PURE__ */ new Map();
  for (const input of toolInputs) for (const path4 of pathsIn(input)) {
    const checkout = checkoutForPath(path4);
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
var NO_PROJECT, realpathOrSelf3, TEMP_FOLDERS, HOME, TEMP_PROJECT_NAMES, CODEX_SCRATCH, repoRootCache, PATH_START, AGENT_HOMES, isAgentHome, isAbsoluteOn, checkoutForPath, derivedCache, TOOL_SAMPLE;
var init_session_project = __esm({
  "src/services/work-view/session-project.mjs"() {
    "use strict";
    init_project_name();
    NO_PROJECT = "";
    realpathOrSelf3 = (path4) => {
      try {
        return realpathSync4(path4);
      } catch {
        return path4;
      }
    };
    TEMP_FOLDERS = [.../* @__PURE__ */ new Set([resolve3(tmpdir2()), realpathOrSelf3(resolve3(tmpdir2())), "/tmp", "/private/tmp"])];
    HOME = homedir7();
    TEMP_PROJECT_NAMES = new Set(TEMP_FOLDERS.map((folder) => basename6(folder)).filter((name) => name && name !== "tmp"));
    CODEX_SCRATCH = /[/\\]Documents[/\\]Codex[/\\]\d{4}-\d{2}-\d{2}(?:[/\\]|$)/;
    repoRootCache = /* @__PURE__ */ new Map();
    PATH_START = /(?:^|[\s"'`=:(])((?:~[/\\]|\/|[A-Za-z]:[/\\])[^\n\r"'`;|&<>()]*)/g;
    AGENT_HOMES = [".claude", ".codex", ".gemini", ".claude-mem", ".cursor"].map((name) => join8(HOME, name));
    isAgentHome = (path4) => AGENT_HOMES.some((home) => path4 === home || path4.startsWith(`${home}/`) || path4.startsWith(`${home}\\`));
    isAbsoluteOn = (path4, platform) => path4.startsWith("/") && !path4.startsWith("//") || platform === "win32" && /^[A-Za-z]:[/\\]/.test(path4);
    checkoutForPath = (path4) => {
      let current = path4;
      while (current !== dirname5(current) && !existsSync10(current)) current = dirname5(current);
      return repoRootOf(current);
    };
    derivedCache = /* @__PURE__ */ new Map();
    TOOL_SAMPLE = 400;
  }
});

// src/services/work-view/request-projection.mjs
function requestMediaSummary(activity) {
  const refs = /* @__PURE__ */ new Map();
  for (const entry of activity) for (const ref of entry.media?.attachments ?? []) if (!refs.has(ref.id)) refs.set(ref.id, ref);
  if (!refs.size) return null;
  return { count: refs.size, preview: [...refs.values()].slice(0, REQUEST_MEDIA_PREVIEW_LIMIT) };
}
function requestText(value, max = 1200) {
  if (typeof value !== "string") return null;
  const requestSection = value.match(/^\s*#{1,2}\s+My request\s*:\s*(?:\r?\n)?([\s\S]*)$/im);
  const text5 = (requestSection?.[1] ?? value).replace(/<(environment_context|instructions|system-reminder|turn_aborted|permissions|collaboration_mode|skills_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/^\s*#\s*AGENTS\.md instructions[^\n]*(?:\n|$)/gim, " ").replace(/<\/?pasted_content\b[^>]*>/gi, "").trim();
  if (/^\s*#{1,2}\s+Files mentioned by the user\s*:/i.test(text5)) return null;
  if (!text5 || /^\s*<(?:environment_context|instructions|system-reminder)\b/i.test(text5)) return null;
  return text5.length > max ? `${text5.slice(0, max - 1).trimEnd()}\u2026` : text5;
}
function isHumanActionRequest(value) {
  const text5 = requestText(value);
  if (!text5) return false;
  const plain = text5.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
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
function humanRequestTitle(original) {
  const text5 = requestText(typeof original === "string" ? original : original?.text);
  if (!text5) return "";
  const goal = text5.match(/(?:^|\n)\s*GOAL\s*:\s*([^\n]+)/i);
  const lines = text5.split(/\n+/).map((line2) => line2.trim()).filter(Boolean);
  const first = goal?.[1] ?? lines[0] ?? "";
  const nextQuotedLine = /\bcalled\s*$/i.test(first) && /^["“'‘]/.test(lines[1] ?? "") ? ` ${lines[1]}` : "";
  const line = `${first}${nextQuotedLine}`.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^#{1,6}\s*/, "").replace(/\s+/g, " ").trim();
  const clause = line.split(/(?<=[.!?])\s|;\s/)[0];
  if (clause.length <= 100) return clause;
  const cut = clause.slice(0, 99), boundary = cut.lastIndexOf(" ");
  return `${cut.slice(0, boundary > 60 ? boundary : 99).trimEnd()}\u2026`;
}
function conversationKey(session) {
  if (!session?.content_session_id || !session?.platform_source) return null;
  return JSON.stringify(["conversation", session.platform_source, session.content_session_id]);
}
function compareSourceOrder(a = null, b = null) {
  if (!a || !b) return 0;
  const time = a[0] - b[0];
  const device = a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  const left = BigInt(a[2]), right = BigInt(b[2]);
  return time || device || (left < right ? -1 : left > right ? 1 : 0);
}
function originalFor(session, prompts) {
  const ordered = prompts.filter((prompt) => prompt.session_db_id === session.id).sort((a, b) => (a.prompt_number ?? Infinity) - (b.prompt_number ?? Infinity) || (a.created_at_epoch ?? 0) - (b.created_at_epoch ?? 0) || a.id - b.id);
  const first = ordered.find((prompt) => isHumanActionRequest(prompt.prompt_text));
  const initial = () => ({ text: requestText(session.user_prompt), source: "session-initial-request", sourceId: session.sharedOnly ? null : session.id, url: session.sharedOnly ? null : `/api/work-view/evidence/session/${session.id}`, ...session.sharedOnly ? { sourceIdentity: { kind: "session", conversation: conversationKey(session) } } : {}, promptNumber: 1, atEpoch: session.started_at_epoch ?? null });
  if (isHumanActionRequest(session.user_prompt) && (!first || first.prompt_number > 1)) return initial();
  if (first) return { text: requestText(first.prompt_text), source: "user-prompt", sourceId: first.id, url: `/api/work-view/evidence/prompt/${first.id}`, promptNumber: first.prompt_number, atEpoch: first.created_at_epoch ?? null };
  if (isHumanActionRequest(session.user_prompt)) return initial();
  return null;
}
function buildHumanRequests(view, records2 = {}, { titleCache = {}, ledger = null } = {}) {
  const sessions = new Map((records2.sessions ?? []).map((session) => [session.id, session]));
  const prompts = records2.prompts ?? [];
  const flattened = (view.agents ?? []).flatMap((agent) => (agent.work ?? []).map((item) => ({ ...item, agentId: agent.id, agentLabel: agent.label, agentSessionId: agent.sessionId })));
  const subagentIds = new Set((view.agents ?? []).filter((agent) => agent.isSubagent).map((agent) => agent.id));
  const activityPool = /* @__PURE__ */ new Map();
  for (const agent of view.agents ?? []) for (const activity of agent.activity ?? []) activityPool.set(`${agent.id}:${activity.id}`, { ...activity, agentId: agent.id, agentLabel: agent.label });
  for (const activity of view.recentActivity ?? []) {
    const agent = (view.agents ?? []).find((candidate) => candidate.id === activity.agentGroupId);
    if (agent) activityPool.set(`${agent.id}:${activity.id}`, { ...activity, agentId: agent.id, agentLabel: agent.label });
  }
  function activityFor(items, requestId, limit) {
    const matches = /* @__PURE__ */ new Map();
    for (const item of items) {
      const refs = new Set((item.sourceRefs ?? []).map((ref) => `${ref.kind}:${ref.id}`));
      for (const activity of activityPool.values()) {
        if (activity.agentId !== item.agentId) continue;
        const direct = refs.has(activity.id) || activity.sourceRef && refs.has(`${activity.sourceRef.kind}:${activity.sourceRef.id}`);
        const observationForPrompt = activity.kind === "observation" && item.request?.key && activity.requestKey === item.request.key;
        if (direct || observationForPrompt) matches.set(`${activity.agentId}:${activity.id}`, { ...activity, promptRequestKey: activity.requestKey ?? null, requestKey: requestId });
      }
    }
    return [...matches.values()].sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0)).slice(0, limit);
  }
  const explicitIds = /* @__PURE__ */ new Map();
  for (const item of flattened) {
    const key = conversationKey(sessions.get(item.agentSessionId));
    if (key && item.requestId) {
      if (!explicitIds.has(key)) explicitIds.set(key, /* @__PURE__ */ new Set());
      explicitIds.get(key).add(String(item.requestId));
    }
  }
  const sessionsByKey = /* @__PURE__ */ new Map();
  for (const session of sessions.values()) {
    const key = conversationKey(session);
    if (key && !sessionsByKey.has(key)) sessionsByKey.set(key, session);
  }
  const rootFromMembers = (groupId, group) => {
    const anchorRoot = projectRoot(sessionsByKey.get(group.anchor)?.project);
    if (anchorRoot) return anchorRoot;
    const memberRoots = new Set(Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => projectRoot(sessionsByKey.get(key)?.project)).filter(Boolean));
    return memberRoots.size === 1 ? [...memberRoots][0] : NO_PROJECT;
  };
  const derivedRoots = /* @__PURE__ */ new Map();
  const groupRoot = (groupId) => {
    const group = ledger?.groups?.groups?.[groupId];
    if (group?.projectRoot === NO_PROJECT) {
      if (!derivedRoots.has(groupId)) derivedRoots.set(groupId, rootFromMembers(groupId, group));
      return derivedRoots.get(groupId);
    }
    return projectRoot(sessionsByKey.get(group?.anchor)?.project);
  };
  const groupFor = (key, session) => {
    const groupId = key ? ledger?.groups?.conversations?.[key] ?? null : null;
    if (!groupId) return null;
    const storedRoot = ledger.groups.groups[groupId]?.projectRoot;
    if (typeof storedRoot === "string" && storedRoot !== NO_PROJECT) return groupId;
    const own = projectRoot(session?.project), expected = groupRoot(groupId);
    return own == null || expected == null || own === expected || storedRoot === NO_PROJECT && own === NO_PROJECT ? groupId : null;
  };
  const requests = /* @__PURE__ */ new Map(), unlinkedWork = [];
  const requestFor = (id, { key, original, groupId = null, explicit = null, explicitText = null }) => {
    let request = requests.get(id);
    const anchorAsk = groupId ? ledger?.groups?.groups?.[groupId]?.anchorAsk ?? null : null;
    if (anchorAsk && (anchorAsk.atEpoch ?? Infinity) < (original.atEpoch ?? Infinity)) original = anchorAsk;
    if (!request) {
      request = { id, conversationKey: key, conversationKeys: [], original, explicitRequestText: explicitText, scopeUpdates: [], projects: [], agentIds: [], items: [], workstreams: [], updatedAtEpoch: 0, explicitRequestId: explicit, groupId };
      requests.set(id, request);
    } else {
      if (!request.explicitRequestText && explicitText) request.explicitRequestText = explicitText;
      if (groupId && (original.atEpoch ?? Infinity) < (request.original.atEpoch ?? Infinity)) request.original = original;
    }
    if (key && !request.conversationKeys.includes(key)) request.conversationKeys.push(key);
    return request;
  };
  const addProject = (request, project) => {
    if (typeof project === "string" && project && !request.projects.includes(project)) request.projects.push(project);
  };
  for (const [key, session] of sessionsByKey) {
    if (explicitIds.has(key) || ledger?.groups?.ignored?.[key]) continue;
    const original = originalFor(session, prompts);
    if (!original) continue;
    const groupId = groupFor(key, session);
    addProject(requestFor(groupId ? JSON.stringify(["overall-request", groupId]) : key, { key, original, groupId }), session.project);
  }
  for (const [groupId, group] of Object.entries(ledger?.groups?.groups ?? {})) {
    const id = JSON.stringify(["overall-request", groupId]);
    if (requests.has(id) || !group?.anchorAsk || ledger?.groups?.ignored?.[group.anchor]) continue;
    const anchorSession = sessionsByKey.get(group.anchor);
    if (anchorSession) continue;
    requestFor(id, { key: isConversationKey(group.anchor) ? group.anchor : null, original: group.anchorAsk, groupId });
  }
  for (const item of flattened) {
    const session = sessions.get(item.agentSessionId);
    const key = conversationKey(session);
    const knownIds = explicitIds.get(key);
    const explicit = item.requestId ? String(item.requestId) : knownIds?.size === 1 ? [...knownIds][0] : null;
    if (!item.requestId && knownIds?.size > 1) {
      unlinkedWork.push({ ...item, reason: "multiple-explicit-requests-without-item-link" });
      continue;
    }
    let original = session ? originalFor(session, prompts) : null;
    const explicitText = isHumanActionRequest(item.requestText) ? requestText(item.requestText) : null;
    if (!original && explicit && explicitText) original = { text: explicitText, source: "explicit-work-state-request", sourceId: item.id, url: item.url, promptNumber: null, atEpoch: item.lastUpdateEpoch ?? null };
    if (!original || !key && !explicit) {
      unlinkedWork.push({ ...item, reason: key ? "no-substantive-human-request" : "no-confirmed-conversation-or-explicit-request" });
      continue;
    }
    if (!explicit && key && ledger?.groups?.ignored?.[key]) {
      unlinkedWork.push({ ...item, reason: "ignored-by-request-grouping" });
      continue;
    }
    const groupId = !explicit ? groupFor(key, session) : null;
    const root = projectRoot(session?.project) ?? projectRoot(item.project);
    const id = explicit ? JSON.stringify(root == null ? ["explicit-request", explicit] : ["explicit-request", root, explicit]) : groupId ? JSON.stringify(["overall-request", groupId]) : key;
    const request = requestFor(id, { key, original, groupId, explicit, explicitText });
    addProject(request, session?.project);
    addProject(request, item.project);
    if (!request.agentIds.includes(item.agentId)) request.agentIds.push(item.agentId);
    request.items.push(item);
    request.updatedAtEpoch = Math.max(request.updatedAtEpoch, item.lastUpdateEpoch ?? 0);
  }
  const requestsByConversation = /* @__PURE__ */ new Map();
  for (const request of requests.values()) for (const key of request.conversationKeys) {
    if (!requestsByConversation.has(key)) requestsByConversation.set(key, []);
    requestsByConversation.get(key).push(request);
  }
  const sessionsByMemory = new Map([...sessions.values()].filter((session) => session.memory_session_id).map((session) => [session.memory_session_id, session]));
  const recordedProducts = /* @__PURE__ */ new Map();
  const attach = (session, products) => {
    const owners = requestsByConversation.get(conversationKey(session));
    if (owners?.length !== 1 || !products.length) return;
    if (!recordedProducts.has(owners[0])) recordedProducts.set(owners[0], []);
    recordedProducts.get(owners[0]).push(...products);
  };
  for (const call of records2.productCalls ?? []) attach(sessions.get(call.session_db_id), productsFromToolUse(call));
  for (const observation of records2.productObservations ?? []) attach(sessionsByMemory.get(observation.memory_session_id), productsFromObservation(observation));
  for (const row of records2.productDeliverables ?? []) attach(row, productsFromDeliverable(row));
  for (const record of records2.sharedProducts ?? []) {
    const session = sessionsByKey.get(record.conversationKey);
    if (session) attach(session, record.products ?? []);
  }
  const sessionIdsByKey = /* @__PURE__ */ new Map(), promptsBySession = /* @__PURE__ */ new Map();
  for (const session of sessions.values()) {
    const key = conversationKey(session);
    if (key) sessionIdsByKey.set(key, [...sessionIdsByKey.get(key) ?? [], session.id]);
  }
  for (const prompt of prompts) {
    if (!promptsBySession.has(prompt.session_db_id)) promptsBySession.set(prompt.session_db_id, []);
    promptsBySession.get(prompt.session_db_id).push(prompt);
  }
  for (const request of requests.values()) {
    const merged = mergeProducts([...recordedProducts.get(request) ?? [], ...request.items.flatMap((item) => item.workProduct ?? [])]);
    const copies = merged.filter((product) => product.deliverable && product.sourcePath);
    const covered = (product) => Boolean(product.path) && copies.some((copy) => copy.sourcePath === product.path && copyCoversSource(copy, product.path));
    request.workProduct = merged.filter((product) => !covered(product)).map((product) => ({ ...product, fileUrl: fileUrl(product), available: product.path ? Boolean(servableFile(product)) : product.deliverable ? bucketFileAvailable(product) : true }));
    const relatedIds = new Set(request.conversationKeys.flatMap((key) => sessionIdsByKey.get(key) ?? []));
    const related = [...relatedIds].flatMap((id) => promptsBySession.get(id) ?? []);
    request.updatedAtEpoch = Math.max(request.updatedAtEpoch, request.original.atEpoch ?? 0, ...related.map((prompt) => prompt.created_at_epoch ?? 0));
    if (!request.agentIds.length) {
      for (const agent of view.agents ?? []) if (relatedIds.has(agent.sessionId) && !request.agentIds.includes(agent.id)) request.agentIds.push(agent.id);
    }
    request.scopeUpdates = related.filter((prompt) => !(request.original.source === "user-prompt" && prompt.id === request.original.sourceId) && requestText(prompt.prompt_text) && (request.original.promptNumber == null || prompt.prompt_number >= request.original.promptNumber)).sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0) || b.prompt_number - a.prompt_number || b.id - a.id).slice(0, 6).reverse().map((prompt) => ({ text: requestText(prompt.prompt_text, 500), sourceId: prompt.id, url: `/api/work-view/evidence/prompt/${prompt.id}`, promptNumber: prompt.prompt_number, atEpoch: prompt.created_at_epoch ?? null }));
    const streams = /* @__PURE__ */ new Map();
    for (const item of request.items) {
      const id = item.listId ?? JSON.stringify(["agent-session", item.agentId]);
      if (!streams.has(id)) streams.set(id, { id, title: item.listName ?? item.title, agentIds: [], items: [] });
      const stream = streams.get(id);
      if (!stream.agentIds.includes(item.agentId)) stream.agentIds.push(item.agentId);
      stream.items.push(item);
    }
    request.workstreams = [...streams.values()];
    request.agentIds.sort((a, b) => Number(subagentIds.has(a)) - Number(subagentIds.has(b)));
    for (const stream of request.workstreams) stream.activity = activityFor(stream.items, request.id, 20);
    request.activity = activityFor(request.items, request.id, 40);
    const media = requestMediaSummary(request.activity);
    if (media) request.media = media;
    const metadata = (key) => request.items.map((item) => ({ item, record: item[key] })).filter(({ record }) => record).sort((a, b) => (b.record.atEpoch ?? 0) - (a.record.atEpoch ?? 0));
    const lifecycleRecords = request.items.flatMap((item) => [
      ...typeof item.requestStatus === "string" && item.requestStatus.trim() ? [{ status: item.requestStatus.trim(), explicit: true, field: "request_status", sourceId: item.id, url: item.url, atEpoch: item.requestStatusSource?.atEpoch ?? item.lastUpdateEpoch ?? null, sourceOrder: item.requestStatusSource?.sourceOrder ?? null, sourceRef: item.requestStatusSource?.sourceRef ?? null }] : [],
      ...typeof item.requestComplete === "boolean" ? [{ status: item.requestComplete ? "done" : "open", complete: item.requestComplete, explicit: true, field: "request_complete", sourceId: item.id, url: item.url, atEpoch: item.requestCompleteSource?.atEpoch ?? item.lastUpdateEpoch ?? null, sourceOrder: item.requestCompleteSource?.sourceOrder ?? null, sourceRef: item.requestCompleteSource?.sourceRef ?? null }] : []
    ]).sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0) || compareSourceOrder(b.sourceOrder, a.sourceOrder) || Number(b.field === "request_complete") - Number(a.field === "request_complete"));
    request.lifecycle = lifecycleRecords[0] ?? null;
    request.startedAtEpoch = request.original.atEpoch ?? null;
    request.progress = request.groupId ? ledger?.progress?.[request.groupId] ?? null : null;
    request.completedAtEpoch = request.lifecycle && (request.lifecycle.complete === true || ["done", "completed", "complete", "shipped", "delivered"].includes(request.lifecycle.status.toLowerCase())) ? request.lifecycle.atEpoch : null;
    request.requestedBy = metadata("requestedBySource")[0]?.item.requestedBy ?? null;
    request.requestedBySource = metadata("requestedBySource")[0]?.record ?? null;
    request.shipEstimate = metadata("shipEstimateSource")[0]?.item.shipEstimate ?? null;
    request.shipEstimateSource = metadata("shipEstimateSource")[0]?.record ?? null;
    request.stageSourceText = metadata("stageSource")[0]?.item.stageSourceText ?? null;
    request.stageSource = metadata("stageSource")[0]?.record ?? null;
    const collect = (section, valueKey) => {
      const unique = /* @__PURE__ */ new Map();
      for (const item of request.items) for (const value of item.afterShip?.[section] ?? []) {
        const key = JSON.stringify([value.kind ?? section, value[valueKey]]);
        if (!unique.has(key)) unique.set(key, { ...value, sourceRefs: [] });
        const target = unique.get(key);
        for (const ref of value.sourceRefs ?? []) if (!target.sourceRefs.some((other) => other.kind === ref.kind && other.id === ref.id)) target.sourceRefs.push(ref);
      }
      return [...unique.values()];
    };
    const resources = collect("resources", "url"), classifications = collect("classifications", "text"), notes = collect("notes", "text");
    request.afterShip = resources.length || classifications.length || notes.length ? { resources, classifications, notes } : null;
    const cached = titleCache instanceof Map ? titleCache.get(request.id) : titleCache[request.id];
    const cachedTitle = typeof cached === "string" ? cached.trim() : cached && cached.source === request.original.source && cached.sourceId != null && String(cached.sourceId) === String(request.original.sourceId) && typeof cached.title === "string" ? cached.title.trim() : "";
    const groupTitle = request.groupId ? ledger?.groups?.groups?.[request.groupId]?.title?.trim() ?? "" : "";
    request.title = cachedTitle || groupTitle || humanRequestTitle(request.explicitRequestText ?? request.original);
    request.titleSource = cachedTitle ? "title-cache" : groupTitle ? "request-group" : request.explicitRequestText ? "explicit-work-state-request" : "original-human-request";
    request.items.sort((a, b) => (b.lastUpdateEpoch ?? 0) - (a.lastUpdateEpoch ?? 0));
  }
  return { humanRequests: [...requests.values()].sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch), unlinkedWork };
}
var REQUEST_MEDIA_PREVIEW_LIMIT, ENGLISH_ACTION, IMPERATIVE_OPENING, NOT_A_VERB, ENGLISH_WORDS, isConversationKey;
var init_request_projection = __esm({
  "src/services/work-view/request-projection.mjs"() {
    "use strict";
    init_work_product();
    init_session_project();
    REQUEST_MEDIA_PREVIEW_LIMIT = 4;
    ENGLISH_ACTION = /\b(?:make|build|create|implement|design|fix|investigate|audit|review|write|rewrite|show|see|find|search|explain|compare|help|convert|add|remove|update|rename|run|test|verify|deploy|analyze|analyse|read|tell|open|generate|ship|merge|commit|push|release|publish|set up|i want|i need|can you|could you|would you|how (?:can|do|does|is)|what (?:is|are|does|did)|why (?:is|are|does|did)|do we|do you|(?:is|are|seems?|looks?) (?:broken|failing|wrong)|doesn'?t work|not working)\b/i;
    IMPERATIVE_OPENING = /^(?:please\s+)?([a-z]{3,})\s+(?:the|this|that|these|those|all|every|each|my|our|your|its|it|them|any|some|a|an)\b/i;
    NOT_A_VERB = /^(?:the|and|for|with|from|now|then|just|not|about|after|before|into|onto|over|under|like|also|here|there|when|where|what|which|who|why|how|but|yet|all|any|some|its|our|your|this|that|these|those|they|she|his|her|one|two|three)$/i;
    ENGLISH_WORDS = /\b(?:the|a|an|this|that|it|is|are|to|of|and|for|with|in|on|my|me|you|we|please|just|all|so|now|then|from|be|not)\b/i;
    isConversationKey = (value) => {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed[0] === "conversation" && parsed.length === 3;
      } catch {
        return false;
      }
    };
  }
});

// src/services/work-view/owner-goals.mjs
function isOwnerGoalsList(name) {
  return name === OWNER_GOALS_LIST || String(name ?? "").startsWith(`${OWNER_GOALS_LIST}/`);
}
function goalKindOf(fields) {
  const value = fields?.goal_kind;
  if (GOAL_KINDS.includes(value)) return { kind: value, legacy: false };
  if (Object.hasOwn(LEGACY_GOAL_KINDS, value)) return { kind: LEGACY_GOAL_KINDS[value], legacy: true };
  throw new Error(`Owner-goals item ${JSON.stringify(fields?.task ?? null)} has an unknown goal_kind: ${JSON.stringify(value ?? null)}`);
}
var OWNER_GOALS_LIST, GOAL_KINDS, LEGACY_GOAL_KINDS;
var init_owner_goals = __esm({
  "src/services/work-view/owner-goals.mjs"() {
    "use strict";
    OWNER_GOALS_LIST = "owner-goals";
    GOAL_KINDS = ["focus-area", "ask"];
    LEGACY_GOAL_KINDS = { priority: "focus-area", "open-ask": "ask" };
  }
});

// src/services/work-view/work-state-limits.mjs
var init_work_state_limits = __esm({
  "src/services/work-view/work-state-limits.mjs"() {
    "use strict";
  }
});

// src/utils/redaction.ts
import { existsSync as existsSync11, readFileSync as readFileSync8 } from "fs";
function genericBuiltinRegex(lookbehind) {
  return new RegExp(`${lookbehind}${GENERIC_VALUE}`, "gi");
}
function webhookHost(host) {
  const ci = host.replace(/\\.|[a-z]/g, (c) => c.length === 1 ? `[${c}${c.toUpperCase()}]` : c);
  return String.raw`(?:^|\/\/|@|[^\w.\/@%-])${ci}`;
}
function keyedLookbehind(key) {
  return `(?<=${key}${OPTIONAL_QUOTE}${BOUNDED_SPACE}[=:]${BOUNDED_SPACE}${OPTIONAL_QUOTE})`;
}
function redactSensitive(input, config) {
  if (!config.enabled || input.length === 0) {
    return { redacted: input, counts: {}, oversize: false };
  }
  if (input.length > MAX_INPUT_CHARS) {
    logger.warn("REDACT", "field exceeds the 1M-char redaction cap; replaced by an oversize marker", void 0, {
      inputLength: input.length
    });
    return { redacted: OVERSIZE_MARKER, counts: { oversize: 1 }, oversize: true };
  }
  const disabled = new Set(config.disabledBuiltinPatterns ?? []);
  const counts = {};
  let working = input;
  const compiledCustom = [];
  for (const cp of config.customPatterns ?? []) {
    if (!cp.name || cp.name.length === 0) {
      logger.warn("REDACT", "custom pattern skipped: missing name", void 0, { pattern: cp });
      continue;
    }
    try {
      compiledCustom.push({ name: cp.name, regex: new RegExp(cp.regex, "g") });
    } catch (error) {
      logger.warn("REDACT", "custom pattern skipped: invalid regex", { name: cp.name }, error instanceof Error ? error : new Error(String(error)));
    }
  }
  const allPatterns = [
    ...compiledCustom,
    ...BUILTIN_REDACTION_PATTERNS,
    ...config.genericEnabled ? GENERIC_REDACTION_PATTERNS : []
  ];
  for (const pattern of allPatterns) {
    if (disabled.has(pattern.name)) continue;
    pattern.regex.lastIndex = 0;
    working = working.replace(pattern.regex, () => {
      counts[pattern.name] = (counts[pattern.name] ?? 0) + 1;
      return `<redacted type='${pattern.name}'/>`;
    });
  }
  if (config.logMatches && Object.keys(counts).length > 0) {
    logger.debug("REDACT", "patterns matched", void 0, { counts });
  }
  return { redacted: working, counts, oversize: false };
}
function safeParseCustomPatterns(raw) {
  if (!raw || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn("REDACT", "CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring");
      return [];
    }
    return parsed.filter((p) => p && typeof p.name === "string" && typeof p.regex === "string");
  } catch (error) {
    logger.warn(
      "REDACT",
      "failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",
      void 0,
      error instanceof Error ? error : new Error(String(error))
    );
    return [];
  }
}
function loadRedactionConfig(settings2) {
  return {
    enabled: settings2.CLAUDE_MEM_REDACT_ENABLED === "true",
    disabledBuiltinPatterns: (settings2.CLAUDE_MEM_REDACT_DISABLED_BUILTINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    customPatterns: safeParseCustomPatterns(settings2.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS ?? "[]"),
    logMatches: settings2.CLAUDE_MEM_REDACT_LOG_MATCHES === "true",
    genericEnabled: settings2.CLAUDE_MEM_REDACT_GENERIC_ENABLED === "true"
  };
}
function readSettingsText(settingsPath) {
  if (!existsSync11(settingsPath)) return null;
  try {
    return readFileSync8(settingsPath, "utf-8");
  } catch {
    return "";
  }
}
function isUnreadableSettings(text5) {
  if (text5 === null) return false;
  try {
    const parsed = JSON.parse(stripUtf8Bom(text5));
    return parsed === null || typeof parsed !== "object" || Array.isArray(parsed);
  } catch {
    return true;
  }
}
function configForUnreadableSettings(settingsPath, text5, loaded) {
  if (process.env.CLAUDE_MEM_REDACT_ENABLED === "false") return loaded;
  const requested = lastLoadedConfig?.enabled === true || REDACTION_REQUESTED_IN_RAW.test(text5);
  if (!requested) return loaded;
  if (!warnedUnreadableSettings) {
    warnedUnreadableSettings = true;
    logger.warn("REDACT", "settings.json could not be read; secret redaction stays on until it is repaired", {
      settingsPath,
      using: lastLoadedConfig?.enabled ? "the last configuration that loaded" : "the built-in patterns"
    });
  }
  return lastLoadedConfig?.enabled ? lastLoadedConfig : BUILTINS_ONLY;
}
function getRedactionConfig(settingsPath = USER_SETTINGS_PATH) {
  const now = Date.now();
  if (cachedConfig && now - cacheStamp < CACHE_TTL_MS) {
    return cachedConfig;
  }
  const settings2 = SettingsDefaultsManager.loadFromFile(settingsPath);
  const loaded = loadRedactionConfig(settings2);
  const text5 = loaded.enabled ? null : readSettingsText(settingsPath);
  if (isUnreadableSettings(text5)) {
    cachedConfig = configForUnreadableSettings(settingsPath, text5, loaded);
  } else {
    cachedConfig = loaded;
    lastLoadedConfig = loaded;
  }
  cacheStamp = now;
  return cachedConfig;
}
function genericMarkerForKeyedValue(key, value, config) {
  if (!config.genericEnabled) return null;
  const name = GENERIC_PASSWORD_KEY.test(key) ? "generic_password" : GENERIC_TOKEN_KEY.test(key) ? "generic_token" : null;
  if (!name) return null;
  if (config.disabledBuiltinPatterns?.includes(name)) return null;
  if (!WHOLE_GENERIC_VALUE.test(value) || !/[A-Za-z]/.test(value)) return null;
  return `<redacted type='${name}'/>`;
}
function bearerMarkerForKeyedValue(key, value, config) {
  if (!config.genericEnabled || config.disabledBuiltinPatterns?.includes("bearer_token")) return null;
  if (!AUTHORIZATION_KEY.test(key)) return null;
  const match = KEYED_BEARER_VALUE.exec(value);
  return match ? `${match[1]}<redacted type='bearer_token'/>${value.slice(match[0].length)}` : null;
}
function basicMarkerForKeyedValue(key, value, config) {
  if (!config.genericEnabled || config.disabledBuiltinPatterns?.includes("basic_auth")) return null;
  if (!AUTHORIZATION_KEY.test(key)) return null;
  const match = KEYED_BASIC_VALUE.exec(value);
  return match ? `${match[1]}<redacted type='basic_auth'/>${value.slice(match[0].length)}` : null;
}
function awsSessionTokenMarkerForKeyedValue(key, value, config) {
  if (config.disabledBuiltinPatterns?.includes("aws_session_token")) return null;
  if (!AWS_SESSION_TOKEN_KEY.test(key) || !WHOLE_AWS_SESSION_TOKEN_VALUE.test(value)) return null;
  return "<redacted type='aws_session_token'/>";
}
function awsSecretKeyMarkerForKeyedValue(key, value, config) {
  if (config.disabledBuiltinPatterns?.includes("aws_secret_key")) return null;
  if (!AWS_SECRET_KEY_KEY.test(key) || !WHOLE_AWS_SECRET_KEY_VALUE.test(value)) return null;
  return "<redacted type='aws_secret_key'/>";
}
function redactJsonStrings(value, config = getRedactionConfig()) {
  if (!config.enabled) return value;
  const walk = (node, key) => {
    if (typeof node === "string") {
      const result = redactSensitive(node, config);
      if (key === void 0 || Object.keys(result.counts).length > 0) return result.redacted;
      return awsSessionTokenMarkerForKeyedValue(key, node, config) ?? awsSecretKeyMarkerForKeyedValue(key, node, config) ?? bearerMarkerForKeyedValue(key, node, config) ?? basicMarkerForKeyedValue(key, node, config) ?? genericMarkerForKeyedValue(key, node, config) ?? result.redacted;
    }
    if (Array.isArray(node)) return node.map((child) => walk(child));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, walk(child, childKey)]));
    }
    return node;
  };
  return walk(value);
}
var GENERIC_VALUE_CLASS, GENERIC_VALUE, OPTIONAL_QUOTE, BOUNDED_SPACE, BARE_TOKEN_KEY, ESCAPED_QUOTE, STRING_EDGE, ASSIGNMENT_START, LINE_START, LINE_END, GENERIC_TOKEN_REGEX, BUILTIN_REDACTION_PATTERNS, GENERIC_REDACTION_PATTERNS, MAX_INPUT_CHARS, OVERSIZE_MARKER, cachedConfig, cacheStamp, CACHE_TTL_MS, lastLoadedConfig, warnedUnreadableSettings, BUILTINS_ONLY, REDACTION_REQUESTED_IN_RAW, GENERIC_PASSWORD_KEY, GENERIC_TOKEN_KEY, WHOLE_GENERIC_VALUE, AUTHORIZATION_KEY, KEYED_BEARER_VALUE, KEYED_BASIC_VALUE, AWS_SESSION_TOKEN_KEY, WHOLE_AWS_SESSION_TOKEN_VALUE, AWS_SECRET_KEY_KEY, WHOLE_AWS_SECRET_KEY_VALUE;
var init_redaction = __esm({
  "src/utils/redaction.ts"() {
    "use strict";
    init_logger();
    init_SettingsDefaultsManager();
    init_paths();
    init_atomic_json();
    GENERIC_VALUE_CLASS = String.raw`[A-Za-z0-9_.\-+/=~@#$%^*!?]`;
    GENERIC_VALUE = `(?=${GENERIC_VALUE_CLASS}{8})${GENERIC_VALUE_CLASS}*[A-Za-z]${GENERIC_VALUE_CLASS}*`;
    OPTIONAL_QUOTE = String.raw`(?:\\{0,3}["'])?`;
    BOUNDED_SPACE = String.raw`\s{0,8}`;
    BARE_TOKEN_KEY = String.raw`(?:token|secret|api_key)`;
    ESCAPED_QUOTE = String.raw`\\{0,3}["']`;
    STRING_EDGE = String.raw`(?<!\\)"`;
    ASSIGNMENT_START = String.raw`(?:^|[\s?&]|\\[nrt]|${STRING_EDGE})`;
    LINE_START = String.raw`(?:^|\n|\\n|${STRING_EDGE})[ \t]{0,8}(?:-[ \t]{1,8})?`;
    LINE_END = String.raw`(?:${ESCAPED_QUOTE})?[ \t]{0,8}(?:$|\r?\n|\\{1,3}[rn]|#|${STRING_EDGE})`;
    GENERIC_TOKEN_REGEX = new RegExp([
      `${keyedLookbehind(String.raw`\b\w*_${BARE_TOKEN_KEY}`)}${GENERIC_VALUE}`,
      `(?<=${ESCAPED_QUOTE}${BARE_TOKEN_KEY}${ESCAPED_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${ESCAPED_QUOTE})${GENERIC_VALUE}`,
      `(?<=${ASSIGNMENT_START}${BARE_TOKEN_KEY}=${OPTIONAL_QUOTE})${GENERIC_VALUE}(?!\\(|${GENERIC_VALUE_CLASS})`,
      String.raw`(?<=--(?:[a-z0-9]+[-_])*(?:token|secret|api[-_]key)(?:=|[ \t]{1,8})${OPTIONAL_QUOTE})${GENERIC_VALUE}`,
      `(?<=${LINE_START}${BARE_TOKEN_KEY}:[ \\t]{1,8}${OPTIONAL_QUOTE})${GENERIC_VALUE}(?=${LINE_END})`
    ].join("|"), "gi");
    BUILTIN_REDACTION_PATTERNS = [
      // The password in a URL's userinfo: `postgres://app:hunter2@db/prod`,
      // `redis://:hunter2@cache:6379/0`, `https://user:pass@host/repo.git` (what
      // `git remote -v` and a DATABASE_URL print). Only the password is replaced,
      // so the scheme, user and host stay readable. The value stops at `/`, `@`,
      // whitespace and quotes; a `<` start keeps an earlier marker and a `$`/`{`
      // start keeps a `${DB_PASS}` placeholder from being taken for a secret.
      // First in the list, so the whole password goes before a vendor pattern can
      // split it with its marker and leave the rest of it behind.
      { name: "url_credentials", regex: /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@'"<>]*:)(?![${<])[^\s\/@'"<>]+(?=@)/gi },
      // `AKIA` is a long-term access key ID; `ASIA` is the temporary one that STS,
      // SSO and instance roles hand out (`aws sts assume-role`, `aws configure
      // export-credentials`), printed next to its secret and session token.
      { name: "aws_access_key", regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
      // Anchored to its key names: `AWS_SECRET_ACCESS_KEY=…` in env output,
      // `aws_secret_access_key = …` in ~/.aws/credentials and SDK arguments (any
      // letter case), and `"SecretAccessKey": "…"` in `aws sts` / `aws configure
      // export-credentials` JSON, which prints it beside the ASIA key ID and the
      // session token. keyedLookbehind also takes JSON-style `"KEY": "val"`.
      { name: "aws_secret_key", regex: new RegExp(`${keyedLookbehind(String.raw`(?:aws_secret_access_key|\bSecretAccessKey)`)}[A-Za-z0-9/+=]{40}`, "gi") },
      // The session token of temporary credentials (STS, SSO, `aws configure
      // export-credentials`) grants access together with the key pair, so it is
      // anchored to its key names the same way: `AWS_SESSION_TOKEN=…` in env
      // output, `aws_session_token = …` in ~/.aws/credentials and
      // `"SessionToken": "…"` in `aws sts` JSON. Real tokens run to hundreds of
      // base64 characters; the 100-char floor keeps short placeholders out.
      { name: "aws_session_token", regex: new RegExp(`${keyedLookbehind(String.raw`\b(?:aws_session_token|SessionToken)`)}[A-Za-z0-9/+=]{100,}`, "gi") },
      { name: "github_pat", regex: /\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
      // openai_key, anthropic_key, slack_token, jwt and google_api_key end in a
      // class that includes `-`. A closing `\b` after a `-` needs a word character
      // to follow, so a Google key ending in `-` was not redacted at all and the
      // others left their final `-` in the stored text. `(?!\w)` is the same
      // "the token ends here" check without that gap.
      { name: "openai_key", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}(?!\w)/g },
      { name: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}(?!\w)/g },
      // Slack bot/user/legacy tokens (`xoxb-`, `xoxp-`, …), refresh tokens from
      // token rotation (`xoxe-`) and app-level Socket Mode tokens (`xapp-`).
      { name: "slack_token", regex: /\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}(?!\w)/g },
      { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)/g },
      // A PGP secret key is armored as `PRIVATE KEY BLOCK`, and an encrypted
      // PKCS#8 key as `ENCRYPTED PRIVATE KEY`.
      { name: "private_key_pem", regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
      // API keys (`sk_`/`pk_`/`rk_`) and webhook signing secrets (`whsec_`, what
      // `stripe listen` prints and STRIPE_WEBHOOK_SECRET holds), which forge events.
      { name: "stripe_key", regex: /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g },
      { name: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}(?!\w)/g },
      // Google OAuth 2.0 access tokens: `ya29.` + a base64url body, plus the
      // `ya29.c.` form the GCE metadata server hands out. `gcloud auth
      // print-access-token`, `curl -H "Authorization: Bearer …"` lines and token
      // JSON print them; each grants an hour of the account's API access.
      { name: "google_oauth_token", regex: /\bya29\.(?:c\.)?[0-9A-Za-z_-]{20,}(?!\w)/g },
      // GitLab personal/project/group access tokens (`glpat-`), deploy tokens (`gldt-`),
      // and runner authentication tokens (`glrt-` + 20 chars; newer routable tokens
      // add dot-separated segments), Hugging Face user access tokens (`hf_` + 34 chars),
      // npm access tokens (`npm_` + 36 chars) and Docker Hub personal access tokens
      // (`dckr_pat_` + 27 chars): credentials printed in config files, CLI commands
      // (`glab`, `huggingface-cli`, `npm`, `docker login`), and env dumps.
      { name: "gitlab_token", regex: /\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*(?!\w)/g },
      { name: "huggingface_token", regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
      { name: "npm_token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
      { name: "docker_pat", regex: /\bdckr_pat_[A-Za-z0-9_-]{27,}(?!\w)/g },
      // Linear personal API keys (`lin_api_` + 40 alphanumerics) and Notion
      // integration tokens (`ntn_` + 46 alphanumerics, and the older `secret_` +
      // 43): what `LINEAR_API_KEY=…` / `NOTION_TOKEN=…` lines, MCP server configs
      // and `curl -H "Authorization: …"` commands print. Fixed lengths keep
      // `secret_` words and short look-alikes out.
      { name: "linear_key", regex: /\blin_api_[A-Za-z0-9]{40}(?!\w)/g },
      { name: "notion_token", regex: /\b(?:ntn_[A-Za-z0-9]{46}|secret_[A-Za-z0-9]{43})(?!\w)/g },
      // SendGrid API keys (`SG.` + 22 + `.` + 43 base64url chars), DigitalOcean
      // personal access, OAuth and refresh tokens (`dop_v1_`/`doo_v1_`/`dor_v1_` +
      // 64 hex) and Shopify Admin API, app and shared-secret tokens (`shpat_`,
      // `shpca_`, `shppa_`, `shpss_` + 32 hex): what `doctl`, the Shopify CLI and
      // `.env` dumps print.
      { name: "sendgrid_key", regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g },
      { name: "digitalocean_token", regex: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
      { name: "shopify_token", regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
      // PyPI API tokens: `pypi-` + a base64url macaroon whose header always
      // starts `AgE` (pypi.org and test.pypi.org alike), printed by `twine`,
      // `uv publish` and `~/.pypirc` dumps. Real tokens run past 150 characters.
      { name: "pypi_token", regex: /\bpypi-AgE[A-Za-z0-9_-]{50,}(?!\w)/g },
      // Databricks personal access tokens (`dapi` + 32 hex, sometimes with a
      // `-<digit>` suffix) that DATABRICKS_TOKEN, `~/.databrickscfg` and
      // `databricks tokens create` print, and HashiCorp Vault service and batch
      // tokens (`hvs.` + 90-120 and `hvb.` + 138-300 base64url chars) that
      // VAULT_TOKEN, `~/.vault-token` and `vault login` / `vault token create`
      // print.
      { name: "databricks_token", regex: /\bdapi[a-f0-9]{32}(?:-\d)?(?!\w)/g },
      { name: "vault_token", regex: /\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/g },
      // Two OpenAI-compatible providers this project onboards users for
      // (src/shared/openai-compat-presets.ts): NVIDIA NIM issues `nvapi-` keys and
      // Runcrate issues `rc_live_` keys. Both presets tell the user the prefix in
      // their installer hint, and neither was claimed by openai_key (`sk-`), so a
      // key pasted into a session (or printed by a `curl`/`.env` dump) was stored
      // verbatim. 32+ trailing chars keeps short placeholders out.
      { name: "nvidia_nim_key", regex: /\bnvapi-[A-Za-z0-9_-]{32,}(?!\w)/g },
      { name: "runcrate_key", regex: /\brc_live_[A-Za-z0-9_-]{24,}(?!\w)/g },
      // Groq API keys (`gsk_` + 52 alphanumerics) and xAI API keys (`xai-` + 80
      // chars): LLM provider keys that `.env` files, `export GROQ_API_KEY=…` /
      // `XAI_API_KEY=…` lines and `curl -H "Authorization: Bearer …"` commands
      // print. Neither prefix is claimed by openai_key, so they stayed in the text.
      { name: "groq_key", regex: /\bgsk_[A-Za-z0-9]{52}(?!\w)/g },
      { name: "xai_key", regex: /\bxai-[A-Za-z0-9_]{80}(?!\w)/g },
      // Perplexity API keys (`pplx-` + 48 alphanumerics): an LLM provider key
      // that `.env` files, `export PERPLEXITY_API_KEY=…` lines and `curl -H
      // "Authorization: Bearer …"` commands print. The prefix is not claimed by
      // openai_key, and Perplexity model ids share it (`pplx-embed-v1-4b`), so
      // the fixed 48-char alphanumeric body keeps the model ids out. The worker
      // scans JSON.stringify(toolResponse), where a newline right before the key
      // arrives as `\n`; the `n` is a word character, so a bare `\b` cannot match
      // there and the lookbehind also accepts the escaped whitespace pair, like
      // generic_token's ASSIGNMENT_START.
      { name: "perplexity_key", regex: new RegExp(String.raw`(?<=\\[nrt]|\b)pplx-[A-Za-z0-9]{48}(?!\w)`, "g") },
      // Supabase personal access tokens (`sbp_` + 40 hex, what `supabase login`
      // stores and SUPABASE_ACCESS_TOKEN holds) and Sentry auth tokens: personal
      // ones (`sntryu_` + 64 hex) and organization ones (`sntrys_` + a base64
      // payload + `_` + a 43-char base64 secret), which SENTRY_AUTH_TOKEN lines,
      // `.sentryclirc` dumps and source-map upload commands print.
      { name: "supabase_token", regex: /\bsbp_[a-f0-9]{40}(?!\w)/g },
      { name: "sentry_token", regex: /\b(?:sntryu_[a-f0-9]{64}(?!\w)|sntrys_[A-Za-z0-9+\/]{20,}={0,2}_[A-Za-z0-9+\/]{43}(?![\w+\/]))/g },
      // Incoming webhook URLs carry their secret in the path, so anyone holding
      // one can post to the channel: Slack (`hooks.slack.com/services/T…/B…/…`,
      // plus workflow and trigger URLs) and Discord (`discord.com/api/webhooks/
      // <id>/<token>`, discordapp.com and the ptb/canary hosts too), as printed by
      // `.env` dumps, CI configs and `curl -X POST` commands. Only the last path
      // segment is replaced, so the host and the workspace/channel ids stay
      // readable. The host must start the URL's host part (after `//`, `@`, or a
      // non-URL character), so `example.com/hooks.slack.com/…` keeps its path, and
      // it matches in any letter case, as DNS does; the path stays case-sensitive.
      { name: "slack_webhook", regex: new RegExp(String.raw`(?<=${webhookHost(String.raw`hooks\.slack\.com`)}\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Z0-9]+\/(?:[0-9]+\/)?)[A-Za-z0-9]{20,}(?!\w)`, "g") },
      { name: "discord_webhook", regex: new RegExp(String.raw`(?<=${webhookHost(String.raw`(?:(?:ptb|canary)\.)?discord(?:app)?\.com`)}\/api\/(?:v\d+\/)?webhooks\/[0-9]{17,20}\/)[A-Za-z0-9_-]{60,}(?![\w-])`, "g") },
      // claude-mem's own credentials: server API keys (`cmem_` + 43 base64url
      // chars, server-bootstrap.ts createRawApiKey) and cmem.ai Pro memory keys.
      { name: "claude_mem_key", regex: /\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g }
    ];
    GENERIC_REDACTION_PATTERNS = [
      // `pwd` only as a suffix (`DB_PWD`, `MYSQL_PWD`): the bare `PWD` and
      // `OLDPWD` environment variables hold a working directory, not a secret.
      { name: "generic_password", regex: genericBuiltinRegex(keyedLookbehind(String.raw`\b(?:\w*_?(?:password|passwd)|\w+_pwd)`)) },
      { name: "generic_token", regex: GENERIC_TOKEN_REGEX },
      { name: "bearer_token", regex: genericBuiltinRegex(`(?<=\\bAuthorization${OPTIONAL_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${OPTIONAL_QUOTE}Bearer${BOUNDED_SPACE})`) },
      // `Authorization: Basic …` carries base64(user:password), a password anyone
      // can decode, as in `curl -H "Authorization: Basic dXNlcjpodW50ZXIy"`.
      { name: "basic_auth", regex: genericBuiltinRegex(`(?<=\\bAuthorization${OPTIONAL_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${OPTIONAL_QUOTE}Basic${BOUNDED_SPACE})`) }
    ];
    MAX_INPUT_CHARS = 1024 * 1024;
    OVERSIZE_MARKER = "<redacted type='oversize'/>";
    cachedConfig = null;
    cacheStamp = 0;
    CACHE_TTL_MS = 5e3;
    lastLoadedConfig = null;
    warnedUnreadableSettings = false;
    BUILTINS_ONLY = { enabled: true, disabledBuiltinPatterns: [], customPatterns: [], logMatches: false };
    REDACTION_REQUESTED_IN_RAW = /"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;
    GENERIC_PASSWORD_KEY = /(?:password|passwd)$|\w_pwd$/i;
    GENERIC_TOKEN_KEY = /(?:^|_)(?:secret|token|api_key)$/i;
    WHOLE_GENERIC_VALUE = new RegExp(`^${GENERIC_VALUE_CLASS}{8,}$`);
    AUTHORIZATION_KEY = /^(?:proxy-)?authorization$/i;
    KEYED_BEARER_VALUE = new RegExp(`^(${BOUNDED_SPACE}Bearer${BOUNDED_SPACE})${GENERIC_VALUE}`, "i");
    KEYED_BASIC_VALUE = new RegExp(`^(${BOUNDED_SPACE}Basic${BOUNDED_SPACE})${GENERIC_VALUE}`, "i");
    AWS_SESSION_TOKEN_KEY = /^(?:aws_session_token|SessionToken)$/i;
    WHOLE_AWS_SESSION_TOKEN_VALUE = /^[A-Za-z0-9/+=]{100,}$/;
    AWS_SECRET_KEY_KEY = /^(?:aws_secret_access_key|SecretAccessKey)$/i;
    WHOLE_AWS_SECRET_KEY_VALUE = /^[A-Za-z0-9/+=]{40}$/;
  }
});

// src/services/sync/diagnostic-redaction.ts
function redactSyncDiagnostic(value, config = getRedactionConfig()) {
  if (!config.enabled) return value;
  let remainingNodes = 5e4;
  const text5 = (input, keys = []) => {
    if (!keys.length) return redactSensitive(input, config).redacted;
    for (const key of keys) {
      const redacted = redactJsonStrings({ [key]: input }, config)[key];
      if (redacted !== input) return redacted;
    }
    return input;
  };
  const walk = (input, depth, keys = []) => {
    if (depth > 32 || --remainingNodes < 0) return BUDGET_MARKER;
    if (typeof input === "string") {
      if (input.length > MAX_DIAGNOSTIC_CHARS) return redactSensitive(input, config).redacted;
      try {
        const parsed = JSON.parse(input);
        if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string")) {
          const sanitized = walk(parsed, depth + 1, keys);
          const serialized = JSON.stringify(sanitized);
          if (serialized !== JSON.stringify(parsed)) return serialized;
        }
      } catch {
      }
      return text5(input, keys);
    }
    if (Array.isArray(input)) return input.length > remainingNodes ? BUDGET_MARKER : input.map((item) => walk(item, depth + 1, keys));
    if (input && typeof input === "object") {
      const entries = Object.entries(input);
      if (entries.length > remainingNodes) return BUDGET_MARKER;
      return Object.fromEntries(entries.map(([name, item]) => [text5(name, keys), walk(item, depth + 1, [name, ...keys])]));
    }
    return input;
  };
  return walk(value, 0);
}
var MAX_DIAGNOSTIC_CHARS, BUDGET_MARKER;
var init_diagnostic_redaction = __esm({
  "src/services/sync/diagnostic-redaction.ts"() {
    "use strict";
    init_redaction();
    MAX_DIAGNOSTIC_CHARS = 1024 * 1024;
    BUDGET_MARKER = "<redacted type='diagnostic_budget'/>";
  }
});

// src/shared/media-contract.ts
function object(value, keys, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MediaError(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new MediaError(code);
  const record = value;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new MediaError(code);
  return record;
}
function boundedString(value, pattern, max, code) {
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) throw new MediaError(code);
  return value;
}
function validateMediaManifest(value) {
  const record = object(value, ["version", "attachments", "overflow"], "invalid_manifest");
  if (record.version !== MEDIA_MANIFEST_VERSION || !Array.isArray(record.attachments)) throw new MediaError("invalid_manifest");
  if (record.attachments.length > MEDIA_LIMITS.maxObservationRefs) throw new MediaError("manifest_too_large");
  if (record.overflow !== void 0 && typeof record.overflow !== "boolean") throw new MediaError("invalid_manifest");
  const ids = /* @__PURE__ */ new Set();
  const attachments = Array.from(record.attachments, (value2) => {
    const ref = object(value2, ["id", "label", "inspection"], "invalid_manifest");
    const id = boundedString(ref.id, UUID_V4, 36, "invalid_manifest");
    const label = boundedString(ref.label, LABEL, MEDIA_LIMITS.maxLabelChars, "invalid_manifest");
    if (ids.has(id) || ref.inspection !== "inspected" && ref.inspection !== "uninspected") throw new MediaError("invalid_manifest");
    ids.add(id);
    return { id, label, inspection: ref.inspection };
  });
  const result = { version: MEDIA_MANIFEST_VERSION, attachments };
  if (record.overflow !== void 0) result.overflow = record.overflow;
  if (new TextEncoder().encode(JSON.stringify(result)).length > MEDIA_LIMITS.maxManifestBytes) throw new MediaError("manifest_too_large");
  return result;
}
var MEDIA_MANIFEST_VERSION, MEDIA_METADATA_NAMESPACE, MEDIA_LIMITS, MediaError, UUID_V4, LABEL;
var init_media_contract = __esm({
  "src/shared/media-contract.ts"() {
    "use strict";
    MEDIA_MANIFEST_VERSION = 1;
    MEDIA_METADATA_NAMESPACE = "cmem_media_v1";
    MEDIA_LIMITS = Object.freeze({
      // Abuse protection: caps one event at 4 stored images (about 13 MiB) and one
      // observer turn at 4 derivatives (maxGatewayImageBytes).
      maxImagesPerEvent: 4,
      // Provider maximum: Vercel Functions take request bodies up to 4.5 MB; this
      // plus maxUploadBodyBytes' multipart overhead (3.06 MiB, 3.2 MB) fits.
      maxSourceBytes: 3 * 1024 * 1024,
      // Same bound for the stored full-size copy: a lossless re-encode of an accepted
      // source must still fit, and a stored copy is served back in one Vercel
      // response, also limited to 4.5 MB.
      maxCanonicalBytes: 3 * 1024 * 1024,
      // Owner's rule, 2026-11-05/06: no stored copy is multiple megabytes, and every
      // copy is lossy WebP. Both converters fit each canonical they encode into this.
      // maxCanonicalBytes stays the bound for an accepted upload and for reading a
      // copy stored before this rule (lossless, up to 3 MiB). Measured 2026-11-06 at
      // quality 80: the largest of 29 real screenshots is 406 KiB, and a 2800x23880
      // full-page screenshot fitted to 8192 px is 528 KiB, so all keep full
      // resolution with about 2 times headroom.
      maxEncodedCanonicalBytes: 1024 * 1024,
      // Abuse protection (decompression bombs): a decode holds about 4 bytes per
      // pixel, so at most about 96 MB. A 6016x3384 display (20.4 million px) fits.
      maxPixels: 24e6,
      // Abuse protection: bounds long thin images that pass maxPixels. An 8K
      // display (7680 px wide) fits.
      maxDimension: 8192,
      // Abuse protection: one conversion holds a shared instance's CPU. The upload
      // route's 59 s maxDuration fits this plus two 20 s Storage writes.
      conversionTimeoutSeconds: 5,
      // Abuse protection: instances serve concurrent requests, so one decode of up
      // to about 96 MB runs at a time; others fail fast as conversion_busy and retry.
      maxConcurrentConversions: 1,
      // Abuse protection on what a model is sent: 4 of these make the 1 MiB
      // maxGatewayImageBytes.
      maxDerivativeBytes: 256 * 1024,
      // Provider maximum: Anthropic downscales images whose long edge is above
      // 1,568 px (standard tier, platform.claude.com/docs/en/build-with-claude/vision),
      // so pixels beyond that cost tokens and add nothing.
      maxDerivativeDimension: 1536,
      // One largest source as base64 (3 MiB x 4/3 = 4 MiB), so the local event JSON
      // stays under its existing 5 MB cap.
      maxInlineEncodedBytes: 4 * 1024 * 1024,
      // Abuse protection: metadata.cmem_media_v1 syncs to every device; 32 refs of
      // about 120 bytes each stay inside maxManifestBytes.
      maxObservationRefs: 32,
      // Abuse protection: labels are generated (event1_image1); 64 leaves room and
      // keeps a ref small.
      maxLabelChars: 64,
      // Abuse protection: bounds one manifest; 32 refs need about 4 KiB.
      maxManifestBytes: 8192,
      // Abuse protection: bounds the private provenance row; its largest part is
      // the 4096-character locator.
      maxProvenanceBytes: 8192,
      // Operating-system maximum: PATH_MAX is 4096 on Linux (1024 on macOS).
      maxSourceLocatorChars: 4096,
      // maxImagesPerEvent x maxDerivativeBytes: the most one observer turn can send.
      maxGatewayImageBytes: 4 * 256 * 1024,
      // maxSourceBytes plus 64 KiB for the manifest (8 KiB at most) and multipart
      // headers; still under Vercel's 4.5 MB request body maximum.
      maxUploadBodyBytes: 3 * 1024 * 1024 + 64 * 1024,
      // Abuse protection, sized so a paying user's images are not refused (owner,
      // 2026-11-05: "dont throw away images, on cloud they'll be PAYING me").
      // Measured 2026-11-05: the median converted pair (canonical plus derivative)
      // of 27 real screenshots is 321 KiB, so 100 screenshots a day is about
      // 11.2 GiB a year. Past the Pro plan's 100 GB, Supabase Storage costs $0.0213
      // per GB a month (supabase.com/docs/guides/platform/manage-your-usage/
      // storage-size, read 2026-11-05), so a full owner (26.8 GB) costs about $0.57
      // a month. Pro enforces it: uploads past it answer 413 quota_exceeded and the
      // image stays on the computer.
      ownerQuotaBytes: 25 * 1024 * 1024 * 1024
    });
    MediaError = class extends Error {
      constructor(code, message = code) {
        super(message);
        this.code = code;
        this.name = "MediaError";
      }
      code;
    };
    UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  }
});

// src/services/sync/CanonicalContent.ts
import { createHash as createHash3, randomUUID } from "crypto";
function jsonError(message) {
  const reason = redactSyncDiagnostic(message);
  logger.debug("CLOUD_SYNC", "Rejected invalid canonical content", { reason });
  throw new Error(`canonical content: ${reason}`);
}
function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value, /* @__PURE__ */ new Set()));
}
function normalizeJson(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) jsonError("numbers must be finite");
    if (!Number.isSafeInteger(value) && Number.isInteger(value)) {
      jsonError("integers must be safe; use decimal strings for uint64 values");
    }
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value !== "object") jsonError(`unsupported JSON value ${typeof value}`);
  if (seen.has(value)) jsonError("cycles are not allowed");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeJson(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      jsonError("objects must be plain objects");
    }
    const input = value;
    const output2 = {};
    for (const key of Object.keys(input).sort()) {
      const item = input[key];
      if (item === void 0) jsonError(`undefined is not allowed at ${key}`);
      output2[key] = normalizeJson(item, seen);
    }
    return output2;
  } finally {
    seen.delete(value);
  }
}
function sha256Base64Url(value) {
  return createHash3("sha256").update(value, "utf8").digest("base64url");
}
function assertCanonicalDecimal(value, options = {}) {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    return jsonError("decimal values must be unsigned base-10 strings without leading zeroes");
  }
  if (BigInt(value) > UINT64_MAX) jsonError("decimal value exceeds uint64");
  if (options.positive && value === "0") jsonError("decimal value must be positive");
  return value;
}
function compareCanonicalDecimals(left, right) {
  assertCanonicalDecimal(left);
  assertCanonicalDecimal(right);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
function incrementCanonicalDecimal(value) {
  const canonical = assertCanonicalDecimal(value);
  if (BigInt(canonical) === UINT64_MAX) jsonError("uint64 sequence overflow");
  return (BigInt(canonical) + 1n).toString(10);
}
var CANONICAL_DECIMAL, UINT64_MAX;
var init_CanonicalContent = __esm({
  "src/services/sync/CanonicalContent.ts"() {
    "use strict";
    init_logger();
    init_diagnostic_redaction();
    init_media_contract();
    CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
    UINT64_MAX = 18446744073709551615n;
  }
});

// src/services/work-view/shared-records.mjs
function sharedWriter(value) {
  text(value, 128, "writer");
  if (Buffer.byteLength(value, "utf8") > 128) fail("writer exceeds canonical byte limit");
  return value;
}
function sharedIdentity(kind, key) {
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(kind)) fail("invalid kind");
  text(key, 1024, "key");
  return sharedRecordKey(kind, key);
}
function createSharedEntry({ batchId, writer, kind, key, revision, base = null, value, deleted = false }) {
  sharedWriter(writer);
  text(batchId, 100, "batch");
  sharedIdentity(kind, key);
  assertCanonicalDecimal(revision, { positive: true });
  if (base !== null) hash(base);
  if (typeof deleted !== "boolean") fail("invalid deletion flag");
  const payload = canonicalJson(deleted ? null : value);
  if (bytes(payload) > SHARED_WORK_MAX_VALUE_BYTES) fail("value exceeds byte limit");
  return {
    version: 1,
    record: "entry",
    batch: batchId,
    writer,
    kind,
    key,
    revision,
    base,
    deleted,
    payload,
    hash: sharedValueHash(kind, key, deleted ? null : value, deleted)
  };
}
function createSharedBatch(entries, { batchId, writer }) {
  sharedWriter(writer);
  text(batchId, 100, "batch");
  if (!Array.isArray(entries) || !entries.length || entries.length > SHARED_WORK_MAX_UPDATES) fail("invalid batch size");
  const identities = /* @__PURE__ */ new Set();
  const groups = [[]];
  for (const entry of entries) {
    if (entry.batch !== batchId || entry.writer !== writer) fail("entry belongs to another batch");
    const identity = sharedIdentity(entry.kind, entry.key);
    if (identities.has(identity)) fail("duplicate logical object in batch");
    identities.add(identity);
    const ref = sharedEntryRef(entry);
    let group = groups.at(-1);
    if (bytes(canonicalJson([...group, ref])) > SHARED_WORK_MAX_MANIFEST_BYTES) {
      group = [];
      groups.push(group);
    }
    group.push(ref);
    if (bytes(canonicalJson(group)) > SHARED_WORK_MAX_MANIFEST_BYTES) fail("manifest reference exceeds byte limit");
  }
  if (groups.length > SHARED_WORK_MAX_PARTS) fail("too many manifest parts");
  const manifests = groups.map((refs, part) => {
    const payload2 = canonicalJson(refs);
    return { version: 1, record: "manifest", batch: batchId, writer, part, payload: payload2, hash: sha256Base64Url(payload2) };
  });
  const payload = canonicalJson(manifests.map((part) => part.hash));
  const commit = { version: 1, record: "commit", batch: batchId, writer, count: entries.length, payload, hash: sha256Base64Url(payload) };
  return [
    ...entries.map((fields) => ({ listName: `${SHARED_WORK_PREFIX}entry`, fields })),
    ...manifests.map((fields) => ({ listName: `${SHARED_WORK_PREFIX}manifest`, fields })),
    { listName: `${SHARED_WORK_PREFIX}commit`, fields: commit }
  ];
}
function parseSharedRow(row, localDeviceId2, { redactionReceipt = null } = {}) {
  if (!isSharedWorkList(row.list_name)) return null;
  if (!row.list_name.startsWith(SHARED_WORK_PREFIX)) return { unsupported: true };
  if (typeof row.fields === "string" && bytes(row.fields) > SHARED_WORK_MAX_ROW_BYTES) fail("row exceeds byte limit");
  const fields = typeof row.fields === "string" ? JSON.parse(row.fields) : row.fields;
  if (!fields || fields.version !== 1) return { unsupported: true };
  const writer = row.origin_device_id ?? localDeviceId2;
  sharedWriter(writer);
  if (fields.writer !== writer) fail("writer does not match origin");
  text(fields.batch, 100, "batch");
  hash(fields.hash);
  if (row.list_name !== `${SHARED_WORK_PREFIX}${fields.record}`) fail("record/list mismatch");
  if (fields.record === "entry") {
    exact(fields, ["version", "record", "batch", "writer", "kind", "key", "revision", "base", "deleted", "payload", "hash"]);
    sharedIdentity(fields.kind, fields.key);
    assertCanonicalDecimal(fields.revision, { positive: true });
    if (fields.base !== null) hash(fields.base);
    if (typeof fields.deleted !== "boolean" || typeof fields.payload !== "string" || bytes(fields.payload) > SHARED_WORK_MAX_VALUE_BYTES) fail("invalid entry payload");
    const value = JSON.parse(fields.payload);
    if (canonicalJson(value) !== fields.payload || fields.deleted && value !== null) fail("entry hash mismatch");
    const result = { ...fields, value };
    if (sharedValueHash(fields.kind, fields.key, value, fields.deleted) !== fields.hash) {
      const receipt = redactionReceipt;
      if (!receipt || String(row.id) !== String(receipt.row_id) || row.origin_device_id !== receipt.origin_device_id || String(row.origin_local_id) !== receipt.origin_local_id || String(row.sync_rev) !== receipt.sync_rev || sha256Base64Url(canonicalJson(fields)) !== receipt.stored_fields_hash) fail("entry hash mismatch");
      const ref = JSON.parse(receipt.original_ref_json);
      exact(ref, ["kind", "key", "revision", "hash", "entryHash"]);
      hash(ref.hash);
      hash(ref.entryHash);
      if (ref.kind !== fields.kind || ref.key !== fields.key || ref.revision !== fields.revision || ref.hash !== fields.hash) fail("redaction receipt does not match entry");
      Object.defineProperty(result, verifiedRedactionReference, { value: ref });
    }
    return result;
  }
  if (fields.record === "manifest") {
    exact(fields, ["version", "record", "batch", "writer", "part", "payload", "hash"]);
    if (!Number.isInteger(fields.part) || fields.part < 0 || fields.part >= SHARED_WORK_MAX_PARTS || typeof fields.payload !== "string" || bytes(fields.payload) > SHARED_WORK_MAX_MANIFEST_BYTES) fail("invalid manifest");
    const refs = JSON.parse(fields.payload);
    if (!Array.isArray(refs) || !refs.length || refs.length > SHARED_WORK_MAX_UPDATES || canonicalJson(refs) !== fields.payload) fail("invalid references");
    for (const ref of refs) {
      exact(ref, ["kind", "key", "revision", "hash", "entryHash"]);
      sharedIdentity(ref.kind, ref.key);
      assertCanonicalDecimal(ref.revision, { positive: true });
      hash(ref.hash);
      hash(ref.entryHash);
    }
    if (sha256Base64Url(fields.payload) !== fields.hash) fail("manifest hash mismatch");
    return { ...fields, refs };
  }
  if (fields.record === "commit") {
    exact(fields, ["version", "record", "batch", "writer", "count", "payload", "hash"]);
    if (!Number.isInteger(fields.count) || fields.count < 1 || fields.count > SHARED_WORK_MAX_UPDATES || typeof fields.payload !== "string" || bytes(fields.payload) > SHARED_WORK_MAX_MANIFEST_BYTES) fail("invalid commit");
    const parts = JSON.parse(fields.payload);
    if (!Array.isArray(parts) || !parts.length || parts.length > SHARED_WORK_MAX_PARTS || canonicalJson(parts) !== fields.payload) fail("invalid commit parts");
    parts.forEach(hash);
    if (sha256Base64Url(fields.payload) !== fields.hash) fail("commit hash mismatch");
    return { ...fields, parts };
  }
  fail("unknown record type");
}
var SHARED_WORK_PREFIX, SHARED_WORK_MAX_VALUE_BYTES, SHARED_WORK_MAX_MANIFEST_BYTES, SHARED_WORK_MAX_ROW_BYTES, SHARED_WORK_MAX_UPDATES, SHARED_WORK_MAX_PARTS, isSharedWorkList, sharedRecordKey, sharedValueHash, fail, text, hash, bytes, verifiedRedactionReference, exact, sharedEntryRef;
var init_shared_records = __esm({
  "src/services/work-view/shared-records.mjs"() {
    "use strict";
    init_CanonicalContent();
    SHARED_WORK_PREFIX = "__my_work_v1:";
    SHARED_WORK_MAX_VALUE_BYTES = 48e3;
    SHARED_WORK_MAX_MANIFEST_BYTES = 48e3;
    SHARED_WORK_MAX_ROW_BYTES = 128e3;
    SHARED_WORK_MAX_UPDATES = 512;
    SHARED_WORK_MAX_PARTS = 32;
    isSharedWorkList = (value) => typeof value === "string" && /^__my_work_v\d+:/.test(value);
    sharedRecordKey = (kind, key) => canonicalJson([kind, key]);
    sharedValueHash = (kind, key, value, deleted = false) => sha256Base64Url(canonicalJson({ kind, key, value: deleted ? null : value, deleted }));
    fail = (message) => {
      throw new TypeError(`Shared My Work: ${message}`);
    };
    text = (value, max, name) => {
      if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail(`invalid ${name}`);
      return value;
    };
    hash = (value) => {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail("invalid hash");
      return value;
    };
    bytes = (value) => Buffer.byteLength(value, "utf8");
    verifiedRedactionReference = /* @__PURE__ */ Symbol("verified-redaction-reference");
    exact = (value, keys) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail("invalid fields");
    };
    sharedEntryRef = (entry) => {
      if (entry[verifiedRedactionReference]) return entry[verifiedRedactionReference];
      const fields = Object.fromEntries(["version", "record", "batch", "writer", "kind", "key", "revision", "base", "deleted", "payload", "hash"].map((key) => [key, entry[key]]));
      return {
        kind: entry.kind,
        key: entry.key,
        revision: entry.revision,
        hash: entry.hash,
        entryHash: sha256Base64Url(canonicalJson(fields))
      };
    };
  }
});

// src/services/work-view/work-state-reduce.mjs
function reduceWorkState(entries, { currentProject, currentProjectScope = [], eventLimit = Infinity, localDeviceId: localDeviceId2 = "" } = {}) {
  entries = entries.filter((entry) => !isSharedWorkList(entry.list_name));
  const scope = new Set(currentProjectScope.map(normalizedKey));
  const listsById = /* @__PURE__ */ new Map();
  const events = [];
  let revision = 0;
  const device = (row) => row.origin_device_id ?? localDeviceId2;
  for (const row of [...entries].sort((a, b) => {
    const timeAndDevice = a.created_at_epoch - b.created_at_epoch || (device(a) < device(b) ? -1 : device(a) > device(b) ? 1 : 0);
    if (timeAndDevice) return timeAndDevice;
    const left = BigInt(a.origin_local_id ?? a.id), right = BigInt(b.origin_local_id ?? b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    revision = Math.max(revision, row.id);
    const fields = typeof row.fields === "string" ? JSON.parse(row.fields) : row.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Invalid work-state entry");
    const id = listId(row.scope_project ?? row.project, row.list_name);
    let list2 = listsById.get(id);
    if (!list2) {
      list2 = { id, project: row.scope_project ?? row.project, name: row.list_name, fields: {}, tasksByName: /* @__PURE__ */ new Map(), updatedAtEpoch: 0, stateUpdatedAtEpoch: null, latestEntryId: 0 };
      listsById.set(id, list2);
    }
    const taskName = fields.task == null || fields.task === "" ? null : String(fields.task);
    let target = list2;
    if (taskName !== null) {
      target = list2.tasksByName.get(taskName);
      if (!target) {
        target = { id: taskId(id, taskName), name: taskName, fields: {}, updatedAtEpoch: 0, latestEntryId: 0 };
        list2.tasksByName.set(taskName, target);
      }
    } else {
      list2.stateUpdatedAtEpoch = row.created_at_epoch;
    }
    const changes = [];
    for (const [key, value] of Object.entries(fields)) {
      const hadPrevious = Object.hasOwn(target.fields, key);
      const previous = target.fields[key];
      if (key !== "task" && (value === null && hadPrevious || value !== null && (!hadPrevious || previous !== value))) {
        changes.push({ field: key, ...hadPrevious ? { previous } : {}, value, hadPrevious });
      }
      if (value === null) delete target.fields[key];
      else target.fields[key] = value;
    }
    target.updatedAtEpoch = row.created_at_epoch;
    target.latestEntryId = row.id;
    list2.updatedAtEpoch = row.created_at_epoch;
    list2.latestEntryId = row.id;
    events.push({
      id: row.id,
      project: list2.project,
      originProject: row.project,
      listName: row.list_name,
      listId: id,
      task: taskName,
      taskId: taskName === null ? null : target.id,
      type: taskName === null ? "state" : "task",
      fields,
      changes,
      status: taskName === null ? target.fields.status == null ? "open" : String(target.fields.status).toLowerCase() : effectiveStatus(target.fields.status),
      at: iso(row.created_at_epoch),
      atEpoch: row.created_at_epoch,
      sourceOrder: [row.created_at_epoch, device(row), String(row.origin_local_id ?? row.id)],
      inCurrentScope: scope.has(normalizedKey(row.project))
    });
  }
  const lists = [...listsById.values()].sort((a, b) => b.latestEntryId - a.latestEntryId).map((list2) => {
    const tasks2 = [...list2.tasksByName.values()].map((task) => ({
      ...task,
      status: effectiveStatus(task.fields.status),
      isOpen: !isClosed(task.fields.status),
      updatedAt: iso(task.updatedAtEpoch)
    }));
    const stateIsOpen = Object.keys(list2.fields).some((key) => key !== "task") && !isClosed(list2.fields.status);
    const { tasksByName, ...record } = list2;
    return {
      ...record,
      status: isClosed(list2.fields.status) ? String(list2.fields.status).toLowerCase() : "open",
      isOpen: stateIsOpen || tasks2.some((task) => task.isOpen),
      inCurrentScope: scope.has(normalizedKey(list2.project)),
      updatedAt: iso(list2.updatedAtEpoch),
      stateUpdatedAt: iso(list2.stateUpdatedAtEpoch),
      tasks: tasks2
    };
  });
  const projectsById = /* @__PURE__ */ new Map();
  for (const list2 of lists) {
    const key = normalizedKey(list2.project);
    const project = projectsById.get(key) ?? { id: list2.project, name: list2.project, lists: 0, openLists: 0, tasks: 0, doing: 0, inCurrentScope: list2.inCurrentScope, lastUpdatedAt: list2.updatedAt };
    project.lists++;
    project.openLists += Number(list2.isOpen);
    project.tasks += list2.tasks.length;
    project.doing += list2.tasks.filter((task) => task.isOpen && task.status === "doing").length;
    projectsById.set(key, project);
  }
  const projects = [...projectsById.values()];
  const tasks = lists.flatMap((list2) => list2.tasks);
  const summary = {
    projects: projects.length,
    lists: lists.length,
    openLists: lists.filter((list2) => list2.isOpen).length,
    tasks: tasks.length,
    openTasks: tasks.filter((task) => task.isOpen).length,
    todo: tasks.filter((task) => task.status === "todo").length,
    doing: tasks.filter((task) => task.status === "doing").length,
    done: tasks.filter((task) => task.status === "done").length,
    dropped: tasks.filter((task) => task.status === "dropped").length,
    unknown: tasks.filter((task) => task.status === "unknown").length
  };
  return {
    schemaVersion: 1,
    revision,
    entryCount: entries.length,
    currentProject,
    currentProjectScope,
    summary,
    projects,
    lists,
    events: events.slice(-eventLimit).reverse(),
    lastUpdatedAt: events.length ? events.at(-1).at : null
  };
}
var CLOSED, normalizedKey, iso, isClosed, effectiveStatus, listId, taskId;
var init_work_state_reduce = __esm({
  "src/services/work-view/work-state-reduce.mjs"() {
    "use strict";
    init_shared_records();
    CLOSED = /* @__PURE__ */ new Set(["done", "dropped"]);
    normalizedKey = (value) => String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    iso = (epoch2) => epoch2 == null ? null : new Date(epoch2).toISOString();
    isClosed = (status) => status != null && CLOSED.has(String(status).toLowerCase());
    effectiveStatus = (status) => status == null || status === "" ? "unknown" : String(status).toLowerCase();
    listId = (project, name) => JSON.stringify([normalizedKey(project), name]);
    taskId = (parentId, name) => JSON.stringify([parentId, name]);
  }
});

// src/services/work-view/nav-words.mjs
var NAV_LABELS;
var init_nav_words = __esm({
  "src/services/work-view/nav-words.mjs"() {
    "use strict";
    NAV_LABELS = Object.freeze(["my focus", "my work", "my rules", "other", "suggested", "past focus", "monitor", "steer"]);
  }
});

// src/services/work-view/my-focus.mjs
function applyPatch(target, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (key === "task") continue;
    if (value === null) delete target[key];
    else target[key] = value;
  }
}
function buildFocusAreas(state, { localDeviceId: localDeviceId2 = null } = {}) {
  if (typeof state.entryCount === "number" && state.events.length !== state.entryCount) {
    throw new Error("My Focus needs every work-state row; the events were cut.");
  }
  const areas = /* @__PURE__ */ new Map(), placements = /* @__PURE__ */ new Map();
  let otherPassHash2 = null;
  for (const event of [...state.events].reverse()) {
    if (!isMyFocusList(event.listName)) continue;
    if (event.task === null) {
      if (localDeviceId2 !== null && event.sourceOrder?.[1] === localDeviceId2 && Object.hasOwn(event.fields, "other_pass_hash")) otherPassHash2 = text2(event.fields.other_pass_hash) || null;
      continue;
    }
    if (event.task.startsWith(FOCUS_AREA_TASK_PREFIX)) {
      const focusAreaId = text2(event.fields.focus_area_id) || event.task.slice(FOCUS_AREA_TASK_PREFIX.length);
      if (focusAreaId === OTHER_FOCUS_AREA_ID) throw new Error(`A my-focus area row uses the reserved id "${OTHER_FOCUS_AREA_ID}".`);
      const decidedBy = event.fields.decided_by;
      if (!FOCUS_AREA_DECIDED_BY.includes(decidedBy)) throw new Error(`Focus area ${focusAreaId} has an unknown writer: ${decidedBy}`);
      const area = areas.get(focusAreaId) ?? { fields: {}, ownerDecided: false, savedAt: null };
      if (area.ownerDecided && decidedBy === "system") continue;
      applyPatch(area.fields, event.fields);
      if (decidedBy !== "system") area.ownerDecided = decidedBy === "owner";
      area.savedAt = event.at;
      areas.set(focusAreaId, area);
    } else if (event.task.startsWith(PLACEMENT_TASK_PREFIX)) {
      const anchor = text2(event.fields.anchor_conversation_key) || event.task.slice(PLACEMENT_TASK_PREFIX.length);
      const placedBy = event.fields.placed_by;
      if (!PLACEMENT_PLACED_BY.includes(placedBy)) throw new Error(`A placement has an unknown writer: ${placedBy}`);
      const placement = placements.get(anchor) ?? { owner: null, router: null };
      placement[placedBy] ??= { fields: {}, device: null };
      applyPatch(placement[placedBy].fields, event.fields);
      placement[placedBy].device = event.sourceOrder?.[1] ?? null;
      placements.set(anchor, placement);
    }
  }
  const focusAreas = [...areas].map(([focusAreaId, { fields, savedAt }]) => {
    if (!text2(fields.name)) throw new Error(`Focus area ${focusAreaId} has no name.`);
    if (!FOCUS_AREA_STATUSES.includes(fields.status)) throw new Error(`Focus area ${focusAreaId} has an unknown status: ${fields.status}`);
    if (!FOCUS_AREA_SOURCES.includes(fields.source)) throw new Error(`Focus area ${focusAreaId} has an unknown source: ${fields.source}`);
    return {
      focusAreaId,
      name: text2(fields.name),
      goal: text2(fields.goal) || null,
      about: text2(fields.about) || null,
      status: fields.status,
      priorityRank: rank(fields.priority_rank),
      ownerRank: rank(fields.owner_rank),
      source: fields.source,
      mergedInto: text2(fields.merged_into) || null,
      evidence: text2(fields.evidence) || null,
      decidedBy: fields.decided_by,
      savedAt
    };
  }).sort((a, b) => (a.ownerRank ?? Infinity) - (b.ownerRank ?? Infinity) || (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity) || a.name.localeCompare(b.name));
  const byId = new Map(focusAreas.map((area) => [area.focusAreaId, area]));
  const resolve4 = (focusAreaId) => {
    if (focusAreaId === OTHER_FOCUS_AREA_ID) return OTHER_FOCUS_AREA_ID;
    const seen = /* @__PURE__ */ new Set();
    let area = byId.get(focusAreaId);
    while (area?.mergedInto && byId.has(area.mergedInto) && !seen.has(area.mergedInto)) {
      seen.add(area.focusAreaId);
      area = byId.get(area.mergedInto);
    }
    return area && !area.mergedInto && area.status !== "dismissed" ? area.focusAreaId : null;
  };
  const focusAreaIdByAnchor = /* @__PURE__ */ new Map();
  const placementsByAnchor = /* @__PURE__ */ new Map();
  const side = (written) => written && { focusAreaId: text2(written.fields.focus_area_id), basis: text2(written.fields.basis) || null, evidence: text2(written.fields.evidence) || null, device: written.device };
  for (const [anchor, { owner, router }] of placements) {
    const focusAreaId = owner && resolve4(text2(owner.fields.focus_area_id)) || router && resolve4(text2(router.fields.focus_area_id));
    if (focusAreaId) focusAreaIdByAnchor.set(anchor, focusAreaId);
    placementsByAnchor.set(anchor, { owner: side(owner), router: side(router) });
  }
  return { focusAreas, focusAreaIdByAnchor, placementsByAnchor, resolveFocusAreaId: resolve4, otherPassHash: otherPassHash2 };
}
function readFocus(database, { localDeviceId: localDeviceId2 } = {}) {
  if (typeof localDeviceId2 !== "string") throw new TypeError(`readFocus needs the worker's sync device id ("" when cloud sync never started).`);
  const rows = database.prepare("SELECT * FROM work_state_entries WHERE list_name = ?").all(MY_FOCUS_LIST);
  return buildFocusAreas(reduceWorkState(rows, { localDeviceId: localDeviceId2 }), { localDeviceId: localDeviceId2 });
}
function anchorConversationKeyFor(request, ledger) {
  const anchor = (request.groupId ? ledger?.groups?.groups?.[request.groupId]?.anchor : null) || request.conversationKey;
  return typeof anchor === "string" && anchor ? anchor : null;
}
function placeRequests(humanRequests, focusAreaIdByAnchor, ledger) {
  return humanRequests.map((request) => {
    const anchorConversationKey = anchorConversationKeyFor(request, ledger);
    const focusAreaId = anchorConversationKey ? focusAreaIdByAnchor.get(anchorConversationKey) : void 0;
    return { ...request, anchorConversationKey, ...focusAreaId ? { focusAreaId } : {} };
  });
}
var MY_FOCUS_LIST, OTHER_FOCUS_AREA_ID, FOCUS_AREA_TASK_PREFIX, PLACEMENT_TASK_PREFIX, FOCUS_AREA_STATUSES, FOCUS_AREA_SOURCES, PROPOSAL_SOURCES, PROPOSAL_KINDS, FOCUS_AREA_DECIDED_BY, PLACEMENT_PLACED_BY, isMyFocusList, text2, rank, isPlaceableArea, isOwnerDismissedArea;
var init_my_focus = __esm({
  "src/services/work-view/my-focus.mjs"() {
    "use strict";
    init_work_state_limits();
    init_work_state_reduce();
    init_nav_words();
    MY_FOCUS_LIST = "my-focus";
    OTHER_FOCUS_AREA_ID = "other";
    FOCUS_AREA_TASK_PREFIX = "Focus area: ";
    PLACEMENT_TASK_PREFIX = "Placement: ";
    FOCUS_AREA_STATUSES = ["suggested", "kept", "dismissed", "done"];
    FOCUS_AREA_SOURCES = ["owner-goals", "clustering", "promotion", "seed", "owner"];
    PROPOSAL_SOURCES = Object.freeze({ new: "clustering", promote: "promotion" });
    PROPOSAL_KINDS = Object.freeze(Object.keys(PROPOSAL_SOURCES));
    FOCUS_AREA_DECIDED_BY = ["owner", "system", "owner-restore"];
    PLACEMENT_PLACED_BY = ["router", "owner"];
    isMyFocusList = (name) => name === MY_FOCUS_LIST;
    text2 = (value) => typeof value === "string" ? value.trim() : "";
    rank = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
    isPlaceableArea = (area) => (area.status === "kept" || area.status === "suggested") && !area.mergedInto;
    isOwnerDismissedArea = (area) => area.status === "dismissed" && area.decidedBy === "owner";
  }
});

// src/services/work-view/shared-file-hooks.mjs
import path3 from "node:path";
function registerSharedFileWriter(directory, beforeWrite) {
  const root = path3.resolve(directory);
  if (writers.has(root)) throw new Error("Shared My Work writer already registered");
  writers.set(root, beforeWrite);
  return () => {
    if (writers.get(root) === beforeWrite) writers.delete(root);
  };
}
function ledgerRelativeName(root, filePath, paths2 = path3) {
  const name = paths2.relative(root, paths2.resolve(filePath));
  if (!name || name === ".." || name.startsWith(`..${paths2.sep}`) || paths2.isAbsolute(name)) return null;
  return name.split(paths2.sep).join("/");
}
function beforeSharedFileWrite(filePath, value) {
  for (const [root, writer] of writers) {
    const name = ledgerRelativeName(root, filePath);
    if (name) return writer(name, value);
  }
  return null;
}
var writers;
var init_shared_file_hooks = __esm({
  "src/services/work-view/shared-file-hooks.mjs"() {
    "use strict";
    writers = /* @__PURE__ */ new Map();
  }
});

// src/shared/gemini-error-details.ts
var init_gemini_error_details = __esm({
  "src/shared/gemini-error-details.ts"() {
    "use strict";
  }
});

// src/shared/api-key-pool.ts
function parseApiKeyList(raw) {
  const parts = Array.isArray(raw) ? raw.flatMap((entry) => typeof entry === "string" ? splitKeyString(entry) : []) : typeof raw === "string" ? splitKeyString(raw) : [];
  const seen = /* @__PURE__ */ new Set();
  const keys = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    keys.push(part);
    if (keys.length >= MAX_POOL_KEYS) break;
  }
  return keys;
}
function splitKeyString(raw) {
  return raw.split(/[\s,;]+/).map((part) => part.trim()).filter((part) => part.length > 0);
}
function buildKeyPool(primary, listRaw) {
  const listed = parseApiKeyList(listRaw);
  const primaryTrimmed = primary.trim();
  if (!primaryTrimmed) return listed;
  return parseApiKeyList([primaryTrimmed, ...listed]);
}
var MAX_POOL_KEYS, KEY_COOLDOWN_MS, RATE_LIMIT_COOLDOWN_MAX_MS, ROTATE_KINDS, KEY_ROTATE_KINDS;
var init_api_key_pool = __esm({
  "src/shared/api-key-pool.ts"() {
    "use strict";
    init_paths();
    init_logger();
    init_gemini_error_details();
    MAX_POOL_KEYS = 32;
    KEY_COOLDOWN_MS = {
      rate_limit: 6e4,
      quota_exhausted: 30 * 6e4,
      auth_invalid: 6 * 60 * 6e4
    };
    RATE_LIMIT_COOLDOWN_MAX_MS = 15 * 6e4;
    ROTATE_KINDS = /* @__PURE__ */ new Set(["rate_limit", "quota_exhausted", "auth_invalid"]);
    KEY_ROTATE_KINDS = [...ROTATE_KINDS];
  }
});

// src/supervisor/env-sanitizer.ts
var ENV_PROXY_VARS, ENV_PRESERVE;
var init_env_sanitizer = __esm({
  "src/supervisor/env-sanitizer.ts"() {
    "use strict";
    ENV_PROXY_VARS = /* @__PURE__ */ new Set([
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "npm_config_proxy",
      "npm_config_https_proxy",
      "npm_config_noproxy",
      // Node's fetch ignores HTTP(S)_PROXY until this is set (NODE_USE_ENV_PROXY=1).
      // Claude Code applies it from user settings; the observer child does not
      // load those settings, so the flag has to travel with the other proxy vars
      // (#5400). The lowercase spelling matches the http_proxy family.
      "NODE_USE_ENV_PROXY",
      "node_use_env_proxy"
    ]);
    ENV_PRESERVE = /* @__PURE__ */ new Set([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_GIT_BASH_PATH",
      // The CLI documents CLAUDE_CODE_TMPDIR as the fix for a root-owned per-uid
      // /tmp/claude-<uid> directory (#4161). Stripping it here sent the SDK child
      // back to /tmp, so the child hit that directory and exited 1 on every spawn
      // — the user's only documented escape did nothing.
      "CLAUDE_CODE_TMPDIR",
      // Documented Claude Code gateway compatibility switch. The Observer must
      // inherit an explicit beta opt-out because settingSources: [] prevents the
      // SDK child from recovering it from user settings. Keep this as a single
      // named exception: arbitrary CLAUDE_CODE_* host settings remain stripped.
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
      // claude-mem's own setting, not a CLI knob (the CLI never reads it): the
      // path to the claude binary, documented as settable from the file OR the
      // env. Every daemon spawn passes through sanitizeEnv, and the worker reads
      // the env override (SettingsDefaultsManager.applyEnvOverrides), so
      // stripping it silently dropped the env form.
      "CLAUDE_CODE_PATH",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
      "CLAUDE_CODE_SKIP_VERTEX_AUTH",
      "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "AWS_REGION",
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "GOOGLE_APPLICATION_CREDENTIALS",
      ...ENV_PROXY_VARS
    ]);
  }
});

// src/shared/oauth-token.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync;
var init_oauth_token = __esm({
  "src/shared/oauth-token.ts"() {
    "use strict";
    init_paths();
    init_SettingsDefaultsManager();
    init_logger();
    execFileAsync = promisify(execFile);
  }
});

// src/shared/EnvManager.ts
import { existsSync as existsSync12, readFileSync as readFileSync9, writeFileSync as writeFileSync2, mkdirSync as mkdirSync4, chmodSync } from "fs";
import { parseEnv as parseEnv2 } from "util";
function envFilePath() {
  return process.env.CLAUDE_MEM_ENV_FILE ?? paths.envFile();
}
function parseEnvFile(content) {
  return parseEnv2(stripUtf8Bom(content));
}
function loadClaudeMemEnv() {
  const envFile = envFilePath();
  if (!existsSync12(envFile)) {
    return {};
  }
  try {
    const content = readFileSync9(envFile, "utf-8");
    const parsed = parseEnvFile(content);
    const result = {};
    for (const key of CREDENTIAL_KEYS) {
      if (parsed[key]) result[key] = parsed[key];
    }
    return result;
  } catch (error) {
    logger.warn("ENV", "Failed to load .env file", { path: envFile }, error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}
function getCredential(key) {
  const env = loadClaudeMemEnv();
  return env[key];
}
var CREDENTIAL_KEYS;
var init_EnvManager = __esm({
  "src/shared/EnvManager.ts"() {
    "use strict";
    init_env_sanitizer();
    init_logger();
    init_paths();
    init_atomic_json();
    init_SettingsDefaultsManager();
    init_oauth_token();
    CREDENTIAL_KEYS = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_FALLBACK_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "GEMINI_API_KEY",
      "GEMINI_API_KEYS",
      "OPENROUTER_API_KEY",
      "OPENROUTER_API_KEYS",
      "OPENAI_COMPAT_API_KEY",
      "OPENAI_COMPAT_API_KEYS",
      "CLAUDE_CODE_OAUTH_TOKEN"
    ];
  }
});

// src/shared/pro-promo.ts
var PRO_TRIAL_MAX_DAYS, PRO_TRIAL_LABEL, PLAN_USAGE_GAIN_PERCENT, PRO_TRIAL_PITCH;
var init_pro_promo = __esm({
  "src/shared/pro-promo.ts"() {
    "use strict";
    PRO_TRIAL_MAX_DAYS = 30;
    PRO_TRIAL_LABEL = `${PRO_TRIAL_MAX_DAYS} Day Free Trial`;
    PLAN_USAGE_GAIN_PERCENT = 100;
    PRO_TRIAL_PITCH = `${PRO_TRIAL_LABEL} \u2014 memory runs off-plan. Get up to ${PLAN_USAGE_GAIN_PERCENT}% more usage from your plan`;
  }
});

// src/shared/relayed-text.ts
var init_relayed_text = __esm({
  "src/shared/relayed-text.ts"() {
    "use strict";
  }
});

// src/shared/cmem-gateway.ts
function cmemProOrigin() {
  return (process.env.CMEM_PRO_ORIGIN?.trim() || "https://cmem.ai").replace(/\/+$/, "");
}
function isCmemGatewayUrl(url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return false;
  try {
    const gateway = new URL(cmemProOrigin());
    const candidate = new URL(trimmed);
    if (gateway.protocol !== "http:" && gateway.protocol !== "https:" || candidate.origin !== gateway.origin) {
      return false;
    }
    const gatewayPath = gateway.pathname.replace(/\/+$/, "");
    return gatewayPath === "" || candidate.pathname === gatewayPath || candidate.pathname.startsWith(`${gatewayPath}/`);
  } catch {
    return false;
  }
}
function isCmemMemoryKey(apiKey) {
  return (apiKey ?? "").trim().startsWith("cm_pro_");
}
function isKeyAllowedForEndpoint(apiUrl, apiKey) {
  return isCmemGatewayUrl(apiUrl) === isCmemMemoryKey(apiKey);
}
var init_cmem_gateway = __esm({
  "src/shared/cmem-gateway.ts"() {
    "use strict";
    init_paths();
    init_SettingsDefaultsManager();
    init_settings_document();
    init_hook_io();
    init_pro_promo();
    init_relayed_text();
  }
});

// src/services/work-view/request-judge.mjs
var request_judge_exports = {};
__export(request_judge_exports, {
  JEV_MODEL: () => JEV_MODEL,
  JOIN_THRESHOLD: () => JOIN_THRESHOLD,
  MAX_CANDIDATE_REQUESTS: () => MAX_CANDIDATE_REQUESTS,
  MAX_DECISION_BODY_BYTES: () => MAX_DECISION_BODY_BYTES,
  OPENROUTER_DECISIONS_URL: () => OPENROUTER_DECISIONS_URL,
  SUGGEST_THRESHOLD: () => SUGGEST_THRESHOLD,
  answerOf: () => answerOf,
  bandFor: () => bandFor,
  configuredJudge: () => configuredJudge,
  contextReader: () => contextReader,
  decideSuggestion: () => decideSuggestion,
  jevClient: () => jevClient,
  jevClientFromSettings: () => jevClientFromSettings,
  jevJudge: () => jevJudge,
  judgeConversation: () => judgeConversation,
  routeUndecided: () => routeUndecided,
  rulesJudge: () => rulesJudge
});
import { join as join9 } from "node:path";
function bandFor(confidence) {
  if (!Number.isFinite(confidence)) throw new TypeError(`A judge's confidence must be a number, got ${confidence}.`);
  return confidence >= JOIN_THRESHOLD ? "join" : confidence >= SUGGEST_THRESHOLD ? "suggest" : "new";
}
function contextReader(database) {
  const sessions = database.prepare("SELECT id, memory_session_id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ? ORDER BY id");
  const cache = /* @__PURE__ */ new Map();
  return (conversationKey2, { project = null, startedAt = null } = {}) => {
    if (cache.has(conversationKey2)) return cache.get(conversationKey2);
    const [, platform, sessionId] = JSON.parse(conversationKey2);
    const rows = sessions.all(platform, sessionId);
    const ids = rows.map((row) => row.id);
    const memories = [...new Set(rows.map((row) => row.memory_session_id).filter(Boolean))];
    const marks = (values2) => values2.map(() => "?").join(",");
    const prompts = ids.length ? database.prepare(`SELECT prompt_text FROM user_prompts WHERE session_db_id IN (${marks(ids)}) ORDER BY session_db_id, prompt_number, id LIMIT ${CONTEXT_PROMPTS}`).all(...ids) : [];
    const recorded = memories.length ? database.prepare(`SELECT title FROM observations WHERE memory_session_id IN (${marks(memories)}) AND title IS NOT NULL ORDER BY created_at_epoch, id LIMIT ${CONTEXT_RECORDED_TITLES}`).all(...memories) : [];
    const context = {
      worktree: typeof project === "string" ? project : null,
      started: typeof startedAt === "string" ? startedAt.slice(0, 16) : null,
      asks: prompts.map((row) => clean(row.prompt_text).slice(0, CONTEXT_PROMPT_CHARS)).filter(Boolean),
      agent_recorded: recorded.map((row) => clean(row.title).slice(0, CONTEXT_TITLE_CHARS))
    };
    cache.set(conversationKey2, context);
    return context;
  };
}
function answerOf(result, id, type) {
  const answer = result?.answers?.[id];
  if (!answer || answer.type !== type) throw new Error(`Jev answered without a ${type} answer for "${id}".`);
  return answer;
}
function jevJudge(client) {
  return {
    name: "jev",
    async judge(conversation2, openRequests) {
      if (!openRequests.length) return { requestId: null, confidence: 1, evidence: "Judge jev: no open request in this project root to continue." };
      const candidates = openRequests.slice(0, MAX_CANDIDATE_REQUESTS);
      const considered = candidates.length === openRequests.length ? `${openRequests.length} open request${openRequests.length === 1 ? "" : "s"}` : `the ${candidates.length} most recently active of ${openRequests.length} open requests`;
      const picked = await client.decide(
        { conversation: conversation2.context, requests: Object.fromEntries(candidates.map((request2) => [request2.groupId, request2.context])) },
        { pick: { type: "choice", instructions: PICK_INSTRUCTIONS, criteria: { ...Object.fromEntries(candidates.map((request2) => [request2.groupId, `\`requests.${request2.groupId}\`: ${request2.title}`])), none: "None of these: a separate ask of its own" } } }
      );
      const pick2 = answerOf(picked, "pick", "choice");
      const model = typeof picked.model === "string" && picked.model ? picked.model : client.model;
      const probability = (choice) => {
        const value = pick2.probabilities?.[choice];
        if (!Number.isFinite(value)) throw new Error(`Jev gave no probability for "${choice}".`);
        return value;
      };
      if (pick2.choice === "none") return { requestId: null, confidence: probability("none"), evidence: `Judge jev (${model}): none of ${considered} is continued (p ${probability("none").toFixed(2)}).` };
      const request = candidates.find((candidate) => candidate.groupId === pick2.choice);
      if (!request) throw new Error(`Jev picked "${pick2.choice}", which was not offered.`);
      const checked = await client.decide({ request: request.context, conversation: conversation2.context }, { same: { type: "noul", instructions: CHECK_INSTRUCTIONS, criteria: CHECK_CRITERIA } });
      const score = answerOf(checked, "same", "noul").noul;
      if (!Number.isFinite(score)) throw new Error("Jev's check gave no score.");
      return { requestId: request.groupId, confidence: score, evidence: `Judge jev (${model}): picked "${request.title}" over ${considered} (p ${probability(pick2.choice).toFixed(2)}); the check "continues that request" scored ${score.toFixed(2)}.` };
    }
  };
}
function jevClient({ url, apiKey, model = null, fetchImpl = fetch }) {
  if (typeof url !== "string" || !url || typeof apiKey !== "string" || !apiKey) throw new TypeError("A Jev client needs a url and an apiKey.");
  return {
    name: "jev",
    url,
    model: model ?? JEV_MODEL,
    async decide(state, questions) {
      const body = JSON.stringify(model ? { model, state, questions } : { state, questions });
      const bytes2 = Buffer.byteLength(body, "utf8");
      if (bytes2 > MAX_DECISION_BODY_BYTES) throw new Error(`Jev request is ${bytes2} bytes; the decisions gateway takes at most ${MAX_DECISION_BODY_BYTES}. It is not trimmed: this conversation goes to the grouping agent instead.`);
      let response;
      try {
        response = await fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(DECISION_TIMEOUT_MS) });
      } catch (error) {
        throw new Error(`Jev request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const text5 = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text5);
      } catch {
      }
      if (!response.ok) {
        const failure = parsed?.error && typeof parsed.error === "object" ? parsed.error : {};
        throw new Error(`Jev answered ${response.status}${failure.code ? ` ${failure.code}` : ""}: ${failure.message ?? text5.slice(0, 200) ?? "no body"}${failure.request_id ? ` (request ${failure.request_id})` : ""}`);
      }
      if (!parsed?.answers || typeof parsed.answers !== "object") throw new Error("Jev answered without answers.");
      return parsed;
    }
  };
}
function jevClientFromSettings(settings2, { credential = (name) => getCredential(name), fetchImpl } = {}) {
  if (settings2?.CLAUDE_MEM_PROVIDER !== "openrouter") return null;
  const apiKey = String(settings2.CLAUDE_MEM_OPENROUTER_API_KEY ?? "").trim() || credential("OPENROUTER_API_KEY") || "";
  const base = String(settings2.CLAUDE_MEM_OPENROUTER_BASE_URL ?? "").trim();
  if (isCmemGatewayUrl(base)) {
    const url = `${base.replace(/\/+$/, "")}/decisions`;
    return apiKey && isKeyAllowedForEndpoint(url, apiKey) ? jevClient({ url, apiKey, fetchImpl }) : null;
  }
  if (!isOpenRouterApiUrl(resolveOpenRouterChatCompletionsUrl(base))) return null;
  const pool = buildKeyPool(apiKey, settings2.CLAUDE_MEM_OPENROUTER_API_KEYS || credential("OPENROUTER_API_KEYS") || "");
  const key = pool.find((candidate) => isKeyAllowedForEndpoint(OPENROUTER_DECISIONS_URL, candidate));
  return key ? jevClient({ url: OPENROUTER_DECISIONS_URL, apiKey: key, model: JEV_MODEL, fetchImpl }) : null;
}
function configuredJudge(settingsPath = USER_SETTINGS_PATH) {
  const client = jevClientFromSettings(SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }));
  return client ? jevJudge(client) : null;
}
async function judgeConversation(conversation2, openRequests, judge) {
  const pick2 = await judge.judge(conversation2, openRequests);
  if (!pick2) return null;
  if (pick2.requestId != null && !openRequests.some((request) => request.groupId === pick2.requestId)) throw new Error(`Judge ${judge.name} picked ${pick2.requestId}, which is not an open request.`);
  const band = pick2.requestId == null ? "new" : bandFor(pick2.confidence);
  return {
    requestId: band === "new" ? null : pick2.requestId,
    confidence: pick2.confidence,
    evidence: pick2.evidence,
    judge: judge.name,
    band,
    ...band === "new" && pick2.requestId != null ? { rejected: pick2.requestId } : {}
  };
}
function ownTitle(openingAsk) {
  return humanRequestTitle(openingAsk) || requestText(openingAsk, 120) || "Untitled request";
}
async function routeUndecided({ dir = LEDGER_DIR, database, judge = null, now = Date.now(), days = 14, apply = false }) {
  const judges = [rulesJudge, ...judge ? [judge] : []];
  const ledger = readLedger(dir);
  const sinceEpoch = now - days * DAY_MS;
  const context = contextReader(database);
  const skip = /* @__PURE__ */ new Set();
  const routed = [], unplaced = [];
  let working = ledger.groups;
  const persist = () => {
    if (apply) writeJsonAtomic(join9(dir, "request-groups.json"), working);
  };
  for (; ; ) {
    const input = groupingInput({ ...ledger, groups: working }, database, { sinceEpoch, limit: Infinity, skip });
    if (!input.conversations.length) break;
    const { root } = input;
    const anchors = new Map(readCandidates(database, { conversationKeys: input.openRequests.map((request) => request.anchor), excludedPromptIds: ledger.agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate]));
    let openRequests = input.openRequests.map((request) => ({
      groupId: request.groupId,
      title: request.title,
      anchor: request.anchor,
      context: { title: request.title, ...context(request.anchor, { project: anchors.get(request.anchor)?.project ?? null, startedAt: anchors.get(request.anchor)?.startedAt ?? null }) }
    }));
    for (const conversation2 of input.conversations) {
      const key = conversation2.conversationKey;
      const judged = {
        conversationKey: key,
        openingAsk: conversation2.openingAsk,
        context: context(key, { project: conversation2.project, startedAt: conversation2.startedAt }),
        // The code links naming this conversation, with the requests their other members are in now.
        links: input.proposedLinks.filter((link) => link.conversations.includes(key)).map((link) => ({ ...link, groups: [...new Set(link.conversations.map((other) => working.conversations[other]).filter(Boolean))] }))
      };
      let verdict = null, failure = null;
      for (const candidate of judges) {
        try {
          verdict = await judgeConversation(judged, openRequests, candidate);
        } catch (error) {
          failure = `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
        if (verdict) break;
      }
      if (!verdict) {
        unplaced.push({ conversationKey: key, root, openingAsk: conversation2.openingAsk, reason: failure ?? (judge ? "no code link and no verdict" : "no code link, and no Jev judge is configured: the grouping agent decides") });
        skip.add(key);
        continue;
      }
      if (apply) {
        working = readLedger(dir).groups;
        if (working.conversations[key] || working.ignored?.[key]) {
          skip.add(key);
          continue;
        }
      }
      const live = (request) => {
        const id = request && working.conversations[request.anchor];
        const group = id && working.groups[id];
        return group ? { ...request, groupId: id, anchor: group.anchor, title: group.title } : null;
      };
      const picked = verdict.requestId ? openRequests.find((request) => request.groupId === verdict.requestId) : null;
      const target = verdict.band === "join" ? live(picked) : null;
      if (verdict.band === "join" && !target) {
        unplaced.push({ conversationKey: key, root, openingAsk: conversation2.openingAsk, reason: `the picked request ${verdict.requestId} left the ledger while the judge was asked` });
        skip.add(key);
        continue;
      }
      const title = ownTitle(conversation2.openingAsk);
      const decisions = target ? { groups: [{ title: target.title, conversations: [target.anchor, key], links: [{ kind: "judge", conversations: [target.anchor, key], evidence: verdict.evidence }], ...typeof root === "string" && root ? { projectRoot: root } : {} }] } : { groups: [{ title, conversations: [key] }] };
      working = applyDecisions(working, decisions, { database, now, excludedPromptIds: ledger.agentWrittenPromptIds });
      const suggested = verdict.band === "suggest" ? live(picked) : null;
      if (suggested) working.suggestions = { ...working.suggestions ?? {}, [key]: { requestId: suggested.groupId, confidence: verdict.confidence, evidence: verdict.evidence, judge: verdict.judge, at: iso2(now), status: "open" } };
      persist();
      if (!target) openRequests = [{ groupId: groupIdFor(key), title, anchor: key, context: { title, ...judged.context } }, ...openRequests];
      routed.push({
        conversationKey: key,
        root,
        openingAsk: conversation2.openingAsk,
        band: verdict.band,
        judge: verdict.judge,
        confidence: verdict.confidence,
        evidence: verdict.evidence,
        requestId: target ? target.groupId : groupIdFor(key),
        requestTitle: target ? target.title : title,
        ...suggested ? { suggestedRequestId: suggested.groupId, suggestedRequestTitle: suggested.title } : {}
      });
    }
  }
  const count2 = (band) => routed.filter((entry) => entry.band === band).length;
  return { days, judges: judges.map((entry) => entry.name), applied: apply, counts: { joined: count2("join"), suggested: count2("suggest"), new: count2("new"), unplaced: unplaced.length }, routed, unplaced };
}
function decideSuggestion({ dir, database, conversationKey: conversationKey2, action, now = Date.now(), writeGroups, ledger: suppliedLedger, resolution }) {
  if (!["join", "not-this"].includes(action)) throw new TypeError(`action must be join or not-this, got ${action}.`);
  const ledger = suppliedLedger ?? readLedger(dir);
  const groups = ledger.groups;
  const suggestion = resolution?.suggestion ?? groups.suggestions?.[conversationKey2];
  if (!suggestion || !resolution && suggestion.status !== "open") return null;
  if (resolution) {
    groups.suggestions ??= {};
    groups.suggestions[conversationKey2] = { ...suggestion, status: "open" };
    if (action === "not-this" && groups.conversations[conversationKey2] === suggestion.requestId) delete groups.conversations[conversationKey2];
  }
  const request = groups.groups[suggestion.requestId];
  let next;
  if (action === "join") {
    if (!request) return null;
    const ownId = groups.conversations[conversationKey2];
    const brought = ownId && groups.groups[ownId]?.anchor === conversationKey2 ? Object.entries(groups.conversations).filter(([key, id]) => id === ownId && key !== conversationKey2).map(([key]) => key) : [];
    const moving = /* @__PURE__ */ new Set([conversationKey2, ...brought]);
    const broughtLinks = brought.length ? (groups.groups[ownId].links ?? []).filter((link) => link.conversations.every((key) => moving.has(key))) : [];
    next = applyDecisions(groups, { groups: [{
      title: request.title,
      conversations: [request.anchor, conversationKey2, ...brought],
      links: [{ kind: "judge", conversations: [request.anchor, conversationKey2], evidence: `Owner joined on the judge's suggestion. ${suggestion.evidence}` }, ...broughtLinks],
      ...typeof request.projectRoot === "string" && request.projectRoot ? { projectRoot: request.projectRoot } : {}
    }] }, { database, now, excludedPromptIds: ledger.agentWrittenPromptIds, enrichGroupIds: resolution?.groupKeys ?? null });
    next.suggestions[conversationKey2] = { ...suggestion, status: "joined", resolvedAt: iso2(now) };
    if (ownId && !next.groups[ownId]) for (const [other, entry] of Object.entries(next.suggestions)) {
      if (entry.status === "open" && entry.requestId === ownId) next.suggestions[other] = { ...entry, requestId: suggestion.requestId };
    }
  } else {
    if (groups.conversations[conversationKey2]) next = structuredClone(groups);
    else {
      const [candidate] = readCandidates(database, { conversationKeys: [conversationKey2], excludedPromptIds: ledger.agentWrittenPromptIds });
      next = applyDecisions(groups, { groups: [{ title: ownTitle(candidate?.firstAsk ?? ""), conversations: [conversationKey2] }] }, { database, now, excludedPromptIds: ledger.agentWrittenPromptIds, enrichGroupIds: resolution?.groupKeys ?? null });
    }
    next.suggestions = { ...next.suggestions ?? {}, [conversationKey2]: { ...suggestion, status: "declined", resolvedAt: iso2(now), evidence: `Owner declined: not part of "${request?.title ?? suggestion.requestId}". ${suggestion.evidence}` } };
    next.updatedAt = iso2(now);
  }
  if (writeGroups) writeGroups(next);
  else writeJsonAtomic(join9(dir, "request-groups.json"), next);
  return { status: next.suggestions[conversationKey2].status, requestId: next.conversations[conversationKey2] ?? null };
}
var DAY_MS, iso2, JOIN_THRESHOLD, SUGGEST_THRESHOLD, MAX_CANDIDATE_REQUESTS, MAX_DECISION_BODY_BYTES, DECISION_TIMEOUT_MS, JEV_MODEL, OPENROUTER_DECISIONS_URL, CONTEXT_PROMPTS, CONTEXT_PROMPT_CHARS, CONTEXT_RECORDED_TITLES, CONTEXT_TITLE_CHARS, PICK_INSTRUCTIONS, CHECK_INSTRUCTIONS, CHECK_CRITERIA, clean, rulesJudge;
var init_request_judge = __esm({
  "src/services/work-view/request-judge.mjs"() {
    "use strict";
    init_api_key_pool();
    init_EnvManager();
    init_cmem_gateway();
    init_openrouter_base_url();
    init_paths();
    init_SettingsDefaultsManager();
    init_request_groups();
    init_request_projection();
    DAY_MS = 864e5;
    iso2 = (epoch2) => new Date(epoch2).toISOString();
    JOIN_THRESHOLD = 0.8;
    SUGGEST_THRESHOLD = 0.5;
    MAX_CANDIDATE_REQUESTS = 19;
    MAX_DECISION_BODY_BYTES = 64 * 1024;
    DECISION_TIMEOUT_MS = 6e4;
    JEV_MODEL = "typesafe/jev-1.14";
    OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
    CONTEXT_PROMPTS = 3;
    CONTEXT_PROMPT_CHARS = 250;
    CONTEXT_RECORDED_TITLES = 8;
    CONTEXT_TITLE_CHARS = 120;
    PICK_INSTRUCTIONS = "`conversation` was started after each of `requests`. Which of `requests` does it continue: the same overall piece of work (same feature, page, skill, release or investigation), or another run of the same recurring routine? A person tracking their requests would want both on one card. Pick `none` if it is a separate ask of its own.";
    CHECK_INSTRUCTIONS = "`conversation` was started after `request`. It continues `request`: the same overall piece of work (same feature, page, skill, release or investigation), or another run of the same recurring routine. A person tracking their requests would want both on one card.";
    CHECK_CRITERIA = { true: "Same work", false: "Different work" };
    clean = (text5) => String(text5 ?? "").split("# Attached files")[0].replace(/\s+/g, " ").trim();
    rulesJudge = {
      name: "rules",
      async judge(conversation2, openRequests) {
        const open = new Set(openRequests.map((request) => request.groupId));
        const picks = /* @__PURE__ */ new Map();
        for (const link2 of conversation2.links ?? []) for (const groupId2 of link2.groups ?? []) if (open.has(groupId2)) picks.set(groupId2, link2);
        if (picks.size !== 1) return null;
        const [[groupId, link]] = picks;
        return { requestId: groupId, confidence: 1, evidence: `Judge rules: ${link.kind} ${link.evidence}` };
      }
    };
  }
});

// src/services/work-view/request-groups.mjs
import { Database } from "bun:sqlite";
import { createHash as createHash4 } from "node:crypto";
import { mkdirSync as mkdirSync5, readFileSync as readFileSync10, readdirSync, renameSync as renameSync3, statSync as statSync6, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { join as join10 } from "node:path";
function placeholders(values2) {
  return values2.map(() => "?").join(",");
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
    const asks = own.filter((prompt) => isHumanActionRequest(prompt.prompt_text)).map((prompt) => ({ promptId: prompt.id, at: iso3(prompt.created_at_epoch), text: requestText(prompt.prompt_text, fullAsks ? Infinity : 280) }));
    candidates.set(key, {
      conversationKey: key,
      platform: session.platform_source,
      project: session.project,
      startedAt: iso3(original.atEpoch ?? session.started_at_epoch),
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
  return [...candidates.values()].sort((a, b) => a.startedAtEpoch - b.startedAtEpoch).map(({ sessionDbId, lastActivityEpoch, ...candidate }) => ({ ...candidate, lastActivityAt: iso3(lastActivityEpoch), lastActivityEpoch }));
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
    // taskKey is the item's work-state task; goal is only ever a focus area's sentence.
    taskKey: item.task,
    ...goalKindOf(item),
    rank: Number(item.rank) || null,
    title: item.title ?? item.task,
    goal: item.goal ?? null,
    focusArea: item.focus_area ?? null,
    focusAreaId: item.focus_area_id ?? null,
    latestAt: item.latest_at ?? null,
    timesAsked: Number(item.times_asked) || null,
    // A later local refresh changes snapshot, so it cannot reuse an older hosted JSON evidence field.
    evidence: item.source === "hosted-intent" && item.hosted_snapshot === item.snapshot ? JSON.parse(item.evidence_json) : String(item.evidence ?? "").split("\n").filter(Boolean).map((line) => {
      const [at, ...quote2] = line.split(" | ");
      return { at, quote: quote2.join(" | ") };
    })
  })).sort((a, b) => GOAL_KINDS.indexOf(a.kind) - GOAL_KINDS.indexOf(b.kind) || (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return { summary: listState.human_summary ?? null, generatedAt: listState.generated_at ?? null, mapPath: listState.map_path ?? null, goals };
}
function readJson(path4, fallback) {
  try {
    return JSON.parse(readFileSync10(path4, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function writeJsonAtomic(path4, value) {
  const finish = beforeSharedFileWrite(path4, value);
  mkdirSync5(join10(path4, ".."), { recursive: true });
  const temp = `${path4}.tmp`;
  const stored = finish && Object.hasOwn(finish, "value") ? finish.value : value;
  writeFileSync3(temp, `${JSON.stringify(stored, null, 2)}
`, { mode: 384 });
  renameSync3(temp, path4);
  finish?.();
}
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
    if (decision.projectRoot != null && (typeof decision.projectRoot !== "string" || !decision.projectRoot.trim())) throw new TypeError(`${label}.projectRoot must be a non-empty string when given.`);
    const explicitRoot = decision.projectRoot ?? (next.groups[id]?.rootNamed ? next.groups[id].projectRoot : null);
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
    if (explicitRoot == null && roots.size > 1) throw new TypeError(`${label} joins conversations from different projects (${[...roots.keys()].map((root) => root || "no project").join(", ")}); a request stays inside one project root.`);
    const projectRootOfGroup = explicitRoot != null ? explicitRoot.trim() : roots.size ? [...roots.keys()][0] : storedRoot ?? null;
    for (const key of decision.conversations) {
      next.conversations[key] = id;
      if (next.ignored) delete next.ignored[key];
    }
    const memberSet = new Set(allMembers);
    const keptLinks = (next.groups[id]?.links ?? []).filter((link) => link.conversations.every((key) => memberSet.has(key)));
    const known = new Set(keptLinks.map((link) => JSON.stringify(link)));
    const mergedLinks = [...keptLinks, ...links.filter((link) => !known.has(JSON.stringify(link)))];
    next.groups[id] = { title: decision.title.trim(), anchor: decision.conversations[0], projectRoot: projectRootOfGroup, ...explicitRoot != null ? { rootNamed: true } : {}, links: mergedLinks, decidedAt: iso3(now), anchorAsk: stored?.groups?.[id]?.anchor === decision.conversations[0] ? stored.groups[id].anchorAsk ?? null : null };
  }
  next.ignored ??= {};
  for (const [index, ignored] of (decisions.ignored ?? []).entries()) {
    if (!isConversationKey(ignored.conversation)) throw new TypeError(`ignored[${index}].conversation must be a conversation key.`);
    next.ignored[ignored.conversation] = boundedText(ignored.reason, 200, `ignored[${index}].reason`);
    delete next.conversations[ignored.conversation];
  }
  const used = new Set(Object.values(next.conversations));
  for (const id of Object.keys(next.groups)) if (!used.has(id)) delete next.groups[id];
  next.updatedAt = iso3(now);
  return next;
}
function boundedText(value, max, label, optional2 = false) {
  if (optional2 && (value == null || value === "")) return "";
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be 1\u2013${max} characters.`);
  if (value.length > max) {
    const target = textTarget(max);
    throw new TypeError(`${label} is ${value.length} characters; it must be 1\u2013${max}. Bring it to about ${target} characters (cut at least ${value.length - target}).`);
  }
  return value.trim();
}
function boundedQuote(value, max, label) {
  if (typeof value === "string" && value.length > max) {
    throw new TypeError(`${label} is ${value.length} characters; it must be 1\u2013${max}. Quote a shorter part of it word for word, about ${textTarget(max)} characters; never reword a quote.`);
  }
  return boundedText(value, max, label);
}
function boundedList(value, max, label) {
  const list2 = value ?? [];
  if (!Array.isArray(list2)) throw new TypeError(`${label} must be an array of at most ${max}.`);
  if (list2.length > max) throw new TypeError(`${label} has ${list2.length} items; it must have at most ${max}. Keep the ${max} that matter most.`);
  return list2;
}
function reviewText(value, max, label, options) {
  if (!options.coerce) return boundedText(value, max, label, options.optional);
  if (options.optional && (value == null || value === "")) return "";
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be 1\u2013${max} characters.`);
  const text5 = value.trim();
  if (text5.length <= max) return text5;
  options.coercedFields.add(label);
  const suffix = "\u2026";
  let prefix = text5.slice(0, max - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  const boundary = prefix.lastIndexOf(" ");
  if (boundary >= prefix.length - 40) prefix = prefix.slice(0, boundary);
  return `${prefix.trimEnd()}${suffix}`;
}
function reviewQuote(value, max, label, options) {
  if (!options.coerce || typeof value !== "string" || !value.trim()) return boundedQuote(value, max, label);
  const text5 = value.trim();
  if (text5.length <= max) return text5;
  options.coercedFields.add(label);
  let quote2 = text5.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(quote2)) quote2 = quote2.slice(0, -1);
  const boundary = quote2.lastIndexOf(" ");
  if (boundary >= quote2.length - 40) quote2 = quote2.slice(0, boundary);
  return quote2.trimEnd();
}
function reviewList(value, max, label, options) {
  const list2 = value ?? [];
  if (!Array.isArray(list2)) throw new TypeError(`${label} must be an array of at most ${max}.`);
  if (list2.length <= max) return list2;
  if (!options.coerce) throw new TypeError(`${label} has ${list2.length} items; it must have at most ${max}. Keep the ${max} that matter most.`);
  options.coercedFields.add(label);
  const times = list2.map((entry) => Date.parse(entry?.at));
  if (times.some(Number.isNaN)) return list2.slice(-max);
  const newestIndexes = new Set(list2.map((_, index) => index).sort((a, b) => times[a] - times[b] || a - b).slice(-max));
  return list2.filter((_, index) => newestIndexes.has(index));
}
function validateOutcome(outcome2, options = {}) {
  if (outcome2 == null) return null;
  if (typeof outcome2 !== "object" || Array.isArray(outcome2)) throw new TypeError("outcome must be an object.");
  options = { coerce: false, coercedFields: /* @__PURE__ */ new Set(), ...options };
  const text5 = (value, max, label, optional2 = false) => reviewText(value, max, label, { ...options, optional: optional2 });
  const leveled = (entry, levels, label) => {
    if (entry == null) return null;
    if (!levels.includes(entry.level)) throw new TypeError(`${label}.level must be one of ${levels.join(", ")}.`);
    return { level: entry.level, text: text5(entry.text, 400, `${label}.text`), evidence: evidenceList(entry.evidence) };
  };
  const regressions = reviewList(outcome2.regressions, 10, "outcome.regressions", options), changes = reviewList(outcome2.changes, 12, "outcome.changes", options);
  const dated = (value, label) => {
    if (!isIsoOrNull(value ?? null)) throw new TypeError(`${label} must be an ISO date or null.`);
    return value ?? null;
  };
  return {
    landed: outcome2.landed == null ? null : { text: text5(outcome2.landed.text, 400, "outcome.landed.text"), at: dated(outcome2.landed.at, "outcome.landed.at"), evidence: evidenceList(outcome2.landed.evidence) },
    usage: leveled(outcome2.usage, USAGE_LEVELS, "outcome.usage"),
    value: leveled(outcome2.value, VALUE_LEVELS, "outcome.value"),
    regressions: regressions.map((regression, index) => ({
      text: text5(regression.text, 300, `outcome.regressions[${index}].text`),
      at: dated(regression.at, `outcome.regressions[${index}].at`),
      fixedBy: text5(regression.fixedBy, 200, `outcome.regressions[${index}].fixedBy`, true) || null,
      evidence: evidenceList(regression.evidence)
    })),
    changes: changes.map((change, index) => ({
      what: text5(change.what, 200, `outcome.changes[${index}].what`),
      why: text5(change.why, 400, `outcome.changes[${index}].why`),
      at: dated(change.at, `outcome.changes[${index}].at`),
      evidence: evidenceList(change.evidence)
    }))
  };
}
function validateProgress(entry, knownGroups, options = {}) {
  if (!entry || typeof entry !== "object") throw new TypeError("Progress must be an object.");
  options = { coerce: false, coercedFields: /* @__PURE__ */ new Set(), ...options };
  const text5 = (value, max, label, optional2 = false) => reviewText(value, max, label, { ...options, optional: optional2 });
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
  const milestones = reviewList(entry.milestones, 12, "milestones", options), preferences = reviewList(entry.preferences, 10, "preferences", options);
  return {
    groupId: entry.groupId,
    state: entry.state,
    percent: entry.percent,
    startedAt: entry.startedAt ?? null,
    shippedAt: entry.shippedAt ?? null,
    lastActivityAt: entry.lastActivityAt ?? null,
    summary: text5(entry.summary, 280, "summary"),
    narrative: text5(entry.narrative, 1200, "narrative", true),
    milestones: milestones.map((milestone, index) => {
      if (!isIsoOrNull(milestone.at ?? null)) throw new TypeError(`milestones[${index}].at must be an ISO date or null.`);
      return { at: milestone.at ?? null, text: text5(milestone.text, 200, `milestones[${index}].text`), evidence: evidenceList(milestone.evidence, 6) };
    }),
    preferences: preferences.map((preference2, index) => {
      if (!PREFERENCE_KINDS.includes(preference2.kind)) throw new TypeError(`preferences[${index}].kind must be one of ${PREFERENCE_KINDS.join(", ")}.`);
      if (!isIsoOrNull(preference2.at ?? null)) throw new TypeError(`preferences[${index}].at must be an ISO date or null.`);
      return { kind: preference2.kind, preference: text5(preference2.preference, 200, `preferences[${index}].preference`), quote: reviewQuote(preference2.quote, 300, `preferences[${index}].quote`, options), at: preference2.at ?? null };
    }),
    outcome: validateOutcome(entry.outcome, options),
    evidence: evidenceList(entry.evidence, 20),
    // What the reviewer actually saw: later activity or membership changes make it due again.
    reviewedThrough: new Date(Date.parse(basis.checkedThrough)).toISOString(),
    reviewedConversations: [...new Set(basis.conversations)].sort(),
    ...options.coerce && options.coercedFields.size ? { coercedFields: [...options.coercedFields].sort() } : {}
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
function storyPieces(narrative) {
  const pieces = [""];
  let fence = null;
  for (const line of (typeof narrative === "string" ? narrative : "").split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r?\n$/, ""));
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) fence = marker[1];
    else if (line.startsWith("## ")) pieces.push("");
    pieces[pieces.length - 1] += line;
  }
  return pieces;
}
function storyChaptersToMerge(narrative) {
  const chapters = storyPieces(narrative).length - 1;
  const fit = Math.floor((STORY_NARRATIVE_TARGET - STORY_RECAP_BUDGET) / STORY_CHAPTER_MIN_BUDGET);
  return chapters > fit ? chapters - fit + 1 : 0;
}
function storyParts(narrative) {
  const [recap, ...chapters] = storyPieces(narrative);
  const chapterBudget = Math.max(STORY_CHAPTER_MIN_BUDGET, Math.floor((STORY_NARRATIVE_TARGET - STORY_RECAP_BUDGET) / Math.max(1, chapters.length)));
  return [
    { part: "recap", text: recap, budgetChars: chapters.length ? STORY_RECAP_BUDGET : STORY_NARRATIVE_TARGET },
    ...chapters.map((chapter) => ({ part: chapter.split("\n", 1)[0].replace(/^## /, "").trim(), text: chapter, budgetChars: chapterBudget }))
  ].map(({ part, text: text5, budgetChars }) => {
    const words = text5.split(/\s+/).filter(Boolean).length;
    const charsPerWord = words ? text5.length / words : STORY_CHARS_PER_WORD;
    return { part, chars: text5.length, words, budgetChars, budgetWords: Math.max(1, Math.floor(budgetChars / charsPerWord)), overBudgetChars: Math.max(0, text5.length - budgetChars) };
  });
}
function validateStory(story) {
  const preferences = boundedList(story?.preferences, 30, "preferences");
  const narrativeChars = typeof story?.narrative === "string" ? story.narrative.length : 0;
  if (narrativeChars > STORY_NARRATIVE_MAX) {
    const over = storyParts(story.narrative).filter((part) => part.overBudgetChars > 0).sort((a, b) => b.overBudgetChars - a.overBudgetChars);
    const named = over.slice(0, STORY_REFUSAL_PARTS).map((part) => `${part.part === "recap" ? "the recap" : `"${part.part.slice(0, 60)}"`} ${part.chars} \u2192 ${part.budgetChars} characters (about ${part.budgetWords} words)`);
    const more = over.length > STORY_REFUSAL_PARTS ? `; ${over.length - STORY_REFUSAL_PARTS} more parts are over their budgets too` : "";
    const merge = storyChaptersToMerge(story.narrative);
    const chapters = storyParts(story.narrative).slice(1, merge + 1).map((part) => `"${part.part.slice(0, 60)}"`);
    const steps = [
      ...merge ? [`merge the ${merge} oldest chapters (${chapters[0]} through ${chapters[chapters.length - 1]}) into one chapter of at most ${STORY_CHAPTER_MIN_BUDGET} characters`] : [],
      ...named.length ? [`rewrite the parts furthest over their budgets: ${named.join("; ")}${more}`] : []
    ];
    throw new TypeError(`narrative is ${narrativeChars} characters; it must be 1\u2013${STORY_NARRATIVE_MAX}. Bring it to about ${STORY_NARRATIVE_TARGET} characters: ${steps.join(", then ") || "condense every part"}.`);
  }
  return {
    narrative: boundedText(story?.narrative, STORY_NARRATIVE_MAX, "narrative"),
    preferences: preferences.map((preference2, index) => ({
      preference: boundedText(preference2.preference, 200, `preferences[${index}].preference`),
      kind: PREFERENCE_KINDS.includes(preference2.kind) ? preference2.kind : "directive",
      supportCount: Number.isInteger(preference2.supportCount) && preference2.supportCount > 0 ? preference2.supportCount : 1,
      quotes: (preference2.quotes ?? []).slice(0, 3).map((quote2, quoteIndex) => ({ quote: boundedQuote(quote2.quote, 300, `preferences[${index}].quotes[${quoteIndex}]`), at: isIsoOrNull(quote2.at ?? null) ? quote2.at ?? null : null }))
    }))
  };
}
function readLedger(dir = LEDGER_DIR) {
  const groups = readJson(join10(dir, "request-groups.json"), emptyGroups());
  const progress = {};
  let names = [];
  try {
    names = readdirSync(join10(dir, "progress")).filter((name) => /^g_[0-9a-f]{12}\.json$/.test(name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const entry = readJson(join10(dir, "progress", name), null);
    if (entry?.groupId && groups.groups[entry.groupId]) progress[entry.groupId] = { ...entry, title: groups.groups[entry.groupId].title };
  }
  return {
    groups,
    progress,
    story: readJson(join10(dir, "story.json"), null),
    refresh: readJson(join10(dir, "refresh.json"), null),
    agentWrittenPromptIds: new Set(readJson(join10(dir, AGENT_WRITTEN_PROMPTS_FILE), { promptIds: [] }).promptIds ?? [])
  };
}
function groupDetails(groupId, ledger, candidatesByKey) {
  const group = ledger.groups.groups[groupId];
  const conversations = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => candidatesByKey.get(key) ?? { conversationKey: key, outsideWindow: true });
  const loaded = conversations.filter((conversation2) => !conversation2.outsideWindow);
  return {
    groupId,
    title: group.title,
    links: group.links,
    anchorAsk: group.anchorAsk ?? null,
    startedAt: iso3(Math.min(...loaded.map((conversation2) => conversation2.startedAtEpoch ?? Infinity))),
    lastActivityAt: iso3(Math.max(0, ...loaded.map((conversation2) => conversation2.lastActivityEpoch ?? 0))),
    lastActivityEpoch: Math.max(0, ...loaded.map((conversation2) => conversation2.lastActivityEpoch ?? 0)),
    projects: [...new Set(loaded.map((conversation2) => conversation2.project))],
    conversations: conversations.map(({ lastActivityEpoch, startedAtEpoch, original, ...conversation2 }) => conversation2),
    previousReview: ledger.progress[groupId] ?? null
  };
}
function pendingReviews(ledger, database, sinceEpoch) {
  const candidates = new Map(readCandidates(database, { sinceEpoch, excludedPromptIds: ledger.agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate]));
  const ungrouped = [...candidates.keys()].filter((key) => !ledger.groups.conversations[key] && !ledger.groups.ignored?.[key]).length;
  const ids = [...new Set([...candidates.keys()].map((key) => ledger.groups.conversations[key]).filter(Boolean))];
  const due = ids.map((id) => groupDetails(id, ledger, candidates)).filter((group) => !reviewIsCurrent(group.previousReview, group.conversations.map((conversation2) => conversation2.conversationKey), group.lastActivityEpoch)).sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch);
  return { due, ungrouped };
}
function openingAsks(database, ledger, conversationKeys) {
  const asks = /* @__PURE__ */ new Map();
  for (let index = 0; index < conversationKeys.length; index += CONVERSATIONS_PER_QUERY) {
    for (const candidate of readCandidates(database, { conversationKeys: conversationKeys.slice(index, index + CONVERSATIONS_PER_QUERY), excludedPromptIds: ledger.agentWrittenPromptIds })) {
      asks.set(candidate.conversationKey, candidate.firstAsk);
    }
  }
  return asks;
}
function requestRecord(ledger, groupId, asks) {
  const group = ledger.groups.groups[groupId], review = ledger.progress[groupId];
  const conversations = groupConversations(ledger, groupId);
  return {
    anchor: group.anchor,
    groupId,
    title: group.title,
    firstAsk: requestText(group.anchorAsk?.text ?? null, FOCUS_ASK_CHARS),
    state: review?.state ?? null,
    summary: review?.summary ?? null,
    // A tag only, never a grouping: the request's project root.
    repo: group.projectRoot ?? null,
    conversations: conversations.length,
    conversationAsks: conversations.map((key) => requestText(asks.get(key) ?? null, FOCUS_ASK_CHARS)).filter(Boolean)
  };
}
function focusBasis(ledger, groupId) {
  const group = ledger.groups.groups[groupId];
  return createHash4("sha256").update(JSON.stringify({ title: group.title, firstAsk: group.anchorAsk?.text ?? null, conversations: groupConversations(ledger, groupId) })).digest("hex").slice(0, 16);
}
function focusDue(ledger, focus, localDeviceId2) {
  return Object.keys(ledger.groups.groups).filter((groupId) => {
    const placement = focus.placementsByAnchor.get(ledger.groups.groups[groupId].anchor);
    if (placement?.owner && focus.resolveFocusAreaId(placement.owner.focusAreaId)) return false;
    const router = placement?.router;
    if (!router || !focus.resolveFocusAreaId(router.focusAreaId)) return true;
    return router.device === localDeviceId2 && router.basis != null && router.basis !== focusBasis(ledger, groupId);
  });
}
function routerOther(ledger, focus, queued) {
  return Object.keys(ledger.groups.groups).filter((groupId) => {
    if (queued.has(groupId)) return false;
    const placement = focus.placementsByAnchor.get(ledger.groups.groups[groupId].anchor);
    if (placement?.owner && focus.resolveFocusAreaId(placement.owner.focusAreaId)) return false;
    return !!placement?.router && focus.resolveFocusAreaId(placement.router.focusAreaId) === OTHER_FOCUS_AREA_ID;
  });
}
function focusInput(ledger, focus, localDeviceId2, database, { limit = FOCUS_BATCH } = {}) {
  const due = focusDue(ledger, focus, localDeviceId2);
  return {
    areas: focus.focusAreas.filter(isPlaceableArea).map(focusAreaRecord),
    dismissed: focus.focusAreas.filter(isOwnerDismissedArea).map(focusAreaRecord),
    requests: records(database, ledger, due.slice(0, limit)),
    remaining: Math.max(0, due.length - limit)
  };
}
function otherInput(ledger, focus, localDeviceId2, database) {
  const other = routerOther(ledger, focus, new Set(focusDue(ledger, focus, localDeviceId2)));
  const hash2 = otherPassHash(ledger, other);
  return {
    areas: focus.focusAreas.filter(isPlaceableArea).map(focusAreaRecord),
    dismissed: focus.focusAreas.filter(isOwnerDismissedArea).map(focusAreaRecord),
    other: records(database, ledger, other),
    due: hash2 !== null && hash2 !== focus.otherPassHash
  };
}
function validateFocusAnswer(answer, input, ledger, { other = false } = {}) {
  if (!Array.isArray(answer?.placements)) throw new TypeError("The answer needs a placements array.");
  if (!Array.isArray(answer?.proposals)) throw new TypeError("The answer needs a proposals array (empty when there is nothing to propose).");
  const listed = new Map((other ? input.other : input.requests).map((request) => [request.anchor, request]));
  const areaIds = new Set(input.areas.map((area) => area.focusAreaId));
  const dismissed = new Map(input.dismissed.map((area) => [area.focusAreaId, area]));
  const placed = /* @__PURE__ */ new Map();
  if (other && answer.placements.length) throw new TypeError('This question places nothing: answer "placements": [] and propose areas only.');
  for (const [index, placement] of answer.placements.entries()) {
    const label = `placements[${index}]`;
    if (!listed.has(placement?.anchor)) throw new TypeError(`${label} names ${placement?.anchor}, which was not asked about.`);
    if (placed.has(placement.anchor)) throw new TypeError(`${label} places ${placement.anchor} a second time; a request sits in one area.`);
    if (placement.focusAreaId !== OTHER_FOCUS_AREA_ID && !areaIds.has(placement.focusAreaId)) {
      if (dismissed.has(placement.focusAreaId)) throw new TypeError(`${label} names ${placement.focusAreaId} ("${dismissed.get(placement.focusAreaId).name}"), which the owner dismissed; it takes no requests. Use a listed area id or "other".`);
      throw new TypeError(`${label} names ${JSON.stringify(placement.focusAreaId)}, which is not a listed focus area. Use an exact focusAreaId from "areas", or "other".`);
    }
    placed.set(placement.anchor, { focusAreaId: placement.focusAreaId, evidence: boundedText(placement.evidence, AREA_SENTENCE_MAX, `${label}.evidence`) });
  }
  if (!other) {
    const missing = [...listed.keys()].filter((anchor) => !placed.has(anchor));
    if (missing.length) throw new TypeError(`Place every request asked about; missing ${missing.join(", ")}.`);
  }
  const held = /* @__PURE__ */ new Set();
  const proposals = answer.proposals.map((proposal, index) => {
    const label = `proposals[${index}]`;
    if (!PROPOSAL_KINDS.includes(proposal?.kind)) throw new TypeError(`${label}.kind must be one of ${PROPOSAL_KINDS.join(", ")}.`);
    if (!other && proposal.kind === "new") throw new TypeError(`${label}: new areas are proposed from Other in their own question; here only "promote" a request that holds several separate asks.`);
    if (proposal.sameAs != null && !areaIds.has(proposal.sameAs)) {
      if (dismissed.has(proposal.sameAs)) throw new TypeError(`${label} is the area the owner dismissed (${proposal.sameAs}, "${dismissed.get(proposal.sameAs).name}"); never propose it again. Drop this proposal.`);
      throw new TypeError(`${label}.sameAs names ${JSON.stringify(proposal.sameAs)}, which is not a listed area; use an exact focusAreaId from "areas" or null.`);
    }
    if (!Array.isArray(proposal.anchors) || !proposal.anchors.length) throw new TypeError(`${label}.anchors must list the requests it holds.`);
    if (proposal.kind === "new" && proposal.anchors.length < 2) throw new TypeError(`${label} clusters one request; a "new" area holds two or more steps of something larger (use "promote" for one request that holds several asks).`);
    if (proposal.kind === "promote" && proposal.anchors.length !== 1) throw new TypeError(`${label} promotes one request; list only that request's anchor.`);
    const requests = proposal.anchors.map((anchor) => {
      if (!listed.has(anchor)) throw new TypeError(`${label} holds ${anchor}, which ${other ? "is not a listed Other request" : "was not asked about"}.`);
      if (held.has(anchor)) throw new TypeError(`${label} holds ${anchor}, which another proposal already holds.`);
      held.add(anchor);
      return { anchorConversationKey: anchor, basis: focusBasis(ledger, listed.get(anchor).groupId) };
    });
    return {
      kind: proposal.kind,
      name: boundedText(proposal.name, AREA_NAME_MAX, `${label}.name`),
      goal: boundedText(proposal.goal, AREA_SENTENCE_MAX, `${label}.goal`),
      about: boundedText(proposal.about, AREA_SENTENCE_MAX, `${label}.about`),
      evidence: boundedText(proposal.evidence, AREA_SENTENCE_MAX, `${label}.evidence`),
      sameAs: proposal.sameAs ?? null,
      requests
    };
  });
  return {
    placements: [...placed].filter(([anchor]) => !held.has(anchor)).map(([anchor, { focusAreaId, evidence: evidence2 }]) => ({
      anchorConversationKey: anchor,
      focusAreaId,
      basis: focusBasis(ledger, listed.get(anchor).groupId),
      evidence: evidence2
    })),
    proposals,
    ...other ? { otherPassHash: otherPassHash(ledger, [...listed.keys()].filter((anchor) => !held.has(anchor)).map((anchor) => listed.get(anchor).groupId)) } : {}
  };
}
function refreshNeeds({ dir = LEDGER_DIR, database, now = Date.now(), days = 14, localDeviceId: localDeviceId2 }) {
  requireDeviceId(localDeviceId2);
  const ledger = readLedger(dir);
  const { due, ungrouped } = pendingReviews(ledger, database, now - days * DAY_MS2);
  const goals = readGoals(database);
  const generated = Date.parse(goals.generatedAt ?? "");
  const goalsStale = !Number.isFinite(generated) || now - generated > GOALS_STALE_MS;
  const focus = readFocus(database, { localDeviceId: localDeviceId2 });
  const queued = focusDue(ledger, focus, localDeviceId2);
  const otherHash = otherPassHash(ledger, routerOther(ledger, focus, new Set(queued)));
  const otherChanged = otherHash !== null && otherHash !== focus.otherPassHash;
  return { due: due.length, ungrouped, goalsStale, unplaced: queued.length, otherChanged, needed: Boolean(due.length || ungrouped || goalsStale || queued.length || otherChanged) };
}
function readInput(source) {
  return JSON.parse(readFileSync10(source === "-" ? 0 : source, "utf8"));
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
  const path4 = process.env.CLAUDE_MEM_DB ?? join10(DATA_DIR2, "claude-mem.db");
  statSync6(path4);
  const database = new Database(path4, { readonly: true, create: false });
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
function groupingInput(ledger, database, { sinceEpoch, limit = GROUPING_BATCH, skip = null }) {
  const candidates = readCandidates(database, { sinceEpoch, excludedPromptIds: ledger.agentWrittenPromptIds });
  const decided = (key) => Boolean(ledger.groups.conversations[key] || ledger.groups.ignored?.[key] || skip?.has(key));
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
  }).sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch).map(({ lastActivityEpoch, ...request }) => ({ ...request, lastActivityAt: iso3(lastActivityEpoch) }));
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
function applyDecisions(stored, decisions, { database, now = Date.now(), excludedPromptIds = null, enrichGroupIds = null }) {
  const touched = (decisions?.groups ?? []).flatMap((group) => Array.isArray(group?.conversations) ? group.conversations : []).filter(isConversationKey);
  const touchedGroups = new Set(touched.map((key) => groupIdFor(key)));
  const existing = Object.entries(stored?.conversations ?? {}).filter(([, id]) => touchedGroups.has(id)).map(([key]) => key);
  const next = applyGroupDecisions(stored, decisions, now, { projectOf: readConversationProjects(database, [...touched, ...existing]) });
  const missing = Object.entries(next.groups).filter(([id, group]) => !group.anchorAsk && (enrichGroupIds === null || enrichGroupIds.includes(id))).map(([, group]) => group.anchor);
  const anchors = new Map(readCandidates(database, { conversationKeys: missing, excludedPromptIds }).map((candidate) => [candidate.conversationKey, candidate.original]));
  for (const group of Object.values(next.groups)) if (!group.anchorAsk && anchors.has(group.anchor)) group.anchorAsk = anchors.get(group.anchor);
  return next;
}
function runCli(argv, { dir = LEDGER_DIR, database = null, now = Date.now(), print: print2 = (value) => console.log(JSON.stringify(value, null, 2)), localDeviceId: localDeviceId2, saveFocus: saveFocus2 = null, judge = void 0, coerceProgress = false } = {}) {
  const [command2, ...args] = argv;
  const db = () => database ?? openDatabase();
  const since = () => now - option(args, "days", 14) * DAY_MS2;
  if (command2 === "candidates") {
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
    return print2({ candidates: shown, proposedGroups: proposedGroups.filter((group) => group.links.length), skippedLists, projects: [...new Set(candidates.map((candidate) => projectRoot(candidate.project)))] });
  }
  if (command2 === "grouping-input") return print2(groupingInput(readLedger(dir), db(), { sinceEpoch: since(), limit: option(args, "limit", GROUPING_BATCH) }));
  if (command2 === "judge") {
    return Promise.resolve().then(() => (init_request_judge(), request_judge_exports)).then(({ configuredJudge: configuredJudge2, routeUndecided: routeUndecided2 }) => routeUndecided2({ dir, database: db(), judge: judge === void 0 ? configuredJudge2() : judge, now, days: option(args, "days", 14), apply: args.includes("--apply") })).then(print2);
  }
  if (command2 === "apply") {
    const ledger = readLedger(dir);
    const next = applyDecisions(ledger.groups, readInput(args[0] ?? "-"), { database: db(), now, excludedPromptIds: ledger.agentWrittenPromptIds });
    writeJsonAtomic(join10(dir, "request-groups.json"), next);
    return print2({ groups: Object.keys(next.groups).length, conversations: Object.keys(next.conversations).length });
  }
  if (command2 === "pending" || command2 === "show") {
    const ledger = readLedger(dir);
    if (command2 === "show") {
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
      const conversations = details.conversations.map((conversation2) => {
        const [, platform, sessionId] = JSON.parse(conversation2.conversationKey);
        return {
          ...conversation2,
          ...conversation2.asks && amendSince ? { asks: conversation2.asks.filter((ask) => Date.parse(ask.at) > since2) } : {},
          observations: observations.all(platform, sessionId, since2).map((row) => ({ id: row.id, at: iso3(row.created_at_epoch), type: row.type, title: row.title, subtitle: row.subtitle }))
        };
      });
      return print2({ ...details, conversations, mode: amendSince ? "amend" : "full", amendSince, reviewBasis: { checkedThrough: iso3(now), conversations: keys.sort() } });
    }
    const { due, ungrouped } = pendingReviews(ledger, db(), since());
    const limit = option(args, "limit", 48);
    return print2({ due: due.length, groups: due.slice(0, limit).map((group) => ({ groupId: group.groupId, title: group.title, lastActivityAt: group.lastActivityAt, conversations: group.conversations.length })), deferred: Math.max(0, due.length - limit), ungroupedConversations: ungrouped });
  }
  if (command2 === "record-progress") {
    const ledger = readLedger(dir);
    const coercedFields = /* @__PURE__ */ new Set();
    const reviewed = validateProgress(readInput(args[0] ?? "-"), ledger.groups.groups, { coerce: coerceProgress, coercedFields });
    const checkedAt = iso3(now);
    const previous = ledger.progress[reviewed.groupId];
    const unchanged = previous && JSON.stringify(storyFacts(previous)) === JSON.stringify(storyFacts(reviewed));
    const entry = { ...reviewed, checkedAt, changedAt: unchanged ? previous.changedAt ?? previous.checkedAt : checkedAt, readings: appendReading(ledger.progress[reviewed.groupId], { at: checkedAt, percent: reviewed.percent }) };
    writeJsonAtomic(join10(dir, "progress", `${entry.groupId}.json`), entry);
    return print2({ recorded: entry.groupId, state: entry.state, percent: entry.percent, readings: entry.readings.length, ...coercedFields.size ? { coercedFields: [...coercedFields] } : {} });
  }
  if (command2 === "story-input") {
    const { groups, progress, story } = readLedger(dir);
    const reviews = Object.values(progress).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const writtenAt = Date.parse(story?.writtenAt ?? "");
    const update = Number.isFinite(writtenAt);
    const previousNarrativeChars = story?.narrative?.length ?? 0;
    return print2({
      groups: Object.keys(groups.groups).length,
      update,
      narrativeTarget: STORY_NARRATIVE_TARGET,
      narrativeLimit: STORY_NARRATIVE_MAX,
      previousNarrativeChars,
      roomChars: Math.max(0, STORY_NARRATIVE_TARGET - previousNarrativeChars),
      condenseChars: Math.max(0, previousNarrativeChars - STORY_NARRATIVE_TARGET),
      previousParts: update ? storyParts(story.narrative) : [],
      mergeOldestChapters: update ? storyChaptersToMerge(story.narrative) : 0,
      reviews: update ? reviews.filter((review) => Date.parse(review.changedAt ?? review.checkedAt) > writtenAt) : reviews,
      // Rules owner-goals put in the story are its own (record-story carries them over): shown here, the story model
      // would echo them back without their source and when, leaving copies a later owner-goals save cannot replace.
      previousStory: story && { ...story, preferences: (story.preferences ?? []).filter((preference2) => preference2?.source !== OWNER_GOALS_LIST) }
    });
  }
  if (command2 === "record-story") {
    const validated = validateStory(readInput(args[0] ?? "-"));
    const fromOwnerGoals = (readLedger(dir).story?.preferences ?? []).filter((preference2) => preference2?.source === OWNER_GOALS_LIST);
    const story = { ...validated, preferences: [...validated.preferences, ...fromOwnerGoals], writtenAt: iso3(now) };
    writeJsonAtomic(join10(dir, "story.json"), story);
    return print2({ recorded: "story", preferences: story.preferences.length });
  }
  const focusQuestion = () => {
    const ledger = readLedger(dir), focus = readFocus(db(), { localDeviceId: requireDeviceId(localDeviceId2) });
    const other = args.includes("--other");
    return { ledger, other, input: other ? otherInput(ledger, focus, localDeviceId2, db()) : focusInput(ledger, focus, localDeviceId2, db(), { limit: option(args, "limit", FOCUS_BATCH) }) };
  };
  if (command2 === "focus-input") return print2(focusQuestion().input);
  if (command2 === "record-focus") {
    if (!saveFocus2) throw new Error("record-focus saves through the claude-mem worker, and none was given.");
    const { ledger, other, input } = focusQuestion();
    const file = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--limit").at(-1) ?? "-";
    const body = validateFocusAnswer(readInput(file), input, ledger, { other });
    return Promise.resolve(saveFocus2(body)).then((saved) => print2({ placed: saved.placed, proposed: saved.focusAreaIds.length, focusAreaIds: saved.focusAreaIds }));
  }
  if (command2 === "refresh-needs") return print2(refreshNeeds({ dir, database: db(), now, days: option(args, "days", 14), localDeviceId: localDeviceId2 }));
  throw new TypeError("Usage: request-groups.mjs candidates|grouping-input|judge|apply|pending|show|record-progress|story-input|record-story|focus-input|record-focus|refresh-needs (see file header).");
}
var DATA_DIR2, LEDGER_DIR, AGENT_WRITTEN_PROMPTS_FILE, DAY_MS2, GOALS_STALE_MS, MAX_CONVERSATIONS_PER_LINKING_LIST, PROGRESS_STATES, PREFERENCE_KINDS, USAGE_LEVELS, VALUE_LEVELS, LINK_KINDS, MAX_READINGS, iso3, groupIdFor, emptyGroups, isIsoOrNull, textTarget, evidenceList, STORY_NARRATIVE_MAX, STORY_NARRATIVE_TARGET, STORY_RECAP_BUDGET, STORY_CHAPTER_MIN_BUDGET, STORY_CHARS_PER_WORD, STORY_REFUSAL_PARTS, FOCUS_ASK_CHARS, CONVERSATIONS_PER_QUERY, groupConversations, records, otherPassHash, focusAreaRecord, AREA_NAME_MAX, AREA_SENTENCE_MAX, requireDeviceId, GROUPING_BATCH, FOCUS_BATCH, CLOSED_STATES;
var init_request_groups = __esm({
  "src/services/work-view/request-groups.mjs"() {
    "use strict";
    init_request_projection();
    init_owner_goals();
    init_session_project();
    init_my_focus();
    init_shared_file_hooks();
    DATA_DIR2 = process.env.CLAUDE_MEM_DATA_DIR || join10(homedir8(), ".claude-mem");
    LEDGER_DIR = join10(DATA_DIR2, "work-view");
    AGENT_WRITTEN_PROMPTS_FILE = "agent-written-prompts.json";
    DAY_MS2 = 864e5;
    GOALS_STALE_MS = DAY_MS2;
    MAX_CONVERSATIONS_PER_LINKING_LIST = 8;
    PROGRESS_STATES = ["shipped", "in-progress", "stalled", "abandoned", "unknown"];
    PREFERENCE_KINDS = ["directive", "correction", "praise", "frustration"];
    USAGE_LEVELS = ["in-use", "some-use", "no-evidence", "unknown"];
    VALUE_LEVELS = ["high", "medium", "low", "unclear"];
    LINK_KINDS = ["shared-work-list", "shared-request-id", "agent-judgment", "judge"];
    MAX_READINGS = 20;
    iso3 = (epoch2) => Number.isFinite(epoch2) && epoch2 > 0 ? new Date(epoch2).toISOString() : null;
    groupIdFor = (anchorConversationKey) => `g_${createHash4("sha256").update(anchorConversationKey).digest("hex").slice(0, 12)}`;
    emptyGroups = () => ({ version: 1, updatedAt: null, conversations: {}, groups: {}, ignored: {} });
    isIsoOrNull = (value) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
    textTarget = (max) => Math.floor(max * 0.75 / 10) * 10;
    evidenceList = (value, limit = 8) => (Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [value] : []).map(String).slice(0, limit);
    STORY_NARRATIVE_MAX = 12e3;
    STORY_NARRATIVE_TARGET = 8e3;
    STORY_RECAP_BUDGET = 800;
    STORY_CHAPTER_MIN_BUDGET = 300;
    STORY_CHARS_PER_WORD = 6;
    STORY_REFUSAL_PARTS = 6;
    FOCUS_ASK_CHARS = 400;
    CONVERSATIONS_PER_QUERY = 400;
    groupConversations = (ledger, groupId) => Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => key).sort();
    records = (database, ledger, groupIds) => {
      const asks = openingAsks(database, ledger, groupIds.flatMap((groupId) => groupConversations(ledger, groupId)));
      return groupIds.map((groupId) => requestRecord(ledger, groupId, asks));
    };
    otherPassHash = (ledger, groupIds) => groupIds.length ? createHash4("sha256").update(JSON.stringify(groupIds.map((groupId) => [ledger.groups.groups[groupId].anchor, focusBasis(ledger, groupId)]).sort())).digest("hex").slice(0, 16) : null;
    focusAreaRecord = (area) => ({ focusAreaId: area.focusAreaId, name: area.name, goal: area.goal, about: area.about, status: area.status });
    AREA_NAME_MAX = 80;
    AREA_SENTENCE_MAX = 300;
    requireDeviceId = (localDeviceId2) => {
      if (typeof localDeviceId2 !== "string") throw new TypeError(`My Focus needs the worker's sync device id ("" when cloud sync never started).`);
      return localDeviceId2;
    };
    GROUPING_BATCH = 20;
    FOCUS_BATCH = GROUPING_BATCH;
    CLOSED_STATES = /* @__PURE__ */ new Set(["shipped", "abandoned"]);
  }
});

// src/services/work-view/request-groups-cli.mjs
import { join as join12 } from "node:path";

// src/integrations/harness-worker.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
init_expand_home();
init_hook_constants();
init_install_port();
function dataDirectory() {
  return expandHome(process.env.CLAUDE_MEM_DATA_DIR || join3(homedir3(), ".claude-mem"));
}
function harnessSetting(dataDir = dataDirectory()) {
  let settings2 = {};
  try {
    const document = JSON.parse(readFileSync2(join3(dataDir, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
    const nested = document?.env;
    settings2 = nested && typeof nested === "object" && !Array.isArray(nested) && Object.keys(nested).some((key) => key.startsWith("CLAUDE_MEM_")) ? nested : document ?? {};
  } catch {
  }
  return (key, fallback) => process.env[key] || (typeof settings2[key] === "string" && settings2[key] ? String(settings2[key]) : fallback);
}
function resolveHarnessWorkerUrl() {
  const dataDir = dataDirectory();
  const setting = harnessSetting(dataDir);
  const configuredHost = setting("CLAUDE_MEM_WORKER_HOST", "127.0.0.1");
  const host = configuredHost === "localhost" ? "127.0.0.1" : configuredHost;
  const port = setting("CLAUDE_MEM_WORKER_PORT", String(getDefaultWorkerPort(dataDir)));
  return "http://" + (host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host) + ":" + port;
}

// src/services/work-view/request-groups-cli.mjs
init_paths();
init_SettingsDefaultsManager();
init_request_groups();
import { Database as Database2 } from "bun:sqlite";
import { existsSync as existsSync13 } from "node:fs";

// src/services/work-view/shared-ledger-adapter.mjs
init_request_groups();
import { readFileSync as readFileSync11, readdirSync as readdirSync2, mkdirSync as mkdirSync6, renameSync as renameSync4, writeFileSync as writeFileSync4, unlinkSync as unlinkSync2, statSync as statSync7 } from "node:fs";
import { join as join11 } from "node:path";
import { createHash as createHash7 } from "node:crypto";

// src/services/work-view/agent-view.mjs
init_request_projection();
init_owner_goals();

// src/services/work-view/my-rules.mjs
import { createHash as createHash5 } from "node:crypto";
var MY_RULES_LIST = "my-rules";
var RULE_TASK_PREFIX = "Rule: ";
var RULE_SCOPE_TIERS = ["everywhere", "project", "situation"];
var RULE_SET_BY = ["owner", "approved", "learned"];
var SAVED_RULE_STATUSES = ["on", "off", "replaced", "dismissed", "suggested"];
var MAX_QUOTES = 3;
var MAX_QUOTE_CHARS = 200;
var isMyRulesList = (name) => name === MY_RULES_LIST;
var ruleIdForPreference = (preference2) => `pref_${createHash5("sha256").update(String(preference2)).digest("hex").slice(0, 12)}`;
var text3 = (value) => typeof value === "string" ? value.trim() : "";
var count = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
var shortQuote = (quote2) => quote2.length > MAX_QUOTE_CHARS ? `${quote2.slice(0, MAX_QUOTE_CHARS - 1)}\u2026` : quote2;
function parseQuoteLines(value, kind) {
  if (typeof value !== "string") return [];
  return value.split("\n").flatMap((line) => {
    const match = /^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)?\s*\|\s*(.+)$/.exec(line.trim());
    if (!match) return [];
    return [{ at: match[1] ? `${match[1].replace(" ", "T")}${match[1].length > 10 ? ":00Z" : ""}` : null, quote: match[2], kind }];
  });
}
var ruleScopeId = (tier, name) => tier === "everywhere" ? "everywhere" : `${tier}:${name}`;
function suggestionsFromStory(story) {
  const preferences = Array.isArray(story?.preferences) ? story.preferences : [];
  return preferences.filter((preference2) => text3(preference2?.preference)).map((preference2) => {
    const originalQuotes = (preference2.quotes ?? []).filter((quote2) => text3(quote2?.quote));
    const quotes = (story.source === "hosted-intent" ? originalQuotes : originalQuotes.slice(0, MAX_QUOTES)).map((quote2) => ({ at: quote2.at ?? null, quote: story.source === "hosted-intent" ? String(quote2.quote) : shortQuote(text3(quote2.quote)), kind: preference2.kind }));
    const latest = quotes.map((quote2) => Date.parse(quote2.at ?? "")).filter(Number.isFinite);
    return {
      ruleId: ruleIdForPreference(preference2.preference),
      scopeTier: "everywhere",
      scopeName: "Everywhere",
      // Preferences are single sentences: the whole preference is the "then". Splitting a when out of it
      // would need a model call, which this view never makes; owner-goals' rules already carry their own.
      when: text3(preference2.when),
      then: story.source === "hosted-intent" ? String(preference2.preference) : text3(preference2.preference),
      setBy: "learned",
      status: "suggested",
      kind: preference2.kind ?? "directive",
      source: preference2.source === "owner-goals" ? "owner-goals" : "request-progress",
      timesSeen: Number.isInteger(preference2.supportCount) && preference2.supportCount > 0 ? preference2.supportCount : 1,
      latestAt: latest.length ? new Date(Math.max(...latest)).toISOString() : story.writtenAt ?? null,
      quotes,
      replacedBy: null,
      replacedAt: null,
      savedAt: null
    };
  });
}
function buildRules(state, ledger) {
  const rules = new Map(suggestionsFromStory(ledger?.story).map((rule) => [rule.ruleId, rule]));
  const ruleTasks = state.lists.filter((list2) => isMyRulesList(list2.name)).flatMap((list2) => list2.tasks).filter((task) => task.name.startsWith(RULE_TASK_PREFIX)).sort((a, b) => (a.updatedAtEpoch ?? 0) - (b.updatedAtEpoch ?? 0) || (a.latestEntryId ?? 0) - (b.latestEntryId ?? 0));
  for (const task of ruleTasks) {
    const fields = task.fields;
    const ruleId = text3(fields.rule_id) || task.name.slice(RULE_TASK_PREFIX.length);
    const base = rules.get(ruleId) ?? {
      ruleId,
      scopeTier: "everywhere",
      scopeName: "Everywhere",
      when: "",
      then: "",
      setBy: "owner",
      status: "on",
      kind: "directive",
      source: "you",
      timesSeen: 1,
      latestAt: null,
      quotes: [],
      replacedBy: null,
      replacedAt: null,
      savedAt: null
    };
    const scopeTier = RULE_SCOPE_TIERS.includes(fields.scope_tier) ? fields.scope_tier : base.scopeTier;
    const savedQuotes = parseQuoteLines(fields.quotes, base.kind);
    rules.set(ruleId, {
      ...base,
      scopeTier,
      scopeName: scopeTier === "everywhere" ? "Everywhere" : text3(fields.scope_name) || base.scopeName,
      when: typeof fields.when === "string" ? fields.when.trim() : base.when,
      then: text3(fields.then) || base.then,
      setBy: RULE_SET_BY.includes(fields.set_by) ? fields.set_by : base.setBy,
      status: SAVED_RULE_STATUSES.includes(fields.status) ? fields.status : base.status,
      source: text3(fields.source) || base.source,
      timesSeen: count(fields.times_seen) ?? base.timesSeen,
      latestAt: text3(fields.latest_at) || base.latestAt,
      quotes: savedQuotes.length ? savedQuotes : base.quotes,
      replacedBy: text3(fields.replaced_by) || null,
      replacedAt: text3(fields.replaced_at) || null,
      savedAt: task.updatedAt
    });
  }
  const shown = [...rules.values()].filter((rule) => rule.then && !(rule.setBy === "owner" && rule.status === "dismissed"));
  const scopes = /* @__PURE__ */ new Map([["everywhere", { id: "everywhere", tier: "everywhere", name: "Everywhere" }]]);
  for (const rule of shown) {
    const id = ruleScopeId(rule.scopeTier, rule.scopeName);
    if (!scopes.has(id)) scopes.set(id, { id, tier: rule.scopeTier, name: rule.scopeName });
  }
  const story = ledger?.story ?? null;
  return {
    rules: shown.map((rule) => ({ ...rule, scopeId: ruleScopeId(rule.scopeTier, rule.scopeName) })),
    ruleScopes: [...scopes.values()].sort((a, b) => RULE_SCOPE_TIERS.indexOf(a.tier) - RULE_SCOPE_TIERS.indexOf(b.tier) || a.name.localeCompare(b.name)),
    rulesLearning: story ? {
      preferencesFound: Array.isArray(story.preferences) ? story.preferences.length : 0,
      newSuggestions: shown.filter((rule) => rule.status === "suggested").length,
      reviewsRead: Object.keys(ledger.progress ?? {}).length,
      writtenAt: story.writtenAt ?? null
    } : null
  };
}

// src/services/work-view/agent-view.mjs
init_my_focus();
init_work_product();

// src/services/work-view/agent-lifecycle.mjs
var AGENT_LIFECYCLE_LIST = "agent-lifecycle";
var isAgentLifecycleList = (name) => name === AGENT_LIFECYCLE_LIST;
var stopKey = (platformSource, contentSessionId, agentId) => JSON.stringify([String(platformSource ?? "claude"), String(contentSessionId), String(agentId)]);
function readAgentStops(state) {
  const stops = /* @__PURE__ */ new Map();
  for (const list2 of state.lists ?? []) {
    if (!isAgentLifecycleList(list2.name)) continue;
    for (const task of list2.tasks) {
      const { content_session_id: session, agent_id: agentId, platform_source: platform, stopped_at_epoch: at, stop_source: source } = task.fields;
      if (typeof session !== "string" || typeof agentId !== "string" || !Number.isFinite(at)) continue;
      const key = stopKey(platform, session, agentId);
      const current = stops.get(key);
      if (!current || at > current.stoppedAtEpoch) stops.set(key, { stoppedAtEpoch: at, source, entryId: task.latestEntryId });
    }
  }
  return stops;
}
function agentStopFor(stops, platformSource, contentSessionId, agentId) {
  if (!contentSessionId || !agentId) return null;
  return stops.get(stopKey(platformSource, contentSessionId, agentId)) ?? null;
}

// src/services/work-view/agent-view.mjs
init_session_project();

// src/services/media/feed.ts
init_media_contract();
init_logger();
function observationMediaFromMetadata(metadataJson) {
  if (typeof metadataJson !== "string" || metadataJson.length === 0) return void 0;
  let metadata;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    logger.warn("DB", "Observation metadata unreadable; media refs omitted from feed", { code: "invalid_manifest" });
    return void 0;
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return void 0;
  if (!Object.prototype.hasOwnProperty.call(metadata, MEDIA_METADATA_NAMESPACE)) return void 0;
  try {
    const manifest = validateMediaManifest(metadata[MEDIA_METADATA_NAMESPACE]);
    return manifest.attachments.length > 0 ? manifest : void 0;
  } catch (error) {
    logger.warn("DB", "Observation media manifest invalid; media refs omitted from feed", {
      code: error instanceof MediaError ? error.code : "invalid_manifest"
    });
    return void 0;
  }
}

// src/services/work-view/agent-view.mjs
var PROJECT_KEY = (value) => String(value ?? "").replace(/[A-Z]/g, (c) => c.toLowerCase());
var CLOSED2 = /* @__PURE__ */ new Set(["done", "dropped", "completed", "failed"]);
var PLATFORMS = { codex: "Codex", claude: "Claude Code", "gemini-cli": "Gemini CLI", "antigravity-cli": "Antigravity CLI", kimi: "Kimi", "hermes-cli": "Hermes", "pi-agent": "Pi" };
var stamp = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value)).toISOString() : null;
var fingerprint = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
var callKey = (project, list2, fields) => JSON.stringify([PROJECT_KEY(project), list2, fingerprint(fields)]);
var agentKey = (platform, session, agent) => JSON.stringify(["session", platform ?? "unknown", String(session ?? ""), agent ?? "unidentified"]);
function compactText(value, max = 260) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text5 = String(value).replace(/\s+/g, " ").trim();
  return text5 ? text5.length > max ? `${text5.slice(0, max - 1).trimEnd()}\u2026` : text5 : null;
}
function fieldText(fields, names, max = 260) {
  for (const name of names) {
    if (typeof fields?.[name] !== "string") continue;
    const text5 = compactText(fields?.[name], max);
    if (text5 && /^(?:true|false|null|undefined|[-+]?\d+(?:\.\d+)?)$/i.test(text5)) continue;
    if (text5) return { text: text5, source: "work-state-field", field: name };
  }
  return null;
}
function readableRequest(value) {
  if (typeof value !== "string") return null;
  const text5 = value.replace(/<(environment_context|instructions|system-reminder|turn_aborted|permissions|collaboration_mode|skills_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/^\s*#\s*AGENTS\.md instructions[^\n]*(?:\n|$)/gim, " ").trim();
  if (!text5 || /^\s*(?:<\/?(?:environment_context|instructions|system-reminder)\b|You are (?:Codex|an AI)\b)/i.test(text5)) return null;
  return compactText(text5, 500);
}
function confirmedRequestKey(session, number) {
  if (!session || !Number.isInteger(Number(number)) || Number(number) < 0 || number == null) return null;
  return JSON.stringify(["request", session.platform_source ?? "unknown", String(session.id), Number(number)]);
}
function safeRead(database, sql, params = []) {
  try {
    return database.prepare(sql).all(...params);
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return [];
    throw error;
  }
}
function activitySignature(database) {
  const heads = ["observations", "session_summaries", "tool_uses", "user_prompts"].map((table) => {
    const row = safeRead(database, `SELECT MAX(id) AS id, COUNT(*) AS count FROM ${table}`)[0];
    return `${table}:${row?.id ?? 0}:${row?.count ?? 0}`;
  });
  const sessions = safeRead(database, `SELECT MAX(id) AS id, COUNT(*) AS count, MAX(completed_at_epoch) AS completed,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM sdk_sessions`)[0];
  heads.push(`sessions:${sessions?.id ?? 0}:${sessions?.count ?? 0}:${sessions?.completed ?? 0}:${sessions?.active ?? 0}`);
  const version = safeRead(database, "PRAGMA data_version")[0]?.data_version ?? 0;
  heads.push(`data:${version}`);
  return heads.join("|");
}
var REQUEST_WINDOW_MS = 14 * 864e5;
function readAgentRecords(database, { observationLimit = 300, summaryLimit = 100, workCallLimit = 5e3, requestSessionLimit = 600, workState, ledger = null, now = Date.now() } = {}) {
  const recentWorkTimes = workState?.lists.flatMap((list2) => [list2.stateUpdatedAtEpoch, ...list2.tasks.map((task) => task.updatedAtEpoch)]).filter(Boolean).sort((a, b) => b - a).slice(0, 240);
  const workSinceEpoch = recentWorkTimes?.length ? recentWorkTimes.at(-1) - 5e3 : 0;
  const calls = safeRead(database, `SELECT id, project, platform_source, agent_id, agent_type, session_db_id, memory_session_id, content_session_id, prompt_number, tool_input, created_at_epoch
    FROM tool_uses WHERE tool_name IN (SELECT DISTINCT tool_name FROM tool_uses WHERE tool_name LIKE '%work_state_write%')
    AND created_at_epoch >= ? ORDER BY id DESC LIMIT ?`, [workSinceEpoch, workCallLimit]);
  const observationContentSession = safeRead(database, "PRAGMA table_info(observations)").some((column) => column.name === "content_session_id") ? "content_session_id" : "NULL AS content_session_id";
  const observations = safeRead(database, `SELECT id, project, memory_session_id, ${observationContentSession}, agent_id, agent_type, prompt_number, title, subtitle, type, created_at_epoch
    FROM observations ORDER BY created_at_epoch DESC, id DESC LIMIT ?`, [observationLimit]);
  const withMetadata = observations.length ? safeRead(database, `SELECT id, metadata FROM observations
    WHERE metadata IS NOT NULL AND id IN (${observations.map(() => "?")})`, observations.map((row) => row.id)) : [];
  const mediaById = new Map(withMetadata.map((row) => [row.id, observationMediaFromMetadata(row.metadata)]).filter(([, media]) => media));
  for (const observation of observations) if (mediaById.has(observation.id)) observation.media = mediaById.get(observation.id);
  const summaries = safeRead(database, `SELECT id, project, memory_session_id, prompt_number, request, completed, next_steps, created_at_epoch
    FROM session_summaries ORDER BY created_at_epoch DESC, id DESC LIMIT ?`, [summaryLimit]);
  const { productCalls, productObservations, productDeliverables } = readProductRecords((sql, params) => safeRead(database, sql, params), workSinceEpoch, 2e3, { database });
  const ids = [...new Set([...calls, ...productCalls].map((call) => call.session_db_id).filter((id) => id != null))];
  const memoryIds = [...new Set([...observations, ...summaries, ...productObservations].map((row) => row.memory_session_id).filter(Boolean))];
  const predicates = [], args = [];
  if (ids.length) {
    predicates.push(`id IN (${ids.map(() => "?")})`);
    args.push(...ids);
  }
  if (memoryIds.length) {
    predicates.push(`memory_session_id IN (${memoryIds.map(() => "?")})`);
    args.push(...memoryIds);
  }
  const columns = "id, project, platform_source, content_session_id, memory_session_id, user_prompt, custom_title, status, started_at_epoch, completed_at_epoch";
  const loaded = new Map((predicates.length ? safeRead(database, `SELECT ${columns} FROM sdk_sessions WHERE ${predicates.join(" OR ")}`, args) : []).map((session) => [session.id, session]));
  const recentAsks = safeRead(database, `SELECT ${columns} FROM sdk_sessions WHERE id IN (
    SELECT session_db_id FROM user_prompts WHERE created_at_epoch >= ? GROUP BY session_db_id ORDER BY MAX(created_at_epoch) DESC LIMIT ?)`, [now - REQUEST_WINDOW_MS, requestSessionLimit]);
  const grouped = Object.keys(ledger?.groups?.conversations ?? {}).flatMap((key) => {
    try {
      const parsed = JSON.parse(key);
      return parsed?.[0] === "conversation" && parsed.length === 3 ? [[parsed[1], parsed[2]]] : [];
    } catch {
      return [];
    }
  });
  const groupedSessions = [];
  for (let index = 0; index < grouped.length; index += 400) {
    const chunk = grouped.slice(index, index + 400);
    groupedSessions.push(...safeRead(database, `SELECT ${columns} FROM sdk_sessions WHERE (platform_source, content_session_id) IN (VALUES ${chunk.map(() => "(?, ?)").join(",")})`, chunk.flat()));
  }
  for (const session of [...recentAsks, ...groupedSessions]) if (!loaded.has(session.id)) loaded.set(session.id, session);
  const sessions = withDerivedProjects(database, [...loaded.values()]);
  const sessionIds = sessions.map((session) => session.id);
  const prompts = sessionIds.length ? safeRead(database, `SELECT id, session_db_id, prompt_number, substr(prompt_text, 1, 1200) AS prompt_text, created_at_epoch
    FROM user_prompts WHERE session_db_id IN (${sessionIds.map(() => "?")}) ORDER BY id DESC LIMIT 12000`, sessionIds) : [];
  const contentIds = [...new Set([...observations, ...calls].filter((row) => row.agent_id && row.content_session_id).map((row) => row.content_session_id))];
  const contentArgs = contentIds.map(() => "?").join(", ");
  const agentLaunches = contentIds.length ? safeRead(database, `SELECT id, session_db_id, content_session_id, platform_source, prompt_number, created_at_epoch,
    json_extract(tool_response, '$.agentId') AS agent_id, json_extract(tool_response, '$.status') AS status,
    json_extract(tool_response, '$.isAsync') AS is_async,
    coalesce(json_extract(tool_input, '$.description'), json_extract(tool_response, '$.description')) AS description,
    substr(coalesce(json_extract(tool_input, '$.prompt'), json_extract(tool_response, '$.prompt')), 1, 600) AS prompt
    FROM tool_uses WHERE tool_name IN ('Agent', 'Task') AND json_valid(tool_response) AND json_valid(coalesce(tool_input, '{}'))
    AND content_session_id IN (${contentArgs}) ORDER BY id DESC LIMIT 2000`, contentIds) : [];
  const agentToolActivity = contentIds.length ? safeRead(database, `SELECT content_session_id, agent_id, MAX(created_at_epoch) AS last_epoch
    FROM tool_uses WHERE agent_id IS NOT NULL AND content_session_id IN (${contentArgs}) GROUP BY content_session_id, agent_id`, contentIds) : [];
  return { calls, observations, summaries, sessions, prompts, productCalls, productObservations, productDeliverables, agentLaunches, agentToolActivity };
}
function readAgentLaunches(rows) {
  const launches = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const agentId = typeof row.agent_id === "string" && row.agent_id ? row.agent_id : null;
    if (!agentId || !row.content_session_id) continue;
    const key = JSON.stringify([row.content_session_id, agentId]);
    if (launches.has(key)) continue;
    const isAsync = row.is_async === 1 || row.is_async === true || row.status === "async_launched";
    launches.set(key, {
      toolUseId: row.id,
      promptNumber: row.prompt_number ?? null,
      launchedAtEpoch: row.created_at_epoch,
      shared: row.shared === true,
      isAsync,
      returnedAtEpoch: !isAsync && row.status === "completed" ? row.created_at_epoch : null,
      description: compactText(row.description, 160),
      prompt: compactText(row.prompt, 500)
    });
  }
  return launches;
}
function launchRequest(launch) {
  if (!launch) return null;
  const text5 = launch.description ?? launch.prompt;
  return text5 ? { text: text5, source: "agent-launch", sourceId: launch.shared ? null : launch.toolUseId, url: launch.shared ? null : `/api/work-view/evidence/tool-use/${launch.toolUseId}` } : null;
}
function buildAgentView(state, records2, { now = Date.now(), workLimit = 240, activityLimit = 160, recentMs = 15 * 60 * 1e3, titleCache = {}, ledger = null } = {}) {
  const { calls = [], observations = [], summaries = [], sessions = [], prompts = [], agentLaunches = [], agentToolActivity = [] } = records2;
  const launches = readAgentLaunches(agentLaunches);
  const lastToolEpochs = new Map(agentToolActivity.map((row) => [JSON.stringify([row.content_session_id, row.agent_id]), Number(row.last_epoch) || 0]));
  const stops = readAgentStops(state);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const sessionsByMemory = new Map(sessions.filter((session) => session.memory_session_id).map((session) => [session.memory_session_id, session]));
  const scopes = new Set(state.currentProjectScope.map(PROJECT_KEY));
  const eventsById = new Map(state.events.map((event) => [event.id, event]));
  const fieldEvents = /* @__PURE__ */ new Map();
  for (const event of state.events) for (const field of Object.keys(event.fields)) {
    const key = JSON.stringify([event.taskId ?? event.listId, field]);
    if (!fieldEvents.has(key)) fieldEvents.set(key, event);
  }
  function recordedField(item, names, accept = (value) => typeof value === "string" && value.trim()) {
    const found = [];
    for (const field of names) {
      const own = Object.hasOwn(item.fields, field);
      const value = own ? item.fields[field] : item.list.fields[field];
      if (!accept(value)) continue;
      const event = fieldEvents.get(JSON.stringify([own ? item.id : item.list.id, field]));
      found.push({ value, field, atEpoch: event?.atEpoch ?? item.updatedAtEpoch ?? null, sourceOrder: event?.sourceOrder ?? null, sourceRef: event ? { kind: "work-state", id: event.id } : null });
    }
    return found.sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0));
  }
  function metadataFor(item) {
    const requester = recordedField(item, ["requested_by", "requester", "human_requester"])[0] ?? null;
    const estimate = recordedField(item, ["ship_estimate", "eta", "target_ship_at", "due_at"])[0] ?? null;
    const stage = recordedField(item, ["stage", "phase"])[0] ?? null;
    const resources = [];
    for (const field of ["docs_url", "documentation_url", "promo_url", "announcement_url"]) for (const record of recordedField(item, [field])) {
      try {
        const url = new URL(record.value.trim());
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
        resources.push({ kind: ["docs_url", "documentation_url"].includes(field) ? "documentation" : "promotion", url: record.value.trim(), field, atEpoch: record.atEpoch, sourceRefs: record.sourceRef ? [record.sourceRef] : [] });
      } catch {
      }
    }
    const describe = (fields) => fields.flatMap((field) => recordedField(item, [field]).map((record) => ({ text: compactText(record.value, 600), field, atEpoch: record.atEpoch, sourceRefs: record.sourceRef ? [record.sourceRef] : [] })));
    const classifications = describe(["classification", "category", "tags"]);
    const notes = describe(["post_ship", "after_ship"]);
    const status = recordedField(item, ["request_status"])[0] ?? null;
    const complete = recordedField(item, ["request_complete"], (value) => typeof value === "boolean")[0] ?? null;
    const workProduct = Object.keys({ ...item.list.fields, ...item.fields }).filter(isWorkProductField).flatMap((field) => {
      const event = fieldEvents.get(JSON.stringify([Object.hasOwn(item.fields, field) ? item.id : item.list.id, field]));
      return event ? productsFromFields(event.fields, { atEpoch: event.atEpoch, sourceRef: { kind: "work-state", id: event.id } }).filter((product) => product.field === field) : [];
    });
    return {
      workProduct,
      requestedBy: requester?.value.trim() ?? null,
      requestedBySource: requester,
      shipEstimate: estimate?.value ?? null,
      shipEstimateSource: estimate,
      stageSourceText: stage?.value ?? null,
      stageSource: stage,
      requestStatusSource: status,
      requestCompleteSource: complete,
      afterShip: resources.length || classifications.length || notes.length ? { resources, classifications, notes } : null
    };
  }
  const promptsByKey = /* @__PURE__ */ new Map();
  for (const prompt of prompts) {
    const key = JSON.stringify([prompt.session_db_id, prompt.prompt_number]);
    if (!promptsByKey.has(key)) promptsByKey.set(key, prompt);
  }
  const summaryByKey = /* @__PURE__ */ new Map();
  for (const summary of summaries) {
    const key = JSON.stringify([summary.memory_session_id, summary.prompt_number]);
    if (!summaryByKey.has(key)) summaryByKey.set(key, summary);
  }
  const callsByKey = /* @__PURE__ */ new Map();
  for (const call of calls) {
    let input;
    try {
      input = JSON.parse(call.tool_input);
    } catch {
      continue;
    }
    if (!input?.list || !input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)) continue;
    const key = callKey(call.project, input.list, input.fields);
    if (!callsByKey.has(key)) callsByKey.set(key, []);
    callsByKey.get(key).push(call);
  }
  const groups = /* @__PURE__ */ new Map();
  const activity = [];
  let linkedWork = 0, ownerWork = 0, unattributedWork = 0;
  function getGroup({ session, agentId = null, agentType = null, owner = null, project }) {
    const platform = session?.platform_source ?? null;
    const id = session ? agentKey(platform, session.id, agentId) : JSON.stringify([owner ? "owner" : "unassigned", PROJECT_KEY(project), owner, agentId]);
    if (!groups.has(id)) {
      const platformLabel = PLATFORMS[platform] ?? compactText(platform, 48) ?? "Unassigned";
      groups.set(id, {
        id,
        kind: session ? "session" : owner ? "recorded-owner" : "unassigned",
        label: session ? platformLabel : owner ? compactText(owner, 70) : "Unassigned work",
        platformSource: platform,
        agentId,
        agentType,
        sessionId: session?.id ?? null,
        contentSessionId: session?.content_session_id ?? null,
        sessionTitle: compactText(session?.custom_title, 120),
        recordedSessionStatus: session?.status ?? null,
        project,
        projects: [project],
        inCurrentScope: scopes.has(PROJECT_KEY(project)),
        identityEvidence: session ? "captured-session" : owner ? "explicit-owner-field" : agentId ? "recorded-agent-id" : "no-attribution",
        presence: { status: "unknown", isLive: null, evidence: "recorded-activity-only", lastActivityAt: null },
        // A subagent works inside its parent's conversation; only its own
        // captured tool calls and observations are credited to it. Claude Code
        // sets agent_id only inside a subagent; other hosts (Codex) also tag
        // the main thread, so their groups keep the per-prompt layout.
        isSubagent: Boolean(session && agentId && platform === "claude"),
        launch: session && agentId ? launches.get(JSON.stringify([session.content_session_id, agentId])) ?? null : null,
        work: [],
        activity: [],
        lastActivityEpoch: 0
      });
    }
    const group = groups.get(id);
    if (!group.projects.includes(project)) group.projects.push(project);
    group.inCurrentScope ||= scopes.has(PROJECT_KEY(project));
    return group;
  }
  function requestFor(session, number) {
    if (!session) return null;
    const key = confirmedRequestKey(session, number);
    const prompt = promptsByKey.get(JSON.stringify([session.id, number]));
    const summary = summaryByKey.get(JSON.stringify([session.memory_session_id, number]));
    const original = prompt ? { source: "user-prompt", sourceId: prompt.id, url: `/api/work-view/evidence/prompt/${prompt.id}` } : null;
    if (summary && readableRequest(summary.request)) return { key, text: readableRequest(summary.request), source: "session-summary-request", sourceId: summary.id, url: `/api/work-view/evidence/summary/${summary.id}`, original };
    if (prompt && readableRequest(prompt.prompt_text)) return { key, text: readableRequest(prompt.prompt_text), ...original };
    if ((number == null || number <= 1) && readableRequest(session.user_prompt)) return { key, text: readableRequest(session.user_prompt), source: "session-initial-request", sourceId: session.sharedOnly ? null : session.id, url: session.sharedOnly ? null : `/api/work-view/evidence/session/${session.id}` };
    return null;
  }
  function addActivity(group, entry) {
    group.lastActivityEpoch = Math.max(group.lastActivityEpoch, entry.atEpoch ?? 0);
    group.activity.push(entry);
    activity.push({ ...entry, agentGroupId: group.id });
  }
  const candidates = state.lists.filter((list2) => !isOwnerGoalsList(list2.name) && !isMyRulesList(list2.name) && !isMyFocusList(list2.name) && !isAgentLifecycleList(list2.name)).flatMap((list2) => [
    ...list2.tasks.map((task) => ({ ...task, list: list2, recordKind: "task" })),
    ...Object.keys(list2.fields).some((key) => key !== "task") ? [{ id: list2.id, name: list2.name, fields: list2.fields, status: list2.status, isOpen: !CLOSED2.has(list2.status), updatedAtEpoch: list2.stateUpdatedAtEpoch, latestEntryId: state.events.find((event) => event.listId === list2.id && event.task === null)?.id ?? 0, list: list2, recordKind: "list" }] : []
  ]).sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch).slice(0, workLimit);
  function uniqueCall(event) {
    const matches = (callsByKey.get(callKey(event.originProject ?? event.project, event.listName, event.fields)) ?? []).filter((call) => Math.abs(call.created_at_epoch - event.atEpoch) <= 5e3);
    return matches.length === 1 ? matches[0] : records2.sharedAttributions?.get(event.id) ?? null;
  }
  const eventsByItem = /* @__PURE__ */ new Map();
  for (const event of state.events) {
    const itemId = event.taskId ?? (event.task === null ? event.listId : null);
    if (itemId === null) continue;
    if (!eventsByItem.has(itemId)) eventsByItem.set(itemId, []);
    eventsByItem.get(itemId).push(event);
  }
  for (const item of candidates) {
    const event = eventsById.get(item.latestEntryId);
    let call = null, linkedEvent = null;
    for (const candidate of eventsByItem.get(item.id) ?? (event ? [event] : [])) {
      call = uniqueCall(candidate);
      if (call) {
        linkedEvent = candidate;
        break;
      }
    }
    const session = call ? sessionsById.get(call.session_db_id) ?? sessionsByMemory.get(call.memory_session_id) : null;
    const owner = compactText(item.fields.owner, 100);
    const group = getGroup({ session, agentId: call?.agent_id ?? null, agentType: call?.agent_type ?? null, owner, project: item.list.project });
    if (session) linkedWork++;
    else if (owner) ownerWork++;
    else unattributedWork++;
    const explicitRequest = fieldText(item.fields, ["request", "human_request", "user_request"], 500);
    const requestKey = confirmedRequestKey(session, call?.prompt_number);
    const request = { ...explicitRequest ?? requestFor(session, call?.prompt_number) ?? { text: compactText(item.name, 500), source: item.recordKind === "task" ? "task-label" : "list-label", sourceId: item.id, url: null }, key: requestKey };
    const next = fieldText(item.fields, ["next_step", "nextStep", "next", "next_action", "remaining", "pending", "then_run"]);
    const outcome2 = fieldText(item.fields, ["outcome", "result", "completed", "verified", "verification"]);
    const progress = fieldText(item.fields, ["human_summary", "summary", "progress", "phase", "stage", "status_note"]);
    const entry = {
      id: item.id,
      kind: "work-state",
      recordKind: item.recordKind,
      title: compactText(item.name, 160),
      project: item.list.project,
      listId: item.list.id,
      listName: item.list.name,
      taskId: item.recordKind === "task" ? item.id : null,
      status: item.status,
      statusExplicit: Object.hasOwn(item.fields, "status"),
      isOpen: item.isOpen,
      request,
      nextStep: next,
      outcome: outcome2,
      progress,
      owner,
      requestId: ["string", "number"].includes(typeof (item.fields.request_id ?? item.list.fields.request_id)) ? String(item.fields.request_id ?? item.list.fields.request_id).trim() || null : null,
      requestText: fieldText(item.fields, ["human_request", "request", "user_request"], 1200)?.text ?? fieldText(item.list.fields, ["human_request", "request", "user_request"], 1200)?.text ?? null,
      requestStatus: typeof (item.fields.request_status ?? item.list.fields.request_status) === "string" ? item.fields.request_status ?? item.list.fields.request_status : null,
      requestComplete: typeof (item.fields.request_complete ?? item.list.fields.request_complete) === "boolean" ? item.fields.request_complete ?? item.list.fields.request_complete : null,
      ...metadataFor(item),
      lastUpdateAt: stamp(item.updatedAtEpoch),
      lastUpdateEpoch: item.updatedAtEpoch,
      attribution: session ? { source: call.shared ? "synced-work-state-provenance" : "captured-work-state-call", toolUseId: call.shared ? null : call.id, sessionId: session.id, agentId: call.agent_id ?? null, meaning: linkedEvent.id === event?.id ? "update-author" : "latest-linked-update-author", linkedEntryId: linkedEvent.id, match: call.shared ? "stable-origin-entry" : "unique-project-list-fields-within-5s" } : { source: owner ? "explicit-owner-field" : "unavailable", meaning: owner ? "recorded-assignee" : "unknown" },
      sourceRefs: [{ kind: "work-state", id: event?.id ?? item.latestEntryId }, ...call && !call.shared ? [{ kind: "tool-use", id: call.id }] : []],
      url: `/api/work-view/evidence/work-state/${event?.id ?? item.latestEntryId}`
    };
    group.work.push(entry);
    addActivity(group, { id: `work-state:${event?.id ?? item.latestEntryId}`, requestKey, kind: "work-state", title: entry.title, detail: outcome2?.text ?? progress?.text ?? next?.text ?? null, project: entry.project, at: entry.lastUpdateAt, atEpoch: entry.lastUpdateEpoch, sourceRef: entry.sourceRefs[0], url: entry.url });
  }
  const observationBuckets = /* @__PURE__ */ new Map();
  function observationBucket(group, observation, session, request, requestKey, key, { withSummary }) {
    if (observationBuckets.has(key)) return observationBuckets.get(key);
    const summary = withSummary ? summaryByKey.get(JSON.stringify([observation.memory_session_id, observation.prompt_number])) : null;
    const row = {
      id: `session-request:${key}`,
      kind: "session-request",
      recordKind: "session",
      title: request?.text ?? compactText(observation.title, 160) ?? "Recorded observation",
      project: observation.project,
      listId: null,
      taskId: null,
      status: "unknown",
      statusExplicit: false,
      isOpen: true,
      request: { ...request ?? { text: compactText(observation.title, 500) ?? "Recorded observation", source: "observation-title", sourceId: observation.id, url: `/api/work-view/evidence/observation/${observation.id}` }, key: requestKey },
      nextStep: summary?.next_steps ? { text: compactText(summary.next_steps), source: "session-summary", sourceId: summary.id } : null,
      outcome: summary?.completed ? { text: compactText(summary.completed), source: "session-summary", sourceId: summary.id } : null,
      progress: { text: compactText(observation.title), source: "observation", sourceId: observation.id },
      owner: null,
      lastUpdateAt: stamp(observation.created_at_epoch),
      lastUpdateEpoch: observation.created_at_epoch,
      attribution: { source: session ? "observation-session-link" : "unavailable", meaning: group.isSubagent ? "recorded-subagent" : "recorded-session", agentId: group.agentId ?? null },
      sourceRefs: [{ kind: "observation", id: observation.id }],
      url: `/api/work-view/evidence/observation/${observation.id}`
    };
    observationBuckets.set(key, row);
    group.work.push(row);
    return row;
  }
  const mainKey = (group, observation) => JSON.stringify([group.id, observation.memory_session_id ?? null, observation.content_session_id ?? null, observation.prompt_number ?? null]);
  for (const observation of observations) {
    const session = sessionsByMemory.get(observation.memory_session_id);
    const group = getGroup({ session, agentId: observation.agent_id, agentType: observation.agent_type, project: observation.project });
    const media = observation.media;
    const observationActivity = { id: `observation:${observation.id}`, kind: "observation", title: compactText(observation.title, 160) ?? "Recorded observation", detail: compactText(observation.subtitle), project: observation.project, at: stamp(observation.created_at_epoch), atEpoch: observation.created_at_epoch, sourceRef: { kind: "observation", id: observation.id }, url: `/api/work-view/evidence/observation/${observation.id}`, ...media ? { media } : {} };
    if (!group.isSubagent) {
      const requestKey = confirmedRequestKey(session, observation.prompt_number);
      observationBucket(group, observation, session, requestFor(session, observation.prompt_number), requestKey, mainKey(group, observation), { withSummary: true });
      addActivity(group, { ...observationActivity, requestKey });
      continue;
    }
    const launch = group.launch;
    const launchKey = launch ? confirmedRequestKey(session, launch.promptNumber) : null;
    observationBucket(group, observation, session, launchRequest(launch), launchKey, JSON.stringify([group.id]), { withSummary: false });
    addActivity(group, { ...observationActivity, requestKey: launchKey });
    const parentRequest = requestFor(session, observation.prompt_number);
    if (session && parentRequest) {
      const main = getGroup({ session, agentId: null, agentType: null, project: observation.project });
      const parentKey = confirmedRequestKey(session, observation.prompt_number);
      const row = observationBucket(main, observation, session, parentRequest, parentKey, mainKey(main, observation), { withSummary: true });
      if (!row.sourceRefs.some((ref) => ref.kind === "observation" && ref.id === observation.id)) row.sourceRefs.push({ kind: "observation", id: observation.id });
    }
  }
  function subagentFinish(group) {
    const lastToolEpoch = lastToolEpochs.get(JSON.stringify([group.contentSessionId, group.agentId])) ?? 0;
    const lastActive = Math.max(group.lastActivityEpoch, lastToolEpoch);
    const evidence2 = [];
    const stop = agentStopFor(stops, group.platformSource, group.contentSessionId, group.agentId);
    if (stop) evidence2.push({ evidence: stop.source, atEpoch: stop.stoppedAtEpoch, sourceRef: { kind: "work-state", id: stop.entryId } });
    if (group.launch?.returnedAtEpoch) evidence2.push({ evidence: "agent-call-returned", atEpoch: group.launch.returnedAtEpoch, sourceRef: group.launch.shared ? null : { kind: "tool-use", id: group.launch.toolUseId } });
    return evidence2.filter((entry) => entry.atEpoch >= lastActive).sort((a, b) => b.atEpoch - a.atEpoch)[0] ?? null;
  }
  const agents = [...groups.values()].map((group) => {
    const { lastActivityEpoch, ...publicGroup } = group;
    const age = Math.max(0, now - lastActivityEpoch);
    const finished = group.isSubagent ? subagentFinish(group) : null;
    if (finished) {
      for (const item of group.work) if (item.kind === "session-request") {
        item.status = "finished";
        item.isOpen = false;
      }
    }
    return {
      ...publicGroup,
      presence: finished ? { ...group.presence, status: "finished", evidence: finished.evidence, finishedAt: stamp(finished.atEpoch), sourceRef: finished.sourceRef, lastActivityAt: stamp(lastActivityEpoch) } : { ...group.presence, status: lastActivityEpoch ? age <= recentMs ? "recent" : "quiet" : "unknown", lastActivityAt: stamp(lastActivityEpoch) },
      // The owner may record a stop for a subagent no recorded evidence covers.
      canMarkFinished: group.isSubagent && !finished,
      work: group.work.sort((a, b) => b.lastUpdateEpoch - a.lastUpdateEpoch),
      activity: group.activity.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, 8),
      counts: { work: group.work.length, open: group.work.filter((item) => item.isOpen).length, done: group.work.filter((item) => item.status === "done").length }
    };
  }).sort((a, b) => String(b.presence.lastActivityAt ?? "").localeCompare(String(a.presence.lastActivityAt ?? "")));
  const recentActivity = activity.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, activityLimit);
  const requestProjection = buildHumanRequests({ agents, recentActivity }, records2, { titleCache, ledger });
  const { focusAreas, focusAreaIdByAnchor } = buildFocusAreas(state);
  return {
    version: 1,
    generatedAt: stamp(now),
    currentProject: state.currentProject,
    currentProjectScope: state.currentProjectScope,
    agents,
    recentActivity,
    goals: buildOwnerGoals(state),
    goalHistory: buildOwnerGoalHistory(state),
    ...buildRules(state, ledger),
    ...requestProjection,
    focusAreas,
    humanRequests: placeRequests(requestProjection.humanRequests, focusAreaIdByAnchor, ledger),
    coverage: { workRows: candidates.length, workLimit, linkedWork, ownerWork, unattributedWork, observations: observations.length, observationLimit: 300, summaries: summaries.length, livePresenceAvailable: false, summaryMethod: "bounded-recorded-text", fullHistoryUrl: "/viewer" }
  };
}
function goalEvidence(value, structuredValue = null) {
  if (structuredValue !== null) {
    const evidence2 = JSON.parse(structuredValue);
    if (!Array.isArray(evidence2) || !evidence2.every((item) => item && typeof item.at === "string" && typeof item.quote === "string")) {
      throw new TypeError("Hosted goal evidence must contain dated quote objects.");
    }
    return evidence2;
  }
  if (typeof value !== "string") return [];
  return value.split("\n").flatMap((line) => {
    const match = /^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)\s*\|\s*(.+)$/.exec(line.trim());
    if (match) return [{ at: match[1], quote: compactText(match[2], 400) }];
    return compactText(line, 400) ? [{ at: null, quote: compactText(line, 400) }] : [];
  });
}
function goalsFromList(list2, history) {
  const count2 = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const hosted = list2.fields.source === "hosted-intent" && list2.fields.hosted_generated_at === list2.fields.generated_at;
  const originalText = (value) => typeof value === "string" ? value : null;
  const listText = (value, max) => hosted ? originalText(value) : compactText(value, max);
  const items = list2.tasks.filter((task) => history ? task.status !== "dropped" : task.isOpen).map((task) => {
    const hostedTask = task.fields.source === "hosted-intent" && task.fields.hosted_snapshot === task.fields.snapshot;
    const taskText = (value, max) => hostedTask ? originalText(value) : compactText(value, max);
    return {
      id: task.id,
      task: task.name,
      kind: goalKindOf(task.fields).kind,
      rank: count2(task.fields.rank),
      title: taskText(task.fields.title ?? task.name, 240),
      // A focus area's one-sentence goal; an ask's focus area (the name it was mined with) and that area's id.
      // 300 and 80 are the bounds they are written with: an area's goal and name (MAX_AREA_GOAL_CHARS and
      // MAX_AREA_NAME_CHARS in save_goals.py, the same as focusBody / ownerGoalsFocusBody in WorkViewRoutes.ts).
      goal: taskText(task.fields.goal, 300),
      focusArea: taskText(task.fields.focus_area, 80),
      focusAreaId: typeof task.fields.focus_area_id === "string" ? task.fields.focus_area_id : null,
      // Rows saved before the three tests (2026-10-27) name a product instead of a focus area.
      product: taskText(task.fields.product, 60),
      latestAt: taskText(task.fields.latest_at, 20),
      timesAsked: count2(task.fields.times_asked),
      status: task.status,
      evidence: goalEvidence(task.fields.evidence, hostedTask ? task.fields.evidence_json ?? null : null)
    };
  }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.title.localeCompare(b.title));
  const day = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : null;
  return {
    listId: list2.id,
    listName: list2.name,
    history,
    project: list2.project,
    updatedAt: list2.updatedAt,
    periodStart: day(list2.fields.period_start) ?? (history ? day(list2.name.slice(OWNER_GOALS_LIST.length + 1)) : null),
    periodEnd: day(list2.fields.period_end),
    summary: listText(list2.fields.human_summary, 1600),
    generatedAt: listText(list2.fields.generated_at, 40),
    windowDays: count2(list2.fields.window_days),
    sourcePromptCount: count2(list2.fields.source_prompt_count),
    mapPath: listText(list2.fields.map_path, 400),
    areas: items.filter((item) => item.kind === "focus-area"),
    asks: items.filter((item) => item.kind === "ask")
  };
}
function buildOwnerGoals(state) {
  const list2 = state.lists.find((item) => item.name === OWNER_GOALS_LIST);
  return list2 && list2.isOpen ? goalsFromList(list2, false) : null;
}
function buildOwnerGoalHistory(state) {
  return state.lists.filter((list2) => list2.name !== OWNER_GOALS_LIST && isOwnerGoalsList(list2.name) && list2.status !== "dropped").map((list2) => goalsFromList(list2, true)).filter((goals) => goals.areas.length || goals.asks.length).sort((a, b) => String(b.periodStart ?? b.listName).localeCompare(String(a.periodStart ?? a.listName)));
}

// src/services/work-view/shared-ledger-adapter.mjs
init_work_state_reduce();

// src/services/work-view/shared-projection.mjs
init_request_projection();
init_work_product();

// src/services/work-view/human-copy.mjs
import { createHash as createHash6 } from "node:crypto";
var HUMAN_COPY_MAX_CHARS = 18e3;
function text4(value, max) {
  if (typeof value !== "string") return "";
  const clean3 = value.replace(/\s+/g, " ").trim();
  return clean3.length > max ? `${clean3.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026` : clean3;
}
function sourceRef(value) {
  if (!value || typeof value !== "object") return null;
  if (Object.hasOwn(value, "stableIdentity")) return value.stableIdentity;
  if (value.sourceIdentity) return value.sourceIdentity;
  if (value.identity) return value.identity;
  const kind = typeof (value.kind ?? value.source) === "string" ? value.kind ?? value.source : null;
  const id = value.id ?? value.sourceId;
  if (!kind || !["string", "number"].includes(typeof id)) return null;
  return { kind: text4(kind, 60), id };
}
function refsFor(stream) {
  const refs = /* @__PURE__ */ new Map();
  for (const item of stream.items ?? []) for (const value of item.sourceRefs ?? []) {
    const ref = sourceRef(value);
    if (ref) refs.set(JSON.stringify(ref), ref);
    if (refs.size === 6) return [...refs.values()];
  }
  return [...refs.values()];
}
function itemContent(item, caps) {
  return {
    status: text4(item.status, 40),
    title: text4(item.title, caps.title),
    progress: text4(item.progress?.text, caps.detail),
    next: text4(item.nextStep?.text, caps.detail),
    outcome: text4(item.outcome?.text, caps.detail)
  };
}
function createHumanCopyInput(request) {
  if (!request || typeof request !== "object" || !request.original || typeof request.original.text !== "string") throw new TypeError("A recorded original request is required.");
  const streams = (request.workstreams ?? []).map((stream) => ({ ...stream, id: stream.stableId ?? stream.id }));
  if (streams.some((stream) => typeof stream?.id !== "string" || !stream.id) || new Set(streams.map((stream) => stream.id)).size !== streams.length) throw new TypeError("Workstreams require unique nonempty string ids.");
  streams.sort((a, b) => a.id.localeCompare(b.id));
  let itemLimit = 8, observationLimit = 3, detailCap = 240, titleCap = 160, originalCap = 1600, scopeCap = 320, refLimit = 6;
  const build = () => ({
    version: 1,
    original: { text: text4(request.original.text, originalCap), sourceRef: sourceRef(request.original) },
    recordedStage: text4(request.stageSourceText, 300),
    requestLifecycle: request.lifecycle?.explicit === true ? { status: text4(request.lifecycle.status, 40), field: text4(request.lifecycle.field, 40) } : null,
    scopeUpdates: (request.scopeUpdates ?? []).slice(-6).map((update) => ({ text: text4(update.text, scopeCap), sourceRef: sourceRef({ ...update, source: "user-prompt" }) })).filter((update) => update.text),
    workstreams: streams.map((stream) => ({
      id: stream.id,
      sourceRefs: refsFor(stream).slice(0, refLimit),
      currentItems: (stream.items ?? []).slice(0, itemLimit).map((item) => itemContent(item, { title: titleCap, detail: detailCap })),
      observations: (stream.activity ?? []).filter((activity) => activity.kind === "observation").slice(0, observationLimit).map((activity) => ({
        title: text4(activity.title, titleCap),
        summary: text4(activity.detail, detailCap),
        sourceRef: sourceRef(activity.sourceRef)
      }))
    }))
  });
  let input = build();
  while (JSON.stringify(input).length > HUMAN_COPY_MAX_CHARS) {
    if (detailCap > 80) {
      detailCap = Math.max(80, Math.floor(detailCap * 0.7));
      titleCap = Math.max(80, Math.floor(titleCap * 0.8));
    } else if (itemLimit > 1) itemLimit--;
    else if (observationLimit > 0) observationLimit--;
    else if (scopeCap > 80 || originalCap > 400) {
      scopeCap = 80;
      originalCap = 400;
    } else if (refLimit > 1) refLimit--;
    else throw new RangeError("Workstream identities exceed the bounded human-copy input budget.");
    input = build();
  }
  return input;
}
function humanCopyFingerprint(input) {
  const meaningful = {
    version: input.version,
    original: input.original.text,
    recordedStage: input.recordedStage || "",
    requestLifecycle: input.requestLifecycle ?? null,
    scopeUpdates: input.scopeUpdates.map((update) => update.text),
    workstreams: input.workstreams.map((stream) => ({
      id: stream.id,
      currentItems: [...stream.currentItems].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      observations: stream.observations.map(({ title, summary }) => ({ title, summary })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }))
  };
  return createHash6("sha256").update(JSON.stringify(meaningful)).digest("hex");
}
function exactKeys(object3, keys, label) {
  if (!object3 || typeof object3 !== "object" || Array.isArray(object3) || Object.keys(object3).length !== keys.length || keys.some((key) => !Object.hasOwn(object3, key))) throw new TypeError(`${label} has an invalid shape.`);
}
function copyText(value, limit, label, empty = false) {
  if (typeof value !== "string" || !empty && !value.trim() || value.length > limit) throw new TypeError(`${label} must be ${empty ? "0" : "1"}\u2013${limit} characters.`);
  return value.trim();
}
function validateHumanCopy(output2, input) {
  exactKeys(output2, ["title", "summary", "next", "workstreams", ...Object.hasOwn(output2 || {}, "stage") ? ["stage"] : []], "Human copy");
  if (!Array.isArray(output2.workstreams)) throw new TypeError("workstreams must be an array.");
  const wanted = new Set(input.workstreams.map((stream) => stream.id));
  if (output2.workstreams.length !== wanted.size) throw new TypeError("Every supplied workstream must appear exactly once.");
  const seen = /* @__PURE__ */ new Set();
  const workstreams = output2.workstreams.map((stream) => {
    exactKeys(stream, ["id", "title", "summary"], "Workstream copy");
    if (!wanted.has(stream.id) || seen.has(stream.id)) throw new TypeError("Unknown or duplicate workstream id.");
    seen.add(stream.id);
    return { id: stream.id, title: copyText(stream.title, 90, "Workstream title"), summary: copyText(stream.summary, 200, "Workstream summary") };
  });
  return { title: copyText(output2.title, 100, "Request title"), summary: copyText(output2.summary, 240, "Request summary"), next: copyText(output2.next, 160, "Next step", true), ...Object.hasOwn(output2, "stage") ? { stage: copyText(output2.stage, 40, "Stage", true) } : {}, workstreams };
}

// src/services/work-view/shared-projection.mjs
import { isIP } from "node:net";
import { basename as basename7 } from "node:path";

// src/services/work-view/shared-review-value.mjs
var SHARED_REVIEW_VERSION = 2;
var SHARED_REVIEW_KIND = "review";
var isSharedReviewKey = (value) => typeof value === "string" && /^sr2_[a-f0-9]{64}$/.test(value);
function isSharedReviewValue(kind, key, value, deleted = false) {
  if (kind !== SHARED_REVIEW_KIND || !isSharedReviewKey(key)) return false;
  if (deleted) return true;
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 5 && value.version === SHARED_REVIEW_VERSION && value.requestId === key && /^[a-f0-9]{64}$/.test(value.fingerprint ?? "") && typeof value.checked === "boolean" && Number.isSafeInteger(value.checkedAtEpoch) && value.checkedAtEpoch >= 0 && Number.isFinite(new Date(value.checkedAtEpoch).getTime()));
}

// src/services/work-view/shared-projection.mjs
var TABLES = { observation: "observations", summary: "session_summaries", prompt: "user_prompts", "work-state": "work_state_entries" };
var SOURCE_KINDS = { "user-prompt": "prompt", "session-summary-request": "summary", "session-summary": "summary", "session-initial-request": "session", "work-state": "work-state", observation: "observation" };
var values = (shared) => [...shared?.records?.values?.() ?? []];
var binaryOrder = (left, right) => left < right ? -1 : left > right ? 1 : 0;
var clean2 = (value) => value === void 0 ? null : value;
var pick = (value, names) => Object.fromEntries(names.filter((key) => value?.[key] !== void 0).map((key) => [key, value[key]]));
var object2 = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
var conversation = (value) => {
  try {
    const key = JSON.parse(value);
    return Array.isArray(key) && key.length === 3 && key[0] === "conversation" && key.slice(1).every((part) => typeof part === "string" && part.length > 0);
  } catch {
    return false;
  }
};
var originRef = (ref) => object2(ref) && Object.hasOwn(TABLES, ref.kind) && typeof ref.device === "string" && ref.device.length > 0 && /^\d+$/.test(ref.row ?? "");
function sharedPublishedUrl(value) {
  const normalized = safeWebUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host) || !host.includes(".") || /(?:^|\.)(?:localhost|local|lan|internal|home|test|invalid)$/.test(host)) return null;
  let path4;
  try {
    path4 = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/(?:^|\/)(?:api\/(?:media|work-view|deliverables)|private)(?:\/|$)/i.test(path4) || /\/storage\/v1\/object\/(?:sign|authenticated)(?:\/|$)/i.test(path4)) return null;
  const credentialName = (name) => {
    const words = name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const compact = words.replace(/_/g, "");
    return /(?:^|_)(?:token|signature|sig|credential|secret|password|key|auth|authorization|policy|expires|expiry|expiration)(?:$|_)/.test(words) || /^(?:xamz|xgoog|awsaccesskeyid$|googleaccessid$|accesskeyid$)/.test(compact) || /(?:token|signature|credential|secret|password|authorization|policy|expires|expiry|expiration|(?:api|access|private|signing|client|service|account|session)key)$/.test(compact);
  };
  const fragments = new URLSearchParams(url.hash.slice(1));
  for (const params of [url.searchParams, fragments]) for (const [name, parameter] of params) {
    if (credentialName(name) || /^(?:path|file|filename|source)$/i.test(name) && sharedProjectKey(parameter) === null) return null;
  }
  return normalized;
}
function sharedProjectKey(value) {
  if (typeof value !== "string" || value.length > 2e3) return null;
  if (/^(?:[\\/]|~(?:[\\/]|$)|[a-z]:|\.{1,2}[\\/]|file:|\$(?:HOME|USERPROFILE)(?:[\\/]|$)|\$\{(?:HOME|USERPROFILE)\}|%(?:HOME|USERPROFILE)%)/i.test(value.trim()) || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}
var forbiddenKeys = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype", "path", "bucketPath", "sourcePath", "bucket_path", "source_path", "pid", "lock", "objectKey", "object_key", "tool_input", "tool_response", "toolInput", "toolResponse", "raw", "token", "apiKey", "api_key", "authorization"]);
var string = (value, max = 12e3) => typeof value === "string" && value.length <= max;
var optional = (value, check) => value == null || check(value);
var date = (value) => string(value, 40) && Number.isFinite(Date.parse(value));
var epoch = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
var list = (value, check, max = 512) => Array.isArray(value) && value.length <= max && value.every(check);
var preferenceKinds = ["directive", "correction", "praise", "frustration"];
var quote = (value) => object2(value) && string(value.quote, 4e3) && optional(value.at, date);
var preference = (value) => object2(value) && string(value.preference, 2e3) && optional(value.kind, (kind) => preferenceKinds.includes(kind)) && optional(value.quotes, (quotes) => list(quotes, quote, 100)) && optional(value.quote, (quote2) => string(quote2, 4e3)) && optional(value.at, date);
function safeTree(value, depth = 0) {
  if (depth > 16) return false;
  if (value == null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => safeTree(item, depth + 1));
  return object2(value) && Object.entries(value).every(([key, item]) => !forbiddenKeys.has(key) && safeTree(item, depth + 1) && (!["url", "fileUrl"].includes(key) || optional(item, (url) => Boolean(sharedPublishedUrl(url)))) && (!["project", "projectRoot"].includes(key) || optional(item, (project) => sharedProjectKey(project) !== null)));
}
var evidence = (value) => list(value, (item) => typeof item === "string" || object2(item), 100);
var outcome = (value) => object2(value) && ["landed", "usage", "value"].every((key) => optional(value[key], (item) => object2(item) && string(item.text, 4e3) && optional(item.evidence, evidence))) && ["regressions", "changes"].every((key) => optional(value[key], (items) => list(items, (item) => object2(item) && optional(item.text, (text5) => string(text5, 4e3)) && optional(item.what, (text5) => string(text5, 4e3)) && optional(item.why, (text5) => string(text5, 4e3)), 100)));
var gitSha = (value) => typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value);
var gitBranch = (value) => string(value, 1024) && value.length > 0 && !value.startsWith("/") && !/[\s\\\x00-\x1f\x7f~^:?*\[]|\.\.|@\{/.test(value);
var gitRepo = (value) => string(value, 256) && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.split("/").some((part) => part === "." || part === "..");
var sharedProduct = (value) => object2(value) && string(value.kind, 80) && string(value.title, 2e3) && optional(value.atEpoch, epoch) && optional(value.sha, gitSha) && optional(value.branch, gitBranch) && optional(value.repo, gitRepo) && optional(value.heads, (heads) => list(heads, gitSha, 100)) && (value.availability === "origin-only" ? /^local_[a-f0-9]{64}$/.test(value.productId ?? "") && string(value.originDeviceId, 2e3) && value.originDeviceId.length > 0 && value.url == null && value.fileUrl == null : value.availability == null && Boolean(sharedPublishedUrl(value.url)));
function isSharedProjectionValue(kind, key, value, deleted = false, writer = void 0) {
  if (kind === "review") return isSharedReviewValue(kind, key, value, deleted);
  const groupKey = /^g_[a-f0-9]{12}$/.test(key);
  const knownKey = kind === "group" || kind === "progress" ? groupKey : kind === "story" ? key === "current" : ["ignored", "provenance"].includes(kind) ? conversation(key) : ["refresh", "copy", "exclusion"].includes(kind);
  if (!knownKey) return false;
  if (writer !== void 0 && kind === "refresh" && key !== writer) return false;
  if (writer !== void 0 && kind === "exclusion") {
    let identity;
    try {
      identity = JSON.parse(key);
    } catch {
      return false;
    }
    if (!originRef(identity) || identity.kind !== "prompt" || identity.device !== writer) return false;
  }
  if (deleted) return true;
  if (!safeTree(value)) return false;
  if (kind === "ignored") return string(value, 48e3);
  if (!object2(value)) return false;
  if (kind === "group") return object2(value.group) && string(value.group.title, 120) && value.group.title.trim().length > 0 && conversation(value.group.anchor) && list(value.members, conversation) && value.members.length > 0 && new Set(value.members).size === value.members.length && value.members.includes(value.group.anchor) && optional(value.group.projectRoot, (root) => string(root, 2e3)) && optional(value.group.rootNamed, (root) => typeof root === "boolean") && optional(value.group.product, (product) => string(product, 48e3)) && optional(value.group.anchorAsk, (ask) => object2(ask) && string(ask.text, 2e3) && optional(ask.atEpoch, epoch)) && optional(value.group.links, (links) => list(links, (link) => object2(link) && string(link.kind, 80) && string(link.evidence, 48e3) && list(link.conversations, conversation))) && optional(value.suggestions, (suggestions) => object2(suggestions) && Object.entries(suggestions).every(([candidate, suggestion]) => conversation(candidate) && object2(suggestion) && suggestion.requestId === key && optional(suggestion.confidence, (score) => typeof score === "number" && score >= 0 && score <= 1) && optional(suggestion.evidence, (evidence2) => string(evidence2, 4e3)) && optional(suggestion.status, (status) => ["open", "joined", "declined", "dismissed"].includes(status))));
  if (kind === "progress") return value.groupId === key && ["shipped", "in-progress", "stalled", "abandoned", "unknown"].includes(value.state) && Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100 && ["summary", "narrative", "title"].every((key2) => optional(value[key2], (text5) => string(text5, 12e3))) && ["startedAt", "shippedAt", "lastActivityAt", "reviewedThrough", "checkedAt", "changedAt"].every((key2) => optional(value[key2], date)) && optional(value.milestones, (milestones) => list(milestones, (item) => object2(item) && string(item.text, 4e3) && optional(item.at, date) && optional(item.evidence, evidence), 100)) && optional(value.preferences, (preferences) => list(preferences, preference, 100)) && optional(value.readings, (readings) => list(readings, (item) => object2(item) && date(item.at) && Number.isInteger(item.percent) && item.percent >= 0 && item.percent <= 100, 100)) && optional(value.reviewedConversations, (keys) => list(keys, conversation)) && optional(value.coercedFields, (fields) => list(fields, (field) => string(field, 200))) && optional(value.evidence, evidence) && optional(value.outcome, outcome);
  if (kind === "story") return optional(value.narrative, (narrative) => string(narrative, 48e3)) && list(value.preferences, preference, 100) && optional(value.writtenAt, date) && optional(value.generatedAt, (at) => date(at) || epoch(at)) && optional(value.source, (source) => string(source, 80));
  if (kind === "refresh") return value.originDeviceId === key && ["idle", "running", "ok", "failed", "waiting-for-agent"].includes(value.state) && ["reason", "agent", "result"].every((key2) => optional(value[key2], (text5) => string(text5, 12e3))) && ["startedAt", "finishedAt", "checkedAt"].every((key2) => optional(value[key2], date));
  if (kind === "exclusion") {
    let identity;
    try {
      identity = JSON.parse(key);
    } catch {
      return false;
    }
    return originRef(value.ref) && value.ref.kind === "prompt" && ["kind", "device", "row"].every((field) => identity?.[field] === value.ref[field]) && (value.conversation == null || conversation(value.conversation)) && (value.opening == null || typeof value.opening === "boolean");
  }
  if (kind === "provenance") return conversationKey(value.session) === key && object2(value.session) && ["project", "platform_source", "content_session_id", "memory_session_id", "custom_title", "status"].every((key2) => optional(value.session[key2], (text5) => string(text5, 2e3))) && optional(value.session.user_prompt, (prompt) => string(prompt, 1200)) && ["started_at_epoch", "completed_at_epoch"].every((key2) => optional(value.session[key2], epoch)) && list(value.attributions, (item) => object2(item) && originRef(item.work) && item.work.kind === "work-state" && optional(item.agentId, (id) => string(id, 256)) && optional(item.agentType, (type) => string(type, 256)) && optional(item.promptNumber, (number) => Number.isInteger(number) && number >= 0) && optional(item.atEpoch, epoch)) && list(value.products, (item) => sharedProduct(item) && (item.availability !== "origin-only" || writer === void 0 || item.originDeviceId === writer)) && list(value.launches, (item) => object2(item) && string(item.agent_id, 256) && optional(item.status, (status) => string(status, 80)) && optional(item.is_async, (flag) => typeof flag === "boolean" || flag === 0 || flag === 1) && optional(item.description, (text5) => string(text5, 160)) && optional(item.created_at_epoch, epoch)) && list(value.activity, (item) => object2(item) && optional(item.agent_id, (id) => string(id, 256)) && optional(item.last_epoch, epoch));
  if (kind === "copy") {
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint ?? "") || !object2(value.copy) || !optional(value.generatedAt, epoch)) return false;
    try {
      validateHumanCopy(value.copy, { workstreams: value.copy.workstreams });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
function get(database, sql, args) {
  try {
    return database.prepare(sql).get(...args);
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return null;
    throw error;
  }
}
function stableEvidenceRef(database, kind, id, deviceId) {
  if (id == null) return null;
  if (kind === "session") {
    const row2 = get(database, "SELECT platform_source, content_session_id FROM sdk_sessions WHERE id = ?", [id]);
    const key = conversationKey(row2);
    return key ? { kind, conversation: key } : null;
  }
  const table = TABLES[kind];
  if (!table) return null;
  let row;
  try {
    row = database.prepare(`SELECT origin_device_id, origin_local_id FROM ${table} WHERE id = ?`).get(id);
  } catch (error) {
    if (!/no such (table|column)/i.test(String(error.message))) throw error;
    row = get(database, `SELECT id FROM ${table} WHERE id = ?`, [id]);
  }
  if (!row) return null;
  const origin = row.origin_device_id ?? deviceId;
  return origin ? { kind, device: origin, row: String(row.origin_local_id ?? id) } : null;
}
function resolveEvidenceRef(database, ref, deviceId) {
  if (!ref || typeof ref !== "object") return null;
  if (ref.kind === "session") {
    let tuple;
    try {
      tuple = JSON.parse(ref.conversation);
    } catch {
      return null;
    }
    if (!Array.isArray(tuple) || tuple[0] !== "conversation" || tuple.length !== 3) return null;
    return get(database, "SELECT id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ? ORDER BY id LIMIT 1", tuple.slice(1))?.id ?? null;
  }
  const table = TABLES[ref.kind];
  if (!table || typeof ref.device !== "string" || !/^\d+$/.test(ref.row ?? "")) return null;
  if (ref.device === deviceId) {
    const local = get(database, `SELECT id FROM ${table} WHERE id = ? AND origin_device_id IS NULL`, [ref.row]);
    if (local) return local.id;
  }
  return get(database, `SELECT id FROM ${table} WHERE origin_device_id = ? AND origin_local_id = ?`, [ref.device, ref.row])?.id ?? null;
}
function fileProductIdentity(database, product, deviceId) {
  if (!database) return null;
  const source = product.sourceRef;
  if (!source || !Number.isSafeInteger(source.id) || source.id < 1) return null;
  const ref = source.kind === "deliverable" ? { kind: source.kind, device: deviceId, row: String(source.id) } : stableEvidenceRef(database, source.kind, source.id, deviceId);
  const productId = ref && localProductId({ ...ref, index: source.index ?? 0 });
  return productId ? { productId, originDeviceId: ref.device } : null;
}
function localFileMetadata(database, product, deviceId) {
  if (!product.path && !product.bucketPath) return null;
  const identity = fileProductIdentity(database, product, deviceId);
  if (!identity) return null;
  return {
    kind: product.kind,
    title: basename7(product.path ?? product.bucketPath),
    ...identity,
    availability: "origin-only",
    atEpoch: product.atEpoch ?? null
  };
}
function portableWorkValue(database, value, deviceId) {
  if (Array.isArray(value)) return value.map((item) => portableWorkValue(database, item, deviceId));
  if (!value || typeof value !== "object") return clean2(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["path", "bucketPath", "sourcePath", "bucket_path", "source_path", "pid", "lock", "objectKey", "object_key", "tool_input", "tool_response", "raw", "token", "apiKey", "api_key", "authorization"].includes(key)) continue;
    if (["project", "projectRoot"].includes(key)) {
      const project = sharedProjectKey(item);
      if (project !== null) result[key] = project;
      continue;
    }
    if (key === "url" || key === "fileUrl") {
      const match = typeof item === "string" && /^\/api\/work-view\/evidence\/([\w-]+)\/(\d+)$/.exec(item);
      if (match) {
        const ref = stableEvidenceRef(database, match[1], match[2], deviceId);
        if (ref) result[`${key}Ref`] = ref;
      } else if (sharedPublishedUrl(item)) result[key] = sharedPublishedUrl(item);
      continue;
    }
    if (key === "sourceId") {
      const ref = stableEvidenceRef(database, SOURCE_KINDS[value.source] ?? value.kind, item, deviceId);
      if (ref) result.sourceIdentity = ref;
      continue;
    }
    if (key === "id" && TABLES[value.kind]) {
      const ref = stableEvidenceRef(database, value.kind, item, deviceId);
      if (ref) result.identity = ref;
      continue;
    }
    result[key] = portableWorkValue(database, item, deviceId);
  }
  return result;
}
function localWorkValue(database, value, deviceId) {
  if (Array.isArray(value)) return value.map((item) => localWorkValue(database, item, deviceId));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "sourceIdentity") {
      result.sourceId = resolveEvidenceRef(database, item, deviceId);
      result.sourceIdentity = item;
    } else if (key === "identity") {
      result.id = resolveEvidenceRef(database, item, deviceId);
      result.identity = item;
    } else if (key === "urlRef" || key === "fileUrlRef") {
      const id = resolveEvidenceRef(database, item, deviceId);
      result[key === "urlRef" ? "url" : "fileUrl"] = id == null ? null : `/api/work-view/evidence/${item.kind}/${id}`;
    } else result[key] = localWorkValue(database, item, deviceId);
  }
  return result;
}
var emptyLedger = () => ({ groups: { version: 1, updatedAt: null, conversations: {}, groups: {}, ignored: {}, suggestions: {} }, progress: {}, story: null, refresh: null, agentWrittenPromptIds: /* @__PURE__ */ new Set() });
var sessionFields = ["project", "platform_source", "content_session_id", "memory_session_id", "user_prompt", "custom_title", "status", "started_at_epoch", "completed_at_epoch"];
function buildSharedProjectionUpdates(database, { ledger, records: records2 = {}, view = {}, deviceId, copyEntries = {} } = {}) {
  if (!deviceId) return [];
  decorateSharedView(view, { database, deviceId, records: records2 });
  const updates = [];
  const add = (kind, key, value) => updates.push({ kind, key, value });
  for (const [id, group] of Object.entries(ledger?.groups?.groups ?? {})) {
    const members = Object.entries(ledger.groups.conversations ?? {}).filter(([, groupId]) => groupId === id).map(([key]) => key).sort();
    const suggestions = Object.fromEntries(Object.entries(ledger.groups.suggestions ?? {}).filter(([, suggestion]) => suggestion.requestId === id).map(([key, value]) => [key, pick(value, ["requestId", "confidence", "evidence", "judge", "at", "status", "resolvedAt"])]));
    const portableGroup = pick(group, ["title", "anchor", "projectRoot", "rootNamed", "product", "links", "decidedAt"]);
    if (group.anchorAsk) portableGroup.anchorAsk = pick(group.anchorAsk, ["text", "source", "sourceId", "url", "promptNumber", "atEpoch"]);
    add("group", id, portableWorkValue(database, { group: portableGroup, members, suggestions }, deviceId));
  }
  for (const [key, ignored] of Object.entries(ledger?.groups?.ignored ?? {})) add("ignored", key, portableWorkValue(database, ignored, deviceId));
  for (const [id, progress] of Object.entries(ledger?.progress ?? {})) add("progress", id, portableWorkValue(database, pick(progress, ["groupId", "state", "percent", "startedAt", "shippedAt", "lastActivityAt", "summary", "narrative", "milestones", "preferences", "outcome", "evidence", "reviewedThrough", "reviewedConversations", "coercedFields", "checkedAt", "changedAt", "readings", "title"]), deviceId));
  if (ledger?.story) add("story", "current", portableWorkValue(database, pick(ledger.story, ["narrative", "preferences", "writtenAt", "generatedAt", "source"]), deviceId));
  if (ledger?.refresh) {
    const fields = ["state", "reason", "agent", "result", "startedAt", "finishedAt", "checkedAt"];
    add("refresh", deviceId, { originDeviceId: deviceId, ...Object.fromEntries(fields.filter((key) => ledger.refresh[key] !== void 0).map((key) => [key, ledger.refresh[key]])) });
  }
  for (const id of ledger?.agentWrittenPromptIds ?? []) {
    const ref = stableEvidenceRef(database, "prompt", id, deviceId);
    const prompt = get(database, "SELECT p.prompt_number, p.prompt_text, s.platform_source, s.content_session_id, s.user_prompt FROM user_prompts p LEFT JOIN sdk_sessions s ON s.id = p.session_db_id WHERE p.id = ?", [id]);
    if (ref && ref.device === deviceId) add("exclusion", JSON.stringify(ref), { ref, conversation: conversationKey(prompt), opening: prompt?.prompt_number === 1 || Boolean(prompt && prompt.prompt_text === prompt.user_prompt) });
  }
  const sessions = new Map((records2.sessions ?? []).map((row) => [row.id, row]));
  for (const row of records2.productDeliverables ?? []) {
    const key = conversationKey(row);
    if (key && ![...sessions.values()].some((session) => conversationKey(session) === key)) sessions.set(`deliverable:${key}`, { ...row, id: `deliverable:${key}` });
  }
  const work = (view.agents ?? []).flatMap((agent) => agent.work ?? []);
  for (const session of sessions.values()) {
    const key = conversationKey(session);
    if (!key) continue;
    const calls = (records2.calls ?? []).filter((call) => call.session_db_id === session.id);
    const prompts = (records2.prompts ?? []).filter((prompt) => prompt.session_db_id === session.id);
    const ownsPrompt = prompts.some((prompt) => stableEvidenceRef(database, "prompt", prompt.id, deviceId)?.device === deviceId);
    const ownsObservation = [...records2.observations ?? [], ...records2.productObservations ?? []].some((row) => row.memory_session_id === session.memory_session_id && stableEvidenceRef(database, "observation", row.id, deviceId)?.device === deviceId);
    const ownsProduct = (records2.productCalls ?? []).some((call) => call.session_db_id === session.id) || (records2.productDeliverables ?? []).some((row) => conversationKey(row) === key);
    if (!calls.length && !ownsPrompt && !ownsObservation && !ownsProduct) continue;
    const attributions = work.filter((item) => item.attribution?.sessionId === session.id && item.attribution?.linkedEntryId != null).flatMap((item) => {
      const attribution = item.attribution;
      const call = calls.find((candidate) => candidate.id === attribution.toolUseId);
      const ref = stableEvidenceRef(database, "work-state", attribution.linkedEntryId, deviceId);
      return call && ref?.device === deviceId ? [{ work: ref, agentId: call.agent_id ?? null, agentType: call.agent_type ?? null, promptNumber: call.prompt_number ?? null, atEpoch: call.created_at_epoch }] : [];
    });
    const productCandidates = [
      ...(records2.productCalls ?? []).filter((call) => call.session_db_id === session.id).flatMap(productsFromToolUse),
      ...(records2.productObservations ?? []).filter((row) => row.memory_session_id === session.memory_session_id && stableEvidenceRef(database, "observation", row.id, deviceId)?.device === deviceId).flatMap(productsFromObservation),
      ...(records2.productDeliverables ?? []).filter((row) => conversationKey(row) === key).flatMap(productsFromDeliverable),
      ...work.filter((item) => item.attribution?.sessionId === session.id).flatMap((item) => item.workProduct ?? [])
    ];
    const productsByIdentity = /* @__PURE__ */ new Map();
    const copies = productCandidates.filter((product) => product.deliverable && product.sourcePath);
    for (const product of mergeProducts([productCandidates], productCandidates.length)) {
      if (product.path && copies.some((copy) => copy.sourcePath === product.path && copyCoversSource(copy, product.path))) continue;
      const url = sharedPublishedUrl(product.url);
      if (url) productsByIdentity.set(url, {
        kind: product.kind,
        title: product.title,
        url,
        atEpoch: product.atEpoch ?? null,
        ...Object.fromEntries(["sha", "branch", "repo", "heads"].filter((key2) => product[key2] != null).map((key2) => [key2, product[key2]]))
      });
      else if (product.path ? servableFile(product) : product.bucketPath ? bucketFileAvailable(product) : false) {
        const metadata = localFileMetadata(database, product, deviceId);
        if (metadata?.originDeviceId === deviceId) productsByIdentity.set(metadata.productId, metadata);
      }
    }
    const products = [...productsByIdentity.values()];
    const launches = (records2.agentLaunches ?? []).filter((row) => row.content_session_id === session.content_session_id && typeof row.agent_id === "string").map((row) => ({ agent_id: row.agent_id, status: row.status ?? null, is_async: row.is_async ?? null, description: typeof row.description === "string" ? row.description.slice(0, 160) : null, created_at_epoch: row.created_at_epoch ?? null }));
    const activity = (records2.agentToolActivity ?? []).filter((row) => row.content_session_id === session.content_session_id).map((row) => ({ agent_id: row.agent_id, last_epoch: row.last_epoch }));
    const sessionValue = Object.fromEntries(sessionFields.map((field) => [field, clean2(session[field])]));
    sessionValue.project = sharedProjectKey(sessionValue.project);
    const rejectedOpening = prompts.some((prompt) => ledger?.agentWrittenPromptIds?.has(prompt.id) && (prompt.prompt_number === 1 || prompt.prompt_text === session.user_prompt));
    sessionValue.user_prompt = rejectedOpening ? null : requestText(session.user_prompt, 1200);
    if (typeof sessionValue.custom_title === "string") sessionValue.custom_title = sessionValue.custom_title.slice(0, 120);
    add("provenance", key, { session: sessionValue, attributions, products, launches, activity });
  }
  for (const request of view.humanRequests ?? []) {
    const entry = copyEntries instanceof Map ? copyEntries.get(request.id) : copyEntries[request.id];
    if (!entry?.copy) continue;
    try {
      const legacyValue = (value) => Array.isArray(value) ? value.map(legacyValue) : object2(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !["stableId", "stableIdentity"].includes(key)).map(([key, item]) => [key, legacyValue(item)])) : value;
      const plainRequest = legacyValue(request);
      const plainInput = createHumanCopyInput(plainRequest);
      const stableInput = createHumanCopyInput(request);
      if (![humanCopyFingerprint(plainInput), humanCopyFingerprint(stableInput)].includes(entry.fingerprint)) continue;
      validateHumanCopy(entry.copy, entry.fingerprint === humanCopyFingerprint(plainInput) ? plainInput : stableInput);
      const stableById = new Map((request.workstreams ?? []).map((stream) => [stream.id, stream.stableId ?? stream.id]));
      const copy = { ...entry.copy, workstreams: entry.copy.workstreams.map((stream) => ({ ...stream, id: stableById.get(stream.id) ?? stream.id })) };
      validateHumanCopy(copy, stableInput);
      add("copy", request.id, { fingerprint: humanCopyFingerprint(stableInput), copy, generatedAt: entry.generatedAt ?? null });
    } catch {
    }
  }
  return updates;
}
function applySharedProjection(database, shared, { ledger = null, records: records2 = {}, deviceId = "" } = {}) {
  const next = {
    ...emptyLedger(),
    ...ledger,
    groups: { ...emptyLedger().groups, ...ledger?.groups, groups: { ...ledger?.groups?.groups }, conversations: { ...ledger?.groups?.conversations }, ignored: { ...ledger?.groups?.ignored }, suggestions: { ...ledger?.groups?.suggestions } },
    progress: { ...ledger?.progress },
    agentWrittenPromptIds: new Set(ledger?.agentWrittenPromptIds ?? [])
  };
  const copyEntries = /* @__PURE__ */ new Map();
  const excludedOpenings = /* @__PURE__ */ new Set();
  const merged = { ...records2, sessions: [...records2.sessions ?? []], sharedAttributions: /* @__PURE__ */ new Map(), sharedProducts: [], agentLaunches: [...records2.agentLaunches ?? []], agentToolActivity: [...records2.agentToolActivity ?? []] };
  const ordered = values(shared).sort((a, b) => {
    const left = BigInt(a.revision ?? "0"), right = BigInt(b.revision ?? "0");
    return left < right ? -1 : left > right ? 1 : binaryOrder(String(a.writer), String(b.writer)) || binaryOrder(a.kind, b.kind) || binaryOrder(a.key, b.key);
  });
  const claims = /* @__PURE__ */ new Map();
  for (const record of ordered) if (record.kind === "group" && !record.deleted && Array.isArray(record.value?.members)) {
    for (const member of record.value.members) {
      if (!claims.has(member)) claims.set(member, []);
      claims.get(member).push(record);
    }
  }
  const membershipConflicts = [...claims].filter(([, records3]) => records3.length > 1).map(([key, records3]) => ({
    kind: "group-membership",
    key,
    revision: records3.at(-1).revision,
    writers: [...new Set(records3.map((record) => record.writer))].sort(binaryOrder),
    groups: records3.map((record) => record.key).sort(binaryOrder),
    selectedGroup: records3.at(-1).key
  })).sort((left, right) => binaryOrder(left.key, right.key));
  const diagnostics = {
    ...shared?.diagnostics ?? { pending: 0, invalid: 0, unsupported: 0, conflicts: [] },
    conflicts: [...shared?.diagnostics?.conflicts ?? [], ...membershipConflicts],
    membershipConflicts
  };
  for (const record of ordered) {
    const value = localWorkValue(database, record.value, deviceId);
    if (record.kind === "group") {
      for (const [key, group] of Object.entries(next.groups.conversations)) if (group === record.key) delete next.groups.conversations[key];
      for (const [key, suggestion] of Object.entries(next.groups.suggestions)) if (suggestion.requestId === record.key) delete next.groups.suggestions[key];
      if (record.deleted) delete next.groups.groups[record.key];
      else if (value?.group && Array.isArray(value.members)) {
        next.groups.groups[record.key] = value.group;
        for (const key of value.members) {
          next.groups.conversations[key] = record.key;
          delete next.groups.ignored[key];
        }
        Object.assign(next.groups.suggestions, value.suggestions ?? {});
      }
    } else if (record.kind === "progress") {
      if (record.deleted) delete next.progress[record.key];
      else next.progress[record.key] = value;
    } else if (record.kind === "ignored") {
      if (record.deleted) delete next.groups.ignored[record.key];
      else next.groups.ignored[record.key] = value;
    } else if (record.kind === "story" && record.key === "current") next.story = record.deleted ? null : value;
    else if (record.kind === "refresh" && record.writer !== deviceId) {
      if (record.deleted) {
        if (next.refresh?.originDeviceId === record.key) next.refresh = null;
      } else if (!next.refresh || !Number.isFinite(Date.parse(next.refresh.startedAt ?? next.refresh.checkedAt ?? "")) || Date.parse(value.finishedAt ?? value.checkedAt ?? value.startedAt ?? "") > Date.parse(next.refresh.finishedAt ?? next.refresh.checkedAt ?? next.refresh.startedAt ?? "")) next.refresh = value;
    } else if (record.kind === "exclusion") {
      let ref = value?.ref;
      if (!ref) {
        try {
          ref = JSON.parse(record.key);
        } catch {
        }
      }
      const id = resolveEvidenceRef(database, ref, deviceId);
      if (id != null) {
        if (record.deleted) next.agentWrittenPromptIds.delete(id);
        else next.agentWrittenPromptIds.add(id);
      }
      if (!record.deleted && value?.opening && value.conversation) excludedOpenings.add(value.conversation);
    } else if (record.kind === "copy") copyEntries.set(record.key, record.deleted ? { deleted: true } : value);
    else if (record.kind === "provenance" && !record.deleted && value?.session) {
      const key = conversationKey(value.session);
      if (key !== record.key) continue;
      let session = merged.sessions.find((row) => conversationKey(row) === key);
      if (session) session = record.writer === deviceId ? { ...value.session, ...session } : { ...session, ...value.session };
      else session = { ...value.session, id: `shared:${key}`, sharedOnly: true };
      merged.sessions = merged.sessions.filter((row) => conversationKey(row) !== key);
      merged.sessions.push(session);
      for (const attribution of value.attributions ?? []) {
        const id = resolveEvidenceRef(database, attribution.work, deviceId);
        if (id != null) merged.sharedAttributions.set(id, { ...attribution, session_db_id: session.id, memory_session_id: session.memory_session_id, content_session_id: session.content_session_id, agent_id: attribution.agentId, agent_type: attribution.agentType, prompt_number: attribution.promptNumber, created_at_epoch: attribution.atEpoch, shared: true });
      }
      merged.sharedProducts.push({ conversationKey: key, products: (value.products ?? []).filter((product) => sharedProduct(product) && (product.availability !== "origin-only" || product.originDeviceId === record.writer)) });
      for (const launch of value.launches ?? []) if (!merged.agentLaunches.some((row) => row.content_session_id === session.content_session_id && row.agent_id === launch.agent_id)) merged.agentLaunches.push({ ...launch, content_session_id: session.content_session_id, shared: true });
      for (const activity of value.activity ?? []) if (!merged.agentToolActivity.some((row) => row.content_session_id === session.content_session_id && row.agent_id === activity.agent_id)) merged.agentToolActivity.push({ ...activity, content_session_id: session.content_session_id });
    }
  }
  const referencedGroups = new Set(Object.values(next.groups.conversations));
  for (const groupId of Object.keys(next.groups.groups)) if (!referencedGroups.has(groupId)) delete next.groups.groups[groupId];
  for (const session of merged.sessions) if ((merged.prompts ?? []).some((prompt) => prompt.session_db_id === session.id && next.agentWrittenPromptIds.has(prompt.id) && (prompt.prompt_number === 1 || prompt.prompt_text === session.user_prompt))) excludedOpenings.add(conversationKey(session));
  merged.sessions = merged.sessions.map((session) => excludedOpenings.has(conversationKey(session)) ? { ...session, user_prompt: null } : session);
  merged.prompts = (merged.prompts ?? []).filter((prompt) => !next.agentWrittenPromptIds.has(prompt.id));
  return { ledger: next, records: merged, copyEntries, diagnostics };
}
function decorateSharedView(view, { database = null, deviceId = "", records: records2 = {}, copyEntries = /* @__PURE__ */ new Map() } = {}) {
  const agents = new Map((view.agents ?? []).map((agent) => [agent.id, agent]));
  const identity = (value) => {
    if (!value || !database) return;
    const kind = SOURCE_KINDS[value.source] ?? value.kind;
    value.stableIdentity = value.sourceIdentity ?? value.identity ?? stableEvidenceRef(database, kind, value.sourceId ?? value.id, deviceId);
  };
  for (const request of view.humanRequests ?? []) {
    const products = /* @__PURE__ */ new Map();
    for (const product of request.workProduct ?? []) {
      let next = product;
      if (product.path || product.bucketPath) {
        const metadata = localFileMetadata(database, product, deviceId);
        if (metadata) next = metadata.originDeviceId === deviceId ? { ...product, productId: metadata.productId, originDeviceId: deviceId } : { ...metadata, available: false };
      } else if (product.availability === "origin-only") next = { ...product, url: void 0, fileUrl: void 0, available: false };
      const key = next.productId ?? next.url ?? next.path ?? `${next.kind}:${next.title}`;
      const previous = products.get(key);
      if (!previous || previous.availability === "origin-only" && next.availability !== "origin-only") products.set(key, next);
    }
    request.workProduct = [...products.values()];
    identity(request.original);
    for (const update of request.scopeUpdates ?? []) identity(Object.assign(update, { source: "user-prompt" }));
    for (const stream of request.workstreams ?? []) {
      if (stream.id === stream.items?.[0]?.listId) stream.stableId = stream.id;
      else {
        const agent = agents.get(stream.agentIds?.[0]);
        stream.stableId = JSON.stringify(["agent-session", agent?.platformSource ?? "", agent?.contentSessionId ?? "", agent?.agentId ?? ""]);
      }
      for (const item of stream.items ?? []) for (const ref of item.sourceRefs ?? []) identity(ref);
      for (const activity of stream.activity ?? []) identity(activity.sourceRef);
    }
    const copy = copyEntries.get(request.id);
    if (copy?.deleted) request.sharedHumanCopyDisabled = true;
    else if (copy) request.sharedHumanCopy = copy;
  }
  return view;
}

// src/services/work-view/shared-record-store.mjs
init_CanonicalContent();
init_shared_records();
import { randomUUID as randomUUID2 } from "node:crypto";

// src/services/work-view/shared-redaction.mjs
init_CanonicalContent();
init_redaction();
init_shared_records();
var TABLE = "local_shared_work_redactions";
function assertSharedMetadataRedactionSafe(fields, project = void 0) {
  const config = getRedactionConfig();
  if (project !== void 0 && redactJsonStrings(project, config) !== project) {
    throw new TypeError("Shared My Work: redaction would change a project identity");
  }
  const identity = { ...fields };
  delete identity.payload;
  if (canonicalJson(redactJsonStrings(identity, config)) !== canonicalJson(identity)) {
    throw new TypeError("Shared My Work: redaction would change a protocol identity");
  }
  if (fields.record !== "entry" && canonicalJson(redactJsonStrings(JSON.parse(fields.payload), config)) !== fields.payload) {
    throw new TypeError("Shared My Work: redaction would change a manifest identity");
  }
}
function readSharedRedactionReceipts(db) {
  try {
    return new Map(db.prepare(`SELECT * FROM ${TABLE}`).all().map((row) => [String(row.row_id), row]));
  } catch (error) {
    if (/no such table/i.test(String(error.message))) return /* @__PURE__ */ new Map();
    throw error;
  }
}
function redactSharedValue(value) {
  return redactJsonStrings(value, getRedactionConfig());
}

// src/services/work-view/shared-record-store.mjs
var compareText = (a, b) => a === b ? 0 : a < b ? -1 : 1;
function readSharedRecords(db, { deviceId, validateValue, rows: suppliedRows, includeHistory = false }) {
  const records2 = /* @__PURE__ */ new Map();
  const heads = /* @__PURE__ */ new Map();
  const history = includeHistory ? /* @__PURE__ */ new Map() : void 0;
  const diagnostics = { pending: 0, invalid: 0, unsupported: 0, conflicts: [] };
  let rows;
  try {
    rows = suppliedRows ?? db.prepare("SELECT id, list_name, fields, origin_device_id, origin_local_id, sync_rev FROM work_state_entries WHERE list_name GLOB '__my_work_v[0-9]*:*'").all();
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return { records: records2, heads, ...history ? { history } : {}, revision: sha256Base64Url("[]"), diagnostics };
    throw error;
  }
  const batches = /* @__PURE__ */ new Map();
  let redactionReceipts;
  for (const row of rows) {
    if (!isSharedWorkList(row.list_name)) continue;
    let record;
    try {
      record = parseSharedRow(row, deviceId);
    } catch {
      redactionReceipts ??= readSharedRedactionReceipts(db);
      const receipt = redactionReceipts.get(String(row.id));
      if (!receipt) {
        diagnostics.invalid++;
        continue;
      }
      try {
        record = parseSharedRow(row, deviceId, { redactionReceipt: receipt });
      } catch {
        diagnostics.invalid++;
        continue;
      }
    }
    if (!record) continue;
    if (record.unsupported) {
      diagnostics.unsupported++;
      continue;
    }
    const id = canonicalJson([record.writer, record.batch]);
    let batch = batches.get(id);
    if (!batch) {
      batch = { entries: /* @__PURE__ */ new Map(), manifests: /* @__PURE__ */ new Map(), commits: /* @__PURE__ */ new Map(), invalid: false };
      batches.set(id, batch);
    }
    const map = record.record === "entry" ? batch.entries : record.record === "manifest" ? batch.manifests : batch.commits;
    const key = record.record === "entry" ? sharedRecordKey(record.kind, record.key) : record.record === "manifest" ? record.part : record.hash;
    const previous = map.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(record)) batch.invalid = true;
    map.set(key, record);
  }
  const candidates = /* @__PURE__ */ new Map();
  for (const batch of batches.values()) {
    if (batch.invalid || batch.commits.size > 1) {
      diagnostics.invalid++;
      continue;
    }
    const commit = [...batch.commits.values()][0];
    if (!commit) {
      diagnostics.pending++;
      continue;
    }
    const entries = [];
    let incomplete = false, invalid = false;
    for (let index = 0; index < commit.parts.length; index++) {
      const manifest = batch.manifests.get(index);
      if (!manifest) {
        incomplete = true;
        break;
      }
      if (manifest.hash !== commit.parts[index]) {
        invalid = true;
        break;
      }
      for (const ref of manifest.refs) {
        const entry = batch.entries.get(sharedRecordKey(ref.kind, ref.key));
        if (!entry) {
          incomplete = true;
          break;
        }
        if (canonicalJson(sharedEntryRef(entry)) !== canonicalJson(ref)) {
          invalid = true;
          break;
        }
        entries.push(entry);
      }
    }
    if (invalid) {
      diagnostics.invalid++;
      continue;
    }
    if (incomplete) {
      diagnostics.pending++;
      continue;
    }
    if (entries.length !== commit.count || batch.entries.size !== commit.count || batch.manifests.size !== commit.parts.length || new Set(entries.map((entry) => sharedRecordKey(entry.kind, entry.key))).size !== entries.length) {
      diagnostics.invalid++;
      continue;
    }
    if (validateValue) {
      let valid = true;
      try {
        valid = entries.every((entry) => validateValue(entry.kind, entry.key, entry.value, entry.deleted, entry.writer) === true);
      } catch {
        valid = false;
      }
      if (!valid) {
        diagnostics.invalid++;
        continue;
      }
    }
    for (const entry of entries) {
      const identity = sharedRecordKey(entry.kind, entry.key);
      if (!candidates.has(identity)) candidates.set(identity, []);
      candidates.get(identity).push(entry);
    }
  }
  for (const [identity, entries] of [...candidates].sort(([a], [b]) => compareText(a, b))) {
    entries.sort((a, b) => compareCanonicalDecimals(a.revision, b.revision) || compareText(a.writer, b.writer) || compareText(a.batch, b.batch));
    const latest = entries.at(-1);
    const sameRevision = entries.filter((entry) => entry.revision === latest.revision);
    const recordOf = (entry) => ({
      kind: entry.kind,
      key: entry.key,
      value: entry.value,
      deleted: entry.deleted,
      revision: entry.revision,
      writer: entry.writer,
      hash: entry.hash,
      batchId: entry.batch,
      base: entry.base,
      valueHash: sharedValueHash(entry.kind, entry.key, entry.value, entry.deleted)
    });
    heads.set(identity, sameRevision.map(recordOf));
    if (history && latest.kind === "group") history.set(identity, entries.map(recordOf));
    if (new Set(sameRevision.map((entry) => entry.hash)).size > 1) {
      diagnostics.conflicts.push({
        kind: latest.kind,
        key: latest.key,
        revision: latest.revision,
        writers: [...new Set(sameRevision.map((entry) => entry.writer))].sort()
      });
    }
    records2.set(identity, {
      kind: latest.kind,
      key: latest.key,
      value: latest.value,
      deleted: latest.deleted,
      revision: latest.revision,
      writer: latest.writer,
      hash: latest.hash,
      valueHash: sharedValueHash(latest.kind, latest.key, latest.value, latest.deleted),
      batchId: latest.batch,
      base: latest.base
    });
  }
  diagnostics.conflicts.sort((a, b) => compareText(sharedRecordKey(a.kind, a.key), sharedRecordKey(b.kind, b.key)));
  const revision = sha256Base64Url(canonicalJson([...records2].sort(([a], [b]) => compareText(a, b)).map(([key, record]) => [
    key,
    record.revision,
    record.writer,
    record.hash,
    record.valueHash,
    heads.get(key).map((head) => [head.hash, head.valueHash]).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)))
  ])));
  return { records: records2, heads, ...history ? { history } : {}, revision, diagnostics };
}
function publishSharedRecords(db, { deviceId, project, updates, now = Date.now(), validateValue }) {
  sharedWriter(deviceId);
  if (typeof project !== "string" || !project.trim() || project.length > 1024) throw new TypeError("Shared My Work: invalid project");
  if (!Array.isArray(updates) || updates.length > SHARED_WORK_MAX_UPDATES) throw new RangeError("Shared My Work: too many updates");
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new TypeError("Shared My Work: invalid timestamp");
  return db.transaction(() => {
    const state = readSharedRecords(db, { deviceId, validateValue });
    const batchId = randomUUID2();
    const entries = [], seen = /* @__PURE__ */ new Set();
    for (const update of updates) {
      const identity = sharedIdentity(update.kind, update.key);
      if (seen.has(identity)) throw new TypeError("Shared My Work: duplicate update");
      seen.add(identity);
      const previous = state.records.get(identity);
      if (Object.hasOwn(update, "expectedHash") && update.expectedHash !== (previous?.hash ?? null)) throw new Error("Shared My Work: changed since read");
      const deleted = update.deleted === true;
      const value = deleted ? null : redactSharedValue(update.value);
      if (validateValue && validateValue(update.kind, update.key, value, deleted, deviceId) !== true) throw new TypeError("Shared My Work: invalid object value");
      const conflicted = state.diagnostics.conflicts.some((conflict) => sharedRecordKey(conflict.kind, conflict.key) === identity);
      if (!conflicted && (previous?.valueHash ?? previous?.hash) === sharedValueHash(update.kind, update.key, value, deleted)) continue;
      if (!previous && deleted) continue;
      if (conflicted && !Object.hasOwn(update, "expectedHash")) throw new Error("Shared My Work: unresolved conflict requires expectedHash");
      entries.push(createSharedEntry({
        batchId,
        writer: deviceId,
        kind: update.kind,
        key: update.key,
        revision: incrementCanonicalDecimal(previous?.revision ?? "0"),
        base: previous?.hash ?? null,
        value,
        deleted
      }));
    }
    if (!entries.length) return { changed: 0, rowIds: [], batchId: null };
    const rows = createSharedBatch(entries, { batchId, writer: deviceId });
    for (const row of rows) assertSharedMetadataRedactionSafe(row.fields, project);
    const insert = db.prepare("INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?)");
    try {
      const rowIds = rows.map((row) => Number(insert.run(project, row.listName, canonicalJson(row.fields), new Date(now).toISOString(), now).lastInsertRowid));
      return { changed: entries.length, rowIds, batchId };
    } finally {
      insert.finalize();
    }
  })();
}

// src/services/work-view/shared-ledger-adapter.mjs
init_shared_records();
init_CanonicalContent();
init_redaction();
var digest = (value) => createHash7("sha256").update(canonicalJson(value ?? null)).digest("hex");
var MAX_FILE_BYTES = 8 * 1024 * 1024;
var fixedFiles = ["request-groups.json", "story.json", "refresh.json", "agent-written-prompts.json"];
var fileKinds = (name) => name === "request-groups.json" ? ["group", "ignored"] : name === "story.json" ? ["story"] : name === "refresh.json" ? ["refresh"] : name === "agent-written-prompts.json" ? ["exclusion"] : /^progress\/g_[a-f0-9]{12}\.json$/.test(name) ? ["progress"] : [];
function load(path4) {
  try {
    const raw = readFileSync11(path4);
    if (raw.byteLength > MAX_FILE_BYTES) throw new RangeError("Shared My Work file is over the local import limit");
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function rawWrite(path4, value) {
  mkdirSync6(join11(path4, ".."), { recursive: true });
  const temp = `${path4}.${process.pid}.shared.tmp`;
  try {
    writeFileSync4(temp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
    renameSync4(temp, path4);
  } finally {
    try {
      unlinkSync2(temp);
    } catch {
    }
  }
}
var SharedLedgerAdapter = class {
  constructor(db, { directory, deviceId, project = "__my_work__", notify = () => {
  } }) {
    Object.assign(this, { db, directory, deviceId, project, notify });
    this.errors = [];
    this.activity = null;
    this.copyHash = null;
    this.sharedRevision = null;
    this.storyHash = null;
    this.lastSignature = null;
    this.lastDiagnostic = null;
    db.exec(`CREATE TABLE IF NOT EXISTS my_work_file_state (
      name TEXT PRIMARY KEY, observed_hash TEXT, bases TEXT NOT NULL DEFAULT '{}',
      keys_json TEXT NOT NULL DEFAULT '[]', pending_json TEXT, pending_delete INTEGER NOT NULL DEFAULT 0
    )`);
    if (!db.prepare("PRAGMA table_info(my_work_file_state)").all().some((row) => row.name === "pending_delete")) db.exec("ALTER TABLE my_work_file_state ADD COLUMN pending_delete INTEGER NOT NULL DEFAULT 0");
  }
  state(name) {
    const row = this.db.prepare("SELECT * FROM my_work_file_state WHERE name = ?").get(name);
    return row ? { ...row, bases: JSON.parse(row.bases), keys: JSON.parse(row.keys_json) } : { observed_hash: null, bases: {}, keys: [], pending_json: null };
  }
  pendingMaterialization() {
    return this.db.prepare("SELECT COUNT(*) AS count FROM my_work_file_state WHERE pending_json IS NOT NULL").get().count;
  }
  shared() {
    return readSharedRecords(this.db, { deviceId: this.deviceId, validateValue: isSharedProjectionValue });
  }
  tombstoneKeys(name, shared) {
    const kinds = fileKinds(name);
    return [...shared.records].filter(([, record]) => record.deleted && kinds.includes(record.kind) && (record.kind !== "progress" || record.key === name.slice(9, -5)) && (record.kind !== "refresh" || record.key === this.deviceId)).map(([key]) => key);
  }
  remember(name, value, updates, shared, pending, pendingDelete = false) {
    value = redactJsonStrings(value);
    const prior = this.state(name);
    const keys = updates.map((update) => sharedRecordKey(update.kind, update.key));
    const knownKeys = /* @__PURE__ */ new Set([...Object.keys(prior.bases), ...prior.keys, ...keys, ...this.tombstoneKeys(name, shared)]);
    const bases = Object.fromEntries([...knownKeys].map((key) => [key, shared.records.get(key)?.hash ?? prior.bases[key] ?? null]));
    this.db.prepare(`INSERT INTO my_work_file_state(name, observed_hash, bases, keys_json, pending_json, pending_delete) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET observed_hash=excluded.observed_hash, bases=excluded.bases,
      keys_json=excluded.keys_json, pending_json=excluded.pending_json, pending_delete=excluded.pending_delete`).run(name, pending ? prior.observed_hash ?? digest(load(join11(this.directory, name))) : digest(value), JSON.stringify(bases), JSON.stringify(keys), pending ? JSON.stringify(value) : null, Number(pending && pendingDelete));
  }
  localLedger() {
    try {
      return readLedger(this.directory);
    } catch {
      const safe = (name, fallback) => {
        try {
          return load(join11(this.directory, name)) ?? fallback;
        } catch {
          return fallback;
        }
      };
      const groups = safe("request-groups.json", { groups: {}, conversations: {}, ignored: {} });
      const progress = {};
      try {
        for (const name of readdirSync2(join11(this.directory, "progress"))) if (/^g_[a-f0-9]{12}\.json$/.test(name)) {
          const value = safe(`progress/${name}`, null);
          if (value) progress[name.slice(0, -5)] = value;
        }
      } catch {
      }
      return {
        groups,
        progress,
        story: safe("story.json", null),
        refresh: safe("refresh.json", null),
        agentWrittenPromptIds: new Set(safe("agent-written-prompts.json", {}).promptIds ?? [])
      };
    }
  }
  signature(captureActivity) {
    const names = [...fixedFiles, "human-copy.json"];
    try {
      names.push(...readdirSync2(join11(this.directory, "progress")).filter((name) => /^g_[a-f0-9]{12}\.json$/.test(name)).map((name) => `progress/${name}`));
    } catch {
    }
    const files = names.sort().map((name) => {
      try {
        const stat = statSync7(join11(this.directory, name));
        return [name, stat.ino, stat.size, stat.mtimeMs];
      } catch {
        return [name, "missing"];
      }
    });
    return JSON.stringify([this.db.prepare("PRAGMA data_version").get(), captureActivity, files]);
  }
  updatesForFile(name, value) {
    const kinds = fileKinds(name);
    if (!kinds.length) return [];
    const object3 = (item) => item !== null && typeof item === "object" && !Array.isArray(item);
    if (value !== null && !object3(value)) throw new TypeError("Shared My Work file must contain an object");
    if (name === "request-groups.json" && value !== null && (!object3(value.groups) || !object3(value.conversations) || value.ignored !== void 0 && !object3(value.ignored) || value.suggestions !== void 0 && !object3(value.suggestions))) {
      throw new TypeError("Shared request groups have an invalid shape");
    }
    if (name.startsWith("progress/") && value !== null && value.groupId !== name.slice(9, -5)) throw new TypeError("Shared progress names a different group");
    if (name === "agent-written-prompts.json" && value !== null && (!Array.isArray(value.promptIds) || value.promptIds.some((id) => !Number.isSafeInteger(id) || id <= 0))) throw new TypeError("Shared prompt exclusions have an invalid shape");
    const ledger = this.localLedger();
    if (name === "request-groups.json") ledger.groups = value ?? { groups: {}, conversations: {}, ignored: {} };
    else if (name === "story.json") ledger.story = value ?? null;
    else if (name === "refresh.json") ledger.refresh = value ?? null;
    else if (name === "agent-written-prompts.json") ledger.agentWrittenPromptIds = new Set(value?.promptIds ?? []);
    else {
      const id = name.slice("progress/".length, -5);
      ledger.progress = { ...ledger.progress };
      if (value == null) delete ledger.progress[id];
      else ledger.progress[id] = value;
    }
    return buildSharedProjectionUpdates(this.db, { ledger, deviceId: this.deviceId }).filter((update) => kinds.includes(update.kind) && (kinds[0] !== "progress" || update.key === name.slice(9, -5)));
  }
  /** Stage canonical rows and their recovery intent without touching files or notifying observers. */
  stageFile(name, value, { resolveKeys = [], resolutionBaseline } = {}) {
    if (!fileKinds(name).length) return null;
    value = redactJsonStrings(value);
    const updates = this.updatesForFile(name, value);
    let changed = null;
    this.db.transaction(() => {
      const prior = this.state(name);
      const shared = this.shared();
      const diagnostics = applySharedProjection(this.db, shared, { ledger: this.localLedger(), deviceId: this.deviceId }).diagnostics;
      const conflicted = new Set(diagnostics.conflicts.flatMap((entry) => entry.kind === "group-membership" ? entry.groups.map((group) => sharedRecordKey("group", group)) : [sharedRecordKey(entry.kind, entry.key)]));
      const resolving = new Set(resolveKeys.map((key) => sharedRecordKey("group", key)));
      if (resolving.size && name !== "request-groups.json") throw new TypeError("Only explicit grouping decisions can resolve group conflicts");
      if (resolving.size) {
        if (!resolutionBaseline) throw new TypeError("Explicit grouping resolution requires its canonical baseline");
        const baseline = new Map(this.updatesForFile(name, resolutionBaseline).filter((update) => update.kind === "group").map((update) => [sharedRecordKey(update.kind, update.key), sharedValueHash(update.kind, update.key, update.value, update.deleted)]));
        const desired = new Map(updates.filter((update) => update.kind === "group").map((update) => [sharedRecordKey(update.kind, update.key), sharedValueHash(update.kind, update.key, update.value, update.deleted)]));
        for (const key of /* @__PURE__ */ new Set([...baseline.keys(), ...desired.keys()])) {
          if (!resolving.has(key) && baseline.get(key) !== desired.get(key)) throw new Error("Shared My Work: resolution changed an unrelated group");
        }
      }
      const nextKeys = new Set(updates.map((update) => sharedRecordKey(update.kind, update.key)));
      const changes = updates.flatMap((update) => {
        const key = sharedRecordKey(update.kind, update.key);
        if (resolving.size && update.kind === "group" && !resolving.has(key)) return [];
        const existing = shared.records.get(key);
        if (conflicted.has(key) && !resolving.has(key)) {
          throw new Error("Shared My Work has a conflicting decision; retained the local file");
        }
        return [{ ...update, expectedHash: resolving.has(key) ? existing?.hash ?? null : prior.bases[key] ?? null }];
      });
      for (const key of /* @__PURE__ */ new Set([...prior.keys, ...resolving])) if (!nextKeys.has(key)) {
        const existing = shared.records.get(key);
        if (existing) {
          if (resolving.size && existing.kind === "group" && !resolving.has(key)) continue;
          if (conflicted.has(key) && !resolving.has(key)) {
            if (existing.deleted) continue;
            throw new Error("Shared My Work has a conflicting decision; retained the local file");
          }
          changes.push({ kind: existing.kind, key: existing.key, deleted: true, expectedHash: resolving.has(key) ? existing.hash : prior.bases[key] ?? null });
        }
      }
      for (const change of changes) {
        const key = sharedRecordKey(change.kind, change.key);
        const existing = shared.records.get(key);
        if (!Object.hasOwn(prior.bases, key) && existing && sharedValueHash(change.kind, change.key, change.value, change.deleted) === (existing.valueHash ?? existing.hash)) change.expectedHash = existing.hash;
      }
      const result = publishSharedRecords(this.db, { deviceId: this.deviceId, project: this.project, updates: changes, validateValue: isSharedProjectionValue });
      this.remember(name, value, updates, this.shared(), true, value === null);
      if (result.changed) changed = { rules: changes.some((change) => change.kind === "story") };
    })();
    return { name, value, updates, changed, notified: false };
  }
  notifyCommitted(stage) {
    if (this.db.inTransaction) throw new Error("Shared My Work: the outer transaction has not committed");
    this.lastSignature = null;
    if (!stage?.changed || stage.notified) return;
    stage.notified = true;
    try {
      this.notify(stage.changed);
    } catch {
      this.lastDiagnostic = null;
    }
  }
  /** After the owning transaction commits, materialize its durable recovery intent. */
  materializeFile(stage) {
    this.notifyCommitted(stage);
    if (!stage) return { materialization: "complete" };
    const { name, value, updates } = stage;
    try {
      return { materialization: this.completePending(name, value, updates) ? "complete" : "pending" };
    } catch {
      return { materialization: "pending" };
    }
  }
  /**
   * Replace the file and clear the receipt only if `value` is still the pending
   * intent. The write lock is held throughout, so a writer on another connection
   * commits fully before this check or after this commit, never in between.
   */
  completePending(name, value, updates, shared) {
    return this.db.transaction(() => {
      if (this.state(name).pending_json !== JSON.stringify(redactJsonStrings(value))) return false;
      if (value === null) {
        try {
          unlinkSync2(join11(this.directory, name));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      } else rawWrite(join11(this.directory, name), value);
      this.remember(name, value, updates, shared ?? this.shared(), false);
      return true;
    }).immediate();
  }
  /**
   * Record the intent to materialize a projection. Skips when a writer on another
   * connection owns the file or has changed its records since `shared` was read;
   * that writer's newer value wins and the next reconcile projects from it.
   */
  stageProjection(name, value, updates, shared, pendingDelete = false) {
    const recordHashes = (source) => {
      const kinds = fileKinds(name);
      return JSON.stringify([...source.records].filter(([, record]) => kinds.includes(record.kind)).map(([key, record]) => [key, record.hash]).sort());
    };
    return this.db.transaction(() => {
      if (this.state(name).pending_json !== null || recordHashes(this.shared()) !== recordHashes(shared)) return false;
      this.remember(name, value, updates, shared, true, pendingDelete);
      return true;
    }).immediate();
  }
  /** Finish an interrupted write. Runs under the write lock so it always finishes the newest intent. */
  finishPendingFile(name) {
    return this.db.transaction(() => {
      const prior = this.state(name);
      const current = load(join11(this.directory, name));
      if (prior.pending_json === null) return current;
      const originallyPending = JSON.parse(prior.pending_json);
      const pending = redactJsonStrings(originallyPending);
      if (current !== void 0 && digest(current) !== prior.observed_hash && digest(current) !== digest(originallyPending) && digest(current) !== digest(pending)) throw new Error("Local file changed during an unfinished shared write");
      if (prior.pending_delete) {
        try {
          unlinkSync2(join11(this.directory, name));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      } else rawWrite(join11(this.directory, name), pending);
      this.remember(name, pending, this.updatesForFile(name, pending), this.shared(), false);
      return pending;
    }).immediate();
  }
  /** Called before an external writer replaces its file; finalization follows rename. */
  beforeWrite(name, value, options) {
    if (this.db.inTransaction) throw new Error("Shared My Work: stage file writes until the outer transaction commits");
    const stage = this.stageFile(name, value, options);
    if (!stage) return null;
    this.notifyCommitted(stage);
    return Object.assign(() => this.remember(name, stage.value, stage.updates, this.shared(), false), { value: stage.value });
  }
  saveFile(name, value, options) {
    if (!fileKinds(name).length) throw new TypeError("Unsupported shared My Work file");
    const finish = this.beforeWrite(name, value, options);
    rawWrite(join11(this.directory, name), finish && Object.hasOwn(finish, "value") ? finish.value : value);
    finish?.();
  }
  publish(updates) {
    let changed = 0;
    const shared = this.shared();
    const conflicted = new Set(shared.diagnostics.conflicts.map((entry) => sharedRecordKey(entry.kind, entry.key)));
    if (updates.some((update) => conflicted.has(sharedRecordKey(update.kind, update.key)))) {
      throw new Error("Shared My Work has a conflicting decision; retained the previous complete state");
    }
    const safe = updates;
    for (let offset = 0; offset < safe.length; offset += 512) {
      changed += publishSharedRecords(this.db, { deviceId: this.deviceId, project: this.project, updates: safe.slice(offset, offset + 512), validateValue: isSharedProjectionValue }).changed;
    }
    if (changed) this.notify({ rules: safe.some((update) => update.kind === "story") });
    if (changed) this.lastSignature = null;
    return changed;
  }
  reconcile({ captureActivity = true } = {}) {
    const signature = this.signature(captureActivity);
    if (signature === this.lastSignature && this.lastDiagnostic) return this.lastDiagnostic;
    this.errors = [];
    const names = [.../* @__PURE__ */ new Set([...fixedFiles, ...this.db.prepare("SELECT name FROM my_work_file_state").all().map((row) => row.name)])];
    try {
      names.push(...readdirSync2(join11(this.directory, "progress")).filter((name) => /^g_[a-f0-9]{12}\.json$/.test(name)).map((name) => `progress/${name}`));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of names) {
      try {
        let current = this.state(name).pending_json !== null ? this.finishPendingFile(name) : load(join11(this.directory, name));
        if ((current !== void 0 || this.state(name).observed_hash !== null) && digest(current) !== this.state(name).observed_hash) {
          const finish = this.beforeWrite(name, current ?? null);
          if (finish && Object.hasOwn(finish, "value") && digest(current) !== digest(finish.value)) {
            rawWrite(join11(this.directory, name), finish.value);
            current = finish.value;
          }
          finish?.();
        }
      } catch (error) {
        this.errors.push({ file: name, message: String(error.message) });
      }
    }
    const shared = this.shared();
    let projectionSuperseded = false;
    let ledger = this.localLedger();
    const applied = applySharedProjection(this.db, shared, { ledger, deviceId: this.deviceId });
    ledger = applied.ledger;
    const materialized = {
      "request-groups.json": ledger.groups,
      "story.json": ledger.story,
      "agent-written-prompts.json": { promptIds: [...ledger.agentWrittenPromptIds].sort((a, b) => a - b) }
    };
    for (const [id, progress] of Object.entries(ledger.progress)) materialized[`progress/${id}.json`] = progress;
    for (const [name, value] of Object.entries(materialized)) {
      if (value == null || this.errors.some((error) => error.file === name)) continue;
      const kinds = fileKinds(name);
      if (!shared.records.size || ![...shared.records.values()].some((record) => kinds.includes(record.kind))) continue;
      if (digest(load(join11(this.directory, name))) === digest(value)) {
        const prior = this.state(name);
        if (this.tombstoneKeys(name, shared).some((key) => prior.bases[key] !== shared.records.get(key).hash)) {
          this.remember(name, value, this.updatesForFile(name, value), shared, false);
        }
        continue;
      }
      const updates = this.updatesForFile(name, value);
      if (this.stageProjection(name, value, updates, shared)) this.completePending(name, value, updates, shared);
      else projectionSuperseded = true;
    }
    for (const record of shared.records.values()) {
      if (!record.deleted) continue;
      const name = record.kind === "story" && record.key === "current" ? "story.json" : record.kind === "progress" && /^g_[a-f0-9]{12}$/.test(record.key) ? `progress/${record.key}.json` : null;
      if (!name || this.errors.some((error) => error.file === name)) continue;
      if (load(join11(this.directory, name)) === void 0) {
        if (this.state(name).bases[sharedRecordKey(record.kind, record.key)] !== record.hash) this.remember(name, null, [], shared, false);
        continue;
      }
      if (this.stageProjection(name, null, [], shared, true)) this.completePending(name, null, [], shared);
      else projectionSuperseded = true;
    }
    const activity = captureActivity ? activitySignature(this.db) : null;
    let copies = {}, copyHash = null;
    if (captureActivity) {
      try {
        copies = load(join11(this.directory, "human-copy.json"))?.entries ?? {};
        copyHash = digest(copies);
      } catch (error) {
        this.errors.push({ file: "human-copy.json", message: String(error.message) });
      }
    }
    if (captureActivity && (activity !== this.activity || copyHash !== this.copyHash)) {
      const entries = this.db.prepare("SELECT id, project, list_name, fields, created_at_epoch, origin_device_id, origin_local_id FROM work_state_entries").all();
      const state = reduceWorkState(entries, { localDeviceId: this.deviceId });
      let records2 = readAgentRecords(this.db, { workState: state, ledger });
      records2 = applySharedProjection(this.db, shared, { ledger, records: records2, deviceId: this.deviceId }).records;
      const view = decorateSharedView(buildAgentView(state, records2, { ledger }), { records: records2 });
      try {
        this.publish(buildSharedProjectionUpdates(this.db, { ledger: null, records: records2, view, deviceId: this.deviceId, copyEntries: copies }));
      } catch (error) {
        this.errors.push({ file: "activity", message: String(error.message) });
      }
      this.activity = activity;
      this.copyHash = copyHash;
    }
    const final = this.shared();
    if (final.revision !== this.sharedRevision) {
      const story = final.records.get(sharedRecordKey("story", "current"));
      const storyHash = story?.hash ?? null;
      this.notify({ rules: storyHash !== this.storyHash });
      this.storyHash = storyHash;
      this.sharedRevision = final.revision;
    }
    this.lastSignature = projectionSuperseded ? null : this.signature(captureActivity);
    const diagnostics = applySharedProjection(this.db, final, { ledger, deviceId: this.deviceId }).diagnostics;
    this.lastDiagnostic = { ...diagnostics, files: this.errors };
    return this.lastDiagnostic;
  }
};

// src/services/work-view/request-groups-cli.mjs
init_shared_file_hooks();

// src/services/sync/local-device-identity.ts
init_SettingsDefaultsManager();
init_settings_document();
import { randomUUID as randomUUID3 } from "node:crypto";
function validIdentity(value) {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > 128 || value.includes("\0")) {
    throw new Error("Local device identity is invalid");
  }
  return value;
}
function ensureLocalDeviceIdentity(db, settingsPath, configuredId = "") {
  return db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS local_work_view_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), device_id TEXT NOT NULL)");
    const pinned = db.query("SELECT device_id FROM local_work_view_identity WHERE singleton=1").get()?.device_id;
    const settingsId = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID;
    const identities = new Set([pinned, configuredId, settingsId].filter((value) => Boolean(value)).map(validIdentity));
    try {
      const writers2 = db.query(`SELECT DISTINCT json_extract(fields, '$.writer') AS writer FROM work_state_entries
        WHERE origin_device_id IS NULL AND list_name GLOB '__my_work_v[0-9]*:*' AND json_valid(fields)`).all();
      for (const { writer } of writers2) {
        if (typeof writer !== "string") throw new Error("Native shared work has an invalid device identity");
        identities.add(validIdentity(writer));
      }
    } catch (error) {
      if (!/no such (table|column)/i.test(String(error.message))) throw error;
    }
    if (identities.size > 1) throw new Error("Local device identity conflicts with saved work; reconnect or restore the original identity before writing");
    const deviceId = [...identities][0] ?? randomUUID3();
    if (settingsId !== deviceId) {
      const result = updateSettingsDocument(settingsPath, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: deviceId }, SettingsDefaultsManager.getAllDefaults());
      if (result.status === "refused") throw result.error instanceof Error ? result.error : new Error("Local device identity could not be saved");
    }
    if (!pinned) db.query("INSERT INTO local_work_view_identity(singleton,device_id) VALUES(1,?)").run(deviceId);
    return deviceId;
  }).immediate();
}

// src/services/work-view/request-groups-cli.mjs
async function saveFocus(body) {
  const base = resolveHarnessWorkerUrl();
  let response;
  try {
    response = await fetch(`${base}/api/work-view/focus/router`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    throw new Error(`claude-mem worker is not reachable at ${base} (${error.message}). Start it with: npx claude-mem start`);
  }
  const text5 = await response.text();
  if (response.status === 400) throw new TypeError(`worker refused the answer: ${text5}`);
  if (!response.ok) throw new Error(`worker refused /api/work-view/focus/router: ${response.status} ${text5}`);
  return JSON.parse(text5);
}
var settings = SettingsDefaultsManager.loadFromFile(join12(resolveDataDir(), "settings.json"), true, { readOnly: true });
var localDeviceId = settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? "";
var sharedDatabase = null;
var stopSharedWriter = null;
var command = process.argv[2];
var writesLedger = ["apply", "record-progress", "record-story"].includes(command) || command === "judge" && process.argv.includes("--apply");
if (settings.CLAUDE_MEM_WORK_VIEW_SHARED_STATE === "true" && writesLedger && existsSync13(join12(resolveDataDir(), "claude-mem.db"))) {
  sharedDatabase = new Database2(join12(resolveDataDir(), "claude-mem.db"), { readwrite: true, create: false });
  localDeviceId = ensureLocalDeviceIdentity(sharedDatabase, join12(resolveDataDir(), "settings.json"), localDeviceId);
  const adapter = new SharedLedgerAdapter(sharedDatabase, { directory: join12(resolveDataDir(), "work-view"), deviceId: localDeviceId });
  stopSharedWriter = registerSharedFileWriter(join12(resolveDataDir(), "work-view"), (name, value) => adapter.beforeWrite(name, value));
}
var output = "";
var print = (value) => {
  output += `${JSON.stringify(value, null, 2)}
`;
};
try {
  await runCli(process.argv.slice(2), { saveFocus, localDeviceId, print });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stopSharedWriter?.();
  sharedDatabase?.close();
}
if (output) await new Promise((resolve4, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve4()));
