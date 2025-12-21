#!/usr/bin/env node
/**
 * Export memories matching a search query to a portable JSON format
 * Usage: npx tsx scripts/export-memories.ts <query> <output-file> [--project=name]
 * Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json --project=claude-mem
 */

import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

interface ObservationRecord {
  id: number;
  sdk_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
}

interface SdkSessionRecord {
  id: number;
  claude_session_id: string;
  sdk_session_id: string;
  project: string;
  user_prompt: string;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

interface SessionSummaryRecord {
  id: number;
  sdk_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
}

interface UserPromptRecord {
  id: number;
  claude_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

interface ExportData {
  exportedAt: string;
  exportedAtEpoch: number;
  query: string;
  project?: string;
  totalObservations: number;
  totalSessions: number;
  totalSummaries: number;
  totalPrompts: number;
  observations: ObservationRecord[];
  sessions: SdkSessionRecord[];
  summaries: SessionSummaryRecord[];
  prompts: UserPromptRecord[];
}

async function exportMemories(query: string, outputFile: string, project?: string) {
  try {
    // Read port from settings
    const settings = SettingsDefaultsManager.loadFromFile(join(homedir(), '.claude-mem', 'settings.json'));
    const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
    const baseUrl = `http://localhost:${port}`;

    console.log(`🔍 Searching for: "${query}"${project ? ` (project: ${project})` : ' (all projects)'}`);

    // Build query params - use format=json for raw data
    const params = new URLSearchParams({
      query,
      format: 'json',
      limit: '999999'
    });
    if (project) params.set('project', project);

    // Unified search - gets all result types using hybrid search
    console.log('📡 Fetching all memories via hybrid search...');
    const searchResponse = await fetch(`${baseUrl}/api/search?${params.toString()}`);
    if (!searchResponse.ok) {
      throw new Error(`Failed to search: ${searchResponse.status} ${searchResponse.statusText}`);
    }
    const searchData = await searchResponse.json();

    const observations: ObservationRecord[] = searchData.observations || [];
    const summaries: SessionSummaryRecord[] = searchData.sessions || [];
    const prompts: UserPromptRecord[] = searchData.prompts || [];

    console.log(`✅ Found ${observations.length} observations`);
    console.log(`✅ Found ${summaries.length} session summaries`);
    console.log(`✅ Found ${prompts.length} user prompts`);

    // Get unique SDK session IDs from observations and summaries
    const sdkSessionIds = new Set<string>();
    observations.forEach((o) => {
      if (o.sdk_session_id) sdkSessionIds.add(o.sdk_session_id);
    });
    summaries.forEach((s) => {
      if (s.sdk_session_id) sdkSessionIds.add(s.sdk_session_id);
    });

    // Get SDK sessions metadata via API
    console.log('📡 Fetching SDK sessions metadata...');
    let sessions: SdkSessionRecord[] = [];
    if (sdkSessionIds.size > 0) {
      const sessionsResponse = await fetch(`${baseUrl}/api/sdk-sessions/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdkSessionIds: Array.from(sdkSessionIds) })
      });
      if (sessionsResponse.ok) {
        sessions = await sessionsResponse.json();
      } else {
        console.warn(`⚠️ Failed to fetch SDK sessions: ${sessionsResponse.status}`);
      }
    }
    console.log(`✅ Found ${sessions.length} SDK sessions`);

    // Create export data
    const exportData: ExportData = {
      exportedAt: new Date().toISOString(),
      exportedAtEpoch: Date.now(),
      query,
      project,
      totalObservations: observations.length,
      totalSessions: sessions.length,
      totalSummaries: summaries.length,
      totalPrompts: prompts.length,
      observations,
      sessions,
      summaries,
      prompts
    };

    // Write to file
    writeFileSync(outputFile, JSON.stringify(exportData, null, 2));

    console.log(`\n📦 Export complete!`);
    console.log(`📄 Output: ${outputFile}`);
    console.log(`📊 Stats:`);
    console.log(`   • ${exportData.totalObservations} observations`);
    console.log(`   • ${exportData.totalSessions} sessions`);
    console.log(`   • ${exportData.totalSummaries} summaries`);
    console.log(`   • ${exportData.totalPrompts} prompts`);

  } catch (error) {
    console.error('❌ Export failed:', error);
    process.exit(1);
  }
}

// CLI interface
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: npx tsx scripts/export-memories.ts <query> <output-file> [--project=name]');
  console.error('Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json --project=claude-mem');
  console.error('         npx tsx scripts/export-memories.ts "authentication" auth.json');
  process.exit(1);
}

// Parse arguments
const [query, outputFile, ...flags] = args;
const project = flags.find(f => f.startsWith('--project='))?.split('=')[1];

exportMemories(query, outputFile, project);
