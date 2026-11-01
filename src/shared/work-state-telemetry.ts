import { normalizePlatformSource } from './platform-source.js';

export type WorkStateTool = 'read' | 'write' | 'native_todo';
export type WorkStateOutcome = 'ok' | 'error' | 'excluded' | 'disabled' | 'unknown';
export type InstructionState = 'returned' | 'disabled' | 'excluded' | 'missing' | 'unknown';
export type AgentRole = 'main' | 'subagent' | 'unknown';
export interface WorkStateAttribution {
  contentSessionId: string;
  platformSource?: string;
  agentId?: string | null;
  agentType?: string | null;
  agentRole?: AgentRole;
  /** Original hook time when capture was spooled, not its later drain time. */
  enqueuedAtEpochMs?: number;
}

const PLATFORMS = new Set(['claude', 'codex', 'cursor', 'kimi', 'antigravity-cli', 'gemini', 'opencode', 'openclaw', 'omp', 'pi', 'qwen', 'windsurf']);

/** No default to Claude: missing host attribution really is unknown. */
export function workStatePlatform(value?: string): string {
  if (!value || value === 'unknown') return 'unknown';
  const normalized = normalizePlatformSource(value);
  return PLATFORMS.has(normalized) ? normalized : 'other';
}

export function workStateTool(name: string): WorkStateTool | null {
  if (name === 'TodoWrite' || name === 'SetTodoList' || name === 'update_plan' || name === 'functions.update_plan') return 'native_todo';
  const local = name.replace(/^mcp__[^_].*?__/, '');
  if (local === 'work_state_write') return 'write';
  if (local === 'work_state_read') return 'read';
  return null;
}

/** Inspect only the receipt shape; never send its text or fields. */
export function workStateOutcome(tool: WorkStateTool, response: unknown): WorkStateOutcome {
  // Claude hooks can carry plain text, a JSON-encoded MCP result, or the
  // host's {error, is_interrupt} failure. Inspect only a bounded receipt.
  if (typeof response === 'string') {
    if (response.length <= 32_768 && response.trimStart().startsWith('{')) {
      try { return workStateOutcome(tool, JSON.parse(response)); } catch {}
    }
    return classifyReceipt(tool, response.slice(0, 1_500), false);
  }
  if (!response || typeof response !== 'object') return 'unknown';
  const result = response as { isError?: boolean; error?: unknown; content?: Array<{ type?: string; text?: string }> };
  const text = typeof result.error === 'string' ? result.error.slice(0, 1_500)
    : Array.isArray(result.content) ? result.content.slice(0, 5)
    .filter(item => item && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text!.slice(0, 300)).join('\n') : '';
  return classifyReceipt(tool, text, result.isError === true || Boolean(result.error));
}

function classifyReceipt(tool: WorkStateTool, text: string, isError: boolean): WorkStateOutcome {
  if (text.includes('CLAUDE_MEM_WORK_STATE_ENABLED=false')) return 'disabled';
  if (text.startsWith('Not saved: this project is excluded')) return 'excluded';
  if (isError || /^(?:Error:|Tool execution failed:|Error executing tool|(?:Worker|Server) request failed(?: \(HTTP \d+\))?\.)/.test(text)) return 'error';
  if (tool === 'write') return text.startsWith('Saved to "') ? 'ok' : 'unknown';
  if (tool === 'read') return text ? 'ok' : 'unknown';
  return 'unknown';
}
