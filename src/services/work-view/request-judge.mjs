// The judge that files a new conversation under the human request it continues, before any
// grouping agent sees it. refresh-task.ts runs it ahead of the agent batch; the request-groups
// CLI's `judge --days N [--apply]` backfills.
//
// Two judges. `rules` is the code link request-groups.mjs already proves: the conversation wrote
// to the same work-state list, or recorded the same request_id, as a member of one open request.
// `jev` is Typesafe's Jev, reached through the CMEM Pro decisions gateway with the key and base
// URL the worker already has, or on a bring-your-own-key install through OpenRouter's Decisions
// API; any other provider has no Jev judge and the conversation is handled as before. Jev gets one
// choice question over the root's open requests plus "none", then one calibrated yes/no check on
// the pick, and the check's score decides: join, a suggestion for the owner, or a request of its
// own. State is never trimmed to fit a limit: a question that would be too large is refused and
// the conversation falls back to the grouping agent.
import { join } from 'node:path';
import { buildKeyPool } from '../../shared/api-key-pool.js';
import { getCredential } from '../../shared/EnvManager.js';
import { isCmemGatewayUrl, isKeyAllowedForEndpoint } from '../../shared/cmem-gateway.js';
import { isOpenRouterApiUrl, resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { applyDecisions, groupIdFor, groupingInput, LEDGER_DIR, readCandidates, readLedger, writeJsonAtomic } from './request-groups.mjs';
import { humanRequestTitle, requestText } from './request-projection.mjs';

const DAY_MS = 86400000;
const iso = (epoch) => new Date(epoch).toISOString();

/** The check score at or above which a conversation joins the picked request on its own. Measured on
 * the owner's ledger (calibration2.json, 2026-10-26: 107 known links, 145 non-links): at 0.8 the check
 * was right 98% of the time (60 of the 61 pairs scoring 0.8 or more were links) and caught 56% of the
 * links; 0.9 caught only 29% for the same single false join, and 0.7 was right 91% of the time. */
export const JOIN_THRESHOLD = 0.8;
/** Below the join line and at or above this, the pick becomes a suggestion for the owner: in that band
 * the same measurement held 24 links and 21 non-links, a coin flip no code should settle. Below it,
 * 123 of 146 pairs were different work (84%), so the conversation starts its own request. */
export const SUGGEST_THRESHOLD = 0.5;
/** Open requests sent to one choice question: the Jev decisions gateway contract (claude-mem-pro,
 * docs/jev-decisions-gateway.md) takes up to 19 candidate requests plus `none`. The 19 most recently
 * active go, and the evidence says how many were left out; nothing is dropped silently. */
export const MAX_CANDIDATE_REQUESTS = 19;
/** The gateway refuses bodies over 64 KB with a 400 and never trims them (Jev's state limit is 32k
 * tokens). The same check runs here so a too-large question is refused before it is sent and the
 * conversation falls back to the grouping agent; state is never trimmed to fit. */
export const MAX_DECISION_BODY_BYTES = 64 * 1024;
/** The Jev playground's own fetch timeout, which the measurement client used. A decision answers in
 * about 30 ms, so this only bounds a hung connection. */
const DECISION_TIMEOUT_MS = 60_000;
/** The release the thresholds were measured against. The Pro gateway pins the same one server-side
 * and ignores a client model; a bring-your-own-key install names it itself. */
export const JEV_MODEL = 'typesafe/jev-1.14';
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** The per-conversation context Jev was measured with (the research client's context.mjs): the worktree
 * and start, the first three prompts at 250 characters, and the first eight titles the agent recorded at
 * 120. This is the measured prompt shape the thresholds hold for, not a fit to a limit. */
const CONTEXT_PROMPTS = 3, CONTEXT_PROMPT_CHARS = 250, CONTEXT_RECORDED_TITLES = 8, CONTEXT_TITLE_CHARS = 120;

const PICK_INSTRUCTIONS = '`conversation` was started after each of `requests`. Which of `requests` does it continue: the same overall piece of work (same feature, page, skill, release or investigation), or another run of the same recurring routine? A person tracking their requests would want both on one card. Pick `none` if it is a separate ask of its own.';
/** The calibrated check, word for word as it was measured (calibrate2.mjs). */
const CHECK_INSTRUCTIONS = '`conversation` was started after `request`. It continues `request`: the same overall piece of work (same feature, page, skill, release or investigation), or another run of the same recurring routine. A person tracking their requests would want both on one card.';
const CHECK_CRITERIA = { true: 'Same work', false: 'Different work' };

export function bandFor(confidence) {
  if (!Number.isFinite(confidence)) throw new TypeError(`A judge's confidence must be a number, got ${confidence}.`);
  return confidence >= JOIN_THRESHOLD ? 'join' : confidence >= SUGGEST_THRESHOLD ? 'suggest' : 'new';
}

const clean = (text) => String(text ?? '').split('# Attached files')[0].replace(/\s+/g, ' ').trim();

/** Reads one conversation's context as Jev was measured with it, cached per key for the run. `project`
 * and `startedAt` come from the caller's candidate (readCandidates) so the worktree is the derived one. */
export function contextReader(database) {
  const sessions = database.prepare('SELECT id, memory_session_id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ? ORDER BY id');
  const cache = new Map();
  return (conversationKey, { project = null, startedAt = null } = {}) => {
    if (cache.has(conversationKey)) return cache.get(conversationKey);
    const [, platform, sessionId] = JSON.parse(conversationKey);
    const rows = sessions.all(platform, sessionId);
    const ids = rows.map((row) => row.id);
    const memories = [...new Set(rows.map((row) => row.memory_session_id).filter(Boolean))];
    const marks = (values) => values.map(() => '?').join(',');
    const prompts = ids.length ? database.prepare(`SELECT prompt_text FROM user_prompts WHERE session_db_id IN (${marks(ids)}) ORDER BY session_db_id, prompt_number, id LIMIT ${CONTEXT_PROMPTS}`).all(...ids) : [];
    const recorded = memories.length ? database.prepare(`SELECT title FROM observations WHERE memory_session_id IN (${marks(memories)}) AND title IS NOT NULL ORDER BY created_at_epoch, id LIMIT ${CONTEXT_RECORDED_TITLES}`).all(...memories) : [];
    const context = {
      worktree: typeof project === 'string' ? project : null,
      started: typeof startedAt === 'string' ? startedAt.slice(0, 16) : null,
      asks: prompts.map((row) => clean(row.prompt_text).slice(0, CONTEXT_PROMPT_CHARS)).filter(Boolean),
      agent_recorded: recorded.map((row) => clean(row.title).slice(0, CONTEXT_TITLE_CHARS)),
    };
    cache.set(conversationKey, context);
    return context;
  };
}

/** Code-proven links: the conversation wrote to a work-state list, or recorded a request_id, that a
 * member of exactly one open request also did (linkBackwards). Several or none: no verdict. */
export const rulesJudge = {
  name: 'rules',
  async judge(conversation, openRequests) {
    const open = new Set(openRequests.map((request) => request.groupId));
    const picks = new Map();
    for (const link of conversation.links ?? []) for (const groupId of link.groups ?? []) if (open.has(groupId)) picks.set(groupId, link);
    if (picks.size !== 1) return null;
    const [[groupId, link]] = picks;
    return { requestId: groupId, confidence: 1, evidence: `Judge rules: ${link.kind} ${link.evidence}` };
  },
};

/** The answer Jev gave to question `id`, checked to be of the asked type. */
export function answerOf(result, id, type) {
  const answer = result?.answers?.[id];
  if (!answer || answer.type !== type) throw new Error(`Jev answered without a ${type} answer for "${id}".`);
  return answer;
}

/** Jev: one choice over the open requests plus "none", then the calibrated check on the pick. */
export function jevJudge(client) {
  return {
    name: 'jev',
    async judge(conversation, openRequests) {
      if (!openRequests.length) return { requestId: null, confidence: 1, evidence: 'Judge jev: no open request in this project root to continue.' };
      const candidates = openRequests.slice(0, MAX_CANDIDATE_REQUESTS);
      const considered = candidates.length === openRequests.length
        ? `${openRequests.length} open request${openRequests.length === 1 ? '' : 's'}`
        : `the ${candidates.length} most recently active of ${openRequests.length} open requests`;
      const picked = await client.decide(
        { conversation: conversation.context, requests: Object.fromEntries(candidates.map((request) => [request.groupId, request.context])) },
        { pick: { type: 'choice', instructions: PICK_INSTRUCTIONS, criteria: { ...Object.fromEntries(candidates.map((request) => [request.groupId, `\`requests.${request.groupId}\`: ${request.title}`])), none: 'None of these: a separate ask of its own' } } },
      );
      const pick = answerOf(picked, 'pick', 'choice');
      const model = typeof picked.model === 'string' && picked.model ? picked.model : client.model;
      const probability = (choice) => {
        const value = pick.probabilities?.[choice];
        if (!Number.isFinite(value)) throw new Error(`Jev gave no probability for "${choice}".`);
        return value;
      };
      if (pick.choice === 'none') return { requestId: null, confidence: probability('none'), evidence: `Judge jev (${model}): none of ${considered} is continued (p ${probability('none').toFixed(2)}).` };
      const request = candidates.find((candidate) => candidate.groupId === pick.choice);
      if (!request) throw new Error(`Jev picked "${pick.choice}", which was not offered.`);
      const checked = await client.decide({ request: request.context, conversation: conversation.context }, { same: { type: 'noul', instructions: CHECK_INSTRUCTIONS, criteria: CHECK_CRITERIA } });
      const score = answerOf(checked, 'same', 'noul').noul;
      if (!Number.isFinite(score)) throw new Error('Jev\'s check gave no score.');
      return { requestId: request.groupId, confidence: score, evidence: `Judge jev (${model}): picked "${request.title}" over ${considered} (p ${probability(pick.choice).toFixed(2)}); the check "continues that request" scored ${score.toFixed(2)}.` };
    },
  };
}

/** One send per question, no retry: the gateway meters nothing on a failure, and a refused or failed
 * call means the conversation goes to the grouping agent instead. */
export function jevClient({ url, apiKey, model = null, fetchImpl = fetch }) {
  if (typeof url !== 'string' || !url || typeof apiKey !== 'string' || !apiKey) throw new TypeError('A Jev client needs a url and an apiKey.');
  return {
    name: 'jev', url, model: model ?? JEV_MODEL,
    async decide(state, questions) {
      const body = JSON.stringify(model ? { model, state, questions } : { state, questions });
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > MAX_DECISION_BODY_BYTES) throw new Error(`Jev request is ${bytes} bytes; the decisions gateway takes at most ${MAX_DECISION_BODY_BYTES}. It is not trimmed: this conversation goes to the grouping agent instead.`);
      let response;
      try {
        response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(DECISION_TIMEOUT_MS) });
      } catch (error) { throw new Error(`Jev request failed: ${error instanceof Error ? error.message : String(error)}`); }
      const text = await response.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* A non-JSON body is reported below with its status. */ }
      if (!response.ok) {
        const failure = parsed?.error && typeof parsed.error === 'object' ? parsed.error : {};
        throw new Error(`Jev answered ${response.status}${failure.code ? ` ${failure.code}` : ''}: ${failure.message ?? text.slice(0, 200) ?? 'no body'}${failure.request_id ? ` (request ${failure.request_id})` : ''}`);
      }
      if (!parsed?.answers || typeof parsed.answers !== 'object') throw new Error('Jev answered without answers.');
      return parsed;
    },
  };
}

