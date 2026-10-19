import { setupTeamView } from './team-view.js';
import { relativeTime, requestElapsed } from './view-model.js';
import { presentWork, effectiveStatus, statusCategory, contentSignature, handoffText, scopeWork, sortWork } from './presentation.js';
import { personalRoute, parsePersonalRoute, requestCards, requestList, agentCards, requestPage, workstreamPage, goalsPanel, storyPanel } from './request-views.js';
import { getConnectionStatus } from './live-status.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { rows: [], unlinked: [], loaded: false, failed: false, snapshot: null, filter: 'all', query: '', range: 'day', project: '', sort: 'attention', goalsMonth: '', view: 'cards', from: 'cards', requestId: null, workId: null, agentId: null, pending: null, signature: '', lastReceived: 0, sourceConnected: false, changed: new Set(), unread: new Set(), previousCounts: {}, busy: false, toastTimer: null };
const connection = { transportConnected: false, reconnecting: false, lastEventAt: null, sourceConnected: null, lastSuccessfulCheckAt: null, lastSuccessfulCheckReceivedAt: null };
const labels = { all: 'All', needs: 'Needs you', working: 'In progress', quiet: 'No recent update', ready: 'Ready to check', checked: 'Checked', blocked: 'Blocked', todo: 'To do', unknown: 'Update recorded', closed: 'Closed', other: 'Other states' };
const rowById = id => state.rows.find(row => row.id === id);
const closeButton = '<button type="button" class="dialog-close" data-close aria-label="Close dialog">×</button>';
let teamView;
let lastWorkRoute = '#cards';
let renderedHash = '';
let pendingGoalFocus = null;
// Existing bookmarked memory routes continue to open the preserved viewer.
if (/^#\/?(?:sessions(?:\/|$)|session\/|observation\/|summary\/)/.test(location.hash)) location.replace(`/viewer${location.hash}`);
function announce(text) { $('announcement').textContent = ''; requestAnimationFrame(() => { $('announcement').textContent = text; }); }
function scopedRows() {
  return scopeWork(state.rows, state).filter(row => !state.agentId || row.agentIds.includes(state.agentId));
}
function visibleRows() { return sortWork(scopedRows().filter(row => state.filter === 'all' || (state.filter === 'other' ? statusCategory(row) === 'other' : effectiveStatus(row) === state.filter)), state.sort); }
function focusedGoalSelector() {
  const active = document.activeElement;
  if (!$('goals').contains(active)) return null;
  if (active.id) return `#${CSS.escape(active.id)}`;
  if (active.matches('summary') && active.parentElement.dataset.goal) return `[data-goal="${CSS.escape(active.parentElement.dataset.goal)}"] > summary`;
  if (active.hasAttribute('data-goals-jump')) return '[data-goals-jump]';
  if (active.dataset.goalsFilter) return `.goals-ask-filters [data-goals-filter="${CSS.escape(active.dataset.goalsFilter)}"]`;
  if (active.classList.contains('goals-step')) return `.goals-step[aria-label="${CSS.escape(active.getAttribute('aria-label'))}"]`;
  return null;
}
function render() {
  const goalFocus = focusedGoalSelector();
  const openGoals = new Set([...document.querySelectorAll('details[open][data-goal]')].map(element => element.dataset.goal));
  const goalsView = state.view === 'goals', storyView = state.view === 'story', teamActive = state.view === 'teambrain';
  teamView.setActive(teamActive);
  $('personal-workspace').hidden = goalsView || storyView || teamActive;
  $('goals-workspace').hidden = !goalsView;
  $('story-workspace').hidden = !storyView;
  $('updates-banner').hidden = teamActive;
  $('workspace-personal').setAttribute('aria-pressed', String(!goalsView && !storyView && !teamActive));
  $('workspace-goals').setAttribute('aria-pressed', String(goalsView));
  $('workspace-story').setAttribute('aria-pressed', String(storyView));
  $('workspace-team').setAttribute('aria-pressed', String(teamActive));
  document.title = `${goalsView ? 'Goals' : storyView ? 'Build story' : teamActive ? 'TeamBrain' : 'My Work'} · claude-mem`;
  if (storyView) {
    $('story').innerHTML = state.loaded ? storyPanel(state.snapshot?.story)
      : '<div class="goals-heading"><div><h1 id="story-heading" tabindex="-1">Build story</h1></div></div><div class="empty-work"><h2>Loading your build story…</h2><p>Reading saved progress reviews from this computer.</p></div>';
    return;
  }
  if (goalsView) {
    $('goals').innerHTML = goalsPanel(state.snapshot?.goals, { history: state.snapshot?.goalHistory, selected: state.goalsMonth, askFilter: state.goalsAskFilter })
      || `<div class="goals-heading"><div><p class="eyebrow">Your priorities &amp; follow-through</p><h1 id="goals-heading" tabindex="-1">Goals</h1></div></div><div class="empty-work"><h2>${state.loaded ? 'No goals recorded yet' : 'Loading your goals…'}</h2><p>${state.loaded ? 'Your saved priorities and open asks will appear here.' : 'Reading your saved priorities from this computer.'}</p></div>`;
    for (const element of $('goals').querySelectorAll('details[data-goal]')) if (openGoals.has(element.dataset.goal)) element.open = true;
    if (goalFocus) $('goals').querySelector(goalFocus)?.focus({ preventScroll: true });
    return;
  }
  if (teamActive) return;
  lastWorkRoute = personalRoute(state.view, state);
  const open = new Set([...document.querySelectorAll('details[open]')].map(element => element.dataset.updates));
  const openDetails = new Set([...document.querySelectorAll('details[open][data-detail-key]')].map(element => element.dataset.detailKey));
  const projects = [...new Set(state.rows.flatMap(row => row.projects?.length ? row.projects : [row.project]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.project && !projects.includes(state.project)) state.project = '';
  $('project-filter').hidden = false;
  $('project-filter').innerHTML = '<option value="">All projects</option>' + projects.map(project => `<option value="${esc(project)}" ${state.project === project ? 'selected' : ''}>${esc(project)}</option>`).join('');
  const scoped = scopedRows();
  const counts = Object.fromEntries(Object.keys(labels).map(key => [key, key === 'all' ? scoped.length : 0]));
  for (const row of scoped) {
    const status = effectiveStatus(row);
    counts[Object.hasOwn(labels, status) ? status : 'unknown']++;
    if (statusCategory(row) === 'other') counts.other++;
  }
  $('status-tabs').innerHTML = Object.entries(labels).filter(([key]) => key === 'all' || (state.loaded && (key === state.filter || (key !== 'other' && counts[key] > 0)))).map(([key, label]) => `<button type="button" class="status-tab" data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span class="tab-count${state.previousCounts[key] != null && state.previousCounts[key] !== counts[key] ? ' changed' : ''}">${counts[key]}</span></button>`).join('');
  state.previousCounts = counts;
  const rows = visibleRows();
  $('work-heading').textContent = state.filter === 'all' ? 'All work' : labels[state.filter];
  $('view-count').textContent = state.loaded ? `${rows.length} request${rows.length === 1 ? '' : 's'}` : 'Connecting…';
  const emptyTitle = !state.loaded ? state.failed ? 'Waiting for local work' : 'Loading your local work…' : state.query ? 'No matching work' : 'No requests here yet';
  const emptyText = !state.loaded ? state.failed ? 'Keep this page open to reconnect, or open the memory viewer to inspect the worker.' : 'Reading saved requests from this computer.' : state.query ? 'Try another request, project or contributor.' : 'Recorded human requests appear here as your tools save work. You can also explore your existing memory below.';
  const detail = state.view === 'request';
  $('work-heading').parentElement.hidden = detail;
  $('personal-heading').hidden = detail;
  $('personal-toolbar').hidden = detail;
  $('status-tabs').hidden = detail;
  $('unlinked-work').hidden = detail || !state.unlinked.length;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  let html;
  let trail = '';
  if (detail) {
    const row = rowById(state.requestId);
    const work = row?.workstreams.find(item => item.id === state.workId);
    const route = work ? personalRoute('request', { ...state, workId: null }) : personalRoute(state.from, { ...state, requestId: null, workId: null });
    trail = `<a class="back-button" href="${esc(route)}" data-route>← ${work ? 'Back to request' : 'Back to My Work'}</a>`;
    html = row ? work ? workstreamPage(row, work) : requestPage(row, state)
      : state.loaded ? '<div class="empty-work"><h1 tabindex="-1">This request is outside the loaded history</h1><p>Return to My Work to see the current requests.</p></div>'
      : `<div class="empty-work"><h1 tabindex="-1">${state.failed ? 'Waiting for local work' : 'Loading this request…'}</h1><p>${state.failed ? 'Keep this page open to reconnect, or return to My Work.' : 'Reading the saved request from this computer.'}</p></div>`;
  } else {
    if (state.agentId) {
      const agent = state.rows.flatMap(row => row.contributors || []).find(agent => agent.id === state.agentId);
      trail = `<div class="agent-scope"><a class="back-button" href="${esc(personalRoute('agents', { ...state, agentId: null }))}" data-route>← All agents</a><span>${esc(agent?.label || 'Contributor')}</span></div>`;
    }
    html = rows.length ? state.view === 'list' ? requestList(rows, state) : state.view === 'agents' && !state.agentId ? agentCards(rows, state) : requestCards(rows, state)
      : `<div class="empty-work"><h3>${emptyTitle}</h3><p>${emptyText}</p><a class="source-link" href="/viewer">Open memory &amp; settings →</a></div>`;
  }
  $('scope-trail').innerHTML = trail;
  $('work-grid').className = !detail && (state.view === 'cards' || state.agentId) ? 'work-grid request-grid' : !detail && state.view === 'agents' ? 'agent-grid' : '';
  $('work-grid').innerHTML = html;
  for (const element of document.querySelectorAll('details[data-updates]')) if (open.has(element.dataset.updates)) element.open = true;
  for (const element of document.querySelectorAll('details[data-detail-key]')) if (openDetails.has(element.dataset.detailKey)) element.open = true;
  $('reading-note').textContent = 'Working, reported complete, and human checked are separate states. Your review closes the loop.';
  $('unlinked-work').hidden = detail || !state.unlinked.length;
  $('unlinked-count').textContent = `${state.unlinked.length} work records need a linked human request`;
  $('unlinked-items').innerHTML = '<p>These records stay separate because their original human request was not captured or linked. Explore their source in the memory viewer.</p><a class="source-link" href="/viewer">Explore recorded memory →</a>';
  state.changed.clear();
}
function dialog(id, content, html) { $(content).innerHTML = html; $(id).showModal(); }
function markRead(id) { state.unread.delete(id); const element = [...document.querySelectorAll('.work-card')].find(card => card.dataset.id === id); element?.querySelector('.new-dot')?.remove(); }
function evidenceList(row) { return `<ul>${(row.evidence.length ? row.evidence : ['No separate test evidence was recorded. Inspect the source before checking this result.']).map(text => `<li>${esc(text)}</li>`).join('')}</ul>`; }
function openReview(id) {
  const row = rowById(id); if (!row) return; markRead(id);
  dialog('review-dialog', 'review-content', `<div class="dialog-body"><div class="dialog-top"><span class="dialog-eyebrow">Recorded result · your review</span>${closeButton}</div><h2 id="review-title">${esc(row.title)}</h2><p class="dialog-intro">${esc(row.outcome)}</p><section class="evidence-box"><h3>Recorded evidence</h3>${evidenceList(row)}</section><p class="dialog-note">Checking saves a local note that you looked at this version. It does not certify correctness or change the agent’s work. New substantive updates need another check.</p>${row.review?.available === false ? '<p role="alert">Local review storage is unavailable. Your source work remains readable and unchanged.</p>' : ''}<div class="dialog-actions"><button type="button" class="button-secondary" data-detail="${esc(id)}">View original request</button><button type="button" class="button-primary" data-check="${esc(id)}" ${row.review?.available === false ? 'disabled' : ''}>Mark checked</button></div></div>`);
}
function openDetail(id) {
  if (!rowById(id)) return;
  markRead(id); $('review-dialog').close();
  navigate(personalRoute('request', { ...state, requestId: id, workId: null, from: state.view === 'request' ? state.from : state.view }));
}
const positions = new Map();
function syncControls() {
  $('search').value = state.query; $('time-range').value = state.range; $('sort').value = state.sort;
}
function restorePosition(route) {
  const position = positions.get(route);
  const restore = position?.focus && [...document.querySelectorAll('[href]')].find(element => element.getAttribute('href') === position.focus);
  (restore || (state.view === 'goals' ? $('goals-heading') : state.view === 'story' ? $('story-heading') : state.view === 'teambrain' ? $('team-heading') : document.querySelector('#work-grid h1') || $('work-heading')))?.focus({ preventScroll: true });
  window.scrollTo(0, position?.scroll || 0);
}
function navigate(route, replace = false) {
  if (route === location.hash) return;
  positions.set(location.hash, { scroll: window.scrollY, focus: document.activeElement?.closest('[href]')?.getAttribute('href') });
  if (replace) history.replaceState(null, '', route); else history.pushState(null, '', route);
  renderedHash = location.hash;
  Object.assign(state, parsePersonalRoute(route)); syncControls();
  if (state.requestId) markRead(state.requestId);
  render();
  restorePosition(route);
}
function saveScope() {
  history.replaceState(null, '', personalRoute(state.view, state));
  renderedHash = location.hash;
}
function readLocation() {
  if (location.hash === renderedHash) return;
  renderedHash = location.hash;
  Object.assign(state, parsePersonalRoute(location.hash)); syncControls(); render();
  restorePosition(location.hash);
}
window.addEventListener('popstate', readLocation);
window.addEventListener('hashchange', readLocation);
function toast(message, undo = null) {
  clearTimeout(state.toastTimer); $('toast').hidden = false;
  $('toast').innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" id="undo-check">Undo</button>' : ''}<button class="toast-dismiss" type="button" id="dismiss-toast" aria-label="Dismiss notification">×</button>`;
  if (undo) $('undo-check').onclick = undo;
  $('dismiss-toast').onclick = () => { $('toast').hidden = true; };
  if (!undo) state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 8000);
}
function focusCurrentWork(id) {
  const page = document.querySelector('#work-grid .request-page, #work-grid .records-page');
  const target = page?.querySelector('[data-undo], [data-review], h1')
    || [...document.querySelectorAll('.work-card')].find(card => card.dataset.id === id)
    || $('work-heading');
  target.focus({ preventScroll: true });
}
async function saveReview(id, checked) {
  const row = rowById(id); if (!row || state.busy) return;
  state.busy = true; document.querySelectorAll('[data-check],[data-undo]').forEach(button => { button.disabled = true; });
  try {
    const response = await fetch('/api/work-view/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id, expectedFingerprint: row.contentFingerprint, checked }) });
    if (response.status === 409) { $('review-dialog').close(); await refresh(true); focusCurrentWork(id); toast('This work changed while you were reading. Review the latest version before checking.'); return; }
    if (!response.ok) throw new Error('The local review could not be saved. Try again.');
    const snapshot = await response.json(); $('review-dialog').close(); accept(snapshot, true);
    toast(checked ? 'Checked locally. Your review is saved.' : 'Check undone. The result is ready to review.', checked ? () => saveReview(id, false) : null);
    announce(checked ? 'Result checked. Undo remains available on the card.' : 'Check undone.');
    focusCurrentWork(id);
  } catch (error) { toast(error.message); }
  finally { state.busy = false; document.querySelectorAll('[data-check],[data-undo]').forEach(button => { button.disabled = false; }); }
}
function openConnection(service) {
  const name = service === 'ChatGPT' ? 'ChatGPT' : 'Claude.ai';
  dialog('connect-dialog', 'connect-content', `<div class="dialog-body"><div class="dialog-top"><span class="dialog-eyebrow">Optional CMEM Cloud setup</span>${closeButton}</div><h2 id="connection-title">Bring your memory to ${name}.</h2><p class="dialog-intro">Continue to the existing CMEM connection setup, sign in, and choose ${name}. The setup explains how to connect your chat app and local memory.</p><p class="dialog-note">Cloud sync can upload your saved prompts and observation narratives. Review the setup and sharing scope before enabling it. This local panel stays available without connecting.</p><div class="dialog-actions"><button type="button" class="button-secondary" data-close>Keep working locally</button><a class="button-primary" href="https://cmem.ai/connect?from=local-work" target="_blank" rel="noopener noreferrer">Continue to connection setup ↗</a></div></div>`);
}
function isReading() { return state.view === 'request' || state.busy || window.scrollY > 220 || !!document.querySelector('dialog[open], .work-card details[open], #goals details[open]') || !!document.activeElement?.closest('#work-grid, .search-field, .status-tabs, #personal-toolbar, .view-switch, #goals'); }
function apply(snapshot, force = false) {
  if (!force && state.rows.length && isReading()) {
    pendingGoalFocus = focusedGoalSelector() || pendingGoalFocus;
    state.pending = snapshot; $('updates-banner').innerHTML = '<div class="updates-banner"><span><strong>New work updates are ready.</strong> Your place is saved.</span><button type="button" id="apply-updates">Show updates</button></div>';
    $('apply-updates').onclick = () => {
      const goalFocus = focusedGoalSelector() || pendingGoalFocus, scroll = window.scrollY;
      if (state.pending) apply(state.pending, true);
      if (state.view === 'goals') {
        ((goalFocus && $('goals').querySelector(goalFocus)) || $('goals-heading'))?.focus({ preventScroll: true });
        window.scrollTo(0, scroll);
      } else focusCurrentWork(state.requestId);
      announce('New work updates applied.');
    };
    return;
  }
  const previous = new Map(state.rows.map(row => [row.id, contentSignature(row)]));
  const content = new Map(state.rows.map(row => [row.id, row.contentFingerprint]));
  const result = presentWork(snapshot, state.rows);
  for (const row of result.rows) if (!previous.has(row.id) || previous.get(row.id) !== contentSignature(row)) {
    if (state.rows.length && (!content.has(row.id) || content.get(row.id) !== row.contentFingerprint)) state.unread.add(row.id);
    if (state.rows.length) state.changed.add(row.id);
  }
  state.rows = result.rows; state.unlinked = result.unlinked; state.pending = null; pendingGoalFocus = null; $('updates-banner').replaceChildren(); render();
}
function renderConnection() {
  const status = getConnectionStatus({ ...connection, now: performance.now(), wallNow: Date.now() });
  $('connection').dataset.state = status.state;
  $('connection').title = status.tooltip;
  if ($('connection-label').textContent !== status.label) $('connection-label').textContent = status.label;
  if ($('source-note').textContent !== status.detail) $('source-note').textContent = status.detail;
}
function health(source) {
  connection.sourceConnected = typeof source?.connected === 'boolean' ? source.connected : null;
  state.sourceConnected = connection.sourceConnected === true;
  state.failed = connection.sourceConnected === false;
  if (source?.connected === true && typeof source.lastCheckedAt === 'string' && Number.isFinite(Date.parse(source.lastCheckedAt))) {
    connection.lastSuccessfulCheckAt = source.lastCheckedAt;
    connection.lastSuccessfulCheckReceivedAt = performance.now();
  }
  renderConnection();
}
function received() { state.lastReceived = Date.now(); $('received-time').textContent = `Last received ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; }
function accept(snapshot, force = false, fromEvent = false) {
  state.loaded = true; state.snapshot = snapshot;
  received();
  // An HTTP read that began before a newer event must not renew or overwrite
  // the feed's source-health evidence.
  if (fromEvent || connection.lastEventAt === null) health(snapshot.source);
  const signature = JSON.stringify([snapshot.revision, snapshot.humanRequests, snapshot.unlinkedWork]);
  if (!force && signature === state.signature) return;
  state.signature = signature; apply(snapshot, force);
}
async function refresh(force = false) {
  const previousEvent = connection.lastEventAt;
  const response = await fetch('/api/work-view', { cache: 'no-store' });
  if (!response.ok) throw new Error('Local work could not be loaded.');
  const snapshot = await response.json();
  if (connection.lastEventAt !== previousEvent) {
    if (force && state.snapshot) apply(state.pending || state.snapshot, true);
    return;
  }
  accept(snapshot, force);
}
document.addEventListener('click', async event => {
  const route = event.target.closest('a[data-route]');
  if (route && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    navigate(route.getAttribute('href')); return;
  }
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.view) { navigate(personalRoute(target.dataset.view, { ...state, requestId: null, workId: null, agentId: null, from: null })); return; }
  if (target.dataset.filter) { state.filter = target.dataset.filter; saveScope(); render(); [...document.querySelectorAll('[data-filter]')].find(button => button.dataset.filter === state.filter)?.focus({ preventScroll: true }); }
  if (target.dataset.goalsMonth) { const label = target.getAttribute('aria-label'); state.goalsMonth = target.dataset.goalsMonth; state.goalsAskFilter = 'all'; render(); const again = $('goals').querySelector(`.goals-step[aria-label="${label}"]`); (again && !again.disabled ? again : $('goals-month'))?.focus({ preventScroll: true }); }
  if (target.dataset.goalsFilter) {
    state.goalsAskFilter = target.dataset.goalsFilter;
    render();
    if (target.hasAttribute('data-goals-jump')) {
      $('goals').querySelector('.goals-all-asks').open = true;
      $('goals-asks-heading')?.focus();
    }
    else $('goals').querySelector(`.goals-ask-filters [data-goals-filter="${state.goalsAskFilter}"]`)?.focus({ preventScroll: true });
  }
  if (target.dataset.review) openReview(target.dataset.review);
  if (target.dataset.detail) openDetail(target.dataset.detail);
  if (target.dataset.copyHandoff) {
    const row = rowById(target.dataset.copyHandoff); if (!row) return;
    const text = handoffText(row);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      $('handoff-feedback').textContent = 'Handoff copied. Paste it into the agent or conversation you choose.';
      announce('Handoff copied. Nothing was sent.');
    } catch {
      const area = $('handoff-text'); area.hidden = false; area.value = text; area.focus(); area.select();
      $('handoff-feedback').textContent = 'Clipboard unavailable. Copy the selected handoff text below.';
    }
  }
  if (target.dataset.check) await saveReview(target.dataset.check, true);
  if (target.dataset.undo) await saveReview(target.dataset.undo, false);
  if (target.dataset.connect) openConnection(target.dataset.connect);
  if (target.hasAttribute('data-close')) target.closest('dialog').close();
  if (target.dataset.evidenceKind) {
    const pre = target.closest('[data-evidence-record]')?.querySelector('pre') || $('raw-evidence'); if (!pre) return; pre.hidden = false; pre.textContent = 'Loading recorded source…';
    try { const response = await fetch(`/api/work-view/evidence/${encodeURIComponent(target.dataset.evidenceKind)}/${encodeURIComponent(target.dataset.evidenceId)}`); if (!response.ok) throw new Error(); pre.textContent = JSON.stringify(await response.json(), null, 2); }
    catch { pre.textContent = 'This source record is no longer available.'; }
  }
});
document.addEventListener('change', event => { if (event.target.id === 'goals-month') { state.goalsMonth = event.target.value; state.goalsAskFilter = 'all'; render(); $('goals-month')?.focus({ preventScroll: true }); } });
document.addEventListener('toggle', event => { if (event.target.matches('details[open][data-updates]')) markRead(event.target.dataset.updates); }, true);
$('search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); saveScope(); render(); });
$('time-range').addEventListener('change', event => { state.range = event.target.value; saveScope(); render(); });
$('project-filter').addEventListener('change', event => { state.project = event.target.value; saveScope(); render(); $('project-filter').focus({ preventScroll: true }); });
$('sort').addEventListener('change', event => { state.sort = event.target.value; saveScope(); render(); });
$('skip-to-content').addEventListener('click', event => { event.preventDefault(); $('main').focus(); });
for (const item of document.querySelectorAll('dialog')) item.addEventListener('click', event => { if (event.target === item) { const rect = item.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) item.close(); } });
Object.assign(state, parsePersonalRoute(location.hash)); syncControls();
history.replaceState(null, '', personalRoute(state.view, state));
renderedHash = location.hash;
teamView = setupTeamView({ managedNavigation: true });
$('workspace-personal').onclick = () => navigate(lastWorkRoute);
$('workspace-goals').onclick = () => navigate('#goals');
$('workspace-story').onclick = () => navigate('#story');
$('workspace-team').onclick = () => navigate('#teambrain');
render();
refresh().catch(() => { state.failed = true; renderConnection(); render(); });
const stream = new EventSource('/api/work-view/events');
stream.onopen = () => { connection.transportConnected = true; connection.reconnecting = false; renderConnection(); };
stream.addEventListener('work-view', event => {
  try {
    const snapshot = JSON.parse(event.data);
    if (!snapshot || !Array.isArray(snapshot.humanRequests) || typeof snapshot.source?.connected !== 'boolean') return;
    connection.transportConnected = true; connection.reconnecting = false; connection.lastEventAt = performance.now();
    accept(snapshot, false, true);
  } catch { /* Malformed messages cannot renew the live indicator. */ }
});
stream.addEventListener('heartbeat', event => {
  try {
    const beat = JSON.parse(event.data);
    if (!beat || typeof beat.source?.connected !== 'boolean') return;
    connection.transportConnected = true; connection.reconnecting = false; connection.lastEventAt = performance.now();
    received(); health(beat.source);
  } catch { /* Keep the last valid heartbeat; the freshness deadline still applies. */ }
});
stream.onerror = () => { connection.transportConnected = false; connection.reconnecting = true; renderConnection(); };
const timer = setInterval(() => {
  renderConnection();
  document.querySelectorAll('[data-time]').forEach(element => { element.textContent = `${element.dataset.timePrefix || ''}${relativeTime(Number(element.dataset.time))}`; });
  document.querySelectorAll('[data-request-elapsed]').forEach(element => { const row = rowById(element.dataset.requestElapsed); if (row) element.textContent = requestElapsed(row); });
}, 1000);
// Age recorded activity without a synthetic source event or a forced reorder.
const ageTimer = setInterval(() => {
  if (!state.snapshot || !state.rows.length) return;
  const aged = presentWork(state.snapshot, state.rows).rows;
  if (aged.some((row, index) => row.status !== state.rows[index]?.status)) apply(state.snapshot);
}, 60000);
fetch('/api/sync/status', { cache: 'no-store' }).then(response => response.ok ? response.json() : Promise.reject()).then(sync => { $('sync-state').textContent = sync.configured ? 'Cloud sync configured · local viewing remains independent' : 'Cloud sync not connected · optional'; }).catch(() => { $('sync-state').textContent = 'Cloud sync status unavailable · local viewing remains independent'; });
window.addEventListener('pagehide', () => { stream.close(); clearInterval(timer); clearInterval(ageTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
