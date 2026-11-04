// Portable facts for My Work. Shared records carry stable origin/conversation
// identities; SQLite row numbers and local file locations stay on their device.
import { conversationKey, requestText } from './request-projection.mjs';
import { productsFromToolUse, productsFromObservation, productsFromDeliverable, mergeProducts, safeWebUrl, localProductId, servableFile, bucketFileAvailable, copyCoversSource } from './work-product.mjs';
import { createHumanCopyInput, humanCopyFingerprint, validateHumanCopy } from './human-copy.mjs';
import { isIP } from 'node:net';
import { basename } from 'node:path';
import { isSharedReviewValue } from './shared-review-value.mjs';

const TABLES = { observation: 'observations', summary: 'session_summaries', prompt: 'user_prompts', 'work-state': 'work_state_entries' };
const SOURCE_KINDS = { 'user-prompt': 'prompt', 'session-summary-request': 'summary', 'session-summary': 'summary', 'session-initial-request': 'session', 'work-state': 'work-state', observation: 'observation' };
const values = shared => [...(shared?.records?.values?.() ?? [])];
const binaryOrder = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const clean = value => value === undefined ? null : value;
const pick = (value, names) => Object.fromEntries(names.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const conversation = value => {
  try { const key = JSON.parse(value); return Array.isArray(key) && key.length === 3 && key[0] === 'conversation' && key.slice(1).every(part => typeof part === 'string' && part.length > 0); }
  catch { return false; }
};
const originRef = ref => object(ref) && Object.hasOwn(TABLES, ref.kind) && typeof ref.device === 'string' && ref.device.length > 0 && /^\d+$/.test(ref.row ?? '');

/** Shared products are published web links, never a local server or a bearer locator. */
export function sharedPublishedUrl(value) {
  const normalized = safeWebUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  // Literal addresses and single-label/internal DNS names do not establish a
  // public product. Do not resolve DNS here: projection must stay local/cheap.
  if (isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|lan|internal|home|test|invalid)$/.test(host)) return null;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (/(?:^|\/)(?:api\/(?:media|work-view|deliverables)|private)(?:\/|$)/i.test(path)
    || /\/storage\/v1\/object\/(?:sign|authenticated)(?:\/|$)/i.test(path)) return null;
  const credentialName = name => {
    // URLSearchParams has decoded the name. Split normal camel/acronym case,
    // then also compare known credential names without separators so mixed
    // casing cannot hide accessToken, APIKey or provider signing fields.
    const words = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const compact = words.replace(/_/g, '');
    return /(?:^|_)(?:token|signature|sig|credential|secret|password|key|auth|authorization|policy|expires|expiry|expiration)(?:$|_)/.test(words)
      || /^(?:xamz|xgoog|awsaccesskeyid$|googleaccessid$|accesskeyid$)/.test(compact)
      || /(?:token|signature|credential|secret|password|authorization|policy|expires|expiry|expiration|(?:api|access|private|signing|client|service|account|session)key)$/.test(compact);
  };
  const fragments = new URLSearchParams(url.hash.slice(1));
  for (const params of [url.searchParams, fragments]) for (const [name, parameter] of params) {
    if (credentialName(name) || /^(?:path|file|filename|source)$/i.test(name) && sharedProjectKey(parameter) === null) return null;
  }
  return normalized;
}

