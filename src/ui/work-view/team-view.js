import { relativeTime } from './view-model.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const field = (pairs, names) => names.map(name => pairs?.find(pair => pair[0] === name)?.[1]).find(value => typeof value === 'string' && value.trim()) || '';
const statusLabel = value => ({ doing: 'In progress', 'in-progress': 'In progress', todo: 'To do', blocked: 'Blocked', 'needs-you': 'Needs you', 'needs-input': 'Needs you', 'waiting-on-user': 'Needs you', 'awaiting-approval': 'Needs you' })[String(value || '').toLowerCase()] || (value || 'Status not recorded');
const detailLabel = key => ({ human_summary: 'Update', progress: 'Progress', next: 'Next', next_step: 'Next', outcome: 'Outcome', result: 'Result' })[key] || key;

export function sharingDescription(team) {
  if (!team.broadcasting) return 'You are viewing shared work. Sharing from this computer is off.';
  const scope = team.projects === null ? 'all projects' : team.projects?.length ? team.projects.join(', ') : 'no projects selected';
  return `Your sharing setting is on for ${scope}.`;
}

const timeMarkup = (value, prefix = 'Updated') => {
  const epoch = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return '<span class="team-task-time">Time not recorded</span>';
  return `<time data-team-time="${epoch}" data-time-prefix="${prefix}" datetime="${new Date(epoch).toISOString()}" title="${esc(new Date(epoch).toLocaleString())}">${prefix} ${esc(relativeTime(epoch))}</time>`;
};
const findingLabel = value => ({ collision: 'Overlapping work', delegation: 'Handoff', gap: 'Missing context' })[value] || String(value || 'Finding').replace(/[-_]/g, ' ');
export function teamReceiptIsStale(receivedAt, now = performance.now()) {
  return receivedAt !== null && (!Number.isFinite(receivedAt) || !Number.isFinite(now) || now < receivedAt || now - receivedAt > 35000);
}

const detailKeys = ['human_summary', 'progress', 'next', 'next_step', 'next_action', 'blocker', 'blockers', 'outcome', 'result', 'evidence'];

export function filterTeamLists(board, { search = '', project = '' } = {}) {
  const needle = search.trim().toLowerCase();
  const findings = new Map(board.findings.map(finding => [finding.id, finding]));
  return board.lists.filter(list => (!project || list.project === project) && (!needle || [
    list.name, list.display_name, list.project, JSON.stringify(list.state),
    ...list.tasks.flatMap(task => [task.name, task.status, JSON.stringify(task.details), ...task.finding_ids.map(id => {
      const finding = findings.get(id); return finding ? `${finding.title} ${finding.subtitle || ''} ${finding.narrative || ''}` : '';
    })]),
  ].join(' ').toLowerCase().includes(needle)));
}

const normalizedTaskStatus = value => String(value || '').trim().toLowerCase().replace(/_/g, '-');
const terminalTaskStates = new Set(['done', 'complete', 'completed', 'closed', 'cancelled', 'canceled', 'dropped']);
const openTeamTasks = list => list.tasks.filter(task => !terminalTaskStates.has(normalizedTaskStatus(task.status)));
// A task summary is not a parent request lifecycle or a human review state.
export function teamTaskActivity(list) {
  const open = openTeamTasks(list);
  const count = `${open.length} open ${open.length === 1 ? 'task' : 'tasks'}`;
  if (list.closed) return { state: 'closed', label: 'List closed', count };
  const statuses = new Set(open.map(task => normalizedTaskStatus(task.status)));
  for (const [state, label, aliases] of [
    ['needs', 'Tasks: Needs you', ['needs-you', 'needs-input', 'needs-human', 'waiting-on-user', 'awaiting-approval']],
    ['blocked', 'Tasks: Blocked', ['blocked']],
    ['working', 'Tasks: In progress', ['doing', 'in-progress', 'working', 'active']],
    ['todo', 'Tasks: To do', ['todo', 'to-do', 'queued', 'pending']],
  ]) if (aliases.some(status => statuses.has(status))) return { state, label, count };
  return { state: 'quiet', label: open.length ? 'Task status not recorded' : 'No open tasks', count };
}