/** The Jev client this install can use, from the worker's own provider settings: the CMEM Pro gateway
 * (`<base>/decisions` with the cm_pro_ key) or openrouter.ai (the Decisions API with the user's key),
 * with the gateway/key lock every provider applies. Any other provider or endpoint: null, no judge. */
export function jevClientFromSettings(settings, { credential = (name) => getCredential(name), fetchImpl } = {}) {
  if (settings?.CLAUDE_MEM_PROVIDER !== 'openrouter') return null;
  const apiKey = String(settings.CLAUDE_MEM_OPENROUTER_API_KEY ?? '').trim() || credential('OPENROUTER_API_KEY') || '';
  const base = String(settings.CLAUDE_MEM_OPENROUTER_BASE_URL ?? '').trim();
  if (isCmemGatewayUrl(base)) {
    // The gateway key is account-delivered: never a pool key, as the provider's own config holds.
    const url = `${base.replace(/\/+$/, '')}/decisions`;
    return apiKey && isKeyAllowedForEndpoint(url, apiKey) ? jevClient({ url, apiKey, fetchImpl }) : null;
  }
  // Blank means openrouter.ai. Another OpenAI-compatible endpoint (DeepSeek, LM Studio) has no Decisions API.
  if (!isOpenRouterApiUrl(resolveOpenRouterChatCompletionsUrl(base))) return null;
  // The primary key, else the first key of the pool the provider rotates through (a pool-only install).
  const pool = buildKeyPool(apiKey, settings.CLAUDE_MEM_OPENROUTER_API_KEYS || credential('OPENROUTER_API_KEYS') || '');
  const key = pool.find((candidate) => isKeyAllowedForEndpoint(OPENROUTER_DECISIONS_URL, candidate));
  return key ? jevClient({ url: OPENROUTER_DECISIONS_URL, apiKey: key, model: JEV_MODEL, fetchImpl }) : null;
}

