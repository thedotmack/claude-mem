import { createHash } from 'node:crypto';
import { canonicalJson } from '../sync/CanonicalContent.js';
import { readEvidence } from './agent-view.mjs';
import { stableEvidenceRef, resolveEvidenceRef, sharedProjectKey, sharedPublishedUrl, isSharedProjectionValue } from './shared-projection.mjs';
import { publishSharedRecords, readSharedRecords } from './shared-record-store.mjs';
import { sharedRecordKey } from './shared-records.mjs';
import { SHARED_REVIEW_KIND, SHARED_REVIEW_VERSION, isSharedReviewValue } from './shared-review-value.mjs';
import { groupIdFor } from './request-groups.mjs';

export { SHARED_REVIEW_KIND, SHARED_REVIEW_VERSION, isSharedReviewValue } from './shared-review-value.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const SOURCE_KINDS = { 'user-prompt': 'prompt', 'session-summary-request': 'summary', 'session-summary': 'summary', 'session-initial-request': 'session', 'work-state': 'work-state', observation: 'observation' };
const REPLICATED_KINDS = new Set(['prompt', 'observation', 'summary', 'work-state', 'session']);
// Only viewer/DB envelopes use these lookup fields. User work-state payloads
// use semanticJson below and never inherit this metadata filter.
const ENVELOPE_OMIT = new Set(['id', 'sourceId', 'sourceIdentity', 'stableIdentity', 'identity', 'urlRef', 'fileUrlRef',
  'path', 'bucketPath', 'sourcePath', 'bucket_path', 'source_path', 'toolUseId', 'linkedEntryId',
  'filePath', 'file_path', 'absolutePath', 'cwd', 'workingDirectory', 'working_directory',
  'files_modified', 'files_read', 'files_written', 'filesModified', 'filesRead', 'filesWritten',
  'sessionId', 'session_db_id', 'agentSessionId', 'memory_session_id', 'sourceContentHashes',
  'contentFingerprint', 'review', 'humanCopy', 'sharedHumanCopy', 'sharedHumanCopyDisabled',
  'shared', 'available', 'inCurrentScope', 'identityEvidence', 'match']);
const ENVELOPE_CHILDREN = new Set(['original', 'request', 'scopeUpdates', 'items', 'lifecycle', 'afterShip', 'shipEstimate',
  'nextStep', 'outcome', 'progress', 'evidence', 'sourceRefs', 'sourceRef', 'activity', 'requestedBySource',
  'shipEstimateSource', 'stageSource', 'requestStatusSource', 'requestCompleteSource']);
const compare = (left, right) => { const a = canonicalJson(left), b = canonicalJson(right); return a === b ? 0 : a < b ? -1 : 1; };
const validator = (kind, key, value, deleted, writer) => kind === SHARED_REVIEW_KIND
  ? isSharedReviewValue(kind, key, value, deleted) : isSharedProjectionValue(kind, key, value, deleted, writer);

function sessionIdentity(database, id) {
  try {
    const row = database.prepare('SELECT platform_source, content_session_id FROM sdk_sessions WHERE id = ?').get(id);
    return row?.platform_source && row?.content_session_id ? JSON.stringify(['conversation', row.platform_source, row.content_session_id]) : null;
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return null;
    throw error;
  }
}

/** The same stable identity whether a session is native or a replica stub. */
export function sharedReviewRequestId(request, originalRef = null) {
  const identity = request.groupId ? ['group', request.groupId]
    : request.explicitRequestId ? ['explicit', request.explicitRequestId, [...new Set((request.projects ?? []).map(sharedProjectKey).filter(Boolean))].sort()]
    : ['request', request.conversationKey ?? null, [...(request.conversationKeys ?? [])].sort(), request.original?.promptNumber ?? null, originalRef];
  return `sr2_${digest(identity)}`;
}

/**
 * Fingerprint the full replicated evidence, with the same source disclosure
 * coverage as review-store.ts. Local lookup numbers/URLs are replaced by
 * stable origin identities. Raw tool bodies have never been fingerprinted by
 * the review store and remain outside the shared-memory contract.
 */
