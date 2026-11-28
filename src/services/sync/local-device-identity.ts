import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { updateSettingsDocument } from '../../shared/settings-document.js';
import { sharedWorkListSql } from '../work-view/shared-records.mjs';
import { logger } from '../../utils/logger.js';

function validIdentity(value: string): string {
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > 128 || value.includes('\0')) {
    throw new Error('Local device identity is invalid');
  }
  return value;
}

/** The identities this database and settings name: the pinned one, the configured one, the settings one and every
 * native shared writer. More than one is a conflict, refused before anything is written. */
function recordedIdentities(db: Database, settingsPath: string, configuredId: string, pinned: string | undefined) {
  const settingsId = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID;
  const identities = new Set([pinned, configuredId, settingsId].filter((value): value is string => Boolean(value)).map(validIdentity));
  // Recover a missing settings value from native shared records, never from
  // imported rows belonging to other machines.
  try {
    const writers = db.query(`SELECT DISTINCT json_extract(fields, '$.writer') AS writer FROM work_state_entries
      WHERE origin_device_id IS NULL AND ${sharedWorkListSql('list_name')} AND json_valid(fields)`).all() as Array<{ writer: unknown }>;
    for (const { writer } of writers) {
      if (typeof writer !== 'string') throw new Error('Native shared work has an invalid device identity');
      identities.add(validIdentity(writer));
    }
  } catch (error) {
    if (!/no such (table|column)/i.test(String((error as Error).message))) throw error;
  }
  if (identities.size > 1) throw new Error('Local device identity conflicts with saved work; reconnect or restore the original identity before writing');
  return { settingsId, identity: [...identities][0] as string | undefined };
}

const pinnedIdentity = (db: Database) => (db.query('SELECT device_id FROM local_work_view_identity WHERE singleton=1').get() as { device_id: string } | null)?.device_id;

/**
 * A local writer keeps the same origin when cloud sync is enabled later.
 * Serialize the read/mint/persist operation with the same immediate-transaction
 * pattern as sqlite/connection.ts; two entrypoints sharing a DB cannot mint
 * different writers. This local-only singleton is not an epoch/reset cursor.
 * An identity already pinned and already in settings needs nothing minted or
 * persisted, so it is confirmed in a read transaction, which never takes the
 * write lock. Its writer scan reads every work-state row (124,281 rows and
 * about 230 ms on the owner's Mac, 2026-11-27), and every ledger write of the
 * request-progress CLI opens with it, so under the lock it held every other
 * writer back that long.
 */
export function ensureLocalDeviceIdentity(db: Database, settingsPath: string, configuredId = ''): string {
  const confirmed = db.transaction(() => {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_work_view_identity'").get()) return null;
    const pinned = pinnedIdentity(db);
    if (!pinned) return null;
    const { settingsId, identity } = recordedIdentities(db, settingsPath, configuredId, pinned);
    return settingsId === pinned && identity === pinned ? pinned : null;
  })();
  if (confirmed) return confirmed;
  return db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS local_work_view_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), device_id TEXT NOT NULL)');
    const pinned = pinnedIdentity(db);
    const { settingsId, identity } = recordedIdentities(db, settingsPath, configuredId, pinned);
    const deviceId = identity ?? randomUUID();
    // Write settings while holding the DB lock. A crash before DB commit leaves
    // the same identity recoverable from settings, and a refused settings write
    // rolls the DB transaction back before any shared record can be authored.
    // An identity the DB already pins is durable, so a refused write (such as a
    // settings.json that is not valid JSON) only skips the settings copy.
    if (settingsId !== deviceId) {
      const result = updateSettingsDocument(settingsPath, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: deviceId }, SettingsDefaultsManager.getAllDefaults());
      if (result.status === 'refused') {
        const cause = result.error instanceof Error ? result.error : new Error(String(result.error));
        if (pinned) {
          logger.warn('DB', 'Could not save the local device identity to settings; using the identity saved in the database', { settingsPath }, cause);
        } else {
          throw new Error(`Could not save the local device identity to ${settingsPath}: ${cause.message}. If this file is not valid JSON, repair or delete it, then restart claude-mem.`, { cause });
        }
      }
    }
    if (!pinned) db.query('INSERT INTO local_work_view_identity(singleton,device_id) VALUES(1,?)').run(deviceId);
    return deviceId;
  }).immediate();
}
