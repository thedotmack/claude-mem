// The runs the owner starts from My Work with one click, and the states each shows. One click is at most one agent run:
// a failed run records `failed` with its reason and stops; nothing here queues, retries or replays it (AGENTS.md).
// The worker is the one writer of every state below (owner-run-store.ts). No Node imports: My Work loads this file.

/** The file beside the ledger that holds every record below. */
export const OWNER_RUNS_FILE = 'owner-runs.json';

/**
 * An answer the owner typed in My Work, sent to the request's own session as one headless turn.
 *   (none) → answering → delivered
 *                      → failed
 * `delivered` means the tool took the turn and exited cleanly; the session's reply arrives through normal capture.
 */
export const ANSWER_RUN_STATES = ['answering', 'delivered', 'failed'];

/**
 * One staged review of one request in one format.
 *   (none) → generating → ready
 *                       → failed
 * A new click on a ready or failed stage starts over at `generating`.
 */
export const STAGE_STATES = ['generating', 'ready', 'failed'];

/**
 * The focus-area plan: suggestions only, applied one by one by the owner's own actions.
 *   (none) → planning → ready
 *                     → failed
 */
export const PLAN_STATES = ['planning', 'ready', 'failed'];

/** What a plan may propose. `reorder` and `goal` are applied by the focus actions of the same meaning (reorder,
 * edit-goal); `next-asks` are asks the owner may copy into a chat, and nothing applies them. */
export const PLAN_PROPOSAL_KINDS = ['reorder', 'goal', 'next-asks'];

/** How a start route answers once it accepted the body: a run began, or this token already began one. */
export const OWNER_RUN_START_STATES = ['started', 'duplicate'];

/** A client-made id for one click; the same token never starts a second run. */
export const OWNER_RUN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** A stage format's id: a built-in's, or the file name of an owner's own format. */
export const STAGE_FORMAT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_ANSWER_CHARS = 8000;
/** The `kind` of a stage's row in the deliverables table, so a stage is never listed as the request's own work product. */
export const STAGE_DELIVERABLE_KIND = 'stage';
/** Automatic stage generation makes at most this many stages after one refresh. */
export const AUTO_STAGE_LIMIT = 3;

/** True while a run of this state has not ended. */
export const isOwnerRunInFlight = (state) => state === 'answering' || state === 'generating' || state === 'planning';
