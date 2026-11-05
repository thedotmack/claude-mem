import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { upsertToolUse } from '../../../src/services/sqlite/tool-uses.js';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';
import { buildAgentView, readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';
import { conversationKey } from '../../../src/services/work-view/request-projection.mjs';
import { groupIdFor } from '../../../src/services/work-view/request-groups.mjs';
import { publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { applySharedProjection, buildSharedProjectionUpdates, decorateSharedView, isSharedProjectionValue, portableWorkValue, resolveEvidenceRef, sharedProjectKey, sharedPublishedUrl, stableEvidenceRef } from '../../../src/services/work-view/shared-projection.mjs';
import { createHumanCopyInput, humanCopyFingerprint } from '../../../src/services/work-view/human-copy.mjs';
import { HumanCopyWorker } from '../../../src/services/work-view/human-copy-worker.mjs';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';
import { sharedReviewDescriptor } from '../../../src/services/work-view/shared-reviews.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const NOW = Date.now();
function store(path = ':memory:') {
  const db = new Database(path);
  const value = new SessionStore(db);
  cleanup.push(() => db.close());
  return value;
}
function state(db: Database, deviceId: string) {
  const rows = db.query('SELECT * FROM work_state_entries').all().map((row: any) => ({ ...row, fields: JSON.parse(row.fields) }));
  return reduceWorkState(rows, { currentProject: 'repo', currentProjectScope: ['repo'], localDeviceId: deviceId });
}
function transferRows(a: SessionStore, b: SessionStore, filter: string, originDeviceId = 'a') {
  const rows = a.db.query(`SELECT * FROM work_state_entries WHERE ${filter} ORDER BY id`).all() as any[];
  const apply = new SyncApply(b.db, { deviceId: 'b' });
  const cursor = BigInt(apply.getCursor());
  const ops = rows.map((row, index) => ({ seq: String(cursor + BigInt(index + 1)), ...buildContentOperation({
    kind: 'work_state', originDeviceId, originLocalId: String(row.id), entityRev: row.sync_rev,
    payload: { created_at: row.created_at, created_at_epoch: String(row.created_at_epoch), project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields) },
  }) }));
  apply.applyOps(decodeChanges(ops), { epoch: '1' });
}
function transferPrompts(a: SessionStore, b: SessionStore) {
  const rows = a.db.query(`SELECT p.*, s.content_session_id, s.memory_session_id, s.platform_source, s.project FROM user_prompts p JOIN sdk_sessions s ON s.id = p.session_db_id ORDER BY p.id`).all() as any[];
  const apply = new SyncApply(b.db, { deviceId: 'b' });
  const cursor = BigInt(apply.getCursor());
  apply.applyOps(decodeChanges(rows.map((row, index) => ({ seq: String(cursor + BigInt(index + 1)), ...buildContentOperation({
    kind: 'prompt', originDeviceId: 'a', originLocalId: String(row.id), entityRev: row.sync_rev,
    payload: Object.fromEntries(['content_session_id', 'memory_session_id', 'platform_source', 'project', 'prompt_number', 'prompt_text', 'created_at', 'created_at_epoch'].map(key => [key, ['created_at_epoch', 'prompt_number'].includes(key) ? String(row[key]) : row[key]])),
  }) }))), { epoch: '1' });
}

test('canonical shared records preserve grouping, progress, attribution and safe products with different receiving IDs', () => {
  const a = store(), b = store();
  const sessionA = a.createSDKSession('conversation-a', 'repo', 'Build release cards', undefined, 'claude');
  const sessionB = a.createSDKSession('conversation-b', 'repo', 'Fix card spacing', undefined, 'claude');
  a.updateMemorySessionId(sessionA, 'memory-a'); a.updateMemorySessionId(sessionB, 'memory-b');
  a.saveUserPrompt('conversation-a', 1, 'Build release cards', sessionA);
  a.saveUserPrompt('conversation-b', 1, 'Fix card spacing', sessionB);
  const fields = { task: 'Card grid', status: 'doing' };
  const workId = a.appendWorkStateEntry({ project: 'repo', listName: 'cards', fields, createdAtEpoch: NOW });
  upsertToolUse(a.db, { toolUseId: 'write-a', contentSessionId: 'conversation-a', sessionDbId: sessionA, memorySessionId: 'memory-a', project: 'repo', platformSource: 'claude', agentId: 'child-a', agentType: 'builder', toolName: 'work_state_write', toolInput: JSON.stringify({ list: 'cards', fields }), createdAtEpoch: NOW });
  upsertToolUse(a.db, { toolUseId: 'launch-a', contentSessionId: 'conversation-a', sessionDbId: sessionA, memorySessionId: 'memory-a', project: 'repo', platformSource: 'claude', toolName: 'Agent', toolInput: JSON.stringify({ description: 'Build the cards', prompt: 'PRIVATE_RAW_LAUNCH_INPUT' }), toolResponse: JSON.stringify({ agentId: 'child-a', status: 'completed', isAsync: false }), createdAtEpoch: NOW + 1 });
  upsertToolUse(a.db, { toolUseId: 'publish-a', contentSessionId: 'conversation-a', sessionDbId: sessionA, memorySessionId: 'memory-a', project: 'repo', platformSource: 'claude', toolName: 'Bash', toolInput: JSON.stringify({ command: "gh pr create --title 'Release cards'" }), toolResponse: JSON.stringify({ stdout: 'https://github.com/example/repo/pull/42' }), createdAtEpoch: NOW + 2 });
  for (let i = 0; i < 4; i++) b.appendWorkStateEntry({ project: 'padding', listName: `empty-${i}`, fields: {} });
  transferRows(a, b, "list_name = 'cards'");
  const receivedWork = b.db.query("SELECT id FROM work_state_entries WHERE list_name = 'cards'").get() as any;
  expect(receivedWork.id).not.toBe(workId);
  const records = readAgentRecords(a.db, { workState: state(a.db, 'a'), now: NOW });
  const keys = records.sessions.map(conversationKey).filter(Boolean);
  const anchor = conversationKey(records.sessions.find((row: any) => row.id === sessionA));
  const groupId = groupIdFor(anchor);
  const ledger = { groups: { groups: { [groupId]: { title: 'Release cards', anchor, projectRoot: 'repo' } }, conversations: Object.fromEntries(keys.map((key: string) => [key, groupId])), ignored: {} }, progress: { [groupId]: { groupId, state: 'in-progress', percent: 60, summary: 'The cards are taking shape.' } }, story: null, refresh: null, agentWrittenPromptIds: new Set() };
  const view = decorateSharedView(buildAgentView(state(a.db, 'a'), records, { ledger, now: NOW }), { records });
  expect(view.coverage.linkedWork).toBe(1);
  const updates = buildSharedProjectionUpdates(a.db, { ledger, records, view, deviceId: 'a' });
  const text = JSON.stringify(updates);
  expect(text).not.toContain('tool_input'); expect(text).not.toContain('tool_response');
  expect(text).not.toContain('PRIVATE_RAW_LAUNCH_INPUT');
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', updates, validateValue: isSharedProjectionValue });
  // Start from the current canonical stream, including its manifests, on B.
  transferRows(a, b, "list_name LIKE '__my_work_v1:%'");
  const shared = readSharedRecords(b.db, { deviceId: 'b', validateValue: isSharedProjectionValue });
  expect(shared.diagnostics.invalid).toBe(0);
  const merged = applySharedProjection(b.db, shared, { records: readAgentRecords(b.db, { workState: state(b.db, 'b'), now: NOW }), deviceId: 'b' });
  const replica = decorateSharedView(buildAgentView(state(b.db, 'b'), merged.records, { ledger: merged.ledger, now: NOW }), merged);
  expect(replica.humanRequests).toHaveLength(1);
  expect(replica.humanRequests[0].progress.percent).toBe(60);
  expect(replica.coverage.linkedWork).toBe(1);
  expect(replica.coverage.unattributedWork).toBe(0);
  expect(replica.humanRequests[0].title).toBe('Release cards');
  expect(replica.humanRequests[0].workProduct.some((item: any) => item.url === 'https://github.com/example/repo/pull/42')).toBe(true);
  expect(replica.agents.find((agent: any) => agent.agentId === 'child-a').presence.status).toBe('finished');
  expect(b.db.query('SELECT COUNT(*) AS n FROM tool_uses').get()).toEqual({ n: 0 });
  const ref = stableEvidenceRef(a.db, 'work-state', workId, 'a')!;
  expect(resolveEvidenceRef(b.db, ref, 'b')).toBe(receivedWork.id);

  // The canonical prompt stream may arrive after the shared manifest. Once
  // both are present the actual projections produce identical normalized copy
  // input even though the receiver has no raw tool calls and different IDs.
  transferPrompts(a, b);
  const withPrompts = applySharedProjection(b.db, shared, { records: readAgentRecords(b.db, { workState: state(b.db, 'b'), now: NOW }), deviceId: 'b' });
  const replicaWithPrompts = decorateSharedView(buildAgentView(state(b.db, 'b'), withPrompts.records, { ledger: withPrompts.ledger, now: NOW }), { ...withPrompts, database: b.db, deviceId: 'b' });
  const input = createHumanCopyInput(view.humanRequests[0]);
  const replicaInput = createHumanCopyInput(replicaWithPrompts.humanRequests[0]);
  expect(replicaInput).toEqual(input);
  const reviewA = sharedReviewDescriptor(a.db, view.humanRequests[0], { deviceId: 'a', sharedState: readSharedRecords(a.db, { deviceId: 'a', validateValue: isSharedProjectionValue }) });
  const reviewB = sharedReviewDescriptor(b.db, replicaWithPrompts.humanRequests[0], { deviceId: 'b', sharedState: shared });
  expect(reviewA.complete).toBe(true);
  expect(reviewB).toEqual(reviewA);
  const copy = { title: 'Release cards', summary: 'The shared card work is underway.', next: '', workstreams: input.workstreams.map((stream: any) => ({ id: stream.id, title: 'Cards', summary: 'The layout is underway.' })) };
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [{ kind: 'copy', key: view.humanRequests[0].id, value: { fingerprint: humanCopyFingerprint(input), copy, generatedAt: NOW } }] });
  transferRows(a, b, "list_name LIKE '__my_work_v1:%'");
  const withCopy = applySharedProjection(b.db, readSharedRecords(b.db, { deviceId: 'b', validateValue: isSharedProjectionValue }), { records: readAgentRecords(b.db, { workState: state(b.db, 'b'), now: NOW }), deviceId: 'b' });
  const finalView = decorateSharedView(buildAgentView(state(b.db, 'b'), withCopy.records, { ledger: withCopy.ledger, now: NOW }), { ...withCopy, database: b.db, deviceId: 'b' });
  const worker = new HumanCopyWorker({ provider: Object.assign(async () => { throw new Error('disabled'); }, { isOff: () => true }) });
  cleanup.push(() => worker.close());
  expect(worker.observe(finalView).humanRequests[0].humanCopy).toMatchObject({ state: 'current', title: 'Release cards' });
  expect(worker.status().queued).toBe(0);
});

