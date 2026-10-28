// A read-only projection of recorded work and observation activity. A captured
// tool call establishes its author, never the assignee or live presence.
import { buildHumanRequests } from './request-projection.mjs';
import { goalKindOf, OWNER_GOALS_LIST, isOwnerGoalsList } from './owner-goals.mjs';
import { buildRules, isMyRulesList } from './my-rules.mjs';
import { buildFocusAreas, isMyFocusList, placeRequests } from './my-focus.mjs';
import { isWorkProductField, productsFromFields, readProductRecords } from './work-product.mjs';
import { agentStopFor, isAgentLifecycleList, readAgentStops } from './agent-lifecycle.mjs';
import { withDerivedProjects } from './session-project.mjs';
const PROJECT_KEY = (value) => String(value ?? '').replace(/[A-Z]/g, (c) => c.toLowerCase());
const CLOSED = new Set(['done', 'dropped', 'completed', 'failed']);
const PLATFORMS = { codex: 'Codex', claude: 'Claude Code', 'gemini-cli': 'Gemini CLI', kimi: 'Kimi', 'hermes-cli': 'Hermes', 'pi-agent': 'Pi' };
const stamp = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value)).toISOString() : null;
const fingerprint = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const callKey = (project, list, fields) => JSON.stringify([PROJECT_KEY(project), list, fingerprint(fields)]);
const agentKey = (platform, session, agent) => JSON.stringify(['session', platform ?? 'unknown', String(session ?? ''), agent ?? 'unidentified']);

export function compactText(value, max = 260) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text : null;
}

function fieldText(fields, names, max = 260) {
  for (const name of names) {
    if (typeof fields?.[name] !== 'string') continue;
    const text = compactText(fields?.[name], max);
    if (text && /^(?:true|false|null|undefined|[-+]?\d+(?:\.\d+)?)$/i.test(text)) continue;
    if (text) return { text, source: 'work-state-field', field: name };
  }
  return null;
}

// Hide known runtime envelopes from display text. Their exact raw text remains
// available through the evidence endpoint; it is not a human request summary.
export function readableRequest(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<(environment_context|instructions|system-reminder|turn_aborted|permissions|collaboration_mode|skills_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/^\s*#\s*AGENTS\.md instructions[^\n]*(?:\n|$)/gim, ' ')
    .trim();
  if (!text || /^\s*(?:<\/?(?:environment_context|instructions|system-reminder)\b|You are (?:Codex|an AI)\b)/i.test(text)) return null;
  return compactText(text, 500);
}

function confirmedRequestKey(session, number) {
  if (!session || !Number.isInteger(Number(number)) || Number(number) < 0 || number == null) return null;
  return JSON.stringify(['request', session.platform_source ?? 'unknown', String(session.id), Number(number)]);
}

function safeRead(database, sql, params = []) {
  try { return database.prepare(sql).all(...params); }
  catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return [];
    throw error;
  }
}

export function activitySignature(database) {
  const heads = ['observations', 'session_summaries', 'tool_uses', 'user_prompts'].map((table) => {
    const row = safeRead(database, `SELECT MAX(id) AS id, COUNT(*) AS count FROM ${table}`)[0];
    return `${table}:${row?.id ?? 0}:${row?.count ?? 0}`;
  });
  const sessions = safeRead(database, `SELECT MAX(id) AS id, COUNT(*) AS count, MAX(completed_at_epoch) AS completed,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM sdk_sessions`)[0];
  heads.push(`sessions:${sessions?.id ?? 0}:${sessions?.count ?? 0}:${sessions?.completed ?? 0}:${sessions?.active ?? 0}`);
  // This reader never writes. SQLite's connection-local data_version changes
  // when another connection commits, including edits that keep row IDs/counts.
  const version = safeRead(database, 'PRAGMA data_version')[0]?.data_version ?? 0;
  heads.push(`data:${version}`);
  return heads.join('|');
}

