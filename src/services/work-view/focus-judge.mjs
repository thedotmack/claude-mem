// The focus judge: before the focus agent sees a batch of requests to place, Jev is asked which of the owner's kept
// focus areas each request is part of. refresh-task.ts runs it on every focus-input batch when the install has Jev;
// scripts/calibrate-focus-routing.mjs asks the same question of the requests the owner placed by hand.
//
// One Jev `choice` question per request over the kept areas plus `none`, through request-judge.mjs's client (the CMEM
// Pro gateway or OpenRouter's Decisions API). More kept areas than one question takes are asked in sets, and when more
// than one set picks an area a last question goes over just those winners. A refused or failed call leaves the request
// unjudged with the reason; there are no retries and the state is never trimmed. While FOCUS_AUTO_PLACE_THRESHOLD is
// null every pick is only a hint for the focus agent, which decides.
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { readCandidates } from './request-groups.mjs';
import { answerOf, contextReader, jevClientFromSettings, MAX_CANDIDATE_REQUESTS } from './request-judge.mjs';

/** The Jev confidence at or above which a pick is placed without the agent. Null: no pick places a request on its own.
 * Measured 2026-10-27: the live `my-focus` list held 0 owner placements (`placed_by: owner`), so nothing is labeled
 * yet. Its 121 router placements are not labels: the seed placements came from Jev itself (tree2.json), so
 * calibrating Jev against them would be circular. Set this only from scripts/calibrate-focus-routing.mjs's table. */
export const FOCUS_AUTO_PLACE_THRESHOLD = null;
/** Owner-labeled pairs needed before the calibration table may suggest a cutoff: 97 = ceil(1.96² × 0.25 / 0.10²), the
 * sample at which a measured proportion's 95% interval is within ±10 points whatever the true rate (p = 0.5 is the
 * widest). Fewer, and a precision read off the table could be off by more than the gap between two cutoffs. */
export const MIN_OWNER_LABELED_PAIRS = 97;

const AREA_INSTRUCTIONS = '`request` is one piece of the owner\'s work. Which of `areas` is it part of: the area the owner could ask for it inside of (read each area\'s goal and about)? Working in the same repo is not enough. Pick `none` if it fits none of these areas.';
const NONE_CRITERION = 'None of these focus areas';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One choice over one set of areas: the pick (an area id or 'none') and Jev's probability for it. */
async function askSet(client, request, areas) {
  const answered = await client.decide(
    { request, areas: Object.fromEntries(areas.map((area) => [area.focusAreaId, { name: area.name, goal: area.goal ?? null, about: area.about ?? null }])) },
    { area: { type: 'choice', instructions: AREA_INSTRUCTIONS, criteria: { ...Object.fromEntries(areas.map((area) => [area.focusAreaId, `\`areas.${area.focusAreaId}\`: ${area.name}`])), none: NONE_CRITERION } } },
  );
  const pick = answerOf(answered, 'area', 'choice');
  if (pick.choice !== 'none' && !areas.some((area) => area.focusAreaId === pick.choice)) throw new Error(`Jev picked "${pick.choice}", which was not offered.`);
  const probability = pick.probabilities?.[pick.choice];
  if (!Number.isFinite(probability)) throw new Error(`Jev gave no probability for "${pick.choice}".`);
  return { choice: pick.choice, probability, model: typeof answered.model === 'string' && answered.model ? answered.model : client.model };
}

/** Sets of up to MAX_CANDIDATE_REQUESTS (the gateway's choice limit), then one question over the set winners when
 * more than one set picked an area (again in sets, should the winners themselves not fit one question). With no
 * winner the answer is none, at the lowest `none` probability any set gave: the least sure set speaks for all. */
async function pickAmong(client, request, areas, tally) {
  if (areas.length <= MAX_CANDIDATE_REQUESTS) return askSet(client, request, areas);
  const picks = [];
  for (let index = 0; index < areas.length; index += MAX_CANDIDATE_REQUESTS) {
    tally.sets++;
    picks.push(await askSet(client, request, areas.slice(index, index + MAX_CANDIDATE_REQUESTS)));
  }
  const winners = picks.filter((pick) => pick.choice !== 'none');
  if (!winners.length) return { choice: 'none', probability: Math.min(...picks.map((pick) => pick.probability)), model: picks[0].model };
  if (winners.length === 1) return winners[0];
  tally.finals++;
  return pickAmong(client, request, winners.map((winner) => areas.find((area) => area.focusAreaId === winner.choice)), tally);
}

