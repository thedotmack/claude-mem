import { createHash } from 'node:crypto';
import { canonicalJson, compareCanonicalDecimals } from '../sync/CanonicalContent.js';
import { buildAgentView, DEFAULT_RECENT_ACTIVITY_MS } from './agent-view.mjs';
import { projectWorkView } from './overview.js';
import { reduceWorkState } from './work-state-reduce.mjs';
import { contentFingerprint } from './review-fingerprint.js';
import { isReportedReadyForCheck } from './review-readiness.js';
import { conversationKey } from './request-projection.mjs';
import { openSuggestions, applyGroupDecisions as decideGroups } from './request-groups.mjs';
import { projectRoot } from './session-project.mjs';
import { observationMediaFromMetadata } from '../media/feed.js';
import { applySharedProjection, decorateSharedView, isSharedProjectionValue, sharedPublishedUrl } from './shared-projection.mjs';
import { foldPortableSharedRows } from './shared-record-store.mjs';
import { sharedRecordKey } from './shared-records.mjs';
import { requestEvidenceRefs } from './request-evidence-refs.mjs';
import { sharedReviewDescriptor, readSharedReview, sharedSuggestionDescriptor, sharedConflictSuggestions } from './shared-reviews.mjs';
import { createHumanCopyInput, humanCopyFingerprint, validateHumanCopy } from './human-copy.mjs';

// A read-only host has no originating device and can never claim an origin's files.
const cloudDevice = Symbol('cloud viewer');
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// A batch is emitted only when the OSS entry/manifest/commit validator accepts every member.
export function foldCloudBatch(rows) {
  const state = foldPortableSharedRows(rows, isSharedProjectionValue);
  return { members: [...state.heads.values()].flat(), pending: state.diagnostics.pending,
    invalid: state.diagnostics.invalid, unsupported: state.diagnostics.unsupported };
}

// The projection store returns the winning revision and every competing head at that revision.
function sharedState(heads, diagnostics, revision) {
  const records = new Map(), byKey = new Map(), conflicts = [];
  for (const row of heads) {
    const identity = sharedRecordKey(row.kind, row.key);
    const group = byKey.get(identity);
    if (group) group.push(row);
    else byKey.set(identity, [row]);
  }
  for (const [key, group] of byKey) {
    group.sort((a, b) => compareCanonicalDecimals(a.revision, b.revision) || compareText(a.writer, b.writer) || compareText(a.batchId, b.batchId));
    const winner = group.at(-1);
    const competing = group.filter(row => row.revision === winner.revision);
    records.set(key, winner);
    byKey.set(key, competing);
    if (new Set(competing.map(row => row.hash)).size > 1) conflicts.push({
      kind: winner.kind, key: winner.key, revision: winner.revision, writers: [...new Set(competing.map(row => row.writer))].sort(),
    });
  }
  return { records, heads: byKey, revision, diagnostics: { pending: 0, invalid: 0, unsupported: 0, ...diagnostics, conflicts } };
}

// The same disclosure columns as agent-view.mjs readEvidence; arbitrary canonical metadata never enters the UI.
const evidenceFields = {
  'work-state': ['project', 'list_name', 'fields', 'created_at_epoch'],
  prompt: ['session_db_id', 'prompt_number', 'prompt_text', 'created_at_epoch'],
  summary: ['project', 'request', 'completed', 'next_steps', 'created_at_epoch'],
  observation: ['project', 'title', 'subtitle', 'narrative', 'created_at_epoch'],
  session: ['project', 'platform_source', 'user_prompt', 'custom_title', 'status', 'started_at_epoch'],
};
// A cloud renderer has no local project-naming settings. Keep recorded remote roots intact.
function cloudRootOf(groups) {
  const roots = new Set(Object.values(groups ?? {}).map(group => group.projectRoot));
  return project => projectRoot(project, roots.has(project));
}

export function applyGroupDecisions(stored, decisions, now, options = {}) {
  return decideGroups(stored, decisions, now, { ...options, getProjectRoot: cloudRootOf(stored?.groups) });
}

