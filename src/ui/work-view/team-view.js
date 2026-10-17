import { relativeTime } from './view-model.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const field = (pairs, names) => names.map(name => pairs?.find(pair => pair[0] === name)?.[1]).find(value => typeof value === 'string' && value.trim()) || '';
const statusLabel = value => ({ doing: 'In progress', 'in-progress': 'In progress', todo: 'To do', blocked: 'Blocked', 'needs-you': 'Needs you', 'needs-input': 'Needs you', 'waiting-on-user': 'Needs you', 'awaiting-approval': 'Needs you' })[String(value || '').toLowerCase()] || (value || 'Recorded update');
const detailLabel = key => ({ human_summary: 'Update', progress: 'Progress', next: 'Next', next_step: 'Next', outcome: 'Outcome', result: 'Result' })[key] || key;

export function sharingDescription(team) {
  if (!team.broadcasting) return 'You are viewing shared work. Sharing from this computer is off.';
  const scope = team.projects === null ? 'all projects' : team.projects?.length ? team.projects.join(', ') : 'no projects selected';
  return `Your sharing setting is on for ${scope}.`;
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
  const state = { active: false, teams: [], selected: '', appUrl: 'https://cmem.ai/teambrain/app', board: null, pending: null, signature: '', search: '', project: '', controller: null, serial: 0, lastReceived: 0, inFlight: false };
  let timer = null;
  const read = (path, signal) => readTeamResource(path, signal);
  function stop() { state.controller?.abort(); state.controller = null; clearInterval(timer); timer = null; state.serial++; state.inFlight = false; }
  function show(active) {
    state.active = active;
    $('personal-workspace').hidden = active; $('team-workspace').hidden = !active;
    $('workspace-personal').setAttribute('aria-pressed', String(!active)); $('workspace-team').setAttribute('aria-pressed', String(active));
    history.replaceState(null, '', `${location.pathname}${location.search}${active ? '#teambrain' : ''}`);
    stop();
    if (active) {
      void loadTeams();
      timer = setInterval(() => { if (document.visibilityState === 'visible' && state.selected) void loadBoard(); }, 5000);
    }
  }
  function failure(error, context = 'Shared work') {
    if (error.name === 'AbortError') return;
    $('team-health').textContent = `${context} unavailable. ${error.message}`;
    $('team-health').dataset.state = 'error';
    if ([401, 403, 404].includes(error.status)) {
      state.board = null; state.pending = null; state.signature = '';
      $('team-updates').replaceChildren(); renderBoard();
    }
  }
  async function loadTeams() {
    const serial = ++state.serial;
    state.inFlight = false;
    state.controller?.abort(); state.controller = new AbortController();
    $('team-health').textContent = 'Checking your TeamBrain membership…'; $('team-health').dataset.state = 'connecting';
    try {
      const result = await read('/api/teambrain/status', state.controller.signal);
      if (!state.active || serial !== state.serial) return;
      if (!Array.isArray(result.teams)) throw new Error('The team membership response could not be read.');
      state.teams = result.teams || []; state.appUrl = result.appUrl || 'https://cmem.ai/teambrain/app';
      $('team-setup').hidden = result.configured && state.teams.length > 0;
      $('team-connected').hidden = !result.configured || state.teams.length === 0;
      if (!result.configured || !state.teams.length) {
        state.selected = ''; state.board = null;
        $('team-health').textContent = result.configured ? 'No active TeamBrain membership was found for this install.' : 'Personal work is local and free. TeamBrain is optional.';
        return;
      }
      const previousTeam = state.selected;
      state.selected = state.teams.some(team => team.id === state.selected) ? state.selected
        : state.teams.some(team => team.id === result.selectedTeamId) ? result.selectedTeamId : state.teams[0].id;
      if (state.selected !== previousTeam) { state.board = null; state.pending = null; state.signature = ''; $('team-updates').replaceChildren(); }
      $('team-select').innerHTML = state.teams.map(team => `<option value="${esc(team.id)}" ${team.id === state.selected ? 'selected' : ''}>${esc(team.name)}</option>`).join('');
      renderBoard();
      await loadBoard();
    } catch (error) { if (serial === state.serial && state.active) failure(error, 'Team membership'); }
  }
  async function loadBoard() {
    if (!state.active || !state.selected || state.inFlight) return;
    state.inFlight = true;
    const selected = state.selected, serial = state.serial;
    try {
      const result = await read(`/api/teambrain/board?team_id=${encodeURIComponent(selected)}`, state.controller?.signal);
      if (!state.active || serial !== state.serial || selected !== state.selected) return;
      if (!Array.isArray(result.lists) || !Array.isArray(result.findings)) throw new Error('The shared board response could not be read.');
      state.lastReceived = Date.now();
      $('team-health').textContent = `Shared updates connected · received ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      $('team-health').dataset.state = 'live';
      const signature = JSON.stringify(result);
      if (signature === state.signature) return;
      state.signature = signature;
      if (state.board && (window.scrollY > 220 || document.querySelector('.team-card details[open]') || document.activeElement?.closest('.team-card, .team-controls'))) {
        state.pending = result;
        $('team-updates').innerHTML = '<div class="updates-banner"><span>New shared updates are ready. Your place is saved.</span><button type="button" id="apply-team-updates">Show updates</button></div>';
        $('apply-team-updates').onclick = () => { state.board = state.pending; state.pending = null; $('team-updates').replaceChildren(); renderBoard(); $('shared-work-heading').focus({ preventScroll: true }); };
      } else { state.board = result; renderBoard(); }
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
    if (!board) { $('team-cards').innerHTML = '<div class="empty-work"><h3>No shared work loaded</h3><p>Refresh the connection or open the team workspace. Your personal work remains available.</p></div>'; $('team-count').textContent = ''; return; }
    const projects = [...new Set(board.lists.map(list => list.project))].sort();
    if (state.project && !projects.includes(state.project)) state.project = '';
    $('team-project').hidden = projects.length < 2;
    $('team-project').innerHTML = '<option value="">All projects</option>' + projects.map(project => `<option value="${esc(project)}" ${state.project === project ? 'selected' : ''}>${esc(project)}</option>`).join('');
    const open = new Set([...document.querySelectorAll('.team-card details[open]')].map(item => item.dataset.list));
    const lists = board.lists.filter(list => (!state.project || list.project === state.project)
      && (!state.search || `${list.name} ${list.display_name} ${list.project} ${JSON.stringify(list.state)} ${list.tasks.map(task => task.name).join(' ')}`.toLowerCase().includes(state.search)));
    const taskCount = lists.reduce((sum, list) => sum + list.tasks.length, 0);
    $('team-count').textContent = `${lists.length} shared ${lists.length === 1 ? 'list' : 'lists'} · ${taskCount} open ${taskCount === 1 ? 'task' : 'tasks'}`;
    const findings = new Map(board.findings.map(finding => [finding.id, finding]));
    $('team-cards').innerHTML = lists.length ? lists.map(list => {
      const key = JSON.stringify([list.user_id, list.project, list.name]);
      const summary = field(list.state, ['human_summary', 'progress', 'stage', 'phase']);
      const next = field(list.state, ['next', 'next_step', 'next_action']) || field(list.tasks[0]?.details, ['next', 'next_step', 'next_action']);
      return `<article class="work-card team-card" tabindex="-1"><div class="card-top"><span class="status">Shared work</span><span class="card-time">${esc(relativeTime(list.last_written_at))}</span></div><h3 class="card-title">${esc(list.name)}</h3>${summary ? `<p class="card-activity">${esc(summary)}</p>` : ''}<div class="agent-line"><span class="agent-name">${esc(list.display_name)}</span><span class="agent-dot" aria-hidden="true"></span><span>${esc(list.project)}</span></div>${next ? `<div class="handoff-note"><span class="handoff-label">Next</span><span>${esc(next)}</span></div>` : ''}<div class="card-footer"><details data-list="${esc(key)}" ${open.has(key) ? 'open' : ''}><summary><span class="disclosure-chevron" aria-hidden="true"></span>${list.tasks.length} open ${list.tasks.length === 1 ? 'task' : 'tasks'}</summary><ol class="activity-list">${list.tasks.map(task => `<li><strong>${esc(task.name)}</strong><div class="team-task-status">${esc(statusLabel(task.status))}</div>${task.details.filter(([name, value]) => typeof value === 'string' && ['human_summary', 'progress', 'next', 'next_step', 'outcome', 'result'].includes(name)).map(([name, value]) => `<p><strong>${esc(detailLabel(name))}:</strong> ${esc(value)}</p>`).join('')}${task.finding_ids.map(id => findings.get(id)).filter(Boolean).map(finding => `<details class="team-finding"><summary>${esc(finding.type)} · ${esc(finding.title)}</summary><p>${esc(finding.narrative || finding.subtitle || '')}</p></details>`).join('')}</li>`).join('') || '<li>No open tasks in this list.</li>'}</ol></details></div></article>`;
    }).join('') : '<div class="empty-work"><h3>No shared work in this view</h3><p>Only work your teammates chose to share appears here. Try another project or search.</p></div>';
  }
  $('workspace-personal').onclick = () => show(false);
  $('workspace-team').onclick = () => show(true);
  $('team-refresh').onclick = () => { state.signature = ''; void loadTeams(); };
  $('team-refresh-connected').onclick = () => { state.signature = ''; void loadTeams(); };
  $('team-select').onchange = event => { stop(); state.selected = event.target.value; state.board = null; state.pending = null; state.signature = ''; $('team-updates').replaceChildren(); renderBoard(); state.controller = new AbortController(); void loadBoard(); timer = setInterval(() => { if (document.visibilityState === 'visible') void loadBoard(); }, 5000); };
  $('team-search').oninput = event => { state.search = event.target.value.trim().toLowerCase(); renderBoard(); };
  $('team-project').onchange = event => { state.project = event.target.value; renderBoard(); $('team-project').focus({ preventScroll: true }); };
  window.addEventListener('pagehide', stop);
  if (location.hash === '#teambrain') show(true);
}
