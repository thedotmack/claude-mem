
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from '../shared/paths.js';
import { emitDiagnostic } from '../shared/hook-io.js';
import { readJsonFileWithBom } from '../shared/atomic-json.js';
import { settingsTarget } from '../shared/settings-document.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export type Component =
  | 'AGENTS_MD'
  | 'AWARENESS'
  | 'BRANCH'
  | 'CHROMA'
  | 'CHROMA_MCP'
  | 'CHROMA_SYNC'
  | 'CLAUDE_MD'
  | 'CLOUD_SYNC'
  | 'CONFIG'
  | 'CONSOLE'
  | 'CONTEXT_CACHE'
  | 'CURSOR'
  | 'DB'
  | 'DEDUP'
  | 'ENV'
  | 'FOLDER_INDEX'
  | 'GIT'
  | 'GROK_INDEX'
  | 'HOOK'
  | 'HTTP'
  | 'IMPORT'
  | 'INGEST'
  | 'OAUTH'
  | 'OMP'
  | 'OPENCLAW'
  | 'OPENCODE'
  | 'PARSER'
  | 'PROCESS'
  | 'PROJECT_NAME'
  | 'QUEUE'
  | 'REDACT'
  | 'SDK'
  | 'SDK_SPAWN'
  | 'SEARCH'
  | 'SECURITY'
  | 'SESSION'
  | 'SETTINGS'
  | 'SHUTDOWN'
  | 'SYNC_APPLY'
  | 'SYNC_CLIENT'
  | 'SYSTEM'
  | 'TELEGRAM'
  | 'TRANSCRIPT'
  | 'WINDSURF'
  | 'WORKER';

interface LogContext {
  sessionId?: string | number;
  memorySessionId?: string;
  correlationId?: string | number;
  [key: string]: any;
}

/**
 * Optional error sink. The logger must NEVER import the telemetry client (that
 * would create an import cycle: telemetry → logger via instrument.ts → ...).
 * Instead worker/telemetry init injects a sink via logger.setErrorSink(); when
 * present, logger.error()/logger.failure() route their Error payload through it
 * (consent + rate-limit + kill-switch all enforced INSIDE the sink, i.e.
 * captureException). The sink is optional and swallow-all so logging keeps
 * working with telemetry disabled or uninstalled.
 */
export type ErrorSink = (err: unknown, ctx?: Record<string, unknown>) => void;
let errorSink: ErrorSink | null = null;


class Logger {
  private level: LogLevel | null = null;
  private useColor: boolean;
  private logFilePath: string | null = null;
  private logFileInitialized: boolean = false;
  private logFileDate: string | null = null;
  private logFd: number | null = null;

  constructor() {
    this.useColor = process.stdout.isTTY ?? false;
    // Don't initialize log file in constructor - do it lazily to avoid circular dependency
  }

