import { storyInput, type StoryInput } from './request-groups.mjs';

/** Leave room for the skill, a checked story draft and a refused answer. This is a UTF-8
 * input budget, not a tokenizer or a claim about any provider's context limit. */
export const STORY_INPUT_BYTES = 256 * 1024;

/** A complete prefix of the remaining reviews, including the current draft's story budgets.
 * No review is truncated or dropped. The byte accounting matches writeInput's pretty JSON. */
export function nextStoryBatch(source: StoryInput, offset: number, previous: StoryInput['previousStory']): StoryInput {
  const input = storyInput(source.groups, [], previous);
  let bytes = Buffer.byteLength(JSON.stringify(input, null, 2), 'utf8');
  for (let index = offset; index < source.reviews.length; index++) {
    const review = source.reviews[index];
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
