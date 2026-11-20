import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache } from '../../../src/utils/redaction.js';
import { logger } from '../../../src/utils/logger.js';
import { SyncApply, type SyncOp } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildContentOperation, canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';
import { redactSyncDiagnostic } from '../../../src/services/sync/diagnostic-redaction.js';
import { createSharedBatch, createSharedEntry } from '../../../src/services/work-view/shared-records.mjs';

const SECRET = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const MARKER = "<redacted type='aws_access_key'/>";
const cleanup: Array<() => void> = [];
const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_REDACT_ENABLED: 'true',
  }));
  cleanup.push(() => settings.mockRestore()); _resetRedactionConfigCache();
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const log = spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logs.push(JSON.stringify(args.map(value => value instanceof Error ? value.message : value)));
    });
    cleanup.push(() => log.mockRestore());
  }
});
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); _resetRedactionConfigCache(); });

function receiver() {
  const db = new Database(':memory:'); new SessionStore(db); cleanup.push(() => db.close());
  return { db, apply: new SyncApply(db, { deviceId: 'receiver', now: () => 1000 }) };
}
function batch(writer = 'sender', project = 'repo', narrative = 'Safe content') {
  const batchId = 'quarantine-test';
  const entry = createSharedEntry({ batchId, writer, kind: 'story', key: 'current', revision: '1', value: { narrative, preferences: [] } });
  return createSharedBatch([entry], { batchId, writer }).map((row, index) => ({
    seq: String(index + 1), ...buildContentOperation({ kind: 'work_state', originDeviceId: writer,
      originLocalId: String(index + 1), entityRev: '1', payload: { project, list_name: row.listName,
        fields: row.fields, created_at: '1970-01-01T00:00:01.000Z', created_at_epoch: '1000' } }),
  }));
}
function assertPrivate(db: Database, secret = SECRET) {
  const forbidden = [...new Set([SECRET, secret])];
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
    const quoted = name.replace(/"/g, '""');
    const serialized = JSON.stringify(db.query(`SELECT * FROM "${quoted}"`).all());
    for (const value of forbidden) expect(serialized, `table ${name}`).not.toContain(value);
  }
  for (const value of forbidden) expect(logs.join('\n')).not.toContain(value);
}

test('encoded scalar secrets retain their sensitive key through JSON and array layers', () => {
  const f = receiver(), scalarSecret = 'x'.repeat(40);
  const encoded = JSON.stringify(scalarSecret);
  const raw = JSON.stringify({
    SecretAccessKey: encoded,
    aws_secret_access_key: JSON.stringify(encoded),
    credentials: JSON.stringify({ SecretAccessKey: encoded }),
    records: { SecretAccessKey: [encoded] },
    objectWrapper: { SecretAccessKey: JSON.stringify({ nested: scalarSecret }) },
    keyWrapper: { SecretAccessKey: JSON.stringify({ [scalarSecret]: 'keyed value' }) },
    innerCredential: JSON.stringify({ Credentials: { SecretAccessKey: encoded } }),
  });
  expect(f.apply.applyOps([{ seq: '1', undecodable: 'encoded scalar fixture', raw }])).toMatchObject({ quarantined: 1, cursor: '1' });
  expect((f.db.query('SELECT raw_body FROM sync_pull_quarantine').get() as any).raw_body).toContain('aws_secret_key');
  assertPrivate(f.db, scalarSecret);
});

test('a tampered canonical wrapper redacts encoded scalar credentials inside fields.raw', () => {
  const f = receiver(), scalarSecret = 'x'.repeat(40), original = batch()[0];
  const body = JSON.parse(original.body);
  body.payload.fields.raw = JSON.stringify({ SecretAccessKey: JSON.stringify(scalarSecret) });
  const bad = { ...original, body: canonicalJson(body), operation_sha256: 'A'.repeat(43) };
  const decoded = decodeChanges([bad]);
  expect(decoded[0]).toHaveProperty('undecodable');
  expect(f.apply.applyOps(decoded)).toMatchObject({ quarantined: 1, cursor: '1' });
  expect((f.db.query('SELECT raw_body FROM sync_pull_quarantine').get() as any).raw_body).toContain('aws_secret_key');
  assertPrivate(f.db, scalarSecret);
});

