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

  console.log(`🗑️  Deleting existing collection: ${collectionName}`);

  try {
    await client.callTool({
      name: 'chroma_delete_collection',
      arguments: {
        collection_name: collectionName
      }
    });
    console.log('✅ Collection deleted\n');
  } catch (error) {
    console.log('ℹ️  Collection does not exist (first run)\n');
  }

  console.log(`📚 Creating collection: ${collectionName}`);

  // Create collection via MCP
  const createResult = await client.callTool({
    name: 'chroma_create_collection',
    arguments: {
      collection_name: collectionName,
      embedding_function_name: 'default'
    }
  });

  console.log('✅ Collection created:', createResult.content[0]);
  console.log();

  // Fetch observations from SQLite using raw query
  console.log('📖 Reading observations from SQLite...');
  const observations = store.db.prepare(`
    SELECT * FROM observations WHERE project = ? ORDER BY created_at_epoch DESC
  `).all(project) as any[];
  console.log(`Found ${observations.length} observations\n`);

  // Prepare documents for Chroma - each semantic chunk is its own document
  const documents: ChromaDocument[] = [];

  for (const obs of observations) {
    // Parse JSON fields
    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    const files_read = obs.files_read ? JSON.parse(obs.files_read) : [];
    const files_modified = obs.files_modified ? JSON.parse(obs.files_modified) : [];

    const baseMetadata = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      sdk_session_id: obs.sdk_session_id,
      project: obs.project,
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled',
      ...(obs.subtitle && { subtitle: obs.subtitle }),
      ...(concepts.length && { concepts: concepts.join(',') }),
      ...(files_read.length && { files_read: files_read.join(',') }),
      ...(files_modified.length && { files_modified: files_modified.join(',') })
    };

    // Narrative as separate document
    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    // Text as separate document
    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    // Each fact as separate document
    facts.forEach((fact: string, index: number) => {
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });
  }

  console.log(`Created ${documents.length} observation field documents (narratives, texts, facts)\n`);

  // Sync in batches of 100
  console.log('⬆️  Syncing observation fields to ChromaDB...');
  const batchSize = 100;
  const totalBatches = Math.ceil(documents.length / batchSize);
  const startTime = Date.now();

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const progress = Math.round((batchNumber / totalBatches) * 100);
    const docsProcessed = Math.min(i + batchSize, documents.length);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    process.stdout.write(`  [${batchNumber}/${totalBatches}] ${progress}% - Syncing docs ${i + 1}-${docsProcessed}/${documents.length} (${elapsed}s elapsed)...`);

    await client.callTool({
      name: 'chroma_add_documents',
      arguments: {
        collection_name: collectionName,
        documents: batch.map(d => d.document),
        ids: batch.map(d => d.id),
        metadatas: batch.map(d => d.metadata)
      }
    });

    console.log(' ✓');
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Synced ${documents.length} observation documents in ${totalTime}s\n`);

  // Fetch session summaries
  console.log('📖 Reading session summaries from SQLite...');
  const summaries = store.db.prepare(`
    SELECT * FROM session_summaries WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 100
  `).all(project) as any[];
  console.log(`Found ${summaries.length} session summaries`);

  // Prepare session documents - each field is its own document
  const sessionDocs: ChromaDocument[] = [];

  for (const summary of summaries) {
    const baseMetadata = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      sdk_session_id: summary.sdk_session_id,
      project: summary.project,
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

    // Each field becomes a separate document
    if (summary.request) {
      sessionDocs.push({
        id: `summary_${summary.id}_request`,
        document: summary.request,
        metadata: { ...baseMetadata, field_type: 'request' }
      });
    }

    if (summary.investigated) {
      sessionDocs.push({
        id: `summary_${summary.id}_investigated`,
        document: summary.investigated,
        metadata: { ...baseMetadata, field_type: 'investigated' }
      });
    }

    if (summary.learned) {
      sessionDocs.push({
        id: `summary_${summary.id}_learned`,
        document: summary.learned,
        metadata: { ...baseMetadata, field_type: 'learned' }
      });
    }

    if (summary.completed) {
      sessionDocs.push({
        id: `summary_${summary.id}_completed`,
        document: summary.completed,
        metadata: { ...baseMetadata, field_type: 'completed' }
      });
    }

    if (summary.next_steps) {
      sessionDocs.push({
        id: `summary_${summary.id}_next_steps`,
        document: summary.next_steps,
        metadata: { ...baseMetadata, field_type: 'next_steps' }
      });
    }

    if (summary.notes) {
      sessionDocs.push({
        id: `summary_${summary.id}_notes`,
        document: summary.notes,
        metadata: { ...baseMetadata, field_type: 'notes' }
      });
    }
  }

  console.log(`Created ${sessionDocs.length} session field documents\n`);

  // Sync sessions
  console.log('⬆️  Syncing session fields to ChromaDB...');
  const sessionBatches = Math.ceil(sessionDocs.length / batchSize);
  const sessionStartTime = Date.now();

  for (let i = 0; i < sessionDocs.length; i += batchSize) {
    const batch = sessionDocs.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const progress = Math.round((batchNumber / sessionBatches) * 100);
    const docsProcessed = Math.min(i + batchSize, sessionDocs.length);
    const elapsed = ((Date.now() - sessionStartTime) / 1000).toFixed(1);

    process.stdout.write(`  [${batchNumber}/${sessionBatches}] ${progress}% - Syncing docs ${i + 1}-${docsProcessed}/${sessionDocs.length} (${elapsed}s elapsed)...`);

    await client.callTool({
      name: 'chroma_add_documents',
      arguments: {
        collection_name: collectionName,
        documents: batch.map(d => d.document),
        ids: batch.map(d => d.id),
        metadatas: batch.map(d => d.metadata)
      }
    });

    console.log(' ✓');
  }

  const sessionTotalTime = ((Date.now() - sessionStartTime) / 1000).toFixed(1);
  console.log(`✅ Synced ${sessionDocs.length} session documents in ${sessionTotalTime}s\n`);

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
