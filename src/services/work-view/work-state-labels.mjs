// Jev labels for open work-state items. An agent's work state is free notes: its status word is the last
// writer's claim, and what is next or what came out sits under whatever field name the agent picked. Jev reads
// each open item once per version (its latest entry) and labels it: the state the notes describe, and which of
// its own fields says what is next and what it produced. My Work shows a label at LABEL_THRESHOLD or above; no
// person approves labels. Labels are derived data in work-state-labels.json beside the ledger: the work-state
// log is never written, so an agent's own words stay what they were.
//
// The 10-minute My Work check runs labelOpenWorkState (auto-refresh-worker.mjs) when the install has Jev (the
// CMEM Pro gateway or OpenRouter's Decisions API, request-judge.mjs). Each item version is asked once, at most one
// call a second. A failure the item causes (a 400, a body over the limit, an answer that does not fit the question)
// is recorded for that version and never sent again. A refusal or outage of the service (401, 402, 429, 5xx, no
// connection) is not about the item and is never metered (claude-mem-pro docs/jev-decisions-gateway.md): it stops
// the run unrecorded. Either way the run stops there, and the items it did not reach are asked at the next check.
// A new write to an item is a new version.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { isAgentLifecycleList } from './agent-lifecycle.mjs';
import { isMyFocusList } from './my-focus.mjs';
import { isMyRulesList } from './my-rules.mjs';
import { isOwnerGoalsList } from './owner-goals.mjs';
import { answerOf, MAX_CANDIDATE_REQUESTS } from './request-judge.mjs';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { redactJsonStrings } from '../../utils/redaction.js';
import { readWorkStateRows, reduceWorkState } from './work-state-reduce.mjs';
import { isClosedWorkStateStatus } from './work-state-status.mjs';

export const WORK_STATE_LABELS_FILE = 'work-state-labels.json';

/** The states Jev chooses from, each with the words Jev reads and the recorded status My Work already words for
 * people (status-normalization.ts): a label changes which of My Work's existing statuses an item shows, never adds
 * one. Waiting on CI or another agent stays the agent's move, so it shows as work under way. */
export const JUDGED_WORK_STATES = {
  working: { criterion: 'Still being worked on: the notes describe work under way, and nothing says it finished, stalled or waits on someone', recordedStatus: 'doing' },
  not_started: { criterion: 'Not started yet: planned, or a step of a plan waiting its turn after another step', recordedStatus: 'todo' },
  waiting_on_person: { criterion: 'Waiting on the person: a decision, review, approval, login, answer or merge only they can give', recordedStatus: 'needs-you' },
  waiting_on_other: { criterion: 'Waiting on something else: CI, a running job, a release, another agent, a date or an outside service', recordedStatus: 'doing' },
  finished: { criterion: 'Finished: the notes say the work already finished, shipped, merged or was verified, though it was never marked done', recordedStatus: 'needs-review' },
  abandoned: { criterion: 'Abandoned: superseded, replaced, moved elsewhere or no longer wanted', recordedStatus: 'dropped' },
};

/** Jev's probability at or above which My Work shows a label. Measured 2026-11-10 on this owner's 200 open items
 * (.scratch/work-state-jev in the find-all-implicit-state worktree): by hand check of a fixed 28-item sample, Jev's
 * state choice was right 11 of 13 times at 0.8 or above and 9 of 15 times between 0.5 and 0.8. One labeler; the
 * two misses at 0.8+ were `todo` items, which judgedStatusFor below no longer lets a waiting label override. */
export const LABEL_THRESHOLD = 0.8;

/** The recorded statuses a label may replace. `doing`, and no status at all (`unknown` on a task, `open` on a
 * list's own state), are claims a quiet agent leaves behind. A `todo` may only be shown finished or abandoned:
 * in the measurement both confident misses read a plan's ordered `todo` steps as waiting. Any other word the agent
 * wrote (needs-review, blocked, ...) is its explicit choice and stays. */
const REPLACEABLE_STATUSES = new Set(['doing', 'unknown', 'open']);
const TODO_REPLACEMENTS = new Set(['finished', 'abandoned']);

const STATE_INSTRUCTIONS = '`item` is one entry of an AI agent\'s work list, as the agent last wrote it. `item.recorded_status` is the status word the agent wrote, which may be out of date. `item.days_since_last_update` is how long since anyone wrote to it. From the notes, which state is this work really in now?';
const NEXT_INSTRUCTIONS = 'Which field of `item.notes` says what is still left to do or what happens next?';
const RESULT_INSTRUCTIONS = 'Which field of `item.notes` says what the work produced, proved or delivered so far (a result, outcome, link or verification)?';
/** Keys that are not notes: the item's name and its status word, which the question already carries. */
const NOT_NOTES = new Set(['task', 'status']);
const DAY_MS = 86400000;
const notesOf = (fields) => Object.fromEntries(Object.entries(fields).filter(([key, value]) => !NOT_NOTES.has(key) && value !== null));
/** The pause between label calls. The CMEM Pro gateway allows 120 decisions a minute per user (claude-mem-pro
 * src/lib/jev/gateway.ts DECISIONS_PER_MINUTE) and the request and focus judges share that minute, so labeling
 * takes at most half: one call a second. Measured 2026-11-11: unpaced, 78 calls in 22 s drew a 429. */