test('rejected shared project metadata is redacted in quarantine body and diagnostics while the cursor advances', () => {
  const f = receiver(), wires = batch('sender', SECRET);
  expect(f.apply.applyOps(decodeChanges(wires))).toMatchObject({ applied: 0, quarantined: 3, cursor: '3' });
  const rows = f.db.query('SELECT raw_body, reason, operation_sha256 FROM sync_pull_quarantine ORDER BY id').all() as any[];
  expect(rows).toHaveLength(3); expect(rows[0].raw_body).toContain(MARKER);
  expect(rows.map(row => row.operation_sha256)).toEqual(wires.map(wire => wire.operation_sha256));
  assertPrivate(f.db);
});

test('rejected shared writer identity is redacted in metadata, invalidOp reasons and logs', () => {
  const f = receiver(), wires = batch(SECRET);
  expect(f.apply.applyOps(decodeChanges(wires))).toMatchObject({ applied: 0, quarantined: 3, cursor: '3' });
  const row = f.db.query('SELECT * FROM sync_pull_quarantine ORDER BY id LIMIT 1').get() as any;
  expect(row.origin_device_id).toBe(MARKER); expect(row.reason).toContain(MARKER);
  expect(row.operation_sha256).toBe(wires[0].operation_sha256);
  assertPrivate(f.db);
});

test('undecodable canonical wrappers recursively redact nested body, body_json, raw, fields and object keys', () => {
  const f = receiver(), original = batch('sender', 'repo', SECRET)[0];
  const body = JSON.parse(original.body);
  body.payload.fields.body_json = canonicalJson({ raw: canonicalJson({ [SECRET]: SECRET }) });
  const bad = { ...original, body: canonicalJson(body), operation_sha256: 'A'.repeat(43) };
  const decoded = decodeChanges([bad]);
  expect(decoded[0]).toHaveProperty('undecodable');
  expect(f.apply.applyOps(decoded)).toMatchObject({ applied: 0, quarantined: 1, cursor: '1' });
  const row = f.db.query('SELECT raw_body FROM sync_pull_quarantine').get() as any;
  expect(row.raw_body).toContain('redacted');
  assertPrivate(f.db);
});

test('canonical decoder diagnostic messages redact unsupported kind values before logging', () => {
  const f = receiver(), original = batch()[0];
  const body = JSON.parse(original.body); body.kind = SECRET;
  const raw = canonicalJson(body);
  const decoded = decodeChanges([{ ...original, body: raw, operation_sha256: sha256Base64Url(raw) }]);
  expect(f.apply.applyOps(decoded)).toMatchObject({ quarantined: 1, cursor: '1' });
  expect(logs.join('\n')).toContain('Rejected invalid canonical content');
  assertPrivate(f.db);
});

test('malformed diagnostic text and bounded nested JSON cannot retain secrets', () => {
  const f = receiver();
  expect(f.apply.applyOps([{ seq: '1', undecodable: `Malformed ${SECRET}`, raw: `{broken ${SECRET}` }])).toMatchObject({ quarantined: 1, cursor: '1' });
  let deep: unknown = { [SECRET]: SECRET };
  for (let i = 0; i < 40; i++) deep = { body_json: deep };
  expect(JSON.stringify(redactSyncDiagnostic(deep))).not.toContain(SECRET);
  expect(redactSyncDiagnostic('x'.repeat(1024 * 1024 + 1) + SECRET)).toContain('redacted');
  const many = Array.from({ length: 50_001 }, () => SECRET);
  expect(JSON.stringify(redactSyncDiagnostic(many))).not.toContain(SECRET);
  assertPrivate(f.db);
});

test('safe retry bytes stay exact, but transformed body or identity is not replayable', () => {
  const f = receiver();
  const decoded = decodeChanges(batch())[0] as SyncOp;
  const safe = `  ${decoded.body}\n`;
  (f.apply as any).quarantine('', '1', decoded, 'safe failure', safe, true);
  expect(f.db.query('SELECT raw_body, retryable FROM sync_pull_quarantine').get()).toEqual({ raw_body: safe, retryable: 1 });
  (f.apply as any).quarantine('', '2', { ...decoded, origin_device: SECRET }, 'unsafe failure', decoded.body, true);
  expect((f.db.query("SELECT retryable FROM sync_pull_quarantine WHERE seq='2'").get() as any).retryable).toBe(0);
  assertPrivate(f.db);
});

