#!/usr/bin/env node
/**
 * Chroma MCP Sync Experiment
 *
 * This script tests syncing SQLite observations/summaries to ChromaDB
 * via the existing Chroma MCP server (uvx chroma-mcp).
 *
 * NO PRODUCTION CODE CHANGES - Pure experiment.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import path from 'path';
import os from 'os';

interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

async function main() {
  console.log('🧪 Chroma MCP Sync Experiment\n');

  // Initialize MCP client to Chroma server
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
    name: 'chroma-sync-experiment',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  console.log('✅ Connected to Chroma MCP\n');

  // List available tools
  const { tools } = await client.listTools();
  console.log('🔧 Available MCP tools:');
  tools.forEach(tool => console.log(`  - ${tool.name}`));
  console.log();

  // Initialize SessionStore to read SQLite data
  const dbPath = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
  const store = new SessionStore();

  // Get project name (for collection naming)
  const project = 'claude-mem';
  const collectionName = `cm__${project}`;

  console.log(`📚 Creating/getting collection: ${collectionName}`);

  // Create or get collection via MCP
  const createResult = await client.callTool({
    name: 'chroma_create_collection',
    arguments: {
      collection_name: collectionName,
      embedding_function_name: 'default'
    }
  });

  console.log('✅ Collection ready:', createResult.content[0]);
  console.log();

  // Fetch observations from SQLite using raw query
  console.log('📖 Reading observations from SQLite...');
  const observations = store.db.prepare(`
    SELECT * FROM observations WHERE project = ? ORDER BY created_at_epoch DESC
  `).all(project) as any[];
  console.log(`Found ${observations.length} observations\n`);

  // Prepare documents for Chroma
  const documents: ChromaDocument[] = observations.map(obs => {
    // Parse JSON fields
    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    const files_read = obs.files_read ? JSON.parse(obs.files_read) : [];
    const files_modified = obs.files_modified ? JSON.parse(obs.files_modified) : [];

    // Create rich text representation
    const docText = [
      `Title: ${obs.title || 'Untitled'}`,
      obs.subtitle ? `Subtitle: ${obs.subtitle}` : '',
      obs.narrative ? `Narrative: ${obs.narrative}` : '',
      obs.text ? `Text: ${obs.text}` : '',
      facts.length ? `Facts:\n${facts.join('\n')}` : '',
      concepts.length ? `Concepts: ${concepts.join(', ')}` : '',
      files_read.length ? `Files Read: ${files_read.join(', ')}` : '',
      files_modified.length ? `Files Modified: ${files_modified.join(', ')}` : ''
    ].filter(Boolean).join('\n\n');

    return {
      id: `obs_${obs.id}`,
      document: docText,
      metadata: {
        sqlite_id: obs.id,
        doc_type: 'observation',
        sdk_session_id: obs.sdk_session_id,
        project: obs.project,
        created_at_epoch: obs.created_at_epoch,
        type: obs.type || 'discovery',
        ...(concepts.length && { concepts: concepts.join(',') }),
        ...(files_read.length && { files_read: files_read.join(',') }),
        ...(files_modified.length && { files_modified: files_modified.join(',') })
      }
    };
  });

  // Sync in batches of 100
  console.log('⬆️  Syncing observations to ChromaDB...');
  const batchSize = 100;

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);

    await client.callTool({
      name: 'chroma_add_documents',
      arguments: {
        collection_name: collectionName,
        documents: batch.map(d => d.document),
        ids: batch.map(d => d.id),
        metadatas: batch.map(d => d.metadata)
      }
    });

    console.log(`  ✓ Synced batch ${Math.floor(i / batchSize) + 1} (${batch.length} docs)`);
  }

  console.log();

  // Fetch session summaries
  console.log('📖 Reading session summaries from SQLite...');
  const summaries = store.db.prepare(`
    SELECT * FROM session_summaries WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 100
  `).all(project) as any[];
  console.log(`Found ${summaries.length} session summaries\n`);

  // Prepare session documents
  const sessionDocs: ChromaDocument[] = summaries.map(summary => {
    const docText = [
      `Request: ${summary.request || 'Unknown'}`,
      summary.investigated ? `Investigated: ${summary.investigated}` : '',
      summary.learned ? `Learned: ${summary.learned}` : '',
      summary.completed ? `Completed: ${summary.completed}` : '',
      summary.next_steps ? `Next Steps: ${summary.next_steps}` : '',
      summary.notes ? `Notes: ${summary.notes}` : ''
    ].filter(Boolean).join('\n\n');

    return {
      id: `summary_${summary.id}`,
      document: docText,
      metadata: {
        sqlite_id: summary.id,
        doc_type: 'session_summary',
        sdk_session_id: summary.sdk_session_id,
        project: summary.project,
        created_at_epoch: summary.created_at_epoch,
        prompt_number: summary.prompt_number || 0
      }
    };
  });

  // Sync sessions
  console.log('⬆️  Syncing sessions to ChromaDB...');

  for (let i = 0; i < sessionDocs.length; i += batchSize) {
    const batch = sessionDocs.slice(i, i + batchSize);

    await client.callTool({
      name: 'chroma_add_documents',
      arguments: {
        collection_name: collectionName,
        documents: batch.map(d => d.document),
        ids: batch.map(d => d.id),
        metadatas: batch.map(d => d.metadata)
      }
    });

    console.log(`  ✓ Synced batch ${Math.floor(i / batchSize) + 1} (${batch.length} docs)`);
  }

  console.log();

  // Get collection info
  const infoResult = await client.callTool({
    name: 'chroma_get_collection_info',
    arguments: {
      collection_name: collectionName
    }
  });

  console.log('📊 Collection Info:');
  console.log(infoResult.content[0]);
  console.log();

  // Get count
  const countResult = await client.callTool({
    name: 'chroma_get_collection_count',
    arguments: {
      collection_name: collectionName
    }
  });

  console.log('📊 Total Documents:', countResult.content[0]);
  console.log();

  console.log('✅ Sync experiment complete!\n');
  console.log('Next: Run chroma-search-test.ts to test semantic search');

  await client.close();
}

main().catch(error => {
  console.error('❌ Experiment failed:', error);
  process.exit(1);
});
