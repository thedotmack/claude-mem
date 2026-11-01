import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Loading from cwd lets the same fixture check an unchanged checkout. Each
// invocation owns its data/config directories before production modules load.
const load = (file: string) => import(pathToFileURL(join(process.cwd(), file)).href);
const { SessionStore } = await load('src/services/sqlite/SessionStore.ts');
const { SyncApply } = await load('src/services/sync/SyncApply.ts');
const { ChromaSync } = await load('src/services/sync/ChromaSync.ts');
const { ChromaSyncState } = await load('src/services/sync/ChromaSyncState.ts');
const { ChromaMcpManager } = await load('src/services/sync/ChromaMcpManager.ts');

const kind = process.env.CHROMA_ROW_KIND ?? 'observation';
const schedule = process.env.CHROMA_ROW_SCHEDULE ?? 'before-turn';
const rehome = schedule === 'queued-rehome' || schedule === 'waiting-rehome';
const failRevision = process.env.CHROMA_FAIL_REVISION === '1';
const throwLookup = process.env.CHROMA_THROW_LOOKUP === '1';
const restart = process.env.CHROMA_ROW_RESTART === '1';
const live = process.env.CHROMA_ROW_LIVE === '1';
const project = 'deployment-project';
const movedProject = 'rehome-project';
const docType = kind === 'summary' ? 'session_summary' : kind === 'prompt' ? 'user_prompt' : 'observation';
const table = kind === 'summary' ? 'session_summaries' : kind === 'prompt' ? 'user_prompts' : 'observations';
const checkpointKind = kind === 'summary' ? 'summaries' : kind === 'prompt' ? 'prompts' : 'observations';
const dataDir = process.env.CLAUDE_MEM_DATA_DIR!;
const indexPath = join(dataDir, 'transport-index.json');
const indexed = new Map<string, { document: string; metadata: Record<string, unknown> }>(
  existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [],
);
const store = new SessionStore(join(dataDir, 'probe.db'));
const sync = new ChromaSync('claude-mem');
const liveSync = new ChromaSync('claude-mem');
// Summaries have at most six fragments; a one-document batch exercises the
// same boundary as an observation exceeding the production 100-doc batch.
if (kind === 'summary' && schedule === 'during-row') sync.BATCH_SIZE = 1;
const manager = ChromaMcpManager.getInstance();
const realCall = manager.callTool.bind(manager);
if (!live) manager.acceptsMutations = () => true;
let release!: () => void;
let reached!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const blocked = new Promise<void>(resolve => { reached = resolve; });
let pause = false;
let blockerId = 0;
let targetId = 0;
let targetMutations = 0;
let failWrites = false;
let failLookup = false;
const mutations = new Set(['chroma_add_documents', 'chroma_update_documents']);
manager.callTool = async (tool: string, args: any) => {
  const ids: string[] = args.ids ?? [];
  if (failLookup && tool === 'chroma_get_documents' && args.where?.sqlite_id === targetId) {
    failLookup = false;
    throw new Error('Injected fragment lookup failure');
  }
  if (failWrites && mutations.has(tool)
    && args.metadatas.some((metadata: any) => metadata.sqlite_id === targetId && metadata.doc_type === docType)
    && args.documents.some((text: string) => text.includes('new green cluster'))) {
    throw new Error('Injected temporary failure writing the revised memory');
  }
  let result: any = {};
  if (live) {
    result = await realCall(tool, args);
  } else if (tool === 'chroma_get_documents') {
    const found = (args.ids ? ids.filter(id => indexed.has(id)) : [...indexed.keys()].filter(id =>
      !args.where || Object.entries(args.where).every(([key, value]) => indexed.get(id)!.metadata[key] === value),
    )).slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? Infinity));
    result = { ids: found, metadatas: found.map(id => indexed.get(id)!.metadata), documents: found.map(id => indexed.get(id)!.document) };
  } else if (tool === 'chroma_delete_documents') {
    ids.forEach(id => indexed.delete(id));
  } else if (mutations.has(tool)) {
    // add rejects the whole conflicting batch; update ignores missing IDs.
    if (tool === 'chroma_add_documents' && ids.some(id => indexed.has(id))) {
      throw new Error('IDs already exist in collection');
    }
    ids.forEach((id, index) => {
      if (tool === 'chroma_add_documents' || indexed.has(id)) {
        indexed.set(id, { document: args.documents[index], metadata: args.metadatas[index] });
      }
    });
  }
  if (mutations.has(tool)) {
    if (args.metadatas.some((metadata: any) => metadata.sqlite_id === targetId && metadata.doc_type === docType)) targetMutations++;
    // The server already completed this mutation. Only its response is held,
    // so the interleaving also works with Chroma's single-request server.
    if (pause && args.metadatas.some((metadata: any) => metadata.sqlite_id === blockerId && metadata.doc_type === docType)) {
      pause = false;
      reached();
      await gate;
    }
  }
  return result;
};