export function teamCardHtml(list, findings = new Map(), members = new Map(), open = false) {
  const key = JSON.stringify([list.user_id, list.project, list.name]);
  const recordedStatus = field(list.state, ['status', 'request_status']);
  const summary = field(list.state, ['human_summary', 'progress', 'stage', 'phase']) || 'Open the recorded tasks to see the work and its next steps.';
  const next = field(list.state, ['next', 'next_step', 'next_action']) || list.tasks.map(task => field(task.details, ['next', 'next_step', 'next_action'])).find(Boolean);
  const activity = teamTaskActivity(list), count = activity.count;
  return `<article class="request-card team-card" tabindex="-1"><div class="team-card-main"><div class="request-card-meta"><span class="team-card-state" data-task-state="${activity.state}"><span class="team-state-dot" aria-hidden="true"></span>${esc(activity.label)}</span>${timeMarkup(list.last_written_at)}</div><h3>${esc(list.name)}</h3><p class="team-task-count">${esc(count)}${recordedStatus ? ` · Recorded list status: ${esc(statusLabel(recordedStatus))}` : ''}</p><p class="team-card-summary">${esc(summary)}</p><div class="team-card-byline"><strong>${esc(list.display_name)}</strong><span>${esc(list.project)}</span></div>${next ? `<div class="team-card-next"><span>Next step</span><p>${esc(next)}</p></div>` : ''}</div><details class="team-card-details" data-list="${esc(key)}" ${open ? 'open' : ''}><summary>${esc(count)} · View details</summary><ol class="team-task-list">${list.tasks.map(task => `<li><div class="team-task-heading"><h4>${esc(task.name)}</h4><span class="team-task-status">${esc(statusLabel(task.status))}</span></div><span class="team-task-time">${timeMarkup(task.updated_at)}</span>${task.details.filter(([name, value]) => typeof value === 'string' && value.trim() && detailKeys.includes(name)).map(([name, value]) => `<p class="team-task-detail"><strong>${esc(detailLabel(name).replace(/_/g, ' '))}</strong>${esc(value)}</p>`).join('')}${task.finding_ids.map(id => findings.get(id)).filter(Boolean).map(finding => {
    const people = [...new Set(finding.member_ids.map(id => members.get(id) || 'Team member'))];
    return `<details class="team-finding" data-finding="${finding.id}"><summary>${esc(findingLabel(finding.type))}: ${esc(finding.title)}</summary>${finding.subtitle ? `<p>${esc(finding.subtitle)}</p>` : ''}${finding.narrative ? `<p>${esc(finding.narrative)}</p>` : ''}<p class="team-finding-meta">${esc(people.join(' · '))}${people.length ? ' · ' : ''}${timeMarkup(finding.created_at, 'Recorded')}</p></details>`;
  }).join('')}</li>`).join('') || '<li>No open tasks are recorded in this shared list.</li>'}</ol></details></article>`;
}

