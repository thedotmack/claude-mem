#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// End-to-end encrypted sync with a self-hosted hub (workers/sync-hub,
// wrangler.self-host.jsonc). Run on every device:
//
//   bun scripts/sync-e2e.ts init                 first device: create the key
//   bun scripts/sync-e2e.ts export               print the key to copy to another device
//   bun scripts/sync-e2e.ts import               other devices: paste the key (read from stdin)
//   bun scripts/sync-e2e.ts configure --env-file ~/.cloudflare/cmem-sync.env
//                                                point settings.json at the hub, E2E on
//   bun scripts/sync-e2e.ts backfill [--limit N] queue pre-sync history for upload
//   bun scripts/sync-e2e.ts status               key, settings and queue counts
//   bun scripts/sync-e2e.ts verify [--env-file F] [--wrong-key]
//                                                pull the hub into a throwaway DB and check it decrypts;
//                                                without --env-file it reads CLAUDE_MEM_CLOUD_SYNC_{HUB_URL,
//                                                TOKEN,USER_ID,E2E_KEY} from the environment if set
//
// The key lives in <data dir>/sync-e2e.key (0600). Losing every copy makes the
// hub's data unreadable; `export` output is the backup.

import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import { parseArgs } from 'util';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../src/shared/atomic-json.js';
import { resolveDataDir } from '../src/shared/paths.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { configureSyncE2E } from '../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../src/services/sync/SyncApply.js';
import { SyncClient } from '../src/services/sync/SyncClient.js';
import {
  decodeE2EKey,
  E2ECodec,
  e2eKeyPath,
  encodeE2EKey,
  generateE2EKey,
  readE2EKey,
  writeE2EKey,
} from '../src/services/sync/E2ECodec.js';

const TABLES = [
  { table: 'observations', kind: 'observation' },
  { table: 'session_summaries', kind: 'summary' },
  { table: 'user_prompts', kind: 'prompt' },
] as const;

class UsageError extends Error {}

function settingsPath(): string {
  return join(resolveDataDir(), 'settings.json');
}

function dbPath(): string {
  return join(resolveDataDir(), 'claude-mem.db');
}

function requireKey(): E2ECodec {
  const key = readE2EKey();
  if (!key) throw new UsageError(`no key at ${e2eKeyPath()}: run "init" (first device) or "import"`);
  return new E2ECodec(key);
}

function init(): void {
  if (existsSync(e2eKeyPath())) throw new UsageError(`${e2eKeyPath()} already exists`);
  writeE2EKey(generateE2EKey());
  console.log(`Created ${e2eKeyPath()} (key id ${requireKey().keyId}).`);
  console.log('Back it up now: "export" prints it; every other device needs it ("import").');
}

function exportKey(): void {
  const key = readE2EKey();
  if (!key) throw new UsageError(`no key at ${e2eKeyPath()}`);
  console.log(encodeE2EKey(key));
}

async function importKey(): Promise<void> {
  if (existsSync(e2eKeyPath())) throw new UsageError(`${e2eKeyPath()} already exists`);
  const text = (await Bun.stdin.text()).trim();
  writeE2EKey(decodeE2EKey(text));
  console.log(`Imported key ${requireKey().keyId} to ${e2eKeyPath()}.`);
}

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith('#')) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function configure(envFile: string | undefined): void {
  if (!envFile) throw new UsageError('configure needs --env-file (written by workers/sync-hub/scripts/self-host-setup.mjs)');
  const codec = requireKey();
  const env = readEnvFile(envFile);
  for (const name of ['CLAUDE_MEM_CLOUD_SYNC_HUB_URL', 'CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID']) {
    if (!env[name]) throw new UsageError(`${envFile} has no ${name}`);
  }
  const path = settingsPath();
  const settings = existsSync(path) ? readJsonFileWithBom<Record<string, unknown>>(path) : {};
  if (existsSync(path)) copyFileSync(path, `${path}.bak-sync-e2e`);
  writeJsonFileAtomic(path, {
    ...settings,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: env.CLAUDE_MEM_CLOUD_SYNC_HUB_URL,
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: env.CLAUDE_MEM_CLOUD_SYNC_TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: env.CLAUDE_MEM_CLOUD_SYNC_USER_ID,
    CLAUDE_MEM_CLOUD_SYNC_E2E: 'true',
    ...(settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME ? {} : { CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: hostname().slice(0, 80) }),
  });
  console.log(`Sync configured in ${path} (backup: ${path}.bak-sync-e2e), key ${codec.keyId}.`);
  console.log('Restart the worker to start syncing: npm run worker:restart');
}

