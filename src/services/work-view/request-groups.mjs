// Overall-request ledger. Works backwards from recorded work to the human
// conversations behind it, then stores evidence-backed groups, per-group
// progress reviews and the build story beside My Work's other caches.
// The request-progress skill runs the bundled CLI (request-groups-cli.mjs) with bun:
//
//   bun request-groups.mjs candidates [--days 14] [--project root] [--brief]
//                                                   conversations + deterministic links
//   bun request-groups.mjs grouping-input [--days 14] [--limit 20]
//                                                   undecided conversations of one root + its open requests
//   bun request-groups.mjs judge [--days 14] [--apply]  route every undecided conversation with the judge
//                                                   (code links, then Jev when the install has it); plan only without --apply
//   bun request-groups.mjs apply <file|->            persist group decisions
//   bun request-groups.mjs pending [--days 14] [--limit 48]   groups needing a progress review
//   bun request-groups.mjs show <groupId>           one group's asks, work lists and dates (only new asks when amending)
//   bun request-groups.mjs record-progress <file|-> persist one progress review
//   bun request-groups.mjs story-input              reviews whose facts changed since the last story (all without one)
//   bun request-groups.mjs record-story <file|->    persist the build story and preferences
//   bun request-groups.mjs focus-input [--limit 20]  focus areas + one batch of requests still to place
//   bun request-groups.mjs focus-input --other       focus areas + the requests in Other, to propose areas from
//   bun request-groups.mjs record-focus [--limit 20 | --other] <file|->
//                                                   place requests and propose areas (saved through the worker)
//   bun request-groups.mjs refresh-needs [--days 14]  what the automatic refresh would do now
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { conversationKey, isConversationKey, isHumanActionRequest, originalFor, requestText } from './request-projection.mjs';
import { GOAL_KINDS, goalKindOf, OWNER_GOALS_LIST } from './owner-goals.mjs';
import { NO_PROJECT, projectRoot, upgradedGroupRoot, withDerivedProjects } from './session-project.mjs';
import { isOwnerDismissedArea, isPlaceableArea, OTHER_FOCUS_AREA_ID, PROPOSAL_KINDS, readFocus } from './my-focus.mjs';

const DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
export const LEDGER_DIR = join(DATA_DIR, 'work-view');
/** Hook-recorded prompts the setup scan judged agent-written; they never become asks. */
export const AGENT_WRITTEN_PROMPTS_FILE = 'agent-written-prompts.json';
const DAY_MS = 86400000;
/** Goals older than this make the automatic refresh run owner-goals again. */
export const GOALS_STALE_MS = DAY_MS;
// A list touched by many conversations is a shared bucket, not proof of one goal.
const MAX_CONVERSATIONS_PER_LINKING_LIST = 8;
export const PROGRESS_STATES = ['shipped', 'in-progress', 'stalled', 'abandoned', 'unknown'];
export const PREFERENCE_KINDS = ['directive', 'correction', 'praise', 'frustration'];
export const USAGE_LEVELS = ['in-use', 'some-use', 'no-evidence', 'unknown'];
export const VALUE_LEVELS = ['high', 'medium', 'low', 'unclear'];
// `judge` links are written by code (request-judge.mjs): their evidence names the judge and its score.
const LINK_KINDS = ['shared-work-list', 'shared-request-id', 'agent-judgment', 'judge'];
// Each review adds one dated percent; the measured ETA reads the last two.
export const MAX_READINGS = 20;

const iso = (epoch) => Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
export const groupIdFor = (anchorConversationKey) => `g_${createHash('sha256').update(anchorConversationKey).digest('hex').slice(0, 12)}`;

function placeholders(values) { return values.map(() => '?').join(','); }

// Pass sinceEpoch for a time window, or conversationKeys for specific conversations.
// fullAsks returns every qualifying ask untruncated (for `show`); listings stay short.
// excludedPromptIds: hook-recorded prompts the setup scan found an agent wrote (agent-written-prompts.json).
export function readCandidates(database, { sinceEpoch = 0, conversationKeys = null, fullAsks = false, excludedPromptIds = null }) {
  const columns = 'SELECT id, platform_source, content_session_id, project, user_prompt, started_at_epoch FROM sdk_sessions';
  const pairs = conversationKeys?.map((key) => JSON.parse(key).slice(1));
  const stored = pairs
    ? pairs.length ? database.prepare(`${columns} WHERE (platform_source, content_session_id) IN (VALUES ${pairs.map(() => '(?, ?)').join(',')})`).all(...pairs.flat()) : []
    // Any recent activity counts: a new start, prompt, observation or recorded tool use (a commit, a push, a work-state write).
    : database.prepare(`${columns} WHERE started_at_epoch >= ?
        OR id IN (SELECT DISTINCT session_db_id FROM user_prompts WHERE created_at_epoch >= ?)
        OR id IN (SELECT DISTINCT session_db_id FROM tool_uses WHERE created_at_epoch >= ?)
        OR memory_session_id IN (SELECT DISTINCT memory_session_id FROM observations WHERE created_at_epoch >= ?)`).all(sinceEpoch, sinceEpoch, sinceEpoch, sinceEpoch);
  if (!stored.length) return [];
  // A session started from an agent scratch folder takes the repo its tool calls touched.
  const sessions = withDerivedProjects(database, stored);
  const ids = sessions.map((session) => session.id);
  const prompts = database.prepare(`SELECT id, session_db_id, prompt_number, ${fullAsks ? 'prompt_text' : 'substr(prompt_text, 1, 1200) AS prompt_text'}, created_at_epoch
    FROM user_prompts WHERE session_db_id IN (${placeholders(ids)})`).all(...ids);
  const writes = database.prepare(`SELECT session_db_id, tool_input, created_at_epoch FROM tool_uses
    WHERE tool_name LIKE '%work_state_write%' AND session_db_id IN (${placeholders(ids)})`).all(...ids);
  const observations = database.prepare(`SELECT s.id AS session_db_id, COUNT(*) AS count, MAX(o.created_at_epoch) AS last_epoch
    FROM observations o JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE s.id IN (${placeholders(ids)}) GROUP BY s.id`).all(...ids);
  const observationsBySession = new Map(observations.map((row) => [row.session_db_id, row]));
  // Work after a review without a new prompt or observation (a commit, a push) still makes the review due again.
  const toolActivity = database.prepare(`SELECT session_db_id, MAX(created_at_epoch) AS last_epoch FROM tool_uses
    WHERE session_db_id IN (${placeholders(ids)}) GROUP BY session_db_id`).all(...ids);
  const lastToolUseBySession = new Map(toolActivity.map((row) => [row.session_db_id, row.last_epoch ?? 0]));
  const promptsBySession = new Map();
  for (const prompt of prompts) {
    if (!promptsBySession.has(prompt.session_db_id)) promptsBySession.set(prompt.session_db_id, []);
    promptsBySession.get(prompt.session_db_id).push(prompt);
  }
  const candidates = new Map();
  for (const session of sessions) {
    const key = conversationKey(session);
    const all = promptsBySession.get(session.id) ?? [];
    const own = all.filter((prompt) => !excludedPromptIds?.has(prompt.id));
    // The session's stored opening prompt is a copy of its first prompt row: a rejected first prompt stays rejected.
    const openingRejected = all.some((prompt) => excludedPromptIds?.has(prompt.id) && (prompt.prompt_number === 1 || prompt.prompt_text === session.user_prompt));
    const original = key ? originalFor(openingRejected ? { ...session, user_prompt: null } : session, own) : null;
    if (!original) continue;
    own.sort((a, b) => a.created_at_epoch - b.created_at_epoch || a.id - b.id);
    const lastPrompt = own.at(-1)?.created_at_epoch ?? 0;
    const asks = own.filter((prompt) => isHumanActionRequest(prompt.prompt_text))
      .map((prompt) => ({ promptId: prompt.id, at: iso(prompt.created_at_epoch), text: requestText(prompt.prompt_text, fullAsks ? Infinity : 280) }));
    candidates.set(key, {
      conversationKey: key, platform: session.platform_source, project: session.project,
      startedAt: iso(original.atEpoch ?? session.started_at_epoch), startedAtEpoch: original.atEpoch ?? session.started_at_epoch,
      lastActivityEpoch: Math.max(lastPrompt, observationsBySession.get(session.id)?.last_epoch ?? 0, lastToolUseBySession.get(session.id) ?? 0, session.started_at_epoch ?? 0),
      firstAsk: requestText(original.text, 600), asks: fullAsks ? asks : asks.slice(0, 10), askCount: asks.length, original,
      workLists: [], requestIds: [], observationCount: observationsBySession.get(session.id)?.count ?? 0,
      sessionDbId: session.id,
    });
  }
  const bySession = new Map([...candidates.values()].map((candidate) => [candidate.sessionDbId, candidate]));
  for (const write of writes) {
    const candidate = bySession.get(write.session_db_id);
    if (!candidate) continue;
    let input;
    try { input = JSON.parse(write.tool_input); } catch { continue; }
    if (typeof input?.list === 'string' && !candidate.workLists.includes(input.list)) candidate.workLists.push(input.list);
    const requestId = input?.fields?.request_id;
    if (['string', 'number'].includes(typeof requestId) && String(requestId).trim() && !candidate.requestIds.includes(String(requestId).trim())) candidate.requestIds.push(String(requestId).trim());
    candidate.lastActivityEpoch = Math.max(candidate.lastActivityEpoch, write.created_at_epoch ?? 0);
  }
  return [...candidates.values()].sort((a, b) => a.startedAtEpoch - b.startedAtEpoch)
    .map(({ sessionDbId, lastActivityEpoch, ...candidate }) => ({ ...candidate, lastActivityAt: iso(lastActivityEpoch), lastActivityEpoch }));
}

