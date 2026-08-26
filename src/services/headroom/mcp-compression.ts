
import { HeadroomService } from './HeadroomService.js';

/**
 * Delivery-time compression glue between the MCP search server and the
 * Headroom proxy (Phase 3). Stored observations are never altered — only the
 * payload text handed back to the primary agent is compressed, and only when
 * CLAUDE_MEM_HEADROOM_ENABLED is 'true'.
 */

/**
 * Pull the text back out of a Headroom result message. Compressed messages
 * come back in the same role/content shape they were sent in (the format
 * detector rewrites `content` in place), so a string-content input yields a
 * string-content output; content-block arrays are joined defensively.
 */
function extractMessageContent(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (typeof block?.text === 'string') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return '';
}

/**
 * Route a tool response payload through the Headroom proxy.
 *
 * Returns the original text unchanged when Headroom is disabled
 * (compressPayload → null), when the proxy is unreachable (`fallback: true`
 * → `compressed: false`), or when the payload is below Headroom's
 * compression thresholds. On success, returns the compressed text with a
 * single trailing stats line mirroring the `Stats:` economics style.
 */
export async function maybeCompressToolResponse(payloadText: string): Promise<string> {
  const result = await HeadroomService.getInstance().compressPayload([
    { role: 'user', content: payloadText },
  ]);
  if (!result || !result.compressed) {
    return payloadText;
  }

  const compressedText = (result.messages ?? []).map(extractMessageContent).join('\n');
  if (compressedText.trim().length === 0) {
    return payloadText;
  }

  const statsLine = `Headroom: ${result.tokensBefore.toLocaleString()}t → ${result.tokensAfter.toLocaleString()}t (${result.tokensSaved.toLocaleString()}t saved)`;
  return `${compressedText}\n\n${statsLine}`;
}

/**
 * MCP tool that reverses CCR compression markers embedded in compressed
 * payloads. Registered only while Headroom is enabled (see
 * headroomRetrieveToolIfEnabled); a retrieval failure surfaces through the
 * MCP server's shared tool-error path.
 */
export const headroomRetrieveTool = {
  name: 'headroom_retrieve',
  description: 'Retrieve the original content behind a Headroom CCR marker ("[N items compressed to M. Retrieve more: hash=...]"). Params: hash (required), query (optional relevance filter). Hashes expire after ~30 minutes — if retrieval fails, fall back to get_observations([IDs]) to re-fetch the underlying records.',
  inputSchema: {
    type: 'object',
    properties: {
      hash: { type: 'string', description: 'CCR hash from a compressed payload marker (required)' },
      query: { type: 'string', description: 'Optional query to filter the retrieved content' },
    },
    required: ['hash'],
    additionalProperties: false,
  },
  handler: async (args: any) => {
    if (typeof args?.hash !== 'string' || args.hash.trim() === '') throw new Error('headroom_retrieve: "hash" is required');
    const result = await HeadroomService.getInstance().retrieve(args.hash, args.query);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
};

/**
 * Conditional registration for headroom_retrieve: spread into both the
 * tools/list advertisement and the tools/call dispatch so the tool exists
 * only while CLAUDE_MEM_HEADROOM_ENABLED is 'true' (re-checked per request,
 * matching the per-call runtime selection above it).
 */
export function headroomRetrieveToolIfEnabled(): Array<typeof headroomRetrieveTool> {
  return HeadroomService.getInstance().isEnabled() ? [headroomRetrieveTool] : [];
}
