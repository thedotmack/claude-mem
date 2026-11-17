import { storyInput, type StoryDraft, type StoryInput } from './request-groups.mjs';

/** Leave room for the skill, a checked story draft and a refused answer. This is a UTF-8
 * input budget, not a tokenizer or a claim about any provider's context limit. */
export const STORY_INPUT_BYTES = 256 * 1024;

interface PreferenceEvidence {
  values: Array<Record<string, any>>;
  requests: Array<{ groupId: string; preferences: number[] }>;
}

interface PreferenceComparison {
  values: Array<{ id: number; evidence: Record<string, any> }>;
}

/** Only the overflow path needs separate semantic comparisons. Keep the original
 * values and request references until every comparison finishes, including
 * singletons: a later page can supply their second supporting request. */
export async function boundedStoryPreferences(source: StoryInput, evidence: PreferenceEvidence,
  compare: (input: PreferenceComparison, validate: (answer: unknown) => number[][]) => Promise<number[][]>): Promise<StoryDraft['preferences']> {
  const saved = source.previousStory?.preferences ?? [];
  const values = [...saved, ...evidence.values].map((value, id) => ({ id, evidence: value }));
  const pages: PreferenceComparison['values'][] = [];
  let page: PreferenceComparison['values'] = [];
  for (const value of values) {
    // Two pages must fit together. The item cap also bounds the answer's id list.
    if (page.length && (page.length >= 128 || Buffer.byteLength(JSON.stringify({ values: [...page, value] }, null, 2), 'utf8') > (STORY_INPUT_BYTES - 64) / 2)) {
      pages.push(page); page = [];
    }
    if (Buffer.byteLength(JSON.stringify({ values: [value] }, null, 2), 'utf8') > (STORY_INPUT_BYTES - 64) / 2) {
      throw Object.assign(new Error('A single preference exceeds the comparison input budget. No story was saved and no evidence was skipped.'), { retryable: false, answerRefused: true });
    }
    page.push(value);
  }
  if (page.length) pages.push(page);

  const parent = values.map(value => value.id);
  const root = (id: number): number => {
    while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; }
    return id;
  };
  // Every pair of pages meets. A bounded shortlist or a summary of a singleton
  // could lose the only evidence that matches a later page. For P pages this
  // requires P*(P-1)/2 comparisons (one for a single page), only on overflow.
  for (let left = 0; left < pages.length; left++) {
    for (let right = pages.length === 1 ? left : left + 1; right < pages.length; right++) {
      const input = { values: left === right ? pages[left] : [...pages[left], ...pages[right]] };
      const groups = await compare(input, answer => {
        const groups = (answer as { groups?: unknown })?.groups;
        if (!Array.isArray(groups)) throw new TypeError('Preference comparison needs groups of evidence ids, including singletons.');
        const remaining = new Set(input.values.map(value => value.id));
        for (const group of groups) {
          if (!Array.isArray(group) || !group.length) throw new TypeError('Every preference group must contain at least one evidence id.');
          for (const id of group) {
            if (!Number.isInteger(id) || !remaining.delete(id)) throw new TypeError('Every supplied preference id must occur exactly once; unknown or duplicate ids are refused.');
          }
        }
        if (remaining.size) throw new TypeError('Every supplied preference id must occur exactly once; missing evidence ids are refused.');
        return groups as number[][];
      });
      for (const group of groups) for (const id of group.slice(1)) parent[root(id)] = root(group[0]);
    }
  }

  const groups = new Map<number, number[]>();
  for (const value of values) {
    const id = root(value.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(value.id);
  }
  const requests = new Map<number, Set<string>>();
  for (const request of evidence.requests) for (const index of request.preferences) {
    const id = root(saved.length + index);
    if (!requests.has(id)) requests.set(id, new Set());
    requests.get(id)!.add(request.groupId);
  }
  return [...groups.entries()].map(([id, members]) => {
    const previous = members.filter(index => index < saved.length).map(index => saved[index]);
    const support = requests.get(id)?.size ?? 0;
    // Saved counts have no request ids. Adding them would count re-reviewed
    // requests again; retain the known lower bound instead.
    const supportCount = Math.max(support, ...previous.map(value => value.supportCount ?? 1));
    const quotes = new Map<string, { quote: string; at: string | null }>();
    for (const index of members) {
      const value = values[index].evidence;
      for (const quote of index < saved.length ? value.quotes ?? [] : [{ quote: value.quote, at: value.at ?? null }]) {
        quotes.set(JSON.stringify(quote), quote);
      }
    }
    const first = values[members[0]].evidence;
    return { preference: first.preference, kind: first.kind, supportCount,
      quotes: [...quotes.values()].slice(0, 3), keep: previous.length > 0 || support >= 2 };
  }).filter(value => value.keep).sort((a, b) => b.supportCount - a.supportCount).slice(0, 30)
    .map(({ keep: _keep, ...preference }) => preference);
}

/** Retain every preference and its request, including one-off statements that can
 * match a differently worded statement in another narrative batch. Intern exact
 * repeats to avoid copying the same quote repeatedly; no evidence is summarized. */
export function storyPreferenceEvidence(source: StoryInput): PreferenceEvidence {
  const values: PreferenceEvidence['values'] = [], requests: PreferenceEvidence['requests'] = [];
  const indices = new Map<string, number>();
  for (const review of source.reviews) {
    const preferences = new Set<number>();
    for (const preference of review.preferences ?? []) {
      const key = JSON.stringify(preference);
      let index = indices.get(key);
      if (index === undefined) { index = values.length; indices.set(key, index); values.push(preference); }
      preferences.add(index);
    }
    if (preferences.size) requests.push({ groupId: review.groupId, preferences: [...preferences] });
  }
  return { values, requests };
}

/** A complete prefix of the remaining reviews, including the current draft's story budgets.
 * No review is truncated or dropped. The byte accounting matches writeInput's pretty JSON. */
export function nextStoryBatch(source: StoryInput, offset: number, previous: StoryInput['previousStory'],
  preferenceEvidence: PreferenceEvidence | null): StoryInput & { preferenceEvidence?: PreferenceEvidence } {
  // Narrative drafts accumulate; preferences are always reconciled from the full
  // snapshot and the saved story, not counted again from an intermediate draft.
  const baseline = previous && { ...previous, preferences: preferenceEvidence ? source.previousStory?.preferences ?? [] : [] };
  const input = { ...storyInput(source.groups, [], baseline), ...(preferenceEvidence ? { preferenceEvidence } : {}) };
  let bytes = Buffer.byteLength(JSON.stringify(input, null, 2), 'utf8');
  if (bytes >= STORY_INPUT_BYTES) {
    throw Object.assign(new Error('The complete preference evidence and checked draft exceed the story input budget. No story was saved and no review was skipped.'), { retryable: false, answerRefused: true });
  }
  for (let index = offset; index < source.reviews.length; index++) {
    const { preferences: _preferences, ...review } = source.reviews[index];
    const encoded = JSON.stringify(review, null, 2).replace(/^/gm, '    ');
    // The first item opens/closes the nonempty array; later ones add a comma/newline.
    const added = Buffer.byteLength(encoded, 'utf8') + (input.reviews.length ? 2 : 4);
    if (bytes + added > STORY_INPUT_BYTES) break;
    input.reviews.push(review);
    bytes += added;
  }
  if (!input.reviews.length) {
    throw Object.assign(new Error('A story review and its checked draft exceed the input budget. No story was saved and no review was skipped.'), { retryable: false, answerRefused: true });
  }
  return input;
}
