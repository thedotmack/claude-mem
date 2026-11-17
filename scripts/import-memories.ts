#!/usr/bin/env node

import { existsSync } from 'fs';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../src/shared/paths.js';
import { formatHostForUrl } from '../src/shared/worker-url.js';
import { readJsonFileWithBom } from '../src/shared/atomic-json.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../src/shared/worker-http-limits.js';
import { normalizePlatformSource } from '../src/shared/platform-source.js';

const workerSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
// loadFromFile already applies env overrides and normalizes 'localhost' to
// 127.0.0.1 (#2992); a raw process.env read here would bypass both.
const WORKER_HOST = workerSettings.CLAUDE_MEM_WORKER_HOST;
const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || workerSettings.CLAUDE_MEM_WORKER_PORT;
const WORKER_URL = `http://${formatHostForUrl(WORKER_HOST)}:${WORKER_PORT}`;

const IMPORT_KINDS = ['sessions', 'summaries', 'observations', 'prompts'] as const;
type ImportKind = typeof IMPORT_KINDS[number];

async function postImport(body: string) {
  const response = await fetch(`${WORKER_URL}/api/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\n${await response.text()}`);
  }
  return response.json();
}

async function importExportRows(payload: Record<ImportKind, any[]>) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) <= WORKER_JSON_BODY_LIMIT_BYTES) return postImport(body);

  // A file may contain many individually importable rows. Size requests by
  // encoded bytes, without truncating records or raising the worker's limit.
  const envelope = (kind: ImportKind) => `{"${kind}":[`;
  for (const kind of IMPORT_KINDS) {
    payload[kind].forEach((row, index) => {
      if (Buffer.byteLength(envelope(kind) + JSON.stringify(row) + ']}') > WORKER_JSON_BODY_LIMIT_BYTES) {
        throw new Error(`${kind}[${index}] exceeds the worker's ${WORKER_JSON_BODY_LIMIT_BYTES}-byte request limit`);
      }
    });
  }

  const stats: Record<string, number> = {};
  const rejected: Record<string, Array<{ index: number; reason: string }>> = {};
  const memoryIds = new Map<string, string>();
  const contentIds = new Map<string, Array<{ id: number; platformSource: string }>>();
  const remap = (kind: ImportKind, row: any) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    if (kind === 'observations' || kind === 'summaries') {
      const memoryId = memoryIds.get(row.memory_session_id);
      return memoryId === undefined ? row : { ...row, memory_session_id: memoryId };
    }
    if (kind === 'prompts') {
      const contexts = contentIds.get(row.content_session_id) ?? [];
      const platform = typeof row.platform_source === 'string' ? normalizePlatformSource(row.platform_source) : undefined;
      const context = platform ? contexts.findLast(value => value.platformSource === platform)
        : contexts.length === 1 ? contexts[0] : undefined;
      return context ? { ...row, session_db_id: context.id, platform_source: platform ?? context.platformSource } : row;
    }
    return row;
  };

  // Parent identities are resolved by the worker, including an existing
  // local memory id and same-content sessions owned by different platforms.
  // Carry those identities across requests instead of re-importing parents.
  for (const kind of IMPORT_KINDS) {
    let start = 0;
    while (start < payload[kind].length) {
      const rows: string[] = [];
      const prefix = envelope(kind);
      let bytes = Buffer.byteLength(prefix) + 2;
      let end = start;
      while (end < payload[kind].length) {
        const row = JSON.stringify(remap(kind, payload[kind][end]));
        const size = Buffer.byteLength(row) + (rows.length ? 1 : 0);
        if (bytes + size > WORKER_JSON_BODY_LIMIT_BYTES) {
          if (rows.length === 0) throw new Error(`${kind}[${end}] exceeds the worker's request limit after resolving its session`);
          break;
        }
        rows.push(row); bytes += size; end++;
      }
      const result = await postImport(prefix + rows.join(',') + ']}');
      for (const [key, value] of Object.entries(result.stats)) stats[key] = (stats[key] ?? 0) + Number(value);
      for (const [key, entries] of Object.entries(result.rejected ?? {})) {
        (rejected[key] ??= []).push(...(entries as Array<{ index: number; reason: string }>)
          .map(row => ({ ...row, index: row.index + start })));
      }
      if (kind === 'sessions') {
        if (!result.sessionIdentities) throw new Error('Update the worker before importing a file that requires multiple requests; it must return imported session identities.');
        for (const [source, local] of result.sessionIdentities.memorySessionIds) memoryIds.set(source, local);
        for (const [content, contexts] of result.sessionIdentities.contentSessionIds) {
          contentIds.set(content, [...(contentIds.get(content) ?? []), ...contexts]);
        }
      }
      start = end;
    }
  }
  return { stats, rejected };
}