/** Union conversations that recorded into the same work list or request id.
 * A list name or request id links only within one project root, so worktrees
 * of one repo link and different repos never do. */
export function linkBackwards(candidates) {
  const parent = new Map(candidates.map((candidate) => [candidate.conversationKey, candidate.conversationKey]));
  const find = (key) => { while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); } return key; };
  const links = [];
  const skippedLists = [];
  const shared = (kind, field) => {
    const owners = new Map();
    for (const candidate of candidates) for (const value of candidate[field]) {
      const scope = JSON.stringify([projectRoot(candidate.project), value]);
      if (!owners.has(scope)) owners.set(scope, { value, project: candidate.project, keys: [] });
      owners.get(scope).keys.push(candidate.conversationKey);
    }
    for (const { value, project, keys } of owners.values()) {
      if (keys.length < 2) continue;
      if (kind === 'shared-work-list' && keys.length > MAX_CONVERSATIONS_PER_LINKING_LIST) { skippedLists.push({ list: value, project, conversations: keys.length }); continue; }
      for (const key of keys.slice(1)) parent.set(find(key), find(keys[0]));
      links.push({ kind, conversations: keys, evidence: kind === 'shared-work-list' ? `work list "${value}" in ${project}` : `request_id "${value}"` });
    }
  };
  shared('shared-request-id', 'requestIds');
  shared('shared-work-list', 'workLists');
  const groups = new Map();
  for (const candidate of candidates) {
    const root = find(candidate.conversationKey);
    if (!groups.has(root)) groups.set(root, { conversations: [], links: [] });
    groups.get(root).conversations.push(candidate.conversationKey);
  }
  for (const link of links) groups.get(find(link.conversations[0])).links.push(link);
  return { proposedGroups: [...groups.values()], skippedLists };
}

