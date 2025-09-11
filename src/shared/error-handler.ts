import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HookError, CompressionError, Logger, FileLogger } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ErrorHandler {
  private logger: Logger;
  private logDir: string;

  // <Block> 7.1 ====================================
  constructor(enableDebug = false) {
    this.logDir = join(__dirname, '..', 'logs');
    this.ensureLogDirectory();

    const logFile = join(
      this.logDir,
      `claude-mem-${new Date().toISOString().slice(0, 10)}.log`
    );
    this.logger = new FileLogger(logFile, enableDebug);
  }
  // </Block> =======================================

  // <Block> 7.2 ====================================
  private ensureLogDirectory(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }
  // </Block> =======================================

  // <Block> 7.3 ====================================
  handleHookError(error: Error, hookType: string, payload?: unknown): never {
    // <Block> 7.3a ====================================
    const hookError =
      error instanceof HookError
        ? error
        : new HookError(
            error.message,
            hookType,
            payload as any,
            'HOOK_EXECUTION_ERROR'
          );
    // </Block> =======================================

    this.logger.error(`Hook execution failed in ${hookType}`, hookError, {
      hookType,
      payload: payload ? JSON.stringify(payload) : undefined,
    });

    console.log(
      JSON.stringify({
        continue: false,
        stopReason: `Hook error: ${hookError.message}`,
        error: {
          type: hookError.name,
          message: hookError.message,
          code: hookError.code,
        },
      })
    );

    process.exit(1);
  }
  // </Block> =======================================

  // <Block> 7.4 ====================================
  handleCompressionError(
    error: Error,
    transcriptPath: string,
    stage: string
  ): never {
    // <Block> 7.4a ====================================
    const compressionError =
      error instanceof CompressionError
        ? error
        : new CompressionError(error.message, transcriptPath, stage as any);
    // </Block> =======================================

    this.logger.error(`Compression failed during ${stage}`, compressionError, {
      transcriptPath,
      stage,
    });

    console.error(`Compression error: ${compressionError.message}`);
    console.error(`Stage: ${stage}`);
    console.error(`Transcript: ${transcriptPath}`);

    process.exit(1);
  }
  // </Block> =======================================

  // <Block> 7.5 ====================================
  handleValidationError(
    message: string,
    context?: Record<string, unknown>
  ): never {
    this.logger.error('Validation error', undefined, { message, context });

    console.error(`Validation error: ${message}`);
    // <Block> 7.5a ====================================
    if (context) {
      console.error('Context:', JSON.stringify(context, null, 2));
    }
    // </Block> =======================================

    process.exit(1);
  }
  // </Block> =======================================

  // <Block> 7.6 ====================================
  logSuccess(operation: string, details?: Record<string, unknown>): void {
    this.logger.info(`Operation successful: ${operation}`, details);
  }
  // </Block> =======================================

  // <Block> 7.7 ====================================
  logWarning(message: string, details?: Record<string, unknown>): void {
    this.logger.warn(message, details);
  }
  // </Block> =======================================

  // <Block> 7.8 ====================================
  logDebug(message: string, details?: Record<string, unknown>): void {
    this.logger.debug(message, details);
  }
  // </Block> =======================================
}

// <Block> 7.9 ====================================
export function parseStdinJson<T = unknown>(input: string): T {
  try {
    return JSON.parse(input) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON input: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
// </Block> =======================================

// <Block> 7.10 ===================================
export async function safeExecute<T>(
  operation: () => Promise<T>,
  errorHandler: ErrorHandler,
  context: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = `Safe execution failed in ${context}: ${error instanceof Error ? error.message : String(error)}`;
    errorHandler.handleValidationError(message, { context, error });
    throw error;
  }
}
// </Block> =======================================

// <Block> 7.11 ===================================
export function validateFileExists(
  filePath: string,
  errorHandler: ErrorHandler
): void {
  if (!existsSync(filePath)) {
    errorHandler.handleValidationError(`File not found: ${filePath}`, {
      filePath,
    });
  }
}
// </Block> =======================================

// <Block> 7.12 ===================================
/**
 * Creates a standardized hook response using HookTemplates
 * @deprecated Use HookTemplates.createHookSuccessResponse or createHookErrorResponse instead
 * This function is maintained for backward compatibility but should be replaced with HookTemplates.
 */
export function createHookResponse(
  success: boolean,
  data?: Record<string, unknown>
): string {
  // Log deprecation warning in development mode
  if (process.env.NODE_ENV === 'development') {
    console.warn('createHookResponse in error-handler.ts is deprecated. Use HookTemplates.createHookSuccessResponse or createHookErrorResponse instead.');
  }

  const response = {
    continue: success,
    suppressOutput: true, // Add standard suppressOutput field for Claude Code compatibility
    ...data,
  };

  return JSON.stringify(response);
}
// </Block> =======================================

export const globalErrorHandler = new ErrorHandler(
  process.env.DEBUG === 'true'
);
