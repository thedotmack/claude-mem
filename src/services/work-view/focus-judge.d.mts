import type { LedgerDatabase, FocusInput, FocusRequestRecord } from './request-groups.mjs';
import type { ConversationContext, JevClient } from './request-judge.mjs';

export const FOCUS_AUTO_PLACE_THRESHOLD: number | null;
export const MIN_OWNER_LABELED_PAIRS: number;

type FocusAreaChoice = { focusAreaId: string; name: string; goal?: string | null; about?: string | null };
/** Jev's pick for one request: a kept area's id or 'other', with its probability. */
export interface FocusPick { focusAreaId: string; confidence: number; evidence: string }
/** One judged request of a batch. focusAreaId null: unjudged, and the evidence says why. */
export interface FocusJudgement { anchor: string; focusAreaId: string | null; confidence: number | null; evidence: string }
export interface FocusJudge { name: string; pick(request: ConversationContext & { title: string }, areas: FocusAreaChoice[]): Promise<FocusPick> }

export function askFocusArea(client: JevClient, request: unknown, areas: FocusAreaChoice[]): Promise<FocusPick>;
export function jevFocusJudge(client: JevClient): FocusJudge;
export function configuredFocusJudge(settingsPath?: string): FocusJudge | null;
export function requestContexts(database: LedgerDatabase, ledger: Record<string, any>, requests: Array<Pick<FocusRequestRecord, 'anchor' | 'title'>>): Map<string, ConversationContext & { title: string }>;
export function judgeFocusBatch(options: { judge: FocusJudge; input: FocusInput; database: LedgerDatabase; ledger: Record<string, any> }): Promise<FocusJudgement[]>;
export function placesAlone(result: Pick<FocusJudgement, 'focusAreaId' | 'confidence'>, threshold?: number | null): boolean;
