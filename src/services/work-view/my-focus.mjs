// My Focus: the owner's focus areas and which area each request sits in.
// Areas and placements are work-state rows in the "my-focus" list under the home
// project, so they sync like any other work state (the same pattern as my-rules).
//   "Focus area: <focusAreaId>"           one area; every row saves the whole area.
//   "Placement: <anchorConversationKey>"  which area one request sits in.
// A placement is keyed by the request's anchor conversation key (the input groupIdFor
// hashes), never by the local g_ id. Area ids are never derived from names, so a
// rename keeps the id. Rows are append-only and replay in write order.
import { randomBytes } from 'node:crypto';
import { MAX_WORK_STATE_FIELDS_JSON_CHARS } from './work-state-limits.mjs';
import { reduceWorkState } from './work-state-reduce.mjs';
import { navWordIn } from './nav-words.mjs';

export const MY_FOCUS_LIST = 'my-focus';
/** The permanent bucket for requests that fit no area. Never an area id. */
export const OTHER_FOCUS_AREA_ID = 'other';
const FOCUS_AREA_TASK_PREFIX = 'Focus area: ';
const PLACEMENT_TASK_PREFIX = 'Placement: ';
const FOCUS_AREA_STATUSES = ['suggested', 'kept', 'dismissed', 'done'];
const FOCUS_AREA_SOURCES = ['owner-goals', 'clustering', 'promotion', 'seed', 'owner'];
/** What the focus step may propose, and the area source each becomes: a cluster of Other requests that are steps of
 * something larger, or one request whose conversations hold several separate asks. */
export const PROPOSAL_SOURCES = Object.freeze({ new: 'clustering', promote: 'promotion' });
export const PROPOSAL_KINDS = Object.freeze(Object.keys(PROPOSAL_SOURCES));
// Who wrote an area row: the owner (from My Work), the system (a refresh, a seed script), or the owner
// handing a decided area back to the system ("restore-suggestion"), after which system rows apply again.
const FOCUS_AREA_DECIDED_BY = ['owner', 'system', 'owner-restore'];
const PLACEMENT_PLACED_BY = ['router', 'owner'];

export const isMyFocusList = (name) => name === MY_FOCUS_LIST;
const focusAreaTaskName = (focusAreaId) => `${FOCUS_AREA_TASK_PREFIX}${focusAreaId}`;
const placementTaskName = (anchorConversationKey) => `${PLACEMENT_TASK_PREFIX}${anchorConversationKey}`;

const text = (value) => typeof value === 'string' ? value.trim() : '';
const rank = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

function fitsOneWrite(fields, what) {
  if (JSON.stringify(fields).length > MAX_WORK_STATE_FIELDS_JSON_CHARS) throw new RangeError(`This ${what} is too long to save. Shorten it.`);
  return fields;
}

/** The fields one area row saves: the whole area, so the row reads on its own on every device. */
export function focusAreaRowFields(area) {
  const focusAreaId = text(area.focusAreaId);
  if (!focusAreaId || focusAreaId === OTHER_FOCUS_AREA_ID) throw new Error(`A focus area needs an id other than "${OTHER_FOCUS_AREA_ID}".`);
  if (!text(area.name)) throw new Error('A focus area needs a name.');
  if (!FOCUS_AREA_STATUSES.includes(area.status)) throw new Error(`Unknown focus area status: ${area.status}`);
  if (!FOCUS_AREA_SOURCES.includes(area.source)) throw new Error(`Unknown focus area source: ${area.source}`);
  if (!FOCUS_AREA_DECIDED_BY.includes(area.decidedBy)) throw new Error(`Unknown focus area writer: ${area.decidedBy}`);
  return fitsOneWrite({
    task: focusAreaTaskName(focusAreaId), focus_area_id: focusAreaId,
    name: text(area.name), goal: text(area.goal) || null, about: text(area.about) || null, status: area.status,
    priority_rank: rank(area.priorityRank), owner_rank: rank(area.ownerRank),
    source: area.source, merged_into: text(area.mergedInto) || null,
    evidence: text(area.evidence) || null, decided_by: area.decidedBy,
  }, 'focus area');
}

