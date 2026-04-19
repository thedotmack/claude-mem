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
  // Claude Code subagent identity — present only when hook fires inside a subagent.
  // Main session has both undefined. Discriminator for subagent context.
  agentId?: string;      // Claude Code subagent agent_id (undefined in main session)
  agentType?: string;    // Claude Code subagent agent_type (undefined in main session)
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
