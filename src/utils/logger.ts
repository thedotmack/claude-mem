/**
 * Structured Logger for claude-mem Worker Service
 * Provides readable, traceable logging with correlation IDs and data flow tracking
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export type Component = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM';

interface LogContext {
  sessionId?: number;
  sdkSessionId?: string;
  correlationId?: string;
  [key: string]: any;
}

class Logger {
  private level: LogLevel;
  private useColor: boolean;

  constructor() {
    // Parse log level from environment
    const envLevel = process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase() || 'INFO';
    this.level = LogLevel[envLevel as keyof typeof LogLevel] ?? LogLevel.INFO;

    // Disable colors when output is not a TTY (e.g., PM2 logs)
    this.useColor = process.stdout.isTTY ?? false;
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
        return this.level === LogLevel.DEBUG
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
    if (level < this.level) return;

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 23);
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
      if (this.level === LogLevel.DEBUG && typeof data === 'object') {
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