/** The fields one placement row saves. A router placement carries the basis it was decided on (focusBasis in
 * request-groups.mjs), so a later change to the request queues it again. */
export function placementRowFields(placement) {
  const anchor = text(placement.anchorConversationKey);
  if (!anchor) throw new Error('A placement needs the request\'s anchor conversation key.');
  if (!text(placement.focusAreaId)) throw new Error('A placement needs a focus area id or "other".');
  if (!PLACEMENT_PLACED_BY.includes(placement.placedBy)) throw new Error(`Unknown placement writer: ${placement.placedBy}`);
  return fitsOneWrite({
    task: placementTaskName(anchor), anchor_conversation_key: anchor,
    focus_area_id: text(placement.focusAreaId), placed_by: placement.placedBy,
    confidence: rank(placement.confidence), basis: text(placement.basis) || null, evidence: text(placement.evidence) || null,
  }, 'placement');
}

/** A new area id: random, like an owner-written rule's id (`own_` + 6 random bytes), never derived from
 * the name, so a rename keeps it. */
export const newFocusAreaId = () => `fa_${randomBytes(6).toString('hex')}`;

/**
 * The my-focus rows for the focus areas owner-goals mined from the owner's prompts. Each mined area
 * carries the model's judgment of which saved area it already is: `matches` is that area's id, or null
 * for an area not saved yet. Names are never compared.
 * - matches null: a new area, written by the system as `source: owner-goals, status: suggested`, with
 *   the id `newId()` gives it.
 * - matches a saved area: no new area. A suggestion nobody has decided gets the mined rank, and the mined
 *   goal when it has none (hosted setup saves areas without one); its name and an existing goal are never
 *   changed. An area the owner kept, renamed, merged, dismissed or finished is left as it is (the reducer
 *   would ignore a system row for it anyway). A match to an area the owner merged away answers that area's
 *   own id, not the area it was merged into: readers follow the merge (the viewer's resolveFocusAreaId), and
 *   the next save, which passes each item's saved id back as `matches`, still has one mined area per saved
 *   area. Answering the merge target would give two items the same id and refuse that next save.
 * A match to an id that is not saved, or two mined areas matching one saved area, is refused: the answer
 * is wrong, and guessing which area was meant would file the owner's words under the wrong one.
 * Returns the rows to write and each mined area's id, in the mined order.
 */
export function ownerGoalsAreaRows(minedAreas, savedAreas, newId = newFocusAreaId) {
  // A withdrawn area (a seed undo) is not an area the owner has: a mined area never matches it.
  const savedById = new Map(savedAreas.filter((area) => !isWithdrawnArea(area)).map((area) => [area.focusAreaId, area]));
  const claimed = new Set();
  const rows = [], focusAreaIds = [];
  for (const [index, mined] of minedAreas.entries()) {
    const matches = mined.matches;
    if (matches !== null && typeof matches !== 'string') throw new TypeError(`focus_areas[${index}].matches must be a saved focus area id or null.`);
    if (matches === null) {
      refuseNavWordName(mined.name, `focus_areas[${index}]`);
      const focusAreaId = newId(index);
      if (savedById.has(focusAreaId) || focusAreaIds.includes(focusAreaId)) throw new Error(`Focus area id ${focusAreaId} is already used.`);
      rows.push(focusAreaRowFields({
        focusAreaId, name: mined.name, goal: mined.goal, status: 'suggested', priorityRank: mined.rank, ownerRank: null,
        source: 'owner-goals', mergedInto: null, evidence: mined.evidence, decidedBy: 'system',
      }));
      focusAreaIds.push(focusAreaId);
      continue;
    }
    const saved = savedById.get(matches);
    if (!saved) throw new TypeError(`focus_areas[${index}] matches ${matches}, which is not a saved focus area.`);
    if (claimed.has(matches)) throw new TypeError(`Two mined focus areas match ${matches}; one saved area is one mined area.`);
    claimed.add(matches);
    const fillGoal = !text(saved.goal) && text(mined.goal);
    if (saved.decidedBy !== 'owner' && saved.status === 'suggested' && (saved.priorityRank !== mined.rank || fillGoal)) {
      rows.push(focusAreaRowFields({ ...saved, priorityRank: mined.rank, goal: fillGoal ? mined.goal : saved.goal, decidedBy: 'system' }));
    }
    focusAreaIds.push(saved.focusAreaId);
  }
  return { rows, focusAreaIds };
}

