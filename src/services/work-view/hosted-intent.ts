/** Setup's subsidized extraction. The wire contract is claude-mem-pro's /api/pro/intent. */
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { OwnerPrompt } from '../prompt-import/index.js';
import { getOrCreateIntentCredentials, intentCredentialHeaders, readIntentCredentials } from '../../shared/intent-credentials.js';
import { groupIdFor, readConversationProjects, readGoals, readLedger, writeJsonAtomic, type LedgerDatabase } from './request-groups.mjs';
import { projectRoot } from './session-project.mjs';

/** Owner-approved cap: the largest measured export was 262 KB, and all exports fit one 1M-context call.
 * Cloud enforces this against both compressed and uncompressed bytes, plus its offline 400k-token budget. */
export const INTENT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const text = z.string().min(1).refine(value => value.trim().length > 0, 'Must contain text.');
const minute = text.regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
const quote = z.object({ at: minute, quote: text });
// Match Cloud's measured owner-goals protocol: 2–4 inspectable quotes shorter than 240 UTF-16 units.
const goal = z.object({ rank: z.number().int().positive(), title: text, product: text, latest_at: minute,
  times_asked: z.number().int().positive(), evidence: z.array(quote.extend({ quote: text.max(239) })).min(2).max(4) });
// Cloud's measured grouping protocol uses a 120-character visible title and two-conversation evidence links.
const group = z.object({ title: text.max(120), product: text, conversations: z.array(text).min(1),
  links: z.array(z.object({ kind: z.literal('agent-judgment'), conversations: z.tuple([text, text]), evidence: text })) });
const resultSchema = z.object({
  goals: z.object({ map: text, goals: z.object({ generated_at: text.datetime({ offset: true }), window_days: z.number().int().positive(),
    // Cloud's owner map asks for the ten highest priorities; open asks are not capped.
    source_prompt_count: z.number().int().nonnegative(), human_summary: text, priorities: z.array(goal).max(10), open_asks: z.array(goal) }) }),
  // Match the measured Cloud preference protocol: 30 rules, 200-character statements, 1–3 quotes of at most 300 characters.
  rules: z.array(z.object({ preference: text.max(200), kind: z.enum(['directive', 'correction', 'praise', 'frustration']),
    supportCount: z.number().int().positive(), quotes: z.array(quote.extend({ quote: text.max(300) })).min(1).max(3) })).max(30),
  groups: z.object({ groups: z.array(group), ignored: z.array(z.object({ conversation: text, reason: text })) }),
  cost_usd: z.number().finite().nonnegative(), model: text, dropped_quotes: z.number().int().nonnegative(),
});
export type HostedIntentResult = z.infer<typeof resultSchema>;
/** Cloud's answer plus what saving it needs, kept until the save finishes. */
interface PendingSave { result: HostedIntentResult; keys: Array<[string, string]>; offset: number; projects: Array<[string, string | undefined]> }
const COMPLETE_FILE = 'hosted-intent.json';
const PENDING_FILE = 'hosted-intent-pending.json';
export interface HostedIntentState {
  state: 'idle' | 'running' | 'ok' | 'failed';
  reason: 'setup-scan'; step: 'goals' | null; agent: null;
  startedAt: string | null; finishedAt: string | null; error: string | null;
}
export interface HostedIntentOptions {
  origin: () => string;
  credentials: () => { token: string; userId: string };
  /** Defaults to the installation's private intent configuration, shared with installer sign-in. */
  intentConfigPath?: string;
  ledgerDir: string;
  openDatabase: () => LedgerDatabase & { close(): void };
  appendWorkStateEntry: (entry: { project: string; listName: string; fields: Record<string, string | number | boolean | null> }) => void;
  homeProject: () => string;
  fetch?: typeof fetch;
  now?: () => number;
  timezoneOffsetMinutes?: () => number;
}

