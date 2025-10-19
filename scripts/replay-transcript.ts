#!/usr/bin/env node
/**
 * Transcript Replay Tool
 *
 * Plays back a Claude Code transcript through the memory system to test:
 * 1. Tool observation capture
 * 2. SDK worker processing
 * 3. SQLite storage
 * 4. Session summary generation
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import * as net from 'net';
import { HooksDatabase } from '../src/services/sqlite/HooksDatabase';
import { getWorkerSocketPath } from '../src/shared/paths';
import { spawn } from 'child_process';

interface TranscriptLine {
  type: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      name?: string;
      input?: any;
      output?: string;
      id?: string;
    }>;
  };
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
}

interface ToolUse {
  id: string;
  name: string;
  input: any;
  output?: string;
  timestamp: string;
}

/**
 * Parse transcript JSONL file and extract tool uses with their results
 */
function parseTranscript(filePath: string): ToolUse[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  const toolUses: Map<string, ToolUse> = new Map();

  for (const line of lines) {
    try {
      const event: TranscriptLine = JSON.parse(line);

      // Capture tool_use from assistant messages
      if (event.type === 'assistant' && event.message?.content) {
        for (const item of event.message.content) {
          if (item.type === 'tool_use' && item.name && item.id) {
            toolUses.set(item.id, {
              id: item.id,
              name: item.name,
              input: item.input,
              timestamp: event.timestamp || new Date().toISOString(),
            });
          }
        }
      }

      // Capture tool_result from user messages
      // Tool results come in user messages with tool_use_id
      if (event.type === 'user' && event.message?.content) {
        const content = event.message.content;

        // Content can be array or single object
        const items = Array.isArray(content) ? content : [content];

        for (const item of items) {
          if (item && typeof item === 'object' && 'type' in item && item.type === 'tool_result') {
            const toolUseId = (item as any).tool_use_id;
            const toolContent = (item as any).content;

            if (toolUseId) {
              const toolUse = toolUses.get(toolUseId);
              if (toolUse) {
                toolUse.output = toolContent || '';
              }
            }
          }
        }
      }
    } catch (err) {
      // Skip invalid lines
      continue;
    }
  }

  return Array.from(toolUses.values()).filter(t => t.output !== undefined);
}

/**
 * Send observation to SDK worker via Unix socket
 */
async function sendObservation(
  socketPath: string,
  toolName: string,
  toolInput: any,
  toolOutput: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      const message = JSON.stringify({
        type: 'observation',
        tool_name: toolName,
        tool_input: toolInput,
        tool_output: toolOutput,
      });

      client.write(message + '\n');
      client.end();
      resolve();
    });

    client.on('error', reject);
    client.setTimeout(5000);
    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Socket timeout'));
    });
  });
}

/**
 * Send finalize message to SDK worker
 */
async function sendFinalize(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      const message = JSON.stringify({ type: 'finalize' });
      client.write(message + '\n');
      client.end();
      resolve();
    });

    client.on('error', reject);
    client.setTimeout(5000);
    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Socket timeout'));
    });
  });
}

/**
 * Main replay function
 */