// Bounds are deliberate: observers can have years of history. Full legacy
// work-state history remains on /api/state; this view only needs a recent slice.
// Request cards come from prompts, so the conversations a ledger group holds
// and conversations with a recent ask are read even before any work exists.
export const REQUEST_WINDOW_MS = 14 * 86400000;
export function readAgentRecords(database, { observationLimit = 300, summaryLimit = 100, workCallLimit = 5000, requestSessionLimit = 600, workState, ledger = null, now = Date.now() } = {}) {
  const recentWorkTimes = workState?.lists.flatMap((list) => [list.stateUpdatedAtEpoch, ...list.tasks.map((task) => task.updatedAtEpoch)]).filter(Boolean).sort((a, b) => b - a).slice(0, 240);
  const workSinceEpoch = recentWorkTimes?.length ? recentWorkTimes.at(-1) - 5000 : 0;
  const calls = safeRead(database, `SELECT id, project, platform_source, agent_id, agent_type, session_db_id, memory_session_id, content_session_id, prompt_number, tool_input, created_at_epoch
    FROM tool_uses WHERE tool_name IN (SELECT DISTINCT tool_name FROM tool_uses WHERE tool_name LIKE '%work_state_write%')
    AND created_at_epoch >= ? ORDER BY id DESC LIMIT ?`, [workSinceEpoch, workCallLimit]);
  const observations = safeRead(database, `SELECT id, project, memory_session_id, content_session_id, agent_id, agent_type, prompt_number, title, subtitle, type, created_at_epoch
    FROM observations ORDER BY created_at_epoch DESC, id DESC LIMIT ?`, [observationLimit]);
  const summaries = safeRead(database, `SELECT id, project, memory_session_id, prompt_number, request, completed, next_steps, created_at_epoch
    FROM session_summaries ORDER BY created_at_epoch DESC, id DESC LIMIT ?`, [summaryLimit]);
  const { productCalls, productObservations, productDeliverables } = readProductRecords((sql, params) => safeRead(database, sql, params), workSinceEpoch);
  const ids = [...new Set([...calls, ...productCalls].map((call) => call.session_db_id).filter((id) => id != null))];
  const memoryIds = [...new Set([...observations, ...summaries, ...productObservations].map((row) => row.memory_session_id).filter(Boolean))];
  const predicates = [], args = [];
  if (ids.length) { predicates.push(`id IN (${ids.map(() => '?')})`); args.push(...ids); }
  if (memoryIds.length) { predicates.push(`memory_session_id IN (${memoryIds.map(() => '?')})`); args.push(...memoryIds); }
  const columns = 'id, project, platform_source, content_session_id, memory_session_id, user_prompt, custom_title, status, started_at_epoch, completed_at_epoch';
  const loaded = new Map((predicates.length ? safeRead(database, `SELECT ${columns} FROM sdk_sessions WHERE ${predicates.join(' OR ')}`, args) : []).map((session) => [session.id, session]));
  const recentAsks = safeRead(database, `SELECT ${columns} FROM sdk_sessions WHERE id IN (
    SELECT session_db_id FROM user_prompts WHERE created_at_epoch >= ? GROUP BY session_db_id ORDER BY MAX(created_at_epoch) DESC LIMIT ?)`, [now - REQUEST_WINDOW_MS, requestSessionLimit]);
  const grouped = Object.keys(ledger?.groups?.conversations ?? {}).flatMap((key) => {
    try { const parsed = JSON.parse(key); return parsed?.[0] === 'conversation' && parsed.length === 3 ? [[parsed[1], parsed[2]]] : []; } catch { return []; }
  });
  const groupedSessions = [];
  for (let index = 0; index < grouped.length; index += 400) {
    const chunk = grouped.slice(index, index + 400);
    groupedSessions.push(...safeRead(database, `SELECT ${columns} FROM sdk_sessions WHERE (platform_source, content_session_id) IN (VALUES ${chunk.map(() => '(?, ?)').join(',')})`, chunk.flat()));
  }
  for (const session of [...recentAsks, ...groupedSessions]) if (!loaded.has(session.id)) loaded.set(session.id, session);
  // A session started from an agent scratch folder takes the repo its tool calls touched.
  const sessions = withDerivedProjects(database, [...loaded.values()]);
  const sessionIds = sessions.map((session) => session.id);
  const prompts = sessionIds.length ? safeRead(database, `SELECT id, session_db_id, prompt_number, substr(prompt_text, 1, 1200) AS prompt_text, created_at_epoch
    FROM user_prompts WHERE session_db_id IN (${sessionIds.map(() => '?')}) ORDER BY id DESC LIMIT 12000`, sessionIds) : [];
  // Subagent lifecycle evidence: the parent's Agent call that launched each one
  // (and, for a foreground agent, returned when it finished), and the time of
  // each subagent's latest captured tool call.
  // Only conversations whose loaded records include a subagent need it.
  const contentIds = [...new Set([...observations, ...calls].filter((row) => row.agent_id && row.content_session_id).map((row) => row.content_session_id))];
  const contentArgs = contentIds.map(() => '?').join(', ');
  // Fields are pulled out in SQL: a launch response embeds the whole prompt,
  // so a truncated copy would not parse.
  const agentLaunches = contentIds.length ? safeRead(database, `SELECT id, session_db_id, content_session_id, platform_source, prompt_number, created_at_epoch,
    json_extract(tool_response, '$.agentId') AS agent_id, json_extract(tool_response, '$.status') AS status,
    json_extract(tool_response, '$.isAsync') AS is_async,
    coalesce(json_extract(tool_input, '$.description'), json_extract(tool_response, '$.description')) AS description,
    substr(coalesce(json_extract(tool_input, '$.prompt'), json_extract(tool_response, '$.prompt')), 1, 600) AS prompt
    FROM tool_uses WHERE tool_name IN ('Agent', 'Task') AND json_valid(tool_response) AND json_valid(coalesce(tool_input, '{}'))
    AND content_session_id IN (${contentArgs}) ORDER BY id DESC LIMIT 2000`, contentIds) : [];
  const agentToolActivity = contentIds.length ? safeRead(database, `SELECT content_session_id, agent_id, MAX(created_at_epoch) AS last_epoch
    FROM tool_uses WHERE agent_id IS NOT NULL AND content_session_id IN (${contentArgs}) GROUP BY content_session_id, agent_id`, contentIds) : [];
  return { calls, observations, summaries, sessions, prompts, productCalls, productObservations, productDeliverables, agentLaunches, agentToolActivity };
}

