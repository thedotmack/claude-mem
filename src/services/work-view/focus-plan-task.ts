/**
 * Planning help for the owner's focus areas. One click asks the owner's own agent once, through the same read-only
 * runner as the refresh, to read the areas (names, goals, notes, order) and each area's requests, and to propose:
 * a priority order, the initiatives to file the areas under, a sharper goal where one is vague, a first draft of notes
 * where there are none, and next asks. Every proposal is a suggestion. The worker checks each one and saves the plan;
 * nothing in it changes a focus area until the owner accepts it, and then it is the owner's existing action (reorder,
 * set-initiative, edit-goal, edit-notes) that saves.
 */
import { join } from 'path';
import type { AgentRunResult, AgentTask } from '../agent-runner/run.js';
import type { FocusArea } from './my-focus.mjs';
import { MAX_FOCUS_INITIATIVE_CHARS, initiativeKey, type FocusInitiativeFields } from './focus-initiative.mjs';
import { MAX_FOCUS_NOTES_CHARS } from './work-state-limits.mjs';
import { PLAN_PROPOSAL_KINDS, type PlanProposal, type PlanState } from './owner-runs.mjs';
import type { OwnerRunStore } from './owner-run-store.js';
import { inlineSkill, parseAgentJson, localAgentsOnly, readOnlyAgentTask, readOnlyRule, resolveStepModels, resolveTextLanguage } from './refresh-task.js';

const MAX_REQUESTS_PER_AREA = 25, MAX_ASKS_PER_REQUEST = 4, ASK_CHARS = 400;
const MAX_NEXT_ASKS = 3, GOAL_CHARS = 300, REASON_CHARS = 200, NEXT_ASK_CHARS = 300;

/** A request as the snapshot shows it, as far as planning reads it. */
export interface PlanSourceRequest {
  title: string; focusAreaId?: string; updatedAtEpoch?: number | null;
  original?: { text?: string | null } | null; scopeUpdates?: Array<{ text?: string | null }>;
  progress?: { state?: string; percent?: number; summary?: string; nextStep?: string; question?: { text: string } } | null;
}

export interface PlanInputArea {
  focusAreaId: string; name: string; goal: string | null; notes: string | null; status: FocusArea['status'];
  /** Its place in the owner's current order, 1 first. */
  position: number;
  /** The initiative it sits under now, and whose that is: the owner's own filing, or a guess from its folders. */
  initiative: string | null; initiativeFrom: 'owner' | 'guess' | null;
  /** The folders its requests ran in, most used first. */
  folders: string[];
  requests: Array<{ title: string; state: string | null; percent: number | null; summary: string | null; nextStep: string | null; question: string | null; asks: string[] }>;
}
export interface PlanInput {
  scope: 'all' | 'one'; areas: PlanInputArea[]; currentOrder: string[];
  /** The initiative names the owner already uses, across every area. */
  ownerInitiatives: string[];
}

const cut = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/**
 * What the agent reads: the areas still in the owner's focus (kept or suggested, not merged), in their current order,
 * each with its newest requests. With `focusAreaId` it holds that one area; the order then cannot be planned.
 */
export function focusPlanInput(focusAreas: ReadonlyArray<FocusArea & FocusInitiativeFields>, requests: readonly PlanSourceRequest[], focusAreaId: string | null): PlanInput {
  const live = focusAreas.filter(area => (area.status === 'kept' || area.status === 'suggested') && !area.mergedInto);
  const areas = live.map((area, index): PlanInputArea => ({
    focusAreaId: area.focusAreaId, name: area.name, goal: area.goal, notes: area.notes ?? null, status: area.status, position: index + 1,
    initiative: area.initiative ?? null, initiativeFrom: area.initiative ? area.initiativeGuess ? 'guess' : 'owner' : area.initiativeNone ? 'owner' : null, folders: area.folders ?? [],
    requests: requests.filter(request => request.focusAreaId === area.focusAreaId)
      .sort((a, b) => (b.updatedAtEpoch ?? 0) - (a.updatedAtEpoch ?? 0)).slice(0, MAX_REQUESTS_PER_AREA)
      .map(request => ({
        title: request.title, state: request.progress?.state ?? null, percent: request.progress?.percent ?? null,
        summary: cut(request.progress?.summary, 280), nextStep: cut(request.progress?.nextStep, 60), question: cut(request.progress?.question?.text, 200),
        asks: [request.original?.text, ...(request.scopeUpdates ?? []).map(update => update.text)].map(text => cut(text, ASK_CHARS)).filter((text): text is string => text !== null).slice(0, MAX_ASKS_PER_REQUEST),
      })),
  }));
  return {
    scope: focusAreaId === null ? 'all' : 'one',
    areas: focusAreaId === null ? areas : areas.filter(area => area.focusAreaId === focusAreaId),
    // Only kept areas have an order the owner can save (the reorder action lists every kept area once).
    currentOrder: focusAreaId === null ? live.filter(area => area.status === 'kept').map(area => area.focusAreaId) : [],
    ownerInitiatives: [...new Map(live.filter(area => area.initiative && !area.initiativeGuess).map(area => [initiativeKey(area.initiative), area.initiative!])).values()],
  };
}

