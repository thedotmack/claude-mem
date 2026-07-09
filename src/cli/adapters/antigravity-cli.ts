import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

/**
 * Antigravity CLI adapter.
 *
 * Antigravity replaces Gemini CLI (Gemini CLI stops serving 2026-06-18). Its
 * declarative hooks live in ~/.gemini/config/hooks.json and the stdin payload
 * is shaped differently from Gemini CLI:
 *
 *   {
 *     "conversationId": "...",            // → sessionId
 *     "artifactDirectoryPath": "...",
 *     "stepIdx": 50,
 *     "toolCall": { "name": "run_command", "args": { "CommandLine": ..., "Cwd": ... } },
 *     "transcriptPath": "...",
 *     "workspacePaths": ["..."],          // → cwd (first entry)
 *     "error": ""                         // PostToolUse only
 *   }
 *
 * Unlike Gemini CLI, the payload carries NO `hook_event_name`. The event is
 * known only from the CLI argument (`hook antigravity-cli <event>`), so this
 * adapter never infers the event from stdin — it only normalizes the data.
 *
 * The above shape for PreToolUse/PostToolUse was confirmed by live probing
 * agy 1.0.9 in both headless and interactive sessions. Those are the ONLY two
 * events the CLI hook runner fires today — session/turn lifecycle events
 * (SessionStart, Stop, Compaction, …) exist in the Python SDK but are not yet
 * surfaced by the CLI. See AntigravityCliHooksInstaller for details.
 */
export const antigravityCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    const toolCall = (r.toolCall ?? {}) as Record<string, unknown>;
    const toolArgs = (toolCall.args ?? {}) as Record<string, unknown>;

    const cwd = r.cwd
      ?? (Array.isArray(r.workspacePaths) ? r.workspacePaths[0] : undefined)
      ?? (typeof toolArgs.Cwd === 'string' ? toolArgs.Cwd : undefined)
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = r.conversationId
      ?? r.session_id
      ?? process.env.GEMINI_SESSION_ID
      ?? undefined;

    const toolName = typeof toolCall.name === 'string' ? toolCall.name : undefined;
    const toolInput = toolCall.args !== undefined ? toolCall.args : undefined;

    // PostToolUse carries an `error` field; PreToolUse has no result yet.
    let toolResponse: unknown;
    if ('error' in r) {
      toolResponse = { error: r.error };
    } else if (toolName) {
      toolResponse = { _preExecution: true };
    }

    const metadata: Record<string, unknown> = {};
    if (r.conversationId) metadata.conversationId = r.conversationId;
    if (r.artifactDirectoryPath) metadata.artifactDirectoryPath = r.artifactDirectoryPath;
    if (r.stepIdx !== undefined) metadata.stepIdx = r.stepIdx;

    return {
      sessionId,
      cwd,
      prompt: r.prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcriptPath,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result) {
    // Antigravity hooks read a JSON object on stdout with a `decision` key
    // (allow | deny | ask). claude-mem is a passive observer — it captures
    // memory and never blocks the agent — so it always allows. Context is
    // injected via GEMINI.md (still parsed by Antigravity), not stdout.
    const decision = result.decision === 'block' ? 'deny' : 'allow';

    const output: Record<string, unknown> = { decision };

    if (result.reason) {
      output.reason = result.reason;
    }

    return output;
  }
};