test('portable typed evidence drops local locations and resolves only the receiving origin', () => {
  const a = store();
  const id = a.appendWorkStateEntry({ project: 'repo', listName: 'work', fields: { task: 'Review' } });
  const portable = portableWorkValue(a.db, { kind: 'work-state', id, url: `/api/work-view/evidence/work-state/${id}`, path: '/private/report.pdf', bucketPath: '/private/bucket', tool_input: 'secret', api_key: 'secret' }, 'a');
  expect(portable).toEqual({ kind: 'work-state', identity: { kind: 'work-state', device: 'a', row: String(id) }, urlRef: { kind: 'work-state', device: 'a', row: String(id) } });
  expect(resolveEvidenceRef(a.db, { kind: 'work-state', device: 'other', row: String(id) }, 'a')).toBeNull();
});

test('shared published metadata excludes local/private endpoints, bearer locators and filesystem project names', () => {
  const invalid = [
    'http://localhost:37777/api/media/photo', 'http://127.0.0.1:37777/result', 'http://10.1.2.3/result',
    'http://[::1]/result', 'https://worker.internal/result', 'https://worker.local/result',
    'https://cmem.ai/api/media/photo', 'https://cmem.ai/private/file',
    'https://cmem.ai/api/deliverables/42/report.pdf', 'https://cmem.ai/api/%64eliverables/42/report.pdf',
    'https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Credential=PRIVATE&X-Amz-Signature=SECRET',
    'https://storage.googleapis.com/report.pdf?GoogleAccessId=PRIVATE&Signature=SECRET',
    'https://files.example.com/report.pdf?sv=1&sig=SECRET', 'https://files.example.com/report.pdf?access_token=SECRET',
    'https://files.example.com/report.pdf#token=SECRET', 'https://files.example.com/file?path=%2FUsers%2Fprivate%2Freport.pdf',
    'https://files.example.com/report.pdf?accessToken=SECRET', 'https://files.example.com/report.pdf?apiKey=SECRET',
    'https://files.example.com/report.pdf?APIKey=SECRET', 'https://files.example.com/report.pdf?AcCeSsToKeN=SECRET',
    'https://files.example.com/report.pdf?clientAcCeSsToKeN=SECRET', 'https://files.example.com/report.pdf?pRiVaTeKeY=SECRET',
    'https://files.example.com/report.pdf?%61ccess%54oken=SECRET', 'https://files.example.com/report.pdf#%61pi%4Bey=SECRET',
    'https://files.example.com/report.pdf#refreshToken=SECRET', 'https://files.example.com/report.pdf?xAmzSignature=SECRET',
    'https://project.supabase.co/storage/v1/object/sign/bucket/report.pdf',
  ];
  const valid = ['https://github.com/example/repo/pull/42', 'https://www.notion.so/example/Release-cards-0123456789abcdef?pvs=4', 'https://claude.ai/public/artifacts/01234567'];
  for (const url of invalid) expect(sharedPublishedUrl(url)).toBeNull();
  for (const url of valid) expect(sharedPublishedUrl(url)).toBe(url);
  for (const path of ['/Users/private/repo', '~/repo', 'C:\\Users\\private\\repo', '\\\\server\\repo', '../repo', '$HOME/repo']) expect(sharedProjectKey(path)).toBeNull();
  expect(sharedProjectKey('org/repo')).toBe('org/repo');

  const owner = store();
  const sessionId = owner.createSDKSession('published-metadata', '/Users/private/repo', 'Build release cards', undefined, 'claude');
  const session = owner.db.query('SELECT * FROM sdk_sessions WHERE id = ?').get(sessionId);
  const key = conversationKey(session), groupId = groupIdFor(key);
  const records = { sessions: [session], productCalls: [...invalid, ...valid].map((url, index) => ({ id: index + 1, session_db_id: sessionId, tool_name: 'Artifact', tool_input: JSON.stringify({ title: 'Published result' }), tool_response: JSON.stringify({ url }), created_at_epoch: NOW })) };
  const updates = buildSharedProjectionUpdates(owner.db, { deviceId: 'a', records, ledger: { groups: { groups: { [groupId]: { title: 'Cards', anchor: key, projectRoot: '/Users/private/repo' } }, conversations: { [key]: groupId } } } });
  const provenance = updates.find(update => update.kind === 'provenance')!.value;
  expect(provenance.products.map((product: any) => product.url)).toEqual(valid);
  expect(provenance.session.project).toBeNull();
  expect(updates.find(update => update.kind === 'group')!.value.group.projectRoot).toBeUndefined();
  expect(JSON.stringify(updates)).not.toContain('PRIVATE');
  expect(JSON.stringify(updates)).not.toContain('/Users/private/repo');
  expect(updates.every(update => isSharedProjectionValue(update.kind, update.key, update.value))).toBe(true);
  expect(isSharedProjectionValue('provenance', key, { ...provenance, products: [{ kind: 'file', title: 'Private', url: invalid[8] }] })).toBe(false);
  expect(isSharedProjectionValue('provenance', key, { ...provenance, session: { ...provenance.session, project: '/Users/private/repo' } })).toBe(false);
});

