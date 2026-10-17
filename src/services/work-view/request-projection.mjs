// Human requests own the top level. Agent work and observations are evidence
// beneath a proven native conversation, never substitutes for a human ask.
export function requestText(value, max = 1200) {
  if (typeof value !== 'string') return null;
  const requestSection = value.match(/^\s*#{1,2}\s+My request\s*:\s*(?:\r?\n)?([\s\S]*)$/im);
  const text = (requestSection?.[1] ?? value)
    .replace(/<(environment_context|instructions|system-reminder|turn_aborted|permissions|collaboration_mode|skills_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/^\s*#\s*AGENTS\.md instructions[^\n]*(?:\n|$)/gim, ' ')
    .replace(/<\/?pasted_content\b[^>]*>/gi, '')
    .trim();
  if (/^\s*#{1,2}\s+Files mentioned by the user\s*:/i.test(text)) return null;
  if (!text || /^\s*<(?:environment_context|instructions|system-reminder)\b/i.test(text)) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function isHumanActionRequest(value) {
  const text = requestText(value);
  if (!text) return false;
  const plain = text.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(?:please\s+)?read\s+(?:the\s+)?[\w./ -]*(?:AGENTS|KICKOFF|CLAUDE)\.md(?:\s+and\s+(?:follow|obey|read|apply)(?:\s+it|\s+the\s+instructions)?\s*)?[.!]?$/i.test(plain)) return false;
  if (/^(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|yes|no|sure|continue|go ahead|keep going|resume|done)[.!\s]*$/i.test(plain)) return false;
  if (/^(?:You are (?:Codex|an AI)|Available skills|Environment context)\b/i.test(plain)) return false;
  if (/^(?:(?:please|just)\s+)?make sure (?:this|that|it|everything) (?:is |will be |keeps? )?(?:working|works|ok|okay|correct)(?:[.!\s]*)$/i.test(plain)) return false;
  if (/^you can (?:def(?:initely)? )?do (?:real )?tests?[,;.!\s]/i.test(plain) && !/\b(?:fix|build|create|implement|change|update|rename|remove|add)\b/i.test(plain)) return false;
  if (/(?:^|\s)GOAL\s*:\s*\S/i.test(plain)) return true;
  return /\b(?:GOAL\s*:|make|build|create|implement|design|fix|investigate|audit|review|write|rewrite|show|see|find|search|explain|compare|help|convert|add|remove|update|rename|run|test|verify|deploy|analyze|analyse|read|tell|open|generate|set up|i want|i need|can you|could you|would you|how (?:can|do|does|is)|what (?:is|are|does|did)|why (?:is|are|does|did)|do we|do you)\b/i.test(plain);
}

export function humanRequestTitle(original) {
  const text = requestText(typeof original === 'string' ? original : original?.text);
  if (!text) return '';
  const goal = text.match(/(?:^|\n)\s*GOAL\s*:\s*([^\n]+)/i);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const first = goal?.[1] ?? lines[0] ?? '';
  const nextQuotedLine = /\bcalled\s*$/i.test(first) && /^["“'‘]/.test(lines[1] ?? '') ? ` ${lines[1]}` : '';
  const line = `${first}${nextQuotedLine}`
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/, '').replace(/\s+/g, ' ').trim();
  const clause = line.split(/(?<=[.!?])\s|;\s/)[0];
  if (clause.length <= 100) return clause;
  const cut = clause.slice(0, 99), boundary = cut.lastIndexOf(' ');
  return `${cut.slice(0, boundary > 60 ? boundary : 99).trimEnd()}…`;
}

function conversationKey(session) {
  if (!session?.content_session_id || !session?.platform_source) return null;
  return JSON.stringify(['conversation', session.platform_source, session.content_session_id]);
}

function compareSourceOrder(a = null, b = null) {
  if (!a || !b) return 0;
  const time = a[0] - b[0];
  const device = a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  const left = BigInt(a[2]), right = BigInt(b[2]);
  return time || device || (left < right ? -1 : left > right ? 1 : 0);
}

function originalFor(session, prompts) {
  const ordered = prompts.filter((prompt) => prompt.session_db_id === session.id)
    .sort((a, b) => (a.prompt_number ?? Infinity) - (b.prompt_number ?? Infinity) || (a.created_at_epoch ?? 0) - (b.created_at_epoch ?? 0) || a.id - b.id);
  const first = ordered.find((prompt) => isHumanActionRequest(prompt.prompt_text));
  if (isHumanActionRequest(session.user_prompt) && (!first || first.prompt_number > 1)) return { text: requestText(session.user_prompt), source: 'session-initial-request', sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  if (first) return { text: requestText(first.prompt_text), source: 'user-prompt', sourceId: first.id, url: `/api/work-view/evidence/prompt/${first.id}`, promptNumber: first.prompt_number, atEpoch: first.created_at_epoch ?? null };
  if (isHumanActionRequest(session.user_prompt)) return { text: requestText(session.user_prompt), source: 'session-initial-request', sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  return null;
}

export function buildHumanRequests(view, records = {}, { titleCache = {} } = {}) {
  const sessions = new Map((records.sessions ?? []).map((session) => [session.id, session]));
  const prompts = records.prompts ?? [];
  const flattened = (view.agents ?? []).flatMap((agent) => (agent.work ?? []).map((item) => ({ ...item, agentId: agent.id, agentLabel: agent.label, agentSessionId: agent.sessionId })));
  const activityPool = new Map();
  for (const agent of view.agents ?? []) for (const activity of agent.activity ?? []) activityPool.set(`${agent.id}:${activity.id}`, { ...activity, agentId: agent.id, agentLabel: agent.label });
  for (const activity of view.recentActivity ?? []) {
    const agent = (view.agents ?? []).find((candidate) => candidate.id === activity.agentGroupId);
    if (agent) activityPool.set(`${agent.id}:${activity.id}`, { ...activity, agentId: agent.id, agentLabel: agent.label });
  }
  function activityFor(items, requestId, limit) {
    const matches = new Map();
    for (const item of items) {
      const refs = new Set((item.sourceRefs ?? []).map((ref) => `${ref.kind}:${ref.id}`));
      for (const activity of activityPool.values()) {
        if (activity.agentId !== item.agentId) continue;
        const direct = refs.has(activity.id) || (activity.sourceRef && refs.has(`${activity.sourceRef.kind}:${activity.sourceRef.id}`));
        const observationForPrompt = activity.kind === 'observation' && item.request?.key && activity.requestKey === item.request.key;
        if (direct || observationForPrompt) matches.set(`${activity.agentId}:${activity.id}`, { ...activity, promptRequestKey: activity.requestKey ?? null, requestKey: requestId });
      }
    }
    return [...matches.values()].sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0)).slice(0, limit);
  }
  const explicitIds = new Map();
  for (const item of flattened) {
    const key = conversationKey(sessions.get(item.agentSessionId));
    if (key && item.requestId) {
      if (!explicitIds.has(key)) explicitIds.set(key, new Set());
      explicitIds.get(key).add(String(item.requestId));
    }
  }
  const requests = new Map(), unlinkedWork = [];
  for (const item of flattened) {
    const session = sessions.get(item.agentSessionId);
    const key = conversationKey(session);
    const knownIds = explicitIds.get(key);
    const explicit = item.requestId ? String(item.requestId) : knownIds?.size === 1 ? [...knownIds][0] : null;
    if (!item.requestId && knownIds?.size > 1) {
      unlinkedWork.push({ ...item, reason: 'multiple-explicit-requests-without-item-link' });
      continue;
    }
    let original = session ? originalFor(session, prompts) : null;
    const explicitText = isHumanActionRequest(item.requestText) ? requestText(item.requestText) : null;
    if (!original && explicit && explicitText) original = { text: explicitText, source: 'explicit-work-state-request', sourceId: item.id, url: item.url, promptNumber: null, atEpoch: item.lastUpdateEpoch ?? null };
    if (!original || (!key && !explicit)) {
      unlinkedWork.push({ ...item, reason: key ? 'no-substantive-human-request' : 'no-confirmed-conversation-or-explicit-request' });
      continue;
    }
    const id = explicit ? JSON.stringify(['explicit-request', explicit]) : key;
    let request = requests.get(id);
    if (!request) {
      request = { id, conversationKey: key, conversationKeys: [], original, explicitRequestText: explicitText, scopeUpdates: [], projects: [], agentIds: [], items: [], workstreams: [], updatedAtEpoch: 0, explicitRequestId: explicit };
      requests.set(id, request);
    } else if (!request.explicitRequestText && explicitText) request.explicitRequestText = explicitText;
    if (key && !request.conversationKeys.includes(key)) request.conversationKeys.push(key);
    if (item.project && !request.projects.includes(item.project)) request.projects.push(item.project);
    if (!request.agentIds.includes(item.agentId)) request.agentIds.push(item.agentId);
    request.items.push(item);
    request.updatedAtEpoch = Math.max(request.updatedAtEpoch, item.lastUpdateEpoch ?? 0);
  }

  for (const request of requests.values()) {
    const relatedSessions = [...sessions.values()].filter((session) => request.conversationKeys.includes(conversationKey(session)));
    const relatedIds = new Set(relatedSessions.map((session) => session.id));
    request.scopeUpdates = prompts.filter((prompt) => relatedIds.has(prompt.session_db_id) && !(request.original.source === 'user-prompt' && prompt.id === request.original.sourceId) && requestText(prompt.prompt_text) && (request.original.promptNumber == null || prompt.prompt_number >= request.original.promptNumber))
      .sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0) || b.prompt_number - a.prompt_number || b.id - a.id)
      .slice(0, 6).reverse().map((prompt) => ({ text: requestText(prompt.prompt_text, 500), sourceId: prompt.id, url: `/api/work-view/evidence/prompt/${prompt.id}`, promptNumber: prompt.prompt_number, atEpoch: prompt.created_at_epoch ?? null }));
    const streams = new Map();
    for (const item of request.items) {
      const id = item.listId ?? JSON.stringify(['agent-session', item.agentId]);
      if (!streams.has(id)) streams.set(id, { id, title: item.listName ?? item.title, agentIds: [], items: [] });
      const stream = streams.get(id);
      if (!stream.agentIds.includes(item.agentId)) stream.agentIds.push(item.agentId);
      stream.items.push(item);
    }
    request.workstreams = [...streams.values()];
    for (const stream of request.workstreams) stream.activity = activityFor(stream.items, request.id, 20);
    request.activity = activityFor(request.items, request.id, 40);
    const metadata = (key) => request.items.map((item) => ({ item, record: item[key] })).filter(({ record }) => record).sort((a, b) => (b.record.atEpoch ?? 0) - (a.record.atEpoch ?? 0));
    const lifecycleRecords = request.items.flatMap((item) => [
      ...(typeof item.requestStatus === 'string' && item.requestStatus.trim() ? [{ status: item.requestStatus.trim(), explicit: true, field: 'request_status', sourceId: item.id, url: item.url, atEpoch: item.requestStatusSource?.atEpoch ?? item.lastUpdateEpoch ?? null, sourceOrder: item.requestStatusSource?.sourceOrder ?? null, sourceRef: item.requestStatusSource?.sourceRef ?? null }] : []),
      ...(typeof item.requestComplete === 'boolean' ? [{ status: item.requestComplete ? 'done' : 'open', complete: item.requestComplete, explicit: true, field: 'request_complete', sourceId: item.id, url: item.url, atEpoch: item.requestCompleteSource?.atEpoch ?? item.lastUpdateEpoch ?? null, sourceOrder: item.requestCompleteSource?.sourceOrder ?? null, sourceRef: item.requestCompleteSource?.sourceRef ?? null }] : []),
    ]).sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0)
      || compareSourceOrder(b.sourceOrder, a.sourceOrder)
      || Number(b.field === 'request_complete') - Number(a.field === 'request_complete'));
    request.lifecycle = lifecycleRecords[0] ?? null;
    request.startedAtEpoch = request.original.atEpoch ?? null;
    request.completedAtEpoch = request.lifecycle && (request.lifecycle.complete === true || ['done', 'completed', 'complete', 'shipped', 'delivered'].includes(request.lifecycle.status.toLowerCase())) ? request.lifecycle.atEpoch : null;
    request.requestedBy = metadata('requestedBySource')[0]?.item.requestedBy ?? null;
    request.requestedBySource = metadata('requestedBySource')[0]?.record ?? null;
    request.shipEstimate = metadata('shipEstimateSource')[0]?.item.shipEstimate ?? null;
    request.shipEstimateSource = metadata('shipEstimateSource')[0]?.record ?? null;
    request.stageSourceText = metadata('stageSource')[0]?.item.stageSourceText ?? null;
    request.stageSource = metadata('stageSource')[0]?.record ?? null;
    const collect = (section, valueKey) => {
      const unique = new Map();
      for (const item of request.items) for (const value of item.afterShip?.[section] ?? []) {
        const key = JSON.stringify([value.kind ?? section, value[valueKey]]);
        if (!unique.has(key)) unique.set(key, { ...value, sourceRefs: [] });
        const target = unique.get(key);
        for (const ref of value.sourceRefs ?? []) if (!target.sourceRefs.some((other) => other.kind === ref.kind && other.id === ref.id)) target.sourceRefs.push(ref);
      }
      return [...unique.values()];
    };
    const resources = collect('resources', 'url'), classifications = collect('classifications', 'text'), notes = collect('notes', 'text');
    request.afterShip = resources.length || classifications.length || notes.length ? { resources, classifications, notes } : null;
    const cached = titleCache instanceof Map ? titleCache.get(request.id) : titleCache[request.id];
    const cachedTitle = typeof cached === 'string' ? cached.trim() : cached && cached.source === request.original.source && cached.sourceId != null && String(cached.sourceId) === String(request.original.sourceId) && typeof cached.title === 'string' ? cached.title.trim() : '';
    request.title = cachedTitle || humanRequestTitle(request.explicitRequestText ?? request.original);
    request.titleSource = cachedTitle ? 'title-cache' : request.explicitRequestText ? 'explicit-work-state-request' : 'original-human-request';
    request.items.sort((a, b) => (b.lastUpdateEpoch ?? 0) - (a.lastUpdateEpoch ?? 0));
  }
  return { humanRequests: [...requests.values()].sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch), unlinkedWork };
}
