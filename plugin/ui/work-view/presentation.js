import { buildModel, cleanText, activityFor, agentIcon, STATUS } from './view-model.js';

// Local source text is always enough to render this view. Generated copy is
// optional evidence left by other tools, never a prerequisite or a new call.
export function presentWork(snapshot, previous = [], now = Date.now()) {
  const model = buildModel(snapshot, now);
  const originals = new Map((snapshot?.humanRequests || []).map(request => [request.id, request]));
  const agents = new Map(model.agents.map(agent => [agent.id, agent]));
  const order = new Map(previous.map((row, index) => [row.id, index]));
  const rows = model.requests.map(request => {
    const agent = agents.get(request.agentIds[0]);
    const platformIcon = agent && agentIcon(agent);
    const items = request.items || [];
    const updates = [...request.workstreams.flatMap(stream => activityFor(stream)), ...items.map(item => ({
      title: item.title, detail: item.progress?.text || item.outcome?.text, atEpoch: item.lastUpdateEpoch,
    }))].sort((a, b) => (b.atEpoch || 0) - (a.atEpoch || 0)).map(item => ({
      text: cleanText(item.detail || item.title, 400), at: item.atEpoch,
    })).filter((item, index, all) => item.text && all.findIndex(other => other.text === item.text) === index).slice(0, 8);
    const hasCopy = request.humanCopy && request.copyState === 'current';
    const status = ({ 'in-progress': 'working', 'needs-you': 'needs', done: 'ready' })[request.status] || request.status;
    const activity = hasCopy ? request.summary : updates[0]?.text || cleanText(request.original?.text, 300) || 'No progress update has been recorded.';
    const next = hasCopy ? request.next : cleanText(items.find(item => item.nextStep?.text)?.nextStep?.text, 300)
      || (status === 'ready' ? 'Read the reported result and recorded evidence.' : status === 'needs' ? 'Read the handoff, then continue in the original work conversation.' : 'Follow the latest recorded activity.');
    return {
      ...request, status, sourceLabel: STATUS[request.status]?.label, activity, summary: activity, next,
      title: hasCopy ? request.title : cleanText(originals.get(request.id)?.title || request.original?.text, 220),
      agent: agent?.label || 'Contributor not recorded',
      role: request.agentIds.length > 1 ? `${request.agentIds.length} contributors` : 'Recorded work',
      icon: platformIcon?.replace('/assets/', '/work-view/assets/') ?? null,
      project: request.project || 'Local project', updates,
      evidence: [...items.map(item => cleanText(item.outcome?.text, 500)).filter(Boolean), ...updates.map(item => item.text)].filter((text, index, all) => all.indexOf(text) === index).slice(0, 8),
      outcome: cleanText(items.find(item => item.outcome?.text)?.outcome?.text, 1000) || activity,
    };
  }).sort((a, b) => {
    if (order.has(a.id) || order.has(b.id)) return (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity);
    return b.updated - a.updated || a.id.localeCompare(b.id);
  });
  return { rows, unlinked: model.unlinked };
}

export const effectiveStatus = row => row.review?.checked ? 'checked' : row.status;
export const statusCategory = row => ['working', 'needs', 'ready', 'checked'].includes(effectiveStatus(row)) ? effectiveStatus(row) : 'other';
export const contentSignature = row => JSON.stringify([row.contentFingerprint, row.review, row.title, row.status, row.activity, row.next, row.updates]);

export function scopeWork(rows, { query = '', range = 'all', project = '', now = Date.now() } = {}) {
  const since = range === 'day' ? now - 86400000 : range === 'week' ? now - 7 * 86400000 : 0;
  const search = query.trim().toLowerCase();
  return rows.filter(row => row.updated >= since && (!project || row.project === project || row.projects?.includes(project))
    && (!search || `${row.title} ${row.activity} ${row.agent} ${(row.projects || [row.project]).join(' ')}`.toLowerCase().includes(search)));
}

export function handoffText(row) {
  const status = ({ working: 'In progress', needs: 'Needs you', ready: 'Reported complete', checked: 'Checked locally' })[effectiveStatus(row)] || row.sourceLabel || 'Recorded update';
  return [
    `Request: ${row.original?.text || row.title}`,
    `Project: ${row.project}`,
    `Recorded state: ${status}`,
    `Next step: ${row.next}`,
    '', 'Latest recorded updates:',
    ...(row.updates.length ? row.updates.slice(0, 4).map(update => `- ${update.text}`) : ['- No detailed updates recorded.']),
    '', 'Continue in the original work conversation. This handoff does not assign or send work.',
  ].join('\n');
}