const squeezed = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The agent's answer as the proposals My Work shows. Each proposal is checked on its own against the input it answers;
 * one the checks refuse is left out and named in `skipped`, so a plan never shows a proposal the owner's action would
 * refuse, and never a "quote" the owner did not type.
 */
export function validateFocusPlan(answer: unknown, input: PlanInput): { proposals: PlanProposal[]; skipped: string[] } {
  const listed = (answer as { proposals?: unknown } | null)?.proposals;
  if (!Array.isArray(listed)) throw new TypeError('The answer needs "proposals" (an array).');
  const areas = new Map(input.areas.map(area => [area.focusAreaId, area]));
  const proposals: PlanProposal[] = [], skipped: string[] = [];
  const once = new Set<string>();
  for (const [index, raw] of listed.entries()) {
    const proposal = (raw ?? {}) as Record<string, any>;
    const label = `proposals[${index}] (${String(proposal.kind)})`;
    const skip = (why: string) => { skipped.push(`${label}: ${why}`); };
    if (!(PLAN_PROPOSAL_KINDS as readonly string[]).includes(proposal.kind)) { skip(`kind must be one of ${PLAN_PROPOSAL_KINDS.join(', ')}`); continue; }
    if (proposal.kind === 'reorder') {
      const order: unknown = proposal.focusAreaIds;
      if (input.scope !== 'all') { skip('the order is planned only across all areas'); continue; }
      if (once.has('reorder')) { skip('a plan has one order'); continue; }
      if (!Array.isArray(order) || order.length !== input.currentOrder.length || new Set(order).size !== order.length || !input.currentOrder.every(id => order.includes(id))) {
        skip('focusAreaIds must list every kept area once'); continue;
      }
      if (order.every((id, position) => id === input.currentOrder[position])) { skip('it is the order you already have'); continue; }
      const moves = (Array.isArray(proposal.moves) ? proposal.moves : [])
        .filter((move: any) => order.includes(move?.focusAreaId) && cut(move?.reason, REASON_CHARS))
        .map((move: any) => ({ focusAreaId: move.focusAreaId as string, reason: cut(move.reason, REASON_CHARS)! }));
      if (!moves.length) { skip('every move needs one line of reasoning'); continue; }
      once.add('reorder');
      proposals.push({ kind: 'reorder', focusAreaIds: order as string[], moves });
      continue;
    }
    if (proposal.kind === 'initiative') {
      const name = typeof proposal.initiative === 'string' ? proposal.initiative.trim() : '', reason = cut(proposal.reason, REASON_CHARS);
      const ids: unknown = proposal.focusAreaIds;
      if (!name || name.length > MAX_FOCUS_INITIATIVE_CHARS) { skip(`initiative must be a name of at most ${MAX_FOCUS_INITIATIVE_CHARS} characters`); continue; }
      if (once.has(`initiative:${initiativeKey(name)}`)) { skip('this initiative already has a proposal'); continue; }
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || !ids.every(id => areas.has(id))) { skip('focusAreaIds must list areas this plan was asked about, each once'); continue; }
      if (!reason) { skip('an initiative needs its reason'); continue; }
      // The owner's own filing stands, and an area sits under one initiative: what is left is what Accept would change.
      const unfiled = (ids as string[]).filter(id => areas.get(id)!.initiativeFrom !== 'owner' && !once.has(`filed:${id}`));
      if (!unfiled.length) { skip('you already filed these areas yourself'); continue; }
      // One spelling per initiative: the owner's, when they already use the name.
      const spelled = input.ownerInitiatives.find(owned => initiativeKey(owned) === initiativeKey(name)) ?? name;
      once.add(`initiative:${initiativeKey(name)}`);
      for (const id of unfiled) once.add(`filed:${id}`);
      proposals.push({ kind: 'initiative', initiative: spelled, focusAreaIds: unfiled, reason });
      continue;
    }
    const area = areas.get(proposal.focusAreaId);
    if (!area) { skip(`${String(proposal.focusAreaId)} is not an area this plan was asked about`); continue; }
    const key = `${proposal.kind}:${area.focusAreaId}`;
    if (once.has(key)) { skip('this area already has one'); continue; }
    if (proposal.kind === 'goal') {
      const goal = typeof proposal.goal === 'string' ? proposal.goal.trim() : '', reason = cut(proposal.reason, REASON_CHARS);
      if (!goal || goal.length > GOAL_CHARS) { skip(`goal must be one sentence of at most ${GOAL_CHARS} characters`); continue; }
      if (goal === area.goal) { skip('it is the goal the area already has'); continue; }
      if (!reason) { skip('a sharper goal needs its reason'); continue; }
      proposals.push({ kind: 'goal', focusAreaId: area.focusAreaId, goal, reason });
    } else if (proposal.kind === 'notes') {
      const notes = typeof proposal.notes === 'string' ? proposal.notes.trim() : '';
      if (area.notes) { skip('the area already has your notes; a plan never drafts over them'); continue; }
      if (!notes || notes.length > MAX_FOCUS_NOTES_CHARS) { skip(`notes must be 1 to ${MAX_FOCUS_NOTES_CHARS} characters`); continue; }
      const asks = area.requests.flatMap(request => request.asks).map(squeezed);
      const quotes = (Array.isArray(proposal.quotes) ? proposal.quotes : []).filter((quote: unknown): quote is string => typeof quote === 'string' && !!quote.trim()).map((quote: string) => quote.trim());
      if (!quotes.length) { skip('a draft of notes quotes your own asks'); continue; }
      const invented = quotes.find((quote: string) => !asks.some(ask => ask.includes(squeezed(quote))));
      if (invented) { skip(`"${invented.slice(0, 80)}" is not in your asks word for word`); continue; }
      proposals.push({ kind: 'notes', focusAreaId: area.focusAreaId, notes, draft: true, quotes });
    } else {
      const asks = (Array.isArray(proposal.asks) ? proposal.asks : [])
        .filter((ask: any) => cut(ask?.text, NEXT_ASK_CHARS) && cut(ask?.reason, REASON_CHARS)).slice(0, MAX_NEXT_ASKS)
        .map((ask: any) => ({ text: cut(ask.text, NEXT_ASK_CHARS)!, reason: cut(ask.reason, REASON_CHARS)! }));
      if (!asks.length) { skip('each next ask needs its text and its reason'); continue; }
      proposals.push({ kind: 'next-asks', focusAreaId: area.focusAreaId, asks });
    }
    once.add(key);
  }
  return { proposals, skipped };
}

