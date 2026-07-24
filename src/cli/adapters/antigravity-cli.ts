import type { PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';
import fs from 'fs';

// agy wraps the real user message in <USER_REQUEST>...</USER_REQUEST> and
// appends injected <ADDITIONAL_METADATA> (local time) and <USER_SETTINGS_CHANGE>
// (model switches) blocks. Keep only the genuine request text.
function unwrapAgyUserInput(text: string): string {
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  return text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
}

// Antigravity transcript.jsonl lines: {step_index, source, type, content}.
// The assistant's final text lives ONLY in type=PLANNER_RESPONSE nodes —
// RUN_COMMAND/VIEW_FILE/etc. also carry source=MODEL, so filter by type.
function readLastTranscriptContent(
  transcriptPath: string,
  nodeType: 'USER_INPUT' | 'PLANNER_RESPONSE',
): string | undefined {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return undefined;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8').trim();
    if (!content) return undefined;
    const lines = content.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (!obj || obj.type !== nodeType) continue;
        if (typeof obj.content === 'string' && obj.content.trim()) {
          const text = obj.content.trim();
          return nodeType === 'USER_INPUT' ? unwrapAgyUserInput(text) : text;
        }
        if (Array.isArray(obj.content)) {
          const textParts = obj.content
            .filter((c: any) => c && typeof c.text === 'string' && c.text.trim())
            .map((c: any) => c.text.trim());
          if (textParts.length > 0) {
            const text = textParts.join('\n');
            return nodeType === 'USER_INPUT' ? unwrapAgyUserInput(text) : text;
          }
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

// Antigravity's hook stdin is a FLAT payload with no event-name field
// (verified against live payloads): {conversationId, workspacePaths,
// transcriptPath, toolCall?, error? (PostToolUse only), invocationNum +
// initialNumSteps (Pre/PostInvocation only), terminationReason (Stop only)}.
// Key shape is therefore the authoritative event discriminator.
export const antigravityCliAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;

    const cwd = r.workspacePaths?.[0]
      ?? r.cwd
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

    const transcriptPath = r.transcriptPath ?? r.transcript_path;

    const hasToolCall = Boolean(r.toolCall);
    const hasErrorKey = 'error' in r;
    const isInvocationEvent = 'invocationNum' in r && !hasToolCall;

    let toolName: string | undefined = r.toolCall?.name ?? r.tool_name;
    let toolInput: unknown = r.toolCall?.args ?? r.tool_input;
    let toolResponse: unknown = r.tool_response;

    const prompt = r.prompt
      ?? (transcriptPath ? readLastTranscriptContent(transcriptPath, 'USER_INPUT') : undefined);

    // Pre- and PostInvocation payloads are identical; the CLI event arg in
    // hooks.json routes PreInvocation to the context handler (which ignores
    // toolName) and PostInvocation to observation, so setting the provider
    // fields for both is safe.
    if (isInvocationEvent) {
      const extractedResponse = transcriptPath
        ? readLastTranscriptContent(transcriptPath, 'PLANNER_RESPONSE')
        : undefined;

      toolName = 'AntigravityProvider';
      toolInput = { prompt: prompt ?? 'User Query' };
      toolResponse = { response: extractedResponse ?? 'Completed' };
    }

    if (hasToolCall && !hasErrorKey && toolName && !toolResponse) {
      toolResponse = { _preExecution: true };
    }

    if (hasToolCall && hasErrorKey && toolName && !toolResponse) {
      toolResponse = r.error && typeof r.error === 'string'
        ? { error: r.error }
        : { status: 'completed' };
    }

    return {
      sessionId,
      cwd,
      prompt,
      toolName,
      toolInput,
      toolResponse,
      transcriptPath,
    };
  },

  // Antigravity deserializes hook stdout with strict protojson — unknown
  // fields (continue/suppressOutput/systemMessage/...) make it discard the
  // whole payload, and a missing allowTool on PreToolUse defaults to false,
  // blocking every tool call. Only emit fields in agy's proto definition.
  formatOutput(result, rawInput) {
    const r = result ?? {};
    const raw = (rawInput ?? {}) as any;
    const isPreTool = Boolean(raw.toolCall) && !('error' in raw);

    if (r.continue === false || r.decision === 'block') {
      return {
        allowTool: false,
        denyReason: r.reason ?? 'Denied by hook',
        decision: 'deny',
        reason: r.reason ?? 'Denied by hook',
      };
    }

    const additionalContext = r.hookSpecificOutput?.additionalContext ?? r.systemMessage;
    if (additionalContext) {
      const ansiRegex = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
      const cleanMessage = (additionalContext as string).replace(ansiRegex, '');
      return {
        injectSteps: [
          {
            ephemeralMessage: cleanMessage
          }
        ]
      };
    }

    if (isPreTool) {
      return {
        allowTool: true
      };
    }

    return {};
  }
};