test('shared copy displays with generation off and stable stream identities', () => {
  const provider = Object.assign(async () => { throw new Error('must not generate'); }, { isOff: () => true });
  const worker = new HumanCopyWorker({ provider }); cleanup.push(() => worker.close());
  const request: any = { id: 'request', original: { text: 'Build cards' }, scopeUpdates: [], workstreams: [{ id: 'local-b', stableId: 'stable-conversation-stream', items: [], activity: [] }] };
  const input = createHumanCopyInput(request);
  const sharedCopy = { fingerprint: humanCopyFingerprint(input), generatedAt: NOW, copy: { title: 'Release cards', summary: 'Cards are in progress.', next: '', workstreams: [{ id: 'stable-conversation-stream', title: 'Cards', summary: 'Layout work' }] } };
  request.sharedHumanCopy = sharedCopy;
  const displayed: any = worker.observe({ humanRequests: [request] });
  expect(displayed.humanRequests[0].humanCopy.title).toBe('Release cards');
  expect(displayed.humanRequests[0].humanCopy.workstreams[0].id).toBe('local-b');
  expect(worker.status().queued).toBe(0);
  const otherInput = createHumanCopyInput({ ...request, workstreams: [{ ...request.workstreams[0], id: 'local-a' }] });
  expect(humanCopyFingerprint(otherInput)).toBe(sharedCopy.fingerprint);
});