export function sharedReviewDescriptor(database, request, { deviceId, sharedState = null, evidenceRows = new Map() } = {}) {
  if (!request || typeof request !== 'object' || !deviceId) throw new TypeError('Shared review requires a request and device identity');
  const refs = new Map(), missing = new Set();
  const evidenceRow = (kind, id) => {
    const key = `${kind}:${id}`;
    if (!evidenceRows.has(key)) evidenceRows.set(key, readEvidence(database, kind, id));
    return evidenceRows.get(key);
  };
  const remember = ref => {
    if (ref && REPLICATED_KINDS.has(ref.kind)) refs.set(canonicalJson(ref), ref);
    return ref;
  };
  const refFor = value => {
    if (!value || typeof value !== 'object') return null;
    const given = value.stableIdentity ?? value.sourceIdentity ?? value.identity;
    if (given?.kind && REPLICATED_KINDS.has(given.kind)) return remember(given);
    const kind = SOURCE_KINDS[value.source] ?? value.kind;
    const id = value.sourceId ?? value.id;
    if (!REPLICATED_KINDS.has(kind) || id == null || !/^\d+$/.test(String(id))) return null;
    const ref = stableEvidenceRef(database, kind, id, deviceId);
    if (!ref) missing.add(`${kind}:unresolved`);
    return remember(ref);
  };
  const agent = value => {
    if (typeof value !== 'string') return value ?? null;
    let parts;
    try { parts = JSON.parse(value); } catch { return value; }
    if (!Array.isArray(parts)) return value;
    if (parts[0] === 'session' && parts.length >= 4) {
      const conversation = sessionIdentity(database, parts[2]);
      if (!conversation) { missing.add('agent:unresolved'); return null; }
      return ['agent', conversation, parts[3] ?? null];
    }
    if (parts[0] === 'request' && parts.length >= 4) {
      const conversation = sessionIdentity(database, parts[2]);
      if (!conversation) { missing.add('request:unresolved'); return null; }
      return ['request', conversation, parts[3]];
    }
    return value;
  };
  const semanticJson = (value, depth = 0) => {
    if (depth > 48) { missing.add('evidence:unsupported-depth'); return null; }
    if (value == null || typeof value !== 'object') return value ?? null;
    if (Array.isArray(value)) return value.map(item => semanticJson(item, depth + 1));
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, semanticJson(item, depth + 1)]));
  };
  const productMeaning = product => {
    if (!product || typeof product !== 'object') return semanticJson(product);
    const url = sharedPublishedUrl(product.url);
    if ((product.path || product.bucketPath || product.availability === 'origin-only') && !product.productId) missing.add('product:unresolved');
    return { kind: product.kind ?? null, title: product.title ?? null, url: url ?? null,
      productId: product.productId ?? null, originDeviceId: product.productId ? product.originDeviceId ?? null : null,
      sha: product.sha ?? null, branch: product.branch ?? null, repo: product.repo ?? null,
      heads: Array.isArray(product.heads) ? semanticJson(product.heads).sort(compare) : product.heads ?? null,
      atEpoch: product.atEpoch ?? null };
  };
  const normalize = (value, field = '', depth = 0) => {
    if (depth > 48) { missing.add('evidence:unsupported-depth'); return null; }
    if (value == null) return null;
    if (typeof value !== 'object') {
      if (field === 'agentId' || field === 'agentIds' || field === 'key' || field === 'requestKey' || field === 'promptRequestKey') return agent(value);
      if (field === 'project' || field === 'projectRoot') return sharedProjectKey(value);
      return value;
    }
    if (Array.isArray(value)) {
      const result = value.filter(item => item?.kind !== 'tool-use').map(item => normalize(item, field, depth + 1));
      return ['sourceRefs', 'agentIds', 'projects'].includes(field) ? result.sort(compare) : result;
    }
    const ref = refFor(value);
    const result = ref ? { ref } : {};
    for (const [key, item] of Object.entries(value)) {
      if (ENVELOPE_OMIT.has(key) || item === undefined) continue;
      if (key === 'attribution') {
        result.attribution = { agentId: item?.agentId ?? null, meaning: item?.meaning ?? null };
        continue;
      }
      if (key === 'url' || key === 'fileUrl') {
        const match = typeof item === 'string' && /^\/api\/work-view\/evidence\/([\w-]+)\/(\d+)$/.exec(item);
        if (match && REPLICATED_KINDS.has(match[1])) {
          const identity = remember(stableEvidenceRef(database, match[1], match[2], deviceId));
          if (identity) result.ref ??= identity;
          else missing.add(`${match[1]}:unresolved`);
        } else if (sharedPublishedUrl(item)) result[key] = item;
        continue;
      }
      result[key] = key === 'workProduct' ? (item ?? []).map(productMeaning).sort(compare)
        : key === 'fields' ? semanticJson(item, depth + 1)
        : item && typeof item === 'object' && !ENVELOPE_CHILDREN.has(key) ? semanticJson(item, depth + 1)
        : normalize(item, key, depth + 1);
    }
    return result;
  };

  // Do not trust the existing sourceContentHashes: they deliberately contain
  // the native row id. Re-read full evidence and hash its portable meaning.
  for (const ref of request.sourceContentHashes ?? []) refFor(ref);
  const selected = {};
  for (const key of ['original', 'explicitRequestText', 'scopeUpdates', 'projects', 'agentIds', 'items', 'lifecycle', 'afterShip', 'shipEstimate', 'stageSourceText']) {
    selected[key] = key === 'projects' && Array.isArray(request[key])
      ? [...new Set(request[key].map(sharedProjectKey).filter(Boolean))].sort(compare) : normalize(request[key], key);
  }
  selected.workProduct = (request.workProduct ?? []).map(productMeaning).sort(compare);
  selected.items?.sort(compare);
  const evidence = [];
  for (const [identity, ref] of [...refs].sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1)) {
    const id = resolveEvidenceRef(database, ref, deviceId);
    if (id == null) { missing.add(identity); continue; }
    let row;
    if (ref.kind === 'session') {
      // Native session rows are not synchronized. A full stable provenance
      // session may establish this disclosure; a receiving stub never does.
      const record = sharedState?.records?.get(sharedRecordKey('provenance', ref.conversation));
      if (!record || record.deleted || !record.value?.session) { missing.add(identity); continue; }
      row = { kind: 'session', ...record.value.session };
      const native = evidenceRow('session', id);
      // A receiving stub has no opening prompt; a populated native session
      // must agree with its exported disclosure before it can be shared.
      if (native?.user_prompt && ['user_prompt', 'custom_title', 'status', 'project', 'platform_source', 'started_at_epoch']
        .some(key => (native[key] ?? null) !== (row[key] ?? null))) { missing.add(identity); continue; }
    } else {
      row = evidenceRow(ref.kind, id);
      if (!row) { missing.add(identity); continue; }
      if (ref.kind === 'work-state' && typeof row.fields === 'string') {
        try { row = { ...row, fields: JSON.parse(row.fields) }; } catch { missing.add(identity); continue; }
      }
      if (ref.kind === 'prompt') row = { ...row, conversation: sessionIdentity(database, row.session_db_id) };
    }
    // readEvidence returns a known database envelope. Every field inside the
    // work-state payload is user evidence, even when named id/path/url.
    const { id: _id, session_db_id: _sessionId, kind: _kind, ...content } = row;
    if (Object.hasOwn(content, 'project')) content.project = sharedProjectKey(content.project);
    evidence.push({ ref, hash: digest(semanticJson(content)) });
  }
  const originalRef = refFor(request.original);
  if (!request.groupId && !request.explicitRequestId && request.original?.promptNumber == null && !originalRef) missing.add('request:unresolved');
  const requestId = sharedReviewRequestId(request, originalRef);
  return { version: SHARED_REVIEW_VERSION, requestId,
    fingerprint: digest({ version: SHARED_REVIEW_VERSION, requestId, content: selected, evidence }),
    complete: missing.size === 0, missingEvidence: [...missing].sort() };
}