export function configuredJudge(settingsPath = USER_SETTINGS_PATH) {
  const client = jevClientFromSettings(SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }));
  return client ? jevJudge(client) : null;
}

/** One judge's verdict on one conversation against the open requests of its project root, banded:
 * `join` (the code link, or a check at JOIN_THRESHOLD or above), `suggest` (between the thresholds)
 * or `new` (below SUGGEST_THRESHOLD, or no request picked). Null when the judge cannot place it. */
export async function judgeConversation(conversation, openRequests, judge) {
  const pick = await judge.judge(conversation, openRequests);
  if (!pick) return null;
  if (pick.requestId != null && !openRequests.some((request) => request.groupId === pick.requestId)) throw new Error(`Judge ${judge.name} picked ${pick.requestId}, which is not an open request.`);
  const band = pick.requestId == null ? 'new' : bandFor(pick.confidence);
  return {
    requestId: band === 'new' ? null : pick.requestId, confidence: pick.confidence, evidence: pick.evidence, judge: judge.name, band,
    ...(band === 'new' && pick.requestId != null ? { rejected: pick.requestId } : {}),
  };
}

/** The title a request of one conversation starts with: the goal from its opening ask, as the card shows it. */
function ownTitle(openingAsk) {
  return humanRequestTitle(openingAsk) || requestText(openingAsk, 120) || 'Untitled request';
}