test('domain-invalid newer batches retain previous valid shared values', () => {
  const a = store();
  const key = 'g_0123456789ab';
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', updates: [{ kind: 'progress', key, value: { groupId: key, state: 'in-progress', percent: 60 } }], validateValue: isSharedProjectionValue });
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', updates: [{ kind: 'progress', key, value: { groupId: key, state: 'in-progress', percent: 900 } }] });
  const read = readSharedRecords(a.db, { deviceId: 'a', validateValue: isSharedProjectionValue });
  expect([...read.records.values()][0].value).toMatchObject({ percent: 60 });
  expect(read.diagnostics.invalid).toBeGreaterThan(0);
});

test('canonical writers cannot replace or delete another origin\'s refresh or prompt exclusions', () => {
  const owner = store(), attacker = store();
  const ref = { kind: 'prompt', device: 'a', row: '1' };
  const exclusionKey = JSON.stringify(ref);
  publishSharedRecords(owner.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [
    { kind: 'refresh', key: 'a', value: { originDeviceId: 'a', state: 'ok' } },
    { kind: 'exclusion', key: exclusionKey, value: { ref, opening: true } },
  ] });
  transferRows(owner, attacker, "list_name LIKE '__my_work_v1:%'");
  // A legacy/malicious publisher bypasses domain checks; the receiving domain
  // validator must still reject its complete canonical batch by writer origin.
  publishSharedRecords(attacker.db, { deviceId: 'b', project: 'repo', updates: [
    { kind: 'refresh', key: 'a', value: { originDeviceId: 'a', state: 'failed' } },
    { kind: 'exclusion', key: exclusionKey, value: { ref, opening: false } },
  ] });
  publishSharedRecords(attacker.db, { deviceId: 'b', project: 'repo', updates: [
    { kind: 'refresh', key: 'a', deleted: true }, { kind: 'exclusion', key: exclusionKey, deleted: true },
  ] });
  const shared = readSharedRecords(attacker.db, { deviceId: 'b', validateValue: isSharedProjectionValue });
  const records = [...shared.records.values()];
  expect(records.find(record => record.kind === 'refresh')).toMatchObject({ writer: 'a', deleted: false, value: { state: 'ok' } });
  expect(records.find(record => record.kind === 'exclusion')).toMatchObject({ writer: 'a', deleted: false, value: { opening: true } });
  expect(shared.diagnostics.invalid).toBeGreaterThan(0);
  expect(() => publishSharedRecords(attacker.db, { deviceId: 'b', project: 'repo', validateValue: isSharedProjectionValue,
    updates: [{ kind: 'refresh', key: 'a', value: { originDeviceId: 'a', state: 'ok' } }] })).toThrow();
});

