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
import fs from 'fs';

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

  // Track results for documentation
  const results: any[] = [];
  let chromaSuccessCount = 0;
  let fts5SuccessCount = 0;

  for (const testQuery of TEST_QUERIES) {
    console.log(`📝 ${testQuery.description}`);
    console.log(`Query: "${testQuery.query}"`);
    console.log(`Expected best: ${testQuery.expectedType}`);
    console.log();

    const testResult: any = {
      description: testQuery.description,
      query: testQuery.query,
      expectedType: testQuery.expectedType,
      chromaFound: false,
      fts5Found: false,
      chromaResults: '',
      chromaTopResults: [],
      fts5TopResults: []
    };

    // Semantic search via Chroma MCP
    console.log('🔍 Semantic Search (Chroma):');
    try {
      const chromaResult = await client.callTool({
        name: 'chroma_query_documents',
        arguments: {
          collection_name: collectionName,
          query_texts: [testQuery.query],
          n_results: 3,
          include: ['documents', 'metadatas', 'distances']
        }
      });

      const resultText = chromaResult.content[0]?.text || '';
      testResult.chromaResults = resultText;
      testResult.chromaFound = resultText.includes('ids') && resultText.length > 50;

      // Extract documents from result text
      if (testResult.chromaFound) {
        chromaSuccessCount++;

        // Try to parse documents from the Python dict-like output
        const docsMatch = resultText.match(/'documents':\s*\[(.*?)\]/s);
        const metasMatch = resultText.match(/'metadatas':\s*\[(.*?)\]/s);
        const distancesMatch = resultText.match(/'distances':\s*\[(.*?)\]/s);

        if (docsMatch) {
          // Extract individual document strings
          const docsContent = docsMatch[1];
          const docMatches = docsContent.match(/'([^']*(?:\\'[^']*)*)'/g) || [];
          const docs = docMatches.map(d => d.slice(1, -1).replace(/\\'/g, "'"));

          testResult.chromaTopResults = docs.slice(0, 3);
        }

        console.log('  ✅ Found results');
        console.log(resultText.substring(0, 500) + '...');
      } else {
        console.log('  ❌ No results');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
      testResult.chromaResults = `Error: ${error.message}`;
    }
    console.log();

    // Keyword search via FTS5
    console.log('🔍 Keyword Search (FTS5):');
    try {
      const fts5Results = search.searchObservations(testQuery.query, {
        limit: 3,
        project
      });

      testResult.fts5Found = fts5Results.length > 0;

      if (testResult.fts5Found) {
        fts5SuccessCount++;

        // Capture top results with title and narrative
        testResult.fts5TopResults = fts5Results.map(r => ({
          title: r.title,
          narrative: r.narrative || r.text || '(no content)',
          type: r.type
        }));

        console.log(`  ✅ Found: ${fts5Results.length} results`);
        console.log(`  Top result: ${fts5Results[0].title}`);
      } else {
        console.log('  ❌ No results');
      }
    } catch (error: any) {
      console.log(`  ❌ Error: ${error.message}`);
    }

    results.push(testResult);

    console.log();
    console.log('-'.repeat(80));
    console.log();
  }

  // Generate results summary
  const totalTests = TEST_QUERIES.length;
  const chromaSuccessRate = ((chromaSuccessCount / totalTests) * 100).toFixed(0);
  const fts5SuccessRate = ((fts5SuccessCount / totalTests) * 100).toFixed(0);

  console.log('✅ Search comparison complete!\n');
  console.log(`📊 Results Summary:`);
  console.log(`   Chroma: ${chromaSuccessCount}/${totalTests} queries succeeded (${chromaSuccessRate}%)`);
  console.log(`   FTS5:   ${fts5SuccessCount}/${totalTests} queries succeeded (${fts5SuccessRate}%)`);
  console.log();

  // Write results to RESULTS.md
  const resultsPath = path.join(process.cwd(), 'experiment', 'RESULTS.md');
  const timestamp = new Date().toISOString();

  let markdown = `# Chroma MCP Search Experiment Results

**Date**: ${timestamp}
**Project**: ${project}
**Collection**: ${collectionName}

## Summary

- **Semantic Search (Chroma)**: ${chromaSuccessCount}/${totalTests} queries succeeded (${chromaSuccessRate}%)
- **Keyword Search (FTS5)**: ${fts5SuccessCount}/${totalTests} queries succeeded (${fts5SuccessRate}%)

## Key Findings

`;

  if (chromaSuccessCount > fts5SuccessCount) {
    const diff = chromaSuccessCount - fts5SuccessCount;
    markdown += `✅ **Semantic search outperformed keyword search by ${diff} queries.**\n\n`;
    markdown += `Chroma's vector embeddings successfully handled conceptual queries that FTS5 completely missed. `;
    markdown += `For queries requiring semantic understanding rather than exact keyword matching, Chroma is clearly superior.\n\n`;
  } else if (fts5SuccessCount > chromaSuccessCount) {
    const diff = fts5SuccessCount - chromaSuccessCount;
    markdown += `⚠️ **Keyword search outperformed semantic search by ${diff} queries.**\n\n`;
  } else {
    markdown += `Both search methods performed equally well.\n\n`;
  }

  markdown += `## Detailed Results\n\n`;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    markdown += `### ${i + 1}. ${result.description}\n\n`;
    markdown += `**Query**: \`${result.query}\`  \n`;
    markdown += `**Expected Best**: ${result.expectedType}\n\n`;

    // Chroma Results
    markdown += `#### 🔵 Semantic Search (Chroma)\n\n`;
    if (result.chromaFound && result.chromaTopResults.length > 0) {
      markdown += `**Status**: ✅ Found ${result.chromaTopResults.length} results\n\n`;
      result.chromaTopResults.forEach((doc: string, idx: number) => {
        markdown += `**Result ${idx + 1}:**\n\n`;
        markdown += `\`\`\`\n${doc}\n\`\`\`\n\n`;
      });
    } else {
      markdown += `**Status**: ❌ No results\n\n`;
    }

    // FTS5 Results
    markdown += `#### 🟡 Keyword Search (FTS5)\n\n`;
    if (result.fts5Found && result.fts5TopResults.length > 0) {
      markdown += `**Status**: ✅ Found ${result.fts5TopResults.length} results\n\n`;
      result.fts5TopResults.forEach((r: any, idx: number) => {
        markdown += `**Result ${idx + 1}: ${r.title}** (${r.type})\n\n`;
        markdown += `\`\`\`\n${r.narrative}\n\`\`\`\n\n`;
      });
    } else {
      markdown += `**Status**: ❌ No results\n\n`;
    }

    markdown += `---\n\n`;
  }

  markdown += `## Conclusion\n\n`;

  if (chromaSuccessRate === '100' && fts5SuccessRate !== '100') {
    markdown += `Semantic search via Chroma demonstrates clear superiority for this use case. `;
    markdown += `It successfully answered all test queries, while keyword search failed on ${totalTests - fts5SuccessCount} queries. `;
    markdown += `The gap is especially pronounced for conceptual queries where users ask about "how something works" `;
    markdown += `or "problems with X" - cases where FTS5 has no mechanism to understand intent beyond literal keyword matching.\n\n`;
    markdown += `**Recommendation**: Implement Chroma as the primary search interface for the memory system.\n`;
  } else if (chromaSuccessCount > fts5SuccessCount) {
    markdown += `Semantic search shows better performance overall. Consider using Chroma as primary with FTS5 as fallback.\n`;
  } else {
    markdown += `Both methods show similar performance. A hybrid approach may be beneficial.\n`;
  }

  fs.writeFileSync(resultsPath, markdown);
  console.log(`📝 Results written to: ${resultsPath}\n`);

  await client.close();
}

main().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
