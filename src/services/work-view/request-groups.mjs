// Overall-request ledger. Works backwards from recorded work to the human
// conversations behind it, then stores evidence-backed groups, per-group
// progress reviews and the build story beside My Work's other caches.
// The request-progress skill runs the bundled CLI (request-groups-cli.mjs) with bun:
//
//   bun request-groups.mjs candidates [--days 14] [--project root] [--brief]
//                                                   conversations + deterministic links
//   bun request-groups.mjs grouping-input [--days 14] [--limit 20]
//                                                   undecided conversations of one root + its open requests
//   bun request-groups.mjs apply <file|->            persist group decisions
//   bun request-groups.mjs pending [--days 14] [--limit 48]   groups needing a progress review
//   bun request-groups.mjs show <groupId>           one group's asks, work lists and dates (only new asks when amending)
//   bun request-groups.mjs record-progress <file|-> persist one progress review
//   bun request-groups.mjs story-input              reviews whose facts changed since the last story (all without one)
//   bun request-groups.mjs record-story <file|->    persist the build story and preferences
//   bun request-groups.mjs align-input              owner goals + the groups still to align
//   bun request-groups.mjs record-alignment <file|-> persist which goals each group serves
//   bun request-groups.mjs refresh-needs [--days 14]  what the automatic refresh would do now
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { conversationKey, isConversationKey, isHumanActionRequest, originalFor, requestText } from './request-projection.mjs';
import { OWNER_GOALS_LIST } from './owner-goals.mjs';
import { NO_PROJECT, projectRoot, upgradedGroupRoot, withDerivedProjects } from './session-project.mjs';

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
const LINK_KINDS = ['shared-work-list', 'shared-request-id', 'agent-judgment'];
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

/** Fold the owner-goals list (patch entries) into its open priorities and asks. */
export function readGoals(database) {
  const rows = database.prepare('SELECT fields FROM work_state_entries WHERE list_name = ? ORDER BY id').all(OWNER_GOALS_LIST);
  const listState = {}, items = new Map();
  for (const row of rows) {
    const fields = JSON.parse(row.fields);
    const target = fields.task ? items.get(fields.task) ?? items.set(fields.task, {}).get(fields.task) : listState;
    for (const [key, value] of Object.entries(fields)) { if (value === null) delete target[key]; else target[key] = value; }
  }
  const goals = [...items.values()].filter((item) => !['done', 'dropped'].includes(String(item.status).toLowerCase())).map((item) => ({
    goal: item.task, kind: item.goal_kind === 'open-ask' ? 'open-ask' : 'priority', rank: Number(item.rank) || null,
    title: item.title ?? item.task, product: item.product ?? null, latestAt: item.latest_at ?? null, timesAsked: Number(item.times_asked) || null,
    // A later local refresh changes snapshot, so it cannot reuse an older hosted JSON evidence field.
    evidence: item.source === 'hosted-intent' && item.hosted_snapshot === item.snapshot
      ? JSON.parse(item.evidence_json)
      : String(item.evidence ?? '').split('\n').filter(Boolean).map((line) => { const [at, ...quote] = line.split(' | '); return { at, quote: quote.join(' | ') }; }),
  })).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'priority' ? -1 : 1) || (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return { summary: listState.human_summary ?? null, generatedAt: listState.generated_at ?? null, mapPath: listState.map_path ?? null, goals };
}

/** Alignment links each overall request to the owner goals it serves, with evidence. */
export function validateAlignment(input, { groups, goals }) {
  const goalNames = new Set(goals.map((goal) => goal.goal));
  if (!Array.isArray(input?.links)) throw new TypeError('Alignment needs a links array.');
  const links = {};
  for (const [index, link] of input.links.entries()) {
    if (!groups[link.groupId]) throw new TypeError(`links[${index}] has unknown group ${link.groupId}.`);
    if (!goalNames.has(link.goal)) throw new TypeError(`links[${index}].goal must be a current goal's exact "goal" value.`);
    (links[link.groupId] ??= []).push({ goal: link.goal, evidence: boundedText(link.evidence, 300, `links[${index}].evidence`) });
  }
  const unaligned = [...new Set(input.unaligned ?? [])];
  for (const groupId of unaligned) {
    if (!groups[groupId]) throw new TypeError(`unaligned has unknown group ${groupId}.`);
    if (links[groupId]) throw new TypeError(`Group ${groupId} is both linked and unaligned.`);
  }
  return { links, unaligned };
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
 * conversation key to its project: a group holds one project root only. */
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
    // A request stays in one project root, members it already has included.
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
    if (roots.size > 1) throw new TypeError(`${label} joins conversations from different projects (${[...roots.keys()].map((root) => root || 'no project').join(', ')}); a request stays inside one project root.`);
    const projectRootOfGroup = roots.size ? [...roots.keys()][0] : storedRoot ?? null;
    for (const key of decision.conversations) {
      next.conversations[key] = id;
      // A later decision can correct an earlier ignore; the viewer checks ignored first.
      if (next.ignored) delete next.ignored[key];
    }
    next.groups[id] = { title: decision.title.trim(), anchor: decision.conversations[0], projectRoot: projectRootOfGroup, links, decidedAt: iso(now), anchorAsk: stored?.groups?.[id]?.anchor === decision.conversations[0] ? stored.groups[id].anchorAsk ?? null : null };
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
    groups, progress, story: readJson(join(dir, 'story.json'), null), alignment: readJson(join(dir, 'alignment.json'), null), refresh: readJson(join(dir, 'refresh.json'), null),
    agentWrittenPromptIds: new Set(readJson(join(dir, AGENT_WRITTEN_PROMPTS_FILE), { promptIds: [] }).promptIds ?? []),
  };
}