const body = (name: string, current: boolean, split = false) => ({
  memory_session_id: 'remote-memory', content_session_id: 'remote-host', project,
  type: 'discovery', title: name, platform_source: 'claude', prompt_number: 1, created_at_epoch: 1_800_000_000_000,
  narrative: current ? 'Deploy to the new green cluster.' : 'Deploy to the retired blue cluster.',
  request: current ? 'Deploy to the new green cluster.' : 'Deploy to the retired blue cluster.',
  learned: current ? 'Use the new green cluster.' : 'Use the retired blue cluster.',
  notes: current ? null : 'Use obsolete credential.',
  facts: JSON.stringify(current ? [] : Array.from({ length: split ? 101 : 1 }, (_, index) => `Use obsolete credential ${index}.`)),
  prompt_text: current ? 'Deploy to the new green cluster.' : 'Deploy to the retired blue cluster.',
  concepts: '[]', files_read: '[]', files_modified: '[]',
});
const op = (seq: number, origin: string, rev: number, content: any) => ({
  seq: String(seq), rev: String(rev), kind, origin_device: 'remote-device',
  origin_id: origin, body: JSON.stringify(content), server_ts: Date.now(),
});
// Only waits for existing fire-and-forget jobs; assertions concern durable
// rows, projected content, pending recovery and unrelated-row progress.
const drainForwards = (apply: any) => Promise.allSettled([...apply.chromaWrites.values()]);
const documents = async (id: number) => {
  if (!live) return [...indexed].filter(([, value]) => value.metadata.sqlite_id === id && value.metadata.doc_type === docType)
    .map(([id, value]) => ({ id, document: value.document, metadata: value.metadata }));
  const result = await realCall('chroma_get_documents', {
    collection_name: sync.getCollectionName(), where: { sqlite_id: id }, include: ['documents', 'metadatas'],
  }) as any;
  return result.ids.flatMap((documentId: string, index: number) => result.metadatas[index].doc_type === docType
    ? [{ id: documentId, document: result.documents[index], metadata: result.metadatas[index] }] : []);
};
const currentRow = (id: number) => kind === 'prompt'
  ? store.db.query(`SELECT up.*, s.project FROM user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id WHERE up.id = ?`).get(id)
  : store.db.query(`SELECT * FROM ${table} WHERE id = ?`).get(id);
