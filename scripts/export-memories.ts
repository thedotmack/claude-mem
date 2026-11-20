#!/usr/bin/env node

import { fstatSync, lstatSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { resolveDataDir } from '../src/shared/paths.js';
import { writeJsonFileAtomic } from '../src/shared/atomic-json.js';
import { formatHostForUrl } from '../src/shared/worker-url.js';
import type {
  ObservationRecord,
  SdkSessionRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  ExportData
} from './types/export.js';

const WORKER_FETCH_TIMEOUT_MS = 30_000;

function standardStreamDescriptor(outputFile: string): number | undefined {
  let current = resolve(outputFile);
  for (;;) {
    // Resolve directory aliases without following the final descriptor link
    // into a redirected regular file. A normal path to that file still needs
    // atomic replacement, even when stdout happens to have it open.
    current = join(realpathSync(dirname(current)), basename(current));
    if (current === '/dev/stdout') return process.stdout.fd;
    if (current === '/dev/stderr') return process.stderr.fd;
    const descriptor = current.match(new RegExp(`^(?:/dev/fd|/proc/${process.pid}(?:/task/[0-9]+)?/fd)/([12])$`));
    if (descriptor) return Number(descriptor[1]);
    if (!lstatSync(current).isSymbolicLink()) return undefined;
    current = resolve(dirname(current), readlinkSync(current));
  }
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

async function withWorkerResponse<T>(url: string, read: (response: Response) => Promise<T>, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKER_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await read(response);
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
  let streamTarget = false;
  let stdioTarget: number | undefined;
  try {
    const target = statSync(outputFile);
    streamTarget = target.isCharacterDevice() || target.isFIFO();
    // An explicit stdio alias names this process's own descriptor, so use it as named.
    // Its inode cannot confirm it: macOS devfs reports other dev/inode numbers for
    // /dev/fd/N than fstat does for the same socket or pipe.
    stdioTarget = standardStreamDescriptor(outputFile);
    // Any other stream (a named FIFO) may still be the one stdout or stderr has open.
    if (stdioTarget === undefined && streamTarget) {
      for (const fd of [process.stdout.fd, process.stderr.fd]) {
        const stream = fstatSync(fd);
        if (target.dev === stream.dev && target.ino === stream.ino) {
          stdioTarget = fd;
          break;
        }
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  // Match the open stream, including aliases such as /dev/fd/1 and symlinks.
  // Progress on that stream would make an otherwise successful JSON export unusable.
  const progress = stdioTarget === process.stdout.fd ? console.error : console.log;

  const settings = SettingsDefaultsManager.loadFromFile(join(resolveDataDir(), 'settings.json'), true, {
    warn: stdioTarget === process.stderr.fd ? progress : undefined,
  });
  const port = parseWorkerPort(settings.CLAUDE_MEM_WORKER_PORT);
  const baseUrl = `http://${formatHostForUrl(settings.CLAUDE_MEM_WORKER_HOST)}:${port}`;

  progress(`🔍 Searching for: "${query}"${project ? ` (project: ${project})` : ' (all projects)'}`);

  const params = new URLSearchParams({
    query,
    format: 'json',
    limit: '999999',
    // Exports include saved history, independent of interactive search recency.
    // The explicit range also permits the documented empty-query full export.
    dateStart: '1970-01-01T00:00:00.000Z'
  });
  if (project) params.set('project', project);

  progress('📡 Fetching all memories via hybrid search...');
  const searchData = await withWorkerResponse(`${baseUrl}/api/search?${params.toString()}`, async response => {
    if (!response.ok) throw new Error(`Failed to search: ${response.status} ${response.statusText}`);
    return response.json();
  });

  const observations: ObservationRecord[] = searchData.observations || [];
  const summaries: SessionSummaryRecord[] = searchData.sessions || [];
  const prompts: Array<UserPromptRecord & { id?: number; memory_session_id?: string | null }> = searchData.prompts || [];

  progress(`✅ Found ${observations.length} observations`);
  progress(`✅ Found ${summaries.length} session summaries`);
  progress(`✅ Found ${prompts.length} user prompts`);

  const memorySessionIds = new Set<string>();
  observations.forEach((o) => {
    if (o.memory_session_id) memorySessionIds.add(o.memory_session_id);
  });
  summaries.forEach((s) => {
    if (s.memory_session_id) memorySessionIds.add(s.memory_session_id);
  });
  // Prompt search rows carry their joined SDK session's memory identity too.
  // A prompt-only export still needs that parent for project/platform ownership.
  prompts.forEach((p) => {
    if (p.memory_session_id) memorySessionIds.add(p.memory_session_id);
  });

  // Prompt IDs resolve their actual foreign-key parents even before the SDK
  // has registered a memory ID; never infer ownership from content ID alone.
  const promptIds = prompts.map(p => p.id).filter((id): id is number =>
    typeof id === 'number' && Number.isSafeInteger(id) && id > 0);

  progress('📡 Fetching SDK sessions metadata...');
  let sessions: SdkSessionRecord[] = [];
  if (memorySessionIds.size > 0 || promptIds.length > 0) {
    sessions = await withWorkerResponse(`${baseUrl}/api/sdk-sessions/batch`, async response => {
      if (response.ok) return response.json();
      const body = await response.text();
      throw new Error(`Failed to fetch SDK sessions: ${response.status} ${response.statusText} ${body}`.trim());
    }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memorySessionIds: Array.from(memorySessionIds), ...(promptIds.length > 0 ? { promptIds } : {}) })
    });
  }
  progress(`✅ Found ${sessions.length} SDK sessions`);

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

  // Write stdio through its open descriptor: Bun can back it with a socket,
  // whose pseudo-path is not a replaceable file. Other devices and pipes keep
  // direct writes; regular file destinations retain atomic replacement.
  if (stdioTarget !== undefined) writeFileSync(stdioTarget, JSON.stringify(exportData, null, 2));
  else if (streamTarget) writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
  else writeJsonFileAtomic(outputFile, exportData);

  progress(`\n📦 Export complete!`);
  progress(`📄 Output: ${outputFile}`);
  progress(`📊 Stats:`);
  progress(`   • ${exportData.totalObservations} observations`);
  progress(`   • ${exportData.totalSessions} sessions`);
  progress(`   • ${exportData.totalSummaries} summaries`);
  progress(`   • ${exportData.totalPrompts} prompts`);
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
  const project = flags.find(f => f.startsWith('--project='))?.slice('--project='.length);

  exportMemories(query, outputFile, project).catch((error) => {
    console.error('❌ Export failed:', error);
    process.exit(1);
  });
}
