// Human requests own the top level. Agent work and observations are evidence
// beneath a proven native conversation, never substitutes for a human ask.
import { bucketFileAvailable, copyCoversSource, fileUrl, mergeProducts, productsFromDeliverable, productsFromObservation, productsFromToolUse, servableFile } from './work-product.mjs';
import { NO_PROJECT, projectRoot, upgradedGroupRoot } from './session-project.mjs';

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
  if (ENGLISH_ACTION.test(plain)) return true;
  // Any other verb acting on an object: "Delete the branch", "List all tasks".
  const opening = IMPERATIVE_OPENING.exec(plain);
  if (opening && !NOT_A_VERB.test(opening[1])) return true;
  // English needs an action, so "list", "ps" or a pasted fragment never
  // becomes a request. Text in other scripts counts once two letters remain.
  if (/[^\x00-\x7F]/.test(plain)) return /\p{L}.*\p{L}/u.test(plain);
  // Plain ASCII without an English word (Turkish, Spanish without accents...)
  // counts once two real words remain; shell commands like "ls -la" do not.
  return !ENGLISH_WORDS.test(plain) && (plain.match(/\b[a-z]{3,}\b/gi) ?? []).length >= 2;
}

const ENGLISH_ACTION = /\b(?:make|build|create|implement|design|fix|investigate|audit|review|write|rewrite|show|see|find|search|explain|compare|help|convert|add|remove|update|rename|run|test|verify|deploy|analyze|analyse|read|tell|open|generate|ship|merge|commit|push|release|publish|set up|i want|i need|can you|could you|would you|how (?:can|do|does|is)|what (?:is|are|does|did)|why (?:is|are|does|did)|do we|do you|(?:is|are|seems?|looks?) (?:broken|failing|wrong)|doesn'?t work|not working)\b/i;
// An opening word, then a determiner or pronoun naming what it acts on.
const IMPERATIVE_OPENING = /^(?:please\s+)?([a-z]{3,})\s+(?:the|this|that|these|those|all|every|each|my|our|your|its|it|them|any|some|a|an)\b/i;
// Opening words that are not verbs: "on main now", "about the login", "now the...".
const NOT_A_VERB = /^(?:the|and|for|with|from|now|then|just|not|about|after|before|into|onto|over|under|like|also|here|there|when|where|what|which|who|why|how|but|yet|all|any|some|its|our|your|this|that|these|those|they|she|his|her|one|two|three)$/i;
const ENGLISH_WORDS = /\b(?:the|a|an|this|that|it|is|are|to|of|and|for|with|in|on|my|me|you|we|please|just|all|so|now|then|from|be|not)\b/i;

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

export const isConversationKey = (value) => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) && parsed[0] === 'conversation' && parsed.length === 3; } catch { return false; } };