// The parent's Agent (formerly Task) calls, by [content session, agent id].
// A foreground call's PostToolUse fires when the subagent returns, so its row
// is a recorded finish; an async launch only says the subagent started.
export function readAgentLaunches(rows) {
  const launches = new Map();
  for (const row of rows) {
    const agentId = typeof row.agent_id === 'string' && row.agent_id ? row.agent_id : null;
    if (!agentId || !row.content_session_id) continue;
    const key = JSON.stringify([row.content_session_id, agentId]);
    if (launches.has(key)) continue;
    const isAsync = row.is_async === 1 || row.is_async === true || row.status === 'async_launched';
    launches.set(key, {
      toolUseId: row.id, promptNumber: row.prompt_number ?? null, launchedAtEpoch: row.created_at_epoch,
      isAsync, returnedAtEpoch: !isAsync && row.status === 'completed' ? row.created_at_epoch : null,
      description: compactText(row.description, 160), prompt: compactText(row.prompt, 500),
    });
  }
  return launches;
}

function launchRequest(launch) {
  if (!launch) return null;
  const text = launch.description ?? launch.prompt;
  return text ? { text, source: 'agent-launch', sourceId: launch.toolUseId, url: `/api/work-view/evidence/tool-use/${launch.toolUseId}` } : null;
}