  private ensureLogFileInitialized(): void {
    // The date is computed BEFORE the latch is consulted, so a long-lived process rolls onto a new
    // log file at UTC midnight. Latching on the boolean alone freezes logFilePath at the day the
    // process started, and the daemon then writes entries stamped with today's date into a file
    // named for a previous day.
    const date = new Date().toISOString().split('T')[0];
    if (this.logFileInitialized && this.logFileDate === date) return;
    // Failed setup must stay retryable, but report initialization failure only once per UTC day.
    const firstAttemptToday = this.logFileDate !== date;
    this.closeLogFd();
    this.logFileInitialized = false;
    this.logFileDate = date;

    try {
      const logsDir = paths.logsDir();

      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }

      this.logFilePath = join(logsDir, `claude-mem-${date}.log`);
      this.logFileInitialized = true;
    } catch (error: unknown) {
      if (firstAttemptToday) {
        console.error('[LOGGER] Failed to initialize log file:', error instanceof Error ? error.message : String(error));
      }
      this.logFilePath = null;
    }
  }

  private closeLogFd(): void {
    if (this.logFd === null) return;
    try {
      closeSync(this.logFd);
    } catch {
      // Already closed or invalid: nothing left to release.
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
  private appendLine(path: string, text: string): void {
    if (this.logFd !== null) {
      let current = false;
      try {
        const open = fstatSync(this.logFd);
        const onDisk = statSync(path);
        current = open.ino === onDisk.ino && open.dev === onDisk.dev;
      } catch {
        // Path gone or descriptor invalid: re-open below.
      }
      if (!current) this.closeLogFd();
    }
    if (this.logFd === null) {
      // The stat above re-opens after an external delete; recreate the logs
      // directory too, or every later line fails until the next UTC day.
      mkdirSync(dirname(path), { recursive: true });
      this.logFd = openSync(path, 'a');
    }
    try {
      // writeSync may accept only part of the buffer; appendFileSync looped for us.
      let bytes = Buffer.from(text, 'utf8');
      while (bytes.length > 0) {
        const written = writeSync(this.logFd, bytes);
        if (written <= 0) throw new Error('log write accepted 0 bytes');
        bytes = bytes.subarray(written);
      }
    } catch (error) {
      this.closeLogFd();
      throw error;
    }
  }

  private getLevel(): LogLevel {
    if (this.level === null) {
      try {
        const settingsPath = paths.settings();
        if (existsSync(settingsPath)) {
          const settings = settingsTarget(readJsonFileWithBom<Record<string, unknown>>(settingsPath));
          const envLevel = (settings.CLAUDE_MEM_LOG_LEVEL || 'INFO').toString().toUpperCase();
          this.level = LogLevel[envLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
        } else {
          this.level = LogLevel.INFO;
        }
      } catch (error: unknown) {
        console.error('[LOGGER] Failed to load log level from settings:', error instanceof Error ? error.message : String(error));
        this.level = LogLevel.INFO;
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
  private safeStringify(data: unknown, indent?: number, maxDepth = 6): string {
    const seen = new WeakSet<object>();
    const prune = (rawValue: unknown, depth: number): unknown => {
      if (typeof rawValue === 'bigint') return `${rawValue}n`;
      if (rawValue === null || typeof rawValue !== 'object') return rawValue;
      // Date, URL, Buffer … define toJSON. Call it once, as JSON.stringify does,
      // so they log as their JSON form rather than as an empty `{}`.
      const toJSON = (rawValue as { toJSON?: unknown }).toJSON;
      const value: unknown = typeof toJSON === 'function' ? toJSON.call(rawValue) : rawValue;
      if (typeof value === 'bigint') return `${value}n`;
      if (value === null || typeof value !== 'object') return value;
      if (seen.has(value)) return '[Circular]';
      if (depth >= maxDepth) return Array.isArray(value) ? '[Array]' : '[Object]';
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map(item => prune(item, depth + 1));
        }
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>)) {
          try {
            out[key] = prune((value as Record<string, unknown>)[key], depth + 1);
          } catch {
            // A throwing getter must not sink the whole log line.
            out[key] = '[unreadable]';
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
      return Array.isArray(data) ? `[${(data as unknown[]).length} items]` : '[unserializable]';
    }
  }

  private formatData(data: any): string {
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;
    if (typeof data === 'number') return data.toString();
    if (typeof data === 'boolean') return data.toString();

    if (typeof data === 'object') {
      if (data instanceof Error) {
        return this.getLevel() === LogLevel.DEBUG
          ? `${data.message}\n${data.stack}`
          : data.message;
      }

      if (Array.isArray(data)) {
        return `[${data.length} items]`;
      }

      const keys = Object.keys(data);
      if (keys.length === 0) return '{}';
      if (keys.length <= 3) {
        return this.safeStringify(data);
      }
      return `{${keys.length} keys: ${keys.slice(0, 3).join(', ')}...}`;
    }

    return String(data);
  }

  formatTool(toolName: string, toolInput?: any): string {
    if (!toolInput) return toolName;

    let input = toolInput;
    if (typeof toolInput === 'string') {
      try {
        input = JSON.parse(toolInput);
      } catch {
        // [ANTI-PATTERN IGNORED]: tool_input is often a plain non-JSON string, so parse failure is the expected signal here; recovery is falling back to the raw string, and logging would spam every formatted log line.
        input = toolInput;
      }
    }

    // A JSON string can represent no arguments just like a direct null input.
    if (input === null) return toolName;

    if (toolName === 'Bash' && input.command) {
      return `${toolName}(${input.command})`;
    }

    if (input.file_path) {
      return `${toolName}(${input.file_path})`;
    }

    if (input.notebook_path) {
      return `${toolName}(${input.notebook_path})`;
    }

    if (toolName === 'Glob' && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }

    if (toolName === 'Grep' && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }

    if (input.url) {
      return `${toolName}(${input.url})`;
    }

    if (input.query) {
      return `${toolName}(${input.query})`;
    }

    if (toolName === 'Task') {
      if (input.subagent_type) {
        return `${toolName}(${input.subagent_type})`;
      }
      if (input.description) {
        return `${toolName}(${input.description})`;
      }
    }

    if (toolName === 'Skill' && input.skill) {
      return `${toolName}(${input.skill})`;
    }

    if (toolName === 'LSP' && input.operation) {
      return `${toolName}(${input.operation})`;
    }

    return toolName;
  }

  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  }

  private log(
    level: LogLevel,
    component: Component,
    message: string,
    context?: LogContext,
    data?: any
  ): void {
    if (level < this.getLevel()) return;

    this.ensureLogFileInitialized();

    const timestamp = this.formatTimestamp(new Date());
    const levelStr = LogLevel[level].padEnd(5);
    const componentStr = component.padEnd(6);

    let correlationStr = '';
    if (context?.correlationId) {
      correlationStr = `[${context.correlationId}] `;
    } else if (context?.sessionId) {
      correlationStr = `[session-${context.sessionId}] `;
    }

    let dataStr = '';
    if (data !== undefined && data !== null) {
      if (data instanceof Error) {
        dataStr = this.getLevel() === LogLevel.DEBUG
          ? `\n${data.message}\n${data.stack}`
          : ` ${data.message}`;
      } else if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
        // Depth-guarded: a deeply nested or self-referential payload would make
        // a plain JSON.stringify overflow the stack (RangeError), crashing the
        // caller through the logger. safeStringify prunes to a finite depth and
        // handles cycles/BigInt, so debug logging can never blow up here.
        dataStr = '\n' + this.safeStringify(data, 2);
      } else {
        dataStr = ' ' + this.formatData(data);
      }
    }

    let contextStr = '';
    if (context) {
      const { sessionId, memorySessionId, correlationId, ...rest } = context;
      if (Object.keys(rest).length > 0) {
        const pairs = Object.entries(rest).map(([k, v]) => {
          if (typeof v !== 'object' || v === null || v instanceof Error || v instanceof Date) return `${k}=${v}`;
          // safeStringify never throws: cycles, BigInt and deep nesting render as markers.
          return `${k}=${Array.isArray(v) ? this.safeStringify(v) : this.formatData(v)}`;
        });
        contextStr = ` {${pairs.join(', ')}}`;
      }
    }

    const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;

    if (this.logFilePath) {
      try {
        this.appendLine(this.logFilePath, logLine + '\n');
      } catch (error: unknown) {
        // [ANTI-PATTERN IGNORED]: this is the logger's own file-write failure path — calling the logger here would recurse into the same failing write, so the error is surfaced via emitDiagnostic to real stderr instead.
        // DIAGNOSTIC: route through hook-io so the message bypasses the Phase 2
        // hook stderr buffer (#2292). Outside the hook context emitDiagnostic
        // writes straight to real stderr, so non-hook callers are unaffected.
        const err = error instanceof Error ? error : new Error(String(error));
        emitDiagnostic(`[LOGGER] Failed to write to log file: ${err.message}\n${err.stack ?? ''}\n`);
      }
    } else {
      // DIAGNOSTIC: see note above.
      emitDiagnostic(logLine + '\n');
    }
  }

  debug(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.DEBUG, component, message, context, data);
  }

  info(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.INFO, component, message, context, data);
  }

  warn(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.WARN, component, message, context, data);
  }

  /**
   * Installs (or clears, with null) the optional error sink. Called once by
   * worker/telemetry init to bridge logged errors into captureException without
   * the logger importing telemetry (no import cycle). Never throws.
   */
  setErrorSink(sink: ErrorSink | null): void {
    errorSink = sink;
  }

  error(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.ERROR, component, message, context, data);
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
  private routeErrorToSink(message: string, context?: LogContext, data?: any): void {
    try {
      if (!errorSink || !(data instanceof Error)) return;
      // Pass the message as context so the sink can fingerprint on it too; the
      // sink (captureException) scrubs everything through error-scrub /
      // scrubProperties, so an unsafe message here cannot leak — but `message`
      // is not whitelisted, so it is dropped by scrubProperties anyway. We pass
      // only the Error itself; context is intentionally minimal.
      errorSink(data);
    } catch {
      // Telemetry/error-sink must never break logging.
    }
  }

  dataIn(component: Component, message: string, context?: LogContext, data?: any): void {
    this.info(component, `→ ${message}`, context, data);
  }

  dataOut(component: Component, message: string, context?: LogContext, data?: any): void {
    this.info(component, `← ${message}`, context, data);
  }

  success(component: Component, message: string, context?: LogContext, data?: any): void {
    this.info(component, `✓ ${message}`, context, data);
  }

  failure(component: Component, message: string, context?: LogContext, data?: any): void {
    this.error(component, `✗ ${message}`, context, data);
  }
}

export const logger = new Logger();