async function replayTranscript(transcriptPath: string, projectName: string = 'claude-mem-test') {
  console.log('🎬 Starting transcript replay...\n');

  // Parse transcript
  console.log(`📖 Parsing transcript: ${transcriptPath}`);
  const toolUses = parseTranscript(transcriptPath);
  console.log(`   Found ${toolUses.length} tool uses\n`);

  // Initialize database
  const hooksDb = new HooksDatabase();

  // Create SDK session
  console.log('🔧 Creating SDK session...');
  const claudeSessionId = `replay-${Date.now()}`;
  const userPrompt = 'Replaying transcript for testing';

  const sessionId = await hooksDb.createSDKSession(
    claudeSessionId,
    projectName,
    userPrompt
  );
  console.log(`   Session ID: ${sessionId}`);

  // Verify session was created
  const verifyQuery = (hooksDb as any).db.query(`
    SELECT id, claude_session_id, project FROM sdk_sessions WHERE id = ?
  `);
  const session = verifyQuery.get(sessionId);

  if (!session) {
    console.error('   ❌ Session not found in database after creation!');
    process.exit(1);
  }

  console.log(`   ✅ Session verified in database\n`);

  // Spawn SDK worker
  console.log('🚀 Spawning SDK worker...');
  const socketPath = getWorkerSocketPath(sessionId);

  // Spawn worker exactly as production hooks do
  const workerPath = join(process.cwd(), 'scripts/hooks/worker.js');
  const worker = spawn('node', [workerPath, String(sessionId)], {
    detached: false, // Keep attached to see errors
    stdio: ['ignore', 'pipe', 'pipe'] // Pipe output to see what's happening
  });

  worker.stdout?.on('data', (data) => {
    console.log(`   [worker stdout] ${data}`);
  });

  worker.stderr?.on('data', (data) => {
    console.error(`   [worker stderr] ${data}`);
  });

  worker.on('exit', (code, signal) => {
    console.error(`   [worker] Exited with code ${code}, signal ${signal}`);
  });

  worker.on('error', (err) => {
    console.error(`\n   [worker] Process error:`, err.message);
  });

  // Wait for socket to be ready
  console.log(`   Waiting for socket: ${socketPath}`);

  // Poll for socket existence
  let socketReady = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      const fs = await import('fs');
      if (fs.existsSync(socketPath)) {
        socketReady = true;
        console.log(`   ✅ Socket ready after ${(i + 1) * 500}ms`);
        break;
      }
    } catch (err) {
      // Continue waiting
    }
  }

  if (!socketReady) {
    console.log(`   ⚠️  Socket not found after 15s, attempting to connect anyway...`);
  }

  // Additional wait for worker to be fully initialized
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Send observations
  console.log(`\n📤 Sending ${toolUses.length} observations...`);
  let sent = 0;
  let failed = 0;

  for (const toolUse of toolUses) {
    try {
      await sendObservation(
        socketPath,
        toolUse.name,
        toolUse.input,
        toolUse.output || ''
      );
      sent++;
      process.stdout.write(`\r   Sent: ${sent}/${toolUses.length}`);

      // Small delay between observations
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (err) {
      failed++;
      console.error(`\n   ❌ Failed to send observation: ${err.message}`);
    }
  }

  console.log(`\n   ✅ Successfully sent ${sent} observations`);
  if (failed > 0) {
    console.log(`   ⚠️  Failed to send ${failed} observations`);
  }

  // Wait for processing
  console.log('\n⏳ Waiting for SDK to process observations...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Send finalize
  console.log('\n🏁 Sending finalize message...');
  try {
    await sendFinalize(socketPath);
    console.log('   ✅ Finalize message sent');
  } catch (err) {
    console.error(`   ❌ Failed to send finalize: ${err.message}`);
  }

  // Wait for summary generation
  console.log('\n⏳ Waiting for summary generation...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // Verify results
  console.log('\n🔍 Verifying results...\n');

  // Check observations using direct DB query
  const observations = (hooksDb as any).db.query(`
    SELECT sdk_session_id, project, text, type, created_at
    FROM observations
    WHERE sdk_session_id = (
      SELECT sdk_session_id FROM sdk_sessions WHERE id = ?
    )
    ORDER BY created_at_epoch ASC
  `).all(sessionId);

  console.log(`   📝 Observations stored: ${observations.length}`);

  if (observations.length > 0) {
    console.log('   Sample observations:');
    observations.slice(0, 3).forEach((obs: any, i: number) => {
      console.log(`      ${i + 1}. [${obs.type}] ${obs.text.substring(0, 60)}...`);
    });
  }

  // Check summary using direct DB query
  const summary = (hooksDb as any).db.query(`
    SELECT request, investigated, learned, completed, next_steps,
           files_read, files_edited, notes, created_at
    FROM session_summaries
    WHERE sdk_session_id = (
      SELECT sdk_session_id FROM sdk_sessions WHERE id = ?
    )
    LIMIT 1
  `).get(sessionId);

  if (summary) {
    console.log(`\n   📋 Summary generated:`);
    console.log(`      Request: ${(summary as any).request?.substring(0, 60)}...`);
    console.log(`      Completed: ${(summary as any).completed?.substring(0, 60)}...`);
    const filesRead = JSON.parse((summary as any).files_read || '[]');
    const filesEdited = JSON.parse((summary as any).files_edited || '[]');
    console.log(`      Files read: ${filesRead.length}`);
    console.log(`      Files edited: ${filesEdited.length}`);
  } else {
    console.log(`\n   ⚠️  No summary generated`);
  }

  // Cleanup (worker is detached and will exit on its own)
  console.log('\n✅ Replay complete!\n');

  return {
    sessionId,
    observationsCount: observations.length,
    hasSummary: !!summary,
  };
}

// CLI interface
const args = process.argv.slice(2);
const transcriptPath = args[0] || join(process.cwd(), 'test-data/sample-transcript.jsonl');
const projectName = args[1] || 'claude-mem-test';

replayTranscript(transcriptPath, projectName)
  .then((result) => {
    console.log('Results:', result);
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Replay failed:', err);
    process.exit(1);
  });
