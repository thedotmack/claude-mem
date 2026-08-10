// SPDX-License-Identifier: Apache-2.0

// Kimi Code platform adapter.
//
// Payload facts below were verified against live Kimi Code (v2, Node engine)
// hook payloads — see https://github.com/thedotmack/claude-mem/pull/2908 for
// the original integration this corrects:
//
//  - PostToolUse payloads carry `tool_output` / `tool_call_id`, NOT Claude
//    Code's `tool_response` / `tool_use_id`.
//  - Stop payloads carry only {cwd, hook_event_name, session_id,
//    stop_hook_active} — no transcript_path and no last_assistant_message,
//    so we synthesize a transcript from Kimi's wire.jsonl session log.
//  - Kimi appends a hook's raw stdout to the model context on
//    UserPromptSubmit, and ignores SessionStart hook stdout entirely. A JSON
//    hook envelope would be injected verbatim, so context is emitted as
//    plain text and everything else stays silent.
//  - SessionStart sources are 'startup' | 'resume'.

import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import { synthesizeKimiTranscript } from './kimi-transcript.js';

export const kimiAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as any;

    const cwd = r.cwd
      ?? process.env.KIMI_CWD
      ?? process.env.KIMI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = r.session_id ?? process.env.KIMI_SESSION_ID ?? undefined;
    if (!sessionId) {
      throw new AdapterRejectedInput('missing_session_id');
    }

    const hookEventName: string | undefined = r.hook_event_name;

    const toolName: string | undefined = r.tool_name;
    const toolInput: unknown = r.tool_input;
    // Kimi sends tool_output where Claude Code sends tool_response.
    const toolResponse: unknown = r.tool_response ?? r.tool_output;

    // Kimi sends the user prompt on UserPromptSubmit. Coerce to string to guard against
    // multimodal payloads where prompt may be an object/array.
    const rawField: unknown = r.prompt ?? r.query ?? r.input ?? r.message;
    let prompt: string | undefined;
    if (typeof rawField === 'string') {
      prompt = rawField;
    } else if (Array.isArray(rawField)) {
      prompt = rawField
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        })
        .join('\n')
        .trim();
      if (prompt.length === 0) prompt = undefined;
    } else if (rawField && typeof rawField === 'object' && typeof (rawField as any).text === 'string') {
      prompt = (rawField as any).text;
    }

    // Kimi's Stop payload has no transcript_path / last_assistant_message.
    // Convert the session's wire.jsonl to Claude Code transcript format so
    // the summarize handler can extract the final assistant message.
    let transcriptPath: string | undefined = r.transcript_path;
    if (hookEventName === 'Stop' && !transcriptPath && r.last_assistant_message === undefined) {
      try {
        transcriptPath = synthesizeKimiTranscript(sessionId) ?? undefined;
      } catch {
        // Best effort — the summarize handler degrades to a logged skip
        // when no transcript is available.
      }
    }

    return {
      sessionId,
      cwd,
      prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath,
      lastAssistantMessage: r.last_assistant_message,
      turnId: r.turn_id,
      stopHookActive: r.stop_hook_active,
      permissionMode: r.permission_mode,
      model: r.model,
      sessionSource: r.source === 'startup' || r.source === 'resume'
        ? r.source
        : undefined,
      filePath: r.file_path,
      edits: r.edits,
    };
  },

  formatOutput(result): string | undefined {
    // Kimi appends raw hook stdout to the model context on UserPromptSubmit;
    // anything else written to stdout is UI noise. Emit the context text
    // plain (no JSON envelope) and stay silent otherwise — exit code 0
    // already means "continue".
    const ctx = result.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.trim()) {
      return ctx;
    }
    return undefined;
  }
};