/**
 * Re-queue the pre-sync baseline (rows migration v47 stamped as synced and
 * recorded in sync_launch_exclusions), newest first, at most `limit` rows.
 * Removing the exclusion keeps an epoch rebuild from skipping them again.
 */
function backfill(limit: number): void {
  const db = new Database(dbPath());
  try {
    db.run('PRAGMA busy_timeout = 10000');
    const candidates = db.query<{ kind: string; id: number; created_at_epoch: number }, []>(
      TABLES.map(({ table, kind }) => `
        SELECT '${kind}' AS kind, t.id, t.created_at_epoch FROM ${table} AS t
        JOIN sync_launch_exclusions AS launch
          ON launch.kind = '${kind}' AND launch.origin_local_id = CAST(t.id AS TEXT)
        WHERE t.origin_device_id IS NULL AND t.synced_at > 0`).join(' UNION ALL ')
      + ' ORDER BY created_at_epoch DESC',
    ).all();
    const batch = candidates.slice(0, limit);
    const tx = db.transaction(() => {
      for (const { table, kind } of TABLES) {
        const requeue = db.prepare(`UPDATE ${table} SET synced_at = NULL WHERE id = ? AND origin_device_id IS NULL`);
        const unexclude = db.prepare('DELETE FROM sync_launch_exclusions WHERE kind = ? AND origin_local_id = ?');
        for (const row of batch.filter(r => r.kind === kind)) {
          requeue.run(row.id);
          unexclude.run(kind, String(row.id));
        }
      }
    });
    tx();
    console.log(`Queued ${batch.length} rows for upload; ${candidates.length - batch.length} history rows remain.`);
    if (candidates.length > batch.length) {
      console.log('Run backfill again tomorrow to stay inside the Workers Free plan daily write limit.');
    }
    console.log('The worker uploads them on its next sync (restart it to start right away: npm run worker:restart).');
  } finally {
    db.close();
  }
}

/**
 * Pull everything from the hub into a throwaway database and report whether it
 * decrypts. Never touches the real database and never prints secrets.
 * --wrong-key uses a fresh random key instead: nothing may be applied.
 */
