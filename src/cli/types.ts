export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;   
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  turnId?: string;
  stopHookActive?: boolean;
  permissionMode?: string;
  model?: string;
  sessionSource?: 'startup' | 'resume' | 'clear';
  filePath?: string;   
  edits?: unknown[];   
  metadata?: Record<string, unknown>;
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
