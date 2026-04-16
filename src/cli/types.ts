export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;   // 'claude-code', 'cursor', 'gemini-cli', etc.
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
  // Cursor-specific fields
  filePath?: string;   // afterFileEdit
  edits?: unknown[];   // afterFileEdit
  // Platform-specific metadata (source, reason, trigger, mcp_context, etc.)
  metadata?: Record<string, unknown>;
  /**
   * Optional historical timestamp (epoch ms) supplied by the transcript-import
   * path only. Live platform adapters never set this. When present, the
   * observation/session-complete handler forwards it to the worker as
   * `historical_timestamp_from_import_epoch_ms` so the row is stamped with
   * the transcript's original time instead of import-run time.
   */
  historicalTimestampFromImportEpochMs?: number;
}

export interface HookResult {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
  systemMessage?: string;
  exitCode?: number;
}

export interface PlatformAdapter {
  normalizeInput(raw: unknown): NormalizedHookInput;
  formatOutput(result: HookResult): unknown;
}

export interface EventHandler {
  execute(input: NormalizedHookInput): Promise<HookResult>;
}