/** Cloud's conversation ids are session ids; local ledger keys also identify the agent. */
function conversationKeys(prompts: OwnerPrompt[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const prompt of prompts) {
    const key = JSON.stringify(['conversation', prompt.platformSource, prompt.sessionId]);
    if (keys.has(prompt.sessionId) && keys.get(prompt.sessionId) !== key) {
      throw new Error(`Hosted extraction cannot distinguish session ${prompt.sessionId} shared by multiple agents. No prompts were uploaded.`);
    }
    keys.set(prompt.sessionId, key);
  }
  return keys;
}

/** Preserve Cloud's complete grouping in the existing ledger, without imposing the local agent CLI's
 * stricter connected-link graph or 200-character ignore reason restrictions on the Cloud contract.
 * A request stays inside one project root (as My Work reads it), so a Cloud group spanning several
 * roots is saved as one group per root, each keeping the links between its own conversations. */
function mergeGroups(stored: Record<string, any>, result: HostedIntentResult, keys: Map<string, string>, writtenAt: string,
  projectOf: Map<string, string | undefined>) {
  const next = structuredClone(stored);
  const keyFor = (id: string) => {
    const key = keys.get(id);
    if (!key) throw new Error(`Hosted extraction returned an unknown conversation: ${id}.`);
    return key;
  };
  const seen = new Set<string>();
  const claim = (id: string) => {
    if (seen.has(id)) throw new Error(`Hosted extraction returned conversation ${id} more than once.`);
    seen.add(id);
    return keyFor(id);
  };
  for (const item of result.groups.groups) {
    const members = item.conversations.map(claim);
    const links = item.links.map(link => {
      if (link.conversations.some(member => !item.conversations.includes(member))) throw new Error('Hosted extraction returned a link outside its group.');
      return { ...link, conversations: link.conversations.map(keyFor) };
    });
    const byRoot = new Map<string | null, string[]>();
    for (const key of members) {
      const root = projectRoot(projectOf.get(key));
      byRoot.set(root, [...(byRoot.get(root) ?? []), key]);
    }
    for (const [root, rootMembers] of byRoot) {
      const id = groupIdFor(rootMembers[0]);
      for (const key of rootMembers) { next.conversations[key] = id; delete next.ignored[key]; }
      next.groups[id] = { title: item.title, product: item.product, anchor: rootMembers[0], projectRoot: root,
        links: links.filter(link => link.conversations.every(key => rootMembers.includes(key))), decidedAt: writtenAt,
        anchorAsk: next.groups[id]?.anchorAsk ?? null };
    }
  }
  for (const item of result.groups.ignored) {
    const key = claim(item.conversation);
    next.ignored[key] = item.reason;
    delete next.conversations[key];
  }
  // A conversation Cloud left out of every group (or placed twice, which Cloud removes and counts) stays as it was:
  // undecided conversations show as their own request, and the local refresh may group them later.
  const used = new Set(Object.values(next.conversations));
  for (const id of Object.keys(next.groups)) if (!used.has(id)) delete next.groups[id];
  return { ...next, updatedAt: writtenAt };
}

/** Interpret the Cloud citation's civil minute using the offset sent with this run, never the server's timezone. */
function quoteIso(at: string, offset: number): string {
  return new Date(Date.parse(`${at.replace(' ', 'T')}:00Z`) + offset * 60_000).toISOString();
}

export class HostedIntent {
  private current: HostedIntentState = { state: 'idle', reason: 'setup-scan', step: null, agent: null, startedAt: null, finishedAt: null, error: null };
  constructor(private options: HostedIntentOptions) {}
  state(): HostedIntentState { return { ...this.current }; }
  private iso(): string { return new Date((this.options.now ?? Date.now)()).toISOString(); }