/** Project names such as org/repo are identities; explicit filesystem paths are not. */
export function sharedProjectKey(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  if (/^(?:[\\/]|~(?:[\\/]|$)|[a-z]:|\.{1,2}[\\/]|file:|\$(?:HOME|USERPROFILE)(?:[\\/]|$)|\$\{(?:HOME|USERPROFILE)\}|%(?:HOME|USERPROFILE)%)/i.test(value.trim())
    || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype', 'path', 'bucketPath', 'sourcePath', 'bucket_path', 'source_path', 'pid', 'lock', 'objectKey', 'object_key', 'tool_input', 'tool_response', 'toolInput', 'toolResponse', 'raw', 'token', 'apiKey', 'api_key', 'authorization']);
const string = (value, max = 12000) => typeof value === 'string' && value.length <= max;
const optional = (value, check) => value == null || check(value);
const date = value => string(value, 40) && Number.isFinite(Date.parse(value));
const epoch = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const list = (value, check, max = 512) => Array.isArray(value) && value.length <= max && value.every(check);
const preferenceKinds = ['directive', 'correction', 'praise', 'frustration'];
const quote = value => object(value) && string(value.quote, 4000) && optional(value.at, date);
const preference = value => object(value) && string(value.preference, 2000)
  && optional(value.kind, kind => preferenceKinds.includes(kind))
  && optional(value.quotes, quotes => list(quotes, quote, 100))
  && optional(value.quote, quote => string(quote, 4000)) && optional(value.at, date);
function safeTree(value, depth = 0) {
  if (depth > 16) return false;
  if (value == null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => safeTree(item, depth + 1));
  return object(value) && Object.entries(value).every(([key, item]) => !forbiddenKeys.has(key) && safeTree(item, depth + 1)
    && (!['url', 'fileUrl'].includes(key) || optional(item, url => Boolean(sharedPublishedUrl(url))))
    && (!['project', 'projectRoot'].includes(key) || optional(item, project => sharedProjectKey(project) !== null)));
}
const evidence = value => list(value, item => typeof item === 'string' || object(item), 100);
const outcome = value => object(value)
  && ['landed', 'usage', 'value'].every(key => optional(value[key], item => object(item) && string(item.text, 4000) && optional(item.evidence, evidence)))
  && ['regressions', 'changes'].every(key => optional(value[key], items => list(items, item => object(item) && optional(item.text, text => string(text, 4000)) && optional(item.what, text => string(text, 4000)) && optional(item.why, text => string(text, 4000)), 100)));

const gitSha = value => typeof value === 'string' && /^[a-f0-9]{7,64}$/i.test(value);
const gitBranch = value => string(value, 1024) && value.length > 0 && !value.startsWith('/') && !/[\s\\\x00-\x1f\x7f~^:?*\[]|\.\.|@\{/.test(value);
const gitRepo = value => string(value, 256) && /^[\w.-]+\/[\w.-]+$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
const sharedProduct = value => object(value) && string(value.kind, 80) && string(value.title, 2000) && optional(value.atEpoch, epoch)
  && optional(value.sha, gitSha) && optional(value.branch, gitBranch) && optional(value.repo, gitRepo)
  && optional(value.heads, heads => list(heads, gitSha, 100))
  && (value.availability === 'origin-only'
    ? /^local_[a-f0-9]{64}$/.test(value.productId ?? '') && string(value.originDeviceId, 2000) && value.originDeviceId.length > 0 && value.url == null && value.fileUrl == null
    : value.availability == null && Boolean(sharedPublishedUrl(value.url)));

/** Invalid domain values reject the complete batch before it becomes visible. */
export function isSharedProjectionValue(kind, key, value, deleted = false, writer = undefined) {
  if (kind === 'review') return isSharedReviewValue(kind, key, value, deleted);
  const groupKey = /^g_[a-f0-9]{12}$/.test(key);
  const knownKey = kind === 'group' || kind === 'progress' ? groupKey
    : kind === 'story' ? key === 'current' : ['ignored', 'provenance'].includes(kind) ? conversation(key)
    : ['refresh', 'copy', 'exclusion'].includes(kind);
  if (!knownKey) return false;
  if (writer !== undefined && kind === 'refresh' && key !== writer) return false;
  if (writer !== undefined && kind === 'exclusion') {
    let identity;
    try { identity = JSON.parse(key); } catch { return false; }
    if (!originRef(identity) || identity.kind !== 'prompt' || identity.device !== writer) return false;
  }
  if (deleted) return true;
  if (!safeTree(value)) return false;
  // Hosted extraction preserves full reasons and summaries rather than using
  // the local CLI's prose caps; the shared record's byte budget still applies.
  if (kind === 'ignored') return string(value, 48000);
  if (!object(value)) return false;
  if (kind === 'group') return object(value.group)
    && string(value.group.title, 120) && value.group.title.trim().length > 0
    && conversation(value.group.anchor) && list(value.members, conversation) && value.members.length > 0
    && new Set(value.members).size === value.members.length && value.members.includes(value.group.anchor)
    && optional(value.group.projectRoot, root => string(root, 2000)) && optional(value.group.rootNamed, root => typeof root === 'boolean')
    && optional(value.group.product, product => string(product, 48000))
    && optional(value.group.anchorAsk, ask => object(ask) && string(ask.text, 2000) && optional(ask.atEpoch, epoch))
    && optional(value.group.links, links => list(links, link => object(link) && string(link.kind, 80) && string(link.evidence, 48000) && list(link.conversations, conversation)))
    && optional(value.suggestions, suggestions => object(suggestions) && Object.entries(suggestions).every(([candidate, suggestion]) => conversation(candidate) && object(suggestion)
      && suggestion.requestId === key && optional(suggestion.confidence, score => typeof score === 'number' && score >= 0 && score <= 1)
      && optional(suggestion.evidence, evidence => string(evidence, 4000)) && optional(suggestion.status, status => ['open', 'joined', 'declined', 'dismissed'].includes(status))));
  if (kind === 'progress') return value.groupId === key
    && ['shipped', 'in-progress', 'stalled', 'abandoned', 'unknown'].includes(value.state)
    && Number.isInteger(value.percent) && value.percent >= 0 && value.percent <= 100
    && ['summary', 'narrative', 'title'].every(key => optional(value[key], text => string(text, 12000)))
    && ['startedAt', 'shippedAt', 'lastActivityAt', 'reviewedThrough', 'checkedAt', 'changedAt'].every(key => optional(value[key], date))
    && optional(value.milestones, milestones => list(milestones, item => object(item) && string(item.text, 4000) && optional(item.at, date) && optional(item.evidence, evidence), 100))
    && optional(value.preferences, preferences => list(preferences, preference, 100))
    && optional(value.readings, readings => list(readings, item => object(item) && date(item.at) && Number.isInteger(item.percent) && item.percent >= 0 && item.percent <= 100, 100))
    && optional(value.reviewedConversations, keys => list(keys, conversation)) && optional(value.coercedFields, fields => list(fields, field => string(field, 200)))
    && optional(value.evidence, evidence) && optional(value.outcome, outcome);
  if (kind === 'story') return optional(value.narrative, narrative => string(narrative, 48000)) && list(value.preferences, preference, 100)
    && optional(value.writtenAt, date) && optional(value.generatedAt, at => date(at) || epoch(at)) && optional(value.source, source => string(source, 80));
  if (kind === 'refresh') return value.originDeviceId === key && ['idle', 'running', 'ok', 'failed', 'waiting-for-agent'].includes(value.state)
    && ['reason', 'agent', 'result'].every(key => optional(value[key], text => string(text, 12000)))
    && ['startedAt', 'finishedAt', 'checkedAt'].every(key => optional(value[key], date));
  if (kind === 'exclusion') {
    let identity;
    try { identity = JSON.parse(key); } catch { return false; }
    return originRef(value.ref) && value.ref.kind === 'prompt' && ['kind', 'device', 'row'].every(field => identity?.[field] === value.ref[field])
      && (value.conversation == null || conversation(value.conversation)) && (value.opening == null || typeof value.opening === 'boolean');
  }
  if (kind === 'provenance') return conversationKey(value.session) === key && object(value.session)
    && ['project', 'platform_source', 'content_session_id', 'memory_session_id', 'custom_title', 'status'].every(key => optional(value.session[key], text => string(text, 2000)))
    && optional(value.session.user_prompt, prompt => string(prompt, 1200))
    && ['started_at_epoch', 'completed_at_epoch'].every(key => optional(value.session[key], epoch))
    && list(value.attributions, item => object(item) && originRef(item.work) && item.work.kind === 'work-state'
      && optional(item.agentId, id => string(id, 256)) && optional(item.agentType, type => string(type, 256))
      && optional(item.promptNumber, number => Number.isInteger(number) && number >= 0) && optional(item.atEpoch, epoch))
    && list(value.products, item => sharedProduct(item) && (item.availability !== 'origin-only' || writer === undefined || item.originDeviceId === writer))
    && list(value.launches, item => object(item) && string(item.agent_id, 256) && optional(item.status, status => string(status, 80))
      && optional(item.is_async, flag => typeof flag === 'boolean' || flag === 0 || flag === 1) && optional(item.description, text => string(text, 160)) && optional(item.created_at_epoch, epoch))
    && list(value.activity, item => object(item) && optional(item.agent_id, id => string(id, 256)) && optional(item.last_epoch, epoch));
  if (kind === 'copy') {
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint ?? '') || !object(value.copy) || !optional(value.generatedAt, epoch)) return false;
    try { validateHumanCopy(value.copy, { workstreams: value.copy.workstreams }); return true; } catch { return false; }
  }
  return false;
}

function get(database, sql, args) {
  try { return database.prepare(sql).get(...args); }
  catch (error) { if (/no such (table|column)/i.test(String(error.message))) return null; throw error; }
}

/** The identity's row component belongs to its origin, never the receiver. */
export function stableEvidenceRef(database, kind, id, deviceId) {
  if (id == null) return null;
  if (kind === 'session') {
    const row = get(database, 'SELECT platform_source, content_session_id FROM sdk_sessions WHERE id = ?', [id]);
    const key = conversationKey(row);
    return key ? { kind, conversation: key } : null;
  }
  const table = TABLES[kind];
  if (!table) return null;
  let row;
  try { row = database.prepare(`SELECT origin_device_id, origin_local_id FROM ${table} WHERE id = ?`).get(id); }
  catch (error) {
    if (!/no such (table|column)/i.test(String(error.message))) throw error;
    row = get(database, `SELECT id FROM ${table} WHERE id = ?`, [id]);
  }
  if (!row) return null;
  const origin = row.origin_device_id ?? deviceId;
  return origin ? { kind, device: origin, row: String(row.origin_local_id ?? id) } : null;
}

export function resolveEvidenceRef(database, ref, deviceId) {
  if (!ref || typeof ref !== 'object') return null;
  if (ref.kind === 'session') {
    let tuple;
    try { tuple = JSON.parse(ref.conversation); } catch { return null; }
    if (!Array.isArray(tuple) || tuple[0] !== 'conversation' || tuple.length !== 3) return null;
    return get(database, 'SELECT id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ? ORDER BY id LIMIT 1', tuple.slice(1))?.id ?? null;
  }
  const table = TABLES[ref.kind];
  if (!table || typeof ref.device !== 'string' || !/^\d+$/.test(ref.row ?? '')) return null;
  if (ref.device === deviceId) {
    const local = get(database, `SELECT id FROM ${table} WHERE id = ? AND origin_device_id IS NULL`, [ref.row]);
    if (local) return local.id;
  }
  return get(database, `SELECT id FROM ${table} WHERE origin_device_id = ? AND origin_local_id = ?`, [ref.device, ref.row])?.id ?? null;
}

function fileProductIdentity(database, product, deviceId) {
  if (!database) return null;
  const source = product.sourceRef;
  if (!source || !Number.isSafeInteger(source.id) || source.id < 1) return null;
  // Deliverable rows are deliberately local-only; other source rows already
  // have a canonical origin identity independent of the receiving row number.
  const ref = source.kind === 'deliverable' ? { kind: source.kind, device: deviceId, row: String(source.id) }
    : stableEvidenceRef(database, source.kind, source.id, deviceId);
  const productId = ref && localProductId({ ...ref, index: source.index ?? 0 });
  return productId ? { productId, originDeviceId: ref.device } : null;
}

function localFileMetadata(database, product, deviceId) {
  if (!product.path && !product.bucketPath) return null;
  const identity = fileProductIdentity(database, product, deviceId);
  if (!identity) return null;
  return {
    kind: product.kind, title: basename(product.path ?? product.bucketPath),
    ...identity, availability: 'origin-only', atEpoch: product.atEpoch ?? null,
  };
}

/** Recursively preserve content while replacing only typed evidence locations. */
export function portableWorkValue(database, value, deviceId) {
  if (Array.isArray(value)) return value.map(item => portableWorkValue(database, item, deviceId));
  if (!value || typeof value !== 'object') return clean(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['path', 'bucketPath', 'sourcePath', 'bucket_path', 'source_path', 'pid', 'lock', 'objectKey', 'object_key', 'tool_input', 'tool_response', 'raw', 'token', 'apiKey', 'api_key', 'authorization'].includes(key)) continue;
    if (['project', 'projectRoot'].includes(key)) {
      const project = sharedProjectKey(item);
      if (project !== null) result[key] = project;
      continue;
    }
    if (key === 'url' || key === 'fileUrl') {
      const match = typeof item === 'string' && /^\/api\/work-view\/evidence\/([\w-]+)\/(\d+)$/.exec(item);
      if (match) {
        const ref = stableEvidenceRef(database, match[1], match[2], deviceId);
        if (ref) result[`${key}Ref`] = ref;
      } else if (sharedPublishedUrl(item)) result[key] = sharedPublishedUrl(item);
      continue;
    }
    if (key === 'sourceId') {
      const ref = stableEvidenceRef(database, SOURCE_KINDS[value.source] ?? value.kind, item, deviceId);
      if (ref) result.sourceIdentity = ref;
      continue;
    }
    if (key === 'id' && TABLES[value.kind]) {
      const ref = stableEvidenceRef(database, value.kind, item, deviceId);
      if (ref) result.identity = ref;
      continue;
    }
    result[key] = portableWorkValue(database, item, deviceId);
  }
  return result;
}

export function localWorkValue(database, value, deviceId) {
  if (Array.isArray(value)) return value.map(item => localWorkValue(database, item, deviceId));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'sourceIdentity') {
      result.sourceId = resolveEvidenceRef(database, item, deviceId);
      result.sourceIdentity = item;
    } else if (key === 'identity') {
      result.id = resolveEvidenceRef(database, item, deviceId);
      result.identity = item;
    } else if (key === 'urlRef' || key === 'fileUrlRef') {
      const id = resolveEvidenceRef(database, item, deviceId);
      result[key === 'urlRef' ? 'url' : 'fileUrl'] = id == null ? null : `/api/work-view/evidence/${item.kind}/${id}`;
    } else result[key] = localWorkValue(database, item, deviceId);
  }
  return result;
}

