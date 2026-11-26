/**
 * Read-only access to the Messages database on a Mac
 * (~/Library/Messages/chat.db).
 *
 * The database belongs to Messages. This module only ever opens it read-only
 * and never writes, vacuums or checkpoints it. Reading it needs Full Disk
 * Access for the app (or terminal) that runs the observer; without it macOS
 * refuses the open with "operation not permitted" or "authorization denied".
 *
 * Under Bun the database is opened with `bun:sqlite`; under Node with
 * `node:sqlite` where that exists. Dates are turned into Unix milliseconds in
 * SQL, because Messages stores nanoseconds since 2001, which do not fit in a
 * JavaScript number (and node:sqlite refuses to return them).
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export function defaultChatDbPath(): string {
  return join(homedir(), 'Library', 'Messages', 'chat.db');
}

/** The few calls the source needs, the same under Bun and Node. */
export interface ReadOnlyDb {
  all<T>(sql: string, ...params: Array<string | number | null>): T[];
  get<T>(sql: string, ...params: Array<string | number | null>): T | undefined;
  close(): void;
}

export type ChatDbAccess =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: 'missing' | 'no-permission' | 'unreadable'; detail: string };

const PERMISSION_WORDS = /operation not permitted|authorization denied|permission denied|EPERM|EACCES|SQLITE_AUTH|unable to open/i;

/** Whether this process can read the Messages database, and if not, why. */
export function checkChatDbAccess(path: string = defaultChatDbPath()): ChatDbAccess {
  if (!existsSync(path)) {
    // Without Full Disk Access, ~/Library/Messages can look empty or missing.
    const folder = join(path, '..');
    try {
      accessSync(folder, constants.R_OK);
    } catch (error) {
      return { ok: false, path, reason: 'no-permission', detail: describe(error) };
    }
    return { ok: false, path, reason: 'missing', detail: 'No Messages database at ' + path };
  }
  try {
    const db = openChatDb(path);
    try {
      db.get('SELECT COUNT(*) AS n FROM chat');
    } finally {
      db.close();
    }
    return { ok: true, path };
  } catch (error) {
    const detail = describe(error);
    return { ok: false, path, reason: PERMISSION_WORDS.test(detail) ? 'no-permission' : 'unreadable', detail };
  }
}

const require = createRequire(import.meta.url);

/** Opens chat.db read-only. Throws when it cannot be opened or read. */
export function openChatDb(path: string = defaultChatDbPath()): ReadOnlyDb {
  if (process.versions.bun) {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    return {
      all: <T>(sql: string, ...params: Array<string | number | null>) => db.query(sql).all(...params) as T[],
      get: <T>(sql: string, ...params: Array<string | number | null>) => (db.query(sql).get(...params) ?? undefined) as T | undefined,
      close: () => db.close(),
    };
  }
  let sqlite: { DatabaseSync: new (path: string, options: { readOnly: boolean }) => NodeSqlite };
  try {
    sqlite = require('node:sqlite');
  } catch {
    throw new Error('Reading the Messages database needs Bun or Node 22.13 or newer.');
  }
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  return {
    all: <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).get(...params) as T | undefined,
    close: () => db.close(),
  };
}

interface NodeSqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}

/** SQL turning a Messages date column (ns or s since 2001) into Unix ms. */
export function appleDateMs(column: string): string {
  return `(CASE WHEN ${column} IS NULL OR ${column} = 0 THEN 0 `
    + `WHEN ${column} > 1000000000000 THEN ${column} / 1000000 + 978307200000 `
    + `ELSE ${column} * 1000 + 978307200000 END)`;
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return `${(error as { code: string }).code}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
