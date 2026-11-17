import { storyInput, type StoryDraft, type StoryInput } from './request-groups.mjs';
import { storyFingerprint, validateCanonicalPreferenceKey, type CanonicalPreferenceKey, type PreferenceProvenance } from './story-cache.js';

/** Leave room for the skill, a checked story draft and a refused answer. This is a UTF-8
 * input budget, not a tokenizer or a claim about any provider's context limit. */
export const STORY_INPUT_BYTES = 256 * 1024;

export interface PreferenceEvidence {
  values: Array<Record<string, any>>;
  /** Include reviewed requests with no preferences, so a withdrawn preference loses its old vote. */
  requests: Array<{ groupId: string; preferences: number[] }>;
}

export interface PreferenceComparison {
  values: Array<{ id: number; evidence: Record<string, any> }>;
}

export interface PreferenceAssignment { id: number; key: CanonicalPreferenceKey }

export interface PreferenceOptions {
  /** The caller scopes this checked cache to the canonicalization contract. */
  canonical?: Record<string, CanonicalPreferenceKey>;
  saveCanonical?: (entries: Record<string, CanonicalPreferenceKey>) => void;
  previous?: PreferenceProvenance[];
}

/** Canonicalize every distinct complete value, including singletons, in bounded pages.
 * Equal complete semantic keys join across all pages; different conditions or polarities
 * stay separate. The model must assign keys independently of page membership. This is a
 * semantic indexing contract, not a guarantee that every possible paraphrase is recalled. */
