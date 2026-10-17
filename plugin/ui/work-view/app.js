import { relativeTime } from './view-model.js';
import { presentWork, effectiveStatus, statusCategory, contentSignature, handoffText, scopeWork } from './presentation.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { rows: [], unlinked: [], loaded: false, failed: false, snapshot: null, filter: 'all', query: '', range: 'all', project: '', pending: null, signature: '', lastReceived: 0, sourceConnected: false, changed: new Set(), unread: new Set(), previousCounts: {}, busy: false, toastTimer: null };
const labels = { all: 'All', working: 'In progress', needs: 'Needs you', ready: 'Ready to check', checked: 'Checked', other: 'Other states' };
const icon = status => `<span class="status-icon" aria-hidden="true">${status === 'needs' ? '!' : ['ready', 'checked'].includes(status) ? '✓' : ''}</span>`;
const rowById = id => state.rows.find(row => row.id === id);
const closeButton = '<button type="button" class="dialog-close" data-close aria-label="Close dialog">×</button>';
// Existing bookmarked memory routes continue to open the preserved viewer.
if (/^#\/?(?:sessions(?:\/|$)|session\/|observation\/|summary\/)/.test(location.hash)) location.replace(`/viewer${location.hash}`);
function announce(text) { $('announcement').textContent = ''; requestAnimationFrame(() => { $('announcement').textContent = text; }); }
function scopedRows() {
  return scopeWork(state.rows, state);
}
function visibleRows() { return scopedRows().filter(row => state.filter === 'all' || statusCategory(row) === state.filter); }
function action(row, location = 'card') {
  const status = effectiveStatus(row), cls = location === 'card' ? 'card-action' : '';
  if (status === 'ready') return `<button type="button" class="${cls}" data-review="${esc(row.id)}">Review result <span aria-hidden="true">↗</span></button>`;
  if (status === 'needs') return `<button type="button" class="${cls}" data-detail="${esc(row.id)}">Read handoff <span aria-hidden="true">↗</span></button>`;
  return location === 'card' ? `<button type="button" class="${cls}" data-detail="${esc(row.id)}">View work <span aria-hidden="true">↗</span></button>` : '';
}
function card(row) {
  const status = effectiveStatus(row);
  const next = status === 'checked' ? 'You reviewed this version. New substantive work will need a fresh check.' : row.next;
  return `<article class="work-card status-${['working', 'needs', 'ready', 'checked'].includes(status) ? status : 'other'}${state.changed.has(row.id) ? ' updated' : ''}" data-id="${esc(row.id)}" tabindex="-1">
    <div class="card-top"><span class="status">${icon(status)}${esc(labels[status] || row.sourceLabel || 'Recorded update')}</span><span class="card-time" data-time="${row.updated}">${esc(relativeTime(row.updated))}${state.unread.has(row.id) ? '<span class="new-dot" role="img" aria-label="Unread update"></span>' : ''}</span></div>
    <h3 class="card-title"><button type="button" class="request-link" data-detail="${esc(row.id)}">${esc(row.title)}</button></h3><p class="card-activity">${esc(row.activity)}</p>
    <div class="agent-line">${row.icon ? `<img src="${esc(row.icon)}" width="17" height="17" alt="">` : ''}<span class="agent-name">${esc(row.agent)}</span><span class="agent-dot" aria-hidden="true"></span><span>${esc(row.role)}</span></div>
    <div class="handoff-note"><span class="handoff-label">${status === 'checked' ? 'Checked' : status === 'needs' ? 'Your move' : 'Next'}</span><span>${esc(next)}</span></div>
    ${['ready', 'checked'].includes(status) ? `<p class="status-detail">${status === 'ready' ? 'Reported complete · awaiting your check' : `Checked locally · source status preserved <button type="button" data-undo="${esc(row.id)}">Undo</button>`}</p>` : ''}
    <div class="card-footer"><details data-updates="${esc(row.id)}"><summary><span class="disclosure-chevron" aria-hidden="true"></span>Latest updates</summary><ol class="activity-list">${row.updates.length ? row.updates.slice(0, 4).map(update => `<li>${update.at ? `<time datetime="${new Date(update.at).toISOString()}">${esc(relativeTime(update.at))}</time>` : ''}${esc(update.text)}</li>`).join('') : '<li>No detailed update recorded.</li>'}</ol></details><div class="card-action-wrap">${action(row)}</div></div></article>`;
}
function render() {
  const open = new Set([...document.querySelectorAll('details[open]')].map(element => element.dataset.updates));
  const projects = [...new Set(state.rows.flatMap(row => row.projects?.length ? row.projects : [row.project]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.project && !projects.includes(state.project)) state.project = '';
  $('project-filter').hidden = projects.length < 2;
  $('project-filter').innerHTML = '<option value="">All projects</option>' + projects.map(project => `<option value="${esc(project)}" ${state.project === project ? 'selected' : ''}>${esc(project)}</option>`).join('');
  const scoped = scopedRows();
  const counts = { all: scoped.length, working: 0, needs: 0, ready: 0, checked: 0, other: 0 };
  for (const row of scoped) counts[statusCategory(row)]++;
  $('status-tabs').innerHTML = Object.entries(labels).map(([key, label]) => `<button type="button" class="status-tab" data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span class="tab-count${state.previousCounts[key] != null && state.previousCounts[key] !== counts[key] ? ' changed' : ''}">${counts[key]}</span></button>`).join('');
  state.previousCounts = counts;
  const rows = visibleRows();
  $('work-heading').textContent = state.filter === 'all' ? 'All work' : labels[state.filter];
  $('view-count').textContent = state.loaded ? `${rows.length} request${rows.length === 1 ? '' : 's'}` : 'Connecting…';
  const emptyTitle = !state.loaded ? state.failed ? 'Waiting for local work' : 'Loading your local work…' : state.query ? 'No matching work' : 'No requests here yet';
  const emptyText = !state.loaded ? state.failed ? 'Keep this page open to reconnect, or open the memory viewer to inspect the worker.' : 'Reading saved requests from this computer.' : state.query ? 'Try another request, project or contributor.' : 'Recorded human requests appear here as your tools save work. You can also explore your existing memory below.';
  $('work-grid').innerHTML = rows.length ? rows.map(card).join('') : `<div class="empty-work"><h3>${emptyTitle}</h3><p>${emptyText}</p><a class="source-link" href="/viewer">Open memory &amp; settings →</a></div>`;
  for (const element of document.querySelectorAll('details[data-updates]')) if (open.has(element.dataset.updates)) element.open = true;
  const next = scoped.filter(row => ['needs', 'ready'].includes(effectiveStatus(row)));
  $('next-count').textContent = next.length;
  $('next-list').innerHTML = next.length ? next.slice(0, 5).map(row => `<div class="next-item"><div class="next-item-top ${effectiveStatus(row)}">${icon(effectiveStatus(row))}${effectiveStatus(row) === 'needs' ? 'A HANDOFF FOR YOU' : 'READY FOR A LOOK'}</div><h3>${esc(row.title)}</h3>${action(row, 'inbox')}</div>`).join('') : '<p class="empty-inbox">No open handoffs in this loaded view. Finished results and explicit questions will appear here.</p>';
  $('workspace-name').textContent = 'Local workspace';
  $('workspace-detail').textContent = `${state.rows.length} requests · saved on this computer`;
  $('reading-note').textContent = 'Working, reported complete, and human checked are separate states. Your review closes the loop.';
  $('unlinked-work').hidden = !state.unlinked.length;
  $('unlinked-count').textContent = `${state.unlinked.length} work records need a linked human request`;
  $('unlinked-items').innerHTML = '<p>These records stay separate because their original human request was not captured or linked. Explore their source in the memory viewer.</p><a class="source-link" href="/viewer">Explore recorded memory →</a>';
  state.changed.clear();
}
function dialog(id, content, html) { $(content).innerHTML = html; $(id).showModal(); }
function markRead(id) { state.unread.delete(id); const element = [...document.querySelectorAll('.work-card')].find(card => card.dataset.id === id); element?.querySelector('.new-dot')?.remove(); }
function evidenceList(row) { return `<ul>${(row.evidence.length ? row.evidence : ['No separate test evidence was recorded. Inspect the source before checking this result.']).map(text => `<li>${esc(text)}</li>`).join('')}</ul>`; }
function sourceLinks(row) {
  const refs = [row.original?.url, ...(row.items || []).flatMap(item => (item.sourceRefs || []).map(ref => `/api/work-view/evidence/${ref.kind}/${ref.id}`))];
  return [...new Set(refs)].flatMap(url => {
    const match = String(url).match(/\/evidence\/(work-state|observation|prompt|summary|session)\/(\d+)$/);
    return match ? [`<button class="source-link" type="button" data-evidence-kind="${match[1]}" data-evidence-id="${match[2]}">Read ${match[1]} #${match[2]}</button>`] : [];
  }).join(' ');
}
function openReview(id) {
  const row = rowById(id); if (!row) return; markRead(id);
  dialog('review-dialog', 'review-content', `<div class="dialog-body"><div class="dialog-top"><span class="dialog-eyebrow">Recorded result · your review</span>${closeButton}</div><h2 id="review-title">${esc(row.title)}</h2><p class="dialog-intro">${esc(row.outcome)}</p><section class="evidence-box"><h3>Recorded evidence</h3>${evidenceList(row)}</section><p class="dialog-note">Checking saves a local note that you looked at this version. It does not certify correctness or change the agent’s work. New substantive updates need another check.</p>${row.review?.available === false ? '<p role="alert">Local review storage is unavailable. Your source work remains readable and unchanged.</p>' : ''}<div class="dialog-actions"><button type="button" class="button-secondary" data-detail="${esc(id)}">View original request</button><button type="button" class="button-primary" data-check="${esc(id)}" ${row.review?.available === false ? 'disabled' : ''}>Mark checked</button></div></div>`);
}
function openDetail(id) {
  const row = rowById(id); if (!row) return; markRead(id); $('review-dialog').close();
  dialog('detail-dialog', 'detail-content', `<div class="dialog-body"><div class="dialog-top"><span class="dialog-eyebrow">${esc(row.project)} · recorded work</span>${closeButton}</div><h2 id="detail-title">${esc(row.title)}</h2><p class="dialog-intro">${esc(row.next)}</p><section class="request-section"><h3>Original human request</h3><p>${esc(row.original?.text)}</p></section>${(row.scopeUpdates || []).length ? `<details class="request-section"><summary>Follow-up requests</summary>${row.scopeUpdates.map(item => `<p>${esc(item.text)}</p>`).join('')}</details>` : ''}<section class="request-section"><h3>Result and recent evidence</h3>${evidenceList(row)}</section><details class="request-section"><summary>Original source records</summary><p>Reply or continue in the original agent conversation. This local panel does not send a reply.</p>${sourceLinks(row)}<pre id="raw-evidence" class="raw-source" hidden></pre></details><p id="handoff-feedback" class="dialog-note" role="status"></p><label class="sr-only" for="handoff-text">Handoff text to copy</label><textarea id="handoff-text" class="raw-source" rows="9" readonly hidden></textarea><div class="dialog-actions"><a class="source-link" href="/viewer">Memory &amp; sessions →</a><button type="button" class="button-secondary" data-copy-handoff="${esc(id)}">Copy handoff</button><button type="button" class="button-primary" data-close>Done reading</button></div></div>`);
}
function toast(message, undo = null) {
  clearTimeout(state.toastTimer); $('toast').hidden = false;
  $('toast').innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button" id="undo-check">Undo</button>' : ''}<button class="toast-dismiss" type="button" id="dismiss-toast" aria-label="Dismiss notification">×</button>`;
  if (undo) $('undo-check').onclick = undo;
  $('dismiss-toast').onclick = () => { $('toast').hidden = true; };
  if (!undo) state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 8000);
}
async function saveReview(id, checked) {
  const row = rowById(id); if (!row || state.busy) return;
  state.busy = true; document.querySelectorAll('[data-check],[data-undo]').forEach(button => { button.disabled = true; });
  try {
    const response = await fetch('/api/work-view/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: id, expectedFingerprint: row.contentFingerprint, checked }) });
    if (response.status === 409) { $('review-dialog').close(); await refresh(true); toast('This work changed while you were reading. Review the latest version before checking.'); return; }
    if (!response.ok) throw new Error('The local review could not be saved. Try again.');
    const snapshot = await response.json(); $('review-dialog').close(); accept(snapshot, true);
    toast(checked ? 'Checked locally. Your review is saved.' : 'Check undone. The result is ready to review.', checked ? () => saveReview(id, false) : null);
    announce(checked ? 'Result checked. Undo remains available on the card.' : 'Check undone.');
    const card = [...document.querySelectorAll('.work-card')].find(card => card.dataset.id === id);
    (card || $('work-heading')).focus({ preventScroll: true });
  } catch (error) { toast(error.message); }
  finally { state.busy = false; document.querySelectorAll('[data-check],[data-undo]').forEach(button => { button.disabled = false; }); }
}
function openConnection(service) {
  const name = service === 'ChatGPT' ? 'ChatGPT' : 'Claude.ai';
  dialog('connect-dialog', 'connect-content', `<div class="dialog-body"><div class="dialog-top"><span class="dialog-eyebrow">Optional CMEM Cloud setup</span>${closeButton}</div><h2 id="connection-title">Bring your memory to ${name}.</h2><p class="dialog-intro">Continue to the existing CMEM connection setup, sign in, and choose ${name}. The setup explains how to connect your chat app and local memory.</p><p class="dialog-note">Cloud sync can upload your saved prompts and observation narratives. Review the setup and sharing scope before enabling it. This local panel stays available without connecting.</p><div class="dialog-actions"><button type="button" class="button-secondary" data-close>Keep working locally</button><a class="button-primary" href="https://cmem.ai/connect?from=local-work" target="_blank" rel="noopener noreferrer">Continue to connection setup ↗</a></div></div>`);
}
function isReading() { return state.busy || window.scrollY > 220 || !!document.querySelector('dialog[open], .work-card details[open]') || !!document.activeElement?.closest('.work-card, .search-field, .status-tabs, .view-options'); }
function apply(snapshot, force = false) {
  if (!force && state.rows.length && isReading()) {
    state.pending = snapshot; $('updates-banner').innerHTML = '<div class="updates-banner"><span><strong>New work updates are ready.</strong> Your place is saved.</span><button type="button" id="apply-updates">Show updates</button></div>';
    $('apply-updates').onclick = () => { if (state.pending) apply(state.pending, true); $('work-heading').focus({ preventScroll: true }); announce('New work updates applied.'); };
    return;
  }
  const previous = new Map(state.rows.map(row => [row.id, contentSignature(row)]));
  const content = new Map(state.rows.map(row => [row.id, row.contentFingerprint]));
  const result = presentWork(snapshot, state.rows);
  for (const row of result.rows) if (!previous.has(row.id) || previous.get(row.id) !== contentSignature(row)) {
    if (state.rows.length && (!content.has(row.id) || content.get(row.id) !== row.contentFingerprint)) state.unread.add(row.id);
    state.changed.add(row.id);
  }
  state.rows = result.rows; state.unlinked = result.unlinked; state.pending = null; $('updates-banner').replaceChildren(); render();
}
function health(connected) {
  state.failed = !connected;
  state.sourceConnected = connected === true; $('connection').dataset.state = connected ? 'live' : 'paused'; $('connection-label').textContent = connected ? 'Local updates connected' : 'Local source unavailable';
  $('source-note').textContent = connected ? 'Live local records. In progress is a recorded state, not a presence signal. Loaded history is bounded.' : 'Local source unavailable. Keeping the last received work while the connection retries.';
}
function received() { state.lastReceived = Date.now(); $('received-time').textContent = `Last received ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; }
function accept(snapshot, force = false) {
  state.loaded = true; state.snapshot = snapshot;
  received(); health(snapshot.source?.connected === true);
  const signature = JSON.stringify([snapshot.revision, snapshot.humanRequests, snapshot.unlinkedWork]);
  if (!force && signature === state.signature) return;
  state.signature = signature; apply(snapshot, force);
}
async function refresh(force = false) { const response = await fetch('/api/work-view', { cache: 'no-store' }); if (!response.ok) throw new Error('Local work could not be loaded.'); accept(await response.json(), force); }
document.addEventListener('click', async event => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.filter) { state.filter = target.dataset.filter; render(); [...document.querySelectorAll('[data-filter]')].find(button => button.dataset.filter === state.filter)?.focus({ preventScroll: true }); }
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
    const pre = $('raw-evidence'); pre.hidden = false; pre.textContent = 'Loading recorded source…';
    try { const response = await fetch(`/api/work-view/evidence/${encodeURIComponent(target.dataset.evidenceKind)}/${encodeURIComponent(target.dataset.evidenceId)}`); if (!response.ok) throw new Error(); pre.textContent = JSON.stringify(await response.json(), null, 2); }
    catch { pre.textContent = 'This source record is no longer available.'; }
  }
});
document.addEventListener('toggle', event => { if (event.target.matches('details[open][data-updates]')) markRead(event.target.dataset.updates); }, true);
$('search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); render(); });
$('time-range').addEventListener('change', event => { state.range = event.target.value; render(); });
$('project-filter').addEventListener('change', event => { state.project = event.target.value; render(); $('project-filter').focus({ preventScroll: true }); });
for (const item of document.querySelectorAll('dialog')) item.addEventListener('click', event => { if (event.target === item) { const rect = item.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) item.close(); } });
render();
refresh().catch(() => { health(false); render(); });
const stream = new EventSource('/api/work-view/events');
stream.addEventListener('work-view', event => { try { accept(JSON.parse(event.data)); } catch { health(false); } });
stream.addEventListener('heartbeat', event => { try { const beat = JSON.parse(event.data); received(); health(beat.source?.connected === true); } catch { health(false); } });
stream.onerror = () => { $('connection').dataset.state = 'paused'; $('connection-label').textContent = 'Reconnecting locally…'; $('source-note').textContent = 'Connection interrupted. Keeping the last received work while updates reconnect.'; };
const timer = setInterval(() => {
  if (state.lastReceived && Date.now() - state.lastReceived > 35000) { $('connection').dataset.state = 'paused'; $('connection-label').textContent = 'Waiting for local updates…'; }
  document.querySelectorAll('[data-time]').forEach(element => { const dot = element.querySelector('.new-dot'); element.textContent = relativeTime(Number(element.dataset.time)); if (dot) element.append(dot); });
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
