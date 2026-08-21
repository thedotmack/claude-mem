import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { kimiCodeHome } from '../../shared/kimi-paths.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
    return {
      sessionId,
      cwd,
      prompt: stringOrUndefined(r.prompt),
      toolName: stringOrUndefined(r.tool_name),
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: deriveKimiTranscriptPath(sessionId),
      model: stringOrUndefined(r.model),
      sessionSource: source === 'startup' || source === 'resume' ? source : undefined,
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