async function importMemories(inputFile: string) {
  if (!existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const exportData = readJsonFileWithBom<any>(inputFile);

  console.log(`📦 Import file: ${inputFile}`);
  console.log(`📅 Exported: ${exportData.exportedAt}`);
  console.log(`🔍 Query: "${exportData.query}"`);
  console.log(`📊 Contains:`);
  console.log(`   • ${exportData.totalObservations} observations`);
  console.log(`   • ${exportData.totalSessions} sessions`);
  console.log(`   • ${exportData.totalSummaries} summaries`);
  console.log(`   • ${exportData.totalPrompts} prompts`);
  console.log('');

  try {
    const healthCheck = await fetch(`${WORKER_URL}/api/stats`);
    if (!healthCheck.ok) {
      throw new Error('Worker not responding');
    }
  } catch (error) {
    console.error(`❌ Worker not running at ${WORKER_URL}`);
    console.error('   Please ensure the claude-mem worker is running.');
    process.exit(1);
  }

  console.log('🔄 Importing via worker API...');

  const result = await importExportRows({
    sessions: exportData.sessions || [],
    summaries: exportData.summaries || [],
    observations: exportData.observations || [],
    prompts: exportData.prompts || [],
  });
  const stats = result.stats;
  const hasRejectedRows = ['sessionsRejected', 'summariesRejected', 'observationsRejected', 'promptsRejected']
    .some(key => (stats[key] ?? 0) > 0);

  console.log('\n✅ Import complete!');
  console.log('📊 Summary:');
  console.log(`   Sessions:     ${stats.sessionsImported} imported, ${stats.sessionsSkipped} skipped, ${stats.sessionsRejected ?? 0} rejected`);
  console.log(`   Summaries:    ${stats.summariesImported} imported, ${stats.summariesSkipped} skipped, ${stats.summariesRejected ?? 0} rejected`);
  console.log(`   Observations: ${stats.observationsImported} imported, ${stats.observationsSkipped} skipped, ${stats.observationsRejected ?? 0} rejected`);
  console.log(`   Prompts:      ${stats.promptsImported} imported, ${stats.promptsSkipped} skipped, ${stats.promptsRejected ?? 0} rejected`);

  // "Skipped" rows were already present. "Rejected" rows were not imported:
  // they failed validation or the database refused them.
  const rejected: Record<string, Array<{ index: number; reason: string }>> = result.rejected ?? {};
  for (const [kind, rows] of Object.entries(rejected)) {
    for (const row of rows.slice(0, 5)) {
      console.log(`   ⚠️  ${kind}[${row.index}] rejected: ${row.reason}`);
    }
    if (rows.length > 5) {
      console.log(`   ⚠️  …and ${rows.length - 5} more ${kind} rejected`);
    }
  }
  if (hasRejectedRows || Object.values(rejected).some(rows => rows.length > 0)) {
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: npx tsx scripts/import-memories.ts <input-file>');
  console.error('Example: npx tsx scripts/import-memories.ts windows-memories.json');
  process.exit(1);
}

const [inputFile] = args;
importMemories(inputFile).catch(error => {
  console.error('❌ Import failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
