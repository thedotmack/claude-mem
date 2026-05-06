#!/usr/bin/env node

import { writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { resolveDataDir } from '../src/shared/paths.js';
import type {
  ObservationRecord,
  SdkSessionRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  ExportData
} from './types/export.js';

const WORKER_FETCH_TIMEOUT_MS = 30_000;

function parseWorkerPort(rawPort: unknown): number {
  if (typeof rawPort !== 'string' || rawPort.trim() === '') {
    throw new Error('Invalid CLAUDE_MEM_WORKER_PORT in settings.json: missing');
  }

  const normalized = rawPort.trim();
  const port = Number.parseInt(normalized, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== normalized) {
    throw new Error(`Invalid CLAUDE_MEM_WORKER_PORT in settings.json: ${rawPort}`);
  }
  return port;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKER_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Worker request timed out after ${WORKER_FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function exportMemories(query: string, outputFile: string, project?: string) {
  const settings = SettingsDefaultsManager.loadFromFile(join(resolveDataDir(), 'settings.json'));
  const port = parseWorkerPort(settings.CLAUDE_MEM_WORKER_PORT);
  const baseUrl = `http://localhost:${port}`;

  console.log(`🔍 Searching for: "${query}"${project ? ` (project: ${project})` : ' (all projects)'}`);

  const params = new URLSearchParams({
    query,
    format: 'json',
    limit: '999999'
  });
  if (project) params.set('project', project);

  console.log('📡 Fetching all memories via hybrid search...');
  const searchResponse = await fetchWithTimeout(`${baseUrl}/api/search?${params.toString()}`);
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

  const memorySessionIds = new Set<string>();
  observations.forEach((o) => {
    if (o.memory_session_id) memorySessionIds.add(o.memory_session_id);
  });
  summaries.forEach((s) => {
    if (s.memory_session_id) memorySessionIds.add(s.memory_session_id);
  });

  console.log('📡 Fetching SDK sessions metadata...');
  let sessions: SdkSessionRecord[] = [];
  if (memorySessionIds.size > 0) {
    const sessionsResponse = await fetchWithTimeout(`${baseUrl}/api/sdk-sessions/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memorySessionIds: Array.from(memorySessionIds) })
    });
    if (sessionsResponse.ok) {
      sessions = await sessionsResponse.json();
    } else {
      const body = await sessionsResponse.text();
      throw new Error(`Failed to fetch SDK sessions: ${sessionsResponse.status} ${sessionsResponse.statusText} ${body}`.trim());
    }
  }
  console.log(`✅ Found ${sessions.length} SDK sessions`);

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

  writeFileSync(outputFile, JSON.stringify(exportData, null, 2));

  console.log(`\n📦 Export complete!`);
  console.log(`📄 Output: ${outputFile}`);
  console.log(`📊 Stats:`);
  console.log(`   • ${exportData.totalObservations} observations`);
  console.log(`   • ${exportData.totalSessions} sessions`);
  console.log(`   • ${exportData.totalSummaries} summaries`);
  console.log(`   • ${exportData.totalPrompts} prompts`);
}

function isDirectRun(): boolean {
  if (process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN === '1') {
    return false;
  }
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/export-memories.ts <query> <output-file> [--project=name]');
    console.error('Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json --project=claude-mem');
    console.error('         npx tsx scripts/export-memories.ts "authentication" auth.json');
    process.exit(1);
  }

  const [query, outputFile, ...flags] = args;
  const project = flags.find(f => f.startsWith('--project='))?.split('=')[1];

  exportMemories(query, outputFile, project).catch((error) => {
    console.error('❌ Export failed:', error);
    process.exit(1);
  });
}