/** Rows are patches: a null field clears it, like reduceWorkState. */
function applyPatch(target, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'task') continue;
    if (value === null) delete target[key];
    else target[key] = value;
  }
}

/**
 * Areas and placements from the my-focus rows, replayed in write order (the clock,
 * then the writing device, then its row id there — reduceWorkState's order), across
 * every project's my-focus list, since two computers with different home folders save
 * under different projects.
 * - The latest accepted row wins.
 * - Once the owner has written an area, system rows for it are ignored: a refresh
 *   never overrides a kept area, a rename, a merge or a dismissal. An owner-restore
 *   row hands the area back, and system rows apply again.
 * - An owner placement beats any router placement, whatever the order, while it still
 *   lands in a live area; once its area is dismissed, the router's placement shows.
 * - A placement into a merged area forwards to the area it was merged into.
 * A row this build cannot read (unknown status, source or writer, no name, the id
 * "other") throws: My Focus never guesses what a row meant.
 */
/** localDeviceId (readFocus passes the worker's): the Other pass record is this computer's own. Its hash covers each
 * request's local basis (titles and conversation groups are local), so another computer's record never matches and
 * taking it would start a paid proposal pass on every computer in turn. Null: no pass record is read. */
export function buildFocusAreas(state, { localDeviceId = null } = {}) {
  // The reducer needs every row's own fields, not the merged task: an owner row must
  // still win after a later router row on the same task. state.events holds them only
  // when reduceWorkState kept every event (its default).
  if (typeof state.entryCount === 'number' && state.events.length !== state.entryCount) {
    throw new Error('My Focus needs every work-state row; the events were cut.');
  }
  const areas = new Map(), placements = new Map();
  let otherPassHash = null;
  // state.events is newest first.
  for (const event of [...state.events].reverse()) {
    if (!isMyFocusList(event.listName)) continue;
    if (event.task === null) {
      // The list's own row: which Other requests this computer's last proposal pass already looked at.
      if (localDeviceId !== null && event.sourceOrder?.[1] === localDeviceId && Object.hasOwn(event.fields, 'other_pass_hash')) otherPassHash = text(event.fields.other_pass_hash) || null;
      continue;
    }
    if (event.task.startsWith(FOCUS_AREA_TASK_PREFIX)) {
      const focusAreaId = text(event.fields.focus_area_id) || event.task.slice(FOCUS_AREA_TASK_PREFIX.length);
      if (focusAreaId === OTHER_FOCUS_AREA_ID) throw new Error(`A my-focus area row uses the reserved id "${OTHER_FOCUS_AREA_ID}".`);
      const decidedBy = event.fields.decided_by;
      if (!FOCUS_AREA_DECIDED_BY.includes(decidedBy)) throw new Error(`Focus area ${focusAreaId} has an unknown writer: ${decidedBy}`);
      const area = areas.get(focusAreaId) ?? { fields: {}, ownerDecided: false, savedAt: null };
      if (area.ownerDecided && decidedBy === 'system') continue;
      applyPatch(area.fields, event.fields);
      if (decidedBy !== 'system') area.ownerDecided = decidedBy === 'owner';
      area.savedAt = event.at;
      areas.set(focusAreaId, area);
    } else if (event.task.startsWith(PLACEMENT_TASK_PREFIX)) {
      const anchor = text(event.fields.anchor_conversation_key) || event.task.slice(PLACEMENT_TASK_PREFIX.length);
      const placedBy = event.fields.placed_by;
      if (!PLACEMENT_PLACED_BY.includes(placedBy)) throw new Error(`A placement has an unknown writer: ${placedBy}`);
      // The owner's and the router's latest placements are kept apart: the router's
      // shows when the owner's area is gone.
      const placement = placements.get(anchor) ?? { owner: null, router: null };
      placement[placedBy] ??= { fields: {}, device: null };
      applyPatch(placement[placedBy].fields, event.fields);
      // The device that wrote the latest row: a router basis is only comparable on the device that computed it.
      placement[placedBy].device = event.sourceOrder?.[1] ?? null;
      placements.set(anchor, placement);
    }
  }

  const focusAreas = [...areas].map(([focusAreaId, { fields, savedAt }]) => {
    if (!text(fields.name)) throw new Error(`Focus area ${focusAreaId} has no name.`);
    if (!FOCUS_AREA_STATUSES.includes(fields.status)) throw new Error(`Focus area ${focusAreaId} has an unknown status: ${fields.status}`);
    if (!FOCUS_AREA_SOURCES.includes(fields.source)) throw new Error(`Focus area ${focusAreaId} has an unknown source: ${fields.source}`);
    return {
      focusAreaId, name: text(fields.name), goal: text(fields.goal) || null, about: text(fields.about) || null, status: fields.status,
      priorityRank: rank(fields.priority_rank), ownerRank: rank(fields.owner_rank), source: fields.source,
      mergedInto: text(fields.merged_into) || null, evidence: text(fields.evidence) || null,
      decidedBy: fields.decided_by, savedAt,
    };
  })
    // The owner's order wins; areas they have not ordered follow by suggested priority.
    .sort((a, b) => (a.ownerRank ?? Infinity) - (b.ownerRank ?? Infinity)
      || (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity) || a.name.localeCompare(b.name));

  const byId = new Map(focusAreas.map((area) => [area.focusAreaId, area]));
  /** The live area a placement lands in, following merges; null when it has none (not sorted yet). */
  const resolve = (focusAreaId) => {
    if (focusAreaId === OTHER_FOCUS_AREA_ID) return OTHER_FOCUS_AREA_ID;
    const seen = new Set();
    let area = byId.get(focusAreaId);
    while (area?.mergedInto && byId.has(area.mergedInto) && !seen.has(area.mergedInto)) {
      seen.add(area.focusAreaId);
      area = byId.get(area.mergedInto);
    }
    // Still merged: a loop written on two devices (A into B here, B into A there), or a target this device
    // has not received yet. A dismissed area holds no requests, and an unknown area is not received yet.
    return area && !area.mergedInto && area.status !== 'dismissed' ? area.focusAreaId : null;
  };
  const focusAreaIdByAnchor = new Map();
  /** Each anchor's latest owner and router placement: the area it names, the basis it was decided on and its device. */
  const placementsByAnchor = new Map();
  const side = (written) => written && { focusAreaId: text(written.fields.focus_area_id), basis: text(written.fields.basis) || null, evidence: text(written.fields.evidence) || null, device: written.device };
  for (const [anchor, { owner, router }] of placements) {
    const focusAreaId = (owner && resolve(text(owner.fields.focus_area_id))) || (router && resolve(text(router.fields.focus_area_id)));
    if (focusAreaId) focusAreaIdByAnchor.set(anchor, focusAreaId);
    placementsByAnchor.set(anchor, { owner: side(owner), router: side(router) });
  }
  return { focusAreas, focusAreaIdByAnchor, placementsByAnchor, resolveFocusAreaId: resolve, otherPassHash };
}