test('incompatible independent group memberships surface the same conflict in opposite canonical arrival orders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-membership-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const first = store(), second = store(), left = store(join(dir, 'memory.db')), right = store();
  const common = JSON.stringify(['conversation', 'claude', 'shared']);
  const anchorA = JSON.stringify(['conversation', 'claude', 'anchor-a']);
  const anchorZ = JSON.stringify(['conversation', 'claude', 'anchor-z']);
  const groupA = groupIdFor(anchorA), groupZ = groupIdFor(anchorZ);
  const groupValue = (anchor: string, title: string) => ({ group: { anchor, title, projectRoot: 'repo' }, members: [anchor, common], suggestions: {} });
  publishSharedRecords(first.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [{ kind: 'group', key: groupA, value: groupValue(anchorA, 'First group') }] });
  publishSharedRecords(second.db, { deviceId: 'Z', project: 'repo', validateValue: isSharedProjectionValue, updates: [{ kind: 'group', key: groupZ, value: groupValue(anchorZ, 'Second group') }] });
  transferRows(first, left, "list_name LIKE '__my_work_v1:%'", 'a');
  transferRows(second, left, "list_name LIKE '__my_work_v1:%'", 'Z');
  transferRows(second, right, "list_name LIKE '__my_work_v1:%'", 'Z');
  transferRows(first, right, "list_name LIKE '__my_work_v1:%'", 'a');
  const project = (db: Database) => applySharedProjection(db, readSharedRecords(db, { deviceId: 'b', validateValue: isSharedProjectionValue }), { deviceId: 'b' });
  const leftView = project(left.db), rightView = project(right.db);
  expect(leftView.ledger.groups.conversations).toEqual(rightView.ledger.groups.conversations);
  expect(leftView.ledger.groups.conversations[common]).toBe(groupA); // binary 'a' sorts after 'Z'
  expect(leftView.diagnostics).toEqual(rightView.diagnostics);
  expect(leftView.diagnostics.membershipConflicts).toEqual([{ kind: 'group-membership', key: common, revision: '1', writers: ['Z', 'a'], groups: [groupA, groupZ].sort(), selectedGroup: groupA }]);
  expect(leftView.diagnostics.conflicts).toHaveLength(1);
  const source = new WorkStateSource({ databasePath: join(dir, 'memory.db'), localDeviceId: 'b' });
  cleanup.push(() => source.close());
  expect(source.read().agentView.sharedState.membershipConflicts).toEqual(leftView.diagnostics.membershipConflicts);

  // A coherent move updates both named objects in one batch, removing the
  // old claim; it does not leave a permanent false conflict behind.
  publishSharedRecords(left.db, { deviceId: 'b', project: 'repo', validateValue: isSharedProjectionValue, updates: [
    { kind: 'group', key: groupA, value: { ...groupValue(anchorA, 'First group'), members: [anchorA] } },
    { kind: 'group', key: groupZ, value: groupValue(anchorZ, 'Second group') },
  ] });
  expect(project(left.db).diagnostics.membershipConflicts).toEqual([]);
});

