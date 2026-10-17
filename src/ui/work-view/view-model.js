// Display rules shared by the browser and focused regression tests.
// Text comes from recorded work; we never infer completion or live presence.
const STALE_MS = 6 * 60 * 60 * 1000;
const meaningful = value => typeof value === 'string' && value.trim() && !/^(true|false|null|undefined|\d+)$/i.test(value.trim());

export function cleanText(value, max = 150) {
  if (!meaningful(value)) return '';
  let text = value
    .replace(/<(environment_context|instructions|system-reminder|INSTRUCTIONS|AGENTS)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  if (/^(?:AGENTS\.md instructions|You are (?:Codex|an AI)|[/{]["']?\w+["']?\s*:)/i.test(text)) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${cut.slice(0, boundary > max * .65 ? boundary : max - 1).replace(/[,:;\-\s]+$/, '')}…`;
}

export function projectLabel(project) {
  return String(project || 'Unknown project').split('/')[0];
}

export function relativeTime(value, now = Date.now()) {
  const epoch = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return 'Time not recorded';
  const age = Math.max(0, now - epoch);
  if (age < 60000) return 'Just now';
  if (age < 3600000) return `${Math.floor(age / 60000)}m ago`;
  if (age < 86400000) return `${Math.floor(age / 3600000)}h ago`;
  if (age < 172800000) return 'Yesterday';
  return `${Math.floor(age / 86400000)}d ago`;
}

export function requestElapsed(request, now = Date.now()) {
  if (!Number.isFinite(request.startedAtEpoch) || request.startedAtEpoch <= 0) return 'Not recorded';
  const end = request.completedAtEpoch || now;
  const minutes = Math.max(0, Math.floor((end - request.startedAtEpoch) / 60000));
  if (minutes < 1) return 'Just started';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

// Update only clock text so an open source disclosure and the reader's scroll
// position survive a timer tick. The request data remains the applied snapshot.
export function refreshTimeLabels(root, requests, now = Date.now()) {
  root.querySelectorAll('time[data-epoch]').forEach(element => {
    element.textContent = relativeTime(Number(element.dataset.epoch), now);
  });
  const byId = new Map(requests.map(request => [request.id, request]));
  root.querySelectorAll('[data-request-elapsed]').forEach(element => {
    const request = byId.get(element.dataset.requestElapsed);
    if (request) element.textContent = requestElapsed(request, now);
  });
}

function normalizeRecordedStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[_ ]/g, '-');
  return ['needs-you', 'needs-input', 'waiting-on-user', 'awaiting-approval', 'needs-approval'].includes(status) ? 'needs-you' : status;
}

export function statusFor(items, now = Date.now()) {
  const states = items.map(item => normalizeRecordedStatus(item.status));
  if (states.includes('needs-you')) return 'needs-you';
  if (states.some(s => ['blocked', 'failed'].includes(s))) return 'blocked';
  if (items.length && items.every(item => item.kind === 'work-state' && ['done', 'completed'].includes(item.status))) return 'done';
  if (items.length && items.every(item => item.kind === 'work-state' && item.status === 'dropped')) return 'closed';
  const updated = Math.max(0, ...items.map(item => item.lastUpdateEpoch || Date.parse(item.lastUpdateAt) || 0));
  if (now - updated > STALE_MS) return 'quiet';
  if (states.some(s => ['doing', 'in-progress', 'active', 'running'].includes(s))) return 'in-progress';
  if (states.some(s => ['todo', 'planned', 'queued'].includes(s))) return 'todo';
  return 'unknown';
}

export const STATUS = {
  'needs-you': { label: 'Needs you', rank: 0 },
  blocked: { label: 'Blocked', rank: 1 },
  'in-progress': { label: 'In progress', rank: 2 },
  quiet: { label: 'No recent update', rank: 1 },
  done: { label: 'Done', rank: 5 },
  todo: { label: 'To do', rank: 3 },
  unknown: { label: 'Update recorded', rank: 4 },
  closed: { label: 'Closed', rank: 6 },
};

function nextFor(items, status) {
  const fields = status === 'done' ? ['outcome', 'progress'] : status === 'needs-you' ? ['nextStep', 'progress'] : ['nextStep', 'progress', 'outcome'];
  const open = items.filter(item => !['done', 'completed', 'dropped'].includes(item.status));
  const candidates = status === 'done' || !open.some(item => item.kind === 'work-state') ? items : open;
  for (const field of fields) for (const item of candidates) {
    const raw = item[field]?.text;
    const first = typeof raw === 'string' ? raw.split(/;\s*|\.(?=\s+[A-Z])/)[0] : raw;
    const text = cleanText(first, 125);
    if (text) return text;
  }
  return status === 'done' ? 'Marked complete.' : status === 'quiet' ? 'No newer progress recorded.' : status === 'todo' ? 'Waiting to begin.' : 'No next step recorded yet.';
}

export function buildModel(snapshot, now = Date.now()) {
  // Human requests are constructed from their original human source, globally.
  // An agent, task, or observation can never create a top-level row here.
  const requests = (snapshot?.humanRequests || []).filter(request => request.id && cleanText(request.original?.text)).map(request => {
    const items = [...(request.items || [])].sort((a, b) => b.lastUpdateEpoch - a.lastUpdateEpoch);
    let status = statusFor(items, now);
    const recordedStatus = request.lifecycle?.explicit ? normalizeRecordedStatus(request.lifecycle.status) : null;
    const lifecycleStatus = request.lifecycle?.explicit && (request.lifecycle.complete === true || ['done', 'completed', 'complete', 'shipped', 'delivered'].includes(recordedStatus)) ? 'done' : recordedStatus;
    if (['done', 'closed'].includes(status) && !['done', 'closed'].includes(lifecycleStatus)) status = 'unknown';
    if (lifecycleStatus && STATUS[lifecycleStatus]) status = lifecycleStatus;
    const copy = request.humanCopy;
    const title = cleanText(copy?.title || request.title || request.original.text, 115);
    const streams = (request.workstreams || []).map(stream => ({
      ...stream, title: cleanText(copy?.workstreams?.find(item => item.id === stream.id)?.title, 115) || 'Supporting work',
      status: statusFor(stream.items || [], now),
      summary: cleanText(copy?.workstreams?.find(item => item.id === stream.id)?.summary, 220) || 'A readable summary is being prepared from the recorded work.',
      activity: [...(stream.activity || [])].sort((a, b) => b.atEpoch - a.atEpoch),
    }));
    const projects = request.projects || [...new Set(items.map(item => item.project).filter(Boolean))];
    const agentIds = request.agentIds || [...new Set(items.map(item => item.agentId).filter(Boolean))];
    return {
      ...request, title, status,
      next: cleanText(copy?.next || copy?.summary, 240) || 'A readable update is being prepared.',
      summary: cleanText(copy?.summary, 300) || 'A readable summary is being prepared from the recorded work.',
      stage: cleanText(copy?.stage, 40) || 'Not recorded yet',
      copyState: copy?.state || 'pending', items, workstreams: streams,
      project: projects[0] || '', projects, agentIds,
      updated: request.updatedAtEpoch || Math.max(0, ...items.map(item => item.lastUpdateEpoch || 0)),
    };
  });
  const agents = (snapshot?.agents || []).map(agent => {
    const linked = requests.filter(request => request.agentIds.includes(agent.id));
    const updated = Date.parse(agent.presence?.lastActivityAt) || Math.max(0, ...linked.map(request => request.updated));
    return { ...agent, requests: linked, updated };
  });
  const requesters = new Set(requests.map(request => request.requestedBy).filter(Boolean));
  return { agents, requests, unlinked: snapshot?.unlinkedWork || [], teamMode: snapshot?.teamMode === true || requesters.size > 1, now };
}

const REQUEST_SORTS = new Set(['attention', 'latest', 'oldest', 'title']);
const requestTitleOrder = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function normalizeRequestSort(value) {
  return REQUEST_SORTS.has(value) ? value : 'attention';
}

const comparableCopy = value => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().replace(/(?:…|\.{3})+$/, '').trim()
  : '';
const nextCopyFallbacks = new Set(['A readable update is being prepared.', 'No next step recorded yet.']);

export function requestCardCopy(request) {
  const summary = request.summary ?? '';
  const next = typeof request.next === 'string' ? request.next : '';
  const copy = request.humanCopy;
  const sourceSummary = comparableCopy(copy?.summary ?? summary);
  const sourceNext = comparableCopy(copy?.next ?? next);
  // The model falls back to the summary when human copy has no next step.
  // Compare original copy before display truncation so distinct steps survive.
  const absentNext = !comparableCopy(next) || (copy && !comparableCopy(copy.next));
  if (absentNext || nextCopyFallbacks.has(comparableCopy(next)) || (sourceSummary && sourceNext === sourceSummary)) {
    return { summary, next: null, nextLabel: null };
  }
  return {
    summary, next,
    nextLabel: ['done', 'closed'].includes(request.status) ? 'Outcome' : request.status === 'needs-you' ? 'Needs you' : 'Next step',
  };
}

function recordedUpdate(request) {
  return Number.isFinite(request.updated) && request.updated > 0 ? request.updated : 0;
}

function compareRequestTitles(a, b) {
  const byTitle = requestTitleOrder.compare(a.title, b.title);
  if (byTitle) return byTitle;
  const aId = String(a.id), bId = String(b.id);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function compareRequestUpdates(a, b, oldestFirst = false) {
  const aTime = recordedUpdate(a), bTime = recordedUpdate(b);
  // An unrecorded time must stay last in either direction.
  if (!aTime || !bTime) return aTime === bTime ? 0 : aTime ? -1 : 1;
  return oldestFirst ? aTime - bTime : bTime - aTime;
}

export function filteredRequests(model, { project = 'all', period = 'day', query = '', agentId = null, status = 'all', sort = 'attention' } = {}) {
  const cutoff = period === 'day' ? model.now - 86400000 : period === 'week' ? model.now - 7 * 86400000 : 0;
  const needle = query.trim().toLowerCase();
  const order = normalizeRequestSort(sort);
  const agentSearch = new Map((model.agents || []).map(agent => [agent.id, `${agent.label || ''} ${agent.platformSource || ''}`]));
  return model.requests.filter(r => (!agentId || r.agentIds.includes(agentId)) && (project === 'all' || r.projects.includes(project)) && recordedUpdate(r) >= cutoff && (status === 'all' || r.status === status) && (!needle || `${r.title} ${r.original.text} ${r.next} ${r.projects.join(' ')} ${r.agentIds.map(id => agentSearch.get(id) || '').join(' ')}`.toLowerCase().includes(needle)))
    .sort((a, b) => {
      if (order === 'title') return compareRequestTitles(a, b);
      const byStatus = order === 'attention' ? STATUS[a.status].rank - STATUS[b.status].rank : 0;
      return byStatus || compareRequestUpdates(a, b, order === 'oldest') || compareRequestTitles(a, b);
    });
}

export function requestViewChanged(beforeModel, afterModel, options = {}) {
  const before = filteredRequests(beforeModel, options);
  const after = filteredRequests(afterModel, options);
  if (before.length !== after.length || before.some((request, index) => request.id !== after[index].id || request.status !== after[index].status)) return true;
  const statusCounts = model => {
    const counts = new Map();
    for (const request of filteredRequests(model, { ...options, status: 'all' })) {
      counts.set(request.status, (counts.get(request.status) || 0) + 1);
    }
    return counts;
  };
  const beforeCounts = statusCounts(beforeModel), afterCounts = statusCounts(afterModel);
  return beforeCounts.size !== afterCounts.size || [...beforeCounts].some(([status, count]) => afterCounts.get(status) !== count);
}

export function activityFor(workstream, _agent = null, limit = 5) {
  const all = [...(workstream.activity || [])];
  for (const item of workstream.items || []) {
    if (all.some(a => a.url === item.url)) continue;
    all.push({ id: `record:${item.id}`, kind: item.kind === 'work-state' ? 'work-state' : 'observation', title: item.title, detail: item.progress?.text || item.outcome?.text, atEpoch: item.lastUpdateEpoch, at: item.lastUpdateAt, url: item.url });
  }
  return all.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, limit);
}

export function agentIcon(agent) {
  const name = { codex: 'chatgpt', claude: 'claude', 'gemini-cli': 'gemini', 'hermes-cli': 'hermes' }[agent.platformSource];
  return name ? `/assets/agents/${name}.svg` : null;
}