export function conversationKey(session) {
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

export function originalFor(session, prompts) {
  const ordered = prompts.filter((prompt) => prompt.session_db_id === session.id)
    .sort((a, b) => (a.prompt_number ?? Infinity) - (b.prompt_number ?? Infinity) || (a.created_at_epoch ?? 0) - (b.created_at_epoch ?? 0) || a.id - b.id);
  const first = ordered.find((prompt) => isHumanActionRequest(prompt.prompt_text));
  if (isHumanActionRequest(session.user_prompt) && (!first || first.prompt_number > 1)) return { text: requestText(session.user_prompt), source: 'session-initial-request', sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  if (first) return { text: requestText(first.prompt_text), source: 'user-prompt', sourceId: first.id, url: `/api/work-view/evidence/prompt/${first.id}`, promptNumber: first.prompt_number, atEpoch: first.created_at_epoch ?? null };
  if (isHumanActionRequest(session.user_prompt)) return { text: requestText(session.user_prompt), source: 'session-initial-request', sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  return null;
}

// `ledger` holds evidence-backed overall-request groups (request-groups.mjs).
// A human request is the top level: one card per ledger group and per
// ungrouped conversation with a substantive human ask, built from its prompts.
// Recorded work, activity, work product and progress attach beneath it when
// they exist. An explicit work-state request_id still wins because the
// producer recorded it directly. Requests stay inside one project root.
export function buildHumanRequests(view, records = {}, { titleCache = {}, ledger = null } = {}) {
  const sessions = new Map((records.sessions ?? []).map((session) => [session.id, session]));
  const prompts = records.prompts ?? [];
  const flattened = (view.agents ?? []).flatMap((agent) => (agent.work ?? []).map((item) => ({ ...item, agentId: agent.id, agentLabel: agent.label, agentSessionId: agent.sessionId })));
  const subagentIds = new Set((view.agents ?? []).filter((agent) => agent.isSubagent).map((agent) => agent.id));
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
  const sessionsByKey = new Map();
  for (const session of sessions.values()) {
    const key = conversationKey(session);
    if (key && !sessionsByKey.has(key)) sessionsByKey.set(key, session);
  }
  // A group decided before its project was known (the "no project" root) takes the repository its
  // members show now: the anchor's, else the one repository its other members went to. Members in any
  // other repository are not part of it.
  const rootFromMembers = (groupId, group) => {
    const anchorRoot = projectRoot(sessionsByKey.get(group.anchor)?.project);
    if (anchorRoot) return anchorRoot;
    const memberRoots = new Set(Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId)
      .map(([key]) => projectRoot(sessionsByKey.get(key)?.project)).filter(Boolean));
    return memberRoots.size === 1 ? [...memberRoots][0] : NO_PROJECT;
  };
  // A group's root is stored at apply time; older groups take their anchor's.
  const derivedRoots = new Map();
  const groupRoot = (groupId) => {
    const group = ledger?.groups?.groups?.[groupId];
    if (group?.projectRoot === NO_PROJECT) {
      if (!derivedRoots.has(groupId)) derivedRoots.set(groupId, rootFromMembers(groupId, group));
      return derivedRoots.get(groupId);
    }
    const anchorRoot = projectRoot(sessionsByKey.get(group?.anchor)?.project);
    if (typeof group?.projectRoot === 'string') {
      if (!derivedRoots.has(groupId)) {
        const memberRoots = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId)
          .map(([key]) => projectRoot(sessionsByKey.get(key)?.project));
        derivedRoots.set(groupId, upgradedGroupRoot(group.projectRoot, anchorRoot, memberRoots));
      }
      return derivedRoots.get(groupId);
    }
    return anchorRoot;
  };
  // A conversation joins its group only from the group's own project root; in a group decided before
  // its project was known, a member that still shows no project stays too.
  const groupFor = (key, session) => {
    const groupId = key ? ledger?.groups?.conversations?.[key] ?? null : null;
    if (!groupId) return null;
    const own = projectRoot(session?.project), expected = groupRoot(groupId);
    const rootWasUnknown = ledger.groups.groups[groupId]?.projectRoot === NO_PROJECT;
    return own == null || expected == null || own === expected || (rootWasUnknown && own === NO_PROJECT) ? groupId : null;
  };
  const requests = new Map(), unlinkedWork = [];
  const requestFor = (id, { key, original, groupId = null, explicit = null, explicitText = null }) => {
    let request = requests.get(id);
    // A group keeps its first ask in the ledger, so the start holds even when
    // the anchor conversation is outside the loaded records.
    const anchorAsk = groupId ? ledger?.groups?.groups?.[groupId]?.anchorAsk ?? null : null;
    if (anchorAsk && (anchorAsk.atEpoch ?? Infinity) < (original.atEpoch ?? Infinity)) original = anchorAsk;
    if (!request) {
      request = { id, conversationKey: key, conversationKeys: [], original, explicitRequestText: explicitText, scopeUpdates: [], projects: [], agentIds: [], items: [], workstreams: [], updatedAtEpoch: 0, explicitRequestId: explicit, groupId };
      requests.set(id, request);
    } else {
      if (!request.explicitRequestText && explicitText) request.explicitRequestText = explicitText;
      // An overall request starts at its earliest linked human ask.
      if (groupId && (original.atEpoch ?? Infinity) < (request.original.atEpoch ?? Infinity)) request.original = original;
    }
    if (key && !request.conversationKeys.includes(key)) request.conversationKeys.push(key);
    return request;
  };
  const addProject = (request, project) => { if (typeof project === 'string' && project && !request.projects.includes(project)) request.projects.push(project); };

  // 1. Requests from prompts: every ungrouped conversation with a substantive
  // human ask, and every group, whether or not any work was recorded yet.
  for (const [key, session] of sessionsByKey) {
    // Its work is filed under the request ids the producer recorded.
    if (explicitIds.has(key) || ledger?.groups?.ignored?.[key]) continue;
    const original = originalFor(session, prompts);
    if (!original) continue;
    const groupId = groupFor(key, session);
    addProject(requestFor(groupId ? JSON.stringify(['overall-request', groupId]) : key, { key, original, groupId }), session.project);
  }
  // A group whose conversations are all outside the loaded records shows from its stored first ask.
  for (const [groupId, group] of Object.entries(ledger?.groups?.groups ?? {})) {
    const id = JSON.stringify(['overall-request', groupId]);
    if (requests.has(id) || !group?.anchorAsk || ledger?.groups?.ignored?.[group.anchor]) continue;
    const anchorSession = sessionsByKey.get(group.anchor);
    // The anchor itself is loaded, so its ask (or its recorded request id) already decided the card.
    if (anchorSession) continue;
    requestFor(id, { key: isConversationKey(group.anchor) ? group.anchor : null, original: group.anchorAsk, groupId });
  }

  // 2. Recorded work attaches beneath its request.
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
    // The grouping agent ruled this conversation out as a human goal; an
    // explicit request_id recorded by the producer still stands on its own.
    if (!explicit && key && ledger?.groups?.ignored?.[key]) {
      unlinkedWork.push({ ...item, reason: 'ignored-by-request-grouping' });
      continue;
    }
    const groupId = !explicit ? groupFor(key, session) : null;
    // One request id names one request per project root; worktrees of a repo share it.
    const root = projectRoot(session?.project) ?? projectRoot(item.project);
    const id = explicit ? JSON.stringify(root == null ? ['explicit-request', explicit] : ['explicit-request', root, explicit]) : groupId ? JSON.stringify(['overall-request', groupId]) : key;
    const request = requestFor(id, { key, original, groupId, explicit, explicitText });
    addProject(request, session?.project);
    addProject(request, item.project);
    if (!request.agentIds.includes(item.agentId)) request.agentIds.push(item.agentId);
    request.items.push(item);
    request.updatedAtEpoch = Math.max(request.updatedAtEpoch, item.lastUpdateEpoch ?? 0);
  }

  // Recorded work product joins a request through its conversation. A
  // conversation split across several explicit requests proves none of them.
  const requestsByConversation = new Map();
  for (const request of requests.values()) for (const key of request.conversationKeys) {
    if (!requestsByConversation.has(key)) requestsByConversation.set(key, []);
    requestsByConversation.get(key).push(request);
  }
  const sessionsByMemory = new Map([...sessions.values()].filter((session) => session.memory_session_id).map((session) => [session.memory_session_id, session]));
  const recordedProducts = new Map();
  const attach = (session, products) => {
    const owners = requestsByConversation.get(conversationKey(session));
    if (owners?.length !== 1 || !products.length) return;
    if (!recordedProducts.has(owners[0])) recordedProducts.set(owners[0], []);
    recordedProducts.get(owners[0]).push(...products);
  };
  for (const call of records.productCalls ?? []) attach(sessions.get(call.session_db_id), productsFromToolUse(call));
  for (const observation of records.productObservations ?? []) attach(sessionsByMemory.get(observation.memory_session_id), productsFromObservation(observation));
  // A deliverables row names its conversation itself (platform + content session), so it needs no loaded session row.
  for (const row of records.productDeliverables ?? []) attach(row, productsFromDeliverable(row));

  const sessionIdsByKey = new Map(), promptsBySession = new Map();
  for (const session of sessions.values()) {
    const key = conversationKey(session);
    if (key) sessionIdsByKey.set(key, [...(sessionIdsByKey.get(key) ?? []), session.id]);
  }
  for (const prompt of prompts) {
    if (!promptsBySession.has(prompt.session_db_id)) promptsBySession.set(prompt.session_db_id, []);
    promptsBySession.get(prompt.session_db_id).push(prompt);
  }
  for (const request of requests.values()) {
    const merged = mergeProducts([...(recordedProducts.get(request) ?? []), ...request.items.flatMap((item) => item.workProduct ?? [])]);
    // A bucket copy that is on disk replaces the record that points at where the file was made (that place is often
    // deleted later), unless the file has been written since the copy: then the record is a newer version and stays.
    const copies = merged.filter((product) => product.deliverable && product.sourcePath);
    const covered = (product) => Boolean(product.path) && copies.some((copy) => copy.sourcePath === product.path && copyCoversSource(copy, product.path));
    request.workProduct = merged.filter((product) => !covered(product))
      .map((product) => ({ ...product, fileUrl: fileUrl(product), available: product.path ? Boolean(servableFile(product)) : product.deliverable ? bucketFileAvailable(product) : true }));
    const relatedIds = new Set(request.conversationKeys.flatMap((key) => sessionIdsByKey.get(key) ?? []));
    const related = [...relatedIds].flatMap((id) => promptsBySession.get(id) ?? []);
    // A new ask is activity on its request, even before any agent records work.
    request.updatedAtEpoch = Math.max(request.updatedAtEpoch, request.original.atEpoch ?? 0, ...related.map((prompt) => prompt.created_at_epoch ?? 0));
    if (!request.agentIds.length) for (const agent of view.agents ?? []) if (relatedIds.has(agent.sessionId) && !request.agentIds.includes(agent.id)) request.agentIds.push(agent.id);
    request.scopeUpdates = related.filter((prompt) => !(request.original.source === 'user-prompt' && prompt.id === request.original.sourceId) && requestText(prompt.prompt_text) && (request.original.promptNumber == null || prompt.prompt_number >= request.original.promptNumber))
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
    // The conversation's own agent leads; a subagent it launched only helps.
    request.agentIds.sort((a, b) => Number(subagentIds.has(a)) - Number(subagentIds.has(b)));
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
    request.progress = request.groupId ? ledger?.progress?.[request.groupId] ?? null : null;
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
    const groupTitle = request.groupId ? ledger?.groups?.groups?.[request.groupId]?.title?.trim() ?? '' : '';
    request.title = cachedTitle || groupTitle || humanRequestTitle(request.explicitRequestText ?? request.original);
    request.titleSource = cachedTitle ? 'title-cache' : groupTitle ? 'request-group' : request.explicitRequestText ? 'explicit-work-state-request' : 'original-human-request';
    request.items.sort((a, b) => (b.lastUpdateEpoch ?? 0) - (a.lastUpdateEpoch ?? 0));
  }
  return { humanRequests: [...requests.values()].sort((a, b) => b.updatedAtEpoch - a.updatedAtEpoch), unlinkedWork };
}