/** Jev's pick for one request: a kept area's id, or 'other' when none fits, with Jev's probability and the evidence. */
export async function askFocusArea(client, request, areas) {
  if (!areas.length) throw new TypeError('askFocusArea needs at least one kept focus area.');
  const tally = { sets: 0, finals: 0 };
  const picked = await pickAmong(client, request, areas, tally);
  const asked = tally.sets
    ? `${plural(areas.length, 'kept focus area')}, asked in ${plural(tally.sets, 'set')} of up to ${MAX_CANDIDATE_REQUESTS}${tally.finals ? ` and ${plural(tally.finals, 'final question')} over the set winners` : ''}`
    : plural(areas.length, 'kept focus area');
  const p = `p ${picked.probability.toFixed(2)}`;
  if (picked.choice === 'none') return { focusAreaId: 'other', confidence: picked.probability, evidence: `Judge jev (${picked.model}): none of ${asked} fits (${p}).` };
  const area = areas.find((candidate) => candidate.focusAreaId === picked.choice);
  return { focusAreaId: area.focusAreaId, confidence: picked.probability, evidence: `Judge jev (${picked.model}): "${area.name}" over ${asked} (${p}).` };
}

export const jevFocusJudge = (client) => ({ name: 'jev', pick: (request, areas) => askFocusArea(client, request, areas) });

/** The focus judge this install can use (Jev on a CMEM Pro or OpenRouter install), or null: the agent places alone. */
export function configuredFocusJudge(settingsPath = USER_SETTINGS_PATH) {
  const client = jevClientFromSettings(SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }));
  return client ? jevFocusJudge(client) : null;
}

/** The context Jev reads for a request: its anchor conversation as request-judge.mjs measured it, plus the title. */
export function requestContexts(database, ledger, requests) {
  const context = contextReader(database);
  const anchors = new Map(readCandidates(database, { conversationKeys: requests.map((request) => request.anchor), excludedPromptIds: ledger.agentWrittenPromptIds })
    .map((candidate) => [candidate.conversationKey, candidate]));
  return new Map(requests.map((request) => [request.anchor, {
    title: request.title, ...context(request.anchor, { project: anchors.get(request.anchor)?.project ?? null, startedAt: anchors.get(request.anchor)?.startedAt ?? null }),
  }]));
}

/** Every request of one focus-input batch judged over its kept areas, in order: {anchor, focusAreaId, confidence,
 * evidence}, where focusAreaId is a kept area's id, 'other', or null when unjudged (no kept area, or the call was
 * refused or failed; the evidence says which). Requests are asked one after another, each once. */
export async function judgeFocusBatch({ judge, input, database, ledger }) {
  const kept = input.areas.filter((area) => area.status === 'kept');
  if (!kept.length) return input.requests.map((request) => ({ anchor: request.anchor, focusAreaId: null, confidence: null, evidence: `Judge ${judge.name}: no kept focus area to choose from.` }));
  const contexts = requestContexts(database, ledger, input.requests);
  const results = [];
  for (const request of input.requests) {
    try { results.push({ anchor: request.anchor, ...(await judge.pick(contexts.get(request.anchor), kept)) }); }
    catch (error) { results.push({ anchor: request.anchor, focusAreaId: null, confidence: null, evidence: `Judge ${judge.name} could not judge it: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  return results;
}

/** Whether a judged request is placed without the agent: a kept area picked at or above the threshold. A null
 * threshold places nothing. `none` is never placed alone: the question offers only kept areas, so it does not rule
 * out a suggested area, which only the agent sees. */
export function placesAlone(result, threshold = FOCUS_AUTO_PLACE_THRESHOLD) {
  if (threshold === null) return false;
  if (!Number.isFinite(threshold)) throw new TypeError(`The focus auto-place threshold must be a number or null, got ${threshold}.`);
  return result.focusAreaId != null && result.focusAreaId !== 'other' && result.confidence >= threshold;
}