/** Fold the owner-goals list (patch entries) into its open focus areas and asks, areas first. */
export function readGoals(database) {
  const rows = database.prepare('SELECT fields FROM work_state_entries WHERE list_name = ? ORDER BY id').all(OWNER_GOALS_LIST);
  const listState = {}, items = new Map();
  for (const row of rows) {
    const fields = JSON.parse(row.fields);
    const target = fields.task ? items.get(fields.task) ?? items.set(fields.task, {}).get(fields.task) : listState;
    for (const [key, value] of Object.entries(fields)) { if (value === null) delete target[key]; else target[key] = value; }
  }
  const goals = [...items.values()].filter((item) => !['done', 'dropped'].includes(String(item.status).toLowerCase())).map((item) => ({
    // taskKey is the item's work-state task; goal is only ever a focus area's sentence.
    taskKey: item.task, ...goalKindOf(item), rank: Number(item.rank) || null,
    title: item.title ?? item.task, goal: item.goal ?? null, focusArea: item.focus_area ?? null, focusAreaId: item.focus_area_id ?? null,
    latestAt: item.latest_at ?? null, timesAsked: Number(item.times_asked) || null,
    // A later local refresh changes snapshot, so it cannot reuse an older hosted JSON evidence field.
    evidence: item.source === 'hosted-intent' && item.hosted_snapshot === item.snapshot
      ? JSON.parse(item.evidence_json)
      : String(item.evidence ?? '').split('\n').filter(Boolean).map((line) => { const [at, ...quote] = line.split(' | '); return { at, quote: quote.join(' | ') }; }),
  })).sort((a, b) => GOAL_KINDS.indexOf(a.kind) - GOAL_KINDS.indexOf(b.kind) || (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return { summary: listState.human_summary ?? null, generatedAt: listState.generated_at ?? null, mapPath: listState.map_path ?? null, goals };
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

const emptyGroups = () => ({ version: 1, updatedAt: null, conversations: {}, groups: {}, ignored: {} });

/** Merge decisions into the stored ledger. Conversations listed in a decision
 * move to that group; others keep their previous group. `projectOf` maps a
 * conversation key to its project: a group holds one project root only, unless
 * the decision names the request's `projectRoot` itself. */
export function applyGroupDecisions(stored, decisions, now = Date.now(), { projectOf = new Map() } = {}) {
  if (!Array.isArray(decisions?.groups)) throw new TypeError('Decisions need a groups array.');
  const next = structuredClone(stored ?? emptyGroups());
  for (const [index, decision] of decisions.groups.entries()) {
    const label = `groups[${index}]`;
    if (typeof decision.title !== 'string' || !decision.title.trim() || decision.title.length > 120) throw new TypeError(`${label}.title must be 1–120 characters.`);
    if (!Array.isArray(decision.conversations) || !decision.conversations.length || !decision.conversations.every(isConversationKey)) throw new TypeError(`${label}.conversations must list conversation keys, earliest first.`);
    const links = decision.links ?? [];
    const members = new Set(decision.conversations);
    const parent = new Map(decision.conversations.map((key) => [key, key]));
    const find = (key) => { while (parent.get(key) !== key) key = parent.get(key); return key; };
    for (const link of links) {
      if (!LINK_KINDS.includes(link.kind)) throw new TypeError(`${label} has unknown link kind ${link.kind}.`);
      if (typeof link.evidence !== 'string' || !link.evidence.trim()) throw new TypeError(`${label} has a link without evidence.`);
      if (!Array.isArray(link.conversations) || link.conversations.length < 2 || !link.conversations.every((key) => members.has(key))) throw new TypeError(`${label} has a link that must name 2+ of the group's own conversations.`);
      for (const key of link.conversations.slice(1)) parent.set(find(key), find(link.conversations[0]));
    }
    if (decision.conversations.length > 1 && !links.length) throw new TypeError(`${label} joins conversations without a recorded link.`);
    const unsupported = decision.conversations.filter((key) => find(key) !== find(decision.conversations[0]));
    if (unsupported.length) throw new TypeError(`${label} joins ${unsupported.join(', ')} without evidence linking it to the anchor.`);
    const id = groupIdFor(decision.conversations[0]);
    // A decision may name the request's root itself: conversations from other roots may then join it, and
    // the group records that root. Without one, a request stays in one project root, members it already
    // has included. A group saved with a named root keeps that allowance when a later decision (a refresh
    // answer, whose schema has no projectRoot) extends it.
    if (decision.projectRoot != null && (typeof decision.projectRoot !== 'string' || !decision.projectRoot.trim())) throw new TypeError(`${label}.projectRoot must be a non-empty string when given.`);
    const explicitRoot = decision.projectRoot ?? (next.groups[id]?.rootNamed ? next.groups[id].projectRoot : null);
    const allMembers = [...new Set([...decision.conversations, ...Object.entries(next.conversations).filter(([key, groupId]) => groupId === id && !decision.conversations.includes(key)).map(([key]) => key)])];
    const storedRoot = upgradedGroupRoot(next.groups[id]?.projectRoot, projectRoot(projectOf.get(next.groups[id]?.anchor)),
      allMembers.map((key) => projectRoot(projectOf.get(key))));
    // A group decided before its project was known (the "no project" root) takes the root its members show now:
    // its earlier members may still show none, and that does not split it.
    const rootWasUnknown = storedRoot === NO_PROJECT;
    const roots = new Map();
    for (const key of allMembers) {
      const root = projectRoot(projectOf.get(key));
      if (root == null || (rootWasUnknown && root === NO_PROJECT && !decision.conversations.includes(key))) continue;
      roots.set(root, [...(roots.get(root) ?? []), key]);
    }
    if (typeof storedRoot === 'string' && !rootWasUnknown && !roots.has(storedRoot)) roots.set(storedRoot, []);
    if (explicitRoot == null && roots.size > 1) throw new TypeError(`${label} joins conversations from different projects (${[...roots.keys()].map((root) => root || 'no project').join(', ')}); a request stays inside one project root.`);
    const projectRootOfGroup = explicitRoot != null ? explicitRoot.trim() : roots.size ? [...roots.keys()][0] : storedRoot ?? null;
    for (const key of decision.conversations) {
      next.conversations[key] = id;
      // A later decision can correct an earlier ignore; the viewer checks ignored first.
      if (next.ignored) delete next.ignored[key];
    }
    // A decision adds its evidence to the request's: a conversation joined one at a time (the judge, the
    // owner's Join) names only its own link, and the links of members that stay must survive it. Links
    // naming a conversation that left the group go with it.
    const memberSet = new Set(allMembers);
    const keptLinks = (next.groups[id]?.links ?? []).filter((link) => link.conversations.every((key) => memberSet.has(key)));
    const known = new Set(keptLinks.map((link) => JSON.stringify(link)));
    const mergedLinks = [...keptLinks, ...links.filter((link) => !known.has(JSON.stringify(link)))];
    next.groups[id] = { title: decision.title.trim(), anchor: decision.conversations[0], projectRoot: projectRootOfGroup, ...(explicitRoot != null ? { rootNamed: true } : {}), links: mergedLinks, decidedAt: iso(now), anchorAsk: stored?.groups?.[id]?.anchor === decision.conversations[0] ? stored.groups[id].anchorAsk ?? null : null };
  }
  next.ignored ??= {};
  for (const [index, ignored] of (decisions.ignored ?? []).entries()) {
    if (!isConversationKey(ignored.conversation)) throw new TypeError(`ignored[${index}].conversation must be a conversation key.`);
    next.ignored[ignored.conversation] = boundedText(ignored.reason, 200, `ignored[${index}].reason`);
    delete next.conversations[ignored.conversation];
  }
  const used = new Set(Object.values(next.conversations));
  for (const id of Object.keys(next.groups)) if (!used.has(id)) delete next.groups[id];
  next.updatedAt = iso(now);
  return next;
}

const isIsoOrNull = (value) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
function boundedText(value, max, label, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be 1–${max} characters.`);
  // The length goes in the refusal: an agent asked to fix "must be 1–12000" without it rewrote a 22K story at 22K (Oct 24).
  if (value.length > max) throw new TypeError(`${label} is ${value.length} characters; it must be 1–${max}. Cut at least ${value.length - max} characters.`);
  return value.trim();
}

const evidenceList = (value) => (Array.isArray(value) ? value : []).map(String).slice(0, 8);

// How released work landed: where it shipped, whether anyone uses it, whether
// it was worth it, what it broke, and why each change was made. Every judgment
// cites evidence; "no-evidence" / "unclear" are answers, not gaps to fill.
export function validateOutcome(outcome) {
  if (outcome == null) return null;
  if (typeof outcome !== 'object' || Array.isArray(outcome)) throw new TypeError('outcome must be an object.');
  const leveled = (entry, levels, label) => {
    if (entry == null) return null;
    if (!levels.includes(entry.level)) throw new TypeError(`${label}.level must be one of ${levels.join(', ')}.`);
    return { level: entry.level, text: boundedText(entry.text, 400, `${label}.text`), evidence: evidenceList(entry.evidence) };
  };
  const regressions = outcome.regressions ?? [], changes = outcome.changes ?? [];
  if (!Array.isArray(regressions) || regressions.length > 10) throw new TypeError('outcome.regressions must be an array of at most 10.');
  if (!Array.isArray(changes) || changes.length > 12) throw new TypeError('outcome.changes must be an array of at most 12.');
  const dated = (value, label) => { if (!isIsoOrNull(value ?? null)) throw new TypeError(`${label} must be an ISO date or null.`); return value ?? null; };
  return {
    landed: outcome.landed == null ? null : { text: boundedText(outcome.landed.text, 400, 'outcome.landed.text'), at: dated(outcome.landed.at, 'outcome.landed.at'), evidence: evidenceList(outcome.landed.evidence) },
    usage: leveled(outcome.usage, USAGE_LEVELS, 'outcome.usage'),
    value: leveled(outcome.value, VALUE_LEVELS, 'outcome.value'),
    regressions: regressions.map((regression, index) => ({
      text: boundedText(regression.text, 300, `outcome.regressions[${index}].text`), at: dated(regression.at, `outcome.regressions[${index}].at`),
      fixedBy: boundedText(regression.fixedBy, 200, `outcome.regressions[${index}].fixedBy`, true) || null, evidence: evidenceList(regression.evidence),
    })),
    changes: changes.map((change, index) => ({
      what: boundedText(change.what, 200, `outcome.changes[${index}].what`), why: boundedText(change.why, 400, `outcome.changes[${index}].why`),
      at: dated(change.at, `outcome.changes[${index}].at`), evidence: evidenceList(change.evidence),
    })),
  };
}

/** Progress reviews are agent assessments; keep them bounded and dated. */
export function validateProgress(entry, knownGroups) {
  if (!entry || typeof entry !== 'object') throw new TypeError('Progress must be an object.');
  if (!knownGroups[entry.groupId]) throw new TypeError(`Unknown group ${entry.groupId}.`);
  const basis = entry.reviewBasis;
  if (!basis || typeof basis.checkedThrough !== 'string' || !Number.isFinite(Date.parse(basis.checkedThrough)) || !Array.isArray(basis.conversations) || !basis.conversations.length || !basis.conversations.every(isConversationKey)) {
    throw new TypeError('reviewBasis must be copied verbatim from `show` (checkedThrough and conversations).');
  }
  if (!PROGRESS_STATES.includes(entry.state)) throw new TypeError(`state must be one of ${PROGRESS_STATES.join(', ')}.`);
  if (!Number.isInteger(entry.percent) || entry.percent < 0 || entry.percent > 100) throw new TypeError('percent must be an integer 0–100.');
  for (const field of ['startedAt', 'shippedAt', 'lastActivityAt']) if (!isIsoOrNull(entry[field] ?? null)) throw new TypeError(`${field} must be an ISO date or null.`);
  if (entry.state === 'shipped' && (entry.percent !== 100 || !entry.shippedAt)) throw new TypeError('A shipped request needs percent 100 and shippedAt.');
  if (entry.state !== 'shipped' && entry.shippedAt) throw new TypeError('Only a shipped request has shippedAt.');
  const milestones = entry.milestones ?? [], preferences = entry.preferences ?? [];
  if (!Array.isArray(milestones) || milestones.length > 12) throw new TypeError('milestones must be an array of at most 12.');
  if (!Array.isArray(preferences) || preferences.length > 10) throw new TypeError('preferences must be an array of at most 10.');
  return {
    groupId: entry.groupId, state: entry.state, percent: entry.percent,
    startedAt: entry.startedAt ?? null, shippedAt: entry.shippedAt ?? null, lastActivityAt: entry.lastActivityAt ?? null,
    summary: boundedText(entry.summary, 280, 'summary'),
    narrative: boundedText(entry.narrative, 1200, 'narrative', true),
    milestones: milestones.map((milestone, index) => {
      if (!isIsoOrNull(milestone.at ?? null)) throw new TypeError(`milestones[${index}].at must be an ISO date or null.`);
      return { at: milestone.at ?? null, text: boundedText(milestone.text, 200, `milestones[${index}].text`), evidence: (milestone.evidence ?? []).map(String).slice(0, 6) };
    }),
    preferences: preferences.map((preference, index) => {
      if (!PREFERENCE_KINDS.includes(preference.kind)) throw new TypeError(`preferences[${index}].kind must be one of ${PREFERENCE_KINDS.join(', ')}.`);
      if (!isIsoOrNull(preference.at ?? null)) throw new TypeError(`preferences[${index}].at must be an ISO date or null.`);
      return { kind: preference.kind, preference: boundedText(preference.preference, 200, `preferences[${index}].preference`), quote: boundedText(preference.quote, 300, `preferences[${index}].quote`), at: preference.at ?? null };
    }),
    outcome: validateOutcome(entry.outcome),
    evidence: (entry.evidence ?? []).map(String).slice(0, 20),
    // What the reviewer actually saw: later activity or membership changes make it due again.
    reviewedThrough: new Date(Date.parse(basis.checkedThrough)).toISOString(),
    reviewedConversations: [...new Set(basis.conversations)].sort(),
  };
}

/** The parts of a review the build story and learned preferences are told from. */
function storyFacts(review) {
  return {
    state: review.state, percent: review.percent, startedAt: review.startedAt ?? null, shippedAt: review.shippedAt ?? null,
    milestones: review.milestones ?? [], preferences: review.preferences ?? [], outcome: review.outcome ?? null,
  };
}

/** Add one reading: deduplicated by `at`, oldest first, the newest MAX_READINGS kept. */
export function appendReading(previous, reading) {
  const byAt = new Map((previous?.readings ?? []).filter((item) => Number.isFinite(Date.parse(item?.at)) && Number.isInteger(item?.percent)).map((item) => [item.at, item]));
  byAt.set(reading.at, { at: reading.at, percent: reading.percent });
  return [...byAt.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_READINGS);
}

/** A review is current only for the membership it covered and the activity it saw. */
export function reviewIsCurrent(review, conversationKeys, lastActivityEpoch) {
  if (!review?.reviewedThrough || !Array.isArray(review.reviewedConversations)) return false;
  const current = [...new Set(conversationKeys)].sort();
  if (current.length !== review.reviewedConversations.length || current.some((key, index) => key !== review.reviewedConversations[index])) return false;
  return Date.parse(review.reviewedThrough) >= lastActivityEpoch;
}

export const STORY_NARRATIVE_MAX = 12000;

export function validateStory(story) {
  const preferences = story?.preferences ?? [];
  if (!Array.isArray(preferences) || preferences.length > 30) throw new TypeError('preferences must be an array of at most 30.');
  return {
    narrative: boundedText(story?.narrative, STORY_NARRATIVE_MAX, 'narrative'),
    preferences: preferences.map((preference, index) => ({
      preference: boundedText(preference.preference, 200, `preferences[${index}].preference`),
      kind: PREFERENCE_KINDS.includes(preference.kind) ? preference.kind : 'directive',
      supportCount: Number.isInteger(preference.supportCount) && preference.supportCount > 0 ? preference.supportCount : 1,
      quotes: (preference.quotes ?? []).slice(0, 3).map((quote, quoteIndex) => ({ quote: boundedText(quote.quote, 300, `preferences[${index}].quotes[${quoteIndex}]`), at: isIsoOrNull(quote.at ?? null) ? quote.at ?? null : null })),
    })),
  };
}

/** Suggestions still waiting for the owner: the judge's mid-band picks (request-judge.mjs) whose
 * request still exists and whose conversation is not in it yet. */
export function openSuggestions(ledger) {
  const groups = ledger?.groups;
  if (!groups) return [];
  return Object.entries(groups.suggestions ?? {})
    .filter(([key, suggestion]) => suggestion?.status === 'open' && groups.groups[suggestion.requestId] && groups.conversations[key] !== suggestion.requestId)
    .map(([conversationKey, suggestion]) => ({
      conversationKey, requestId: suggestion.requestId, requestTitle: groups.groups[suggestion.requestId].title,
      confidence: suggestion.confidence, evidence: suggestion.evidence, judge: suggestion.judge, at: suggestion.at ?? null,
    }));
}

/** Everything the monitor needs, read without touching the database. */
export function readLedger(dir = LEDGER_DIR) {
  const groups = readJson(join(dir, 'request-groups.json'), emptyGroups());
  const progress = {};
  let names = [];
  try { names = readdirSync(join(dir, 'progress')).filter((name) => /^g_[0-9a-f]{12}\.json$/.test(name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names) {
    const entry = readJson(join(dir, 'progress', name), null);
    if (entry?.groupId && groups.groups[entry.groupId]) progress[entry.groupId] = { ...entry, title: groups.groups[entry.groupId].title };
  }
  return {
    groups, progress, story: readJson(join(dir, 'story.json'), null), refresh: readJson(join(dir, 'refresh.json'), null),
    agentWrittenPromptIds: new Set(readJson(join(dir, AGENT_WRITTEN_PROMPTS_FILE), { promptIds: [] }).promptIds ?? []),
  };
}

/** Cheap change detector for the monitor's one-second poll. */
export function ledgerSignature(dir = LEDGER_DIR) {
  return ['request-groups.json', 'progress', 'story.json', 'refresh.json'].map((name) => {
    try { const stat = statSync(join(dir, name)); return `${stat.mtimeMs}:${stat.size}`; }
    catch { return 'missing'; }
  }).join('|');
}

function groupDetails(groupId, ledger, candidatesByKey) {
  const group = ledger.groups.groups[groupId];
  const conversations = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => candidatesByKey.get(key) ?? { conversationKey: key, outsideWindow: true });
  const loaded = conversations.filter((conversation) => !conversation.outsideWindow);
  return {
    groupId, title: group.title, links: group.links, anchorAsk: group.anchorAsk ?? null,
    startedAt: iso(Math.min(...loaded.map((conversation) => conversation.startedAtEpoch ?? Infinity))),
    lastActivityAt: iso(Math.max(0, ...loaded.map((conversation) => conversation.lastActivityEpoch ?? 0))),
    lastActivityEpoch: Math.max(0, ...loaded.map((conversation) => conversation.lastActivityEpoch ?? 0)),
    projects: [...new Set(loaded.map((conversation) => conversation.project))],
    conversations: conversations.map(({ lastActivityEpoch, startedAtEpoch, original, ...conversation }) => conversation),
    previousReview: ledger.progress[groupId] ?? null,
  };
}

// Re-review only groups with activity after their last review; finished
// groups stay finished unless new work arrives.
function pendingReviews(ledger, database, sinceEpoch) {
  const candidates = new Map(readCandidates(database, { sinceEpoch, excludedPromptIds: ledger.agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate]));
  const ungrouped = [...candidates.keys()].filter((key) => !ledger.groups.conversations[key] && !ledger.groups.ignored?.[key]).length;
  const ids = [...new Set([...candidates.keys()].map((key) => ledger.groups.conversations[key]).filter(Boolean))];
  const due = ids.map((id) => groupDetails(id, ledger, candidates))
    .filter((group) => !reviewIsCurrent(group.previousReview, group.conversations.map((conversation) => conversation.conversationKey), group.lastActivityEpoch))
    .sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch);
  return { due, ungrouped };
}

/** An ask as the focus step reads it: the 400 characters grouping-input shows of a conversation's opening ask and an
 * open request's anchor ask (groupingInput), so a request is placed on what it was grouped on. */
const FOCUS_ASK_CHARS = 400;
/** Conversations per readCandidates call: two bound parameters each, and 400 pairs (800 parameters) stays under
 * SQLite's 999-parameter limit before 3.32, the same chunk readConversationProjects uses. */
const CONVERSATIONS_PER_QUERY = 400;

const groupConversations = (ledger, groupId) => Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => key).sort();

/** Each conversation's opening ask, read from the database (the ledger keeps only the anchor's). */
function openingAsks(database, ledger, conversationKeys) {
  const asks = new Map();
  for (let index = 0; index < conversationKeys.length; index += CONVERSATIONS_PER_QUERY) {
    for (const candidate of readCandidates(database, { conversationKeys: conversationKeys.slice(index, index + CONVERSATIONS_PER_QUERY), excludedPromptIds: ledger.agentWrittenPromptIds })) {
      asks.set(candidate.conversationKey, candidate.firstAsk);
    }
  }
  return asks;
}

/** One request as the focus step sees it, keyed by its anchor conversation. Every conversation's opening ask is listed,
 * so a request holding several separate asks (one to promote into an area) can be told from one ask. */
function requestRecord(ledger, groupId, asks) {
  const group = ledger.groups.groups[groupId], review = ledger.progress[groupId];
  const conversations = groupConversations(ledger, groupId);
  return {
    anchor: group.anchor, groupId, title: group.title, firstAsk: requestText(group.anchorAsk?.text ?? null, FOCUS_ASK_CHARS),
    state: review?.state ?? null, summary: review?.summary ?? null,
    // A tag only, never a grouping: the request's project root.
    repo: group.projectRoot ?? null,
    conversations: conversations.length,
    conversationAsks: conversations.map((key) => requestText(asks.get(key) ?? null, FOCUS_ASK_CHARS)).filter(Boolean),
  };
}

const records = (database, ledger, groupIds) => {
  const asks = openingAsks(database, ledger, groupIds.flatMap((groupId) => groupConversations(ledger, groupId)));
  return groupIds.map((groupId) => requestRecord(ledger, groupId, asks));
};

/** What decides a request's area: its title, its first ask and its conversations. Its review (state, percent, summary)
 * is left out, so a request is not placed again every time it is reviewed. */
export function focusBasis(ledger, groupId) {
  const group = ledger.groups.groups[groupId];
  return createHash('sha256').update(JSON.stringify({ title: group.title, firstAsk: group.anchorAsk?.text ?? null, conversations: groupConversations(ledger, groupId) })).digest('hex').slice(0, 16);
}

/** Requests the focus step still has to place: no placement, a placement whose area holds no requests any more
 * (dismissed, or merged into a loop), or a router placement whose request changed since. An owner placement into a
 * live area (Other and done areas included) is the owner's and never queued; once its area is dismissed it no longer
 * binds (buildFocusAreas), and the router's placement must stand on its own. A router basis is compared only on the
 * device that wrote it: another device decided on its own copy of the request, and comparing would re-place every
 * request on every device in turn. Placements written without a basis (a seed) count as current. */
function focusDue(ledger, focus, localDeviceId) {
  return Object.keys(ledger.groups.groups).filter((groupId) => {
    const placement = focus.placementsByAnchor.get(ledger.groups.groups[groupId].anchor);
    if (placement?.owner && focus.resolveFocusAreaId(placement.owner.focusAreaId)) return false;
    const router = placement?.router;
    if (!router || !focus.resolveFocusAreaId(router.focusAreaId)) return true;
    return router.device === localDeviceId && router.basis != null && router.basis !== focusBasis(ledger, groupId);
  });
}

/** Requests the router put in Other, where new areas come from. A request the owner put in Other is the owner's call,
 * not material for a proposal, and a request still to be placed is left for its placement. */
function routerOther(ledger, focus, queued) {
  return Object.keys(ledger.groups.groups).filter((groupId) => {
    if (queued.has(groupId)) return false;
    const placement = focus.placementsByAnchor.get(ledger.groups.groups[groupId].anchor);
    if (placement?.owner && focus.resolveFocusAreaId(placement.owner.focusAreaId)) return false;
    return !!placement?.router && focus.resolveFocusAreaId(placement.router.focusAreaId) === OTHER_FOCUS_AREA_ID;
  });
}

/** Which Other requests a proposal pass looked at, and what each one held then (its focusBasis), so a request that
 * gained conversations or a new ask and stayed in Other is looked at again; null when Other holds none. */
const otherPassHash = (ledger, groupIds) => groupIds.length
  ? createHash('sha256').update(JSON.stringify(groupIds.map((groupId) => [ledger.groups.groups[groupId].anchor, focusBasis(ledger, groupId)]).sort())).digest('hex').slice(0, 16)
  : null;

const focusAreaRecord = (area) => ({ focusAreaId: area.focusAreaId, name: area.name, goal: area.goal, about: area.about, status: area.status });

/** focus-input: the areas a request may go in, the dismissed areas never to propose again, and one batch of requests to
 * place, earliest in the ledger first. `remaining` counts the requests left for later batches. */
export function focusInput(ledger, focus, localDeviceId, database, { limit = FOCUS_BATCH } = {}) {
  const due = focusDue(ledger, focus, localDeviceId);
  return {
    areas: focus.focusAreas.filter(isPlaceableArea).map(focusAreaRecord),
    dismissed: focus.focusAreas.filter(isOwnerDismissedArea).map(focusAreaRecord),
    requests: records(database, ledger, due.slice(0, limit)),
    remaining: Math.max(0, due.length - limit),
  };
}

/** focus-input --other: the requests the router put in Other, for proposing areas. `due` is false when the last pass
 * (on any device: the hash is a synced my-focus row) already looked at exactly these requests. */
export function otherInput(ledger, focus, localDeviceId, database) {
  const other = routerOther(ledger, focus, new Set(focusDue(ledger, focus, localDeviceId)));
  const hash = otherPassHash(ledger, other);
  return {
    areas: focus.focusAreas.filter(isPlaceableArea).map(focusAreaRecord),
    dismissed: focus.focusAreas.filter(isOwnerDismissedArea).map(focusAreaRecord),
    other: records(database, ledger, other),
    due: hash !== null && hash !== focus.otherPassHash,
  };
}

// Same bounds as the worker's focus routes: a nav label, one sentence, and evidence or an about line of one
// sentence each, so a whole area fits one 2000-character work-state row (MAX_WORK_STATE_FIELDS_JSON_CHARS).
const AREA_NAME_MAX = 80, AREA_SENTENCE_MAX = 300;

/**
 * A focus answer checked against the input it was made from. Two kinds of question share the answer shape:
 * - placing (focus-input): every listed request is placed exactly once, in a listed area by its exact id or in "other";
 *   a request whose conversations hold several separate asks may be promoted into a proposed area.
 * - Other (focus-input --other): nothing is placed; requests in Other that are steps of something larger cluster into
 *   a "new" proposal (two or more: one request is a request, not a cluster), and one may be promoted.
 * An area id that is not listed is refused, never mapped to Other: guessing would file the request wrongly. A proposal's
 * `sameAs` is the model's judgment of which saved area it already is: a listed area takes its requests (no new area),
 * and a dismissed one is refused, never proposed again under any name. Returns the body POST /api/work-view/focus/router
 * takes; after an Other pass it carries the hash of the Other requests left, so the next pass waits for a change.
 */
export function validateFocusAnswer(answer, input, ledger, { other = false } = {}) {
  if (!Array.isArray(answer?.placements)) throw new TypeError('The answer needs a placements array.');
  if (!Array.isArray(answer?.proposals)) throw new TypeError('The answer needs a proposals array (empty when there is nothing to propose).');
  const listed = new Map((other ? input.other : input.requests).map((request) => [request.anchor, request]));
  const areaIds = new Set(input.areas.map((area) => area.focusAreaId));
  const dismissed = new Map(input.dismissed.map((area) => [area.focusAreaId, area]));
  const placed = new Map();
  if (other && answer.placements.length) throw new TypeError('This question places nothing: answer "placements": [] and propose areas only.');
  for (const [index, placement] of answer.placements.entries()) {
    const label = `placements[${index}]`;
    if (!listed.has(placement?.anchor)) throw new TypeError(`${label} names ${placement?.anchor}, which was not asked about.`);
    if (placed.has(placement.anchor)) throw new TypeError(`${label} places ${placement.anchor} a second time; a request sits in one area.`);
    if (placement.focusAreaId !== OTHER_FOCUS_AREA_ID && !areaIds.has(placement.focusAreaId)) {
      if (dismissed.has(placement.focusAreaId)) throw new TypeError(`${label} names ${placement.focusAreaId} ("${dismissed.get(placement.focusAreaId).name}"), which the owner dismissed; it takes no requests. Use a listed area id or "other".`);
      throw new TypeError(`${label} names ${JSON.stringify(placement.focusAreaId)}, which is not a listed focus area. Use an exact focusAreaId from "areas", or "other".`);
    }
    placed.set(placement.anchor, { focusAreaId: placement.focusAreaId, evidence: boundedText(placement.evidence, AREA_SENTENCE_MAX, `${label}.evidence`) });
  }
  if (!other) {
    const missing = [...listed.keys()].filter((anchor) => !placed.has(anchor));
    if (missing.length) throw new TypeError(`Place every request asked about; missing ${missing.join(', ')}.`);
  }
  const held = new Set();
  const proposals = answer.proposals.map((proposal, index) => {
    const label = `proposals[${index}]`;
    if (!PROPOSAL_KINDS.includes(proposal?.kind)) throw new TypeError(`${label}.kind must be one of ${PROPOSAL_KINDS.join(', ')}.`);
    if (!other && proposal.kind === 'new') throw new TypeError(`${label}: new areas are proposed from Other in their own question; here only "promote" a request that holds several separate asks.`);
    if (proposal.sameAs != null && !areaIds.has(proposal.sameAs)) {
      if (dismissed.has(proposal.sameAs)) throw new TypeError(`${label} is the area the owner dismissed (${proposal.sameAs}, "${dismissed.get(proposal.sameAs).name}"); never propose it again. Drop this proposal.`);
      throw new TypeError(`${label}.sameAs names ${JSON.stringify(proposal.sameAs)}, which is not a listed area; use an exact focusAreaId from "areas" or null.`);
    }
    if (!Array.isArray(proposal.anchors) || !proposal.anchors.length) throw new TypeError(`${label}.anchors must list the requests it holds.`);
    if (proposal.kind === 'new' && proposal.anchors.length < 2) throw new TypeError(`${label} clusters one request; a "new" area holds two or more steps of something larger (use "promote" for one request that holds several asks).`);
    if (proposal.kind === 'promote' && proposal.anchors.length !== 1) throw new TypeError(`${label} promotes one request; list only that request's anchor.`);
    const requests = proposal.anchors.map((anchor) => {
      if (!listed.has(anchor)) throw new TypeError(`${label} holds ${anchor}, which ${other ? 'is not a listed Other request' : 'was not asked about'}.`);
      if (held.has(anchor)) throw new TypeError(`${label} holds ${anchor}, which another proposal already holds.`);
      held.add(anchor);
      return { anchorConversationKey: anchor, basis: focusBasis(ledger, listed.get(anchor).groupId) };
    });
    return {
      kind: proposal.kind, name: boundedText(proposal.name, AREA_NAME_MAX, `${label}.name`), goal: boundedText(proposal.goal, AREA_SENTENCE_MAX, `${label}.goal`),
      about: boundedText(proposal.about, AREA_SENTENCE_MAX, `${label}.about`), evidence: boundedText(proposal.evidence, AREA_SENTENCE_MAX, `${label}.evidence`),
      sameAs: proposal.sameAs ?? null, requests,
    };
  });
  return {
    placements: [...placed].filter(([anchor]) => !held.has(anchor)).map(([anchor, { focusAreaId, evidence }]) => ({
      anchorConversationKey: anchor, focusAreaId, basis: focusBasis(ledger, listed.get(anchor).groupId), evidence,
    })),
    proposals,
    ...(other ? { otherPassHash: otherPassHash(ledger, [...listed.keys()].filter((anchor) => !held.has(anchor)).map((anchor) => listed.get(anchor).groupId)) } : {}),
  };
}

const requireDeviceId = (localDeviceId) => {
  if (typeof localDeviceId !== 'string') throw new TypeError('My Focus needs the worker\'s sync device id ("" when cloud sync never started).');
  return localDeviceId;
};

/** What an automatic refresh would do now; nothing to do means no agent runs.
 * The window is the request-progress skill's own default, so a finished run
 * leaves nothing due. localDeviceId is the worker's sync device id (readFocus), required. */
export function refreshNeeds({ dir = LEDGER_DIR, database, now = Date.now(), days = 14, localDeviceId }) {
  requireDeviceId(localDeviceId);
  const ledger = readLedger(dir);
  const { due, ungrouped } = pendingReviews(ledger, database, now - days * DAY_MS);
  const goals = readGoals(database);
  const generated = Date.parse(goals.generatedAt ?? '');
  const goalsStale = !Number.isFinite(generated) || now - generated > GOALS_STALE_MS;
  const focus = readFocus(database, { localDeviceId });
  const queued = focusDue(ledger, focus, localDeviceId);
  const otherHash = otherPassHash(ledger, routerOther(ledger, focus, new Set(queued)));
  const otherChanged = otherHash !== null && otherHash !== focus.otherPassHash;
  return { due: due.length, ungrouped, goalsStale, unplaced: queued.length, otherChanged, needed: Boolean(due.length || ungrouped || goalsStale || queued.length || otherChanged) };
}

function readInput(source) {
  return JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8'));
}

function textOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
}