/** Route every undecided conversation of the window, earliest first, one project root at a time:
 * `rules` first, then `judge` (Jev) when the install has one. A join writes the conversation into the
 * request through the same decisions `apply` takes, with a `judge` link whose evidence names the judge
 * and its score, and records the request's root; a suggestion makes the conversation its own request
 * and keeps the pick in the ledger's `suggestions` for the owner; `new` makes it its own request. A
 * conversation no judge can place (no code link and no Jev, a refused or failed call) stays undecided
 * for the grouping agent. With `apply` the ledger is written after every decision; otherwise this is
 * the plan, decided as if each earlier decision had been written. */
export async function routeUndecided({ dir = LEDGER_DIR, database, judge = null, now = Date.now(), days = 14, apply = false }) {
  const judges = [rulesJudge, ...(judge ? [judge] : [])];
  const ledger = readLedger(dir);
  const sinceEpoch = now - days * DAY_MS;
  const context = contextReader(database);
  const skip = new Set();
  const routed = [], unplaced = [];
  let working = ledger.groups;
  const persist = () => { if (apply) writeJsonAtomic(join(dir, 'request-groups.json'), working); };
  for (;;) {
    const input = groupingInput({ ...ledger, groups: working }, database, { sinceEpoch, limit: Infinity, skip });
    if (!input.conversations.length) break;
    const { root } = input;
    // The open requests' anchors, read once per root for their worktree and start.
    const anchors = new Map(readCandidates(database, { conversationKeys: input.openRequests.map((request) => request.anchor), excludedPromptIds: ledger.agentWrittenPromptIds }).map((candidate) => [candidate.conversationKey, candidate]));
    let openRequests = input.openRequests.map((request) => ({
      groupId: request.groupId, title: request.title, anchor: request.anchor,
      context: { title: request.title, ...context(request.anchor, { project: anchors.get(request.anchor)?.project ?? null, startedAt: anchors.get(request.anchor)?.startedAt ?? null }) },
    }));
    for (const conversation of input.conversations) {
      const key = conversation.conversationKey;
      const judged = {
        conversationKey: key, openingAsk: conversation.openingAsk,
        context: context(key, { project: conversation.project, startedAt: conversation.startedAt }),
        // The code links naming this conversation, with the requests their other members are in now.
        links: input.proposedLinks.filter((link) => link.conversations.includes(key))
          .map((link) => ({ ...link, groups: [...new Set(link.conversations.map((other) => working.conversations[other]).filter(Boolean))] })),
      };
      let verdict = null, failure = null;
      for (const candidate of judges) {
        try { verdict = await judgeConversation(judged, openRequests, candidate); }
        catch (error) { failure = `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`; break; }
        if (verdict) break;
      }
      if (!verdict) {
        unplaced.push({ conversationKey: key, root, openingAsk: conversation.openingAsk, reason: failure ?? (judge ? 'no code link and no verdict' : 'no code link, and no Jev judge is configured: the grouping agent decides') });
        skip.add(key);
        continue;
      }
      // Applied runs re-read the ledger before each write: the owner may have answered a suggestion (or
      // another run decided this conversation) while the judge was awaited, and that answer must survive.
      // Between this read and persist() nothing is awaited, so no other write can land in between.
      if (apply) {
        working = readLedger(dir).groups;
        if (working.conversations[key] || working.ignored?.[key]) { skip.add(key); continue; }
      }
      // The request picked, as the ledger holds it now: an owner Join meanwhile may have moved it into another
      // request, so its anchor (and title) is whichever request now holds the anchor it was offered with.
      const live = (request) => {
        const id = request && working.conversations[request.anchor];
        const group = id && working.groups[id];
        return group ? { ...request, groupId: id, anchor: group.anchor, title: group.title } : null;
      };
      const picked = verdict.requestId ? openRequests.find((request) => request.groupId === verdict.requestId) : null;
      const target = verdict.band === 'join' ? live(picked) : null;
      if (verdict.band === 'join' && !target) {
        unplaced.push({ conversationKey: key, root, openingAsk: conversation.openingAsk, reason: `the picked request ${verdict.requestId} left the ledger while the judge was asked` });
        skip.add(key);
        continue;
      }
      const title = ownTitle(conversation.openingAsk);
      const decisions = target
        ? { groups: [{ title: target.title, conversations: [target.anchor, key], links: [{ kind: 'judge', conversations: [target.anchor, key], evidence: verdict.evidence }], ...(typeof root === 'string' && root ? { projectRoot: root } : {}) }] }
        : { groups: [{ title, conversations: [key] }] };
      working = applyDecisions(working, decisions, { database, now, excludedPromptIds: ledger.agentWrittenPromptIds });
      const suggested = verdict.band === 'suggest' ? live(picked) : null;
      if (suggested) working.suggestions = { ...(working.suggestions ?? {}), [key]: { requestId: suggested.groupId, confidence: verdict.confidence, evidence: verdict.evidence, judge: verdict.judge, at: iso(now), status: 'open' } };
      persist();
      // A request started here is the newest, so later conversations of the root may join it.
      if (!target) openRequests = [{ groupId: groupIdFor(key), title, anchor: key, context: { title, ...judged.context } }, ...openRequests];
      routed.push({
        conversationKey: key, root, openingAsk: conversation.openingAsk, band: verdict.band, judge: verdict.judge, confidence: verdict.confidence, evidence: verdict.evidence,
        requestId: target ? target.groupId : groupIdFor(key), requestTitle: target ? target.title : title,
        ...(suggested ? { suggestedRequestId: suggested.groupId, suggestedRequestTitle: suggested.title } : {}),
      });
    }
  }
  const count = (band) => routed.filter((entry) => entry.band === band).length;
  return { days, judges: judges.map((entry) => entry.name), applied: apply, counts: { joined: count('join'), suggested: count('suggest'), new: count('new'), unplaced: unplaced.length }, routed, unplaced };
}