/**
 * My Focus read straight from the my-focus rows (for a refresh, the request-groups CLI or a setup save running beside
 * the worker), replayed in the worker's order. localDeviceId is required: it is the worker's sync device id ('' when
 * cloud sync never started, which is when every row is local), and a wrong one would reorder rows written at the same
 * millisecond and compare router bases written on another device.
 */
export function readFocus(database, { localDeviceId } = {}) {
  if (typeof localDeviceId !== 'string') throw new TypeError('readFocus needs the worker\'s sync device id ("" when cloud sync never started).');
  const rows = database.prepare('SELECT * FROM work_state_entries WHERE list_name = ?').all(MY_FOCUS_LIST);
  return buildFocusAreas(reduceWorkState(rows, { localDeviceId }), { localDeviceId });
}

/** The saved focus areas, read straight from the my-focus rows. */
export const readFocusAreas = (database, options) => readFocus(database, options).focusAreas;

/** An area the router may place requests in: kept or suggested, and not merged away. A dismissed area never
 * takes requests, and a done area takes no new ones. */
export const isPlaceableArea = (area) => (area.status === 'kept' || area.status === 'suggested') && !area.mergedInto;

/**
 * The my-focus rows for one focus-step answer (record-focus), written only as the system: router placements, each
 * proposed area as a new `status: suggested` area under a random id (never derived from its name) with router
 * placements of the requests it holds, and, after a pass over Other, the list row recording which Other requests that
 * pass looked at. Nothing here can stand in for an owner decision.
 * - A placement into an area that is not placeable now (unknown, dismissed, done or merged) is refused, never moved
 *   to Other: the answer was made on areas that changed, and guessing would file the request wrongly.
 * - A proposal's `sameAs` is the model's judgment of which saved area it already is (like ownerGoalsAreaRows' matches):
 *   a placeable area takes the proposal's requests and no area is added; a dismissed area is refused, since the owner
 *   said no to it and it is never proposed again; any other id is refused.
 * Every row is built (and size-checked) before the caller writes the first one, so a refusal writes nothing.
 * Returns the rows, the new areas' ids in order, and how many requests were placed.
 */