test('malformed nested shared values cannot replace valid state or carry private process and file fields', () => {
  const key = 'g_0123456789ab';
  const base = { groupId: key, state: 'in-progress', percent: 60 };
  for (const invalid of [{ ...base, readings: {} }, { ...base, milestones: [null] }, { ...base, preferences: [{ preference: 'Keep it small', quotes: 'wrong' }] }, { ...base, outcome: { changes: 'wrong' } }]) {
    expect(isSharedProjectionValue('progress', key, invalid)).toBe(false);
  }
  expect(isSharedProjectionValue('story', 'current', { narrative: 'Good story', preferences: [{ preference: 'Keep it small', quotes: {} }] })).toBe(false);
  expect(isSharedProjectionValue('refresh', 'a', { originDeviceId: 'a', state: 'running', pid: 12 })).toBe(false);
  const conversation = JSON.stringify(['conversation', 'claude', 'x']);
  expect(isSharedProjectionValue('provenance', conversation, { session: { platform_source: 'claude', content_session_id: 'x' }, attributions: [], products: [{ kind: 'file', title: 'Report', url: 'file:///private/report' }], launches: [], activity: [] })).toBe(false);
  expect(isSharedProjectionValue('group', key, { group: { title: 'Group', anchor: conversation }, members: [conversation], suggestions: { [conversation]: null } })).toBe(false);
});

test('the actual read-only data source consumes complete shared state without local ledger files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-work-source-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  const owner = store(path);
  const key = JSON.stringify(['conversation', 'claude', 'stable-conversation']);
  const id = groupIdFor(key);
  publishSharedRecords(owner.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [
    { kind: 'group', key: id, value: { group: { title: 'Shared request', anchor: key, projectRoot: 'repo' }, members: [key], suggestions: {} } },
    { kind: 'progress', key: id, value: { groupId: id, state: 'in-progress', percent: 60, summary: 'The shared work is underway.' } },
    { kind: 'provenance', key, value: { session: { platform_source: 'claude', content_session_id: 'stable-conversation', project: 'repo', user_prompt: 'Build a shared work viewer', started_at_epoch: NOW }, attributions: [], products: [], launches: [], activity: [] } },
  ] });
  const source = new WorkStateSource({ databasePath: path, ledgerDir: null, localDeviceId: 'a' });
  cleanup.push(() => source.close());
  const view = source.read().agentView;
  expect(view.source.connected).toBe(true);
  expect(view.humanRequests).toHaveLength(1);
  expect(view.humanRequests[0]).toMatchObject({ title: 'Shared request', progress: { percent: 60 }, original: { url: null, sourceId: null } });
  expect(view.sharedState.invalid).toBe(0);
});