/** Cheap change detector for the monitor's one-second poll. */
export function ledgerSignature(dir = LEDGER_DIR) {
  return ['request-groups.json', 'progress', 'story.json', 'alignment.json', 'refresh.json'].map((name) => {
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

/** Goals added since the alignment was recorded. A goals update that only
 * re-ranks or re-quotes adds none. Files from before goal keys were recorded count as current. */
export function goalsAddedSince(alignment, goalKeys) {
  const seen = new Set(alignment?.goals ?? goalKeys);
  return goalKeys.filter((goal) => !seen.has(goal));
}

/** One request as the alignment step sees it (align-input's group record). */
function alignmentRecord(ledger, groupId) {
  const group = ledger.groups.groups[groupId], review = ledger.progress[groupId];
  return { groupId, title: group.title, firstAsk: group.anchorAsk?.text?.slice(0, 400) ?? null, state: review?.state ?? null, percent: review?.percent ?? null, summary: review?.summary ?? null };
}

/** What an alignment decision was made on: the request as align-input showed it, and its conversations. */
function alignmentBasis(ledger, groupId) {
  const conversations = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => key).sort();
  return createHash('sha256').update(JSON.stringify({ ...alignmentRecord(ledger, groupId), conversations })).digest('hex').slice(0, 16);
}

/** Groups the alignment step still has to decide: groups it has not seen,
 * groups that changed since their decision, groups linked to a goal that is
 * gone, and every group when a goal was added (any group may serve it). With
 * no goals there is nothing to align to. Files from before bases were recorded count as current. */
function alignmentDue(ledger, goals) {
  if (!goals.goals.length) return [];
  const current = goals.goals.map((goal) => goal.goal);
  const links = ledger.alignment?.links ?? {}, unaligned = new Set(ledger.alignment?.unaligned ?? []), basis = ledger.alignment?.basis;
  if (goalsAddedSince(ledger.alignment, current).length) return Object.keys(ledger.groups.groups);
  const changed = (id) => basis != null && basis[id] !== alignmentBasis(ledger, id);
  return Object.keys(ledger.groups.groups).filter((id) => changed(id) || (links[id] ? links[id].some((link) => !current.includes(link.goal)) : !unaligned.has(id)));
}

/** What an automatic refresh would do now; nothing to do means no agent runs.
 * The window is the request-progress skill's own default, so a finished run
 * leaves nothing due. With no goals saved there is nothing to align to. */
export function refreshNeeds({ dir = LEDGER_DIR, database, now = Date.now(), days = 14 }) {
  const ledger = readLedger(dir);
  const { due, ungrouped } = pendingReviews(ledger, database, now - days * DAY_MS);
  const goals = readGoals(database);
  const generated = Date.parse(goals.generatedAt ?? '');
  const goalsStale = !Number.isFinite(generated) || now - generated > GOALS_STALE_MS;
  const unaligned = alignmentDue(ledger, goals).length;
  return { due: due.length, ungrouped, goalsStale, unaligned, needed: Boolean(due.length || ungrouped || goalsStale || unaligned) };
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
const CLOSED_STATES = new Set(['shipped', 'abandoned']);

/** One grouping question: only conversations the ledger has not decided,
 * earliest first and all from one project root, each judged from its opening
 * ask, beside that root's open requests. Decided conversations are never sent
 * again. `remaining` counts the new conversations left for later questions. */
export function groupingInput(ledger, database, { sinceEpoch, limit = GROUPING_BATCH }) {
  const candidates = readCandidates(database, { sinceEpoch, excludedPromptIds: ledger.agentWrittenPromptIds });
  const decided = (key) => Boolean(ledger.groups.conversations[key] || ledger.groups.ignored?.[key]);
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

export function runCli(argv, { dir = LEDGER_DIR, database = null, now = Date.now(), print = (value) => console.log(JSON.stringify(value, null, 2)) } = {}) {
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
  if (command === 'apply') {
    const database = db();
    const stored = readLedger(dir).groups;
    const decisions = readInput(args[0] ?? '-');
    // Every conversation the decisions touch, and the members their groups already hold, by project.
    const touched = (decisions?.groups ?? []).flatMap((group) => Array.isArray(group?.conversations) ? group.conversations : []).filter(isConversationKey);
    const touchedGroups = new Set(touched.map((key) => groupIdFor(key)));
    const existing = Object.entries(stored.conversations).filter(([, id]) => touchedGroups.has(id)).map(([key]) => key);
    const next = applyGroupDecisions(stored, decisions, now, { projectOf: readConversationProjects(database, [...touched, ...existing]) });
    // Keep each group's first ask in the ledger so a card's start never moves
    // forward when the anchor conversation ages out of My Work's reads.
    const missing = Object.values(next.groups).filter((group) => !group.anchorAsk).map((group) => group.anchor);
    const anchors = new Map(readCandidates(database, { conversationKeys: missing, excludedPromptIds: readLedger(dir).agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate.original]));
    for (const group of Object.values(next.groups)) if (!group.anchorAsk && anchors.has(group.anchor)) group.anchorAsk = anchors.get(group.anchor);
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
      reviews: update ? reviews.filter((review) => Date.parse(review.changedAt ?? review.checkedAt) > writtenAt) : reviews, previousStory: story });
  }
  if (command === 'record-story') {
    const story = { ...validateStory(readInput(args[0] ?? '-')), writtenAt: iso(now) };
    writeJsonAtomic(join(dir, 'story.json'), story);
    return print({ recorded: 'story', preferences: story.preferences.length });
  }
  if (command === 'align-input') {
    const ledger = readLedger(dir);
    const goals = readGoals(db());
    const due = alignmentDue(ledger, goals);
    const groups = due.map((groupId) => alignmentRecord(ledger, groupId));
    const previousLinks = Object.fromEntries(due.filter((id) => ledger.alignment?.links?.[id]).map((id) => [id, ledger.alignment.links[id]]));
    return print({ goals, groups, previous: ledger.alignment ? { alignedAt: ledger.alignment.alignedAt ?? null, links: previousLinks } : null });
  }
  if (command === 'record-alignment') {
    const ledger = readLedger(dir);
    const goals = readGoals(db());
    const decided = validateAlignment(readInput(args[0] ?? '-'), { groups: ledger.groups.groups, goals: goals.goals });
    const decidedIds = new Set([...Object.keys(decided.links), ...decided.unaligned]);
    const missing = alignmentDue(ledger, goals).filter((id) => !decidedIds.has(id));
    if (missing.length) throw new TypeError(`Every group align-input listed must appear in links or unaligned; missing ${missing.join(', ')}.`);
    // Groups align-input did not list keep their earlier decision.
    const kept = (id) => ledger.groups.groups[id] && !decidedIds.has(id);
    const previous = ledger.alignment ?? {};
    const alignment = {
      links: { ...Object.fromEntries(Object.entries(previous.links ?? {}).filter(([id]) => kept(id))), ...decided.links },
      unaligned: [...(previous.unaligned ?? []).filter(kept), ...decided.unaligned],
      // Each decided group's basis, so a later change to the request makes it due again.
      basis: { ...Object.fromEntries(Object.entries(previous.basis ?? {}).filter(([id]) => kept(id))), ...Object.fromEntries([...decidedIds].map((id) => [id, alignmentBasis(ledger, id)])) },
      goals: goals.goals.map((goal) => goal.goal), alignedAt: iso(now),
    };
    writeJsonAtomic(join(dir, 'alignment.json'), alignment);
    return print({ aligned: Object.keys(decided.links).length, unaligned: decided.unaligned.length });
  }
  if (command === 'refresh-needs') return print(refreshNeeds({ dir, database: db(), now, days: option(args, 'days', 14) }));
  throw new TypeError('Usage: request-groups.mjs candidates|apply|pending|show|record-progress|story-input|record-story|align-input|record-alignment|refresh-needs (see file header).');
}
