// Who holds the next move in a conversation, read from the end of its transcript. The agent tool writes the
// transcript; this only reads which kind of record it ends on, never what the record says. A conversation whose
// transcript is missing or ends on nothing decisive has no turn state (null). No Node imports: My Work loads this file.
//
//   owner-turn: turn-ended (the agent finished or was interrupted) | question-pending (it asked through a tool)
//   agent-turn: owner-spoke (a prompt it has not acted on yet)     | tool-running (a tool call or its result is last)
//
//   owner-turn <-> agent-turn as the transcript grows. Nothing is stored: each read says where the transcript is now.
//   The one writer is the transcript reader (turn-state-reader.mjs).
export const TURN_REASONS = ['turn-ended', 'question-pending', 'owner-spoke', 'tool-running'];

const HOLDER = { 'turn-ended': 'owner-turn', 'question-pending': 'owner-turn', 'owner-spoke': 'agent-turn', 'tool-running': 'agent-turn' };

/** The platforms whose transcripts this reads. */
export const TURN_PLATFORMS = ['claude', 'codex'];

// A tool call that stops the agent until the owner replies in the chat.
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input']);
// Claude ends a turn on these; `tool_use` and a missing stop reason mean it is still going.
const CLAUDE_TURN_END = new Set(['end_turn', 'stop_sequence', 'refusal']);
const CLAUDE_LOCAL_OUTPUT = /^<(?:local-command-stdout|bash-stdout|bash-stderr)>/;
const CLAUDE_LOCAL_INPUT = /^<(?:command-name|command-message|bash-input)>/;
const CLAUDE_INTERRUPTED = /^\[Request interrupted by user/;
const CODEX_TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

const toolReason = (name) => QUESTION_TOOLS.has(name) ? 'question-pending' : 'tool-running';

function claudeText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.find((block) => block?.type === 'text' && typeof block.text === 'string')?.text ?? '' : '';
}

/** One reader per platform: the reason a record decides, or null when the scan should keep going back. `seen` is the
 * reader's own memory across the scan (newest record first). */
const READERS = {
  claude(record, seen) {
    // A subagent's records, injected context and a compaction summary are not moves in the owner's conversation.
    if (record.isSidechain || record.isMeta || record.isCompactSummary) return null;
    const content = record.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    if (record.type === 'assistant') {
      const call = blocks.find((block) => block?.type === 'tool_use');
      if (call) return toolReason(call.name);
      return CLAUDE_TURN_END.has(record.message?.stop_reason) ? 'turn-ended' : null;
    }
    if (record.type !== 'user') return null;
    if (blocks.some((block) => block?.type === 'tool_result')) return 'tool-running';
    const text = claudeText(content);
    if (CLAUDE_INTERRUPTED.test(text)) return 'turn-ended';
    // A local command (`/model`, `!ls`) and its output never reach the agent.
    if (CLAUDE_LOCAL_OUTPUT.test(text)) { seen.localOutput = true; return null; }
    if (CLAUDE_LOCAL_INPUT.test(text) && (seen.localOutput || text.startsWith('<bash-input>'))) { seen.localOutput = false; return null; }
    return 'owner-spoke';
  },
  codex(record) {
    const kind = record.payload?.type;
    if (record.type === 'event_msg') {
      if (kind === 'task_complete' || kind === 'turn_aborted') return 'turn-ended';
      return kind === 'task_started' ? 'owner-spoke' : null;
    }
    if (record.type !== 'response_item' || typeof kind !== 'string') return null;
    if (CODEX_TOOL_CALLS.has(kind)) return toolReason(record.payload.name);
    return kind.endsWith('_output') ? 'tool-running' : null;
  },
};

/**
 * The turn state the last decisive record of a transcript tail shows. `tail` is the end of the file as text; a first
 * line cut by the read is skipped like any other unreadable line. Returns only the state, the reason and the record's
 * time.
 */
export function turnStateFromTail(platform, tail) {
  const reader = Object.hasOwn(READERS, platform) ? READERS[platform] : null;
  if (!reader || typeof tail !== 'string') return null;
  const seen = {};
  let end = tail.length;
  while (end > 0) {
    const start = tail.lastIndexOf('\n', end - 1);
    const line = tail.slice(start + 1, end);
    end = start;
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    const reason = reader(record, seen);
    if (!reason) continue;
    const at = Date.parse(record.timestamp);
    return { state: HOLDER[reason], reason, atEpoch: Number.isFinite(at) ? at : null };
  }
  return null;
}
