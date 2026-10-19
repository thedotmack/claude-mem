import { buildModel, cleanText, activityFor, agentIcon, STATUS } from './view-model.js';

// Local source text is always enough to render this view. Generated copy is
// preferred when present; while newer work is being summarized, the last good
// summary stays up (as on the approved cards) instead of raw notes.
export function presentWork(snapshot, previous = [], now = Date.now()) {
  const model = buildModel(snapshot, now);
  const originals = new Map((snapshot?.humanRequests || []).map(request => [request.id, request]));
  const agents = new Map(model.agents.map(agent => [agent.id, agent]));
  const order = new Map(previous.map((row, index) => [row.id, index]));
  const rows = model.requests.map(request => {
    const contributors = request.agentIds.map(id => agents.get(id)).filter(Boolean).map(agent => ({
      ...agent, icon: agentIcon(agent)?.replace('/assets/', '/work-view/assets/') ?? null,
    }));
    const agent = contributors[0];
    const platformIcon = agent && agentIcon(agent);
    const items = request.items || [];
    const updates = [...request.workstreams.flatMap(stream => activityFor(stream)), ...items.map(item => ({
      title: item.title, detail: item.progress?.text || item.outcome?.text, atEpoch: item.lastUpdateEpoch,
    }))].sort((a, b) => (b.atEpoch || 0) - (a.atEpoch || 0)).map(item => ({
      text: cleanText(item.detail || item.title, 400), at: item.atEpoch,
    })).filter((item, index, all) => item.text && all.findIndex(other => other.text === item.text) === index).slice(0, 8);
    const hasCopy = Boolean(request.humanCopy?.title) && ['current', 'outdated'].includes(request.copyState);
    const status = ({ 'in-progress': 'working', 'needs-you': 'needs', done: 'ready' })[request.status] || request.status;
    const activity = hasCopy ? request.summary : updates[0]?.text || cleanText(request.original?.text, 300) || 'No progress update has been recorded.';
    const next = hasCopy ? request.next : cleanText(items.find(item => item.nextStep?.text)?.nextStep?.text, 300)
      || (status === 'ready' ? 'Read the reported result and recorded evidence.' : status === 'needs' ? 'Read the handoff, then continue in the original work conversation.' : 'Follow the latest recorded activity.');
    return {
      ...request, status, sourceLabel: STATUS[request.status]?.label, activity, summary: activity, next, contributors,
      stage: cleanText(request.stageSourceText || (hasCopy ? request.stage : ''), 80) || 'Not recorded',
      workstreams: request.workstreams.map(stream => {
        const original = originals.get(request.id)?.workstreams?.find(item => item.id === stream.id);
        const current = hasCopy ? request.humanCopy?.workstreams?.find(item => item.id === stream.id) : null;
        const recorded = activityFor(stream, null, 20);
        return { ...stream,
          title: cleanText(current?.title || original?.title || stream.items?.[0]?.title, 115) || 'Supporting work',
          summary: cleanText(current?.summary || recorded[0]?.detail || recorded[0]?.title, 300) || 'No detailed update recorded.',
          contributors: (stream.agentIds || []).map(id => contributors.find(agent => agent.id === id)).filter(Boolean),
        };
      }),
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

const titleOrder = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const attention = { needs: 0, blocked: 1, ready: 2, working: 3, quiet: 4, todo: 5, unknown: 6, closed: 7, checked: 8 };
export function sortWork(rows, sort = 'attention') {
  return [...rows].sort((a, b) => {
    const title = () => titleOrder.compare(a.title, b.title) || String(a.id).localeCompare(String(b.id));
    if (sort === 'title') return title();
    const rank = sort === 'attention' ? (attention[effectiveStatus(a)] ?? 6) - (attention[effectiveStatus(b)] ?? 6) : 0;
    const aTime = Number.isFinite(a.updated) && a.updated > 0 ? a.updated : 0;
    const bTime = Number.isFinite(b.updated) && b.updated > 0 ? b.updated : 0;
    const time = !aTime || !bTime ? (aTime ? -1 : bTime ? 1 : 0) : sort === 'oldest' ? aTime - bTime : bTime - aTime;
    return rank || time || title();
  });
}

export function scopeWork(rows, { query = '', range = 'all', project = '', now = Date.now() } = {}) {
  const since = range === 'day' ? now - 86400000 : range === 'week' ? now - 7 * 86400000 : 0;
  const search = query.trim().toLowerCase();
  return rows.filter(row => row.updated >= since && (!project || row.project === project || row.projects?.includes(project))
    && (!search || `${row.title} ${row.activity} ${row.agent} ${(row.contributors || []).map(agent => `${agent.label} ${agent.agentType || ''}`).join(' ')} ${(row.projects || [row.project]).join(' ')}`.toLowerCase().includes(search)));
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