export function routerFocusRows({ placements, proposals, otherPassHash = null }, savedAreas, newId = newFocusAreaId) {
  const placeable = new Set(savedAreas.filter(isPlaceableArea).map((area) => area.focusAreaId));
  const byId = new Map(savedAreas.map((area) => [area.focusAreaId, area]));
  const anchors = new Set();
  const claim = (anchor, label) => {
    if (anchors.has(anchor)) throw new TypeError(`${label} places ${anchor} a second time; a request sits in one area.`);
    anchors.add(anchor);
  };
  const rows = [];
  for (const [index, placement] of placements.entries()) {
    claim(placement.anchorConversationKey, `placements[${index}]`);
    if (placement.focusAreaId !== OTHER_FOCUS_AREA_ID && !placeable.has(placement.focusAreaId)) {
      throw new TypeError(`placements[${index}] names ${placement.focusAreaId}, which ${byId.has(placement.focusAreaId) ? 'no longer takes requests' : 'is not a focus area'}.`);
    }
    rows.push(placementRowFields({ ...placement, placedBy: 'router' }));
  }
  const focusAreaIds = [];
  for (const [index, proposal] of proposals.entries()) {
    const label = `proposals[${index}]`;
    const source = PROPOSAL_SOURCES[proposal.kind];
    if (!source) throw new TypeError(`${label}.kind must be one of ${PROPOSAL_KINDS.join(', ')}.`);
    let focusAreaId;
    if (proposal.sameAs != null) {
      const same = byId.get(proposal.sameAs);
      if (same && isOwnerDismissedArea(same)) throw new TypeError(`${label} is ${proposal.sameAs} ("${same.name}"), which the owner dismissed; it is never proposed again.`);
      if (same && isWithdrawnArea(same)) throw new TypeError(`${label}.sameAs names ${proposal.sameAs} ("${same.name}"), which was withdrawn and takes no requests; propose it as a new area (sameAs null).`);
      if (!placeable.has(proposal.sameAs)) throw new TypeError(`${label}.sameAs names ${proposal.sameAs}, which ${same ? 'no longer takes requests' : 'is not a focus area'}.`);
      focusAreaId = proposal.sameAs;
    } else {
      refuseNavWordName(proposal.name, label);
      focusAreaId = newId(index);
      if (byId.has(focusAreaId) || focusAreaIds.includes(focusAreaId)) throw new Error(`Focus area id ${focusAreaId} is already used.`);
      rows.push(focusAreaRowFields({
        focusAreaId, name: proposal.name, goal: proposal.goal, about: proposal.about, status: 'suggested', priorityRank: null, ownerRank: null,
        source, mergedInto: null, evidence: proposal.evidence, decidedBy: 'system',
      }));
      focusAreaIds.push(focusAreaId);
    }
    for (const request of proposal.requests) {
      claim(request.anchorConversationKey, label);
      rows.push(placementRowFields({ anchorConversationKey: request.anchorConversationKey, focusAreaId, placedBy: 'router', basis: request.basis, evidence: proposal.evidence }));
    }
  }
  if (otherPassHash != null) rows.push({ other_pass_hash: otherPassHash });
  return { rows, focusAreaIds, placed: anchors.size };
}

