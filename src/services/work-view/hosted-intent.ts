/** Setup's subsidized extraction. The wire contract is claude-mem-pro's /api/pro/intent. */
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { OwnerPrompt } from '../prompt-import/index.js';
import { getOrCreateIntentCredentials, intentCredentialHeaders, readIntentCredentials } from '../../shared/intent-credentials.js';
import { groupIdFor, readGoals, readLedger, writeJsonAtomic, type LedgerDatabase } from './request-groups.mjs';

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
 * stricter connected-link graph or 200-character ignore reason restrictions on the Cloud contract. */
function mergeGroups(stored: Record<string, any>, result: HostedIntentResult, keys: Map<string, string>, writtenAt: string) {
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
    const id = groupIdFor(members[0]);
    const links = item.links.map(link => {
      if (link.conversations.some(member => !item.conversations.includes(member))) throw new Error('Hosted extraction returned a link outside its group.');
      return { ...link, conversations: link.conversations.map(keyFor) };
    });
    for (const key of members) { next.conversations[key] = id; delete next.ignored[key]; }
    next.groups[id] = { title: item.title, product: item.product, anchor: members[0], links, decidedAt: writtenAt,
      anchorAsk: next.groups[id]?.anchorAsk ?? null };
  }
  for (const item of result.groups.ignored) {
    const key = claim(item.conversation);
    next.ignored[key] = item.reason;
    delete next.conversations[key];
  }
  for (const id of keys.keys()) if (!seen.has(id)) throw new Error(`Hosted extraction omitted conversation ${id}.`);
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
      const { token, userId } = this.options.credentials();
      if (!!token !== !!userId) throw new Error('Hosted setup has incomplete CMEM account credentials. Repair the account connection before retrying.');
      if (!ownerPrompts.length) throw new Error('No owner-typed prompts were found for hosted setup. No prompts were uploaded.');
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
      this.save(parsed.data, keys, timezoneOffsetMinutes);
      this.current = { ...this.current, state: 'ok', step: null, finishedAt: this.iso() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.current = { ...this.current, state: 'failed', step: null, finishedAt: this.iso(), error: reason };
      throw new Error(reason);
    }
  }

  private save(result: HostedIntentResult, keys: Map<string, string>, offset: number): void {
    const { ledgerDir } = this.options;
    const writtenAt = this.iso();
    const ledger = readLedger(ledgerDir);
    const groups = mergeGroups(ledger.groups, result, keys, writtenAt);
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
    writeJsonAtomic(join(ledgerDir, 'hosted-intent.json'), result);
    for (const fields of rows) this.options.appendWorkStateEntry({ project: this.options.homeProject(), listName: 'owner-goals', fields });
    writeJsonAtomic(join(ledgerDir, 'request-groups.json'), groups);
    writeJsonAtomic(join(ledgerDir, 'story.json'), {
      narrative: goals.human_summary, preferences: result.rules.map(rule => ({ ...rule, quotes: rule.quotes.map(quote => ({ ...quote, at: quoteIso(quote.at, offset) })) })),
      writtenAt, source: 'hosted-intent',
    });
  }
}