export interface FocusPlanDependencies {
  dataDir: string;
  ledgerDir: string;
  pluginRoot: string;
  store: OwnerRunStore;
  /** The shared agent runner (agent-runner/run.ts runAgentTask). */
  runAgent: (task: AgentTask) => Promise<AgentRunResult>;
}

/**
 * One plan, start to finish. It writes `planning` before its first await, never throws, and ends in `ready` or
 * `failed`. One call is one agent run with one question: an answer the checks cannot read fails the plan.
 */
export async function planFocus(dependencies: FocusPlanDependencies, input: PlanInput, start: { token: string; focusAreaId: string | null }): Promise<PlanState> {
  const { store, dataDir, ledgerDir, pluginRoot } = dependencies;
  try { store.beginPlan(start.token, start.focusAreaId); }
  catch { return 'failed'; }
  const fail = (error: string): PlanState => { store.finishPlan(start.token, { error: error.slice(0, 500) }); return 'failed'; };
  try {
    const result: { plan: ReturnType<typeof validateFocusPlan> | null } = { plan: null };
    const outcome = await dependencies.runAgent({
      ...localAgentsOnly(readOnlyAgentTask({ reason: 'focus-plan', dataDir, ledgerDir, pluginRoot })),
      // One click is one run: a failed plan is never handed to a second agent.
      stayOnFirstUsableAgent: true,
      run: async (ask, agent) => {
        const language = resolveTextLanguage(dataDir);
        const answer = await ask([
          inlineSkill(join(pluginRoot, 'skills', 'focus-plan', 'SKILL.md')), '---', readOnlyRule(agent, 'claude-mem planning help the owner asked for'),
          `The worker did step 1 for you. This is the plan input (${input.scope === 'all' ? 'every focus area' : 'one focus area'}):\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``,
          input.scope === 'all' ? '' : 'Plan this one area only: propose no "reorder".',
          'Reply with only the JSON the skill describes ({"proposals": [...]}); propose nothing where you have nothing better than what is there.',
          language ? `Write every proposal in ${language}; quotes stay as typed.` : '',
        ].filter(Boolean).join('\n\n'), resolveStepModels(dataDir).review);
        try { result.plan = validateFocusPlan(parseAgentJson(answer), input); }
        catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { answerRefused: true }); }
        return `${result.plan.proposals.length} proposals`;
      },
    });
    if (outcome.state !== 'ok' || !result.plan) return fail(outcome.error ?? 'The agent run did not finish.');
    store.finishPlan(start.token, result.plan);
    return 'ready';
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
