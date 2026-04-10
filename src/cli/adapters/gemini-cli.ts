import type { PlatformAdapter } from '../types.js';

/**
 * Gemini CLI Platform Adapter
 *
 * Normalizes Gemini CLI's hook JSON to NormalizedHookInput.
 * Gemini CLI supports 11 lifecycle hooks; we register 8:
 *
 * Lifecycle:
 *   SessionStart  → context     (inject memory context)
 *   SessionEnd    → session-complete
 *   PreCompress   → summarize
 *   Notification  → observation (system events like ToolPermission)
 *
 * Agent:
 *   BeforeAgent   → session-init (initializes session, captures user prompt)
 *   AfterAgent    → observation  (full agent response)
 *
 * Tool:
 *   BeforeTool    → observation  (tool intent before execution)
 *   AfterTool     → observation  (tool result after execution)
 *
 * Unmapped (not useful for memory):
 *   BeforeModel, AfterModel, BeforeToolSelection — model-level events
 *   that fire per-LLM-call, too chatty for observation capture.
 *
 * Base fields (all events): session_id, transcript_path, cwd, hook_event_name, timestamp
 *
 * Output format: { continue, stopReason, suppressOutput, systemMessage, decision, reason, hookSpecificOutput }
 * Advisory hooks (SessionStart, SessionEnd, PreCompress, Notification) ignore flow-control fields.
 */
export const geminiCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    // CWD resolution chain: JSON field → env vars → process.cwd()
    const cwd = r.cwd
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();

    const sessionId = r.session_id
      ?? process.env.GEMINI_SESSION_ID
      ?? undefined;

    const hookEventName: string | undefined = r.hook_event_name;

    // Tool fields — present in BeforeTool, AfterTool
    let toolName: string | undefined = r.tool_name;
    let toolInput: unknown = r.tool_input;
    let toolResponse: unknown = r.tool_response;

    // AfterAgent: synthesize observation shape from the full agent response
    if (hookEventName === 'AfterAgent' && r.prompt_response) {
      toolName = toolName ?? 'GeminiAgent';
      toolInput = toolInput ?? { prompt: r.prompt };
      toolResponse = toolResponse ?? { response: r.prompt_response };
    }

    // BeforeTool: has tool_name and tool_input but no tool_response yet
    // Synthesize a marker so observation handler knows this is pre-execution
    if (hookEventName === 'BeforeTool' && toolName && !toolResponse) {
      toolResponse = { _preExecution: true };
    }

    // Notification: capture as an observation with notification details
    if (hookEventName === 'Notification') {
      toolName = toolName ?? 'GeminiNotification';
      toolInput = toolInput ?? {
        notification_type: r.notification_type,
        message: r.message,
      };
      toolResponse = toolResponse ?? { details: r.details };
    }

    // Collect platform-specific metadata
    const metadata: Record<string, unknown> = {};
    if (r.source) metadata.source = r.source;                     // SessionStart: startup|resume|clear
    if (r.reason) metadata.reason = r.reason;                     // SessionEnd: exit|clear|logout|...
    if (r.trigger) metadata.trigger = r.trigger;                  // PreCompress: auto|manual
    if (r.mcp_context) metadata.mcp_context = r.mcp_context;     // Tool hooks: MCP server context
    if (r.notification_type) metadata.notification_type = r.notification_type;
    if (r.stop_hook_active !== undefined) metadata.stop_hook_active = r.stop_hook_active;
    if (r.original_request_name) metadata.original_request_name = r.original_request_name;
    if (hookEventName) metadata.hook_event_name = hookEventName;

    return {
      sessionId,
      cwd,
      prompt: r.prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcript_path,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result) {
    // Gemini CLI expects: { continue, stopReason, suppressOutput, systemMessage, decision, reason, hookSpecificOutput }
    const output: Record<string, unknown> = {};

    // Flow control — always include `continue` to prevent accidental agent termination
    output.continue = result.continue ?? true;

    if (result.suppressOutput !== undefined) {
      output.suppressOutput = result.suppressOutput;
    }

    if (result.systemMessage) {
      // Strip ANSI escape sequences: matches colors, text formatting, and terminal control codes
      // Gemini CLI often has issues with ANSI escape sequences in tool output (showing them as raw text)
      const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
      output.systemMessage = result.systemMessage.replace(ansiRegex, '');
    }

    // hookSpecificOutput is a first-class Gemini CLI field — pass through directly
    // This includes additionalContext for context injection in SessionStart, BeforeAgent, AfterTool
    if (result.hookSpecificOutput) {
      output.hookSpecificOutput = {
        additionalContext: result.hookSpecificOutput.additionalContext,
      };
    }

    return output;
  }
};
