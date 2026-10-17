import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

/**
 * sync_devices (v68): the name of each device that synced rows came from.
 * Replica observations and summaries carry only origin_device_id (NULL on
 * native rows), so this table is the local copy of the hub's device names.
 * CloudSync updates it from the `devices` list of each hub status reply,
 * which also picks up a rename. A reader shows `[name]` on replica rows, and
 * the first 8 characters of the id while the hub has sent no name.
 */
export function createSyncDevicesSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_devices (
      device_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    )
  `);
}

const MAX_DEVICE_NAME_CHARS = 80;
const SHORT_DEVICE_ID_CHARS = 8;

/** One line, no brackets, at most 80 characters: the name goes into the agent's context. */
function cleanDeviceName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DEVICE_NAME_CHARS);
}

export function saveSyncDeviceNames(db: Database, devices: Array<{ deviceId: string; name: string }>): void {
  const upsert = db.prepare(`
    INSERT INTO sync_devices (device_id, name, updated_at_epoch) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, updated_at_epoch = excluded.updated_at_epoch
    WHERE sync_devices.name IS NOT excluded.name
  `);
  const now = Date.now();
  try {
    db.transaction(() => {
      for (const device of devices) {
        const name = cleanDeviceName(device.name);
        if (device.deviceId && name) upsert.run(device.deviceId, name, now);
      }
    })();
  } finally {
    upsert.finalize();
  }
  logger.debug('DB', 'Saved sync device names', { count: devices.length });
}

/**
 * Empty for a database that predates v68, such as a read-only open before the
 * worker migrates. Finalizes its statements: context renders open read-only
 * connections that must release every statement.
 */
export function readSyncDeviceNames(db: Database): Map<string, string> {
  if (allRows(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_devices'").length === 0) return new Map();
  const rows = allRows<{ device_id: string; name: string }>(db, 'SELECT device_id, name FROM sync_devices');
  return new Map(rows.map(row => [row.device_id, row.name]));
}

function allRows<T>(db: Database, sql: string): T[] {
  const statement = db.prepare(sql);
  try {
    return statement.all() as T[];
  } finally {
    statement.finalize();
  }
}

export interface OriginDeviceFields {
  origin_device_id?: string | null;
  /** The display label of a replica row's origin device. Absent on native rows. */
  origin_device?: string;
}

/**
 * Set `origin_device` on each replica row. Native rows (origin_device_id NULL)
 * stay unmarked, and a set with no replica row reads nothing.
 */
export function labelOriginDevices<T extends OriginDeviceFields>(db: Database, rows: T[]): T[] {
  if (!rows.some(row => row.origin_device_id)) return rows;
  const names = readSyncDeviceNames(db);
  for (const row of rows) {
    if (!row.origin_device_id) continue;
    row.origin_device = names.get(row.origin_device_id) ?? row.origin_device_id.slice(0, SHORT_DEVICE_ID_CHARS);
  }
  return rows;
}

/** `[name] ` for a replica row, or '' for a native row. */
export function originDevicePrefix(row: OriginDeviceFields): string {
  return row.origin_device ? `[${row.origin_device}] ` : '';
}
