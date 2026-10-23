// src/services/work-view/request-groups.mjs
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/services/work-view/work-product.mjs
var FILE_KINDS = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".pdf": "document",
  ".docx": "document",
  ".pptx": "deck",
  ".key": "deck",
  ".xlsx": "spreadsheet",
  ".csv": "spreadsheet",
  ".html": "page"
};
var GIT_PREFIX = String.raw`(?:^|[;&|(\n])\s*(?:rtk\s+)?(?:\/usr\/bin\/)?git(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+`;
var FILE_EXTENSION_PATTERN = Object.keys(FILE_KINDS).map((extension) => `files_modified LIKE '%${extension}"%'`).join(" OR ");

// src/services/work-view/request-projection.mjs
function requestText(value, max = 1200) {
  if (typeof value !== "string") return null;
  const requestSection = value.match(/^\s*#{1,2}\s+My request\s*:\s*(?:\r?\n)?([\s\S]*)$/im);
  const text = (requestSection?.[1] ?? value).replace(/<(environment_context|instructions|system-reminder|turn_aborted|permissions|collaboration_mode|skills_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/^\s*#\s*AGENTS\.md instructions[^\n]*(?:\n|$)/gim, " ").replace(/<\/?pasted_content\b[^>]*>/gi, "").trim();
  if (/^\s*#{1,2}\s+Files mentioned by the user\s*:/i.test(text)) return null;
  if (!text || /^\s*<(?:environment_context|instructions|system-reminder)\b/i.test(text)) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}
function isHumanActionRequest(value) {
  const text = requestText(value);
  if (!text) return false;
  const plain = text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
  if (/^(?:please\s+)?read\s+(?:the\s+)?[\w./ -]*(?:AGENTS|KICKOFF|CLAUDE)\.md(?:\s+and\s+(?:follow|obey|read|apply)(?:\s+it|\s+the\s+instructions)?\s*)?[.!]?$/i.test(plain)) return false;
  if (/^(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|yes|no|sure|continue|go ahead|keep going|resume|done)[.!\s]*$/i.test(plain)) return false;
  if (/^(?:You are (?:Codex|an AI)|Available skills|Environment context)\b/i.test(plain)) return false;
  if (/^(?:(?:please|just)\s+)?make sure (?:this|that|it|everything) (?:is |will be |keeps? )?(?:working|works|ok|okay|correct)(?:[.!\s]*)$/i.test(plain)) return false;
  if (/^you can (?:def(?:initely)? )?do (?:real )?tests?[,;.!\s]/i.test(plain) && !/\b(?:fix|build|create|implement|change|update|rename|remove|add)\b/i.test(plain)) return false;
  if (/(?:^|\s)GOAL\s*:\s*\S/i.test(plain)) return true;
  if (ENGLISH_ACTION.test(plain)) return true;
  if (/[^\x00-\x7F]/.test(plain)) return new RegExp("\\p{L}.*\\p{L}", "u").test(plain);
  return !ENGLISH_WORDS.test(plain) && (plain.match(/\b[a-z]{3,}\b/gi) ?? []).length >= 2;
}
var ENGLISH_ACTION = /\b(?:make|build|create|implement|design|fix|investigate|audit|review|write|rewrite|show|see|find|search|explain|compare|help|convert|add|remove|update|rename|run|test|verify|deploy|analyze|analyse|read|tell|open|generate|ship|merge|commit|push|release|publish|set up|i want|i need|can you|could you|would you|how (?:can|do|does|is)|what (?:is|are|does|did)|why (?:is|are|does|did)|do we|do you|(?:is|are|seems?|looks?) (?:broken|failing|wrong)|doesn'?t work|not working)\b/i;
var ENGLISH_WORDS = /\b(?:the|a|an|this|that|it|is|are|to|of|and|for|with|in|on|my|me|you|we|please|just|all|so|now|then|from|be|not)\b/i;
function conversationKey(session) {
  if (!session?.content_session_id || !session?.platform_source) return null;
  return JSON.stringify(["conversation", session.platform_source, session.content_session_id]);
}
function originalFor(session, prompts) {
  const ordered = prompts.filter((prompt) => prompt.session_db_id === session.id).sort((a, b) => (a.prompt_number ?? Infinity) - (b.prompt_number ?? Infinity) || (a.created_at_epoch ?? 0) - (b.created_at_epoch ?? 0) || a.id - b.id);
  const first = ordered.find((prompt) => isHumanActionRequest(prompt.prompt_text));
  if (isHumanActionRequest(session.user_prompt) && (!first || first.prompt_number > 1)) return { text: requestText(session.user_prompt), source: "session-initial-request", sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  if (first) return { text: requestText(first.prompt_text), source: "user-prompt", sourceId: first.id, url: `/api/work-view/evidence/prompt/${first.id}`, promptNumber: first.prompt_number, atEpoch: first.created_at_epoch ?? null };
  if (isHumanActionRequest(session.user_prompt)) return { text: requestText(session.user_prompt), source: "session-initial-request", sourceId: session.id, url: `/api/work-view/evidence/session/${session.id}`, promptNumber: 1, atEpoch: session.started_at_epoch ?? null };
  return null;
}

// src/services/work-view/owner-goals.mjs
var OWNER_GOALS_LIST = "owner-goals";

// src/services/work-view/request-groups.mjs
var DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
var LEDGER_DIR = join(DATA_DIR, "work-view");
var DAY_MS = 864e5;
var GOALS_STALE_MS = DAY_MS;
var MAX_CONVERSATIONS_PER_LINKING_LIST = 8;
var PROGRESS_STATES = ["shipped", "in-progress", "stalled", "abandoned", "unknown"];
var PREFERENCE_KINDS = ["directive", "correction", "praise", "frustration"];
var USAGE_LEVELS = ["in-use", "some-use", "no-evidence", "unknown"];
var VALUE_LEVELS = ["high", "medium", "low", "unclear"];
var LINK_KINDS = ["shared-work-list", "shared-request-id", "agent-judgment"];
var MAX_READINGS = 20;
var iso = (epoch) => Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
var groupIdFor = (anchorConversationKey) => `g_${createHash("sha256").update(anchorConversationKey).digest("hex").slice(0, 12)}`;
function placeholders(values) {
  return values.map(() => "?").join(",");
}
function readCandidates(database, { sinceEpoch = 0, conversationKeys = null, fullAsks = false }) {
  const columns = "SELECT id, platform_source, content_session_id, project, user_prompt, started_at_epoch FROM sdk_sessions";
  const pairs = conversationKeys?.map((key) => JSON.parse(key).slice(1));
  const sessions = pairs ? pairs.length ? database.prepare(`${columns} WHERE (platform_source, content_session_id) IN (VALUES ${pairs.map(() => "(?, ?)").join(",")})`).all(...pairs.flat()) : [] : database.prepare(`${columns} WHERE started_at_epoch >= ?
        OR id IN (SELECT DISTINCT session_db_id FROM user_prompts WHERE created_at_epoch >= ?)
        OR id IN (SELECT DISTINCT session_db_id FROM tool_uses WHERE created_at_epoch >= ?)
        OR memory_session_id IN (SELECT DISTINCT memory_session_id FROM observations WHERE created_at_epoch >= ?)`).all(sinceEpoch, sinceEpoch, sinceEpoch, sinceEpoch);
  if (!sessions.length) return [];
  const ids = sessions.map((session) => session.id);
  const prompts = database.prepare(`SELECT id, session_db_id, prompt_number, ${fullAsks ? "prompt_text" : "substr(prompt_text, 1, 1200) AS prompt_text"}, created_at_epoch
    FROM user_prompts WHERE session_db_id IN (${placeholders(ids)})`).all(...ids);
  const writes = database.prepare(`SELECT session_db_id, tool_input, created_at_epoch FROM tool_uses
    WHERE tool_name LIKE '%work_state_write%' AND session_db_id IN (${placeholders(ids)})`).all(...ids);
  const observations = database.prepare(`SELECT s.id AS session_db_id, COUNT(*) AS count, MAX(o.created_at_epoch) AS last_epoch
    FROM observations o JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE s.id IN (${placeholders(ids)}) GROUP BY s.id`).all(...ids);
  const observationsBySession = new Map(observations.map((row) => [row.session_db_id, row]));
  const toolActivity = database.prepare(`SELECT session_db_id, MAX(created_at_epoch) AS last_epoch FROM tool_uses
    WHERE session_db_id IN (${placeholders(ids)}) GROUP BY session_db_id`).all(...ids);
  const lastToolUseBySession = new Map(toolActivity.map((row) => [row.session_db_id, row.last_epoch ?? 0]));
  const promptsBySession = /* @__PURE__ */ new Map();
  for (const prompt of prompts) {
    if (!promptsBySession.has(prompt.session_db_id)) promptsBySession.set(prompt.session_db_id, []);
    promptsBySession.get(prompt.session_db_id).push(prompt);
  }
  const candidates = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const key = conversationKey(session);
    const own = promptsBySession.get(session.id) ?? [];
    const original = key ? originalFor(session, own) : null;
    if (!original) continue;
    own.sort((a, b) => a.created_at_epoch - b.created_at_epoch || a.id - b.id);
    const lastPrompt = own.at(-1)?.created_at_epoch ?? 0;
    const asks = own.filter((prompt) => isHumanActionRequest(prompt.prompt_text)).map((prompt) => ({ promptId: prompt.id, at: iso(prompt.created_at_epoch), text: requestText(prompt.prompt_text, fullAsks ? Infinity : 280) }));
    candidates.set(key, {
      conversationKey: key,
      platform: session.platform_source,
      project: session.project,
      startedAt: iso(original.atEpoch ?? session.started_at_epoch),
      startedAtEpoch: original.atEpoch ?? session.started_at_epoch,
      lastActivityEpoch: Math.max(lastPrompt, observationsBySession.get(session.id)?.last_epoch ?? 0, lastToolUseBySession.get(session.id) ?? 0, session.started_at_epoch ?? 0),
      firstAsk: requestText(original.text, 600),
      asks: fullAsks ? asks : asks.slice(0, 10),
      askCount: asks.length,
      original,
      workLists: [],
      requestIds: [],
      observationCount: observationsBySession.get(session.id)?.count ?? 0,
      sessionDbId: session.id
    });
  }
  const bySession = new Map([...candidates.values()].map((candidate) => [candidate.sessionDbId, candidate]));
  for (const write of writes) {
    const candidate = bySession.get(write.session_db_id);
    if (!candidate) continue;
    let input;
    try {
      input = JSON.parse(write.tool_input);
    } catch {
      continue;
    }
    if (typeof input?.list === "string" && !candidate.workLists.includes(input.list)) candidate.workLists.push(input.list);
    const requestId = input?.fields?.request_id;
    if (["string", "number"].includes(typeof requestId) && String(requestId).trim() && !candidate.requestIds.includes(String(requestId).trim())) candidate.requestIds.push(String(requestId).trim());
    candidate.lastActivityEpoch = Math.max(candidate.lastActivityEpoch, write.created_at_epoch ?? 0);
  }
  return [...candidates.values()].sort((a, b) => a.startedAtEpoch - b.startedAtEpoch).map(({ sessionDbId, lastActivityEpoch, ...candidate }) => ({ ...candidate, lastActivityAt: iso(lastActivityEpoch), lastActivityEpoch }));
}
function linkBackwards(candidates) {
  const parent = new Map(candidates.map((candidate) => [candidate.conversationKey, candidate.conversationKey]));
  const find = (key) => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const links = [];
  const skippedLists = [];
  const shared = (kind, field) => {
    const owners = /* @__PURE__ */ new Map();
    for (const candidate of candidates) for (const value of candidate[field]) {
      const scope = kind === "shared-work-list" ? JSON.stringify([candidate.project, value]) : value;
      if (!owners.has(scope)) owners.set(scope, { value, project: candidate.project, keys: [] });
      owners.get(scope).keys.push(candidate.conversationKey);
    }
    for (const { value, project, keys } of owners.values()) {
      if (keys.length < 2) continue;
      if (kind === "shared-work-list" && keys.length > MAX_CONVERSATIONS_PER_LINKING_LIST) {
        skippedLists.push({ list: value, project, conversations: keys.length });
        continue;
      }
      for (const key of keys.slice(1)) parent.set(find(key), find(keys[0]));
      links.push({ kind, conversations: keys, evidence: kind === "shared-work-list" ? `work list "${value}" in ${project}` : `request_id "${value}"` });
    }
  };
  shared("shared-request-id", "requestIds");
  shared("shared-work-list", "workLists");
  const groups = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const root = find(candidate.conversationKey);
    if (!groups.has(root)) groups.set(root, { conversations: [], links: [] });
    groups.get(root).conversations.push(candidate.conversationKey);
  }
  for (const link of links) groups.get(find(link.conversations[0])).links.push(link);
  return { proposedGroups: [...groups.values()], skippedLists };
}
function readGoals(database) {
  const rows = database.prepare("SELECT fields FROM work_state_entries WHERE list_name = ? ORDER BY id").all(OWNER_GOALS_LIST);
  const listState = {}, items = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const fields = JSON.parse(row.fields);
    const target = fields.task ? items.get(fields.task) ?? items.set(fields.task, {}).get(fields.task) : listState;
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete target[key];
      else target[key] = value;
    }
  }
  const goals = [...items.values()].filter((item) => !["done", "dropped"].includes(String(item.status).toLowerCase())).map((item) => ({
    goal: item.task,
    kind: item.goal_kind === "open-ask" ? "open-ask" : "priority",
    rank: Number(item.rank) || null,
    title: item.title ?? item.task,
    product: item.product ?? null,
    latestAt: item.latest_at ?? null,
    timesAsked: Number(item.times_asked) || null,
    evidence: String(item.evidence ?? "").split("\n").filter(Boolean).map((line) => {
      const [at, ...quote] = line.split(" | ");
      return { at, quote: quote.join(" | ") };
    })
  })).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "priority" ? -1 : 1) || (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return { summary: listState.human_summary ?? null, generatedAt: listState.generated_at ?? null, goals };
}
function validateAlignment(input, { groups, goals }) {
  const goalNames = new Set(goals.map((goal) => goal.goal));
  if (!Array.isArray(input?.links)) throw new TypeError("Alignment needs a links array.");
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
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function writeJsonAtomic(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
  renameSync(temp, path);
}
var emptyGroups = () => ({ version: 1, updatedAt: null, conversations: {}, groups: {}, ignored: {} });
var isConversationKey = (value) => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed[0] === "conversation" && parsed.length === 3;
  } catch {
    return false;
  }
};
function applyGroupDecisions(stored, decisions, now = Date.now()) {
  if (!Array.isArray(decisions?.groups)) throw new TypeError("Decisions need a groups array.");
  const next = structuredClone(stored ?? emptyGroups());
  for (const [index, decision] of decisions.groups.entries()) {
    const label = `groups[${index}]`;
    if (typeof decision.title !== "string" || !decision.title.trim() || decision.title.length > 120) throw new TypeError(`${label}.title must be 1\u2013120 characters.`);
    if (!Array.isArray(decision.conversations) || !decision.conversations.length || !decision.conversations.every(isConversationKey)) throw new TypeError(`${label}.conversations must list conversation keys, earliest first.`);
    const links = decision.links ?? [];
    const members = new Set(decision.conversations);
    const parent = new Map(decision.conversations.map((key) => [key, key]));
    const find = (key) => {
      while (parent.get(key) !== key) key = parent.get(key);
      return key;
    };
    for (const link of links) {
      if (!LINK_KINDS.includes(link.kind)) throw new TypeError(`${label} has unknown link kind ${link.kind}.`);
      if (typeof link.evidence !== "string" || !link.evidence.trim()) throw new TypeError(`${label} has a link without evidence.`);
      if (!Array.isArray(link.conversations) || link.conversations.length < 2 || !link.conversations.every((key) => members.has(key))) throw new TypeError(`${label} has a link that must name 2+ of the group's own conversations.`);
      for (const key of link.conversations.slice(1)) parent.set(find(key), find(link.conversations[0]));
    }
    if (decision.conversations.length > 1 && !links.length) throw new TypeError(`${label} joins conversations without a recorded link.`);
    const unsupported = decision.conversations.filter((key) => find(key) !== find(decision.conversations[0]));
    if (unsupported.length) throw new TypeError(`${label} joins ${unsupported.join(", ")} without evidence linking it to the anchor.`);
    const id = groupIdFor(decision.conversations[0]);
    for (const key of decision.conversations) {
      next.conversations[key] = id;
      if (next.ignored) delete next.ignored[key];
    }
    next.groups[id] = { title: decision.title.trim(), anchor: decision.conversations[0], links, decidedAt: iso(now), anchorAsk: stored?.groups?.[id]?.anchor === decision.conversations[0] ? stored.groups[id].anchorAsk ?? null : null };
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
var isIsoOrNull = (value) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
function boundedText(value, max, label, optional = false) {
  if (optional && (value == null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${label} must be 1\u2013${max} characters.`);
  return value.trim();
}
var evidenceList = (value) => (Array.isArray(value) ? value : []).map(String).slice(0, 8);
function validateOutcome(outcome) {
  if (outcome == null) return null;
  if (typeof outcome !== "object" || Array.isArray(outcome)) throw new TypeError("outcome must be an object.");
  const leveled = (entry, levels, label) => {
    if (entry == null) return null;
    if (!levels.includes(entry.level)) throw new TypeError(`${label}.level must be one of ${levels.join(", ")}.`);
    return { level: entry.level, text: boundedText(entry.text, 400, `${label}.text`), evidence: evidenceList(entry.evidence) };
  };
  const regressions = outcome.regressions ?? [], changes = outcome.changes ?? [];
  if (!Array.isArray(regressions) || regressions.length > 10) throw new TypeError("outcome.regressions must be an array of at most 10.");
  if (!Array.isArray(changes) || changes.length > 12) throw new TypeError("outcome.changes must be an array of at most 12.");
  const dated = (value, label) => {
    if (!isIsoOrNull(value ?? null)) throw new TypeError(`${label} must be an ISO date or null.`);
    return value ?? null;
  };
  return {
    landed: outcome.landed == null ? null : { text: boundedText(outcome.landed.text, 400, "outcome.landed.text"), at: dated(outcome.landed.at, "outcome.landed.at"), evidence: evidenceList(outcome.landed.evidence) },
    usage: leveled(outcome.usage, USAGE_LEVELS, "outcome.usage"),
    value: leveled(outcome.value, VALUE_LEVELS, "outcome.value"),
    regressions: regressions.map((regression, index) => ({
      text: boundedText(regression.text, 300, `outcome.regressions[${index}].text`),
      at: dated(regression.at, `outcome.regressions[${index}].at`),
      fixedBy: boundedText(regression.fixedBy, 200, `outcome.regressions[${index}].fixedBy`, true) || null,
      evidence: evidenceList(regression.evidence)
    })),
    changes: changes.map((change, index) => ({
      what: boundedText(change.what, 200, `outcome.changes[${index}].what`),
      why: boundedText(change.why, 400, `outcome.changes[${index}].why`),
      at: dated(change.at, `outcome.changes[${index}].at`),
      evidence: evidenceList(change.evidence)
    }))
  };
}
function validateProgress(entry, knownGroups) {
  if (!entry || typeof entry !== "object") throw new TypeError("Progress must be an object.");
  if (!knownGroups[entry.groupId]) throw new TypeError(`Unknown group ${entry.groupId}.`);
  const basis = entry.reviewBasis;
  if (!basis || typeof basis.checkedThrough !== "string" || !Number.isFinite(Date.parse(basis.checkedThrough)) || !Array.isArray(basis.conversations) || !basis.conversations.length || !basis.conversations.every(isConversationKey)) {
    throw new TypeError("reviewBasis must be copied verbatim from `show` (checkedThrough and conversations).");
  }
  if (!PROGRESS_STATES.includes(entry.state)) throw new TypeError(`state must be one of ${PROGRESS_STATES.join(", ")}.`);
  if (!Number.isInteger(entry.percent) || entry.percent < 0 || entry.percent > 100) throw new TypeError("percent must be an integer 0\u2013100.");
  for (const field of ["startedAt", "shippedAt", "lastActivityAt"]) if (!isIsoOrNull(entry[field] ?? null)) throw new TypeError(`${field} must be an ISO date or null.`);
  if (entry.state === "shipped" && (entry.percent !== 100 || !entry.shippedAt)) throw new TypeError("A shipped request needs percent 100 and shippedAt.");
  if (entry.state !== "shipped" && entry.shippedAt) throw new TypeError("Only a shipped request has shippedAt.");
  const milestones = entry.milestones ?? [], preferences = entry.preferences ?? [];
  if (!Array.isArray(milestones) || milestones.length > 12) throw new TypeError("milestones must be an array of at most 12.");
  if (!Array.isArray(preferences) || preferences.length > 10) throw new TypeError("preferences must be an array of at most 10.");
  return {
    groupId: entry.groupId,
    state: entry.state,
    percent: entry.percent,
    startedAt: entry.startedAt ?? null,
    shippedAt: entry.shippedAt ?? null,
    lastActivityAt: entry.lastActivityAt ?? null,
    summary: boundedText(entry.summary, 280, "summary"),
    narrative: boundedText(entry.narrative, 1200, "narrative", true),
    milestones: milestones.map((milestone, index) => {
      if (!isIsoOrNull(milestone.at ?? null)) throw new TypeError(`milestones[${index}].at must be an ISO date or null.`);
      return { at: milestone.at ?? null, text: boundedText(milestone.text, 200, `milestones[${index}].text`), evidence: (milestone.evidence ?? []).map(String).slice(0, 6) };
    }),
    preferences: preferences.map((preference, index) => {
      if (!PREFERENCE_KINDS.includes(preference.kind)) throw new TypeError(`preferences[${index}].kind must be one of ${PREFERENCE_KINDS.join(", ")}.`);
      if (!isIsoOrNull(preference.at ?? null)) throw new TypeError(`preferences[${index}].at must be an ISO date or null.`);
      return { kind: preference.kind, preference: boundedText(preference.preference, 200, `preferences[${index}].preference`), quote: boundedText(preference.quote, 300, `preferences[${index}].quote`), at: preference.at ?? null };
    }),
    outcome: validateOutcome(entry.outcome),
    evidence: (entry.evidence ?? []).map(String).slice(0, 20),
    // What the reviewer actually saw: later activity or membership changes make it due again.
    reviewedThrough: new Date(Date.parse(basis.checkedThrough)).toISOString(),
    reviewedConversations: [...new Set(basis.conversations)].sort()
  };
}
function readingsOf(entry) {
  if (Array.isArray(entry?.readings)) return entry.readings;
  return entry?.checkedAt && Number.isInteger(entry.percent) ? [{ at: entry.checkedAt, percent: entry.percent }] : [];
}
function appendReading(previous, reading) {
  const byAt = new Map(readingsOf(previous).filter((item) => Number.isFinite(Date.parse(item?.at)) && Number.isInteger(item?.percent)).map((item) => [item.at, item]));
  byAt.set(reading.at, { at: reading.at, percent: reading.percent });
  return [...byAt.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_READINGS);
}
function reviewIsCurrent(review, conversationKeys, lastActivityEpoch) {
  if (!review?.reviewedThrough || !Array.isArray(review.reviewedConversations)) return false;
  const current = [...new Set(conversationKeys)].sort();
  if (current.length !== review.reviewedConversations.length || current.some((key, index) => key !== review.reviewedConversations[index])) return false;
  return Date.parse(review.reviewedThrough) >= lastActivityEpoch;
}
function validateStory(story) {
  const preferences = story?.preferences ?? [];
  if (!Array.isArray(preferences) || preferences.length > 30) throw new TypeError("preferences must be an array of at most 30.");
  return {
    narrative: boundedText(story?.narrative, 12e3, "narrative"),
    preferences: preferences.map((preference, index) => ({
      preference: boundedText(preference.preference, 200, `preferences[${index}].preference`),
      kind: PREFERENCE_KINDS.includes(preference.kind) ? preference.kind : "directive",
      supportCount: Number.isInteger(preference.supportCount) && preference.supportCount > 0 ? preference.supportCount : 1,
      quotes: (preference.quotes ?? []).slice(0, 3).map((quote, quoteIndex) => ({ quote: boundedText(quote.quote, 300, `preferences[${index}].quotes[${quoteIndex}]`), at: isIsoOrNull(quote.at ?? null) ? quote.at ?? null : null }))
    }))
  };
}
function readLedger(dir = LEDGER_DIR) {
  const groups = readJson(join(dir, "request-groups.json"), emptyGroups());
  const progress = {};
  let names = [];
  try {
    names = readdirSync(join(dir, "progress")).filter((name) => /^g_[0-9a-f]{12}\.json$/.test(name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const entry = readJson(join(dir, "progress", name), null);
    if (entry?.groupId && groups.groups[entry.groupId]) progress[entry.groupId] = { ...entry, readings: readingsOf(entry), title: groups.groups[entry.groupId].title };
  }
  return { groups, progress, story: readJson(join(dir, "story.json"), null), alignment: readJson(join(dir, "alignment.json"), null), refresh: readJson(join(dir, "refresh.json"), null) };
}
function groupDetails(groupId, ledger, candidatesByKey) {
  const group = ledger.groups.groups[groupId];
  const conversations = Object.entries(ledger.groups.conversations).filter(([, id]) => id === groupId).map(([key]) => candidatesByKey.get(key) ?? { conversationKey: key, outsideWindow: true });
  const loaded = conversations.filter((conversation) => !conversation.outsideWindow);
  return {
    groupId,
    title: group.title,
    links: group.links,
    anchorAsk: group.anchorAsk ?? null,
    startedAt: iso(Math.min(...loaded.map((conversation) => conversation.startedAtEpoch ?? Infinity))),
    lastActivityAt: iso(Math.max(0, ...loaded.map((conversation) => conversation.lastActivityEpoch ?? 0))),
    lastActivityEpoch: Math.max(0, ...loaded.map((conversation) => conversation.lastActivityEpoch ?? 0)),
    projects: [...new Set(loaded.map((conversation) => conversation.project))],
    conversations: conversations.map(({ lastActivityEpoch, startedAtEpoch, original, ...conversation }) => conversation),
    previousReview: ledger.progress[groupId] ?? null
  };
}
function pendingReviews(ledger, database, sinceEpoch) {
  const candidates = new Map(readCandidates(database, { sinceEpoch }).map((candidate) => [candidate.conversationKey, candidate]));
  const ungrouped = [...candidates.keys()].filter((key) => !ledger.groups.conversations[key] && !ledger.groups.ignored?.[key]).length;
  const ids = [...new Set([...candidates.keys()].map((key) => ledger.groups.conversations[key]).filter(Boolean))];
  const due = ids.map((id) => groupDetails(id, ledger, candidates)).filter((group) => !reviewIsCurrent(group.previousReview, group.conversations.map((conversation) => conversation.conversationKey), group.lastActivityEpoch)).sort((a, b) => b.lastActivityEpoch - a.lastActivityEpoch);
  return { due, ungrouped };
}
function alignmentDue(ledger, goals) {
  if (!goals.goals.length) return [];
  const aligned = /* @__PURE__ */ new Set([...Object.keys(ledger.alignment?.links ?? {}), ...ledger.alignment?.unaligned ?? []]);
  const goalsChanged = (ledger.alignment?.goalsGeneratedAt ?? null) !== goals.generatedAt;
  return Object.keys(ledger.groups.groups).filter((id) => goalsChanged || !aligned.has(id));
}
function refreshNeeds({ dir = LEDGER_DIR, database, now = Date.now(), days = 14 }) {
  const ledger = readLedger(dir);
  const { due, ungrouped } = pendingReviews(ledger, database, now - days * DAY_MS);
  const goals = readGoals(database);
  const generated = Date.parse(goals.generatedAt ?? "");
  const goalsStale = !Number.isFinite(generated) || now - generated > GOALS_STALE_MS;
  const unaligned = alignmentDue(ledger, goals).length;
  return { due: due.length, ungrouped, goalsStale, unaligned, needed: Boolean(due.length || ungrouped || goalsStale || unaligned) };
}
function readInput(source) {
  return JSON.parse(readFileSync(source === "-" ? 0 : source, "utf8"));
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
  const path = process.env.CLAUDE_MEM_DB ?? join(DATA_DIR, "claude-mem.db");
  statSync(path);
  const database = new Database(path, { readonly: true, create: false });
  database.exec("PRAGMA busy_timeout = 1500");
  return database;
}
function runCli(argv, { dir = LEDGER_DIR, database = null, now = Date.now(), print = (value) => console.log(JSON.stringify(value, null, 2)) } = {}) {
  const [command, ...args] = argv;
  const db = () => database ?? openDatabase();
  const since = () => now - option(args, "days", 14) * DAY_MS;
  if (command === "candidates") {
    const projectRoot = textOption(args, "project");
    const stored = readLedger(dir).groups;
    const candidates = readCandidates(db(), { sinceEpoch: since() }).filter((candidate) => !stored.ignored?.[candidate.conversationKey] && (!projectRoot || candidate.project.split("/")[0] === projectRoot));
    const { proposedGroups, skippedLists } = linkBackwards(candidates);
    const brief = args.includes("--brief");
    const shown = candidates.map(({ lastActivityEpoch, startedAtEpoch, original, ...candidate }) => {
      const currentGroup = stored.conversations[candidate.conversationKey] ?? null;
      return brief ? { conversationKey: candidate.conversationKey, project: candidate.project, startedAt: candidate.startedAt, lastActivityAt: candidate.lastActivityAt, firstAsk: candidate.firstAsk.slice(0, 200), laterAsks: candidate.asks.slice(1, 4).map((ask) => ask.text.slice(0, 120)), workLists: candidate.workLists, currentGroup } : { ...candidate, currentGroup };
    });
    return print({ candidates: shown, proposedGroups: proposedGroups.filter((group) => group.links.length), skippedLists, projects: [...new Set(candidates.map((candidate) => candidate.project.split("/")[0]))] });
  }
  if (command === "apply") {
    const next = applyGroupDecisions(readLedger(dir).groups, readInput(args[0] ?? "-"), now);
    const missing = Object.values(next.groups).filter((group) => !group.anchorAsk).map((group) => group.anchor);
    const anchors = new Map(readCandidates(db(), { conversationKeys: missing }).map((candidate) => [candidate.conversationKey, candidate.original]));
    for (const group of Object.values(next.groups)) if (!group.anchorAsk && anchors.has(group.anchor)) group.anchorAsk = anchors.get(group.anchor);
    writeJsonAtomic(join(dir, "request-groups.json"), next);
    return print({ groups: Object.keys(next.groups).length, conversations: Object.keys(next.conversations).length });
  }
  if (command === "pending" || command === "show") {
    const ledger = readLedger(dir);
    if (command === "show") {
      if (!ledger.groups.groups[args[0]]) throw new TypeError(`Unknown group ${args[0]}.`);
      const keys = Object.entries(ledger.groups.conversations).filter(([, id]) => id === args[0]).map(([key]) => key);
      const candidates = new Map(readCandidates(db(), { conversationKeys: keys, fullAsks: true }).map((candidate) => [candidate.conversationKey, candidate]));
      return print({ ...groupDetails(args[0], ledger, candidates), reviewBasis: { checkedThrough: iso(now), conversations: keys.sort() } });
    }
    const { due, ungrouped } = pendingReviews(ledger, db(), since());
    const limit = option(args, "limit", 48);
    return print({ due: due.length, groups: due.slice(0, limit).map((group) => ({ groupId: group.groupId, title: group.title, lastActivityAt: group.lastActivityAt, conversations: group.conversations.length })), deferred: Math.max(0, due.length - limit), ungroupedConversations: ungrouped });
  }
  if (command === "record-progress") {
    const ledger = readLedger(dir);
    const reviewed = validateProgress(readInput(args[0] ?? "-"), ledger.groups.groups);
    const checkedAt = iso(now);
    const previous = ledger.progress[reviewed.groupId];
    const unchanged = previous && previous.state === reviewed.state && previous.percent === reviewed.percent;
    const entry = { ...reviewed, checkedAt, changedAt: unchanged ? previous.changedAt ?? previous.checkedAt : checkedAt, readings: appendReading(ledger.progress[reviewed.groupId], { at: checkedAt, percent: reviewed.percent }) };
    writeJsonAtomic(join(dir, "progress", `${entry.groupId}.json`), entry);
    return print({ recorded: entry.groupId, state: entry.state, percent: entry.percent, readings: entry.readings.length });
  }
  if (command === "story-input") {
    const { groups, progress, story } = readLedger(dir);
    const reviews = Object.values(progress).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const writtenAt = Date.parse(story?.writtenAt ?? "");
    const update = Number.isFinite(writtenAt);
    return print({ groups: Object.keys(groups.groups).length, update, reviews: update ? reviews.filter((review) => Date.parse(review.changedAt ?? review.checkedAt) > writtenAt) : reviews, previousStory: story });
  }
  if (command === "record-story") {
    const story = { ...validateStory(readInput(args[0] ?? "-")), writtenAt: iso(now) };
    writeJsonAtomic(join(dir, "story.json"), story);
    return print({ recorded: "story", preferences: story.preferences.length });
  }
  if (command === "align-input") {
    const ledger = readLedger(dir);
    const goals = readGoals(db());
    const due = alignmentDue(ledger, goals);
    const groups = due.map((groupId) => {
      const group = ledger.groups.groups[groupId], review = ledger.progress[groupId];
      return { groupId, title: group.title, firstAsk: group.anchorAsk?.text?.slice(0, 400) ?? null, state: review?.state ?? null, percent: review?.percent ?? null, summary: review?.summary ?? null };
    });
    const previousLinks = Object.fromEntries(due.filter((id) => ledger.alignment?.links?.[id]).map((id) => [id, ledger.alignment.links[id]]));
    return print({ goals, groups, previous: ledger.alignment ? { alignedAt: ledger.alignment.alignedAt ?? null, links: previousLinks } : null });
  }
  if (command === "record-alignment") {
    const ledger = readLedger(dir);
    const goals = readGoals(db());
    const decided = validateAlignment(readInput(args[0] ?? "-"), { groups: ledger.groups.groups, goals: goals.goals });
    const decidedIds = /* @__PURE__ */ new Set([...Object.keys(decided.links), ...decided.unaligned]);
    const missing = alignmentDue(ledger, goals).filter((id) => !decidedIds.has(id));
    if (missing.length) throw new TypeError(`Every group align-input listed must appear in links or unaligned; missing ${missing.join(", ")}.`);
    const kept = (id) => ledger.groups.groups[id] && !decidedIds.has(id);
    const previous = ledger.alignment ?? {};
    const alignment = {
      links: { ...Object.fromEntries(Object.entries(previous.links ?? {}).filter(([id]) => kept(id))), ...decided.links },
      unaligned: [...(previous.unaligned ?? []).filter(kept), ...decided.unaligned],
      goalsGeneratedAt: goals.generatedAt,
      alignedAt: iso(now)
    };
    writeJsonAtomic(join(dir, "alignment.json"), alignment);
    return print({ aligned: Object.keys(decided.links).length, unaligned: decided.unaligned.length });
  }
  if (command === "refresh-needs") return print(refreshNeeds({ dir, database: db(), now, days: option(args, "days", 14) }));
  throw new TypeError("Usage: request-groups.mjs candidates|apply|pending|show|record-progress|story-input|record-story|align-input|record-alignment|refresh-needs (see file header).");
}

// src/services/work-view/request-groups-cli.mjs
try {
  runCli(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
