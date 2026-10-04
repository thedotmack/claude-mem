import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { kimiCodeHome } from '../../shared/kimi-paths.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Kimi's Read uses `path`; shared read capture and file-context use `file_path`.
function normalizeToolInput(toolName: string | undefined, input: unknown): unknown {
  if (toolName !== 'Read' || !input || typeof input !== 'object' || Array.isArray(input)) return input;
  const readInput = input as Record<string, unknown>;
  return typeof readInput.path === 'string' ? { ...readInput, file_path: readInput.path } : input;
}

// Kimi session ids are opaque workDir-scoped identifiers. Restrict to a safe
// character set so a malicious sessionId from stdin cannot escape
// ~/.kimi-code/sessions via path separators, '..' segments, or null bytes
// (security review on PR #3676).
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const transcriptPathCache = new Map<string, string | undefined>();

/**
 * Kimi hook payloads carry no transcript path. Wire logs live at
 * sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl; the workDirKey
 * bucket is derived from cwd, so scan the (small) sessions root instead of
 * reimplementing the bucket hash. Bounded by the directory entry count.
 *
 * The result is memoized per sessionId so repeated hook events for the same
 * session do not rescan the sessions directory.
 */
export function deriveKimiTranscriptPath(sessionId: string): string | undefined {
  const cacheKey = `${kimiCodeHome()}|${sessionId}`;
  const cached = transcriptPathCache.get(cacheKey);
  if (cached !== undefined || transcriptPathCache.has(cacheKey)) {
    return cached;
  }
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    transcriptPathCache.set(cacheKey, undefined);
    return undefined;
  }
  const sessionsRoot = path.join(kimiCodeHome(), 'sessions');
  let workDirs: string[];
  try {
    workDirs = readdirSync(sessionsRoot);
  } catch {
    transcriptPathCache.set(cacheKey, undefined);
    return undefined;
  }
  for (const workDir of workDirs) {
    const candidate = path.join(sessionsRoot, workDir, sessionId, 'agents', 'main', 'wire.jsonl');
    if (existsSync(candidate)) {
      transcriptPathCache.set(cacheKey, candidate);
      return candidate;
    }
  }
  transcriptPathCache.set(cacheKey, undefined);
  return undefined;
}

/**
 * Kimi Code's UserPromptSubmit `prompt` is the message's ContentPart[] (e.g.
 * [{ type: 'text', text: '...' }]), not a string (MoonshotAI/kimi-code#917).
 * Join its text parts; an image-only prompt yields undefined, which
 * session-init records as a media prompt, as it does for Claude Code.
 */
function promptText(prompt: unknown): string | undefined {
  if (!Array.isArray(prompt)) return stringOrUndefined(prompt);
  const text = prompt
    .map((part) => {
      if (typeof part === 'string') return part;
      const candidate = part as { type?: unknown; text?: unknown } | null;
      return candidate?.type === 'text' && typeof candidate.text === 'string' ? candidate.text : '';
    })
    .filter((partText) => partText.length > 0)
    .join('\n')
    .trim();
  return text || undefined;
}

export const kimiAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = typeof r.cwd === 'string' ? r.cwd : process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    const sessionId = stringOrUndefined(r.session_id);
    if (!sessionId) {
      throw new AdapterRejectedInput('missing_session_id');
    }
    const source = r.source;
    const toolName = stringOrUndefined(r.tool_name);
    return {
      sessionId,
      cwd,
      prompt: promptText(r.prompt),
      toolName,
      toolInput: normalizeToolInput(toolName, r.tool_input),
      // Kimi sends `tool_output` on PostToolUse and `error` on
      // PostToolUseFailure where Claude Code sends `tool_response`, and
      // `tool_call_id` where it sends `tool_use_id`.
      toolResponse: r.tool_response ?? r.tool_output ?? r.error,
      toolUseId: stringOrUndefined(r.tool_call_id),
      transcriptPath: deriveKimiTranscriptPath(sessionId),
      model: stringOrUndefined(r.model),
      sessionSource: source === 'startup' || source === 'resume' ? source : undefined,
      // Kimi binds both Stop and PreCompact to the same internal `summarize`
      // event; the raw event name is the only way handlers can tell them apart.
      hookEventName: stringOrUndefined(r.hook_event_name),
    };
  },

  formatOutput(result: HookResult): unknown {
    // Kimi appends plain stdout text to context; it does not understand the
    // Claude/Codex hookSpecificOutput JSON envelope for context injection.
    const context = result?.hookSpecificOutput?.additionalContext;
    if (typeof context === 'string' && context.length > 0) return context;
    return '';
  },
};
