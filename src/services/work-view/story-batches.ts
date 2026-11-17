import { storyInput, type StoryInput } from './request-groups.mjs';

/** Leave room for the skill, a checked story draft and a refused answer. This is a UTF-8
 * input budget, not a tokenizer or a claim about any provider's context limit. */
export const STORY_INPUT_BYTES = 256 * 1024;

interface PreferenceEvidence {
  values: Array<Record<string, any>>;
  requests: Array<{ groupId: string; preferences: number[] }>;
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
  preferenceEvidence: PreferenceEvidence): StoryInput & { preferenceEvidence: PreferenceEvidence } {
  // Narrative drafts accumulate; preferences are always reconciled from the full
  // snapshot and the saved story, not counted again from an intermediate draft.
  const baseline = previous && { ...previous, preferences: source.previousStory?.preferences ?? [] };
  const input = { ...storyInput(source.groups, [], baseline), preferenceEvidence };
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
