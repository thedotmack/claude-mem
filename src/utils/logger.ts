/**
 * Structured Logger for claude-mem Worker Service
 * Provides readable, traceable logging with correlation IDs and data flow tracking
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export type Component = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | 'FOLDER_INDEX' | 'CLAUDE_MD';

interface LogContext {
  sessionId?: number;
  memorySessionId?: string;
  correlationId?: string;
  [key: string]: any;
}

// NOTE: This default must match DEFAULT_DATA_DIR in src/shared/SettingsDefaultsManager.ts
// Inlined here to avoid circular dependency with SettingsDefaultsManager
const DEFAULT_DATA_DIR = join(homedir(), '.claude-mem');

class Logger {
  private level: LogLevel | null = null;
  private useColor: boolean;
  private logFilePath: string | null = null;
  private logFileInitialized: boolean = false;

  constructor() {
    // Disable colors when output is not a TTY (e.g., PM2 logs)
    this.useColor = process.stdout.isTTY ?? false;
    // Don't initialize log file in constructor - do it lazily to avoid circular dependency
  }

  /**
   * Initialize log file path and ensure directory exists (lazy initialization)
   */
  private ensureLogFileInitialized(): void {
    if (this.logFileInitialized) return;
    this.logFileInitialized = true;

    try {
      // Use default data directory to avoid circular dependency with SettingsDefaultsManager
      // The log directory is always based on the default, not user settings
      const logsDir = join(DEFAULT_DATA_DIR, 'logs');

      // Ensure logs directory exists
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }

      // Create log file path with date
      const date = new Date().toISOString().split('T')[0];
      this.logFilePath = join(logsDir, `claude-mem-${date}.log`);
    } catch (error) {
      // If log file initialization fails, just log to console
      console.error('[LOGGER] Failed to initialize log file:', error);
      this.logFilePath = null;
    }
  }

  /**
   * Lazy-load log level from settings file
   * Uses direct file reading to avoid circular dependency with SettingsDefaultsManager
   */
  private getLevel(): LogLevel {
    if (this.level === null) {
      try {
        // Read settings file directly to avoid circular dependency
        const settingsPath = join(DEFAULT_DATA_DIR, 'settings.json');
        if (existsSync(settingsPath)) {
          const settingsData = readFileSync(settingsPath, 'utf-8');
          const settings = JSON.parse(settingsData);
          const envLevel = (settings.CLAUDE_MEM_LOG_LEVEL || 'INFO').toUpperCase();
          this.level = LogLevel[envLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
        } else {
          this.level = LogLevel.INFO;
        }
      } catch (error) {
        // Fallback to INFO if settings can't be loaded
        this.level = LogLevel.INFO;
      }
    }
    return this.level;
  }

  /**
   * Create correlation ID for tracking an observation through the pipeline
   */
  correlationId(sessionId: number, observationNum: number): string {
    return `obs-${sessionId}-${observationNum}`;
  }

  /**
   * Create session correlation ID
   */
  sessionId(sessionId: number): string {
    return `session-${sessionId}`;
  }

  /**
   * Format data for logging - create compact summaries instead of full dumps
   */
  private formatData(data: any): string {
    if (data === null || data === undefined) return '';
    if (typeof data === 'string') return data;
    if (typeof data === 'number') return data.toString();
    if (typeof data === 'boolean') return data.toString();

    // For objects, create compact summaries
    if (typeof data === 'object') {
      // If it's an error, show message and stack in debug mode
      if (data instanceof Error) {
        return this.getLevel() === LogLevel.DEBUG
          ? `${data.message}\n${data.stack}`
          : data.message;
      }

      // For arrays, show count
      if (Array.isArray(data)) {
        return `[${data.length} items]`;
      }

      // For objects, show key count
      const keys = Object.keys(data);
      if (keys.length === 0) return '{}';
      if (keys.length <= 3) {
        // Show small objects inline
        return JSON.stringify(data);
      }
      return `{${keys.length} keys: ${keys.slice(0, 3).join(', ')}...}`;
    }

    return String(data);
  }

  /**
   * Format a tool name and input for compact display
   */
  formatTool(toolName: string, toolInput?: any): string {
    if (!toolInput) return toolName;

    let input = toolInput;
    if (typeof toolInput === 'string') {
      try {
        input = JSON.parse(toolInput);
      } catch {
        // Input is a raw string (e.g., Bash command), use as-is
        input = toolInput;
      }
    }

    // Bash: show full command
    if (toolName === 'Bash' && input.command) {
      return `${toolName}(${input.command})`;
    }

    // File operations: show full path
    if (input.file_path) {
      return `${toolName}(${input.file_path})`;
    }

    // NotebookEdit: show full notebook path
    if (input.notebook_path) {
      return `${toolName}(${input.notebook_path})`;
    }

    // Glob: show full pattern
    if (toolName === 'Glob' && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }

    // Grep: show full pattern
    if (toolName === 'Grep' && input.pattern) {
      return `${toolName}(${input.pattern})`;
    }

    // WebFetch/WebSearch: show full URL or query
    if (input.url) {
      return `${toolName}(${input.url})`;
    }

    if (input.query) {
      return `${toolName}(${input.query})`;
    }

    // Task: show subagent_type or full description
    if (toolName === 'Task') {
      if (input.subagent_type) {
        return `${toolName}(${input.subagent_type})`;
      }
      if (input.description) {
        return `${toolName}(${input.description})`;
      }
    }

    // Skill: show skill name
    if (toolName === 'Skill' && input.skill) {
      return `${toolName}(${input.skill})`;
    }

    // LSP: show operation type
    if (toolName === 'LSP' && input.operation) {
      return `${toolName}(${input.operation})`;
    }

    // Default: just show tool name
    return toolName;
  }

  /**
   * Format timestamp in local timezone (YYYY-MM-DD HH:MM:SS.mmm)
   */
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

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    component: Component,
    message: string,
    context?: LogContext,
    data?: any
  ): void {
    if (level < this.getLevel()) return;

    // Lazy initialize log file on first use
    this.ensureLogFileInitialized();

    const timestamp = this.formatTimestamp(new Date());
    const levelStr = LogLevel[level].padEnd(5);
    const componentStr = component.padEnd(6);

    // Build correlation ID part
    let correlationStr = '';
    if (context?.correlationId) {
      correlationStr = `[${context.correlationId}] `;
    } else if (context?.sessionId) {
      correlationStr = `[session-${context.sessionId}] `;
    }

    // Build data part
    let dataStr = '';
    if (data !== undefined && data !== null) {
      // Handle Error objects specially - they don't JSON.stringify properly
      if (data instanceof Error) {
        dataStr = this.getLevel() === LogLevel.DEBUG
          ? `\n${data.message}\n${data.stack}`
          : ` ${data.message}`;
      } else if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
        // In debug mode, show full JSON for objects
        dataStr = '\n' + JSON.stringify(data, null, 2);
      } else {
        dataStr = ' ' + this.formatData(data);
      }
    }

    // Build additional context
    let contextStr = '';
    if (context) {
      const { sessionId, memorySessionId, correlationId, ...rest } = context;
      if (Object.keys(rest).length > 0) {
        const pairs = Object.entries(rest).map(([k, v]) => `${k}=${v}`);
        contextStr = ` {${pairs.join(', ')}}`;
      }
    }

    const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;

    // Output to log file ONLY (worker runs in background, console is useless)
    if (this.logFilePath) {
      try {
        appendFileSync(this.logFilePath, logLine + '\n', 'utf8');
      } catch (error) {
        // Logger can't log its own failures - use stderr as last resort
        // This is expected during disk full / permission errors
        process.stderr.write(`[LOGGER] Failed to write to log file: ${error}\n`);
      }
    } else {
      // If no log file available, write to stderr as fallback
      process.stderr.write(logLine + '\n');
    }
  }

  // Public logging methods
  debug(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.DEBUG, component, message, context, data);
  }

  info(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.INFO, component, message, context, data);
  }

  warn(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.WARN, component, message, context, data);
  }

  error(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.ERROR, component, message, context, data);
  }

  /**
   * Log data flow: input → processing
   */
  dataIn(component: Component, message: string, context?: LogContext, data?: any): void {
    this.info(component, `→ ${message}`, context, data);
  }

  /**
   * Log data flow: processing → output
   */
  dataOut(component: Component, message: string, context?: LogContext, data?: any): void {
    this.info(component, `← ${message}`, context, data);
  }

  /**
   * Log successful completion
   */
  success(component: Component, message: string, context?: LogContext, data?: any): void {
    this.info(component, `✓ ${message}`, context, data);
  }

  /**
   * Log failure
   */
  failure(component: Component, message: string, context?: LogContext, data?: any): void {
    this.error(component, `✗ ${message}`, context, data);
  }

  /**
   * Log timing information
   */
  timing(component: Component, message: string, durationMs: number, context?: LogContext): void {
    this.info(component, `⏱ ${message}`, context, { duration: `${durationMs}ms` });
  }

  /**
   * Happy Path Error - logs when the expected "happy path" fails but we have a fallback
   *
   * Semantic meaning: "When the happy path fails, this is an error, but we have a fallback."
   *
   * Use for:
   * ✅ Unexpected null/undefined values that should theoretically never happen
   * ✅ Defensive coding where silent fallback is acceptable
   * ✅ Situations where you want to track unexpected nulls without breaking execution
   *
   * DO NOT use for:
   * ❌ Nullable fields with valid default behavior (use direct || defaults)
   * ❌ Critical validation failures (use logger.warn or throw Error)
   * ❌ Try-catch blocks where error is already logged (redundant)
   *
   * @param component - Component where error occurred
   * @param message - Error message describing what went wrong
   * @param context - Optional context (sessionId, correlationId, etc)
   * @param data - Optional data to include
   * @param fallback - Value to return (defaults to empty string)
   * @returns The fallback value
   */
  happyPathError<T = string>(
    component: Component,
    message: string,
    context?: LogContext,
    data?: any,
    fallback: T = '' as T
  ): T {
    // Capture stack trace to get caller location
    const stack = new Error().stack || '';
    const stackLines = stack.split('\n');
    // Line 0: "Error"
    // Line 1: "at happyPathError ..."
    // Line 2: "at <CALLER> ..." <- We want this one
    const callerLine = stackLines[2] || '';
    const callerMatch = callerLine.match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
    const location = callerMatch
      ? `${callerMatch[1].split('/').pop()}:${callerMatch[2]}`
      : 'unknown';

    // Log as a warning with location info
    const enhancedContext = {
      ...context,
      location
    };

    this.warn(component, `[HAPPY-PATH] ${message}`, enhancedContext, data);

    return fallback;
  }
}

// Export singleton instance
export const logger = new Logger();