test('cached reads avoid shared reference lookups and fresh reads resolve later canonical prompts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-reference-cache-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const owner = store(), receiver = store(join(dir, 'memory.db'));
  const sessionId = owner.createSDKSession('late-prompt', 'repo', 'Build late evidence', undefined, 'claude');
  owner.saveUserPrompt('late-prompt', 1, 'Build late evidence', sessionId);
  const promptId = (owner.db.query('SELECT id FROM user_prompts').get() as any).id;
  const padding = receiver.createSDKSession('padding', 'repo', 'padding', undefined, 'claude');
  receiver.saveUserPrompt('padding', 1, 'padding', padding);
  const key = JSON.stringify(['conversation', 'claude', 'late-prompt']);
  const id = groupIdFor(key), ref = { kind: 'prompt', device: 'a', row: String(promptId) };
  publishSharedRecords(owner.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [
    { kind: 'group', key: id, value: { group: { title: 'Late evidence', anchor: key, projectRoot: 'repo',
      anchorAsk: { text: 'Build late evidence', source: 'user-prompt', sourceIdentity: ref, urlRef: ref, atEpoch: NOW - 1000 } }, members: [key], suggestions: {} } },
    { kind: 'progress', key: id, value: { groupId: id, state: 'in-progress', percent: 60,
      evidence: Array.from({ length: 100 }, () => ({ sourceIdentity: ref, urlRef: ref })) } },
  ] });
  transferRows(owner, receiver, "list_name LIKE '__my_work_v1:%'");
  const source = new WorkStateSource({ databasePath: join(dir, 'memory.db'), localDeviceId: 'b' });
  cleanup.push(() => source.close());
  const first = source.read({ maxActivityAgeMs: 120_000 }).agentView;
  expect(first.humanRequests.find((request: any) => request.groupId === id)?.original.url).toBeNull();
  const database = source.openDatabase(), prepare = database.prepare.bind(database), queries: string[] = [];
  database.prepare = (sql: string) => { queries.push(sql); return prepare(sql); };
  const cached = source.read({ maxActivityAgeMs: 120_000 }).agentView;
  expect(cached.revision).toBe(first.revision);
  expect(queries.some(sql => /WHERE origin_device_id = \? AND origin_local_id = \?/.test(sql))).toBe(false);

  // A fresh read re-resolves misses; the per-read saving must never cache a
  // missing reference across a later canonical prompt arriving on this peer.
  transferPrompts(owner, receiver);
  const received = receiver.db.query("SELECT id FROM user_prompts WHERE origin_device_id = 'a'").get() as any;
  expect(received.id).not.toBe(promptId);
  queries.length = 0;
  const refreshed = source.read().agentView;
  expect(refreshed.humanRequests.find((request: any) => request.groupId === id)?.original.url).toBe(`/api/work-view/evidence/prompt/${received.id}`);
  expect(queries.some(sql => /WHERE origin_device_id = \? AND origin_local_id = \?/.test(sql))).toBe(true);
});

test('new display copy is persisted before local acceptance and a failed durable write stays unpublished', async () => {
  let resolvePersist!: () => void;
  const persisted = new Promise<void>(resolve => { resolvePersist = resolve; });
  let called = false;
  const request = { id: 'shared-copy', original: { text: 'Build a viewer' }, workstreams: [], scopeUpdates: [] };
  const worker = new HumanCopyWorker({
    provider: async () => ({ output: { title: 'Viewer', summary: 'The viewer is underway.', next: '', workstreams: [] } }),
    quietMs: 0, minIntervalMs: 0, warn: () => {},
    persistSharedCopy: async (id, entry) => { expect(id).toBe('shared-copy'); expect(entry.copy.title).toBe('Viewer'); called = true; await persisted; },
  });
  cleanup.push(() => worker.close());
  worker.observe({ humanRequests: [request] });
  await new Promise(resolve => setImmediate(resolve));
  expect(called).toBe(true);
  expect(worker.status().cached).toBe(0);
  resolvePersist();
  await new Promise(resolve => setImmediate(resolve));
  expect(worker.status().cached).toBe(1);
  const rejected = new HumanCopyWorker({ provider: async () => ({ output: { title: 'Viewer', summary: 'Work.', next: '', workstreams: [] } }), quietMs: 0, warn: () => {}, persistSharedCopy: () => { throw new Error('disk unavailable'); } });
  cleanup.push(() => rejected.close());
  rejected.observe({ humanRequests: [request] });
  await new Promise(resolve => setImmediate(resolve));
  expect(rejected.status().cached).toBe(0);
});

