import type { HelixTransport } from './transport.js'

export async function ensureHelixSchema(transport: HelixTransport): Promise<void> {
  await transport.ensureSearchIndexes()
}

