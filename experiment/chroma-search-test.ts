#!/usr/bin/env node
/**
 * Chroma MCP Search Test
 *
 * Compares semantic search (via Chroma MCP) vs keyword search (SQLite FTS5)
 * to determine if hybrid approach is worthwhile.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';
import path from 'path';
import os from 'os';

interface TestQuery {
  description: string;
  query: string;
  expectedType: 'semantic' | 'keyword' | 'both';
}

const TEST_QUERIES: TestQuery[] = [
  {
    description: 'Semantic - conceptual understanding',
    query: 'how does memory compression work',
    expectedType: 'semantic'
  },
  {
    description: 'Semantic - similar patterns',
    query: 'problems with database synchronization',
    expectedType: 'semantic'
  },
  {
    description: 'Keyword - specific file',
    query: 'SessionStore.ts',
    expectedType: 'keyword'
  },
  {
    description: 'Keyword - exact function name',
    query: 'getAllObservations',
    expectedType: 'keyword'
  },
  {
    description: 'Both - technical concept with specifics',
    query: 'FTS5 full text search implementation',
    expectedType: 'both'
  },
  {
    description: 'Semantic - user intent',
    query: 'similar to context injection issues',
    expectedType: 'semantic'
  },
  {
    description: 'Keyword - specific error',
    query: 'NOT NULL constraint violation',
    expectedType: 'keyword'
  },
  {
    description: 'Semantic - design patterns',
    query: 'patterns for background worker processes',
    expectedType: 'semantic'
  }
];

async function main() {
  console.log('🧪 Chroma MCP Search Comparison Test\n');

  // Initialize MCP client
  console.log('📡 Connecting to Chroma MCP server...');
  const transport = new StdioClientTransport({
    command: 'uvx',
    args: [
      'chroma-mcp',
      '--client-type', 'persistent',
      '--data-dir', path.join(os.homedir(), '.claude-mem', 'vector-db')
    ]
  });

  const client = new Client({
    name: 'chroma-search-test',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  console.log('✅ Connected to Chroma MCP\n');

  // Initialize SessionSearch for FTS5
  const dbPath = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
  const search = new SessionSearch(dbPath);

  const project = 'claude-mem';
  const collectionName = `cm__${project}`;

  console.log('Running comparison tests...\n');
  console.log('='.repeat(80));
  console.log();

  for (const testQuery of TEST_QUERIES) {
    console.log(`📝 ${testQuery.description}`);
    console.log(`Query: "${testQuery.query}"`);
    console.log(`Expected best: ${testQuery.expectedType}`);
    console.log();

    // Semantic search via Chroma MCP
    console.log('🔍 Semantic Search (Chroma):');
    try {
      const chromaResult = await client.callTool({
        name: 'chroma_query_documents',
        arguments: {
          collection_name: collectionName,
          query_texts: [testQuery.query],
          n_results: 5
        }
      });

      const results = chromaResult.content[0];
      console.log(`  Found: ${results.text ? 'results' : 'no results'}`);
      if (results.text) {
        console.log('  Top result preview:', results.text.substring(0, 150) + '...');
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    console.log();

    // Keyword search via FTS5
    console.log('🔍 Keyword Search (FTS5):');
    try {
      const fts5Results = search.searchObservations(testQuery.query, {
        limit: 5,
        project
      });

      console.log(`  Found: ${fts5Results.length} results`);
      if (fts5Results.length > 0) {
        console.log(`  Top result: ${fts5Results[0].title}`);
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }

    console.log();
    console.log('-'.repeat(80));
    console.log();
  }

  console.log('✅ Search comparison complete!\n');
  console.log('Review results and document findings in experiment/RESULTS.md');

  await client.close();
}

main().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
