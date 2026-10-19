import { activityFor, cleanText, durationLabel, progressMeter, relativeTime, requestElapsed, STATUS, velocity } from './view-model.js';
import { effectiveStatus } from './presentation.js';

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const esc = escapeHTML;
const labels = { working: 'In progress', needs: 'Needs you', ready: 'Ready to check', checked: 'Checked' };
const chevron = '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="m9 5 7 7-7 7" stroke="currentColor" stroke-width="1.7"/></svg>';
// Worktree checkouts record "repo/worktree"; people know the repo.
const projectLabel = project => String(project || 'Unknown project').split('/')[0];
const projectNames = row => [...new Set((row.projects || [row.project]).filter(Boolean).map(projectLabel))].join(' · ');

export function personalRoute(view, state = {}) {
  if (['goals', 'story', 'teambrain'].includes(view)) return `#${view}`;
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries({ id: view === 'request' ? state.requestId : null, work: view === 'request' ? state.workId : null, agent: state.agentId, from: view === 'request' ? state.from : null, project: state.project, range: state.range, sort: state.sort, status: state.filter, q: state.query })) {
    if (value && !((key === 'range' && value === 'day') || (key === 'sort' && value === 'attention') || (key === 'status' && value === 'all'))) parameters.set(key, value);
  }
  return `#${view}${parameters.size ? `?${parameters}` : ''}`;
}