const emptyLedger = () => ({ groups: { version: 1, updatedAt: null, conversations: {}, groups: {}, ignored: {}, suggestions: {} }, progress: {}, story: null, refresh: null, agentWrittenPromptIds: new Set() });
const sessionFields = ['project', 'platform_source', 'content_session_id', 'memory_session_id', 'user_prompt', 'custom_title', 'status', 'started_at_epoch', 'completed_at_epoch'];

/** Bounded, extracted facts: no raw tool input/response or local deliverable paths. */
export function buildSharedProjectionUpdates(database, { ledger, records = {}, view = {}, deviceId, copyEntries = {} } = {}) {
  if (!deviceId) return [];
  decorateSharedView(view, { database, deviceId, records });
  const updates = [];
  const add = (kind, key, value) => updates.push({ kind, key, value });
  for (const [id, group] of Object.entries(ledger?.groups?.groups ?? {})) {
    const members = Object.entries(ledger.groups.conversations ?? {}).filter(([, groupId]) => groupId === id).map(([key]) => key).sort();
    const suggestions = Object.fromEntries(Object.entries(ledger.groups.suggestions ?? {}).filter(([, suggestion]) => suggestion.requestId === id)
      .map(([key, value]) => [key, pick(value, ['requestId', 'confidence', 'evidence', 'judge', 'at', 'status', 'resolvedAt'])]));
    const portableGroup = pick(group, ['title', 'anchor', 'projectRoot', 'rootNamed', 'product', 'links', 'decidedAt']);
    if (group.anchorAsk) portableGroup.anchorAsk = pick(group.anchorAsk, ['text', 'source', 'sourceId', 'url', 'promptNumber', 'atEpoch']);
    add('group', id, portableWorkValue(database, { group: portableGroup, members, suggestions }, deviceId));
  }
  for (const [key, ignored] of Object.entries(ledger?.groups?.ignored ?? {})) add('ignored', key, portableWorkValue(database, ignored, deviceId));
  for (const [id, progress] of Object.entries(ledger?.progress ?? {})) add('progress', id, portableWorkValue(database, pick(progress, ['groupId', 'state', 'percent', 'startedAt', 'shippedAt', 'lastActivityAt', 'summary', 'narrative', 'milestones', 'preferences', 'outcome', 'evidence', 'reviewedThrough', 'reviewedConversations', 'coercedFields', 'checkedAt', 'changedAt', 'readings', 'title']), deviceId));
  if (ledger?.story) add('story', 'current', portableWorkValue(database, pick(ledger.story, ['narrative', 'preferences', 'writtenAt', 'generatedAt', 'source']), deviceId));
  if (ledger?.refresh) {
    const fields = ['state', 'reason', 'agent', 'result', 'startedAt', 'finishedAt', 'checkedAt'];
    add('refresh', deviceId, { originDeviceId: deviceId, ...Object.fromEntries(fields.filter(key => ledger.refresh[key] !== undefined).map(key => [key, ledger.refresh[key]])) });
  }
  for (const id of ledger?.agentWrittenPromptIds ?? []) {
    const ref = stableEvidenceRef(database, 'prompt', id, deviceId);
    const prompt = get(database, 'SELECT p.prompt_number, p.prompt_text, s.platform_source, s.content_session_id, s.user_prompt FROM user_prompts p LEFT JOIN sdk_sessions s ON s.id = p.session_db_id WHERE p.id = ?', [id]);
    if (ref && ref.device === deviceId) add('exclusion', JSON.stringify(ref), { ref, conversation: conversationKey(prompt), opening: prompt?.prompt_number === 1 || Boolean(prompt && prompt.prompt_text === prompt.user_prompt) });
  }

  const sessions = new Map((records.sessions ?? []).map(row => [row.id, row]));
  // A copied deliverable carries its conversation even when no recent memory
  // happened to load the native session into this bounded projection.
  for (const row of records.productDeliverables ?? []) {
    const key = conversationKey(row);
    if (key && ![...sessions.values()].some(session => conversationKey(session) === key)) sessions.set(`deliverable:${key}`, { ...row, id: `deliverable:${key}` });
  }
  const work = (view.agents ?? []).flatMap(agent => agent.work ?? []);
  for (const session of sessions.values()) {
    const key = conversationKey(session);
    if (!key) continue;
    const calls = (records.calls ?? []).filter(call => call.session_db_id === session.id);
    const prompts = (records.prompts ?? []).filter(prompt => prompt.session_db_id === session.id);
    const ownsPrompt = prompts.some(prompt => stableEvidenceRef(database, 'prompt', prompt.id, deviceId)?.device === deviceId);
    const ownsObservation = [...(records.observations ?? []), ...(records.productObservations ?? [])].some(row => row.memory_session_id === session.memory_session_id && stableEvidenceRef(database, 'observation', row.id, deviceId)?.device === deviceId);
    const ownsProduct = (records.productCalls ?? []).some(call => call.session_db_id === session.id)
      || (records.productDeliverables ?? []).some(row => conversationKey(row) === key);
    if (!calls.length && !ownsPrompt && !ownsObservation && !ownsProduct) continue; // A replica never re-owns imported facts.
    const attributions = work.filter(item => item.attribution?.sessionId === session.id && item.attribution?.linkedEntryId != null).flatMap(item => {
      const attribution = item.attribution;
      const call = calls.find(candidate => candidate.id === attribution.toolUseId);
      const ref = stableEvidenceRef(database, 'work-state', attribution.linkedEntryId, deviceId);
      return call && ref?.device === deviceId ? [{ work: ref, agentId: call.agent_id ?? null, agentType: call.agent_type ?? null, promptNumber: call.prompt_number ?? null, atEpoch: call.created_at_epoch }] : [];
    });
    const productCandidates = [
      ...(records.productCalls ?? []).filter(call => call.session_db_id === session.id).flatMap(productsFromToolUse),
      ...(records.productObservations ?? []).filter(row => row.memory_session_id === session.memory_session_id && stableEvidenceRef(database, 'observation', row.id, deviceId)?.device === deviceId).flatMap(productsFromObservation),
      ...(records.productDeliverables ?? []).filter(row => conversationKey(row) === key).flatMap(productsFromDeliverable),
      ...work.filter(item => item.attribution?.sessionId === session.id).flatMap(item => item.workProduct ?? []),
    ];
    const productsByIdentity = new Map();
    const copies = productCandidates.filter(product => product.deliverable && product.sourcePath);
    for (const product of mergeProducts([productCandidates], productCandidates.length)) {
      if (product.path && copies.some(copy => copy.sourcePath === product.path && copyCoversSource(copy, product.path))) continue;
      const url = sharedPublishedUrl(product.url);
      if (url) productsByIdentity.set(url, { kind: product.kind, title: product.title, url, atEpoch: product.atEpoch ?? null,
        ...Object.fromEntries(['sha', 'branch', 'repo', 'heads'].filter(key => product[key] != null).map(key => [key, product[key]])) });
      else if (product.path ? servableFile(product) : product.bucketPath ? bucketFileAvailable(product) : false) {
        const metadata = localFileMetadata(database, product, deviceId);
        if (metadata?.originDeviceId === deviceId) productsByIdentity.set(metadata.productId, metadata);
      }
    }
    const products = [...productsByIdentity.values()];
    const launches = (records.agentLaunches ?? []).filter(row => row.content_session_id === session.content_session_id && typeof row.agent_id === 'string').map(row => ({ agent_id: row.agent_id, status: row.status ?? null, is_async: row.is_async ?? null, description: typeof row.description === 'string' ? row.description.slice(0, 160) : null, created_at_epoch: row.created_at_epoch ?? null }));
    const activity = (records.agentToolActivity ?? []).filter(row => row.content_session_id === session.content_session_id).map(row => ({ agent_id: row.agent_id, last_epoch: row.last_epoch }));
    const sessionValue = Object.fromEntries(sessionFields.map(field => [field, clean(session[field])]));
    sessionValue.project = sharedProjectKey(sessionValue.project);
    const rejectedOpening = prompts.some(prompt => ledger?.agentWrittenPromptIds?.has(prompt.id) && (prompt.prompt_number === 1 || prompt.prompt_text === session.user_prompt));
    sessionValue.user_prompt = rejectedOpening ? null : requestText(session.user_prompt, 1200);
    if (typeof sessionValue.custom_title === 'string') sessionValue.custom_title = sessionValue.custom_title.slice(0, 120);
    add('provenance', key, { session: sessionValue, attributions, products, launches, activity });
  }

  for (const request of view.humanRequests ?? []) {
    const entry = copyEntries instanceof Map ? copyEntries.get(request.id) : copyEntries[request.id];
    if (!entry?.copy) continue;
    try {
      const legacyValue = value => Array.isArray(value) ? value.map(legacyValue) : object(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !['stableId', 'stableIdentity'].includes(key)).map(([key, item]) => [key, legacyValue(item)])) : value;
      const plainRequest = legacyValue(request);
      const plainInput = createHumanCopyInput(plainRequest);
      const stableInput = createHumanCopyInput(request);
      if (![humanCopyFingerprint(plainInput), humanCopyFingerprint(stableInput)].includes(entry.fingerprint)) continue;
      validateHumanCopy(entry.copy, entry.fingerprint === humanCopyFingerprint(plainInput) ? plainInput : stableInput);
      const stableById = new Map((request.workstreams ?? []).map(stream => [stream.id, stream.stableId ?? stream.id]));
      const copy = { ...entry.copy, workstreams: entry.copy.workstreams.map(stream => ({ ...stream, id: stableById.get(stream.id) ?? stream.id })) };
      validateHumanCopy(copy, stableInput);
      add('copy', request.id, { fingerprint: humanCopyFingerprint(stableInput), copy, generatedAt: entry.generatedAt ?? null });
    } catch { /* A stale/invalid local cache never becomes shared wording. */ }
  }
  return updates;
}