test('stable prompt exclusions survive receiving row numbers and never expose remote process ownership', () => {
  const a = store(), b = store();
  const aSession = a.createSDKSession('excluded-conversation', 'repo', 'Build the hidden request', undefined, 'claude');
  a.saveUserPrompt('excluded-conversation', 1, 'Build the hidden request', aSession);
  const aPrompt = (a.db.query('SELECT id FROM user_prompts').get() as any).id;
  b.createSDKSession('padding', 'repo', 'padding', undefined, 'claude');
  const bSession = b.createSDKSession('excluded-conversation', 'repo', 'Build the hidden request', undefined, 'claude');
  b.saveUserPrompt('padding', 1, 'padding', 1);
  b.saveUserPrompt('excluded-conversation', 1, 'Build the hidden request', bSession);
  b.db.query('UPDATE user_prompts SET origin_device_id = ?, origin_local_id = ? WHERE session_db_id = ?').run('a', String(aPrompt), bSession);
  const local = { groups: { groups: {}, conversations: {}, ignored: {} }, progress: {}, refresh: { state: 'running', pid: 999999, lock: 'secret', startedAt: new Date(NOW).toISOString() }, agentWrittenPromptIds: new Set([aPrompt]) };
  const updates = buildSharedProjectionUpdates(a.db, { ledger: local, deviceId: 'a' });
  expect(JSON.stringify(updates)).not.toContain('999999');
  expect(JSON.stringify(updates)).not.toContain('secret');
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', updates, validateValue: isSharedProjectionValue });
  transferRows(a, b, "list_name LIKE '__my_work_v1:%'");
  const shared = readSharedRecords(b.db, { deviceId: 'b', validateValue: isSharedProjectionValue });
  const raw = readAgentRecords(b.db, { workState: state(b.db, 'b'), now: NOW });
  const projected = applySharedProjection(b.db, shared, { records: raw, deviceId: 'b' });
  expect(projected.ledger.agentWrittenPromptIds.has(aPrompt)).toBe(false);
  expect(projected.ledger.agentWrittenPromptIds.has((b.db.query('SELECT id FROM user_prompts WHERE session_db_id = ?').get(bSession) as any).id)).toBe(true);
  expect(projected.records.prompts.some((row: any) => row.session_db_id === bSession)).toBe(false);
  expect(projected.records.sessions.find((row: any) => row.id === bSession).user_prompt).toBeNull();
  expect(projected.ledger.refresh).toMatchObject({ originDeviceId: 'a', state: 'running' });
  expect(projected.ledger.refresh.pid).toBeUndefined();
});

test('rules-only reads use shared story suggestions without requiring local story files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-rules-source-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  const owner = store(path);
  publishSharedRecords(owner.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [{ kind: 'story', key: 'current', value: { narrative: 'What the owner wants.', preferences: [{ preference: 'Keep the copied results consistent.', kind: 'directive', supportCount: 1, quotes: [] }] } }] });
  const ledgerDir = join(dir, 'work-view');
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, 'story.json'), '{broken cache');
  const source = new WorkStateSource({ databasePath: path, ledgerDir, localDeviceId: 'a' });
  cleanup.push(() => source.close());
  const result = source.readRules();
  expect(result.source.connected).toBe(true);
  expect(result.rules.some((rule: any) => rule.then === 'Keep the copied results consistent.')).toBe(true);
  owner.db.exec('DELETE FROM work_state_entries');
  // Without a complete canonical story, retain the prior malformed-file error.
  expect(source.readRules().source.connected).toBe(false);
});