const contentGroups = { observation: 'observations', summary: 'summaries', prompt: 'prompts', work_state: 'workState' };

// Observation and summary operations carry only the globally unique memory session id. A prompt
// or provenance record establishes the real platform and content conversation on a replica.
function knownMemorySessions(documents, sessionIdentities, shared) {
  const byMemory = new Map();
  for (const row of documents) if (row.kind === 'prompt' && row.content_session_id && row.memory_session_id && row.session_db_id) {
    byMemory.set(row.memory_session_id, { id: row.session_db_id, platform_source: row.platform_source || 'claude', content_session_id: row.content_session_id });
  }
  for (const session of sessionIdentities) {
    const provenance = shared.records.get(sharedRecordKey('provenance', conversationKey(session)));
    const memory = !provenance?.deleted && provenance?.value?.session?.memory_session_id;
    if (memory) byMemory.set(memory, session);
  }
  return byMemory;
}

function cloudInput(documents, sessionIdentities, shared) {
  const records = { observations: [], summaries: [], prompts: [], sessions: [], workState: [] };
  const sessions = new Map(), origins = new Map(), ids = new Map(), evidence = new Map();
  const byMemory = knownMemorySessions(documents, sessionIdentities, shared);
  let unsupported = 0;
  function register(kind, row, origin) {
    const id = row.id;
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Invalid cloud evidence ID');
    const key = kind + ':' + id;
    origins.set(key, origin);
    ids.set(canonicalJson(origin), id);
    const fields = Object.fromEntries(evidenceFields[kind].map(name => [name, row[name] ?? null]));
    evidence.set(key, { kind, id, ...fields });
  }
  for (const document of documents) {
    if (!Object.hasOwn(contentGroups, document.kind)) continue;
    // The sync protocol accepts uint64 values. Work View's dates and prompt numbering have a smaller
    // range. Do not alias two prompts by rounding or let one unrepresentable row stall this owner.
    const promptNumber = document.payload.prompt_number == null ? null : Number(document.payload.prompt_number);
    if (!Number.isFinite(new Date(document.created_at_epoch).getTime())
      || (promptNumber !== null && (!Number.isSafeInteger(promptNumber) || promptNumber < 0))) {
      unsupported++;
      continue;
    }
    const kind = document.kind === 'work_state' ? 'work-state' : document.kind;
    const linked = document.content_session_id ? null : byMemory.get(document.memory_session_id);
    const orphan = kind === 'prompt' && !document.memory_session_id && (!document.project || document.project === 'unknown');
    const sessionId = orphan ? null : linked?.id ?? document.session_db_id;
    const platform = linked?.platform_source || document.platform_source || 'claude';
    const contentId = linked?.content_session_id || document.content_session_id || document.memory_session_id;
    const row = { ...document.payload, id: document.numeric_id, session_db_id: sessionId,
      origin_device_id: document.origin_device_id, origin_local_id: document.origin_local_id,
      project: document.project, platform_source: platform, memory_session_id: document.memory_session_id,
      content_session_id: document.content_session_id || null, created_at_epoch: document.created_at_epoch };
    if (promptNumber !== null) row.prompt_number = promptNumber;
    if (kind === 'observation' && row.metadata) row.media = observationMediaFromMetadata(JSON.stringify(row.metadata));
    if (kind === 'work-state') {
      if (typeof row.list_name !== 'string') throw new TypeError('Invalid synced work-state list');
    }
    register(kind, row, { kind, device: row.origin_device_id, row: String(row.origin_local_id) });
    // Match the bounded SQL projection. The complete prompt remains available for evidence and reviews.
    if (kind === 'prompt') row.prompt_text = [...row.prompt_text].slice(0, 1200).join('');
    records[contentGroups[document.kind]].push(row);
    if (sessionId != null && contentId) {
      const previous = sessions.get(sessionId);
      // SyncApply creates a remote session stub without asserting that the agent is currently running.
      const session = previous ?? { id: sessionId, project: row.project,
        platform_source: platform, content_session_id: contentId, memory_session_id: null,
        status: 'completed', user_prompt: null, custom_title: null, started_at_epoch: row.created_at_epoch, completed_at_epoch: null };
      if (session.platform_source !== platform || session.content_session_id !== contentId) throw new TypeError('Inconsistent cloud conversation identity');
      session.started_at_epoch = Math.min(session.started_at_epoch, row.created_at_epoch);
      if (row.memory_session_id) session.memory_session_id = row.memory_session_id;
      sessions.set(session.id, session);
    }
  }
  // A synced group can carry a native opening/session disclosure before any ordinary document arrives.
  // Keep the durable session number from the projector so evidence URLs, review identities and drawer IDs agree.
  for (const session of sessionIdentities) {
    const existing = sessions.get(session.id);
    if (existing && conversationKey(existing) !== conversationKey(session)) throw new TypeError('Inconsistent cloud conversation identity');
    if (!existing) sessions.set(session.id, session);
  }
  const registerSession = session => register('session', session, { kind: 'session', conversation: conversationKey(session) });
  for (const session of sessions.values()) {
    registerSession(session);
    records.sessions.push(session);
  }
  // Match native SQLite ordering for latest-first request matching; retain full evidence for fingerprinting.
  for (const key of ['observations', 'summaries', 'prompts']) records[key].sort((a, b) => b.created_at_epoch - a.created_at_epoch || b.id - a.id);
  records.productObservations = records.observations;
  const lookup = {
    stableEvidenceRef: (kind, id) => origins.get(kind + ':' + id) ?? null,
    resolveEvidenceRef: ref => ids.get(canonicalJson(ref)) ?? null,
    readEvidence: (kind, id) => evidence.get(kind + ':' + id) ?? null,
  };
  return { records, lookup, evidence, registerSession, unsupported };
}

