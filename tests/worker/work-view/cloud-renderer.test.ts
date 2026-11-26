import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { createSharedBatch, createSharedEntry, focusAreaRowFields, placementRowFields, groupIdFor, foldCloudBatch, renderCloudWorkView } from '../../../src/services/work-view/cloud-renderer.js';
import { workViewRequestDetail } from '../../../src/services/work-view/overview.js';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';
import type { CloudWorkDocument } from '../../../src/services/work-view/cloud-renderer-core.mjs';

function batch(writer: string, batchId: string, revision: string, kind: string, key: string, value: unknown) {
  const entry = createSharedEntry({ writer, batchId, revision, kind, key, value });
  return createSharedBatch([entry], { writer, batchId }).map((row, i) => ({
    id: i + 1, list_name: row.listName, fields: row.fields, origin_device_id: writer, origin_local_id: String(i + 1),
  }));
}
function prompt(now: number, session: string, text: string, originId: number): CloudWorkDocument {
  return {
    id: String(originId), numeric_id: 9000 + originId, session_db_id: 500, kind: 'prompt', entity_rev: '1',
    origin_device_id: 'laptop', origin_local_id: String(originId), created_at_epoch: now, created_at: new Date(now).toISOString(),
    platform_source: 'claude', project: 'repo', merged_into_project: null,
    content_session_id: session, memory_session_id: 'memory-' + session,
    payload: { prompt_number: '1', prompt_text: text },
  };
}
describe('shared Cloud Work View rendering', () => {
  test('renders a first visit without creating records, a local worker, or trial instructions', () => {
    const result = renderCloudWorkView({ now: 1000, revision: '0' });
    expect(result.overview.model.requests).toEqual([]);
    expect(result.details).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.editContext).toMatchObject({ revision: '0', requests: [], focusAreas: [], savedRules: [] });
  });
  test('uses the local review identity despite remapped integers and string wire decimals', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cmem-renderer-'));
    const databasePath = join(directory, 'work.db');
    const store = new SessionStore(databasePath);
    const source = new WorkStateSource({ databasePath, localDeviceId: 'laptop' });
    try {
      store.setLocalSyncDeviceId('laptop');
      const ask = 'Build a shared workspace.';
      const sid = store.createSDKSession('session', 'repo', ask, undefined, 'claude');
      store.updateMemorySessionId(sid, 'memory-session');
      store.saveUserPrompt('session', 1, ask, sid);
      const row = store.db.query('SELECT id, created_at_epoch AS now FROM user_prompts').get() as { id: number; now: number };
      const attachment = { id:'00000000-0000-4000-8000-000000000001', label:'release-screenshot', inspection:'uninspected' };
      const metadata = { cmem_media_v1: { version:1, attachments:[attachment] }, internal_notes:'unlisted metadata' };
      store.db.prepare(`INSERT INTO observations(id,memory_session_id,project,prompt_number,type,title,narrative,metadata,created_at,created_at_epoch)
        VALUES(27,'memory-session','repo',1,'discovery','Verified the workspace','Portable evidence',?,?,?)`)
        .run(JSON.stringify(metadata),new Date(row.now).toISOString(),row.now);
      const native = source.read();
      expect(native.source.connected).toBe(true);
      const nativeRequest = native.agentView.humanRequests[0];
      const document = prompt(row.now, 'session', ask, row.id);
      document.payload.tool_input = 'DO NOT EXPOSE NON-CANONICAL TOOL INPUT';
      const observation: CloudWorkDocument = { ...document, numeric_id:810, session_db_id:612, id:'observation', origin_local_id:'27',
        kind:'observation', content_session_id:'', platform_source:'',
        payload:{ prompt_number:'1', title:'Verified the workspace', type:'discovery', narrative:'Portable evidence', metadata } };
      const documents = [observation, document];
      const result = renderCloudWorkView({ now: row.now, revision: '42', documents });
      expect(result.overview.model.requests).toHaveLength(1);
      expect(result.details[0].id).toEqual(result.overview.model.requests[0].id);
      expect(result.details[0].detail.request.detailRevision).toBe(result.overview.model.requests[0].detailRevision);
      expect(result.details[0].detail.request.review).toMatchObject({ mode: 'shared', available: true });
      expect(result.editContext).toMatchObject({
        revision: '42', requests: [{ readyForCheck: false, reviewDescriptor: nativeRequest.sharedReviewDescriptor, contentFingerprint: nativeRequest.sharedReviewDescriptor.fingerprint }],
      });
      expect(result.evidence).toContainEqual({
        kind: 'prompt', id: document.numeric_id, value: { kind: 'prompt', id: document.numeric_id, prompt_number: 1, prompt_text: ask, session_db_id: 500, created_at_epoch: row.now },
      });
      expect(result.details[0].detail.request.media).toEqual({ count: 1, preview: [attachment] });
      expect(JSON.stringify(result)).not.toContain('DO NOT EXPOSE NON-CANONICAL TOOL INPUT');
      expect(JSON.stringify(result)).not.toContain('unlisted metadata');
      const checked = batch('browser', 'checked', '1', 'review', nativeRequest.sharedReviewDescriptor.requestId,
        { version: 2, requestId: nativeRequest.sharedReviewDescriptor.requestId, fingerprint: nativeRequest.sharedReviewDescriptor.fingerprint, checked: true, checkedAtEpoch: row.now });
      const checkedView = renderCloudWorkView({ now: row.now, revision: '43', documents, sharedHeads: foldCloudBatch(checked).members });
      expect(checkedView.details[0].detail.request.checkedAtIso).toBe(new Date(row.now).toISOString());
    } finally {
      source.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('groups requests from Claude and Gemini and replays a synced focus placement in native order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cmem-renderer-group-'));
    const databasePath = join(directory, 'work.db');
    const store = new SessionStore(databasePath);
    const source = new WorkStateSource({ databasePath, localDeviceId: 'laptop' });
    try {
      store.setLocalSyncDeviceId('laptop');
      const now = Date.now();
      const keys = ['claude', 'gemini'].map(platform => JSON.stringify(['conversation', platform, platform + '-chat']));
      const groupId = groupIdFor(keys[0]);
      const docs: CloudWorkDocument[] = ['claude', 'gemini'].map((platform, i) => {
        const name = platform + '-chat';
        const text = i ? 'Check how our workspace syncs.' : 'Build our shared workspace.';
        const sid = store.createSDKSession(name, 'repo', text, undefined, platform);
        store.updateMemorySessionId(sid, 'memory-' + name);
        store.saveUserPrompt(name, 1, text, sid);
        const origin = i ? 'workstation' : 'laptop';
        const originId = i ? 214 : 5;
        store.db.query('UPDATE user_prompts SET origin_device_id=?, origin_local_id=?, created_at_epoch=? WHERE session_db_id=?').run(origin, String(originId), now+i, sid);
        return { ...prompt(now+i, name, text, originId), origin_device_id: origin, platform_source: platform, session_db_id: 700+i };
      });
      const rows = batch('laptop', 'joined', '1', 'group', groupId,
        { group: { title: 'Shared workspace', anchor: keys[0], projectRoot: 'repo' }, members: keys, suggestions: {} });
      rows.push(...batch('workstation', 'progress', '1', 'progress', groupId, {
        groupId, state: 'in-progress', percent: 64, summary: 'Both clients now sync.', checkedAt: new Date(now).toISOString(),
        readings: [{ at: new Date(now).toISOString(), percent: 64 }], milestones: [],
      }));
      rows.push(...batch('publisher', 'release', '1', 'provenance', keys[0], {
        session: { project: 'repo', platform_source: 'claude', content_session_id: 'claude-chat', memory_session_id: 'memory-claude-chat' },
        attributions: [], activity: [], launches: [],
        products: [{ kind: 'website', title: 'Release notes', url: 'https://release.example.com/sync', atEpoch: now }],
      }));
      const save = store.db.prepare('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch,origin_device_id,origin_local_id) VALUES(?,?,?,?,?,?,?)');
      for (const row of rows) save.run('repo', row.list_name, JSON.stringify(row.fields), new Date(now).toISOString(), now, row.origin_device_id, row.origin_local_id);
      const areaId = 'fa_live';
      const focusRows = [
        focusAreaRowFields({ focusAreaId: areaId, name: 'Client sync', status: 'kept', source: 'owner', decidedBy: 'owner' }),
        placementRowFields({ anchorConversationKey: keys[0], focusAreaId: areaId, placedBy: 'owner' }),
      ];
      for (const [i,fields] of focusRows.entries()) {
        const originId = 600+i;
        save.run('My Work', 'my-focus', JSON.stringify(fields), new Date(now).toISOString(), now, 'browser', String(originId));
        docs.push({ ...prompt(now, '', '', originId), kind: 'work_state', session_db_id: null, platform_source: '', memory_session_id: '',
          content_session_id: '', origin_device_id: 'browser', project: 'My Work', payload: { list_name:'my-focus', fields } } as CloudWorkDocument);
      }
      const native = source.read().agentView;
      expect(native.humanRequests).toHaveLength(1);
      const projected = renderCloudWorkView({ now: now+2, revision: '49', documents: docs.reverse(), sharedHeads: foldCloudBatch(rows).members });
      expect(projected.details).toHaveLength(1);
      expect(projected.details[0].id).toBe(native.humanRequests[0].id);
      const nativeDetail = workViewRequestDetail(native, native.humanRequests[0].id, now+2)!.request;
      const remoteDetail = projected.details[0].detail.request;
      expect(remoteDetail.focusAreaId).toBe(areaId);
      expect(remoteDetail.workProduct).toEqual(nativeDetail.workProduct);
      expect(remoteDetail.workProduct).toContainEqual(expect.objectContaining({ href: 'https://release.example.com/sync' }));
      expect(remoteDetail.progress).toEqual(nativeDetail.progress);
      expect(remoteDetail.progress.percent).toBe(64);
      expect(projected.editContext).toMatchObject({ focusAreas: native.focusAreas, requests: [{
        reviewDescriptor: native.humanRequests[0].sharedReviewDescriptor, originalAsk: native.humanRequests[0].original.text,
      }] });
    } finally {
      source.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('discloses origin-only products by name, and native session evidence by its durable session ID', () => {
    const now = Date.now();
    const key = JSON.stringify(['conversation','claude','only-rich']);
    const session = { id: 777, platform_source: 'claude', content_session_id: 'only-rich', memory_session_id: 'm',
      user_prompt: 'Ship the release report.', custom_title: 'Release report', project: 'repo', started_at_epoch: now, status: 'completed' };
    const rows = batch('laptop','portable-session','1','provenance',key,{ session, attributions: [], activity: [], launches: [],
      products: [
        { kind: 'document', title: 'Release.pdf', originDeviceId: 'laptop', productId: 'local_'+'a'.repeat(64), availability: 'origin-only', atEpoch: now },
        { kind: 'website', title: 'Published report', url:'https://reports.example.com/release', atEpoch: now },
      ] });
    const result = renderCloudWorkView({ now, revision: '2', sharedHeads: foldCloudBatch(rows).members,
      sessions: [
        { id: 777, platform_source: 'claude', content_session_id: 'unrelated' },
        { id: 910, platform_source: 'claude', content_session_id: 'only-rich' },
      ] });
    expect(result.details).toHaveLength(1);
    expect(result.evidence.some(item => item.kind === 'session' && item.id === 777)).toBe(false);
    expect(result.evidence).toContainEqual({ kind: 'session', id: 910,
      value: { kind:'session', id:910, project:'repo', platform_source:'claude', user_prompt:session.user_prompt,
        custom_title:session.custom_title, status:'completed', started_at_epoch:now } });
    expect(result.editContext).toMatchObject({ requests: [{ reviewDescriptor: { complete:true } }] });
    expect(result.details[0].detail.request.workProduct).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Release.pdf', href: undefined, availability: 'origin-only' }),
      expect.objectContaining({ label: 'Published report', href: 'https://reports.example.com/release' }),
    ]));
  });

  test.each(['claude', 'gemini'])('links ordinary %s observations to the originating conversation in either arrival order', platform => {
    const now = Date.now();
    const ask = { ...prompt(now, 'actual-chat', 'Test our release.', 21), platform_source: platform };
    // Ordinary observation bodies have a memory id, while their real platform and content id come from a prompt.
    const observation: CloudWorkDocument = {
      ...ask, id: 'observation', numeric_id: 931, origin_local_id: '8', kind: 'observation',
      platform_source: '', content_session_id: '', session_db_id: 633, created_at_epoch: now+1,
      payload: { prompt_number: '1', agent_id: 'reviewer', agent_type: 'general-purpose', type: 'change', title: 'Reviewed the release.' },
    };
    for (const documents of [[observation, ask], [ask, observation]]) {
      const result = renderCloudWorkView({ now: now+2, revision: '5', documents });
      expect(result.details).toHaveLength(1);
      expect(result.details[0].detail.request.conversations.map(conversation => conversation.platform)).toEqual([platform]);
      expect(result.editContext).toMatchObject({ agents: expect.arrayContaining([
        expect.objectContaining({ agentId: 'reviewer', platformSource: platform, contentSessionId: 'actual-chat', isSubagent: platform === 'claude' }),
      ]) });
      expect(Object.values(result.overview.agentQuietAt)).toEqual(platform === 'claude' ? [now+1+15*60000+1] : []);
    }
  });

  test('retains every representable request when one synced decimal exceeds the UI range', () => {
    const now = Date.now();
    const large = (2n ** 63n - 1n).toString();
    const valid = prompt(now, 'valid', 'Prepare our release notes.', 13);
    const farFuture = { ...prompt(now, 'wrong-date', 'Out-of-range date.', 14), created_at_epoch: Number(large) };
    const unrepresentable = prompt(now, 'wrong-number', 'Out-of-range prompt.', 15);
    unrepresentable.payload.prompt_number = large;
    const result = renderCloudWorkView({ now, revision: '34', documents: [farFuture, valid, unrepresentable] });
    expect(result.details).toHaveLength(1);
    expect(result.overview.model.sharedState).toMatchObject({ unsupported: 2 });
    expect(result.evidence.map(item => item.id)).toContain(valid.numeric_id);
    expect(result.evidence.map(item => item.id)).not.toContain(unrepresentable.numeric_id);
  });

  test('keeps clean state while a newer commit lacks a member or its origin mismatches', () => {
    const previous = batch('a', 'earlier', '1', 'story', 'current', { narrative: 'Ready', preferences: [] });
    const next = batch('b', 'later', '2', 'story', 'current', { narrative: 'New', preferences: [] });
    let state = foldCloudBatch([...previous, next.at(-1)!]);
    expect(state).toMatchObject({ pending: 1, invalid: 0, members: [{ value: { narrative: 'Ready' } }] });
    state = foldCloudBatch([...previous, ...next.map(row => ({ ...row, origin_device_id: 'different' }))]);
    expect(state.invalid).toBeGreaterThan(0);
    expect(state.members.map(member => member.value)).toEqual([{ narrative: 'Ready', preferences: [] }]);
    const wrong = { ...previous[0], id: 999, fields: { ...previous[0].fields, payload: '{"narrative":"changed","preferences":[]}' } };
    state = foldCloudBatch([wrong, ...previous]);
    expect(state.invalid).toBe(1);
    expect(state.members[0].sourceId).toBe(previous[0].id);
    expect(state.members[0].value).toEqual({ narrative:'Ready', preferences:[] });
    const tied = batch('b', 'tied', '1', 'story', 'current', { narrative: 'Competing', preferences: [] });
    expect(foldCloudBatch([...previous, ...tied].reverse()).members).toEqual(foldCloudBatch([...tied, ...previous]).members);
    expect(foldCloudBatch([...tied, ...previous]).members).toHaveLength(2);
  });
});
