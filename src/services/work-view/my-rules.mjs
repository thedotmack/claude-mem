// My Rules: how the owner wants agents to work, as if-then rules (spec §13.3, §14).
// Suggested rules come from the build story's preferences (request-progress skill).
// The owner's decisions are work-state rows in the "my-rules" list under the home
// project, one task per rule ("Rule: <ruleId>"). Rows are append-only and the
// latest write wins, so they sync like any other work state. No new table.
import { createHash } from 'node:crypto';

export const MY_RULES_LIST = 'my-rules';
export const RULE_TASK_PREFIX = 'Rule: ';
export const RULE_SCOPE_TIERS = ['everywhere', 'project', 'situation'];
export const RULE_SET_BY = ['owner', 'approved', 'learned'];
export const SAVED_RULE_STATUSES = ['on', 'off', 'replaced', 'dismissed', 'suggested'];
// One work-state write is at most 2000 characters of JSON (WorkStateRoutes).
const MAX_QUOTES = 3;
const MAX_QUOTE_CHARS = 200;
const DAY_MS = 86400000;

export const isMyRulesList = (name) => name === MY_RULES_LIST;
export const ruleIdForPreference = (preference) => `pref_${createHash('sha256').update(String(preference)).digest('hex').slice(0, 12)}`;
export const ruleTaskName = (ruleId) => `${RULE_TASK_PREFIX}${ruleId}`;

