
import type { CompressResult } from 'headroom-ai';
import { logger } from '../../utils/logger.js';
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
/**
 * Rate limit on the compress-rejection warn log: a dead proxy makes EVERY
 * heavy tool call take this path, and one warn per minute tells the story as
 * well as hundreds would.
 */
const COMPRESSION_WARN_INTERVAL_MS = 60_000;
let lastCompressionWarnAt = 0;

function warnCompressionRejection(error: unknown): void {
  const now = Date.now();
  if (now - lastCompressionWarnAt < COMPRESSION_WARN_INTERVAL_MS) {
    return;
  }
  lastCompressionWarnAt = now;
  logger.warn('HEADROOM', 'compress() rejected — returning the original payload (warn rate-limited to one per minute)', {
    error: error instanceof Error ? error.message : String(error),
  });
}

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
  // Rejection guard: `fallback: true` covers an unreachable proxy, but any
  // non-fallback rejection (proxy 500, malformed response, SDK bug) must
  // never convert a good tool result into an error — degrade to the
  // original payload with a rate-limited warn.
  let result: CompressResult | null;
  try {
    result = await HeadroomService.getInstance().compressPayload([
      { role: 'user', content: payloadText },
    ]);
  } catch (error) {
    warnCompressionRejection(error);
    return payloadText;
  }
  // headroom-ai 0.36.5 reports `compressed: true` for every successful HTTP
  // response, including a below-threshold no-op. Preserve the documented
  // byte-identical pass-through unless the proxy reports actual savings.
  if (
    !result
    || !result.compressed
    || !Number.isFinite(result.tokensSaved)
    || !Number.isFinite(result.tokensBefore)
    || !Number.isFinite(result.tokensAfter)
    || result.tokensSaved <= 0
    || result.tokensAfter >= result.tokensBefore
  ) {
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
 * headroomRetrieveToolIfEnabled). Validation failures (missing hash) throw
 * and surface through the MCP server's shared tool-error path; network
 * failures instead return a helpful text response advising the
 * get_observations([IDs]) fallback — the agent can always act on that.
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
    if (args.query !== undefined && typeof args.query !== 'string') {
      throw new Error('headroom_retrieve: "query" must be a string when provided');
    }
    const hash = args.hash.trim();
    const headroom = HeadroomService.getInstance();
    if (!headroom.isEnabled()) {
      // Defense in depth: the tool is not registered while disabled, but a
      // race with a settings flip must still answer clearly, not error.
      return {
        content: [{
          type: 'text' as const,
          text: 'Headroom is disabled (CLAUDE_MEM_HEADROOM_ENABLED is not "true"), so there is no compression store to retrieve from. Use get_observations([IDs]) to fetch the underlying records directly.',
        }],
      };
    }
    try {
      const result = await headroom.retrieve(hash, args.query);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      // Network/proxy failure (or an expired hash): keep the agent moving
      // with the documented fallback instead of a raw error.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('HEADROOM', 'headroom_retrieve failed — advising get_observations fallback', {
        hash,
        error: message,
      });
      return {
        content: [{
          type: 'text' as const,
          text: `headroom_retrieve could not fetch hash "${hash}" (${message}). CCR hashes expire after ~30 minutes and require the Headroom proxy to be running — fall back to get_observations([IDs]) to re-fetch the underlying records.`,
        }],
      };
    }
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
