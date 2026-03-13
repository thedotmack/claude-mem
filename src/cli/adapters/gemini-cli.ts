import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

/**
 * Gemini CLI Platform Adapter
 *
 * Normalizes Gemini CLI's hook JSON to NormalizedHookInput.
 * Gemini CLI has 11 lifecycle hooks; we map 6 of them:
 *   SessionStart  → session-init
 *   BeforeAgent   → user-message (captures prompt)
 *   AfterAgent    → observation (full response)
 *   AfterTool     → observation (tool result)
 *   PreCompress   → summarize
 *   SessionEnd    → session-complete
 *
 * Base fields (all events): session_id, transcript_path, cwd, hook_event_name, timestamp
 *
 * Output format: { continue, stopReason, suppressOutput, systemMessage, decision, reason }
 * Advisory hooks (SessionStart, SessionEnd, PreCompress) ignore `continue` and `decision`.
 */
export const geminiCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    // Use GEMINI_CWD, GEMINI_PROJECT_DIR, or the JSON cwd field
    const cwd = r.cwd
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();

    const sessionId = r.session_id
      ?? process.env.GEMINI_SESSION_ID
      ?? undefined;

    // Map event-specific fields into normalized shape
    // AfterTool provides tool_name, tool_input, tool_response
    // BeforeAgent/AfterAgent provide prompt (and prompt_response for AfterAgent)
    const hookEventName: string | undefined = r.hook_event_name;

    // For AfterAgent, treat the full response as an observation by packing it
    // into toolResponse so the observation handler can process it
    let toolName: string | undefined = r.tool_name;
    let toolInput: unknown = r.tool_input;
    let toolResponse: unknown = r.tool_response;

    if (hookEventName === 'AfterAgent' && r.prompt_response) {
      toolName = toolName ?? 'GeminiAgent';
      toolInput = toolInput ?? { prompt: r.prompt };
      toolResponse = toolResponse ?? { response: r.prompt_response };
    }

    return {
      sessionId,
      cwd,
      prompt: r.prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcript_path,
    };
  },

  formatOutput(result) {
    // Gemini CLI expects: { continue, stopReason, suppressOutput, systemMessage, decision, reason }
    const output: Record<string, unknown> = {};

    // Always include continue — controls whether the agent proceeds
    output.continue = result.continue ?? true;

    if (result.suppressOutput !== undefined) {
      output.suppressOutput = result.suppressOutput;
    }

    if (result.systemMessage) {
      output.systemMessage = result.systemMessage;
    }

    // hookSpecificOutput carries context injection data
    if (result.hookSpecificOutput) {
      output.systemMessage = result.hookSpecificOutput.additionalContext || output.systemMessage;
    }

    return output;
  }
};