try {
  if (restart) {
    targetId = store.db.prepare(`SELECT id FROM ${table} WHERE origin_local_id = '2'`).get().id;
    const targetProject = rehome ? movedProject : project;
    const outcome = await sync.ensureBackfilled(targetProject, store);
    console.log(JSON.stringify({ outcome, documents: await documents(targetId), targetMutations,
      row: currentRow(targetId), pending: ChromaSyncState.getPending(targetProject, checkpointKind) }));
  } else if (schedule === 'orphan-prompt') {
    const apply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: sync });
    apply.applyOps([op(1, '2', 1, { ...body('Unlinked Codex prompt', true),
      memory_session_id: null, project: 'unknown', platform_source: 'codex' })]);
    await drainForwards(apply);
    targetId = store.db.query(`SELECT id FROM ${table} WHERE origin_local_id = '2'`).get().id;
    console.log(JSON.stringify({ documents: await documents(targetId),
      row: store.db.query(`SELECT * FROM ${table} WHERE id = ?`).get(targetId) }));
  } else if (rehome) {
    // One production SyncApply: revisions may wait in its own queue, or have
    // reached ChromaSync and be waiting for the shared row writer.
    const apply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: liveSync });
    let backfill: Promise<string>;
    pause = schedule === 'queued-rehome';
    apply.applyOps([op(1, '2', 1, body('Deployment runbook', false))]);
    targetId = store.db.query(`SELECT id FROM ${table} WHERE origin_local_id = '2'`).get().id;
    blockerId = targetId;
    if (pause) await blocked;
    else await drainForwards(apply);
    apply.applyOps([op(2, '3', 1, { ...body('Already indexed in the destination', true),
      memory_session_id: 'destination-memory', content_session_id: 'destination-host', project: movedProject })]);
    const destinationId = store.db.query(`SELECT id FROM ${table} WHERE origin_local_id = '3'`).get().id;
    await apply.chromaWrites.get(`${kind}:${destinationId}`);
    if (schedule === 'waiting-rehome') {
      ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0 });
      pause = true;
      backfill = sync.ensureBackfilled(project, store);
      await blocked;
    }
    // Observe callback entry without waiting for the writer's held response.
    const method = kind === 'summary' ? 'syncSummary' : kind === 'prompt' ? 'syncUserPrompt' : 'syncObservation';
    const forward = liveSync[method].bind(liveSync);
    let forwardStarted!: () => void;
    const entered = new Promise<void>(resolve => { forwardStarted = resolve; });
    liveSync[method] = (...args: any[]) => { const work = forward(...args); forwardStarted(); return work; };
    apply.applyOps([op(3, '2', 2, body('Deployment runbook', true))]);
    if (schedule === 'waiting-rehome') await entered;
    apply.applyOps([{ ...op(4, 'remap', 3, {}), kind: 'mutation', body: JSON.stringify({
      op: 'remap_project', where: { project, memory_session_id: 'remote-memory' }, fields: { project: movedProject },
    }) }]);
    if (schedule === 'queued-rehome') {
      ChromaSyncState.replace(movedProject, { observations: 0, summaries: 0, prompts: 0 });
      let started!: () => void;
      const backfillEntered = new Promise<void>(resolve => { started = resolve; });
      const runKind = sync.backfillKind.bind(sync);
      sync.backfillKind = (...args: any[]) => { const work = runKind(...args); started(); return work; };
      backfill = sync.ensureBackfilled(movedProject, store);
      await backfillEntered;
    }
    release();
    const [outcome] = await Promise.all([backfill!, drainForwards(apply)]);
    console.log(JSON.stringify({ outcome, targetId, row: currentRow(targetId), documents: await documents(targetId),
      pending: ChromaSyncState.getPending(movedProject, checkpointKind) }));
  } else {
    const apply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: sync });
    const revisionApply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: liveSync });
    const unrelatedApply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: new ChromaSync('claude-mem') });
    apply.applyOps([op(1, '1', 1, body('Other memory', false)), op(2, '2', 1, body('Deployment runbook', false, schedule === 'during-row'))]);
    await drainForwards(apply);
    const rows = store.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all();
    targetId = rows[1].id;
    blockerId = schedule === 'during-row' ? targetId : rows[0].id;
    ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0 });
    pause = true;
    targetMutations = 0;
    const backfill = sync.ensureBackfilled(project, store);
    await blocked;
    failWrites = failRevision;
    failLookup = throwLookup;
    revisionApply.applyOps([op(3, '2', 2, body('Deployment runbook', true))]);
    let revisionFinished = false;
    let rejectedForwards = 0;
    const revisionDone = drainForwards(revisionApply).then(results => {
      rejectedForwards = results.filter(result => result.status === 'rejected').length;
      revisionFinished = true;
    });
    unrelatedApply.applyOps([op(4, '3', 1, body('Unrelated live memory', true))]);
    await drainForwards(unrelatedApply);
    const unrelatedId = store.db.prepare(`SELECT id FROM ${table} WHERE origin_local_id = '3'`).get().id;
    const unrelatedProgressed = (await documents(unrelatedId)).length > 0;
    if (schedule === 'before-turn') await revisionDone;
    const revisionFinishedBeforeRelease = revisionFinished;
    release();
    const [outcome] = await Promise.all([backfill, revisionDone]);
    if (throwLookup) {
      // A thrown cleanup must release the writer for the next same-row job,
      // including one queued by the same SyncApply instance.
      revisionApply.applyOps([op(5, '2', 3, body('Deployment runbook', true))]);
      await drainForwards(revisionApply);
    }
    const row = store.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(targetId);
    console.log(JSON.stringify({ outcome, targetId, documents: await documents(targetId), row,
      pending: ChromaSyncState.getPending(project, checkpointKind), unrelatedProgressed, revisionFinishedBeforeRelease, rejectedForwards }));
  }
} finally {
  release();
  if (!live) writeFileSync(indexPath, JSON.stringify([...indexed]));
  store.close();
  if (live) await manager.stop();
}
