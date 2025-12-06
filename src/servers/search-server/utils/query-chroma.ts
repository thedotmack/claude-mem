import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { silentDebug } from '../../../utils/silent-debug.js';

const COLLECTION_NAME = 'cm__claude-mem';

/**
 * Query Chroma vector database via MCP
 */
export async function queryChroma(
  chromaClient: Client | null,
  query: string,
  limit: number,
  whereFilter?: Record<string, any>
): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
  if (!chromaClient) {
    throw new Error('Chroma client not initialized');
  }

  silentDebug('queryChroma called', { query, limit, whereFilter });

  const whereStringified = whereFilter ? JSON.stringify(whereFilter) : undefined;
  silentDebug('where filter stringified', { whereFilter, whereStringified });

  const arguments_obj = {
    collection_name: COLLECTION_NAME,
    query_texts: [query],
    n_results: limit,
    include: ['documents', 'metadatas', 'distances'],
    where: whereStringified
  };
  silentDebug('calling chroma_query_documents', arguments_obj);

  const result = await chromaClient.callTool({
    name: 'chroma_query_documents',
    arguments: arguments_obj
  });

  const resultText = result.content[0]?.text || '';
  silentDebug('chroma response received', {
    hasContent: !!result.content[0]?.text,
    textLength: resultText.length,
    textPreview: resultText.substring(0, 200)
  });

  // Parse JSON response
  let parsed: any;
  try {
    parsed = JSON.parse(resultText);
  } catch (error) {
    silentDebug('[search-server] Failed to parse Chroma response as JSON', { error, resultText });
    return { ids: [], distances: [], metadatas: [] };
  }

  // Extract unique IDs from document IDs
  const ids: number[] = [];
  const docIds = parsed.ids?.[0] || [];
  for (const docId of docIds) {
    // Extract sqlite_id from document ID (supports three formats):
    // - obs_{id}_narrative, obs_{id}_fact_0, etc (observations)
    // - summary_{id}_request, summary_{id}_learned, etc (session summaries)
    // - prompt_{id} (user prompts)
    const obsMatch = docId.match(/obs_(\d+)_/);
    const summaryMatch = docId.match(/summary_(\d+)_/);
    const promptMatch = docId.match(/prompt_(\d+)/);

    let sqliteId: number | null = null;
    if (obsMatch) {
      sqliteId = parseInt(obsMatch[1], 10);
    } else if (summaryMatch) {
      sqliteId = parseInt(summaryMatch[1], 10);
    } else if (promptMatch) {
      sqliteId = parseInt(promptMatch[1], 10);
    }

    if (sqliteId !== null && !ids.includes(sqliteId)) {
      ids.push(sqliteId);
    }
  }

  const distances = parsed.distances?.[0] || [];
  const metadatas = parsed.metadatas?.[0] || [];

  return { ids, distances, metadatas };
}
