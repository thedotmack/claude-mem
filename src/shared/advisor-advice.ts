// SPDX-License-Identifier: Apache-2.0

/**
 * Reduce a tool_response of unknown shape (plain string, Anthropic-style
 * content-block array, or an object wrapping either) down to the advice text
 * returned by the `advisor` tool. Falls back to JSON.stringify for shapes we
 * don't recognize rather than dropping the response — the advice is the
 * entire point of an advisor_calls / agent_events record.
 *
 * Shared between the classic worker's SQLite ingestion (services/worker/http/shared.ts)
 * and the server's agent_events-backed v1 routes, which both need to turn a
 * raw PostToolUse tool_response into readable text.
 */
export function stringifyAdvice(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') {
    return toolResponse.trim();
  }
  if (Array.isArray(toolResponse)) {
    return toolResponse
      .filter((c): c is { type: 'text'; text: string } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
      .map(c => c.text)
      .join('\n')
      .trim();
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const obj = toolResponse as { text?: unknown; content?: unknown };
    if (typeof obj.text === 'string') {
      return obj.text.trim();
    }
    if (obj.content !== undefined) {
      return stringifyAdvice(obj.content);
    }
  }
  if (toolResponse === undefined || toolResponse === null) {
    return '';
  }
  return JSON.stringify(toolResponse);
}
