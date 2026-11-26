import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { AdapterRejectedInput } from './errors.js';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ZCode sends Claude Code field and tool names (in snake_case and camelCase),
// so the Claude Code adapter does the mapping, PostToolUseFailure included.
export const zcodeAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    const projectDir = stringOrUndefined(process.env.ZCODE_PROJECT_DIR);
    const payload = stringOrUndefined(r.cwd) || !projectDir ? r : { ...r, cwd: projectDir };
    const input = claudeCodeAdapter.normalizeInput(payload);
    if (!stringOrUndefined(input.sessionId)) {
      throw new AdapterRejectedInput('missing_session_id');
    }
    return {
      ...input,
      // ZCode deletes this temp file once the hook exits and its format is not
      // documented; summarize uses last_assistant_message instead.
      transcriptPath: undefined,
    };
  },

  // ZCode reads `hookSpecificOutput.additionalContext`, the Claude Code envelope.
  formatOutput(result: HookResult): unknown {
    return claudeCodeAdapter.formatOutput(result);
  },
};
