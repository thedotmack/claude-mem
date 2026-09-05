
import type { ConversationMessage } from '../worker-types.js';

/**
 * Bound the OpenAI-compatible message list sent to the model on the
 * OpenRouter path. Root cause of #3606: `session.conversationHistory` was
 * sent in full, with no `system` role, on every call. Against a bounded
 * local context (llama.cpp / Ollama) that either fills the context window
 * (truncation → empty content) or scrolls the observation schema — stated
 * once in the init prompt — out of view (model degrades to bare prose). This
 * module fixes both: the init/continuation prompt is always pinned as
 * `system` so the schema survives regardless of history length, and the rest
 * of the turns are capped by count and total chars.
 */

/** 0 = unbounded for either field. */
export interface ContextWindowLimits {
  /** Max history turns kept AFTER the system anchor. */
  maxMessages: number;
  /** Max total chars of that windowed history. */
  maxChars: number;
}

export interface BoundedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * `history[0]` is always the init or continuation prompt (see
 * OpenAICompatibleProvider.startSession) and carries `system_identity` +
 * `observer_role` + the full `<observation>` skeleton — it is pinned as the
 * `system` message so the schema is never at risk of scrolling out of
 * context. The remaining turns are windowed by count, then by total chars,
 * then leading `assistant` turns are dropped so the first non-system message
 * is a `user` turn (strict OpenAI-compatible gateways reject assistant-first;
 * this also drops the orphaned init acknowledgement a front-trim can leave
 * behind).
 */
export function buildBoundedMessages(
  history: ConversationMessage[],
  limits: ContextWindowLimits
): BoundedMessage[] {
  if (history.length === 0) {
    return [];
  }

  const system: BoundedMessage = { role: 'system', content: history[0].content };
  let rest = history.slice(1);

  if (limits.maxMessages > 0 && rest.length > limits.maxMessages) {
    rest = rest.slice(rest.length - limits.maxMessages);
  }

  if (limits.maxChars > 0) {
    let totalChars = rest.reduce((sum, m) => sum + m.content.length, 0);
    // The final message is always sent even if it alone exceeds the budget —
    // that's the batch actually being asked about; dropping it would leave
    // nothing for the model to respond to.
    while (totalChars > limits.maxChars && rest.length > 1) {
      totalChars -= rest[0].content.length;
      rest = rest.slice(1);
    }
  }

  while (rest.length > 0 && rest[0].role === 'assistant') {
    rest = rest.slice(1);
  }

  return [
    system,
    ...rest.map(m => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: m.content,
    })),
  ];
}
