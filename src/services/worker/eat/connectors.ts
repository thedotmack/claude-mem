import { createMCPClient } from '@ai-sdk/mcp';
import { logger } from '../../../utils/logger.js';
import { EatError } from './errors.js';
import type { EatExtractReject, EatSource } from './types.js';
import type { EatExtractedItem, EatExtraction } from './extract.js';

function rejectMcpItem(source: EatSource, reason: string): EatExtractReject {
  logger.warn('INGEST', 'EAT item rejected during extract', { locator: source.locator, reason });
  return { source, reason };
}

export interface EatMcpConfig {
  url: string;
  resource?: string;
  headers?: Record<string, string>;
}

export async function extractFromMcp(url: string, opts: { resource?: string; headers?: Record<string, string> } = {}): Promise<EatExtraction> {
  // redirect stays at its default ('error') — SSRF protection.
  let client: Awaited<ReturnType<typeof createMCPClient>>;
  try {
    client = await createMCPClient({
      transport: { type: 'http', url, headers: opts.headers },
    });
  } catch (error) {
    // A connector that never connects is an upstream failure, not an empty success.
    const message = error instanceof Error ? error.message : String(error);
    throw new EatError('upstream_fetch_failed', `MCP connect failed for ${url}: ${message}`);
  }

  try {
    let uris: string[];
    if (opts.resource !== undefined) {
      uris = [opts.resource];
    } else {
      try {
        uris = (await client.listResources()).resources.map(resource => resource.uri);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EatError('upstream_fetch_failed', `MCP listResources failed for ${url}: ${message}`);
      }
    }

    const items: EatExtractedItem[] = [];
    const rejects: EatExtractReject[] = [];
    for (const uri of uris) {
      const source: EatSource = { kind: 'mcp', locator: `${url}#${uri}` };
      let contents: Awaited<ReturnType<typeof client.readResource>>['contents'];
      try {
        contents = (await client.readResource({ uri })).contents;
      } catch (error) {
        // Per-resource boundary: one unreadable resource rejects; the run continues.
        const message = error instanceof Error ? error.message : String(error);
        rejects.push(rejectMcpItem(source, `MCP readResource failed: ${message}`));
        continue;
      }
      for (const content of contents) {
        const text = (content as { text?: unknown }).text;
        if (typeof text !== 'string') {
          rejects.push(rejectMcpItem(source, `Non-text resource content (${content.mimeType ?? 'unknown mime type'})`));
          continue;
        }
        const itemSource: EatSource = { ...source };
        if (content.mimeType !== undefined) itemSource.contentType = content.mimeType;
        items.push({ text, source: itemSource });
      }
    }

    return { items, rejects };
  } finally {
    // close() must run even when a read throws; a failed close never masks
    // the real error.
    try {
      await client.close();
    } catch (error) {
      logger.warn('INGEST', 'MCP client close failed', { url }, error as Error);
    }
  }
}
