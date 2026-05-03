
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { paths } from '../shared/paths.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export type Component =
  | 'AGENTS_MD'
  | 'BRANCH'
  | 'CHROMA'
  | 'CHROMA_MCP'
  | 'CHROMA_SYNC'
  | 'CLAUDE_MD'
  | 'CONFIG'
  | 'CONSOLE'
  | 'CURSOR'
  | 'DB'
  | 'DEDUP'
  | 'ENV'
  | 'FOLDER_INDEX'
  | 'HOOK'
  | 'HTTP'
  | 'IMPORT'
  | 'INGEST'
  | 'OAUTH'
  | 'OPENCLAW'
  | 'OPENCODE'
  | 'PARSER'
  | 'PROCESS'
  | 'PROJECT_NAME'
  | 'QUEUE'
  | 'SDK'
  | 'SDK_SPAWN'
  | 'SEARCH'
  | 'SECURITY'
  | 'SESSION'
  | 'SETTINGS'
  | 'SHUTDOWN'
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


class Logger {
  private level: LogLevel | null = null;
  private useColor: boolean;
  private logFilePath: string | null = null;
  private logFileInitialized: boolean = false;

  constructor() {
    this.useColor = process.stdout.isTTY ?? false;
    // Don't initialize log file in constructor - do it lazily to avoid circular dependency
  }

  private ensureLogFileInitialized(): void {
    if (this.logFileInitialized) return;
    this.logFileInitialized = true;

    try {
      const logsDir = paths.logsDir();

      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }

      const date = new Date().toISOString().split('T')[0];
      this.logFilePath = join(logsDir, `claude-mem-${date}.log`);
    } catch (error: unknown) {
      console.error('[LOGGER] Failed to initialize log file:', error instanceof Error ? error.message : String(error));
      this.logFilePath = null;
    }
  }

  private getLevel(): LogLevel {
    if (this.level === null) {
      try {
        const settingsPath = paths.settings();
        if (existsSync(settingsPath)) {
          const settingsData = readFileSync(settingsPath, 'utf-8');
          const settings = JSON.parse(settingsData);
          const envLevel = (settings.CLAUDE_MEM_LOG_LEVEL || 'INFO').toUpperCase();
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

  correlationId(sessionId: number, observationNum: number): string {
    return `obs-${sessionId}-${observationNum}`;
  }

  sessionId(sessionId: number): string {
    return `session-${sessionId}`;
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
        return JSON.stringify(data);
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
      } catch (_parseError: unknown) {
        input = toolInput;
      }
    }

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
        try {
          dataStr = '\n' + JSON.stringify(data, null, 2);
        } catch {
          dataStr = ' ' + this.formatData(data);
        }
      } else {
        dataStr = ' ' + this.formatData(data);
      }
    }

    let contextStr = '';
    if (context) {
      const { sessionId, memorySessionId, correlationId, ...rest } = context;
      if (Object.keys(rest).length > 0) {
        const pairs = Object.entries(rest).map(([k, v]) => `${k}=${v}`);
        contextStr = ` {${pairs.join(', ')}}`;
      }
    }

    const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;

    if (this.logFilePath) {
      try {
        appendFileSync(this.logFilePath, logLine + '\n', 'utf8');
      } catch (error: unknown) {
        process.stderr.write(`[LOGGER] Failed to write to log file: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    } else {
      process.stderr.write(logLine + '\n');
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

  error(component: Component, message: string, context?: LogContext, data?: any): void {
    this.log(LogLevel.ERROR, component, message, context, data);
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

  timing(component: Component, message: string, durationMs: number, context?: LogContext): void {
    this.info(component, `⏱ ${message}`, context, { duration: `${durationMs}ms` });
  }

  happyPathError<T = string>(
    component: Component,
    message: string,
    context?: LogContext,
    data?: any,
    fallback: T = '' as T
  ): T {
    const stack = new Error().stack || '';
    const stackLines = stack.split('\n');
    const callerLine = stackLines[2] || '';
    const callerMatch = callerLine.match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/);
    const location = callerMatch
      ? `${callerMatch[1].split('/').pop()}:${callerMatch[2]}`
      : 'unknown';

    const enhancedContext = {
      ...context,
      location
    };

    this.warn(component, `[HAPPY-PATH] ${message}`, enhancedContext, data);

    return fallback;
  }
}

export const logger = new Logger();