test('legacy replay rejection sanitizes every retained diagnostic field and raw wrapper', () => {
  const f = receiver(), wire = batch(SECRET, SECRET)[0];
  f.db.query(`INSERT INTO sync_pull_quarantine(epoch,seq,kind,entity_id,origin_device_id,origin_local_id,entity_rev,
    operation_sha256,reason,raw_body,retryable,created_at_epoch) VALUES('','1',NULL,NULL,?,NULL,NULL,NULL,?,?,0,1000)`)
    .run(SECRET, `Old ${SECRET}`, JSON.stringify(wire));
  expect(f.apply.replaySetAsideWorkState(decodeChanges)).toBe(0);
  expect((f.db.query('SELECT raw_body FROM sync_pull_quarantine').get() as any).raw_body).toContain('redacted');
  assertPrivate(f.db);
});

test('old retryable rows are sanitized and disabled before a changed identity or body can be replayed', () => {
  const f = receiver(), op = decodeChanges(batch(SECRET))[0] as SyncOp;
  f.db.query(`INSERT INTO sync_pull_quarantine(epoch,seq,kind,entity_id,origin_device_id,origin_local_id,entity_rev,
    operation_sha256,reason,raw_body,retryable,created_at_epoch) VALUES('','1','work_state',?,?,?,?,?,?,?,1,1000)`)
    .run(op.entity_id, op.origin_device, op.origin_id, op.rev, op.operation_sha256, `Old ${SECRET}`, op.body);
  expect(f.apply.applyOps([{ seq: '2', undecodable: 'safe trigger', raw: '{}' }])).toMatchObject({ cursor: '2', applied: 0 });
  expect((f.db.query("SELECT retryable FROM sync_pull_quarantine WHERE seq='1'").get() as any).retryable).toBe(0);
  expect(f.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 0 });
  assertPrivate(f.db);
});

test('legacy ordinary work-state with a redacted origin or body is retained safely and never replayed', () => {
  for (const [origin, project] of [[SECRET, 'repo'], ['sender', SECRET]]) {
    const f = receiver();
    const wire = { seq: '1', ...buildContentOperation({ kind: 'work_state', originDeviceId: origin,
      originLocalId: '1', entityRev: '1', payload: { project, list_name: 'ordinary', fields: { task: 'safe task' },
        created_at: '1970-01-01T00:00:01.000Z', created_at_epoch: '1000' } }) };
    f.db.query(`INSERT INTO sync_pull_quarantine(epoch,seq,kind,entity_id,origin_device_id,origin_local_id,entity_rev,
      operation_sha256,reason,raw_body,retryable,created_at_epoch) VALUES('','1',NULL,NULL,NULL,NULL,NULL,NULL,'old decoder',?,0,1000)`)
      .run(JSON.stringify(wire));
    expect(f.apply.replaySetAsideWorkState(decodeChanges)).toBe(0);
    expect(f.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 0 });
    expect(f.db.query('SELECT COUNT(*) AS n FROM sync_entity_heads').get()).toEqual({ n: 0 });
    expect(f.db.query('SELECT COUNT(*) AS n FROM sync_pull_quarantine').get()).toEqual({ n: 1 });
    assertPrivate(f.db);
  }
});

test('reason-only redaction still permits exact safe ordinary work-state replay', () => {
  const f = receiver();
  const wire = { seq: '1', ...buildContentOperation({ kind: 'work_state', originDeviceId: 'sender',
    originLocalId: '1', entityRev: '1', payload: { project: 'repo', list_name: 'ordinary', fields: { task: 'safe task' },
      created_at: '1970-01-01T00:00:01.000Z', created_at_epoch: '1000' } }) };
  f.db.query(`INSERT INTO sync_pull_quarantine(epoch,seq,kind,entity_id,origin_device_id,origin_local_id,entity_rev,
    operation_sha256,reason,raw_body,retryable,created_at_epoch) VALUES('','1',NULL,NULL,NULL,NULL,NULL,NULL,?,?,0,1000)`)
    .run(`Old ${SECRET}`, JSON.stringify(wire));
  expect(f.apply.replaySetAsideWorkState(decodeChanges)).toBe(1);
  expect(f.db.query('SELECT list_name, fields FROM work_state_entries').get()).toEqual({ list_name: 'ordinary', fields: '{"task":"safe task"}' });
  expect(f.db.query('SELECT COUNT(*) AS n FROM sync_pull_quarantine').get()).toEqual({ n: 0 });
  assertPrivate(f.db);
});