/** The owner's answer to a suggestion. `join` moves the conversation into the suggested request through
 * the same decisions `apply` takes; `not-this` keeps (or makes) it a request of its own and records that
 * the owner declined. Null when no open suggestion exists for the conversation. */
export function decideSuggestion({ dir, database, conversationKey, action, now = Date.now() }) {
  if (!['join', 'not-this'].includes(action)) throw new TypeError(`action must be join or not-this, got ${action}.`);
  const ledger = readLedger(dir);
  const groups = ledger.groups;
  const suggestion = groups.suggestions?.[conversationKey];
  if (!suggestion || suggestion.status !== 'open') return null;
  const request = groups.groups[suggestion.requestId];
  let next;
  if (action === 'join') {
    if (!request) return null;
    // A conversation that anchors a request of its own brings that request's other members with it (later
    // conversations may have joined it meanwhile), with the links that joined them, so no group is left
    // naming an anchor that moved away.
    const ownId = groups.conversations[conversationKey];
    const brought = ownId && groups.groups[ownId]?.anchor === conversationKey
      ? Object.entries(groups.conversations).filter(([key, id]) => id === ownId && key !== conversationKey).map(([key]) => key) : [];
    const moving = new Set([conversationKey, ...brought]);
    const broughtLinks = brought.length ? (groups.groups[ownId].links ?? []).filter((link) => link.conversations.every((key) => moving.has(key))) : [];
    next = applyDecisions(groups, { groups: [{
      title: request.title, conversations: [request.anchor, conversationKey, ...brought],
      links: [{ kind: 'judge', conversations: [request.anchor, conversationKey], evidence: `Owner joined on the judge's suggestion. ${suggestion.evidence}` }, ...broughtLinks],
      ...(typeof request.projectRoot === 'string' && request.projectRoot ? { projectRoot: request.projectRoot } : {}),
    }] }, { database, now, excludedPromptIds: ledger.agentWrittenPromptIds });
    next.suggestions[conversationKey] = { ...suggestion, status: 'joined', resolvedAt: iso(now) };
    // Open suggestions aimed at the request this Join absorbed now point at the request that holds it.
    if (ownId && !next.groups[ownId]) for (const [other, entry] of Object.entries(next.suggestions)) {
      if (entry.status === 'open' && entry.requestId === ownId) next.suggestions[other] = { ...entry, requestId: suggestion.requestId };
    }
  } else {
    if (groups.conversations[conversationKey]) next = structuredClone(groups);
    else {
      const [candidate] = readCandidates(database, { conversationKeys: [conversationKey], excludedPromptIds: ledger.agentWrittenPromptIds });
      next = applyDecisions(groups, { groups: [{ title: ownTitle(candidate?.firstAsk ?? ''), conversations: [conversationKey] }] }, { database, now, excludedPromptIds: ledger.agentWrittenPromptIds });
    }
    next.suggestions = { ...(next.suggestions ?? {}), [conversationKey]: { ...suggestion, status: 'declined', resolvedAt: iso(now), evidence: `Owner declined: not part of "${request?.title ?? suggestion.requestId}". ${suggestion.evidence}` } };
    next.updatedAt = iso(now);
  }
  writeJsonAtomic(join(dir, 'request-groups.json'), next);
  return { status: next.suggestions[conversationKey].status, requestId: next.conversations[conversationKey] ?? null };
}