const text = (value) => typeof value === 'string' ? value.trim() : '';
const count = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const shortQuote = (quote) => quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS - 1)}…` : quote;

/** "YYYY-MM-DD HH:MM | quote" lines, the same format owner-goals uses for evidence. */
export function quoteLines(quotes) {
  return quotes.slice(0, MAX_QUOTES).map((quote) => {
    const at = quote.at && Number.isFinite(Date.parse(quote.at)) ? new Date(quote.at).toISOString().slice(0, 16).replace('T', ' ') : '';
    return `${at} | ${shortQuote(String(quote.quote).replace(/\s+/g, ' ').trim())}`;
  }).join('\n');
}

function parseQuoteLines(value, kind) {
  if (typeof value !== 'string') return [];
  return value.split('\n').flatMap((line) => {
    const match = /^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)?\s*\|\s*(.+)$/.exec(line.trim());
    if (!match) return [];
    return [{ at: match[1] ? `${match[1].replace(' ', 'T')}${match[1].length > 10 ? ':00Z' : ''}` : null, quote: match[2], kind }];
  });
}

/** A rule's scope as one id: "everywhere", or "<tier>:<name>". */
export const ruleScopeId = (tier, name) => tier === 'everywhere' ? 'everywhere' : `${tier}:${name}`;

function suggestionsFromStory(story) {
  const preferences = Array.isArray(story?.preferences) ? story.preferences : [];
  return preferences.filter((preference) => text(preference?.preference)).map((preference) => {
    const originalQuotes = (preference.quotes ?? []).filter((quote) => text(quote?.quote));
    // Cloud already validates its quote budget; retain that evidence in full in the setup snapshot.
    const quotes = (story.source === 'hosted-intent' ? originalQuotes : originalQuotes.slice(0, MAX_QUOTES))
      .map((quote) => ({ at: quote.at ?? null, quote: story.source === 'hosted-intent' ? String(quote.quote) : shortQuote(text(quote.quote)), kind: preference.kind }));
    const latest = quotes.map((quote) => Date.parse(quote.at ?? '')).filter(Number.isFinite);
    return {
      ruleId: ruleIdForPreference(preference.preference),
      scopeTier: 'everywhere', scopeName: 'Everywhere',
      // Preferences are single sentences: the whole preference is the "then". Splitting a when out of it
      // would need a model call, which this view never makes; owner-goals' rules already carry their own.
      when: text(preference.when), then: story.source === 'hosted-intent' ? String(preference.preference) : text(preference.preference),
      setBy: 'learned', status: 'suggested', kind: preference.kind ?? 'directive', source: preference.source === 'owner-goals' ? 'owner-goals' : 'request-progress',
      timesSeen: Number.isInteger(preference.supportCount) && preference.supportCount > 0 ? preference.supportCount : 1,
      latestAt: latest.length ? new Date(Math.max(...latest)).toISOString() : story.writtenAt ?? null,
      quotes, replacedBy: null, replacedAt: null, savedAt: null,
    };
  });
}

/** Story suggestions with the saved my-rules rows laid over them; owner-written rules added. */
export function buildRules(state, ledger) {
  const rules = new Map(suggestionsFromStory(ledger?.story).map((rule) => [rule.ruleId, rule]));
  // Every row saves the whole rule. Two computers with different home folders save under different
  // projects, so after sync one rule can sit in several lists: apply them oldest first, the latest wins.
  const ruleTasks = state.lists.filter((list) => isMyRulesList(list.name)).flatMap((list) => list.tasks)
    .filter((task) => task.name.startsWith(RULE_TASK_PREFIX))
    .sort((a, b) => (a.updatedAtEpoch ?? 0) - (b.updatedAtEpoch ?? 0) || (a.latestEntryId ?? 0) - (b.latestEntryId ?? 0));
  for (const task of ruleTasks) {
    const fields = task.fields;
    const ruleId = text(fields.rule_id) || task.name.slice(RULE_TASK_PREFIX.length);
    const base = rules.get(ruleId) ?? {
      ruleId, scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: '', setBy: 'owner', status: 'on',
      kind: 'directive', source: 'you', timesSeen: 1, latestAt: null, quotes: [], replacedBy: null, replacedAt: null, savedAt: null,
    };
    const scopeTier = RULE_SCOPE_TIERS.includes(fields.scope_tier) ? fields.scope_tier : base.scopeTier;
    const savedQuotes = parseQuoteLines(fields.quotes, base.kind);
    rules.set(ruleId, {
      ...base,
      scopeTier,
      scopeName: scopeTier === 'everywhere' ? 'Everywhere' : text(fields.scope_name) || base.scopeName,
      when: typeof fields.when === 'string' ? fields.when.trim() : base.when,
      then: text(fields.then) || base.then,
      setBy: RULE_SET_BY.includes(fields.set_by) ? fields.set_by : base.setBy,
      status: SAVED_RULE_STATUSES.includes(fields.status) ? fields.status : base.status,
      source: text(fields.source) || base.source,
      timesSeen: count(fields.times_seen) ?? base.timesSeen,
      latestAt: text(fields.latest_at) || base.latestAt,
      quotes: savedQuotes.length ? savedQuotes : base.quotes,
      replacedBy: text(fields.replaced_by) || null,
      replacedAt: text(fields.replaced_at) || null,
      savedAt: task.updatedAt,
    });
  }
  // An owner-written rule that was taken back (dismissed) is gone, not "rejected".
  const shown = [...rules.values()].filter((rule) => rule.then && !(rule.setBy === 'owner' && rule.status === 'dismissed'));
  const scopes = new Map([['everywhere', { id: 'everywhere', tier: 'everywhere', name: 'Everywhere' }]]);
  for (const rule of shown) {
    const id = ruleScopeId(rule.scopeTier, rule.scopeName);
    if (!scopes.has(id)) scopes.set(id, { id, tier: rule.scopeTier, name: rule.scopeName });
  }
  const story = ledger?.story ?? null;
  return {
    rules: shown.map((rule) => ({ ...rule, scopeId: ruleScopeId(rule.scopeTier, rule.scopeName) })),
    ruleScopes: [...scopes.values()].sort((a, b) => RULE_SCOPE_TIERS.indexOf(a.tier) - RULE_SCOPE_TIERS.indexOf(b.tier) || a.name.localeCompare(b.name)),
    rulesLearning: story ? {
      preferencesFound: Array.isArray(story.preferences) ? story.preferences.length : 0,
      newSuggestions: shown.filter((rule) => rule.status === 'suggested').length,
      reviewsRead: Object.keys(ledger.progress ?? {}).length,
      writtenAt: story.writtenAt ?? null,
    } : null,
  };
}

/** The fields one my-rules row saves: the whole rule, so the row reads on its own on every device. */
export function ruleRowFields(rule) {
  const fields = {
    task: ruleTaskName(rule.ruleId), rule_id: rule.ruleId,
    scope_tier: rule.scopeTier, scope_name: rule.scopeTier === 'everywhere' ? 'Everywhere' : rule.scopeName,
    when: rule.when ?? '', then: rule.then, set_by: rule.setBy, status: rule.status, source: rule.source,
    replaced_by: rule.replacedBy ?? null, replaced_at: rule.replacedAt ?? null,
    quotes: quoteLines(rule.quotes ?? []), times_seen: rule.timesSeen ?? 1, latest_at: rule.latestAt ?? null,
  };
  // Keep within one work-state write: drop quotes one at a time until it fits.
  let quotes = (rule.quotes ?? []).slice(0, MAX_QUOTES);
  while (JSON.stringify(fields).length > 2000 && quotes.length) {
    quotes = quotes.slice(0, -1);
    fields.quotes = quoteLines(quotes);
  }
  if (JSON.stringify(fields).length > 2000) throw new RangeError('This rule is too long to save. Shorten it.');
  return fields;
}

/** Strength (§14): times seen × how recent. */
function strength(rule, now) {
  const latest = Date.parse(rule.latestAt ?? '');
  const daysAgo = Number.isFinite(latest) ? Math.max(0, (now - latest) / DAY_MS) : 365;
  return rule.timesSeen / (1 + daysAgo / 7);
}

const SET_BY_ORDER = { owner: 0, approved: 1 };
const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);

/** Rules the owner set or approved that are on, as the Markdown file Claude Code imports. */
export function renderRulesFile(rules, now = Date.now()) {
  const loaded = rules.filter((rule) => rule.status === 'on' && (rule.setBy === 'owner' || rule.setBy === 'approved'));
  const scopes = new Map();
  for (const rule of loaded) {
    const id = ruleScopeId(rule.scopeTier, rule.scopeName);
    if (!scopes.has(id)) scopes.set(id, { tier: rule.scopeTier, name: rule.scopeName, rules: [] });
    scopes.get(id).rules.push(rule);
  }
  const ordered = [...scopes.values()].sort((a, b) => RULE_SCOPE_TIERS.indexOf(a.tier) - RULE_SCOPE_TIERS.indexOf(b.tier) || a.name.localeCompare(b.name));
  const lines = ['# My Rules', '', 'How I want agents to work. Written by claude-mem from the rules I set or approved in My Rules (localhost:37777).'];
  for (const scope of ordered) {
    lines.push('', `## ${scope.tier === 'project' ? `In ${scope.name}` : scope.tier === 'situation' ? scope.name : 'Everywhere'}`, '');
    scope.rules.sort((a, b) => SET_BY_ORDER[a.setBy] - SET_BY_ORDER[b.setBy] || strength(b, now) - strength(a, now));
    for (const rule of scope.rules) lines.push(rule.when ? `- When ${rule.when}: ${lowerFirst(rule.then)}` : `- ${rule.then}`);
  }
  return { markdown: `${lines.join('\n')}\n`, approvedCount: loaded.length };
}