function sharedCopyFor(request) {
  const entry = request.sharedHumanCopy;
  if (!entry || request.sharedHumanCopyDisabled) return { state: 'unavailable' };
  try {
    const input = createHumanCopyInput(request);
    if (entry.fingerprint !== humanCopyFingerprint(input)) return { state: 'unavailable' };
    const copy = validateHumanCopy(entry.copy, input);
    const streams = new Map(request.workstreams.map(stream => [stream.stableId ?? stream.id, stream.id]));
    return { ...copy, state: 'current', generatedAt: entry.generatedAt,
      workstreams: copy.workstreams.map(stream => ({ ...stream, id: streams.get(stream.id) ?? stream.id })) };
  } catch { return { state: 'unavailable' }; }
}

export function renderCloudWorkView({ now, revision, documents = [], sessions = [], sharedHeads = [], diagnostics = {} }) {
  const shared = sharedState(sharedHeads, diagnostics, String(revision));
  const { records, lookup, evidence, registerSession, unsupported } = cloudInput(documents, sessions, shared);
  shared.diagnostics.unsupported += unsupported;
  const state = reduceWorkState(records.workState, { currentProject: '', localDeviceId: cloudDevice });
  const applied = applySharedProjection(lookup, shared, { records, deviceId: cloudDevice });
  // Rich provenance may supply the original session disclosure after the stub was indexed.
  for (const session of applied.records.sessions) if (Number.isSafeInteger(session.id)) registerSession(session);
  const view = decorateSharedView(buildAgentView(state, applied.records, { now, ledger: applied.ledger, localFiles: false, getProjectRoot: cloudRootOf(applied.ledger.groups.groups) }),
    { ...applied, database: lookup, deviceId: cloudDevice });
  const suggestions = new Map(openSuggestions(applied.ledger).map(s => [s.conversationKey, s]));
  for (const s of sharedConflictSuggestions(shared)) suggestions.set(s.conversationKey, s);
  const suggestionDescriptors = Object.create(null);
  for (const [key, item] of suggestions) {
    const descriptor = sharedSuggestionDescriptor(shared, key);
    suggestionDescriptors[key] = descriptor;
    suggestions.set(key, { ...item, expectedSuggestionHash: descriptor.hash, sharedConflict: descriptor.conflict });
  }
  const requests = [];
  const disclosed = new Map();
  for (const request of view.humanRequests) {
    request.sourceContentHashes = [...requestEvidenceRefs(request)].sort(([a], [b]) => a.localeCompare(b)).map(([key, ref]) => {
      const row = evidence.get(key);
      if (row) disclosed.set(key, { kind: ref.kind, id: ref.id, value: row });
      return { ...ref, hash: createHash('sha256').update(JSON.stringify(row ?? null)).digest('hex') };
    });
    const descriptor = sharedReviewDescriptor(lookup, request, { deviceId: cloudDevice, sharedState: shared, evidenceRows: evidence });
    const review = readSharedReview(shared, descriptor);
    request.contentFingerprint = descriptor.complete ? descriptor.fingerprint : contentFingerprint(request);
    request.review = review;
    request.humanCopy = sharedCopyFor(request);
    const suggestion = [...suggestions.values()].find(s => (s.sharedConflict || s.requestId !== request.groupId) && request.conversationKeys.includes(s.conversationKey));
    if (suggestion) request.suggestion = suggestion;
    // Only public remote products are openable; origin-only files retain their stable identity and display metadata.
    request.workProduct = request.workProduct.filter(p => !p.url || sharedPublishedUrl(p.url)).map(p => {
      const { path, bucketPath, sourcePath, fileUrl, ...product } = p;
      return product;
    });
    requests.push({ id: request.id, anchorConversationKey: request.anchorConversationKey, focusAreaId: request.focusAreaId,
      contentFingerprint: request.contentFingerprint, reviewDescriptor: descriptor, readyForCheck: isReportedReadyForCheck(request, now),
      sharedReview: { hash: review.hash, recordHash: review.recordHash, conflict: review.conflict,
        revision: shared.records.get(sharedRecordKey('review', descriptor.requestId))?.revision ?? '0' },
      originalAsk: request.original?.text ?? undefined, project: request.projects?.[0] ?? undefined });
  }
  const snapshot = { ...view, revision: String(revision), suggestions: [...suggestions.values()],
    sharedState: { revision: String(revision), ...applied.diagnostics, enabled: true }, sharedPersistenceVersion: 1,
    story: { reviews: Object.values(applied.ledger.progress), story: applied.ledger.story, groups: Object.keys(applied.ledger.groups.groups).length },
    refresh: applied.ledger.refresh, teamMode: false, source: { kind: 'claude-mem-recorded-agent-activity', connected: true,
      stale: false, lastUpdatedAt: state.lastUpdatedAt, lastCheckedAt: new Date(now).toISOString(), error: null } };
  // Use the same ownership row grouping as the clients, including an empty first visit.
  const project = state.events.find(e => e.listName === 'my-focus' || e.listName === 'my-rules')?.project ?? 'My Work';
  const editContext = { revision: String(revision), project, requests, focusAreas: view.focusAreas, savedRules: view.rules, agents: view.agents.map(
    ({ id, isSubagent, canMarkFinished, agentId, agentType, platformSource, contentSessionId, project }) =>
      ({ id, isSubagent, canMarkFinished, agentId, agentType, platformSource, contentSessionId, project })),
    groupRecords: [...shared.records.values()].filter(r => r.kind === 'group' || r.kind === 'ignored'), suggestionDescriptors };
  const { overview, details } = projectWorkView(snapshot, now);
  // The persisted read model ages between commits. The HTTP reader uses the exclusive quiet deadline.
  const agentQuietAt = Object.fromEntries(view.agents.filter(agent => agent.isSubagent && agent.presence.status === 'recent')
    .map(agent => [agent.id, Date.parse(agent.presence.lastActivityAt) + DEFAULT_RECENT_ACTIVITY_MS + 1]));
  return { overview: { ...overview, agentQuietAt }, details, editContext, evidence: [...disclosed.values()] };
}
