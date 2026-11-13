export const OWNER_RUNS_FILE: 'owner-runs.json';
export const ANSWER_RUN_STATES: readonly ['answering', 'delivered', 'failed'];
export type AnswerRunState = (typeof ANSWER_RUN_STATES)[number];
export const STAGE_STATES: readonly ['generating', 'ready', 'failed'];
export type StageState = (typeof STAGE_STATES)[number];
export const ICON_RUN_STATES: readonly Exclude<StageState, 'ready'>[];
export type IconRunState = (typeof ICON_RUN_STATES)[number];
export const STAGE_OUTPUT_KINDS: readonly ['markdown', 'html'];
export type StageOutputKind = (typeof STAGE_OUTPUT_KINDS)[number];
export const PLAN_STATES: readonly ['planning', 'ready', 'failed'];
export type PlanState = (typeof PLAN_STATES)[number];
export const PLAN_PROPOSAL_KINDS: readonly ['reorder', 'initiative', 'goal', 'notes', 'next-asks'];
export type PlanProposalKind = (typeof PLAN_PROPOSAL_KINDS)[number];
export const OWNER_RUN_START_STATES: readonly ['started', 'duplicate'];
export type OwnerRunStartState = (typeof OWNER_RUN_START_STATES)[number];
export const OWNER_RUN_TOKEN_PATTERN: RegExp;
export const STAGE_FORMAT_ID_PATTERN: RegExp;
export const MAX_ANSWER_CHARS: number;
export const STAGE_DELIVERABLE_KIND: 'stage';
export const AUTO_STAGE_LIMIT: number;
export function isOwnerRunInFlight(state: AnswerRunState | StageState | PlanState | undefined): boolean;

/** One answer's run, by request id. `error` is set only when `failed`. */
export interface AnswerRun { state: AnswerRunState; token: string; platform: string; startedAt: string; finishedAt: string | null; error: string | null; pid: number }
/** One stage, by request group and format. `file` is the path in the deliverables bucket and `url` the route that
 * serves it, both set only when `ready`. `reviewedThrough` is the progress review the stage was made for (null: none yet). */
export interface StageRecord {
  state: StageState; file: string | null; url: string | null; startedAt: string; generatedAt: string | null;
  reviewedThrough: string | null; error: string | null; pid: number;
  /** 'owner': a click in My Work. 'auto': the opt-in setting, after a refresh. */
  trigger: 'owner' | 'auto';
}
/** One focus icon's run, by focus area id. `error` is set only when `failed`. */
export interface IconRun { state: IconRunState; token: string; startedAt: string; error: string | null; pid: number }
export type PlanProposal =
  | { kind: 'reorder'; focusAreaIds: string[]; moves: Array<{ focusAreaId: string; reason: string }> }
  /** One initiative and the focus areas to file under it: only areas the owner has not filed themselves. */
  | { kind: 'initiative'; initiative: string; focusAreaIds: string[]; reason: string }
  | { kind: 'goal'; focusAreaId: string; goal: string; reason: string }
  /** A first draft from evidence, for an area with no notes; `quotes` are the owner's own asks, word for word. */
  | { kind: 'notes'; focusAreaId: string; notes: string; draft: true; quotes: string[] }
  | { kind: 'next-asks'; focusAreaId: string; asks: Array<{ text: string; reason: string }> };
/** The latest plan. `focusAreaId` is the one area it planned, or null for all of them. `skipped` says which proposals
 * the worker's checks refused, in plain words. */
export interface FocusPlan {
  state: PlanState; focusAreaId: string | null; token: string; startedAt: string; generatedAt: string | null;
  proposals: PlanProposal[]; skipped: string[]; error: string | null; pid: number;
}
export interface OwnerRunsFile {
  version: 1;
  /** Recent click tokens, oldest first. */
  tokens: string[];
  answers: Record<string, AnswerRun>;
  stages: Record<string, Record<string, StageRecord>>;
  plan: FocusPlan | null;
  icons: Record<string, IconRun>;
}