async function verify(envFile: string | undefined, wrongKey: boolean): Promise<boolean> {
  // --env-file, else CLAUDE_MEM_CLOUD_SYNC_* environment variables (e.g. a cloud
  // environment), else settings.json.
  const fromEnv = ['CLAUDE_MEM_CLOUD_SYNC_HUB_URL', 'CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID']
    .some(name => (process.env[name] ?? '') !== '');
  const source: Record<string, string | undefined> = envFile
    ? readEnvFile(envFile)
    : fromEnv
      ? process.env
      : (existsSync(settingsPath()) ? readJsonFileWithBom<Record<string, string>>(settingsPath()) : {});
  const hubUrl = (source.CLAUDE_MEM_CLOUD_SYNC_HUB_URL ?? '').trim().replace(/\/+$/, '');
  const token = (source.CLAUDE_MEM_CLOUD_SYNC_TOKEN ?? '').trim();
  const userId = (source.CLAUDE_MEM_CLOUD_SYNC_USER_ID ?? '').trim();
  const missing = [
    ['CLAUDE_MEM_CLOUD_SYNC_HUB_URL', hubUrl], ['CLAUDE_MEM_CLOUD_SYNC_TOKEN', token], ['CLAUDE_MEM_CLOUD_SYNC_USER_ID', userId],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    const where = envFile ? envFile : fromEnv ? 'environment variables' : settingsPath();
    throw new UsageError(`missing or empty in ${where}: ${missing.join(', ')}`);
  }
  // The key comes from the key file, or (verify only) CLAUDE_MEM_CLOUD_SYNC_E2E_KEY.
  const envKey = (process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY ?? '').trim();
  const codec = wrongKey ? new E2ECodec(generateE2EKey()) : envKey ? new E2ECodec(decodeE2EKey(envKey)) : requireKey();
  configureSyncE2E(codec);

  // One stable device id per machine, so repeated runs reuse one hub device slot.
  const deviceId = `verify-${createHash('sha256').update(hostname()).digest('hex').slice(0, 12)}`;
  const headers = { Authorization: `Bearer ${token}`, 'X-User-Id': userId, 'X-Device-Id': deviceId };
  const hubRes = await fetch(`${hubUrl}/v1/sync/status`, { headers }).catch((error: Error) => {
    throw new UsageError(`cannot reach the hub: ${error.message}`);
  });
  if (!hubRes.ok) throw new UsageError(`hub status answered HTTP ${hubRes.status}`);
  const hubHead = ((await hubRes.json()) as { head_seq?: string }).head_seq ?? '0';

  const work = mkdtempSync(join(tmpdir(), 'cmem-sync-verify-'));
  try {
    const db = new Database(join(work, 'verify.db'));
    new SessionStore(db, { syncOpsEnabled: true });
    const apply = new SyncApply(db, { deviceId });
    const client = new SyncClient(apply, {
      hubUrl, token, userId, deviceId, deviceName: 'sync-e2e verify', wsEnabled: false,
      activePollMs: 3_600_000, idlePollMs: 3_600_000, suspendAfterMs: 3_600_000, minPullGapMs: 0,
    });
    let previous = '';
    for (let i = 0; i < 20 && apply.getCursor() !== previous; i++) {
      previous = apply.getCursor();
      await client.pullOnce({ timeoutMs: 180_000, force: true });
    }
    client.stop();
    const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    const counts = { observations: count('observations'), summaries: count('session_summaries'), prompts: count('user_prompts') };
    const newest = db.prepare('SELECT length(narrative) AS len FROM observations ORDER BY created_at_epoch DESC LIMIT 1').get() as { len: number | null } | null;
    const cursor = apply.getCursor();
    db.close();

    console.log(`hub ${hubUrl}: head_seq ${hubHead}; key ${codec.keyId}${wrongKey ? ' (random, --wrong-key)' : ''}`);
    console.log(`pulled through seq ${cursor}: ${counts.observations} observations, ${counts.summaries} summaries, ${counts.prompts} prompts`);
    const applied = counts.observations + counts.summaries + counts.prompts;
    const ok = wrongKey
      ? applied === 0 && cursor === '0'
      : applied > 0 && BigInt(cursor) >= BigInt(hubHead) && (newest?.len ?? 0) > 0;
    console.log(ok
      ? (wrongKey ? 'OK: a different key applied nothing.' : 'OK: everything on the hub decrypted and applied.')
      : (wrongKey ? 'FAIL: rows were applied with a different key.' : 'FAIL: the hub could not be fully pulled and decrypted (see the worker log lines above).'));
    return ok;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function status(): void {
  const key = readE2EKey();
  console.log(`key: ${key ? `${e2eKeyPath()} (id ${new E2ECodec(key).keyId})` : 'missing'}`);
  const settings = existsSync(settingsPath()) ? readJsonFileWithBom<Record<string, string>>(settingsPath()) : {};
  const hub = settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL;
  console.log(`hub: ${hub || '(not configured)'}  e2e: ${settings.CLAUDE_MEM_CLOUD_SYNC_E2E ?? 'false'}`);
  const db = new Database(dbPath(), { readonly: true });
  try {
    for (const { table, kind } of TABLES) {
      const row = db.query<{ total: number; pending: number; local: number }, []>(`
        SELECT count(*) AS total,
               sum(synced_at IS NULL AND origin_device_id IS NULL) AS pending,
               sum(origin_device_id IS NULL) AS local
        FROM ${table}`).get()!;
      const history = db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM sync_launch_exclusions WHERE kind = ?').get(kind)!.n;
      console.log(`${table.padEnd(18)} total ${row.total}  local ${row.local ?? 0}  pending upload ${row.pending ?? 0}  history not yet queued ${history}`);
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'env-file': { type: 'string' },
      limit: { type: 'string', default: '12000' },
      'wrong-key': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  switch (command) {
    case 'init': return init();
    case 'export': return exportKey();
    case 'import': return importKey();
    case 'configure': return configure(values['env-file']);
    case 'backfill': {
      const limit = Number.parseInt(values.limit!, 10);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
      return backfill(limit);
    }
    case 'status': return status();
    case 'verify':
      if (!(await verify(values['env-file'], values['wrong-key']!))) process.exitCode = 1;
      return;
    default:
      throw new UsageError('usage: bun scripts/sync-e2e.ts init | export | import | configure --env-file <file> | backfill [--limit N] | status | verify [--env-file <file>] [--wrong-key]');
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`sync-e2e: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
