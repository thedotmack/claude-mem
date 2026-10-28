import type { LedgerDatabase } from './request-groups.mjs';

export const JOIN_THRESHOLD: number;
export const SUGGEST_THRESHOLD: number;
export const MAX_CANDIDATE_REQUESTS: number;
export const MAX_DECISION_BODY_BYTES: number;
export const JEV_MODEL: string;
export const OPENROUTER_DECISIONS_URL: string;

/** One conversation as Jev was measured with it: its worktree, start, first prompts and the titles the agent recorded. */
export interface ConversationContext { worktree: string | null; started: string | null; asks: string[]; agent_recorded: string[] }
export interface JudgedConversation {
  conversationKey: string;
  openingAsk?: string | null;
  context: ConversationContext;
  /** Code links naming this conversation (grouping-input's proposedLinks), with the requests their other members are in. */
  links?: Array<{ kind: string; conversations: string[]; evidence: string; groups: string[] }>;
}
export interface JudgedRequest { groupId: string; title: string; anchor: string; context: ConversationContext & { title: string } }
/** A judge's raw pick: the request it continues (null for none) and how sure the judge is. */
export interface JudgePick { requestId: string | null; confidence: number; evidence: string }
export type JudgeBand = 'join' | 'suggest' | 'new';
export interface JudgeVerdict extends JudgePick { judge: string; band: JudgeBand; rejected?: string }
export interface RequestJudge { name: string; judge(conversation: JudgedConversation, openRequests: JudgedRequest[]): Promise<JudgePick | null> }
export interface JevAnswer { answers: Record<string, any>; model?: string; usage?: unknown }
export interface JevClient { name: 'jev'; url: string; model: string; decide(state: unknown, questions: Record<string, unknown>): Promise<JevAnswer> }

export function answerOf(result: JevAnswer, id: string, type: string): any;
export const rulesJudge: RequestJudge;
export function jevJudge(client: JevClient): RequestJudge;
export function jevClient(options: { url: string; apiKey: string; model?: string | null; fetchImpl?: typeof fetch }): JevClient;
export function jevClientFromSettings(settings: Record<string, unknown> | null | undefined, options?: { credential?: (name: string) => string | undefined; fetchImpl?: typeof fetch }): JevClient | null;
/** The Jev judge this install can use, or null (then only code links route and the grouping agent decides the rest). */
export function configuredJudge(settingsPath?: string): RequestJudge | null;
export function bandFor(confidence: number): JudgeBand;
export function contextReader(database: LedgerDatabase): (conversationKey: string, hints?: { project?: string | null; startedAt?: string | null }) => ConversationContext;
export function judgeConversation(conversation: JudgedConversation, openRequests: JudgedRequest[], judge: RequestJudge): Promise<JudgeVerdict | null>;

export interface RoutedConversation {
  conversationKey: string; root: string | null; openingAsk: string | null; band: JudgeBand; judge: string; confidence: number; evidence: string;
  requestId: string; requestTitle: string; suggestedRequestId?: string; suggestedRequestTitle?: string;
}
export interface RoutingPlan {
  days: number; judges: string[]; applied: boolean;
  counts: { joined: number; suggested: number; new: number; unplaced: number };
  routed: RoutedConversation[];
  unplaced: Array<{ conversationKey: string; root: string | null; openingAsk: string | null; reason: string }>;
}
export function routeUndecided(options: { dir?: string; database: LedgerDatabase; judge?: RequestJudge | null; now?: number; days?: number; apply?: boolean }): Promise<RoutingPlan>;
export function decideSuggestion(options: { dir: string; database: LedgerDatabase; conversationKey: string; action: 'join' | 'not-this'; now?: number }): { status: 'joined' | 'declined'; requestId: string | null } | null;