export function readSharedReview(sharedState, descriptor) {
  const key = sharedRecordKey(SHARED_REVIEW_KIND, descriptor.requestId);
  const record = sharedState?.records?.get(key);
  const heads = sharedState?.heads?.get(key) ?? (record ? [record] : []);
  const token = record ? digest({ version: 1, requestId: descriptor.requestId,
    heads: heads.map(head => [head.hash, head.valueHash ?? null]).sort(compare) }) : null;
  const conflict = Boolean(sharedState?.diagnostics?.conflicts?.some(value => value.kind === SHARED_REVIEW_KIND && value.key === descriptor.requestId));
  const value = record && !record.deleted && isSharedReviewValue(record.kind, record.key, record.value) ? record.value : null;
  const matches = Boolean(value && value.fingerprint === descriptor.fingerprint);
  return { checked: Boolean(descriptor.complete && !conflict && matches && value.checked),
    checkedAtEpoch: descriptor.complete && !conflict && matches && value.checked ? value.checkedAtEpoch : null,
    actor: descriptor.complete && !conflict && matches && value.checked ? 'shared-user' : null,
    available: descriptor.complete, mode: 'shared', conflict, matches,
    hash: token, recordHash: record?.hash ?? null, version: SHARED_REVIEW_VERSION, writer: record?.writer ?? null,
    ...(!descriptor.complete ? { message: 'Some recorded evidence has not arrived on this viewer. Sync it before sharing a review.' }
      : conflict ? { message: 'Two devices saved different review decisions. Read the latest evidence and choose again.' }
      : value && !matches ? { message: 'The recorded evidence changed since the shared review. Review this version again.' } : {}) };
}