/** An area the owner said no to: never proposed again. An area the system withdrew (a seed undo) is not one: the
 * owner never judged it, so the focus step may propose it again. */
export const isOwnerDismissedArea = (area) => area.status === 'dismissed' && area.decidedBy === 'owner';
/** An area the system withdrew (a seed undo): dismissed, but never by the owner. It holds no requests, is no match
 * target, and is not on the never-propose-again list. */
export const isWithdrawnArea = (area) => area.status === 'dismissed' && area.decidedBy !== 'owner';
/** Every seed placement's evidence starts with this, so an undo can tell the seed's router rows from the focus step's. */
export const SEED_EVIDENCE_PREFIX = 'Seed: ';

/** An area name reusing a nav label would read as a nav item: one rule, shared with the UI (nav-words.mjs). */
export { navWordIn };
/** Refuses a new area name that reuses a nav label (the seed, a rename, and every system suggestion use this). */
export function refuseNavWordName(name, label) {
  const navWord = navWordIn(name);
  if (navWord) throw new TypeError(`${label} is named "${text(name)}", which reuses the nav word "${navWord}". Name it without one.`);
}

/** A router placement row that clears the router's placement of one request (the seed undo): append-only, so the
 * request goes back to "not sorted yet" and the next focus step places it. The owner's placement is untouched. */
export function clearedPlacementRowFields(anchorConversationKey, evidence) {
  const anchor = text(anchorConversationKey);
  if (!anchor) throw new Error('A cleared placement needs the request\'s anchor conversation key.');
  return fitsOneWrite({
    task: placementTaskName(anchor), anchor_conversation_key: anchor,
    focus_area_id: null, placed_by: 'router', confidence: null, basis: null, evidence: text(evidence) || null,
  }, 'placement');
}

/**
 * The my-focus rows for the one-time seed (scripts/seed-focus-areas.mjs), written only as the system:
 * - each seed area with `matches: null` becomes a new `source: seed, status: suggested` area under a random id; one with
 *   `matches: <id>` is the model's or reviewer's judgment that it already is that placeable saved area, and adds no row.
 *   When placeable areas are saved, every seed area must state `matches` (null or an id): names are never compared.
 * - each placement is a router placement into a seed area's key or "other", with the request's focusBasis (from
 *   request-groups.mjs), so the focus step places the request again once it changes, and evidence starting with
 *   SEED_EVIDENCE_PREFIX, so an undo can tell it from the focus step's placements. A request that already has a live placement (the owner's or the router's) is left as it is
 *   and reported in `skipped`, so the seed never overrides newer routing or the owner.
 * Refused: a second seed while a seed area is still live, an area name holding a nav word, an unknown area key, a
 * request placed twice, a match to an area that takes no requests, or two seed areas matching one saved area.
 * focus is readFocus's result. Every row is built before the caller writes the first one.
 */
