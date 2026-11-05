import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { updateSettingsDocument } from '../../shared/settings-document.js';

function validIdentity(value: string): string {
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > 128 || value.includes('\0')) {
    throw new Error('Local device identity is invalid');
  }
  return value;
}

/**
 * A local writer keeps the same origin when cloud sync is enabled later.
 * Serialize the read/mint/persist operation with the same immediate-transaction
 * pattern as sqlite/connection.ts; two entrypoints sharing a DB cannot mint
 * different writers. This local-only singleton is not an epoch/reset cursor.
 */
export function ensureLocalDeviceIdentity(db: Database, settingsPath: string, configuredId = ''): string {
  return db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS local_work_view_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), device_id TEXT NOT NULL)');
    const pinned = (db.query('SELECT device_id FROM local_work_view_identity WHERE singleton=1').get() as { device_id: string } | null)?.device_id;
    const settingsId = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID;
    const identities = new Set([pinned, configuredId, settingsId].filter((value): value is string => Boolean(value)).map(validIdentity));
    // Recover a missing settings value from native shared records, never from
    // imported rows belonging to other machines.
    try {
      const writers = db.query(`SELECT DISTINCT json_extract(fields, '$.writer') AS writer FROM work_state_entries
        WHERE origin_device_id IS NULL AND list_name GLOB '__my_work_v[0-9]*:*' AND json_valid(fields)`).all() as Array<{ writer: unknown }>;
      for (const { writer } of writers) {
        if (typeof writer !== 'string') throw new Error('Native shared work has an invalid device identity');
        identities.add(validIdentity(writer));
      }
    } catch (error) {
      if (!/no such (table|column)/i.test(String((error as Error).message))) throw error;
    }
    if (identities.size > 1) throw new Error('Local device identity conflicts with saved work; reconnect or restore the original identity before writing');
    const deviceId = [...identities][0] ?? randomUUID();
    // Write settings while holding the DB lock. A crash before DB commit leaves
    // the same identity recoverable from settings, and a refused settings write
    // rolls the DB transaction back before any shared record can be authored.
    if (settingsId !== deviceId) {
      const result = updateSettingsDocument(settingsPath, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: deviceId }, SettingsDefaultsManager.getAllDefaults());
      if (result.status === 'refused') throw result.error instanceof Error ? result.error : new Error('Local device identity could not be saved');
    }
    if (!pinned) db.query('INSERT INTO local_work_view_identity(singleton,device_id) VALUES(1,?)').run(deviceId);
    return deviceId;
  }).immediate();
}
