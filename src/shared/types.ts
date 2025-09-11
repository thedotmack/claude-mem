export interface HookPayload {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

export interface PreCompactPayload extends HookPayload {
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions?: string;
}

export interface SessionStartPayload extends HookPayload {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'compact' | 'vscode' | 'web';
}

export interface UserPromptSubmitPayload extends HookPayload {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
  cwd: string;
}

export interface PreToolUsePayload extends HookPayload {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUsePayload extends HookPayload {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown> & {
    success?: boolean;
  };
}

export interface NotificationPayload extends HookPayload {
  hook_event_name: 'Notification';
  message: string;
  title?: string;
}

export interface StopPayload extends HookPayload {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
}

export interface BaseHookResponse {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
}

export interface PreCompactResponse extends BaseHookResponse {
  decision?: 'approve' | 'block';
  reason?: string;
}

export interface SessionStartResponse extends BaseHookResponse {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext?: string;
  };
}

export interface PreToolUseResponse extends BaseHookResponse {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
}

export interface CompressionResult {
  compressedLines: string[];
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  memoryNodes: string[];
}

export interface MemoryNode {
  id: string;
  type: 'document';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export class HookError extends Error {
  constructor(
    message: string,
    public hookType: string,
    public payload?: HookPayload,
    public code?: string
  ) {
    super(message);
    this.name = 'HookError';
  }
}

export class CompressionError extends Error {
  constructor(
    message: string,
    public transcriptPath: string,
    public stage: 'reading' | 'analyzing' | 'compressing' | 'writing'
  ) {
    super(message);
    this.name = 'CompressionError';
  }
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export class FileLogger implements Logger {
  constructor(
    private logFile: string,
    private enableDebug = false
  ) {}

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('WARN', message, meta);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const errorMeta = error ? { error: error.message, stack: error.stack } : {};
    this.log('ERROR', message, { ...meta, ...errorMeta });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.enableDebug) {
      this.log('DEBUG', message, meta);
    }
  }

  private log(
    level: string,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const logLine = `[${timestamp}] ${level}: ${message}${metaStr}\n`;

    console.error(logLine);
  }
}

export function validateHookPayload(
  payload: unknown,
  expectedType: string
): HookPayload {
  if (!payload || typeof payload !== 'object') {
    throw new HookError(
      `Invalid payload: expected object, got ${typeof payload}`,
      expectedType
    );
  }

  const hookPayload = payload as Record<string, unknown>;

  if (!hookPayload.session_id || typeof hookPayload.session_id !== 'string') {
    throw new HookError(
      'Missing or invalid session_id',
      expectedType,
      hookPayload as unknown as HookPayload
    );
  }

  if (
    !hookPayload.transcript_path ||
    typeof hookPayload.transcript_path !== 'string'
  ) {
    throw new HookError(
      'Missing or invalid transcript_path',
      expectedType,
      hookPayload as unknown as HookPayload
    );
  }

  return hookPayload as unknown as HookPayload;
}

export function createSuccessResponse(
  additionalData?: Record<string, unknown>
): BaseHookResponse {
  return {
    continue: true,
    ...additionalData,
  };
}

export function createErrorResponse(
  reason: string,
  additionalData?: Record<string, unknown>
): BaseHookResponse {
  return {
    continue: false,
    stopReason: reason,
    ...additionalData,
  };
}

// =============================================================================
// SETTINGS AND CONFIGURATION TYPES
// =============================================================================

/**
 * Main settings interface for claude-mem configuration
 */
export interface Settings {
  autoCompress?: boolean;
  projectName?: string;
  installed?: boolean;
  backend?: string;
  embedded?: boolean;
  saveMemoriesOnClear?: boolean;
  claudePath?: string;
  [key: string]: unknown;  // Allow additional properties
}

// =============================================================================
// MCP CLIENT INTERFACE TYPES
// =============================================================================

/**
 * Document structure for MCP operations
 */
export interface MCPDocument {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Search result structure from MCP operations
 */
export interface MCPSearchResult {
  documents?: MCPDocument[];
  ids?: string[];
  metadatas?: Record<string, unknown>[];
  distances?: number[];
  [key: string]: unknown;
}

/**
 * Interface for MCP client implementations (Chroma-based)
 */
export interface IMCPClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  addDocuments(documents: MCPDocument[]): Promise<void>;
  queryDocuments(query: string, limit?: number): Promise<MCPSearchResult>;
  getDocuments(ids?: string[]): Promise<MCPSearchResult>;
}
