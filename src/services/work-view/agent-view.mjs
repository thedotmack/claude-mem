// A read-only projection of recorded work and observation activity. A captured
// tool call establishes its author, never the assignee or live presence.
import { buildHumanRequests } from './request-projection.mjs';
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
export function readAgentRecords(database, { observationLimit = 300, summaryLimit = 100, workCallLimit = 5000, workState } = {}) {
  const recentWorkTimes = workState?.lists.flatMap((list) => [list.stateUpdatedAtEpoch, ...list.tasks.map((task) => task.updatedAtEpoch)]).filter(Boolean).sort((a, b) => b - a).slice(0, 240);
  const workSinceEpoch = recentWorkTimes?.length ? recentWorkTimes.at(-1) - 5000 : 0;
  const calls = safeRead(database, `SELECT id, project, platform_source, agent_id, agent_type, session_db_id, memory_session_id, content_session_id, prompt_number, tool_input, created_at_epoch
    FROM tool_uses WHERE tool_name IN (SELECT DISTINCT tool_name FROM tool_uses WHERE tool_name LIKE '%work_state_write%')
    AND created_at_epoch >= ? ORDER BY id DESC LIMIT ?`, [workSinceEpoch, workCallLimit]);
  const observations = safeRead(database, `SELECT id, project, memory_session_id, content_session_id, agent_id, agent_type, prompt_number, title, subtitle, type, created_at_epoch
    FROM observations ORDER BY created_at_epoch DESC, id DESC LIMIT ?`, [observationLimit]);
  const summaries = safeRead(database, `SELECT id, project, memory_session_id, prompt_number, request, completed, next_steps, created_at_epoch
    FROM session_summaries ORDER BY created_at_epoch DESC, id DESC LIMIT ?`, [summaryLimit]);
  const ids = [...new Set(calls.map((call) => call.session_db_id).filter((id) => id != null))];
  const memoryIds = [...new Set([...observations, ...summaries].map((row) => row.memory_session_id).filter(Boolean))];
  const predicates = [], args = [];
  if (ids.length) { predicates.push(`id IN (${ids.map(() => '?')})`); args.push(...ids); }
  if (memoryIds.length) { predicates.push(`memory_session_id IN (${memoryIds.map(() => '?')})`); args.push(...memoryIds); }
  const sessions = predicates.length ? safeRead(database, `SELECT id, project, platform_source, content_session_id, memory_session_id, user_prompt, custom_title, status, started_at_epoch, completed_at_epoch
    FROM sdk_sessions WHERE ${predicates.join(' OR ')}`, args) : [];
  const sessionIds = sessions.map((session) => session.id);
  const prompts = sessionIds.length ? safeRead(database, `SELECT id, session_db_id, prompt_number, substr(prompt_text, 1, 1200) AS prompt_text, created_at_epoch
    FROM user_prompts WHERE session_db_id IN (${sessionIds.map(() => '?')}) ORDER BY id DESC LIMIT 12000`, sessionIds) : [];
  return { calls, observations, summaries, sessions, prompts };
}

export function buildAgentView(state, records, { now = Date.now(), workLimit = 240, activityLimit = 160, recentMs = 15 * 60 * 1000, titleCache = {} } = {}) {
  const { calls = [], observations = [], summaries = [], sessions = [], prompts = [] } = records;
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
    return {
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

  const candidates = state.lists.flatMap((list) => [
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
  for (const observation of observations) {
    const session = sessionsByMemory.get(observation.memory_session_id);
    const group = getGroup({ session, agentId: observation.agent_id, agentType: observation.agent_type, project: observation.project });
    const request = requestFor(session, observation.prompt_number);
    const requestKey = confirmedRequestKey(session, observation.prompt_number);
    const key = JSON.stringify([group.id, observation.memory_session_id ?? null, observation.content_session_id ?? null, observation.prompt_number ?? null]);
    if (!observationBuckets.has(key)) {
      const summary = summaryByKey.get(JSON.stringify([observation.memory_session_id, observation.prompt_number]));
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
        attribution: { source: session ? 'observation-session-link' : 'unavailable', meaning: 'recorded-session' },
        sourceRefs: [{ kind: 'observation', id: observation.id }], url: `/api/work-view/evidence/observation/${observation.id}`,
      };
      observationBuckets.set(key, row);
      group.work.push(row);
    }
    addActivity(group, { id: `observation:${observation.id}`, requestKey, kind: 'observation', title: compactText(observation.title, 160) ?? 'Recorded observation', detail: compactText(observation.subtitle), project: observation.project, at: stamp(observation.created_at_epoch), atEpoch: observation.created_at_epoch, sourceRef: { kind: 'observation', id: observation.id }, url: `/api/work-view/evidence/observation/${observation.id}` });
  }

  const agents = [...groups.values()].map((group) => {
    const { lastActivityEpoch, ...publicGroup } = group;
    const age = Math.max(0, now - lastActivityEpoch);
    return {
      ...publicGroup,
      presence: { ...group.presence, status: lastActivityEpoch ? age <= recentMs ? 'recent' : 'quiet' : 'unknown', lastActivityAt: stamp(lastActivityEpoch) },
      work: group.work.sort((a, b) => b.lastUpdateEpoch - a.lastUpdateEpoch),
      activity: group.activity.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, 8),
      counts: { work: group.work.length, open: group.work.filter((item) => item.isOpen).length, done: group.work.filter((item) => item.status === 'done').length },
    };
  }).sort((a, b) => String(b.presence.lastActivityAt ?? '').localeCompare(String(a.presence.lastActivityAt ?? '')));
  const recentActivity = activity.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, activityLimit);
  const requestProjection = buildHumanRequests({ agents, recentActivity }, records, { titleCache });
  return {
    version: 1, generatedAt: stamp(now), currentProject: state.currentProject, currentProjectScope: state.currentProjectScope,
    agents, recentActivity,
    ...requestProjection,
    coverage: { workRows: candidates.length, workLimit, linkedWork, ownerWork, unattributedWork, observations: observations.length, observationLimit: 300, summaries: summaries.length, livePresenceAvailable: false, summaryMethod: 'bounded-recorded-text', fullHistoryUrl: '/viewer' },
  };
}

export function readEvidence(database, kind, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const queries = {
    'work-state': 'SELECT id, project, list_name, fields, created_at_epoch FROM work_state_entries WHERE id = ?',
    observation: 'SELECT id, project, title, subtitle, narrative, created_at_epoch FROM observations WHERE id = ?',
    prompt: 'SELECT id, session_db_id, prompt_number, prompt_text, created_at_epoch FROM user_prompts WHERE id = ?',
    summary: 'SELECT id, project, request, completed, next_steps, created_at_epoch FROM session_summaries WHERE id = ?',
    session: 'SELECT id, project, platform_source, user_prompt, custom_title, status, started_at_epoch FROM sdk_sessions WHERE id = ?',
  };
  if (!queries[kind]) return null;
  const row = safeRead(database, queries[kind], [id])[0];
  return row ? { kind, ...row } : null;
}