export function seedFocusRows({ areas, placements }, focus, newId = newFocusAreaId) {
  const live = focus.focusAreas.filter((area) => area.status !== 'dismissed');
  const seeded = live.find((area) => area.source === 'seed');
  if (seeded) throw new TypeError(`The seed was already applied (${seeded.focusAreaId}, "${seeded.name}" is a live seed area). Undo it first.`);
  const placeable = new Map(focus.focusAreas.filter(isPlaceableArea).map((area) => [area.focusAreaId, area]));
  const rows = [], focusAreaIds = {}, created = [], claimed = new Set();
  for (const [index, area] of areas.entries()) {
    const label = `areas[${index}] (${area.key})`;
    if (!text(area.key) || area.key === OTHER_FOCUS_AREA_ID || Object.hasOwn(focusAreaIds, area.key)) throw new TypeError(`${label} needs a unique key other than "${OTHER_FOCUS_AREA_ID}".`);
    refuseNavWordName(area.name, label);
    if (area.matches === undefined && placeable.size) {
      throw new TypeError(`${label} must state "matches" (a saved area id or null): focus areas are already saved (${[...placeable.values()].map((saved) => `${saved.focusAreaId} "${saved.name}"`).join(', ')}).`);
    }
    if (area.matches != null) {
      if (!placeable.has(area.matches)) throw new TypeError(`${label} matches ${area.matches}, which is not a focus area that takes requests.`);
      if (claimed.has(area.matches)) throw new TypeError(`${label} matches ${area.matches}, which another seed area already matches.`);
      claimed.add(area.matches);
      focusAreaIds[area.key] = area.matches;
      continue;
    }
    const focusAreaId = newId(index);
    if (focus.focusAreas.some((saved) => saved.focusAreaId === focusAreaId) || created.includes(focusAreaId)) throw new Error(`Focus area id ${focusAreaId} is already used.`);
    rows.push(focusAreaRowFields({
      focusAreaId, name: area.name, goal: area.goal, about: area.about, status: 'suggested', priorityRank: area.priorityRank, ownerRank: null,
      source: 'seed', mergedInto: null, evidence: area.evidence, decidedBy: 'system',
    }));
    focusAreaIds[area.key] = focusAreaId;
    created.push(focusAreaId);
  }
  const placed = [], skipped = [], anchors = new Set();
  for (const [index, placement] of placements.entries()) {
    const anchor = text(placement.anchorConversationKey);
    if (anchors.has(anchor)) throw new TypeError(`placements[${index}] places ${anchor} a second time; a request sits in one area.`);
    anchors.add(anchor);
    if (!text(placement.evidence).startsWith(SEED_EVIDENCE_PREFIX)) throw new TypeError(`placements[${index}].evidence must start with "${SEED_EVIDENCE_PREFIX}".`);
    if (!text(placement.basis)) throw new TypeError(`placements[${index}] needs the request's focus basis.`);
    const focusAreaId = placement.area === OTHER_FOCUS_AREA_ID ? OTHER_FOCUS_AREA_ID : focusAreaIds[placement.area];
    if (!focusAreaId) throw new TypeError(`placements[${index}] names the area key ${JSON.stringify(placement.area)}, which is not a seed area or "${OTHER_FOCUS_AREA_ID}".`);
    const current = focus.placementsByAnchor.get(anchor);
    const ownerArea = current?.owner && focus.resolveFocusAreaId(current.owner.focusAreaId);
    const routerArea = current?.router && focus.resolveFocusAreaId(current.router.focusAreaId);
    if (ownerArea || routerArea) { skipped.push({ anchorConversationKey: anchor, placedBy: ownerArea ? 'owner' : 'router', focusAreaId: ownerArea || routerArea }); continue; }
    rows.push(placementRowFields({ anchorConversationKey: anchor, focusAreaId, placedBy: 'router', confidence: placement.confidence, basis: placement.basis, evidence: placement.evidence }));
    placed.push({ anchorConversationKey: anchor, focusAreaId, basis: placement.basis });
  }
  return { rows, focusAreaIds, created, placed, skipped };
}