function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`--${name} must be a positive integer.`);
  return value;
}

function openDatabase() {
  const path = process.env.CLAUDE_MEM_DB ?? join(DATA_DIR, 'claude-mem.db');
  statSync(path);
  const database = new Database(path, { readonly: true, create: false });
  database.exec('PRAGMA busy_timeout = 1500');
  return database;
}

/** Conversation key → project (derived for scratch-folder sessions). */
export function readConversationProjects(database, conversationKeys) {
  const pairs = [...new Set(conversationKeys)].filter(isConversationKey).map((key) => JSON.parse(key).slice(1));
  const sessions = [];
  for (let index = 0; index < pairs.length; index += 400) {
    const chunk = pairs.slice(index, index + 400);
    sessions.push(...database.prepare(`SELECT id, platform_source, content_session_id, project FROM sdk_sessions WHERE (platform_source, content_session_id) IN (VALUES ${chunk.map(() => '(?, ?)').join(',')})`).all(...chunk.flat()));
  }
  return new Map(withDerivedProjects(database, sessions).map((session) => [conversationKey(session), session.project]));
}

/** New conversations sent to the grouping agent at once. */
export const GROUPING_BATCH = 20;
/** Requests placed per focus answer: GROUPING_BATCH, the per-answer size the same light model (STEP_MODELS) already
 * decides "every listed item exactly once" for in grouping. Reused, not measured for placement itself. */