export function buildAgentView(state, records, { now = Date.now(), workLimit = 240, activityLimit = 160, recentMs = 15 * 60 * 1000, titleCache = {}, ledger = null } = {}) {
  const { calls = [], observations = [], summaries = [], sessions = [], prompts = [], agentLaunches = [], agentToolActivity = [] } = records;
  const launches = readAgentLaunches(agentLaunches);
  const lastToolEpochs = new Map(agentToolActivity.map((row) => [JSON.stringify([row.content_session_id, row.agent_id]), Number(row.last_epoch) || 0]));
  const stops = readAgentStops(state);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const sessionsByMemory = new Map(sessions.filter((session) => session.memory_session_id).map((session) => [session.memory_session_id, session]));
  const scopes = new Set(state.currentProjectScope.map(PROJECT_KEY));
  const eventsById = new Map(state.events.map((event) => [event.id, event]));
  const fieldEvents = new Map();
  for (const event of state.events) for (const field of Object.keys(event.fields)) {
    const key = JSON.stringify([event.taskId ?? event.listId, field]);
    if (!fieldEvents.has(key)) fieldEvents.set(key, event);
  }
  function recordedField(item, names, accept = (value) => typeof value === 'string' && value.trim()) {
    const found = [];
    for (const field of names) {
      const own = Object.hasOwn(item.fields, field);
      const value = own ? item.fields[field] : item.list.fields[field];
      if (!accept(value)) continue;
      const event = fieldEvents.get(JSON.stringify([own ? item.id : item.list.id, field]));
      found.push({ value, field, atEpoch: event?.atEpoch ?? item.updatedAtEpoch ?? null, sourceOrder: event?.sourceOrder ?? null, sourceRef: event ? { kind: 'work-state', id: event.id } : null });
    }
    return found.sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0));
  }
  function metadataFor(item) {
    const requester = recordedField(item, ['requested_by', 'requester', 'human_requester'])[0] ?? null;
    const estimate = recordedField(item, ['ship_estimate', 'eta', 'target_ship_at', 'due_at'])[0] ?? null;
    const stage = recordedField(item, ['stage', 'phase'])[0] ?? null;
    const resources = [];
    for (const field of ['docs_url', 'documentation_url', 'promo_url', 'announcement_url']) for (const record of recordedField(item, [field])) {
      try {
        const url = new URL(record.value.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
        resources.push({ kind: ['docs_url', 'documentation_url'].includes(field) ? 'documentation' : 'promotion', url: record.value.trim(), field, atEpoch: record.atEpoch, sourceRefs: record.sourceRef ? [record.sourceRef] : [] });
      } catch { /* A recorded non-URL is not turned into a link. */ }
    }
    const describe = (fields) => fields.flatMap((field) => recordedField(item, [field]).map((record) => ({ text: compactText(record.value, 600), field, atEpoch: record.atEpoch, sourceRefs: record.sourceRef ? [record.sourceRef] : [] })));
    const classifications = describe(['classification', 'category', 'tags']);
    const notes = describe(['post_ship', 'after_ship']);
    const status = recordedField(item, ['request_status'])[0] ?? null;
    const complete = recordedField(item, ['request_complete'], (value) => typeof value === 'boolean')[0] ?? null;
    // Each attached product points at the entry that recorded it, so a local
    // file can be served from that entry alone.
    const workProduct = Object.keys({ ...item.list.fields, ...item.fields }).filter(isWorkProductField).flatMap((field) => {
      const event = fieldEvents.get(JSON.stringify([Object.hasOwn(item.fields, field) ? item.id : item.list.id, field]));
      return event ? productsFromFields(event.fields, { atEpoch: event.atEpoch, sourceRef: { kind: 'work-state', id: event.id } }).filter((product) => product.field === field) : [];
    });
    return {
      workProduct,
      requestedBy: requester?.value.trim() ?? null, requestedBySource: requester,
      shipEstimate: estimate?.value ?? null, shipEstimateSource: estimate,
      stageSourceText: stage?.value ?? null, stageSource: stage,
      requestStatusSource: status, requestCompleteSource: complete,
      afterShip: resources.length || classifications.length || notes.length ? { resources, classifications, notes } : null,
    };
  }
  const promptsByKey = new Map();
  for (const prompt of prompts) {
    const key = JSON.stringify([prompt.session_db_id, prompt.prompt_number]);
    if (!promptsByKey.has(key)) promptsByKey.set(key, prompt);
  }
  const summaryByKey = new Map();
  for (const summary of summaries) {
    const key = JSON.stringify([summary.memory_session_id, summary.prompt_number]);
    if (!summaryByKey.has(key)) summaryByKey.set(key, summary);
  }
  const callsByKey = new Map();
  for (const call of calls) {
    let input;
    try { input = JSON.parse(call.tool_input); } catch { continue; }
    if (!input?.list || !input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) continue;
    const key = callKey(call.project, input.list, input.fields);
    if (!callsByKey.has(key)) callsByKey.set(key, []);
    callsByKey.get(key).push(call);
  }
  const groups = new Map();
  const activity = [];
  let linkedWork = 0, ownerWork = 0, unattributedWork = 0;

  function getGroup({ session, agentId = null, agentType = null, owner = null, project }) {
    const platform = session?.platform_source ?? null;
    const id = session ? agentKey(platform, session.id, agentId) : JSON.stringify([owner ? 'owner' : 'unassigned', PROJECT_KEY(project), owner, agentId]);
    if (!groups.has(id)) {
      const platformLabel = PLATFORMS[platform] ?? compactText(platform, 48) ?? 'Unassigned';
      groups.set(id, {
        id, kind: session ? 'session' : owner ? 'recorded-owner' : 'unassigned',
        label: session ? platformLabel : owner ? compactText(owner, 70) : 'Unassigned work',
        platformSource: platform, agentId, agentType,
        sessionId: session?.id ?? null, contentSessionId: session?.content_session_id ?? null,
        sessionTitle: compactText(session?.custom_title, 120), recordedSessionStatus: session?.status ?? null,
        project, projects: [project], inCurrentScope: scopes.has(PROJECT_KEY(project)),
        identityEvidence: session ? 'captured-session' : owner ? 'explicit-owner-field' : agentId ? 'recorded-agent-id' : 'no-attribution',
        presence: { status: 'unknown', isLive: null, evidence: 'recorded-activity-only', lastActivityAt: null },
        // A subagent works inside its parent's conversation; only its own
        // captured tool calls and observations are credited to it. Claude Code
        // sets agent_id only inside a subagent; other hosts (Codex) also tag
        // the main thread, so their groups keep the per-prompt layout.
        isSubagent: Boolean(session && agentId && platform === 'claude'),
        launch: session && agentId ? launches.get(JSON.stringify([session.content_session_id, agentId])) ?? null : null,
        work: [], activity: [], lastActivityEpoch: 0,
      });
    }
    const group = groups.get(id);
    if (!group.projects.includes(project)) group.projects.push(project);
    group.inCurrentScope ||= scopes.has(PROJECT_KEY(project));
    return group;
  }

  function requestFor(session, number) {
    if (!session) return null;
    const key = confirmedRequestKey(session, number);
    const prompt = promptsByKey.get(JSON.stringify([session.id, number]));
    const summary = summaryByKey.get(JSON.stringify([session.memory_session_id, number]));
    const original = prompt ? { source: 'user-prompt', sourceId: prompt.id, url: `/api/work-view/evidence/prompt/${prompt.id}` } : null;
    if (summary && readableRequest(summary.request)) return { key, text: readableRequest(summary.request), source: 'session-summary-request', sourceId: summary.id, url: `/api/work-view/evidence/summary/${summary.id}`, original };
    if (prompt && readableRequest(prompt.prompt_text)) return { key, text: readableRequest(prompt.prompt_text), ...original };
    if ((number == null || number <= 1) && readableRequest(session.user_prompt)) return { key, text: readableRequest(session.user_prompt), source: 'session-initial-request', sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}` };
    return null;
  }

  function addActivity(group, entry) {
    group.lastActivityEpoch = Math.max(group.lastActivityEpoch, entry.atEpoch ?? 0);
    group.activity.push(entry);
    activity.push({ ...entry, agentGroupId: group.id });
  }

  const candidates = state.lists.filter((list) => !isOwnerGoalsList(list.name) && !isMyRulesList(list.name) && !isMyFocusList(list.name) && !isAgentLifecycleList(list.name)).flatMap((list) => [
    ...list.tasks.map((task) => ({ ...task, list, recordKind: 'task' })),
    ...(Object.keys(list.fields).some((key) => key !== 'task') ? [{ id: list.id, name: list.name, fields: list.fields, status: list.status, isOpen: !CLOSED.has(list.status), updatedAtEpoch: list.stateUpdatedAtEpoch, latestEntryId: state.events.find((event) => event.listId === list.id && event.task === null)?.id ?? 0, list, recordKind: 'list' }] : []),
  ]).sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch).slice(0, workLimit);

  function uniqueCall(event) {
    const matches = (callsByKey.get(callKey(event.originProject ?? event.project, event.listName, event.fields)) ?? [])
      .filter((call) => Math.abs(call.created_at_epoch - event.atEpoch) <= 5000);
    // Repeated identical writes are deliberately left unlinked when ambiguous.
    return matches.length === 1 ? matches[0] : null;
  }
  const eventsByItem = new Map();
  for (const event of state.events) {
    const itemId = event.taskId ?? (event.task === null ? event.listId : null);
    if (itemId === null) continue;
    if (!eventsByItem.has(itemId)) eventsByItem.set(itemId, []);
    eventsByItem.get(itemId).push(event);
  }

  for (const item of candidates) {
    const event = eventsById.get(item.latestEntryId);
    // An unlinked newest write (no captured call, or an ambiguous repeat) must
    // not erase who did the work: credit the newest write that does link.
    let call = null, linkedEvent = null;
    for (const candidate of eventsByItem.get(item.id) ?? (event ? [event] : [])) {
      call = uniqueCall(candidate);
      if (call) { linkedEvent = candidate; break; }
    }
    const session = call ? sessionsById.get(call.session_db_id) ?? sessionsByMemory.get(call.memory_session_id) : null;
    const owner = compactText(item.fields.owner, 100);
    const group = getGroup({ session, agentId: call?.agent_id ?? null, agentType: call?.agent_type ?? null, owner, project: item.list.project });
    if (session) linkedWork++; else if (owner) ownerWork++; else unattributedWork++;
    const explicitRequest = fieldText(item.fields, ['request', 'human_request', 'user_request'], 500);
    const requestKey = confirmedRequestKey(session, call?.prompt_number);
    const request = { ...(explicitRequest ?? requestFor(session, call?.prompt_number) ?? { text: compactText(item.name, 500), source: item.recordKind === 'task' ? 'task-label' : 'list-label', sourceId: item.id, url: null }), key: requestKey };
    const next = fieldText(item.fields, ['next_step', 'nextStep', 'next', 'next_action', 'remaining', 'pending', 'then_run']);
    const outcome = fieldText(item.fields, ['outcome', 'result', 'completed', 'verified', 'verification']);
    const progress = fieldText(item.fields, ['human_summary', 'summary', 'progress', 'phase', 'stage', 'status_note']);
    const entry = {
      id: item.id, kind: 'work-state', recordKind: item.recordKind, title: compactText(item.name, 160),
      project: item.list.project, listId: item.list.id, listName: item.list.name, taskId: item.recordKind === 'task' ? item.id : null,
      status: item.status, statusExplicit: Object.hasOwn(item.fields, 'status'), isOpen: item.isOpen, request, nextStep: next, outcome, progress, owner,
      requestId: ['string', 'number'].includes(typeof (item.fields.request_id ?? item.list.fields.request_id)) ? String(item.fields.request_id ?? item.list.fields.request_id).trim() || null : null,
      requestText: fieldText(item.fields, ['human_request', 'request', 'user_request'], 1200)?.text ?? fieldText(item.list.fields, ['human_request', 'request', 'user_request'], 1200)?.text ?? null,
      requestStatus: typeof (item.fields.request_status ?? item.list.fields.request_status) === 'string' ? (item.fields.request_status ?? item.list.fields.request_status) : null,
      requestComplete: typeof (item.fields.request_complete ?? item.list.fields.request_complete) === 'boolean' ? (item.fields.request_complete ?? item.list.fields.request_complete) : null,
      ...metadataFor(item),
      lastUpdateAt: stamp(item.updatedAtEpoch), lastUpdateEpoch: item.updatedAtEpoch,
      attribution: session ? { source: 'captured-work-state-call', toolUseId: call.id, sessionId: session.id, agentId: call.agent_id ?? null, meaning: linkedEvent.id === event?.id ? 'update-author' : 'latest-linked-update-author', linkedEntryId: linkedEvent.id, match: 'unique-project-list-fields-within-5s' } : { source: owner ? 'explicit-owner-field' : 'unavailable', meaning: owner ? 'recorded-assignee' : 'unknown' },
      sourceRefs: [{ kind: 'work-state', id: event?.id ?? item.latestEntryId }, ...(call ? [{ kind: 'tool-use', id: call.id }] : [])],
      url: `/api/work-view/evidence/work-state/${event?.id ?? item.latestEntryId}`,
    };
    group.work.push(entry);
    addActivity(group, { id: `work-state:${event?.id ?? item.latestEntryId}`, requestKey, kind: 'work-state', title: entry.title, detail: outcome?.text ?? progress?.text ?? next?.text ?? null, project: entry.project, at: entry.lastUpdateAt, atEpoch: entry.lastUpdateEpoch, sourceRef: entry.sourceRefs[0], url: entry.url });
  }

  const observationBuckets = new Map();
  function observationBucket(group, observation, session, request, requestKey, key, { withSummary }) {
    if (observationBuckets.has(key)) return observationBuckets.get(key);
    const summary = withSummary ? summaryByKey.get(JSON.stringify([observation.memory_session_id, observation.prompt_number])) : null;
    const row = {
      id: `session-request:${key}`, kind: 'session-request', recordKind: 'session',
      title: request?.text ?? compactText(observation.title, 160) ?? 'Recorded observation',
      project: observation.project, listId: null, taskId: null,
      status: 'unknown', statusExplicit: false, isOpen: true,
      request: { ...(request ?? { text: compactText(observation.title, 500) ?? 'Recorded observation', source: 'observation-title', sourceId: observation.id, url: `/api/work-view/evidence/observation/${observation.id}` }), key: requestKey },
      nextStep: summary?.next_steps ? { text: compactText(summary.next_steps), source: 'session-summary', sourceId: summary.id } : null,
      outcome: summary?.completed ? { text: compactText(summary.completed), source: 'session-summary', sourceId: summary.id } : null,
      progress: { text: compactText(observation.title), source: 'observation', sourceId: observation.id }, owner: null,
      lastUpdateAt: stamp(observation.created_at_epoch), lastUpdateEpoch: observation.created_at_epoch,
      attribution: { source: session ? 'observation-session-link' : 'unavailable', meaning: group.isSubagent ? 'recorded-subagent' : 'recorded-session', agentId: group.agentId ?? null },
      sourceRefs: [{ kind: 'observation', id: observation.id }], url: `/api/work-view/evidence/observation/${observation.id}`,
    };
    observationBuckets.set(key, row);
    group.work.push(row);
    return row;
  }
  const mainKey = (group, observation) => JSON.stringify([group.id, observation.memory_session_id ?? null, observation.content_session_id ?? null, observation.prompt_number ?? null]);
  for (const observation of observations) {
    const session = sessionsByMemory.get(observation.memory_session_id);
    const group = getGroup({ session, agentId: observation.agent_id, agentType: observation.agent_type, project: observation.project });
    const observationActivity = { id: `observation:${observation.id}`, kind: 'observation', title: compactText(observation.title, 160) ?? 'Recorded observation', detail: compactText(observation.subtitle), project: observation.project, at: stamp(observation.created_at_epoch), atEpoch: observation.created_at_epoch, sourceRef: { kind: 'observation', id: observation.id }, url: `/api/work-view/evidence/observation/${observation.id}` };
    if (!group.isSubagent) {
      const requestKey = confirmedRequestKey(session, observation.prompt_number);
      observationBucket(group, observation, session, requestFor(session, observation.prompt_number), requestKey, mainKey(group, observation), { withSummary: true });
      addActivity(group, { ...observationActivity, requestKey });
      continue;
    }
    // A subagent's observation carries the parent's current prompt number, so
    // it says nothing about which parent request the subagent was doing. Its
    // one row is the task it was launched with, under the launching prompt.
    const launch = group.launch;
    const launchKey = launch ? confirmedRequestKey(session, launch.promptNumber) : null;
    observationBucket(group, observation, session, launchRequest(launch), launchKey, JSON.stringify([group.id]), { withSummary: false });
    addActivity(group, { ...observationActivity, requestKey: launchKey });
    // The parent's ask at that prompt still belongs to the main agent: it keeps
    // its row even when only the subagent recorded anything during it. The
    // subagent's observation is that row's evidence, never its author.
    const parentRequest = requestFor(session, observation.prompt_number);
    if (session && parentRequest) {
      const main = getGroup({ session, agentId: null, agentType: null, project: observation.project });
      const parentKey = confirmedRequestKey(session, observation.prompt_number);
      const row = observationBucket(main, observation, session, parentRequest, parentKey, mainKey(main, observation), { withSummary: true });
      if (!row.sourceRefs.some((ref) => ref.kind === 'observation' && ref.id === observation.id)) row.sourceRefs.push({ kind: 'observation', id: observation.id });
    }
  }

  // Finished only on recorded evidence that came after the agent's latest
  // recorded activity: its SubagentStop (or the owner's Mark finished), the
  // foreground Agent call returning. (sdk_sessions.completed_at is not used: the
  // worker also sets it when its observer goes idle, so it does not prove the
  // conversation ended.) Any captured
  // tool call or observation after that evidence means the agent resumed.
  function subagentFinish(group) {
    const lastToolEpoch = lastToolEpochs.get(JSON.stringify([group.contentSessionId, group.agentId])) ?? 0;
    const lastActive = Math.max(group.lastActivityEpoch, lastToolEpoch);
    const evidence = [];
    const stop = agentStopFor(stops, group.platformSource, group.contentSessionId, group.agentId);
    if (stop) evidence.push({ evidence: stop.source, atEpoch: stop.stoppedAtEpoch, sourceRef: { kind: 'work-state', id: stop.entryId } });
    if (group.launch?.returnedAtEpoch) evidence.push({ evidence: 'agent-call-returned', atEpoch: group.launch.returnedAtEpoch, sourceRef: { kind: 'tool-use', id: group.launch.toolUseId } });
    return evidence.filter((entry) => entry.atEpoch >= lastActive).sort((a, b) => b.atEpoch - a.atEpoch)[0] ?? null;
  }

  const agents = [...groups.values()].map((group) => {
    const { lastActivityEpoch, ...publicGroup } = group;
    const age = Math.max(0, now - lastActivityEpoch);
    const finished = group.isSubagent ? subagentFinish(group) : null;
    if (finished) for (const item of group.work) if (item.kind === 'session-request') { item.status = 'finished'; item.isOpen = false; }
    return {
      ...publicGroup,
      presence: finished
        ? { ...group.presence, status: 'finished', evidence: finished.evidence, finishedAt: stamp(finished.atEpoch), sourceRef: finished.sourceRef, lastActivityAt: stamp(lastActivityEpoch) }
        : { ...group.presence, status: lastActivityEpoch ? age <= recentMs ? 'recent' : 'quiet' : 'unknown', lastActivityAt: stamp(lastActivityEpoch) },
      // The owner may record a stop for a subagent no recorded evidence covers.
      canMarkFinished: group.isSubagent && !finished,
      work: group.work.sort((a, b) => b.lastUpdateEpoch - a.lastUpdateEpoch),
      activity: group.activity.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, 8),
      counts: { work: group.work.length, open: group.work.filter((item) => item.isOpen).length, done: group.work.filter((item) => item.status === 'done').length },
    };
  }).sort((a, b) => String(b.presence.lastActivityAt ?? '').localeCompare(String(a.presence.lastActivityAt ?? '')));
  const recentActivity = activity.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, activityLimit);
  const requestProjection = buildHumanRequests({ agents, recentActivity }, records, { titleCache, ledger });
  const { focusAreas, focusAreaIdByAnchor } = buildFocusAreas(state);
  return {
    version: 1, generatedAt: stamp(now), currentProject: state.currentProject, currentProjectScope: state.currentProjectScope,
    agents, recentActivity, goals: buildOwnerGoals(state), goalHistory: buildOwnerGoalHistory(state),
    ...buildRules(state, ledger),
    ...requestProjection,
    focusAreas, humanRequests: placeRequests(requestProjection.humanRequests, focusAreaIdByAnchor, ledger),
    coverage: { workRows: candidates.length, workLimit, linkedWork, ownerWork, unattributedWork, observations: observations.length, observationLimit: 300, summaries: summaries.length, livePresenceAvailable: false, summaryMethod: 'bounded-recorded-text', fullHistoryUrl: '/viewer' },
  };
}

// Hosted quotes retain their structure: a quote may contain newlines, so the legacy line format cannot represent it losslessly.
function goalEvidence(value, structuredValue = null) {
  if (structuredValue !== null) {
    const evidence = JSON.parse(structuredValue);
    if (!Array.isArray(evidence) || !evidence.every(item => item && typeof item.at === 'string' && typeof item.quote === 'string')) {
      throw new TypeError('Hosted goal evidence must contain dated quote objects.');
    }
    return evidence;
  }
  // Legacy evidence is a line per quote: "YYYY-MM-DD HH:MM | quote".
  if (typeof value !== 'string') return [];
  return value.split('\n').flatMap((line) => {
    const match = /^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)\s*\|\s*(.+)$/.exec(line.trim());
    if (match) return [{ at: match[1], quote: compactText(match[2], 400) }];
    return compactText(line, 400) ? [{ at: null, quote: compactText(line, 400) }] : [];
  });
}

// One goals list as the panel shows it. The current month shows its open items;
// a past month (saved closed, as history) shows everything but dropped items.
function goalsFromList(list, history) {
  const count = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  // A later local refresh changes generated_at/snapshot; its older hosted fields must not override the new result.
  const hosted = list.fields.source === 'hosted-intent' && list.fields.hosted_generated_at === list.fields.generated_at;
  const originalText = value => typeof value === 'string' ? value : null;
  const listText = (value, max) => hosted ? originalText(value) : compactText(value, max);
  const items = list.tasks.filter((task) => history ? task.status !== 'dropped' : task.isOpen).map((task) => {
    const hostedTask = task.fields.source === 'hosted-intent' && task.fields.hosted_snapshot === task.fields.snapshot;
    const taskText = (value, max) => hostedTask ? originalText(value) : compactText(value, max);
    return {
      id: task.id, task: task.name, kind: goalKindOf(task.fields).kind,
      rank: count(task.fields.rank), title: taskText(task.fields.title ?? task.name, 240),
      // A focus area's one-sentence goal; an ask's focus area (the name it was mined with) and that area's id.
      // 300 and 80 are the bounds they are written with: an area's goal and name (MAX_AREA_GOAL_CHARS and
      // MAX_AREA_NAME_CHARS in save_goals.py, the same as focusBody / ownerGoalsFocusBody in WorkViewRoutes.ts).
      goal: taskText(task.fields.goal, 300), focusArea: taskText(task.fields.focus_area, 80),
      focusAreaId: typeof task.fields.focus_area_id === 'string' ? task.fields.focus_area_id : null,
      // Rows saved before the three tests (2026-10-27) name a product instead of a focus area.
      product: taskText(task.fields.product, 60), latestAt: taskText(task.fields.latest_at, 20),
      timesAsked: count(task.fields.times_asked), status: task.status,
      evidence: goalEvidence(task.fields.evidence, hostedTask ? task.fields.evidence_json ?? null : null),
    };
  }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.title.localeCompare(b.title));
  const day = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : null;
  return {
    listId: list.id, listName: list.name, history, project: list.project, updatedAt: list.updatedAt,
    periodStart: day(list.fields.period_start) ?? (history ? day(list.name.slice(OWNER_GOALS_LIST.length + 1)) : null),
    periodEnd: day(list.fields.period_end),
    summary: listText(list.fields.human_summary, 1600), generatedAt: listText(list.fields.generated_at, 40),
    windowDays: count(list.fields.window_days), sourcePromptCount: count(list.fields.source_prompt_count),
    mapPath: listText(list.fields.map_path, 400),
    areas: items.filter((item) => item.kind === 'focus-area'), asks: items.filter((item) => item.kind === 'ask'),
  };
}

/** The current month: the owner-goals list, open items only, ranked. */
export function buildOwnerGoals(state) {
  const list = state.lists.find((item) => item.name === OWNER_GOALS_LIST);
  return list && list.isOpen ? goalsFromList(list, false) : null;
}

/** Past months: every owner-goals/<start> list, newest first. */
export function buildOwnerGoalHistory(state) {
  return state.lists.filter((list) => list.name !== OWNER_GOALS_LIST && isOwnerGoalsList(list.name) && list.status !== 'dropped')
    .map((list) => goalsFromList(list, true))
    .filter((goals) => goals.areas.length || goals.asks.length)
    .sort((a, b) => String(b.periodStart ?? b.listName).localeCompare(String(a.periodStart ?? a.listName)));
}

export function readEvidence(database, kind, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const queries = {
    'work-state': 'SELECT id, project, list_name, fields, created_at_epoch FROM work_state_entries WHERE id = ?',
    observation: 'SELECT id, project, title, subtitle, narrative, created_at_epoch FROM observations WHERE id = ?',
    prompt: 'SELECT id, session_db_id, prompt_number, prompt_text, created_at_epoch FROM user_prompts WHERE id = ?',
    summary: 'SELECT id, project, request, completed, next_steps, created_at_epoch FROM session_summaries WHERE id = ?',
    session: 'SELECT id, project, platform_source, user_prompt, custom_title, status, started_at_epoch FROM sdk_sessions WHERE id = ?',
    'tool-use': 'SELECT id, project, tool_name, substr(tool_input, 1, 4000) AS tool_input, substr(tool_response, 1, 4000) AS tool_response, created_at_epoch FROM tool_uses WHERE id = ?',
  };
  if (!queries[kind]) return null;
  const row = safeRead(database, queries[kind], [id])[0];
  return row ? { kind, ...row } : null;
}
