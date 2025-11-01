import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VECTOR_DB_DIR } from '../../shared/paths.js';

interface ChromaQueryResult {
  ids: string[][];
  documents: string[][];
  metadatas: Record<string, any>[][];
  distances: number[][];
}

export class ChromaOrchestrator {
  private client: Client | null = null;
  private collectionName = 'cm__claude-mem';

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: 'uvx',
      args: [
        'chroma-mcp',
        '--client-type', 'persistent',
        '--data-dir', VECTOR_DB_DIR
      ]
    });

    this.client = new Client({
      name: 'claude-mem-search-orchestrator',
      version: '1.0.0'
    }, { capabilities: {} });

    await this.client.connect(transport);
  }

  async queryDocuments(
    query: string,
    nResults: number = 100,
    where?: Record<string, any>
  ): Promise<ChromaQueryResult> {
    if (!this.client) throw new Error('Chroma client not connected');

    const result = await this.client.callTool({
      name: 'chroma_query_documents',
      arguments: {
        collection_name: this.collectionName,
        query_texts: [query],
        n_results: nResults,
        ...(where && { where }),
        include: ['documents', 'metadatas', 'distances']
      }
    });

    return JSON.parse(result.content[0].text);
  }

  extractSqliteIds(chromaResult: ChromaQueryResult): number[] {
    // Extract unique sqlite_id values from metadata
    const ids = new Set<number>();
    chromaResult.metadatas[0]?.forEach(meta => {
      if (meta.sqlite_id) ids.add(meta.sqlite_id);
    });
    return Array.from(ids);
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
  }
}