export async function readTeamResource(path, signal, { timeoutMs = 15000, fetcher = fetch } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  try {
    const response = await fetcher(path, { cache: 'no-store', signal: controller.signal });
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* Error responses may be HTML. */ }
    if (!response.ok) throw Object.assign(new Error(body?.error || 'Shared work could not be loaded.'), { status: response.status });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('The shared work response could not be read.');
    return body;
  } catch (error) {
    if (timedOut) throw new Error('The team connection timed out. Refresh to try again.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}

export function setupTeamView() {
  const state = { active: false, teams: [], selected: '', appUrl: 'https://cmem.ai/teambrain/app', board: null, pending: null, signature: '', search: '', project: '', controller: null, serial: 0, lastReceived: 0, receivedAt: null, lastError: null, currentError: '', loading: false, inFlight: false };
  let timer = null;
  let personalHash = location.hash === '#teambrain' ? '#cards' : location.hash || '#cards';
  const read = (path, signal) => readTeamResource(path, signal);
  function paintHealth() {
    const health = $('team-health');
    const stale = state.lastReceived && teamReceiptIsStale(state.receivedAt);
    health.dataset.state = state.currentError ? 'error' : stale ? 'stale' : state.loading ? 'connecting' : state.lastReceived ? 'live' : 'idle';
    const message = state.currentError || (stale ? 'Shared updates stale. Checking for a fresh update…' : state.loading ? 'Checking your TeamBrain connection…' : state.lastReceived ? 'Shared updates connected' : 'TeamBrain is optional. My Work remains local and free.');
    if (health.textContent !== message) health.textContent = message;
    $('team-received').textContent = state.lastReceived ? `Last successful update ${relativeTime(state.lastReceived)} · ${new Date(state.lastReceived).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'No shared update received in this visit.';
    $('team-last-error').hidden = !state.lastError;
    if (state.lastError) $('team-last-error').textContent = `Last connection issue at ${new Date(state.lastError.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${state.lastError.message}`;
    for (const element of document.querySelectorAll('[data-team-time]')) element.textContent = `${element.dataset.timePrefix} ${relativeTime(Number(element.dataset.teamTime))}`;
    for (const id of ['team-refresh', 'team-refresh-connected']) $(id).disabled = state.loading;
  }
  function startPolling() {
    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      paintHealth();
      if (state.selected) void loadBoard();
    }, 5000);
  }
  function stop() { state.controller?.abort(); state.controller = null; clearInterval(timer); timer = null; state.serial++; state.inFlight = false; }
  function show(active, updateRoute = true) {
    if (active && !state.active && location.hash !== '#teambrain') personalHash = location.hash || '#cards';
    state.active = active;
    $('personal-workspace').hidden = active; $('team-workspace').hidden = !active;
    $('workspace-personal').setAttribute('aria-pressed', String(!active)); $('workspace-team').setAttribute('aria-pressed', String(active));
    if (updateRoute) history.replaceState(null, '', `${location.pathname}${location.search}${active ? '#teambrain' : personalHash}`);
    stop();
    if (active) {
      void loadTeams();
      startPolling();
    }
  }
  function failure(error, context = 'Shared work') {
    if (error.name === 'AbortError') return;
    state.currentError = `${context} unavailable. ${error.message}`;
    state.lastError = { at: Date.now(), message: state.currentError };
    paintHealth();
    if ([401, 403, 404].includes(error.status)) {
      state.board = null; state.pending = null; state.signature = '';
      $('team-updates').replaceChildren(); renderBoard();
    }
  }
  async function loadTeams() {
    const serial = ++state.serial;
    state.inFlight = false;
    state.controller?.abort(); state.controller = new AbortController();
    state.loading = true; paintHealth();
    try {
      const result = await read('/api/teambrain/status', state.controller.signal);
      if (!state.active || serial !== state.serial) return;
      if (!Array.isArray(result.teams)) throw new Error('The team membership response could not be read.');
      state.currentError = ''; state.teams = result.teams || []; state.appUrl = result.appUrl || 'https://cmem.ai/teambrain/app';
      $('team-setup').hidden = result.configured && state.teams.length > 0;
      $('team-connected').hidden = !result.configured || state.teams.length === 0;
      if (!result.configured || !state.teams.length) {
        state.selected = ''; state.board = null; state.pending = null; state.signature = ''; state.lastReceived = 0; state.receivedAt = null;
        if (result.configured) state.currentError = 'No active TeamBrain membership was found for this install. Check your account or invitation in TeamBrain.';
        return;
      }
      const previousTeam = state.selected;
      state.selected = state.teams.some(team => team.id === state.selected) ? state.selected
        : state.teams.some(team => team.id === result.selectedTeamId) ? result.selectedTeamId : state.teams[0].id;
      if (state.selected !== previousTeam) { state.lastReceived = 0; state.receivedAt = null; state.board = null; state.pending = null; state.signature = ''; $('team-updates').replaceChildren(); }
      $('team-select').innerHTML = state.teams.map(team => `<option value="${esc(team.id)}" ${team.id === state.selected ? 'selected' : ''}>${esc(team.name)}</option>`).join('');
      renderBoard();
      await loadBoard();
    } catch (error) { if (serial === state.serial && state.active) failure(error, 'Team membership'); }
    finally { if (serial === state.serial) { state.loading = false; paintHealth(); } }
  }
  async function loadBoard() {
    if (!state.active || !state.selected || state.inFlight) return;
    state.inFlight = true;
    const selected = state.selected, serial = state.serial;
    try {
      const result = await read(`/api/teambrain/board?team_id=${encodeURIComponent(selected)}`, state.controller?.signal);
      if (!state.active || serial !== state.serial || selected !== state.selected) return;
      if (!Array.isArray(result.lists) || !Array.isArray(result.findings)) throw new Error('The shared board response could not be read.');
      state.lastReceived = Date.now(); state.receivedAt = performance.now();
      state.currentError = ''; paintHealth();
      const signature = JSON.stringify(result);
      if (signature === state.signature) return;
      state.signature = signature;
      if (state.board && (window.scrollY > 220 || document.querySelector('.team-card details[open]') || document.activeElement?.closest('.team-card, .team-controls'))) {
        state.pending = result;
        $('team-updates').innerHTML = '<div class="updates-banner"><span>New shared updates are ready. Your place is saved.</span><button type="button" id="apply-team-updates">Show updates</button></div>';
        $('apply-team-updates').onclick = () => { state.board = state.pending; state.pending = null; $('team-updates').replaceChildren(); renderBoard(); $('shared-work-heading').focus({ preventScroll: true }); };
      } else { state.board = result; state.pending = null; $('team-updates').replaceChildren(); renderBoard(); }
    } catch (error) { if (state.active && serial === state.serial && selected === state.selected) failure(error); }
    finally { if (serial === state.serial) state.inFlight = false; }
  }
  function renderBoard() {
    const team = state.teams.find(item => item.id === state.selected);
    $('team-name').textContent = team?.name || 'Shared work';
    $('team-sharing').textContent = team ? sharingDescription(team) : '';
    $('team-seat-count').textContent = team?.seatsUsed != null && team.seatLimit != null ? `${team.seatsUsed} of ${team.seatLimit} seats` : '';
    const appUrl = new URL(state.appUrl); if (state.selected) appUrl.searchParams.set('team', state.selected);
    $('team-manage').href = appUrl.href;
    const board = state.board;
    if (!board) { $('team-cards').innerHTML = '<div class="team-empty"><h3>No shared work loaded</h3><p>Refresh the connection or open Team settings. Your personal work remains available.</p></div>'; $('team-count').textContent = ''; return; }
    const projects = [...new Set(board.lists.map(list => list.project))].sort();
    if (state.project && !projects.includes(state.project)) state.project = '';
    $('team-project').hidden = projects.length < 2;
    $('team-project').innerHTML = '<option value="">All projects</option>' + projects.map(project => `<option value="${esc(project)}" ${state.project === project ? 'selected' : ''}>${esc(project)}</option>`).join('');
    const open = new Set([...document.querySelectorAll('.team-card details[open]')].map(item => item.dataset.list));
    const lists = filterTeamLists(board, state);
    const taskCount = lists.reduce((sum, list) => sum + openTeamTasks(list).length, 0);
    $('team-count').textContent = `${lists.length} shared ${lists.length === 1 ? 'list' : 'lists'} · ${taskCount} open ${taskCount === 1 ? 'task' : 'tasks'}`;
    const findings = new Map(board.findings.map(finding => [finding.id, finding]));
    const members = new Map(board.lists.map(list => [list.user_id, list.display_name]));
    const expandedFindings = new Set([...document.querySelectorAll('.team-finding[open]')].map(element => element.dataset.finding));
    $('team-cards').innerHTML = lists.length ? lists.map(list => teamCardHtml(list, findings, members, open.has(JSON.stringify([list.user_id, list.project, list.name])))).join('') : '<div class="team-empty"><h3>No shared work in this view</h3><p>Only work your teammates chose to share appears here. Try another project or search.</p></div>';
    for (const element of document.querySelectorAll('.team-finding')) if (expandedFindings.has(element.dataset.finding)) element.open = true;
  }
  $('workspace-personal').onclick = () => show(false);
  $('workspace-team').onclick = () => show(true);
  $('team-refresh').onclick = () => { state.signature = ''; void loadTeams(); };
  $('team-refresh-connected').onclick = () => { state.signature = ''; void loadTeams(); };
  $('team-select').onchange = event => { stop(); state.selected = event.target.value; state.lastReceived = 0; state.receivedAt = null; state.lastError = null; state.currentError = ''; state.board = null; state.pending = null; state.signature = ''; $('team-updates').replaceChildren(); renderBoard(); state.controller = new AbortController(); paintHealth(); void loadBoard(); startPolling(); };
  $('team-search').oninput = event => { state.search = event.target.value.trim().toLowerCase(); renderBoard(); };
  $('team-project').onchange = event => { state.project = event.target.value; renderBoard(); $('team-project').focus({ preventScroll: true }); };
  document.addEventListener('visibilitychange', () => {
    if (!state.active || document.visibilityState !== 'visible') return;
    paintHealth();
    if (state.selected) void loadBoard();
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('popstate', () => {
    const active = location.hash === '#teambrain';
    if (active !== state.active) show(active, false);
  });
  if (location.hash === '#teambrain') show(true);
}