export const LABEL_CALL_INTERVAL_MS = 1000;
/** jevClient's messages for a call the service refused or never answered: any status but 400, or no connection. */
const SERVICE_FAILURE = /^Jev (?:answered (?!400\b)\d{3}\b|request failed: )/;

/** Open agent-written work-state items as My Work lists them: tasks, and each list's own state when it has any.
 * System lists (owner goals, My Rules, My Focus, agent lifecycle) are not agent work notes. `labelKey` names the
 * version a label judged: the item's latest entry, and for a task whose list has notes (sent as list_notes) the
 * list's latest state entry too, so a write to either asks again. */
export function workStateItems(state) {
  const lists = state.lists.filter((list) => !isOwnerGoalsList(list.name) && !isMyRulesList(list.name) && !isMyFocusList(list.name) && !isAgentLifecycleList(list.name));
  if (!lists.length) return [];
  // Events are newest first in canonical write order. Keep the first state
  // event per list once, rather than searching the full history for each list.
  const stateEntryIds = new Map();
  const missingStateIds = new Set(lists.map((list) => list.id));
  for (const event of state.events) {
    if (event.task !== null || !missingStateIds.delete(event.listId)) continue;
    stateEntryIds.set(event.listId, event.id);
    if (!missingStateIds.size) break;
  }
  return lists.flatMap((list) => {
    const stateEntryId = stateEntryIds.get(list.id) ?? 0;
    const listNotesSent = Object.keys(notesOf(list.fields)).length > 0;
    return [
      ...list.tasks.map((task) => ({ ...task, list, recordKind: 'task', labelKey: listNotesSent ? `${task.latestEntryId}:${stateEntryId}` : String(task.latestEntryId) })),
      ...(Object.keys(list.fields).some((key) => key !== 'task') ? [{ id: list.id, name: list.name, fields: list.fields, status: list.status, isOpen: !isClosedWorkStateStatus(list.status), updatedAtEpoch: list.stateUpdatedAtEpoch, latestEntryId: stateEntryId, labelKey: String(stateEntryId), list, recordKind: 'list' }] : []),
    ];
  });
}

/** The labels file, or an empty one when it does not exist yet. Any other read or parse failure throws. */
export function readWorkStateLabels(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, WORK_STATE_LABELS_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.labels !== 'object' || typeof parsed.failures !== 'object') throw new TypeError(`${WORK_STATE_LABELS_FILE} is not a labels file.`);
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, labels: {}, failures: {} };
    throw error;
  }
}

/** One Jev call for one item: the state choice, and the two field choices when the item has 1 to 19 note fields
 * (one choice takes at most MAX_CANDIDATE_REQUESTS options plus `none`; more are left unasked, and the label says so). */
export async function labelItem(client, item, now) {
  const notes = notesOf(item.fields);
  const keys = Object.keys(notes);
  const listNotes = item.recordKind === 'task' ? notesOf(item.list.fields) : null;
  const state = {
    item: {
      project: item.list.project, list: item.list.name, ...(item.recordKind === 'task' ? { name: item.name } : {}),
      recorded_status: item.fields.status ?? '(none)', days_since_last_update: Math.max(0, Math.floor((now - item.updatedAtEpoch) / DAY_MS)),
      notes, ...(listNotes && Object.keys(listNotes).length ? { list_notes: listNotes } : {}),
    },
  };
  const questions = { state: { type: 'choice', instructions: STATE_INSTRUCTIONS, criteria: Object.fromEntries(Object.entries(JUDGED_WORK_STATES).map(([id, { criterion }]) => [id, criterion])) } };
  const fieldsAsked = keys.length > 0 && keys.length <= MAX_CANDIDATE_REQUESTS;
  if (fieldsAsked) {
    const options = Object.fromEntries(keys.map((key, index) => [`f${index}`, `\`item.notes.${key}\``]));
    questions.next = { type: 'choice', instructions: NEXT_INSTRUCTIONS, criteria: { ...options, none: 'No field says what is left or next' } };
    questions.result = { type: 'choice', instructions: RESULT_INSTRUCTIONS, criteria: { ...options, none: 'No field says what it produced' } };
  }
  // Agent notes can hold tokens, keys and cookies: redact every string before it leaves this computer.
  const answered = await client.decide(redactJsonStrings(state), questions);
  const choice = (id) => {
    const answer = answerOf(answered, id, 'choice');
    const probability = answer.probabilities?.[answer.choice];
    if (!Number.isFinite(probability)) throw new Error(`Jev gave no probability for "${answer.choice}".`);
    return { answer: answer.choice, probability };
  };
  const pickedState = choice('state');
  if (!Object.hasOwn(JUDGED_WORK_STATES, pickedState.answer)) throw new Error(`Jev picked "${pickedState.answer}", which was not offered.`);
  const field = (id) => {
    if (!fieldsAsked) return { field: null, p: null };
    const picked = choice(id);
    if (picked.answer === 'none') return { field: null, p: picked.probability };
    const key = keys[Number(picked.answer.slice(1))];
    if (key === undefined) throw new Error(`Jev picked "${picked.answer}", which was not offered.`);
    return { field: key, p: picked.probability };
  };
  const next = field('next'), result = field('result');
  return {
    at: new Date(now).toISOString(), model: typeof answered.model === 'string' && answered.model ? answered.model : client.model,
    state: pickedState.answer, stateP: pickedState.probability,
    nextField: next.field, nextP: next.p, resultField: result.field, resultP: result.p,
    ...(fieldsAsked || !keys.length ? {} : { fieldsNotAsked: `${keys.length} note fields; one choice takes at most ${MAX_CANDIDATE_REQUESTS}` }),
  };
}

