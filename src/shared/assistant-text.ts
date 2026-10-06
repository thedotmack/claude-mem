/**
 * The answer text of an OpenAI-shaped reply's `message.content`. Gateways may
 * send content blocks instead of a string; only text blocks count, and
 * reasoning or tool-call arguments are never substituted for the answer
 * (#4017). Anything else reads as no text.
 */
export function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