export async function boundedStoryPreferences(source: StoryInput, evidence: PreferenceEvidence,
  canonicalize: (input: PreferenceComparison, validate: (answer: unknown) => PreferenceAssignment[]) => Promise<PreferenceAssignment[]>,
  options: PreferenceOptions = {}): Promise<{ preferences: StoryDraft['preferences']; provenance: PreferenceProvenance[] }> {
  const saved = source.previousStory?.preferences ?? [];
  const values = [...saved, ...evidence.values].map((value, id) => ({ id, evidence: value }));
  const reviewed = new Set<string>();
  for (const request of evidence.requests) {
    if (typeof request.groupId !== 'string' || !request.groupId) throw new TypeError('Preference evidence needs a request id.');
    reviewed.add(request.groupId);
    for (const index of request.preferences) {
      if (!Number.isInteger(index) || index < 0 || index >= evidence.values.length) throw new TypeError('Preference request references an unknown evidence index.');
    }
  }
  const hashes = values.map(value => storyFingerprint(value.evidence));
  let canonical: Record<string, CanonicalPreferenceKey> = { ...options.canonical };
  const pages: PreferenceComparison['values'][] = [];
  let page: PreferenceComparison['values'] = [];
  const emptyBytes = Buffer.byteLength(JSON.stringify({ values: [] }, null, 2), 'utf8');
  let pageBytes = emptyBytes;
  const pending = new Set<string>();
  for (const value of values) {
    const hash = hashes[value.id];
    if (Object.hasOwn(canonical, hash)) {
      canonical[hash] = validateCanonicalPreferenceKey(canonical[hash]);
      continue;
    }
    if (pending.has(hash)) continue;
    pending.add(hash);
    const itemBytes = Buffer.byteLength(JSON.stringify(value, null, 2).replace(/^/gm, '    '), 'utf8');
    if (emptyBytes + itemBytes + 4 > STORY_INPUT_BYTES) {
      throw Object.assign(new Error('A single preference exceeds the canonicalization input budget. No story was saved and no evidence was skipped.'), { retryable: false, answerRefused: true });
    }
    if (page.length && (page.length >= 64 || pageBytes + itemBytes + 2 > STORY_INPUT_BYTES)) {
      pages.push(page); page = []; pageBytes = emptyBytes;
    }
    pageBytes += itemBytes + (page.length ? 2 : 4);
    page.push(value);
  }
  if (page.length) pages.push(page);

  for (const page of pages) {
    const input = { values: page };
    const validate = (answer: unknown): PreferenceAssignment[] => {
      const assignments = (answer as { assignments?: unknown } | null)?.assignments;
      if (!Array.isArray(assignments)) throw new TypeError('Preference canonicalization needs assignments for every evidence id, including singletons.');
      const remaining = new Set(page.map(value => value.id));
      const checked = assignments.map(assignment => {
        if (assignment === null || typeof assignment !== 'object' || Array.isArray(assignment)
          || !Number.isInteger(assignment.id) || !remaining.delete(assignment.id)) {
          throw new TypeError('Every supplied preference id must occur exactly once; unknown or duplicate ids are refused.');
        }
        return { id: assignment.id, key: validateCanonicalPreferenceKey(assignment.key) };
      });
      if (remaining.size) throw new TypeError('Every supplied preference id must occur exactly once; missing evidence ids are refused.');
      return checked;
    };
    const checked = validate({ assignments: await canonicalize(input, validate) });
    const next = { ...canonical };
    for (const assignment of checked) next[hashes[assignment.id]] = assignment.key;
    // A failed write must not make an answer look durably checked to this invocation.
    await options.saveCanonical?.(next);
    canonical = next;
  }

  const groups = new Map<string, number[]>();
  const groupKeys = values.map(value => storyFingerprint(canonical[hashes[value.id]]));
  for (const value of values) {
    const key = groupKeys[value.id];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(value.id);
  }
  const proofs = new Map<string, PreferenceProvenance[]>();
  for (const previous of options.previous ?? []) {
    const hash = storyFingerprint(previous.preference);
    if (!proofs.has(hash)) proofs.set(hash, []);
    proofs.get(hash)!.push(previous);
  }
  const requests = new Map<string, Set<string>>();
  for (const request of evidence.requests) for (const index of request.preferences) {
    const key = groupKeys[saved.length + index];
    if (!requests.has(key)) requests.set(key, new Set());
    requests.get(key)!.add(request.groupId);
  }
  const resolved = [...groups.entries()].map(([key, members]) => {
    const savedMembers = members.filter(index => index < saved.length);
    const requestIds = new Set(requests.get(key));
    let legacySupportCount = 0;
    for (const index of savedMembers) {
      const matched = proofs.get(hashes[index]);
      if (matched?.length) {
        for (const proof of matched) {
          for (const id of proof.requestIds) if (!reviewed.has(id)) requestIds.add(id);
          legacySupportCount = Math.max(legacySupportCount, proof.legacySupportCount ?? 0);
        }
      } else {
        // Old stories did not record request ids. Do not invent them or add an
        // anonymous count to requests that might already be included in it.
        legacySupportCount = Math.max(legacySupportCount, saved[index].supportCount ?? 1);
      }
    }
    const supportCount = Math.max(requestIds.size, legacySupportCount);
    const quotes = new Map<string, { quote: string; at: string | null }>();
    for (const index of members) {
      const value = values[index].evidence;
      for (const quote of index < saved.length ? value.quotes ?? [] : [{ quote: value.quote, at: value.at ?? null }]) {
        quotes.set(storyFingerprint(quote), quote);
      }
    }
    const first = values[members[0]].evidence;
    const preference = { preference: first.preference, kind: first.kind, supportCount, quotes: [...quotes.values()].slice(0, 3) };
    const provenance: PreferenceProvenance = { preference, requestIds: [...requestIds].sort(),
      ...(legacySupportCount ? { legacySupportCount } : {}) };
    return { preference, provenance, keep: savedMembers.length > 0 || supportCount >= 2 };
  }).filter(value => value.preference.supportCount > 0);
  const selected = resolved.filter(value => value.keep).sort((a, b) => b.preference.supportCount - a.preference.supportCount).slice(0, 30);
  return {
    preferences: selected.map(value => value.preference),
    provenance: selected.map(value => value.provenance),
  };
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
    requests.push({ groupId: review.groupId, preferences: [...preferences] });
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
