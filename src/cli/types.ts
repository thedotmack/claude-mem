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
  reason?: string;
  turnId?: string;
  stopHookActive?: boolean;
  permissionMode?: string;
  model?: string;
  sessionSource?: 'startup' | 'resume' | 'clear';
  filePath?: string;
  edits?: unknown[];
  agentId?: string;
  /**
   * Text the human actually submitted, when the host can tell.
   *
   * Qwen Code sends `submitted_prompt` and fires `UserPromptSubmit` for
   * supported model invocations, which on the core/headless path also covers
   * ToolResult and Hook sends. Those carry no user text, and the host's own
   * guidance is that absence of the field means "unavailable" rather than
   * "fall back to prompt". Three states, all meaningful:
   *
   *   - `undefined` - the host did not send the field; legacy handling stands
   *   - `string`   - the host sent real user-submitted text
   *   - `null`     - the host sent the field with no text: not a user turn
   */
  submittedPrompt?: string | null;
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
