#!/usr/bin/env node

import { writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { resolveDataDir } from '../src/shared/paths.js';

const WORKER_FETCH_TIMEOUT_MS = 30_000;

export interface ExportMemoriesOptions {
  allowPartial?: boolean;
}

type ExportObservationRecord = Record<string, unknown> & {
  memory_session_id?: string | null;
};

type ExportSdkSessionRecord = Record<string, unknown> & {
  memory_session_id?: string | null;
};

type ExportSessionSummaryRecord = Record<string, unknown> & {
  memory_session_id?: string | null;
};

type ExportUserPromptRecord = Record<string, unknown>;

interface ExportWarning {
  code: 'SDK_SESSIONS_METADATA_UNAVAILABLE';
  message: string;
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
  observations: ExportObservationRecord[];
  sessions: ExportSdkSessionRecord[];
  summaries: ExportSessionSummaryRecord[];
  prompts: ExportUserPromptRecord[];
  metadata?: {
    partial: true;
    importable: false;
    warnings: ExportWarning[];
  };
}

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

function buildSdkSessionsError(response: Response, body: string): Error {
  return new Error(`Failed to fetch SDK sessions: ${response.status} ${response.statusText} ${body}`.trim());
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

export async function exportMemories(
  query: string,
  outputFile: string,
  project?: string,
  options: ExportMemoriesOptions = {},
) {
  if (project !== undefined && typeof project !== 'string') {
    throw new TypeError('exportMemories project must be a string when provided');
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('exportMemories options must be an object');
  }

  const allowPartial = options.allowPartial === true;
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

  const observations: ExportObservationRecord[] = searchData.observations || [];
  const summaries: ExportSessionSummaryRecord[] = searchData.sessions || [];
  const prompts: ExportUserPromptRecord[] = searchData.prompts || [];

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
  let sessions: ExportSdkSessionRecord[] = [];
  let warnings: ExportWarning[] | undefined;
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
      const error = buildSdkSessionsError(sessionsResponse, body);
      if (!allowPartial) {
        throw error;
      }

      warnings = [{
        code: 'SDK_SESSIONS_METADATA_UNAVAILABLE',
        message: error.message,
      }];
      sessions = [];
      console.warn('⚠️ SDK session metadata unavailable; writing partial export because --allow-partial was set.');
      console.warn(`⚠️ ${error.message}`);
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

  if (warnings) {
    exportData.metadata = {
      partial: true,
      importable: false,
      warnings,
    };
  }

  writeFileSync(outputFile, JSON.stringify(exportData, null, 2));

  console.log(`\n📦 Export complete!`);
  console.log(`📄 Output: ${outputFile}`);
  console.log(`📊 Stats:`);
  console.log(`   • ${exportData.totalObservations} observations`);
  console.log(`   • ${exportData.totalSessions} sessions`);
  console.log(`   • ${exportData.totalSummaries} summaries`);
  console.log(`   • ${exportData.totalPrompts} prompts`);
  if (exportData.metadata?.partial) {
    console.warn('⚠️ Partial export: SDK session metadata was omitted.');
  }
}

export function parseExportMemoriesCliArgs(args: string[]): {
  query: string;
  outputFile: string;
  project?: string;
  options: ExportMemoriesOptions;
} {
  const positionals: string[] = [];
  let project: string | undefined;
  let allowPartial = false;
  let sawFlag = false;

  for (const arg of args) {
    if (arg.startsWith('--')) {
      sawFlag = true;

      if (positionals.length < 2) {
        throw new Error(`Flag "${arg}" must appear after <query> and <output-file>`);
      }

      if (arg === '--allow-partial') {
        allowPartial = true;
        continue;
      }

      if (arg.startsWith('--project=')) {
        const value = arg.slice('--project='.length);
        if (!value) {
          throw new Error('--project requires a non-empty value');
        }
        project = value;
        continue;
      }

      throw new Error(`Unknown option: ${arg}`);
    }

    if (sawFlag) {
      throw new Error(`Unexpected positional argument after options: ${arg}`);
    }

    positionals.push(arg);
  }

  if (positionals.length !== 2) {
    throw new Error('Usage: npx tsx scripts/export-memories.ts <query> <output-file> [--project=name] [--allow-partial]');
  }

  const [query, outputFile] = positionals;
  const options: ExportMemoriesOptions = {
    allowPartial,
  };

  return { query, outputFile, project, options };
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
    console.error('Usage: npx tsx scripts/export-memories.ts <query> <output-file> [--project=name] [--allow-partial]');
    console.error('Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json --project=claude-mem');
    console.error('         npx tsx scripts/export-memories.ts "authentication" auth.json');
    process.exit(1);
  }

  let parsed: ReturnType<typeof parseExportMemoriesCliArgs>;
  try {
    parsed = parseExportMemoriesCliArgs(args);
  } catch (error) {
    console.error('❌ Invalid arguments:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const { query, outputFile, project, options } = parsed;

  exportMemories(query, outputFile, project, options).catch((error) => {
    console.error('❌ Export failed:', error);
    process.exit(1);
  });
}
