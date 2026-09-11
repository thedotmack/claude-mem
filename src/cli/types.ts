export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;   
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  /**
   * Provider-assigned id for THIS tool call. Already honoured downstream (the
   * pending_messages dedupe index and the durable `tool_uses` side index both
   * key on it); adapters simply never forwarded it from the hook payload, so
   * only the transcript-watch path populated it. Optional everywhere: a
   * platform that omits it still ingests, it just cannot be de-duplicated.
   */
  toolUseId?: string;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  turnId?: string;
  stopHookActive?: boolean;
  permissionMode?: string;
  model?: string;
  sessionSource?: 'startup' | 'resume' | 'clear';
  filePath?: string;
  edits?: unknown[];
  agentId?: string;
  agentType?: string;    
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
  decision?: 'block' | 'approve';
  reason?: string;
  exitCode?: number;
}

export interface PlatformAdapter {
  normalizeInput(raw: unknown): NormalizedHookInput;
  formatOutput(result: HookResult): unknown;
}

export interface EventHandler {
  execute(input: NormalizedHookInput): Promise<HookResult>;
}