export const FOCUS_BATCH = GROUPING_BATCH;
const CLOSED_STATES = new Set(['shipped', 'abandoned']);

/** One grouping question: only conversations the ledger has not decided,
 * earliest first and all from one project root, each judged from its opening
 * ask, beside that root's open requests. Decided conversations are never sent
 * again, and neither are the keys in `skip` (conversations the judge could not
 * place in this run). `remaining` counts the new conversations left for later questions. */
export function groupingInput(ledger, database, { sinceEpoch, limit = GROUPING_BATCH, skip = null }) {
  const candidates = readCandidates(database, { sinceEpoch, excludedPromptIds: ledger.agentWrittenPromptIds });
  const decided = (key) => Boolean(ledger.groups.conversations[key] || ledger.groups.ignored?.[key] || skip?.has(key));
  const fresh = candidates.filter((candidate) => !decided(candidate.conversationKey));
  if (!fresh.length) return { root: null, conversations: [], openRequests: [], proposedLinks: [], remaining: 0 };
  const root = projectRoot(fresh[0].project);
  const batch = fresh.filter((candidate) => projectRoot(candidate.project) === root).slice(0, limit);
  const inRoot = candidates.filter((candidate) => projectRoot(candidate.project) === root);
  const byKey = new Map(inRoot.map((candidate) => [candidate.conversationKey, candidate]));
  // A group's root is stored at apply time; older groups, and groups decided before their project was
  // known, take it from their anchor.
  const rootIsStored = (group) => typeof group.projectRoot === 'string' && group.projectRoot !== NO_PROJECT;
  // With git-remote keys, a root saved before they were kept whole ("acme") also reads its anchor.
  const mayBeUpgraded = (group) => root.includes('/') && rootIsStored(group) && root.startsWith(`${group.projectRoot}/`);
  const anchorProjects = readConversationProjects(database, Object.values(ledger.groups.groups).filter((group) => !rootIsStored(group) || mayBeUpgraded(group)).map((group) => group.anchor));
  const groupRoot = (group) => rootIsStored(group) ? upgradedGroupRoot(group.projectRoot, projectRoot(anchorProjects.get(group.anchor))) : projectRoot(anchorProjects.get(group.anchor)) ?? group.projectRoot ?? null;
  // Every open request of the root: a new conversation may continue any of them.
  const openRequests = Object.entries(ledger.groups.groups)
    .filter(([groupId, group]) => groupRoot(group) === root && !CLOSED_STATES.has(ledger.progress[groupId]?.state))
    .map(([groupId, group]) => {
      const members = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => byKey.get(key)).filter(Boolean);
      const asks = members.flatMap((member) => member.asks).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return {
        groupId, title: group.title, anchor: group.anchor,
        anchorAsk: requestText(group.anchorAsk?.text ?? members[0]?.firstAsk ?? '', 400),
        recentAsks: asks.slice(0, 3).map((ask) => ask.text.slice(0, 200)),
        lastActivityEpoch: Math.max(0, ...members.map((member) => member.lastActivityEpoch ?? 0)),
      };
    })
    .sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch)
    .map(({ lastActivityEpoch, ...request }) => ({ ...request, lastActivityAt: iso(lastActivityEpoch) }));
  // Code-proven links (a shared work list or request id) between a new conversation and anything in its root.
  const batchKeys = new Set(batch.map((candidate) => candidate.conversationKey));
  const proposedLinks = linkBackwards(inRoot).proposedGroups.filter((group) => group.links.length && group.conversations.some((key) => batchKeys.has(key)))
    .flatMap((group) => group.links).map((link) => ({ ...link, groups: [...new Set(link.conversations.map((key) => ledger.groups.conversations[key]).filter(Boolean))] }));
  return {
    root,
    conversations: batch.map((candidate) => ({ conversationKey: candidate.conversationKey, project: candidate.project, startedAt: candidate.startedAt, openingAsk: requestText(candidate.firstAsk, 400), workLists: candidate.workLists })),
    openRequests, proposedLinks,
    remaining: fresh.length - batch.length,
  };
}

