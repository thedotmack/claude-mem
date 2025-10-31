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
  const store = new SessionStore(dbPath);

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

  // Fetch observations from SQLite
  console.log('📖 Reading observations from SQLite...');
  const observations = store.getAllObservations(project);
  console.log(`Found ${observations.length} observations\n`);

  // Prepare documents for Chroma
  const documents: ChromaDocument[] = observations.map(obs => {
    // Create rich text representation
    const docText = [
      `Title: ${obs.title}`,
      obs.subtitle ? `Subtitle: ${obs.subtitle}` : '',
      obs.narrative ? `Narrative: ${obs.narrative}` : '',
      obs.facts?.length ? `Facts:\n${obs.facts.join('\n')}` : '',
      obs.concepts?.length ? `Concepts: ${obs.concepts.join(', ')}` : '',
      obs.files_read?.length ? `Files Read: ${obs.files_read.join(', ')}` : '',
      obs.files_modified?.length ? `Files Modified: ${obs.files_modified.join(', ')}` : ''
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
        ...(obs.concepts?.length && { concepts: obs.concepts.join(',') }),
        ...(obs.files_read?.length && { files_read: obs.files_read.join(',') }),
        ...(obs.files_modified?.length && { files_modified: obs.files_modified.join(',') })
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
  const sessions = store.getRecentSessions(project, 100); // Get recent 100
  console.log(`Found ${sessions.length} sessions\n`);

  // Prepare session documents
  const sessionDocs: ChromaDocument[] = sessions.map(session => {
    const summaries = store.getSessionSummaries(session.id);
    const summaryText = summaries.map(s => s.text).join('\n\n---\n\n');

    const docText = [
      `Request: ${session.request || 'Unknown'}`,
      summaryText
    ].join('\n\n');

    return {
      id: `session_${session.id}`,
      document: docText,
      metadata: {
        sqlite_id: session.id,
        doc_type: 'session',
        sdk_session_id: session.id,
        project: session.project,
        created_at_epoch: session.created_at_epoch,
        completed: session.completed ? 1 : 0
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
