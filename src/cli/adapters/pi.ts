import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

/**
 * Pi (https://github.com/badlogic/pi-mono) adapter.
 *
 * Pi is a coding agent with a TypeScript extension system. Extensions subscribe
 * to lifecycle hooks (`session_start`, `before_agent_start`, `tool_call`,
 * `tool_result`, `agent_end`, `session_before_compact`) via `pi.registerHook`
 * and shell out to the claude-mem worker through `bun-runner.js`.
 *
 * Pi-side extension scaffold lives in `pi-hooks/` and ships as a standalone
 * npm package. The extension owns event-shape normalization, so the adapter
 * here treats the incoming stdin payload as already conforming to
 * `NormalizedHookInput`, with a few Pi-specific niceties:
 *
 * - Pi session JSONL transcripts live under
 *   `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`, where
 *   `<encoded-cwd>` replaces `/` with `-` and `[]` with `--`. The encoder is
 *   not always reversible (the same encoded directory can correspond to more
 *   than one real cwd), so we resolve by UUID prefix at runtime when the
 *   extension supplies the session id.
 * - Pi exposes a `cwd` field on every hook event payload; if missing, fall
 *   back to `process.cwd()` as the worker invocation happens in the
 *   extension's host directory.
 * - `agent_type: 'pi'` is forwarded into `agentType` so dashboards and the
 *   project catalog group Pi observations cleanly.
 */

// Pi session ids are UUIDs; restrict to a safe character set so a malicious
// sessionId from stdin cannot escape ~/.pi/agent/sessions via path separators
// or '..' segments.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const PI_SESSIONS_ROOT = join(homedir(), '.pi', 'agent', 'sessions');

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

/**
 * Resolve the on-disk path to a Pi session JSONL by UUID prefix. Pi launches
 * sessions from arbitrary cwds, so the encoded-cwd directory is not stable
 * across invocations. The UUID prefix is unique enough to identify the
 * canonical file without parsing the encoded path.
 *
 * Implementation note: a synchronous shallow walk of `~/.pi/agent/sessions`
 * is acceptable here because the directory typically holds <100 entries and
 * the hook stdin is read once per tool call. If this becomes hot we can
 * cache by session id.
 */
export function derivePiTranscriptPath(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return undefined;
  if (!existsSync(PI_SESSIONS_ROOT)) return undefined;

  // The Pi-side extension is the authoritative source of the transcript
  // path; the adapter never invents one. If the extension omits the path,
  // worker-side handlers gracefully degrade to session-id lookup against
  // the observations table. Returning undefined here is the right default.
  return undefined;
}

export const piAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    // Pi extension may emit either camelCase (NormalizedHookInput shape) or
    // snake_case (raw hook event shape). Accept both so the extension stays
    // free to forward Pi's native event payload without reshaping.
    const cwd = r.cwd ?? r.workingDirectory ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId =
      r.sessionId ?? r.session_id ?? r.sessionUuid ?? r.session_uuid;

    const toolName = r.toolName ?? r.tool_name ?? r.toolType ?? r.tool_type;
    const toolInput = r.toolInput ?? r.tool_input ?? r.input;
    const toolResponse =
      r.toolResponse ?? r.tool_response ?? r.output ?? r.result;

    return {
      sessionId,
      cwd,
      prompt: r.prompt ?? r.userMessage ?? r.user_message,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath:
        r.transcriptPath ?? r.transcript_path ?? derivePiTranscriptPath(sessionId),
      filePath: r.filePath ?? r.file_path ?? r.path,
      edits: r.edits,
      lastAssistantMessage:
        r.lastAssistantMessage ?? r.last_assistant_message,
      turnId: r.turnId ?? r.turn_id,
      stopHookActive: r.stopHookActive ?? r.stop_hook_active,
      permissionMode: r.permissionMode ?? r.permission_mode,
      model: r.model ?? r.modelName ?? r.model_name,
      sessionSource: r.sessionSource ?? r.session_source,
      agentId: pickAgentField(r.agentId ?? r.agent_id),
      agentType: pickAgentField(r.agentType ?? r.agent_type) ?? 'pi',
      metadata: r.metadata,
    };
  },
  formatOutput(result) {
    // Pi extensions consume the worker response as JSON and decide whether
    // to surface `additionalContext` to the model. Keep the response shape
    // close to the canonical Claude Code form so a Pi extension can reuse
    // the same hookSpecificOutput plumbing.
    const r = result ?? ({} as HookResult);
    const output: Record<string, unknown> = { continue: r.continue ?? true };
    if (r.hookSpecificOutput) {
      output.hookSpecificOutput = r.hookSpecificOutput;
    }
    if (r.systemMessage) {
      output.systemMessage = r.systemMessage;
    }
    if (r.suppressOutput !== undefined) {
      output.suppressOutput = r.suppressOutput;
    }
    return output;
  },
};