/** The grouping agent decides exactly the conversations it was sent: each
 * one joins an open request (listed after that request's anchor), starts a new
 * one, or is ignored. Nothing already decided may move. */
export function validateGroupingAnswer(answer, input) {
  const asked = new Set(input.conversations.map((conversation) => conversation.conversationKey));
  const anchors = new Set(input.openRequests.map((request) => request.anchor));
  const decided = new Set();
  for (const [index, group] of (Array.isArray(answer?.groups) ? answer.groups : []).entries()) {
    for (const [position, key] of (Array.isArray(group?.conversations) ? group.conversations : []).entries()) {
      if (asked.has(key)) { decided.add(key); continue; }
      if (position === 0 && anchors.has(key)) continue;
      throw new TypeError(`groups[${index}] lists ${key}, which was not asked about. Continue an open request by listing its anchor first, then only the new conversations.`);
    }
  }
  for (const [index, ignored] of (Array.isArray(answer?.ignored) ? answer.ignored : []).entries()) {
    if (!asked.has(ignored?.conversation)) throw new TypeError(`ignored[${index}] names a conversation that was not asked about.`);
    decided.add(ignored.conversation);
  }
  const missing = [...asked].filter((key) => !decided.has(key));
  if (missing.length) throw new TypeError(`Decide every conversation asked about; missing ${missing.join(', ')}.`);
  return answer;
}