/** Merge only named shared objects. A device's update cannot erase unrelated state. */
export function applySharedProjection(database, shared, { ledger = null, records = {}, deviceId = '' } = {}) {
  const next = { ...emptyLedger(), ...ledger,
    groups: { ...emptyLedger().groups, ...ledger?.groups, groups: { ...ledger?.groups?.groups }, conversations: { ...ledger?.groups?.conversations }, ignored: { ...ledger?.groups?.ignored }, suggestions: { ...ledger?.groups?.suggestions } },
    progress: { ...ledger?.progress }, agentWrittenPromptIds: new Set(ledger?.agentWrittenPromptIds ?? []) };
  const copyEntries = new Map();
  const excludedOpenings = new Set();
  const merged = { ...records, sessions: [...(records.sessions ?? [])], sharedAttributions: new Map(), sharedProducts: [], agentLaunches: [...(records.agentLaunches ?? [])], agentToolActivity: [...(records.agentToolActivity ?? [])] };
  const ordered = values(shared).sort((a, b) => {
    const left = BigInt(a.revision ?? '0'), right = BigInt(b.revision ?? '0');
    return left < right ? -1 : left > right ? 1 : binaryOrder(String(a.writer), String(b.writer))
      || binaryOrder(a.kind, b.kind) || binaryOrder(a.key, b.key);
  });
  // Distinct group records may concurrently claim the same conversation.
  // Their transport keys do not conflict, but their meaning does. Keep a
  // deterministic display while surfacing every competing group explicitly.
  const claims = new Map();
  for (const record of ordered) if (record.kind === 'group' && !record.deleted && Array.isArray(record.value?.members)) {
    for (const member of record.value.members) {
      if (!claims.has(member)) claims.set(member, []);
      claims.get(member).push(record);
    }
  }
  const membershipConflicts = [...claims].filter(([, records]) => records.length > 1).map(([key, records]) => ({
    kind: 'group-membership', key, revision: records.at(-1).revision,
    writers: [...new Set(records.map(record => record.writer))].sort(binaryOrder),
    groups: records.map(record => record.key).sort(binaryOrder),
    selectedGroup: records.at(-1).key,
  })).sort((left, right) => binaryOrder(left.key, right.key));
  const diagnostics = { ...(shared?.diagnostics ?? { pending: 0, invalid: 0, unsupported: 0, conflicts: [] }),
    conflicts: [...(shared?.diagnostics?.conflicts ?? []), ...membershipConflicts], membershipConflicts };
  for (const record of ordered) {
    const value = localWorkValue(database, record.value, deviceId);
    if (record.kind === 'group') {
      for (const [key, group] of Object.entries(next.groups.conversations)) if (group === record.key) delete next.groups.conversations[key];
      for (const [key, suggestion] of Object.entries(next.groups.suggestions)) if (suggestion.requestId === record.key) delete next.groups.suggestions[key];
      if (record.deleted) delete next.groups.groups[record.key];
      else if (value?.group && Array.isArray(value.members)) {
        next.groups.groups[record.key] = value.group;
        for (const key of value.members) { next.groups.conversations[key] = record.key; delete next.groups.ignored[key]; }
        Object.assign(next.groups.suggestions, value.suggestions ?? {});
      }
    } else if (record.kind === 'progress') {
      if (record.deleted) delete next.progress[record.key]; else next.progress[record.key] = value;
    } else if (record.kind === 'ignored') {
      if (record.deleted) delete next.groups.ignored[record.key]; else next.groups.ignored[record.key] = value;
    } else if (record.kind === 'story' && record.key === 'current') next.story = record.deleted ? null : value;
    else if (record.kind === 'refresh' && record.writer !== deviceId) {
      if (record.deleted) { if (next.refresh?.originDeviceId === record.key) next.refresh = null; }
      else if (!next.refresh || !Number.isFinite(Date.parse(next.refresh.startedAt ?? next.refresh.checkedAt ?? '')) || Date.parse(value.finishedAt ?? value.checkedAt ?? value.startedAt ?? '') > Date.parse(next.refresh.finishedAt ?? next.refresh.checkedAt ?? next.refresh.startedAt ?? '')) next.refresh = value;
    } else if (record.kind === 'exclusion') {
      let ref = value?.ref;
      if (!ref) { try { ref = JSON.parse(record.key); } catch { /* Invalid keys are rejected before activation. */ } }
      const id = resolveEvidenceRef(database, ref, deviceId);
      if (id != null) { if (record.deleted) next.agentWrittenPromptIds.delete(id); else next.agentWrittenPromptIds.add(id); }
      if (!record.deleted && value?.opening && value.conversation) excludedOpenings.add(value.conversation);
    } else if (record.kind === 'copy') copyEntries.set(record.key, record.deleted ? { deleted: true } : value);
    else if (record.kind === 'provenance' && !record.deleted && value?.session) {
      const key = conversationKey(value.session);
      if (key !== record.key) continue;
      let session = merged.sessions.find(row => conversationKey(row) === key);
      if (session) session = record.writer === deviceId ? { ...value.session, ...session } : { ...session, ...value.session };
      else session = { ...value.session, id: `shared:${key}`, sharedOnly: true };
      merged.sessions = merged.sessions.filter(row => conversationKey(row) !== key);
      merged.sessions.push(session);
      for (const attribution of value.attributions ?? []) {
        const id = resolveEvidenceRef(database, attribution.work, deviceId);
        if (id != null) merged.sharedAttributions.set(id, { ...attribution, session_db_id: session.id, memory_session_id: session.memory_session_id, content_session_id: session.content_session_id, agent_id: attribution.agentId, agent_type: attribution.agentType, prompt_number: attribution.promptNumber, created_at_epoch: attribution.atEpoch, shared: true });
      }
      merged.sharedProducts.push({ conversationKey: key, products: (value.products ?? []).filter(product => sharedProduct(product)
        && (product.availability !== 'origin-only' || product.originDeviceId === record.writer)) });
      for (const launch of value.launches ?? []) if (!merged.agentLaunches.some(row => row.content_session_id === session.content_session_id && row.agent_id === launch.agent_id)) merged.agentLaunches.push({ ...launch, content_session_id: session.content_session_id, shared: true });
      for (const activity of value.activity ?? []) if (!merged.agentToolActivity.some(row => row.content_session_id === session.content_session_id && row.agent_id === activity.agent_id)) merged.agentToolActivity.push({ ...activity, content_session_id: session.content_session_id });
    }
  }
  const referencedGroups = new Set(Object.values(next.groups.conversations));
  for (const groupId of Object.keys(next.groups.groups)) if (!referencedGroups.has(groupId)) delete next.groups.groups[groupId];
  for (const session of merged.sessions) if ((merged.prompts ?? []).some(prompt => prompt.session_db_id === session.id && next.agentWrittenPromptIds.has(prompt.id) && (prompt.prompt_number === 1 || prompt.prompt_text === session.user_prompt))) excludedOpenings.add(conversationKey(session));
  merged.sessions = merged.sessions.map(session => excludedOpenings.has(conversationKey(session)) ? { ...session, user_prompt: null } : session);
  merged.prompts = (merged.prompts ?? []).filter(prompt => !next.agentWrittenPromptIds.has(prompt.id));
  return { ledger: next, records: merged, copyEntries, diagnostics };
}

