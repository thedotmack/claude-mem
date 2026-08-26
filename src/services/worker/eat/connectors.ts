import { createMCPClient } from '@ai-sdk/mcp';
import type { EatSource } from './types.js';
import type { EatExtractedItem, EatExtraction } from './extract.js';

export interface EatMcpConfig {
  url: string;
  resource?: string;
  headers?: Record<string, string>;
}

export async function extractFromMcp(url: string, opts: { resource?: string; headers?: Record<string, string> } = {}): Promise<EatExtraction> {
  // redirect stays at its default ('error') — SSRF protection.
  const client = await createMCPClient({
    transport: { type: 'http', url, headers: opts.headers },
  });

  const uris = opts.resource !== undefined
    ? [opts.resource]
    : (await client.listResources()).resources.map(resource => resource.uri);

  const items: EatExtractedItem[] = [];
  let skipped = 0;
  for (const uri of uris) {
    const result = await client.readResource({ uri });
    for (const content of result.contents) {
      const text = (content as { text?: unknown }).text;
      if (typeof text !== 'string') {
        skipped++;
        continue;
      }
      const source: EatSource = { kind: 'mcp', locator: `${url}#${uri}` };
      if (content.mimeType !== undefined) source.contentType = content.mimeType;
      items.push({ text, source });
    }
  }

  await client.close();
  return { items, skipped };
}