/** `apply` without the file: the decisions merged into `stored`, with every touched conversation's
 * project read from the database and each new group's first ask kept in the ledger (so a card's start
 * never moves forward when the anchor conversation ages out of My Work's reads). Returns the next
 * ledger without writing it. */
export function applyDecisions(stored, decisions, { database, now = Date.now(), excludedPromptIds = null }) {
  // Every conversation the decisions touch, and the members their groups already hold, by project.
  const touched = (decisions?.groups ?? []).flatMap((group) => Array.isArray(group?.conversations) ? group.conversations : []).filter(isConversationKey);
  const touchedGroups = new Set(touched.map((key) => groupIdFor(key)));
  const existing = Object.entries(stored?.conversations ?? {}).filter(([, id]) => touchedGroups.has(id)).map(([key]) => key);
  const next = applyGroupDecisions(stored, decisions, now, { projectOf: readConversationProjects(database, [...touched, ...existing]) });
  const missing = Object.values(next.groups).filter((group) => !group.anchorAsk).map((group) => group.anchor);
  const anchors = new Map(readCandidates(database, { conversationKeys: missing, excludedPromptIds }).map((candidate) => [candidate.conversationKey, candidate.original]));
  for (const group of Object.values(next.groups)) if (!group.anchorAsk && anchors.has(group.anchor)) group.anchorAsk = anchors.get(group.anchor);
  return next;
}

/**
 * localDeviceId: the worker's sync device id ("" when cloud sync never started), required by focus-input, record-focus
 * and refresh-needs so my-focus rows replay in the worker's order.
 * saveFocus(body): writes a checked record-focus answer through the worker and resolves {placed, focusAreaIds};
 * it throws a TypeError when the worker refused the answer before writing anything. record-focus returns a promise.
 * judge: the Jev judge for the `judge` command: undefined reads it from the install's settings
 * (request-judge.mjs configuredJudge), null routes with code links only. That command returns a promise.
 */