  async run(ownerPrompts: OwnerPrompt[], improveProduct: boolean): Promise<void> {
    this.current = { state: 'running', reason: 'setup-scan', step: 'goals', agent: null, startedAt: this.iso(), finishedAt: null, error: null };
    try {
      // An empty scan has nothing to extract: finish without spending a hosted run or replacing saved work.
      if (!ownerPrompts.length) {
        this.current = { ...this.current, state: 'ok', step: null, finishedAt: this.iso() };
        return;
      }
      // A setup resumed after a successful run (installer restarted before Finish) keeps that result, since the
      // subsidized run may not be repeatable: a complete save is done, and a save that was cut off is replayed.
      if (this.completedResult()) {
        this.current = { ...this.current, state: 'ok', step: null, finishedAt: this.iso() };
        return;
      }
      const interrupted = this.pendingSave();
      if (interrupted) {
        this.save(interrupted);
        this.current = { ...this.current, state: 'ok', step: null, finishedAt: this.iso() };
        return;
      }
      const { token, userId } = this.options.credentials();
      if (!!token !== !!userId) throw new Error('Hosted setup has incomplete CMEM account credentials. Repair the account connection before retrying.');
      const keys = conversationKeys(ownerPrompts);
      const timezoneOffsetMinutes = this.options.timezoneOffsetMinutes?.() ?? new Date().getTimezoneOffset();
      const json = Buffer.from(JSON.stringify({ ownerPrompts, improveProduct, timezoneOffsetMinutes }));
      if (json.byteLength > INTENT_MAX_UPLOAD_BYTES) throw new Error('Hosted setup exceeds the 2 MiB upload cap. No prompts were truncated or uploaded.');
      const body = gzipSync(json);
      if (body.byteLength > INTENT_MAX_UPLOAD_BYTES) throw new Error('Hosted setup exceeds the 2 MiB compressed upload cap. No prompts were truncated or uploaded.');
      const origin = this.options.origin().replace(/\/$/, '');
      // Keep the proved install after sign-in so Cloud can bind its run and consent to the account.
      // Existing signed-in installations without an install credential retain their account-only path.
      const install = token ? readIntentCredentials(this.options.intentConfigPath)
        : await getOrCreateIntentCredentials({ origin, fetch: this.options.fetch, configPath: this.options.intentConfigPath });
      // No client retry: a lost response may already have spent this install/account's subsidized run.
      const response = await (this.options.fetch ?? fetch)(`${origin}/api/pro/intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip',
          ...intentCredentialHeaders(install), ...(token ? { Authorization: `Bearer ${token}`, 'X-User-Id': userId } : {}) }, body,
      });
      const answer = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = answer && typeof answer === 'object' ? answer as { message?: unknown; error?: unknown } : null;
        const reason = typeof failure?.message === 'string' ? failure.message : typeof failure?.error === 'string' ? failure.error : response.statusText;
        throw new Error(`Hosted setup failed (HTTP ${response.status}): ${reason || 'Cloud did not return a reason.'}`);
      }
      const parsed = resultSchema.safeParse(answer);
      if (!parsed.success) throw new Error(`Hosted setup returned an invalid response: ${parsed.error.message}`);
      // Keep Cloud's answer before writing anything from it, so a save that is cut off can be replayed.
      const pending: PendingSave = { result: parsed.data, keys: [...keys], offset: timezoneOffsetMinutes,
        projects: ownerPrompts.map(prompt => [keys.get(prompt.sessionId)!, prompt.project]) };
      mkdirSync(this.options.ledgerDir, { recursive: true });
      writeJsonAtomic(join(this.options.ledgerDir, PENDING_FILE), pending);
      this.save(pending);
      this.current = { ...this.current, state: 'ok', step: null, finishedAt: this.iso() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.current = { ...this.current, state: 'failed', step: null, finishedAt: this.iso(), error: reason };
      throw new Error(reason);
    }
  }

  /** The earlier run's result once every write finished (hosted-intent.json is written last). Invalid files fail loudly. */
  private completedResult(): HostedIntentResult | null {
    const path = join(this.options.ledgerDir, COMPLETE_FILE);
    if (!existsSync(path)) return null;
    const parsed = resultSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) throw new Error(`The saved hosted setup result at ${path} is invalid: ${parsed.error.message}`);
    return parsed.data;
  }

  /** Cloud's answer from a run whose save was cut off before it finished. */
  private pendingSave(): PendingSave | null {
    const path = join(this.options.ledgerDir, PENDING_FILE);
    if (!existsSync(path)) return null;
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<PendingSave>;
    const parsed = resultSchema.safeParse(saved.result);
    if (!parsed.success || !Array.isArray(saved.keys) || !Array.isArray(saved.projects) || typeof saved.offset !== 'number') {
      throw new Error(`The interrupted hosted setup save at ${path} is invalid${parsed.success ? '.' : `: ${parsed.error.message}`}`);
    }
    return { result: parsed.data, keys: saved.keys, offset: saved.offset, projects: saved.projects };
  }

  /** Writes goals, groups and rules. Safe to repeat: every write replaces what an earlier, cut-off attempt left. */
  private save({ result, keys: keyEntries, offset, projects }: PendingSave): void {
    const { ledgerDir } = this.options;
    const keys = new Map(keyEntries);
    const writtenAt = this.iso();
    const ledger = readLedger(ledgerDir);
    // The stored session's project (derived for scratch folders) is what My Work reads; the scan's own project covers the rest.
    const projectOf = new Map<string, string | undefined>(projects);
    const projectsDatabase = this.options.openDatabase();
    try {
      for (const [key, project] of readConversationProjects(projectsDatabase, [...keys.values()])) projectOf.set(key, project);
    } finally { projectsDatabase.close(); }
    const groups = mergeGroups(ledger.groups, result, keys, writtenAt, projectOf);
    const goals = result.goals.goals;
    const mapPath = join(ledgerDir, 'owner-goals', 'hosted-owner-map.md');
    const rows: Array<Record<string, string | number | boolean | null>> = [{
      human_summary: goals.human_summary, generated_at: goals.generated_at, window_days: goals.window_days,
      source_prompt_count: goals.source_prompt_count, map_path: mapPath, status: 'open',
      source: 'hosted-intent', hosted_generated_at: goals.generated_at,
    }];
    for (const [kind, items] of [['priority', goals.priorities], ['open-ask', goals.open_asks]] as const) {
      for (const item of items) rows.push({
        task: `${kind === 'priority' ? 'Priority' : 'Open ask'}: ${item.title}`, status: 'todo', goal_kind: kind,
        rank: item.rank, title: item.title, product: item.product, latest_at: item.latest_at, times_asked: item.times_asked,
        snapshot: goals.generated_at, source: 'hosted-intent', hosted_snapshot: goals.generated_at,
        // JSON preserves quotes containing newlines; the line format remains for older readers.
        evidence_json: JSON.stringify(item.evidence), evidence: item.evidence.map(quote => `${quote.at} | ${quote.quote}`).join('\n'),
      });
    }
    const tasks = new Set(rows.slice(1).map(row => row.task));
    if (tasks.size !== rows.length - 1) throw new Error('Hosted extraction returned duplicate goal titles.');
    const database = this.options.openDatabase();
    try {
      for (const previous of readGoals(database).goals) if (!tasks.has(previous.goal)) rows.push({ task: previous.goal, status: 'dropped' });
    } finally { database.close(); }
    // Internal work-state writes preserve the entire Cloud response. The public route's 2,000-character
    // request bound is not applied here: trimming summaries or evidence would silently change the result.
    mkdirSync(join(ledgerDir, 'owner-goals'), { recursive: true });
    writeFileSync(mapPath, result.goals.map, { mode: 0o600 });
    for (const fields of rows) this.options.appendWorkStateEntry({ project: this.options.homeProject(), listName: 'owner-goals', fields });
    writeJsonAtomic(join(ledgerDir, 'request-groups.json'), groups);
    writeJsonAtomic(join(ledgerDir, 'story.json'), {
      narrative: goals.human_summary, preferences: result.rules.map(rule => ({ ...rule, quotes: rule.quotes.map(quote => ({ ...quote, at: quoteIso(quote.at, offset) })) })),
      writtenAt, source: 'hosted-intent',
    });
    // Last: its presence means every write above finished.
    writeJsonAtomic(join(ledgerDir, COMPLETE_FILE), result);
    rmSync(join(ledgerDir, PENDING_FILE), { force: true });
  }
}