/** Stable stream names affect copy fingerprints, while UI ids remain local. */
export function decorateSharedView(view, { database = null, deviceId = '', records = {}, copyEntries = new Map() } = {}) {
  const agents = new Map((view.agents ?? []).map(agent => [agent.id, agent]));
  const identity = value => {
    if (!value || !database) return;
    const kind = SOURCE_KINDS[value.source] ?? value.kind;
    value.stableIdentity = value.sourceIdentity ?? value.identity ?? stableEvidenceRef(database, kind, value.sourceId ?? value.id, deviceId);
  };
  for (const request of view.humanRequests ?? []) {
    const products = new Map();
    for (const product of request.workProduct ?? []) {
      let next = product;
      if (product.path || product.bucketPath) {
        const metadata = localFileMetadata(database, product, deviceId);
        if (metadata) next = metadata.originDeviceId === deviceId
          ? { ...product, productId: metadata.productId, originDeviceId: deviceId }
          : { ...metadata, available: false };
      } else if (product.availability === 'origin-only') next = { ...product, url: undefined, fileUrl: undefined, available: false };
      const key = next.productId ?? next.url ?? next.path ?? `${next.kind}:${next.title}`;
      const previous = products.get(key);
      // The origin's actual local row remains openable; the shared placeholder
      // is only a declaration that another computer cannot serve that file.
      if (!previous || previous.availability === 'origin-only' && next.availability !== 'origin-only') products.set(key, next);
    }
    request.workProduct = [...products.values()];
    identity(request.original);
    for (const update of request.scopeUpdates ?? []) identity(Object.assign(update, { source: 'user-prompt' }));
    for (const stream of request.workstreams ?? []) {
      if (stream.id === stream.items?.[0]?.listId) stream.stableId = stream.id;
      else {
        const agent = agents.get(stream.agentIds?.[0]);
        stream.stableId = JSON.stringify(['agent-session', agent?.platformSource ?? '', agent?.contentSessionId ?? '', agent?.agentId ?? '']);
      }
      for (const item of stream.items ?? []) for (const ref of item.sourceRefs ?? []) identity(ref);
      for (const activity of stream.activity ?? []) identity(activity.sourceRef);
    }
    const copy = copyEntries.get(request.id);
    if (copy?.deleted) request.sharedHumanCopyDisabled = true;
    else if (copy) request.sharedHumanCopy = copy;
  }
  return view;
}