export function runCli(argv, { dir = LEDGER_DIR, database = null, now = Date.now(), print = (value) => console.log(JSON.stringify(value, null, 2)), localDeviceId, saveFocus = null, judge = undefined } = {}) {
  const [command, ...args] = argv;
  const db = () => database ?? openDatabase();
  const since = () => now - option(args, 'days', 14) * DAY_MS;
  if (command === 'candidates') {
    const wantedRoot = textOption(args, 'project');
    const ledger = readLedger(dir);
    const stored = ledger.groups;
    const candidates = readCandidates(db(), { sinceEpoch: since(), excludedPromptIds: ledger.agentWrittenPromptIds })
      .filter((candidate) => !stored.ignored?.[candidate.conversationKey] && (wantedRoot == null || projectRoot(candidate.project) === wantedRoot));
    const { proposedGroups, skippedLists } = linkBackwards(candidates);
    const brief = args.includes('--brief');
    const shown = candidates.map(({ lastActivityEpoch, startedAtEpoch, original, ...candidate }) => {
      const currentGroup = stored.conversations[candidate.conversationKey] ?? null;
      return brief
        ? { conversationKey: candidate.conversationKey, project: candidate.project, startedAt: candidate.startedAt, lastActivityAt: candidate.lastActivityAt, firstAsk: candidate.firstAsk.slice(0, 200), laterAsks: candidate.asks.slice(1, 4).map((ask) => ask.text.slice(0, 120)), workLists: candidate.workLists, currentGroup }
        : { ...candidate, currentGroup };
    });
    return print({ candidates: shown, proposedGroups: proposedGroups.filter((group) => group.links.length), skippedLists, projects: [...new Set(candidates.map((candidate) => projectRoot(candidate.project)))] });
  }
  if (command === 'grouping-input') return print(groupingInput(readLedger(dir), db(), { sinceEpoch: since(), limit: option(args, 'limit', GROUPING_BATCH) }));
  if (command === 'judge') {
    // Imported here, not at the top: the judge module builds on this one.
    return import('./request-judge.mjs')
      .then(({ configuredJudge, routeUndecided }) => routeUndecided({ dir, database: db(), judge: judge === undefined ? configuredJudge() : judge, now, days: option(args, 'days', 14), apply: args.includes('--apply') }))
      .then(print);
  }
  if (command === 'apply') {
    const ledger = readLedger(dir);
    const next = applyDecisions(ledger.groups, readInput(args[0] ?? '-'), { database: db(), now, excludedPromptIds: ledger.agentWrittenPromptIds });
    writeJsonAtomic(join(dir, 'request-groups.json'), next);
    return print({ groups: Object.keys(next.groups).length, conversations: Object.keys(next.conversations).length });
  }
  if (command === 'pending' || command === 'show') {
    const ledger = readLedger(dir);
    if (command === 'show') {
      if (!ledger.groups.groups[args[0]]) throw new TypeError(`Unknown group ${args[0]}.`);
      const keys = Object.entries(ledger.groups.conversations).filter(([, id]) => id === args[0]).map(([key]) => key);
      const candidates = new Map(readCandidates(db(), { conversationKeys: keys, fullAsks: true, excludedPromptIds: ledger.agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate]));
      const details = groupDetails(args[0], ledger, candidates);
      // Same conversations as the previous review: the reviewer amends it from what happened since.
      // A membership change (a merge, a split) needs a full review.
      const previous = details.previousReview;
      const amendSince = previous && reviewIsCurrent(previous, keys, 0) ? previous.reviewedThrough : null;
      const since = amendSince ? Date.parse(amendSince) : 0;
      // The conversations' own observations (only the new ones when amending), so a reviewer without memory tools has the evidence.
      const observations = db().prepare(`SELECT o.id, o.type, o.title, o.subtitle, o.created_at_epoch FROM observations o
        JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
        WHERE s.platform_source = ? AND s.content_session_id = ? AND o.created_at_epoch > ? ORDER BY o.created_at_epoch, o.id`);
      const conversations = details.conversations.map((conversation) => {
        const [, platform, sessionId] = JSON.parse(conversation.conversationKey);
        return {
          ...conversation,
          ...(conversation.asks && amendSince ? { asks: conversation.asks.filter((ask) => Date.parse(ask.at) > since) } : {}),
          observations: observations.all(platform, sessionId, since).map((row) => ({ id: row.id, at: iso(row.created_at_epoch), type: row.type, title: row.title, subtitle: row.subtitle })),
        };
      });
      // The reviewer passes reviewBasis back to record-progress unchanged.
      return print({ ...details, conversations, mode: amendSince ? 'amend' : 'full', amendSince, reviewBasis: { checkedThrough: iso(now), conversations: keys.sort() } });
    }
    const { due, ungrouped } = pendingReviews(ledger, db(), since());
    const limit = option(args, 'limit', 48);
    return print({ due: due.length, groups: due.slice(0, limit).map((group) => ({ groupId: group.groupId, title: group.title, lastActivityAt: group.lastActivityAt, conversations: group.conversations.length })), deferred: Math.max(0, due.length - limit), ungroupedConversations: ungrouped });
  }
  if (command === 'record-progress') {
    const ledger = readLedger(dir);
    const reviewed = validateProgress(readInput(args[0] ?? '-'), ledger.groups.groups);
    const checkedAt = iso(now);
    const previous = ledger.progress[reviewed.groupId];
    // The story is retold only from reviews whose facts moved; reworded prose and review timestamps are not news.
    const unchanged = previous && JSON.stringify(storyFacts(previous)) === JSON.stringify(storyFacts(reviewed));
    const entry = { ...reviewed, checkedAt, changedAt: unchanged ? previous.changedAt ?? previous.checkedAt : checkedAt, readings: appendReading(ledger.progress[reviewed.groupId], { at: checkedAt, percent: reviewed.percent }) };
    writeJsonAtomic(join(dir, 'progress', `${entry.groupId}.json`), entry);
    return print({ recorded: entry.groupId, state: entry.state, percent: entry.percent, readings: entry.readings.length });
  }
  if (command === 'story-input') {
    const { groups, progress, story } = readLedger(dir);
    const reviews = Object.values(progress).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    // With a previous story, only reviews whose facts changed after it was written.
    const writtenAt = Date.parse(story?.writtenAt ?? '');
    const update = Number.isFinite(writtenAt);
    // An update only ever added to the story until it reached the cap and every update was refused (Oct 24: 11,958 of 12,000),
    // so the agent is told the budget and the previous story's length up front.
    // With only the limit and length, an update at 11,836 of 12,000 still added ~1,300 characters and condensed nothing (Oct 24),
    // so the room left is spelled out as well.
    const previousNarrativeChars = story?.narrative?.length ?? 0;
    return print({ groups: Object.keys(groups.groups).length, update, narrativeLimit: STORY_NARRATIVE_MAX, previousNarrativeChars, roomChars: STORY_NARRATIVE_MAX - previousNarrativeChars,
      reviews: update ? reviews.filter((review) => Date.parse(review.changedAt ?? review.checkedAt) > writtenAt) : reviews,
      // Rules owner-goals put in the story are its own (record-story carries them over): shown here, the story model
      // would echo them back without their source and when, leaving copies a later owner-goals save cannot replace.
      previousStory: story && { ...story, preferences: (story.preferences ?? []).filter((preference) => preference?.source !== OWNER_GOALS_LIST) } });
  }
  if (command === 'record-story') {
    const validated = validateStory(readInput(args[0] ?? '-'));
    // Rules owner-goals found in the owner's prompts (save_goals.py) are its to replace, not the story's.
    const fromOwnerGoals = (readLedger(dir).story?.preferences ?? []).filter((preference) => preference?.source === OWNER_GOALS_LIST);
    const story = { ...validated, preferences: [...validated.preferences, ...fromOwnerGoals], writtenAt: iso(now) };
    writeJsonAtomic(join(dir, 'story.json'), story);
    return print({ recorded: 'story', preferences: story.preferences.length });
  }
  // focus-input and record-focus take the same flags, so record-focus checks the answer against the input it answers.
  const focusQuestion = () => {
    const ledger = readLedger(dir), focus = readFocus(db(), { localDeviceId: requireDeviceId(localDeviceId) });
    const other = args.includes('--other');
    return { ledger, other, input: other ? otherInput(ledger, focus, localDeviceId, db()) : focusInput(ledger, focus, localDeviceId, db(), { limit: option(args, 'limit', FOCUS_BATCH) }) };
  };
  if (command === 'focus-input') return print(focusQuestion().input);
  if (command === 'record-focus') {
    // My Focus rows sync, so they are written by the worker, never by this read-only CLI: saveFocus posts the
    // checked answer to the worker's system-only route (POST /api/work-view/focus/router), or calls the same
    // write in-process when the worker's own refresh runs this command.
    if (!saveFocus) throw new Error('record-focus saves through the claude-mem worker, and none was given.');
    const { ledger, other, input } = focusQuestion();
    const file = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--limit').at(-1) ?? '-';
    const body = validateFocusAnswer(readInput(file), input, ledger, { other });
    return Promise.resolve(saveFocus(body)).then((saved) => print({ placed: saved.placed, proposed: saved.focusAreaIds.length, focusAreaIds: saved.focusAreaIds }));
  }
  if (command === 'refresh-needs') return print(refreshNeeds({ dir, database: db(), now, days: option(args, 'days', 14), localDeviceId }));
  throw new TypeError('Usage: request-groups.mjs candidates|grouping-input|judge|apply|pending|show|record-progress|story-input|record-story|focus-input|record-focus|refresh-needs (see file header).');
}