export function publishSharedReview(database, { deviceId, project, descriptor, checked, expectedHash, now = Date.now() }) {
  if (!descriptor?.complete) throw new Error('Shared review cannot be saved until its complete evidence is available');
  const value = { version: SHARED_REVIEW_VERSION, requestId: descriptor.requestId,
    fingerprint: descriptor.fingerprint, checked, checkedAtEpoch: now };
  if (!isSharedReviewValue(SHARED_REVIEW_KIND, descriptor.requestId, value)) throw new TypeError('Invalid shared review');
  return database.transaction(() => {
    const current = readSharedReview(getSharedReviews(database, deviceId), descriptor);
    if (current.hash !== expectedHash) throw new Error('Shared My Work: changed since read');
    return publishSharedRecords(database, { deviceId, project, validateValue: validator, now,
      updates: [{ kind: SHARED_REVIEW_KIND, key: descriptor.requestId, value, expectedHash: current.recordHash }] });
  })();
}

export function getSharedReviews(database, deviceId, options = {}) {
  return readSharedRecords(database, { ...options, deviceId, validateValue: validator });
}

/** The displayed canonical grouping, including both groups a join may change. */
export function sharedSuggestionDescriptor(sharedState, conversationKey) {
  const records = [...(sharedState?.records?.values() ?? [])].filter(record => ['group', 'ignored'].includes(record.kind));
  const heads = records.flatMap(record => sharedState?.heads?.get(sharedRecordKey(record.kind, record.key)) ?? [record]);
  const candidates = heads.filter(record => !record.deleted && record.kind === 'group' && record.value?.suggestions?.[conversationKey]);
  if (!candidates.length) return { hash: null, conflict: false, groupKeys: [] };
  const selected = records.find(record => !record.deleted && record.kind === 'group' && record.value?.suggestions?.[conversationKey]);
  const target = selected ?? [...candidates].sort((a, b) => compare([a.key, a.hash], [b.key, b.hash]))[0];
  const groupKeys = new Set(candidates.map(record => record.key));
  groupKeys.add(groupIdFor(conversationKey));
  const members = new Set([conversationKey]);
  for (const record of candidates) for (const member of record.value.members ?? []) members.add(member);
  for (const record of heads) if (!record.deleted && record.kind === 'group' && record.value?.group?.anchor === conversationKey) {
    groupKeys.add(record.key);
    for (const member of record.value.members ?? []) members.add(member);
  }
  for (const record of heads) if (!record.deleted && record.kind === 'group' && record.value?.members?.some(member => members.has(member))) groupKeys.add(record.key);
  const claims = new Map();
  let membershipConflict = false;
  for (const record of heads) if (!record.deleted && record.kind === 'group' && groupKeys.has(record.key)) for (const member of record.value?.members ?? []) {
    if (claims.has(member) && claims.get(member) !== record.key) membershipConflict = true;
    claims.set(member, record.key);
  }
  const conflict = membershipConflict || Boolean(sharedState?.diagnostics?.conflicts?.some(entry => entry.kind === 'group' && groupKeys.has(entry.key)));
  if (!conflict && target.value.suggestions[conversationKey].status !== 'open') return { hash: null, conflict: false, groupKeys: [] };
  const bases = heads.map(record => [record.kind, record.key, record.hash, record.valueHash]).sort(compare);
  return { hash: digest({ version: 2, conversationKey, bases }), conflict, groupKeys: [...groupKeys].sort(), targetId: target.key,
    suggestion: { ...target.value.suggestions[conversationKey], conversationKey, requestId: target.key, requestTitle: target.value.group.title } };
}

/** Keep resolved lexical winners actionable until their competing heads are explicitly reconciled. */
export function sharedConflictSuggestions(sharedState) {
  const keys = new Set();
  for (const record of sharedState?.records?.values() ?? []) {
    for (const head of sharedState?.heads?.get(sharedRecordKey(record.kind, record.key)) ?? [record]) {
      if (head.kind === 'group' && !head.deleted) for (const key of Object.keys(head.value?.suggestions ?? {})) keys.add(key);
    }
  }
  return [...keys].sort().flatMap(key => {
    const descriptor = sharedSuggestionDescriptor(sharedState, key);
    return descriptor.conflict && descriptor.hash ? [{ ...descriptor.suggestion, expectedSuggestionHash: descriptor.hash, sharedConflict: true }] : [];
  });
}