/**
 * The my-focus rows that take one seed back (its note: the areas it created and the placements it wrote). Append-only:
 * - a seed area stays live, as the owner's, when the owner decided it (kept, renamed, merged, dismissed) or uses it:
 *   an owner placement lands in it, or the owner merged another area into it. Withdrawing it would cancel those
 *   decisions silently. Otherwise it is withdrawn with a system `dismissed` row (not an owner dismissal, so the focus
 *   step may propose it again).
 * - a placement is cleared (clearedPlacementRowFields) only while the router's placement is still the seed's (the
 *   note's area and basis, and seed evidence) and its area is withdrawn or Other: a placement in an area the owner kept
 *   or uses stays, so undo never empties the owner's area. A placement a later focus step replaced is left, and the
 *   owner's placements are never touched.
 * Refused: a note naming an area that is not saved or not a seed area.
 */
export function seedUndoRows({ focusAreaIds, placements }, focus) {
  const byId = new Map(focus.focusAreas.map((area) => [area.focusAreaId, area]));
  const ownerTargets = new Set([
    ...[...focus.placementsByAnchor.values()].map((placement) => placement.owner?.focusAreaId).filter(Boolean),
    ...focus.focusAreas.filter((area) => area.decidedBy === 'owner' && area.mergedInto).map((area) => area.mergedInto),
  ]);
  const rows = [], withdrawn = [], leftByOwner = [], leftInOwnerUse = [], alreadyWithdrawn = [], cleared = [], replaced = [], leftInOwnerArea = [];
  for (const focusAreaId of focusAreaIds) {
    const area = byId.get(focusAreaId);
    if (!area) throw new TypeError(`The note names ${focusAreaId}, which is not a saved focus area.`);
    if (area.source !== 'seed') throw new TypeError(`The note names ${focusAreaId} ("${area.name}"), which the seed did not create (source ${area.source}).`);
    if (area.decidedBy === 'owner') { leftByOwner.push(focusAreaId); continue; }
    if (area.status === 'dismissed') { alreadyWithdrawn.push(focusAreaId); continue; }
    if (ownerTargets.has(focusAreaId)) { leftInOwnerUse.push(focusAreaId); continue; }
    rows.push(focusAreaRowFields({ ...area, status: 'dismissed', decidedBy: 'system' }));
    withdrawn.push(focusAreaId);
  }
  const ownerAreas = new Set([...leftByOwner, ...leftInOwnerUse]);
  for (const { anchorConversationKey, focusAreaId, basis } of placements) {
    const router = focus.placementsByAnchor.get(anchorConversationKey)?.router;
    if (!router || router.focusAreaId !== focusAreaId || router.basis !== (basis ?? null) || !router.evidence?.startsWith(SEED_EVIDENCE_PREFIX)) { replaced.push(anchorConversationKey); continue; }
    if (ownerAreas.has(focusAreaId)) { leftInOwnerArea.push(anchorConversationKey); continue; }
    rows.push(clearedPlacementRowFields(anchorConversationKey, 'Seed undone: back to not sorted yet.'));
    cleared.push(anchorConversationKey);
  }
  return { rows, withdrawn, leftByOwner, leftInOwnerUse, alreadyWithdrawn, cleared, replaced, leftInOwnerArea };
}

/** The conversation a request's placement is keyed by: its group's anchor, else its own conversation. */
export function anchorConversationKeyFor(request, ledger) {
  // A group missing from the ledger (not grouped on this device yet) falls back to the request's own conversation.
  const anchor = (request.groupId ? ledger?.groups?.groups?.[request.groupId]?.anchor : null) || request.conversationKey;
  return typeof anchor === 'string' && anchor ? anchor : null;
}

/** Each request with its anchor and its area: an area id, "other", or absent while it is not sorted yet. */
export function placeRequests(humanRequests, focusAreaIdByAnchor, ledger) {
  return humanRequests.map((request) => {
    const anchorConversationKey = anchorConversationKeyFor(request, ledger);
    const focusAreaId = anchorConversationKey ? focusAreaIdByAnchor.get(anchorConversationKey) : undefined;
    return { ...request, anchorConversationKey, ...(focusAreaId ? { focusAreaId } : {}) };
  });
}
