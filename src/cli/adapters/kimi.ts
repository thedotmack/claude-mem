// SPDX-License-Identifier: Apache-2.0

import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

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

    const sessionId = r.session_id
      ?? process.env.KIMI_SESSION_ID
      ?? undefined;

    const hookEventName: string | undefined = r.hook_event_name;

    const toolName: string | undefined = r.tool_name;
    const toolInput: unknown = r.tool_input;
    const toolResponse: unknown = r.tool_response;

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

    const metadata: Record<string, unknown> = {};
    if (r.source) metadata.source = r.source;
    if (r.reason) metadata.reason = r.reason;
    if (r.trigger) metadata.trigger = r.trigger;
    if (r.mcp_context) metadata.mcp_context = r.mcp_context;
    if (r.notification_type) metadata.notification_type = r.notification_type;
    if (r.stop_hook_active !== undefined) metadata.stop_hook_active = r.stop_hook_active;
    if (r.original_request_name) metadata.original_request_name = r.original_request_name;
    if (hookEventName) metadata.hook_event_name = hookEventName;

    return {
      sessionId,
      cwd,
      prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath: r.transcript_path,
      lastAssistantMessage: r.last_assistant_message,
      turnId: r.turn_id,
      stopHookActive: r.stop_hook_active,
      permissionMode: r.permission_mode,
      model: r.model,
      sessionSource: r.source === 'startup' || r.source === 'resume' || r.source === 'clear'
        ? r.source
        : undefined,
      filePath: r.file_path,
      edits: r.edits,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result): Record<string, unknown> | undefined {
    // Kimi displays stdout in the UI, so emit nothing when there's no
    // context/system message to inject. Exit code 0 already means "continue".
    const hasOutput = result.systemMessage || result.hookSpecificOutput?.additionalContext;
    if (!hasOutput) {
      return undefined;
    }

    const output: Record<string, unknown> = {
      continue: result.continue ?? true,
    };

    if (result.systemMessage) {
      output.systemMessage = result.systemMessage;
    }

    // Kimi follows the Codex/Claude SDK standard for context injection:
    // top-level additionalContext.
    if (result.hookSpecificOutput?.additionalContext) {
      output.additionalContext = result.hookSpecificOutput.additionalContext;
    }

    return output;
  }
};
