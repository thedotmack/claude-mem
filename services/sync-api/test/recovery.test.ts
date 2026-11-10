import { afterAll, describe, expect, it } from 'bun:test';
import { authHeaders, observationOp, pushRequest, trackedApp, uniqueUser, stopTrackedApps } from './helpers';

afterAll(stopTrackedApps);

describe('origin-only conditional conflict repair', () => {
  it('reads without device/cursor writes, appends higher revisions, retains originals and retries exactly', async () => {
    const { app } = await trackedApp(); const user = uniqueUser();
    const original = await observationOp('7', '9007199254740993', 'dev-a');
    expect((await pushRequest(app, user, 'dev-a', [original])).status).toBe(200);
    const id = JSON.parse(original.body).id;
    const before = await app.sql`SELECT * FROM sync_devices WHERE user_id=${user}`;
    const read = await fetch(`${app.url}/v1/sync/repair/head`, { method: 'POST', headers: authHeaders(user, 'dev-a'), body: JSON.stringify({ entity_id: id }) });
    expect(read.status).toBe(200); const evidence: any = await read.json();
    expect(evidence.op).toEqual(original);
    expect(Array.from(await app.sql`SELECT * FROM sync_devices WHERE user_id=${user}`)).toEqual(Array.from(before));
    const op = await observationOp('7', '9007199254740994', 'dev-a', { text: 'explicit authoritative choice' });
    const payload = { repair_id: 'repair_test_abcdefghijklmnop', expected_epoch: evidence.epoch, expected_head: evidence.head, op };
    const repair = () => fetch(`${app.url}/v1/sync/repair`, { method: 'POST', headers: authHeaders(user, 'dev-a'), body: JSON.stringify(payload) });
    const result = await repair(); expect(result.status).toBe(200);
    const ack: any = await result.json(); expect(ack.acked[0].entity_rev).toBe('9007199254740994');
    expect((await repair()).status).toBe(200);
    const rows = await app.sql`SELECT body FROM sync_ops WHERE user_id=${user} ORDER BY length(seq),seq`;
    expect(rows.map(row => row.body)).toEqual([original.body, op.body]);
    expect(await app.sql`SELECT * FROM sync_repair_receipts WHERE user_id=${user}`).toHaveLength(1);
  });

  it('refuses foreign origins, changed heads, epochs and same-revision overwrites', async () => {
    const { app } = await trackedApp(); const user = uniqueUser();
    const original = await observationOp('1', '4', 'dev-a');
    await pushRequest(app, user, 'dev-a', [original]);
    const read = await app.store.getRepairHead(user, 'dev-a', JSON.parse(original.body).id);
    const send = (device: string, updates: Record<string, unknown> = {}) => fetch(`${app.url}/v1/sync/repair`, {
      method: 'POST', headers: authHeaders(user, device), body: JSON.stringify({ repair_id: 'repair_test_abcdefghijklmnop',
        expected_epoch: read.epoch, expected_head: read.head, op: original, ...updates }) });
    expect((await send('dev-b')).status).toBe(403);
    expect((await send('dev-a')).status).toBe(409);
    const next = await observationOp('1', '6', 'dev-a');
    expect((await send('dev-a', { op: next, expected_epoch: '1' })).status).toBe(409);
    await pushRequest(app, user, 'dev-a', [await observationOp('1', '5', 'dev-a')]);
    expect((await send('dev-a', { op: next })).status).toBe(409);
    expect(await app.sql`SELECT * FROM sync_ops WHERE user_id=${user}`).toHaveLength(2);
    const foreignRead = await fetch(`${app.url}/v1/sync/repair/head`, { method: 'POST', headers: authHeaders(user, 'dev-b'), body: JSON.stringify({ entity_id: read.entity_id }) });
    expect(foreignRead.status).toBe(400);
  });

  it('scopes heads by authenticated account and rejects token account mismatch', async () => {
    const { app } = await trackedApp(); const user = uniqueUser(), other = uniqueUser();
    const op = await observationOp('1'); await pushRequest(app, user, 'dev-a', [op]);
    await pushRequest(app, other, 'dev-a', []);
    const id = JSON.parse(op.body).id;
    const otherHead = await app.store.getRepairHead(other, 'dev-a', id); expect(otherHead.head).toBeNull();
    const res = await fetch(`${app.url}/v1/sync/repair/head`, { method: 'POST', headers: authHeaders(other, 'dev-a', `valid-for:${user}`), body: JSON.stringify({ entity_id: id }) });
    expect(res.status).toBe(403);
  });

  it('serializes competing repairs against one expected head; only one commits', async () => {
    const { app } = await trackedApp(); const user = uniqueUser();
    const original = await observationOp('1', '1'); await pushRequest(app, user, 'dev-a', [original]);
    const read = await app.store.getRepairHead(user, 'dev-a', JSON.parse(original.body).id);
    const requests = await Promise.all([2, 3].map(async revision => ({ repair_id: `raced_repair_abcdefghijklmnop${revision}`,
      expected_epoch: read.epoch, expected_head: read.head, op: await observationOp('1', String(revision), 'dev-a', { text: `choice ${revision}` }) })));
    const results = await Promise.all(requests.map(body => fetch(`${app.url}/v1/sync/repair`, {
      method: 'POST', headers: authHeaders(user, 'dev-a'), body: JSON.stringify(body) })));
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    expect(await app.sql`SELECT * FROM sync_ops WHERE user_id=${user}`).toHaveLength(2);
    expect(await app.sql`SELECT * FROM sync_repair_receipts WHERE user_id=${user}`).toHaveLength(1);
  });

  it('retains a durable receipt if projection fails and retries without duplicate appends', async () => {
    const { app, sidecar } = await trackedApp(); const user = uniqueUser();
    const original = await observationOp('1', '1'); await pushRequest(app, user, 'dev-a', [original]);
    const read = await app.store.getRepairHead(user, 'dev-a', JSON.parse(original.body).id);
    const request = { repair_id: 'projection_repair_abcdefghijklmnop', expected_epoch: read.epoch,
      expected_head: read.head, op: await observationOp('1', '2') };
    const originalUrl = app.env.INTERNAL_PROJECTOR_URL;
    app.env.INTERNAL_PROJECTOR_URL = `${sidecar.baseUrl}/missing`;
    const send = () => fetch(`${app.url}/v1/sync/repair`, { method: 'POST', headers: authHeaders(user, 'dev-a'), body: JSON.stringify(request) });
    const failed = await send(); expect(failed.status).not.toBe(200);
    expect(await app.sql`SELECT * FROM sync_repair_receipts WHERE user_id=${user}`).toHaveLength(1);
    app.env.INTERNAL_PROJECTOR_URL = originalUrl;
    // The existing projector intentionally retains failed leases until expiry.
    // Advance only this isolated fixture's lease instead of waiting 90 seconds.
    await app.sql`UPDATE sync_users SET projection_lease_expires_at='0' WHERE user_id=${user}`;
    expect((await send()).status).toBe(200);
    expect(await app.sql`SELECT * FROM sync_ops WHERE user_id=${user}`).toHaveLength(2);
  });
});