export function parsePersonalRoute(hash) {
  const [rawView, query = ''] = hash.replace(/^#/, '').split('?');
  const parameters = new URLSearchParams(query);
  const view = ['cards', 'list', 'agents', 'request', 'goals', 'story', 'teambrain'].includes(rawView) ? rawView : rawView === 'board' ? 'list' : 'cards';
  return { view, requestId: parameters.get('id'), workId: parameters.get('work'), agentId: parameters.get('agent'),
    from: ['cards', 'list', 'agents'].includes(parameters.get('from')) ? parameters.get('from') : 'cards',
    project: parameters.get('project') || '', range: ['all', 'week'].includes(parameters.get('range')) ? parameters.get('range') : 'day',
    sort: ['latest', 'oldest', 'title'].includes(parameters.get('sort')) ? parameters.get('sort') : 'attention',
    filter: ['working', 'needs', 'ready', 'checked', 'quiet', 'blocked', 'todo', 'unknown', 'closed', 'other'].includes(parameters.get('status')) ? parameters.get('status') : 'all', query: parameters.get('q') || '' };
}

export function badge(row) {
  const status = effectiveStatus(row);
  const shape = status === 'needs' ? '!' : ['ready', 'checked'].includes(status) ? '✓' : '';
  return `<span class="status status-${esc(status)}"><span class="status-icon" aria-hidden="true">${shape}</span>${esc(labels[status] || row.sourceLabel || STATUS[status]?.label || 'Recorded update')}</span>`;
}
const time = updated => {
  const epoch = Number(updated) || 0;
  return `<time class="card-time" data-time="${epoch}"${epoch > 0 ? ` datetime="${new Date(epoch).toISOString()}" title="${esc(new Date(epoch).toLocaleString())}"` : ''}>${esc(relativeTime(epoch))}</time>`;
};
// One line per tool, as on the approved cards: "Codex · 5 contributors".
export function contributors(agents = []) {
  const groups = new Map();
  for (const agent of agents) {
    const key = agent.platformSource || agent.label || 'Contributor';
    const group = groups.get(key) || { label: agent.label || 'Contributor', icon: agent.icon, count: 0 };
    group.count++; groups.set(key, group);
  }
  return [...groups.values()].map(group => `<span class="card-contributor">${group.icon ? `<img src="${esc(group.icon)}" width="25" height="25" alt="">` : ''}<span>${esc(group.label)}${group.count > 1 ? `<span class="contributor-count"> · ${group.count} contributors</span>` : ''}</span></span>`).join('') || '<span class="contributor-count">No contributor recorded</span>';
}
// The meter shows the request-progress review, separate from the recorded status.
export function meter(row) {
  const progress = progressMeter(row.progress);
  if (!progress) return '';
  return `<div class="progress-meter" data-state="${esc(progress.state)}"><span class="meter-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}" aria-label="Progress from memory review"><span style="width:${progress.percent}%"></span></span><span class="meter-label">${esc(progress.label)}</span></div>`;
}
function copyNote(row) {
  return row.humanCopy && ['pending', 'outdated'].includes(row.copyState) ? '<small class="copy-note">Summary updating</small>' : '';
}
function nextCopy(row) {
  if (effectiveStatus(row) === 'checked') return { label: 'Checked locally', text: 'You reviewed this version. New work will need a fresh check.' };
  const summary = String(row.activity || '').replace(/\s+/g, ' ').trim();
  const next = String(row.next || '').replace(/\s+/g, ' ').trim();
  const comparable = text => text.toLocaleLowerCase().replace(/[\s.!?…]+$/u, '');
  if (!next || comparable(next) === comparable(summary) || comparable(next) === 'follow the latest recorded activity') return null;
  const hasSummary = row.humanCopy && ['current', 'outdated'].includes(row.copyState);
  return { label: hasSummary ? 'Next step' : 'Recorded next step', text: next };
}
const botIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3v3m-1-3h2M5 10H3v7h2m14-7h2v7h-2"/><rect x="5" y="6" width="14" height="14" rx="4"/><path d="M8 15h.01M16 15h.01M9 17h6" stroke-linecap="round"/></svg>';
const personIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="7" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3" stroke-linecap="round"/></svg>';
export function nextSteps(row, compact = false) {
  const status = effectiveStatus(row);
  // Free-text plans do not identify their actor. Icons only label the explicit
  // recorded state and the available human handoff; they never assign the plan.
  const recorded = status === 'checked' || row.nextSource === 'fallback' ? null : nextCopy(row);
  const agent = status === 'ready' ? 'This request is reported complete.' : status === 'needs' ? 'Waiting for your input.' : null;
  const human = status === 'ready' ? 'Review the result and recorded evidence.' : status === 'needs' ? 'Read the handoff, then continue in the original conversation.' : status === 'checked' ? 'You checked this version. Review again when new work arrives.' : null;
  if (!recorded && !human) return '';
  return `<div class="${compact ? 'card-next' : 'request-next'} next-steps"><${compact ? 'span' : 'h3'} class="${compact ? 'card-next-label' : 'next-steps-heading'}">What’s next</${compact ? 'span' : 'h3'}>${recorded ? `<div class="next-step-neutral"><span class="next-step-label">${esc(recorded.label)}</span><p>${esc(recorded.text)}</p></div>` : ''}${agent ? `<div class="next-step-person next-step-agent">${botIcon}<div><span class="next-step-label">Agent</span><p>${esc(agent)}</p></div></div>` : ''}${human ? `<div class="next-step-person next-step-human">${personIcon}<div><span class="next-step-label">You</span><p>${esc(human)}</p></div></div>` : ''}</div>`;
}
export function requestCards(rows, state) {
  return rows.map(row => {
    const status = effectiveStatus(row);
    const route = personalRoute('request', { ...state, requestId: row.id, workId: null, from: state.view });
    const action = status === 'ready' ? 'Review result' : status === 'needs' ? 'Read handoff' : 'Open request';
    return `<article class="request-card work-card status-${esc(status)}${state.changed?.has(row.id) ? ' updated' : ''}" data-id="${esc(row.id)}" tabindex="-1"><a class="request-card-open" href="${esc(route)}" data-route aria-label="${esc(action)}: ${esc(row.title)}">
      <div class="request-card-meta">${badge(row)}<span>${time(row.updated)}${state.unread?.has(row.id) ? '<span class="new-dot">New update</span>' : ''}</span></div>
      <div class="request-card-body"><div class="request-card-copy"><h2>${esc(row.title)}</h2><div class="card-update"><span class="card-update-label">${row.humanCopy && ['current', 'outdated'].includes(row.copyState) ? 'Latest update' : 'Latest recorded update'}</span><p class="request-card-summary">${esc(row.activity)}</p>${copyNote(row)}</div>${meter(row)}${productSummary(row)}</div></div>
      ${nextSteps(row, true)}
      <div class="request-card-footer"><div class="request-card-context"><div class="request-contributors" aria-label="Recorded contributors">${contributors(row.contributors)}</div><span class="card-project" title="${esc((row.projects || [row.project]).join(' · '))}">${esc(projectNames(row))}</span></div><span class="open-label">${action} ${chevron}</span></div>
    </a></article>`;
  }).join('');
}

export function requestList(rows, state) {
  return `<div class="board-surface request-list-surface"><table class="work-table" aria-label="Requests"><thead><tr><th scope="col">Status</th><th scope="col">Request</th><th scope="col">What’s next / latest update</th><th scope="col">Last update</th><th scope="col"><span class="sr-only">Open request</span></th></tr></thead><tbody>${rows.map(row => {
    const route = personalRoute('request', { ...state, requestId: row.id, workId: null, from: 'list' });
    const next = nextSteps(row, true), progressLabel = next ? 'What’s next' : (row.humanCopy && ['current', 'outdated'].includes(row.copyState) ? 'Latest update' : 'Latest recorded update');
    return `<tr class="work-row" data-id="${esc(row.id)}"><td data-label="Status">${badge(row)}</td><td data-label="Request"><a class="request-title" href="${esc(route)}" data-route>${esc(row.title)}</a><p class="project-name">${esc(projectNames(row))}</p>${meter(row)}</td><td class="list-progress" data-label="${esc(progressLabel)}">${next || `<span class="list-copy-label">${esc(progressLabel)}</span><p class="next-copy">${esc(row.activity)}</p>`}${copyNote(row)}</td><td data-label="Last update">${time(row.updated)}</td><td class="row-arrow"><a href="${esc(route)}" data-route aria-label="Open request: ${esc(row.title)}">${chevron}</a></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

export function agentCards(rows, state) {
  const agents = new Map();
  for (const row of rows) for (const agent of row.contributors || []) {
    if (!agents.has(agent.id)) agents.set(agent.id, { agent, requests: [] });
    agents.get(agent.id).requests.push(row);
  }
  return [...agents.values()].map(({ agent, requests }) => {
    const recent = [...requests].sort((a, b) => b.updated - a.updated), latest = recent[0];
    const route = personalRoute('agents', { ...state, agentId: agent.id, requestId: null, workId: null });
    return `<article class="agent-card"><a class="agent-open" href="${esc(route)}" data-route><div class="agent-top"><span class="agent-avatar">${agent.icon ? `<img src="${esc(agent.icon)}" width="32" height="32" alt="">` : esc((agent.label || '?').slice(0, 1))}</span><div class="agent-identity"><h2>${esc(agent.label)}</h2><p>${esc(agent.agentType && !['main', 'default'].includes(agent.agentType) ? agent.agentType : 'Recorded contributor')}</p></div>${time(latest.updated)}</div><div class="agent-latest"><span class="agent-section-label">Most recently updated request</span>${badge(latest)}<p class="agent-summary">${esc(latest.title)}</p><p class="agent-update">${esc(latest.activity)}</p>${copyNote(latest)}</div>${recent.length > 1 ? `<div class="agent-other-requests"><span class="agent-section-label">Also contributing to</span><p>${esc(recent[1].title)}</p>${recent.length > 2 ? `<span class="agent-more">+${recent.length - 2} more ${recent.length - 2 === 1 ? 'request' : 'requests'}</span>` : ''}</div>` : ''}<div class="agent-footer"><span>${requests.length} human ${requests.length === 1 ? 'request' : 'requests'}</span><span class="open-label">View requests ${chevron}</span></div></a></article>`;
  }).join('') || `<div class="empty-work agent-empty"><h3>No contributors in this view</h3><p>Requests without a recorded contributor are still available in your list.</p><a class="agent-empty-link" href="${esc(personalRoute('list', { ...state, agentId: null }))}" data-route>Browse requests ${chevron}</a></div>`;
}

export function sourceDisclosure(urls, label = 'Original source') {
  const sources = [...new Set(urls)].flatMap(url => {
    const match = String(url).match(/^\/api\/work-view\/evidence\/(work-state|observation|prompt|summary|session)\/(\d+)$/);
    return match ? [`<button type="button" class="source-link" data-evidence-kind="${match[1]}" data-evidence-id="${match[2]}">Read ${match[1]} #${match[2]}</button>`] : [];
  }).join(' ');
  return sources ? `<details class="source-details" data-evidence-record data-detail-key="${esc(`source:${label}:${urls.join('|')}`)}"><summary>${esc(label)}</summary><div class="source-content">${sources}<pre class="raw-source" hidden></pre></div></details>` : '';
}

export function requestFacts(row) {
  const started = Number.isFinite(row.startedAtEpoch) && row.startedAtEpoch > 0
    ? new Date(row.startedAtEpoch).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not recorded';
  return `<dl class="request-facts"><div><dt>Contributors</dt><dd class="request-contributors">${contributors(row.contributors)}</dd></div>${row.requestedBy ? `<div><dt>Requested by</dt><dd>${esc(row.requestedBy)}</dd></div>` : ''}<div><dt>Started</dt><dd>${esc(started)}</dd></div><div><dt>${row.completedAtEpoch ? 'Time to completion' : 'Elapsed'}</dt><dd data-request-elapsed="${esc(row.id)}" title="Time since the human request, not active agent runtime">${esc(requestElapsed(row))}</dd></div><div><dt>Stage</dt><dd>${esc(row.stage || 'Not recorded')}</dd></div><div><dt>Ship estimate</dt><dd>${esc(row.shipEstimate || 'Not estimated yet')}</dd></div></dl>`;
}

export function afterShip(row) {
  const data = row.afterShip || {};
  const sources = item => sourceDisclosure((item.sourceRefs || []).map(ref => `/api/work-view/evidence/${ref.kind}/${ref.id}`), 'Recorded source');
  const links = kind => (data.resources || []).filter(item => item.kind === kind).flatMap(item => {
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [`<li><a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${kind === 'documentation' ? 'Open documentation' : 'Open promotion material'}</a>${sources(item)}</li>`];
    } catch { return []; }
  }).join('');
  const docs = links('documentation'), promo = links('promotion');
  const categories = (data.classifications || []).map(item => `<li>${esc(cleanText(item.text, 160))}${sources(item)}</li>`).join('');
  if (!docs && !promo && !categories && !data.notes?.length) return '<section class="after-ship after-ship-empty"><h2>After ship</h2><p>No documentation, promotion material or classification recorded yet.</p></section>';
  return `<section class="after-ship"><h2>After ship</h2><p>Keep the documentation, promotion and classification with the work.</p><div class="after-ship-grid"><section class="after-ship-group"><h3>Documentation</h3>${docs ? `<ul>${docs}</ul>` : '<p class="empty-copy">No documentation linked yet.</p>'}</section><section class="after-ship-group"><h3>Promotion</h3>${promo ? `<ul>${promo}</ul>` : '<p class="empty-copy">No promotion material linked yet.</p>'}</section><section class="after-ship-group"><h3>Classification</h3>${categories ? `<ul>${categories}</ul>` : '<p class="empty-copy">Not classified yet.</p>'}</section></div>${(data.notes || []).map(note => `<div class="after-ship-note"><p>${esc(cleanText(note.text, 220))}</p>${sources(note)}</div>`).join('')}</section>`;
}

const PRODUCT_LABELS = { artifact: 'Artifact', page: 'Page', document: 'Document', deployment: 'Preview', 'pull-request': 'Pull request', image: 'Image', video: 'Video', deck: 'Deck', spreadsheet: 'Spreadsheet', documentation: 'Docs', promotion: 'Promotion', link: 'Link' };
const productLabel = kind => PRODUCT_LABELS[kind] || 'Link';

// A web link opens as recorded; a local file opens only through its record.
function productHref(product) {
  if (product.path) return product.available && /^\/api\/work-view\/file\/[\w-]+\/\d+\/\d+$/.test(product.fileUrl || '') ? product.fileUrl : null;
  try {
    const url = new URL(product.url);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function productPlace(product) {
  if (product.path) return product.available ? product.path.split('/').slice(-2, -1)[0] || '' : 'File moved or deleted';
  try { return new URL(product.url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** One line for a card: what this request produced, by kind. */
export function productSummary(row) {
  const products = row.workProduct || [];
  if (!products.length) return '';
  const counts = new Map();
  for (const product of products) counts.set(product.kind, (counts.get(product.kind) || 0) + 1);
  const parts = [...counts].map(([kind, count]) => `${count > 1 ? `${count} ` : ''}${productLabel(kind)}${count > 1 && !/s$/.test(productLabel(kind)) ? 's' : ''}`);
  return `<p class="card-products"><span class="card-products-label">Made</span> ${esc(parts.slice(0, 4).join(' · '))}${parts.length > 4 ? ` · ${parts.length - 4} more` : ''}</p>`;
}

/** Everything the request produced that a person can open. */
export function workProduct(row) {
  const products = row.workProduct || [];
  if (!products.length) return '';
  const tile = product => {
    const href = productHref(product), image = product.kind === 'image' && href;
    const body = `${image ? `<span class="product-thumb"><img src="${esc(href)}" alt="" loading="lazy"></span>` : ''}<span class="product-kind">${esc(productLabel(product.kind))}</span><span class="product-title">${esc(cleanText(product.title, 90))}</span><span class="product-place">${esc(productPlace(product))}</span>`;
    return `<li class="product-tile${image ? ' has-thumb' : ''}${href ? '' : ' unavailable'}">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${body}</a>` : `<div>${body}</div>`}</li>`;
  };
  return `<section class="work-product"><div class="section-heading"><h2>Work product</h2><span class="section-count">${products.length}</span></div><ul class="product-grid">${products.map(tile).join('')}</ul><p class="dialog-note">Found in this request's recorded tool calls, file changes and work updates.</p></section>`;
}

const USAGE_LABELS = { 'in-use': 'In use', 'some-use': 'Some use', 'no-evidence': 'No evidence of use', unknown: 'Unknown' };
const VALUE_LABELS = { high: 'High value', medium: 'Some value', low: 'Low value', unclear: 'Value unclear' };

function outcomeEvidence(evidence = []) {
  return evidence.length ? `<span class="outcome-evidence">${esc(evidence.slice(0, 3).join(' · '))}</span>` : '';
}

/** How released work landed, from the same review as the build story. */
export function howItLanded(row) {
  const outcome = row.progress?.outcome;
  if (!outcome) return '';
  const fact = (label, level, entry) => entry ? `<div><dt>${esc(label)}</dt><dd>${level ? `<strong>${esc(level)}</strong> ` : ''}${esc(entry.text)}${outcomeEvidence(entry.evidence)}</dd></div>` : '';
  const regressions = outcome.regressions || [], changes = outcome.changes || [];
  return `<section class="how-it-landed"><h2>How it landed</h2><dl class="outcome-facts">
    ${fact('Landed', null, outcome.landed)}${fact('Usage', USAGE_LABELS[outcome.usage?.level], outcome.usage)}${fact('Value to us', VALUE_LABELS[outcome.value?.level], outcome.value)}
    <div><dt>Regressions</dt><dd>${regressions.length ? `<ul>${regressions.map(item => `<li>${esc(item.text)}${item.fixedBy ? ` <span class="outcome-fixed">Fixed by ${esc(item.fixedBy)}</span>` : ' <span class="outcome-open">Not fixed yet</span>'}${outcomeEvidence(item.evidence)}</li>`).join('')}</ul>` : 'None found in memory.'}</dd></div>
  </dl>${changes.length ? `<h3>Why it changed</h3><ol class="outcome-changes">${changes.map(change => `<li><strong>${esc(change.what)}</strong><p>${esc(change.why)}</p>${outcomeEvidence(change.evidence)}</li>`).join('')}</ol>` : ''}<p class="dialog-note">Reviewed from memory with the cited evidence. It is an assessment, separate from the recorded status.</p></section>`;
}

export function requestPage(row, state) {
  return `<div class="request-page"><div class="request-heading"><h1 tabindex="-1">${esc(row.title)}</h1><div class="request-meta">${badge(row)}<span>${esc(projectNames(row))}</span>${time(row.updated)}</div></div>
    <section class="request-overview"><h2>Where it stands</h2><p>${esc(row.activity)}</p>${copyNote(row)}${nextSteps(row)}</section>
    <div class="request-actions">${effectiveStatus(row) === 'ready' ? `<button type="button" class="button-primary" data-review="${esc(row.id)}">Review result</button>` : effectiveStatus(row) === 'checked' ? `<button type="button" class="button-secondary" data-undo="${esc(row.id)}">Undo check</button>` : ''}<button type="button" class="button-secondary" data-copy-handoff="${esc(row.id)}">Copy handoff</button><a class="source-link" href="/viewer">Memory &amp; sessions →</a></div><p class="dialog-note" id="handoff-feedback" role="status"></p><label class="sr-only" for="handoff-text">Handoff text to copy</label><textarea class="raw-source" id="handoff-text" readonly rows="9" hidden></textarea>
    <details class="original-request request-context" data-detail-key="${esc(`request:${row.id}:context`)}"><summary>Request context &amp; original</summary><div class="original-body">${requestFacts(row)}<h3>Original request</h3><p>${esc(row.original?.text || 'No original request text was recorded.')}</p>${sourceDisclosure([row.original?.url], 'Read full original')}</div></details>
    <div class="section-heading"><h2>Work behind this request</h2></div><div class="workstream-list">${row.workstreams.map(work => `<article class="workstream-row"><a class="workstream-open" href="${esc(personalRoute('request', { ...state, requestId: row.id, workId: work.id }))}" data-route><div class="workstream-text"><h3>${esc(work.title)}</h3><p>${esc(work.summary)}</p><div class="request-contributors">${contributors(work.contributors)}</div></div>${badge({ status: work.status })}${chevron}</a></article>`).join('') || '<p class="workstream-empty">No linked workstreams have been recorded yet.</p>'}</div>
    ${row.scopeUpdates?.length ? `<details class="original-request" data-detail-key="${esc(`request:${row.id}:followups`)}"><summary>Follow-ups to this request</summary><div class="original-body">${row.scopeUpdates.map(update => `<p>${esc(update.text)}</p>${sourceDisclosure([update.url])}`).join('')}</div></details>` : ''}
    ${workProduct(row)}
    ${buildStory(row)}
    ${howItLanded(row)}
    ${afterShip(row)}
  </div>`;
}

function buildStory(row) {
  const progress = row.progress;
  if (!progress) return '';
  const checked = Date.parse(progress.checkedAt);
  const milestones = (progress.milestones || []).map(milestone => `<li>${milestone.at ? time(Date.parse(milestone.at)) : '<span class="card-time">Date not recorded</span>'}<p>${esc(milestone.text)}</p></li>`).join('');
  return `<section class="build-story"><h2>Build story</h2>${meter(row)}<p>${esc(progress.narrative || progress.summary)}</p>${milestones ? `<ol class="milestones">${milestones}</ol>` : ''}<p class="dialog-note">Reviewed from memory${Number.isFinite(checked) ? ` ${esc(relativeTime(checked))}` : ''}. This is an assessment, separate from the recorded status.</p></section>`;
}

// Story: shipping velocity, the build narrative and learned working
// preferences, all written by the request-progress skill.
export function storyPanel(data) {
  const heading = subtitle => `<div class="goals-heading"><div><p class="eyebrow">How your requests turned into shipped work</p><h1 id="story-heading" tabindex="-1">Build story</h1>${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}</div></div>`;
  if (!data?.reviews?.length) return `${heading('')}<div class="empty-work"><h2>No build story yet</h2><p>Ask your agent to run the request-progress skill. It groups your conversations into overall requests, reviews each one from memory and writes the story.</p></div>`;
  const stats = velocity(data.reviews);
  const peak = Math.max(1, ...stats.weekly.map(week => week.count));
  const tile = (value, label) => `<div class="velocity-tile"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
  const reviews = [...data.reviews].sort((a, b) => String(b.shippedAt || b.lastActivityAt || '').localeCompare(String(a.shippedAt || a.lastActivityAt || '')));
  const narrative = (data.story?.narrative || '').split(/\n{2,}/).map(block => block.trim()).filter(Boolean).map(block => /^#{1,3}\s/.test(block) ? `<h3>${esc(block.replace(/^#{1,3}\s+/, ''))}</h3>` : `<p>${esc(block.replace(/\n/g, ' '))}</p>`).join('');
  const preferences = (data.story?.preferences || []).map(item => `<li><p><strong>${esc(item.preference)}</strong> <span class="pref-meta">${esc(item.kind)} · seen ${esc(item.supportCount)}×</span></p>${(item.quotes || []).map(quote => `<blockquote>“${esc(quote.quote)}”${quote.at ? ` <time class="card-time">${esc(new Date(quote.at).toLocaleDateString())}</time>` : ''}</blockquote>`).join('')}</li>`).join('');
  return `${heading(`${stats.reviewed} overall requests reviewed from memory across ${data.groups} linked groups.`)}
    <section class="story-section"><h2>Shipping velocity</h2><div class="velocity-tiles">${tile(stats.shipped7, 'shipped in 7 days')}${tile(stats.shipped30, 'shipped in 30 days')}${tile(stats.medianCycleMs == null ? '—' : durationLabel(stats.medianCycleMs), 'median ask to ship')}${tile(stats.inProgress, 'in progress')}${tile(stats.stalled, 'stalled')}</div>
    <div class="weekly-bars" role="img" aria-label="Requests shipped per week, last ${stats.weekly.length} weeks: ${stats.weekly.map(week => week.count).join(', ')}">${stats.weekly.map(week => `<span class="week-bar" title="Week of ${esc(new Date(week.start).toLocaleDateString())}: ${week.count} shipped"><span style="height:${Math.round(week.count / peak * 100)}%"></span><small>${week.count}</small></span>`).join('')}</div></section>
    ${narrative ? `<section class="story-section story-narrative"><h2>What we built</h2>${narrative}</section>` : ''}
    <section class="story-section"><h2>Requests</h2><ul class="story-requests">${reviews.map(review => `<li><div><h3>${esc(review.title)}</h3><p>${esc(review.summary)}</p></div>${meter({ progress: review })}</li>`).join('')}</ul></section>
    ${preferences ? `<section class="story-section preferences"><h2>How you like to work with agents</h2><p class="dialog-note">Taken from your own prompts, with the quotes behind each one.</p><ul>${preferences}</ul></section>` : ''}`;
}

export function workstreamPage(row, work) {
  const activity = activityFor(work, null, 100);
  return `<div class="records-page"><div class="request-heading"><p class="workstream-parent">Part of ${esc(row.title)}</p><h1 tabindex="-1">${esc(work.title)}</h1><div class="request-meta">${badge({ status: work.status })}<div class="request-contributors">${contributors(work.contributors)}</div></div></div><div class="records-intro"><p>${esc(work.summary)}</p></div><div class="section-heading"><h2>Recorded changes</h2></div><ul class="records-list">${activity.map(item => `<li><div class="record-meta">${time(item.atEpoch)}<span>${item.kind === 'work-state' ? 'Work update' : 'Observation'}</span></div><div class="record-copy"><p>${esc(item.title || item.detail)}</p>${item.detail && item.detail !== item.title ? `<p class="record-detail">${esc(item.detail)}</p>` : ''}</div>${sourceDisclosure([item.url])}</li>`).join('') || '<li>No detailed updates have been recorded yet.</li>'}</ul></div>`;
}

// Goals: the owner's top priorities and open asks, each with the dated quotes
// from the owner's own prompts that support it (saved by the owner-goals skill).
function goalItem(item, { lead = false } = {}) {
  const evidence = item.evidence || [];
  const meta = [item.timesAsked > 1 ? `<span class="goal-recurrence">Asked ${esc(item.timesAsked)} times</span>` : '', item.product ? `<span>${esc(item.product)}</span>` : '', item.latestAt ? `<span>Last mentioned ${goalDate(item.latestAt)}</span>` : ''].filter(Boolean).join('');
  return `<li class="goal-item${lead ? ' goal-lead' : ''}"><span class="goal-rank" aria-hidden="true">${esc(item.rank ?? '•')}</span><div class="goal-copy">${lead ? '<p class="goal-lead-label">Your clearest priority</p>' : ''}<p class="goal-title">${esc(item.title)}</p><div class="goal-line">${meta ? `<p class="goal-meta">${meta}</p>` : ''}${evidence.length ? `<details class="goal-evidence" data-goal="${esc(item.id)}"><summary>Why it's here <span class="goal-evidence-count">${evidence.length} ${evidence.length === 1 ? 'quote' : 'quotes'}</span></summary><ul>${evidence.map(quote => `<li>${quote.at ? goalDate(quote.at, true) : ''}<q>${esc(quote.quote)}</q></li>`).join('')}</ul></details>` : ''}</div></div></li>`;
}
// These are signals from the saved goal map, not measurements of completed work.
export function goalSignals(goals = {}) {
  const priorities = goals?.priorities || [];
  const openAsks = goals?.openAsks || [];
  return { priorities, openAsks, repeatedAsks: openAsks.filter(item => Number.isFinite(item.timesAsked) && item.timesAsked > 1), lead: priorities[0] || null };
}
const shortDay = (day, withYear) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
// The source has a local wall-clock date, not a guaranteed timezone. Keep it
// intact in datetime/title and format the calendar day without shifting it.
function goalDate(value, full = false) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (!match || !Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`))) return `<span>${esc(raw)}</span>`;
  const date = shortDay(match[1], full);
  return `<time datetime="${esc(match[1] + (match[2] ? `T${match[2]}` : ''))}" title="${esc(raw)}">${esc(date)}${full && match[2] ? ` · ${esc(match[2])}` : ''}</time>`;
}
// "Nov 18 – Dec 18, 2025", or with both years when the period crosses New Year.
export function goalsPeriod(goals) {
  if (!goals?.periodStart) return '';
  if (!goals.periodEnd) return `From ${shortDay(goals.periodStart, true)}`;
  const sameYear = goals.periodStart.slice(0, 4) === goals.periodEnd.slice(0, 4);
  return `${shortDay(goals.periodStart, !sameYear)} – ${shortDay(goals.periodEnd, true)}`;
}
const monthLabel = goals => goals.history ? `${goalsPeriod(goals) || goals.listName} · history` : `${goalsPeriod(goals) || 'This month'} · current`;

// The current month first, then past months newest first; `selected` is a list name.
export function goalsPanel(current, { history = [], selected = '', askFilter = 'all' } = {}) {
  const months = [current, ...history].filter(goals => goals && (goals.priorities?.length || goals.openAsks?.length));
  if (!months.length) return '';
  const index = Math.max(0, months.findIndex(goals => goals.listName === selected));
  const goals = months[index];
  const source = [goals.history ? monthLabel(goals) : goals.windowDays ? `Last ${goals.windowDays} days` : '', goals.sourcePromptCount ? `${goals.sourcePromptCount} prompts you typed` : '', goals.generatedAt ? `Mapped ${String(goals.generatedAt).slice(0, 10)}` : ''].filter(Boolean).join(' · ');
  const step = (target, label, glyph) => `<button type="button" class="goals-step" ${target ? `data-goals-month="${esc(target.listName)}"` : 'disabled'} aria-label="${label}">${glyph}</button>`;
  const switcher = months.length > 1 ? `<div class="goals-months" role="group" aria-label="Goals month">${step(months[index + 1], 'Older month', '‹')}<label><span class="sr-only">Goals month</span><select id="goals-month">${months.map((month, position) => `<option value="${esc(month.listName)}"${position === index ? ' selected' : ''}>${esc(monthLabel(month))}</option>`).join('')}</select></label>${step(months[index - 1], 'Newer month', '›')}</div>` : '';
  const { priorities, openAsks: asks, repeatedAsks } = goalSignals(goals);
  const filteredAsks = askFilter === 'repeated' ? repeatedAsks : asks;
  const shownOpenAsks = 3;
  const more = filteredAsks.slice(shownOpenAsks);
  const asksHeading = goals.history ? 'Open asks then' : 'Open asks';
  const rest = priorities.slice(3);
  return `<div class="goals-heading"><div><p class="eyebrow">Your priorities &amp; follow-through</p><h1 id="goals-heading" tabindex="-1">Goals${goals.history ? ' <span class="goals-history-tag">History</span>' : ''}</h1></div>${switcher}</div>
    <div class="goals-overview${priorities.length && asks.length ? ' goals-overview-split' : ''}">
      ${priorities.length ? `<section class="goals-priorities" aria-label="Top priorities"><div class="goals-section-heading"><h3>${goals.history ? 'What mattered to you then' : 'What matters most to you'}</h3><span>${priorities.length} priorities</span></div><ol class="goal-list">${priorities.slice(0, 3).map((item, i) => goalItem(item, { lead: i === 0 })).join('')}</ol>${rest.length ? `<details class="goals-more" data-goal="more-priorities"><summary>${rest.length} more priorities</summary><ol class="goal-list" start="4">${rest.map(goalItem).join('')}</ol></details>` : ''}</section>` : ''}
      ${asks.length ? `<aside class="goals-follow-through" aria-labelledby="goals-follow-heading"><p class="eyebrow">Worth a closer look</p><h3 id="goals-follow-heading">${repeatedAsks.length ? `<strong>${repeatedAsks.length}</strong> of ${asks.length} open asks${goals.history ? ' then' : ''} came up more than once.` : 'No repeated requests in this map.'}</h3><p>Repetition shows what keeps coming back. It doesn’t tell us what’s finished.</p><button type="button" class="goal-repeat-action" data-goals-filter="${repeatedAsks.length ? 'repeated' : 'all'}" data-goals-jump>${repeatedAsks.length ? 'See repeated requests' : 'Browse open asks'} <span aria-hidden="true">→</span></button></aside>` : ''}
    </div>
    ${asks.length ? `<details class="goals-all-asks" data-goal="all-open-asks"><summary><span class="goals-index-title">${asks.length} ${asksHeading.toLowerCase()}</span><span class="goals-index-hint">Browse requests from ${goals.history ? 'that period' : 'this month'}</span>${chevron}</summary><section class="goals-asks" aria-labelledby="goals-asks-heading"><div class="goals-asks-heading"><h3 id="goals-asks-heading" tabindex="-1">${asksHeading}</h3><div class="goals-ask-filters" role="group" aria-label="Filter open asks"><button type="button" data-goals-filter="all" aria-pressed="${askFilter !== 'repeated'}">All ${asks.length}</button><button type="button" data-goals-filter="repeated" aria-pressed="${askFilter === 'repeated'}">Repeated ${repeatedAsks.length}</button></div></div><ol class="goal-list">${filteredAsks.slice(0, shownOpenAsks).map(goalItem).join('')}</ol>${!filteredAsks.length ? '<p class="goals-empty-filter">No repeated requests in this map.</p>' : ''}${more.length ? `<details class="goals-more" data-goal="more-open-asks"><summary>${more.length} more ${askFilter === 'repeated' ? 'repeated requests' : `${goals.history ? '' : 'open '}${more.length === 1 ? 'ask' : 'asks'}`}</summary><ol class="goal-list" start="4">${more.map(goalItem).join('')}</ol></details>` : ''}</section></details>` : ''}
    <div class="goals-footnotes">${goals.summary ? `<details class="goals-narrative" data-goal="month-narrative"><summary>Read the month in full</summary><p class="goals-summary">${esc(goals.summary)}</p></details>` : ''}<details class="goals-narrative" data-goal="goals-method"><summary>How to read this</summary><p class="goals-summary">This map brings together priorities and open asks from your own prompts. Repeated asks are counted within the open requests only. Completion isn't linked to this map yet, so these counts don't measure finished work.${goals.history ? ' History preserves what was open then; it does not show whether those requests were completed later.' : ''}</p></details><p class="goals-source">${esc(source || 'From your own prompts')}</p></div>`;
}