/** Labels every open item whose current version has no label and no recorded failure, one after another, and
 * writes the file. Labels and failures of versions that are no longer an open item's latest are removed, so the
 * file holds only current open items. Returns what it did; throws only when the database or file cannot be read. */
export async function labelOpenWorkState({ dir, database, client, localDeviceId = '', now = Date.now, intervalMs = LABEL_CALL_INTERVAL_MS, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  // Replayed exactly as My Work replays them (data-source.mjs), so each label's key is the version the view shows.
  const items = workStateItems(reduceWorkState(readWorkStateRows(database), { currentProject: '', localDeviceId })).filter((item) => item.isOpen && item.latestEntryId > 0);
  const previous = readWorkStateLabels(dir);
  const current = new Set(items.map((item) => item.labelKey));
  const keep = (record) => Object.fromEntries(Object.entries(record).filter(([entryId]) => current.has(entryId)));
  const file = { schemaVersion: 1, labels: keep(previous.labels), failures: keep(previous.failures) };
  const pending = items.filter((item) => !file.labels[item.labelKey] && !file.failures[item.labelKey]);
  const size = (record) => Object.keys(record.labels).length + Object.keys(record.failures).length;
  const removed = size(previous) - size(file);
  // Labels are this install's own derived data, never shared, so the plain atomic write and not the ledger's
  // shared-file hook. Saved after every call, so a restart mid-run keeps what was labeled.
  const save = () => writeJsonFileAtomic(join(dir, WORK_STATE_LABELS_FILE), file, { mode: 0o600 });
  if (removed) save();
  let labeled = 0, failed = null, serviceFailure = null;
  for (const [index, item] of pending.entries()) {
    if (index) await wait(intervalMs);
    try { file.labels[item.labelKey] = await labelItem(client, item, now()); labeled++; }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      if (SERVICE_FAILURE.test(message)) { serviceFailure = message; break; }
      failed = { entryId: item.latestEntryId, at: new Date(now()).toISOString(), error: message };
      file.failures[item.labelKey] = { at: failed.at, error: failed.error };
      save();
      break;
    }
    save();
  }
  return { open: items.length, labeled, removed, notReached: pending.length - labeled - (failed ? 1 : 0), failed, serviceFailure };
}

/** What My Work shows for an item from its label: the recorded status to show instead of the agent's, and the
 * fields that hold its next step and result. Null fields mean "show it as written". A label of an older version,
 * or under LABEL_THRESHOLD, changes nothing. */
export function appliedLabel(item, labels, threshold = LABEL_THRESHOLD) {
  const label = labels?.[item.labelKey];
  if (!label) return { judgedStatus: null, nextField: null, resultField: null, label: null };
  // A list's reduced status is `open` for any word that is not closed, so `blocked` would read as replaceable.
  // Its recorded word decides instead; no word at all is `open`.
  const recorded = item.recordKind === 'list' ? (item.fields?.status == null || item.fields.status === '' ? 'open' : item.fields.status) : item.status;
  return {
    judgedStatus: label.stateP >= threshold ? judgedStatusFor(recorded, label.state) : null,
    nextField: label.nextField && label.nextP >= threshold ? label.nextField : null,
    resultField: label.resultField && label.resultP >= threshold ? label.resultField : null,
    label,
  };
}

/** The recorded status a judged state stands for, when the agent's own status word may be replaced; else null. */
export function judgedStatusFor(recordedStatus, judgedState) {
  const recorded = String(recordedStatus ?? 'unknown').toLowerCase();
  if (recorded === 'todo' ? !TODO_REPLACEMENTS.has(judgedState) : !REPLACEABLE_STATUSES.has(recorded)) return null;
  const status = JUDGED_WORK_STATES[judgedState]?.recordedStatus;
  if (!status) throw new TypeError(`"${judgedState}" is not a judged work state.`);
  return status === recorded ? null : status;
}
