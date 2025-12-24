/**
 * Structured Logger for claude-mem Worker Service
 * Provides readable, traceable logging with correlation IDs and data flow tracking
 *
 * Features:
 * - Console output with structured formatting
 * - Optional database sink for self-aware logging
 * - Error pattern detection and tracking
 * - Buffered writes for performance
 */

import { createHash } from 'crypto';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export type Component = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | 'GRAPH' | 'SLACK' | 'NOTIFICATIONS' | 'HEALTH';

interface LogContext {
  sessionId?: number;
  sdkSessionId?: string;
  correlationId?: string;
  [key: string]: any;
}

interface LogEntry {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  component: string;
  message: string;
  context?: Record<string, any>;
  data?: any;
  errorStack?: string;
  timestamp: Date;
}

/**
 * Interface for database sink - allows lazy injection to avoid circular dependencies
 */
interface DatabaseSink {
  storeSystemLog(
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    component: string,
    message: string,
    context?: Record<string, any>,
    data?: any,
    errorStack?: string
  ): number;
  storeSystemLogBatch(logs: LogEntry[]): number;
  trackErrorPattern(errorHash: string, errorMessage: string, component: string): { id: number; isNew: boolean; occurrenceCount: number };
}

class Logger {
  private level: LogLevel | null = null;
  private useColor: boolean;
  private dbSink: DatabaseSink | null = null;
  private logBuffer: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly bufferSize = 50;          // Flush after 50 logs
  private readonly flushIntervalMs = 5000;   // Or flush every 5 seconds
  private isInitialized = false;

  constructor() {
    // Disable colors when output is not a TTY (e.g., PM2 logs)
    this.useColor = process.stdout.isTTY ?? false;
  }

  /**
   * Initialize database sink for persistent logging
   * Called by worker service after SessionStore is ready
   */
  initializeDatabaseSink(sink: DatabaseSink): void {
    if (this.isInitialized) return;
    this.dbSink = sink;
    this.isInitialized = true;

    // Start flush timer
    this.flushTimer = setInterval(() => this.flushBuffer(), this.flushIntervalMs);

    // Flush on process exit
    process.on('beforeExit', () => this.flushBuffer());
    process.on('SIGINT', () => { this.flushBuffer(); process.exit(0); });
    process.on('SIGTERM', () => { this.flushBuffer(); process.exit(0); });
  }

  /**
   * Check if database logging is enabled
   */
  get isDatabaseLoggingEnabled(): boolean {
    return this.dbSink !== null;
  }

  /**
   * Flush buffered logs to database
   */
  private flushBuffer(): void {
    if (this.logBuffer.length === 0 || !this.dbSink) return;

    const logsToFlush = [...this.logBuffer];
    this.logBuffer = [];

    try {
      this.dbSink.storeSystemLogBatch(logsToFlush);
    } catch (error) {
      // Silently fail - we can't log this error without recursion
      console.error('[Logger] Failed to flush logs to database');
    }
  }

  /**
   * Create a hash for error pattern detection
   */
  private createErrorHash(message: string, component: string): string {
    // Normalize the message: remove timestamps, IDs, file paths
    const normalized = message
      .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/g, 'TIMESTAMP')
      .replace(/\b\d+\b/g, 'NUM')
      .replace(/\/[\w\/.-]+/g, 'PATH')
      .substring(0, 200);  // Limit length

    return createHash('md5').update(`${component}:${normalized}`).digest('hex').substring(0, 16);
  }

  /**
   * Lazy-load log level from settings (breaks circular dependency with SettingsDefaultsManager)
   */
  private getLevel(): LogLevel {
    if (this.level === null) {
      const envLevel = SettingsDefaultsManager.get('CLAUDE_MEM_LOG_LEVEL').toUpperCase();
      this.level = LogLevel[envLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
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

    try {
      const input = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;

      // Special formatting for common tools
      if (toolName === 'Bash' && input.command) {
        const cmd = input.command.length > 50
          ? input.command.substring(0, 50) + '...'
          : input.command;
        return `${toolName}(${cmd})`;
      }

      if (toolName === 'Read' && input.file_path) {
        const path = input.file_path.split('/').pop() || input.file_path;
        return `${toolName}(${path})`;
      }

      if (toolName === 'Edit' && input.file_path) {
        const path = input.file_path.split('/').pop() || input.file_path;
        return `${toolName}(${path})`;
      }

      if (toolName === 'Write' && input.file_path) {
        const path = input.file_path.split('/').pop() || input.file_path;
        return `${toolName}(${path})`;
      }

      // Default: just show tool name
      return toolName;
    } catch {
      return toolName;
    }
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

    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 23);
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
      if (this.getLevel() === LogLevel.DEBUG && typeof data === 'object') {
        // In debug mode, show full JSON for objects
        dataStr = '\n' + JSON.stringify(data, null, 2);
      } else {
        dataStr = ' ' + this.formatData(data);
      }
    }

    // Build additional context
    let contextStr = '';
    if (context) {
      const { sessionId, sdkSessionId, correlationId, ...rest } = context;
      if (Object.keys(rest).length > 0) {
        const pairs = Object.entries(rest).map(([k, v]) => `${k}=${v}`);
        contextStr = ` {${pairs.join(', ')}}`;
      }
    }

    const logLine = `[${timestamp}] [${levelStr}] [${componentStr}] ${correlationStr}${message}${contextStr}${dataStr}`;

    // Output to appropriate stream
    if (level === LogLevel.ERROR) {
      console.error(logLine);
    } else {
      console.log(logLine);
    }

    // Write to database if enabled (skip DEBUG level for database to reduce noise)
    if (this.dbSink && level >= LogLevel.INFO) {
      const levelName = LogLevel[level] as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

      // Extract error stack if data is an Error
      let errorStack: string | undefined;
      if (data instanceof Error) {
        errorStack = data.stack;
      }

      // Add to buffer
      this.logBuffer.push({
        level: levelName,
        component,
        message,
        context: context ? { ...context } : undefined,
        data: data instanceof Error ? { message: data.message, name: data.name } : data,
        errorStack,
        timestamp: now
      });

      // Track error patterns
      if (level === LogLevel.ERROR && this.dbSink) {
        const errorHash = this.createErrorHash(message, component);
        try {
          this.dbSink.trackErrorPattern(errorHash, message, component);
        } catch {
          // Silently fail pattern tracking
        }
      }

      // Flush if buffer is full
      if (this.logBuffer.length >= this.bufferSize) {
        this.flushBuffer();
      }
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
}

// Export singleton instance
export const logger = new Logger();
