/**
 * Which typed prompts an agent wrote first. A line-by-line port of
 * `plugin/skills/owner-goals/scripts/export_owner_prompts.py` (`normalize`,
 * `is_agent_written`), so the setup import and the owner-goals skill leave out
 * the same prompts.
 *
 * A prompt counts as agent-written when its opening text appears earlier in
 * agent-authored text, or when it opens with a role assignment ("You are the/a/...",
 * "Task: ", "Branch: ") and runs over 400 characters. Prompts that open in
 * lowercase are kept.
 *
 * The Python version keeps every agent chunk in memory. Full transcript
 * histories run to gigabytes, so this version finds the earliest agent chunk
 * containing each prompt's fingerprint in one streaming pass (rolling hash over
 * every position, verified by direct comparison). The answer is the same:
 * "some chunk before the prompt contains the fingerprint" is "the earliest such
 * chunk is before the prompt".
 */

export const MINIMUM_CHECKABLE_LENGTH = 160;
export const FINGERPRINT_LENGTH = 120;
const ROLE_ASSIGNMENT_OPENING = /^(You are (the|a|an|one|on|in) |Task: |Branch: )/;

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function opensInLowercase(text: string): boolean {
  return /^\p{Lowercase}/u.test(text);
}

/** The fingerprint to look for in agent text, or null when the prompt is not checked that way. */
export function provenanceFingerprint(promptText: string): string | null {
  // Agents do not open a prompt in lowercase; the owner usually does, so those are kept.
  if (opensInLowercase(promptText)) return null;
  const normalized = normalize(promptText);
  if (normalized.length < MINIMUM_CHECKABLE_LENGTH) return null;
  // Match Python's character counts, including letters outside the BMP. Keep the UTF-16 offset only for slicing.
  // Only the opening counts: the owner often types a line and then pastes an agent's report below it.
  let characters = 0, offset = 0, fingerprintEnd = 0;
  for (const character of normalized) {
    offset += character.length;
    if (++characters === FINGERPRINT_LENGTH) fingerprintEnd = offset;
    if (characters === MINIMUM_CHECKABLE_LENGTH) return normalized.slice(0, fingerprintEnd);
  }
  return null;
}

/** Launchers that hand a prompt over through a file leave no copy in any transcript; those prompts open by assigning the agent a role. */
export function opensWithRoleAssignment(promptText: string): boolean {
  return ROLE_ASSIGNMENT_OPENING.test(promptText) && promptText.length > 400;
}

const HASH_BASE = 1_000_003;
function charHashStep(hash: number, code: number): number {
  return (Math.imul(hash, HASH_BASE) + code) >>> 0;
}

/**
 * Collects agent-authored text and remembers, per fingerprint, the earliest
 * second it was seen. Chunks are normalized here; the caller passes raw text.
 */
export class AgentTextIndex {
  private byHash = new Map<number, string[]>();
  private earliest = new Map<string, number>();
  private highPower = 1;

  constructor(fingerprints: Iterable<string>) {
    for (const fingerprint of fingerprints) {
      if (fingerprint.length < FINGERPRINT_LENGTH || fingerprint.length > 2 * FINGERPRINT_LENGTH || this.earliest.has(fingerprint)) continue;
      let hash = 0, characters = 0;
      for (const character of fingerprint) { hash = charHashStep(hash, character.codePointAt(0)!); characters++; }
      if (characters !== FINGERPRINT_LENGTH) continue;
      this.earliest.set(fingerprint, Number.POSITIVE_INFINITY);
      const bucket = this.byHash.get(hash);
      if (bucket) bucket.push(fingerprint); else this.byHash.set(hash, [fingerprint]);
    }
    for (let index = 0; index < FINGERPRINT_LENGTH - 1; index++) this.highPower = Math.imul(this.highPower, HASH_BASE) >>> 0;
  }

  get empty(): boolean { return this.earliest.size === 0; }

  /** One piece of agent-authored text, written at `epochSeconds`. */
  add(epochSeconds: number, rawText: string): void {
    if (this.empty) return;
    const chunk = normalize(rawText);
    if (chunk.length < FINGERPRINT_LENGTH) return;
    let hash = 0, characters = 0, next = 0, start = 0;
    while (characters < FINGERPRINT_LENGTH && next < chunk.length) {
      const code = chunk.codePointAt(next)!;
      hash = charHashStep(hash, code);
      next += code > 0xffff ? 2 : 1;
      characters++;
    }
    if (characters < FINGERPRINT_LENGTH) return;
    for (;;) {
      const bucket = this.byHash.get(hash);
      if (bucket) {
        for (const fingerprint of bucket) {
          if (epochSeconds < this.earliest.get(fingerprint)! && chunk.startsWith(fingerprint, start)) {
            this.earliest.set(fingerprint, epochSeconds);
          }
        }
      }
      if (next >= chunk.length) break;
      const first = chunk.codePointAt(start)!, last = chunk.codePointAt(next)!;
      const outgoing = Math.imul(first, this.highPower) >>> 0;
      hash = charHashStep((hash - outgoing) >>> 0, last);
      start += first > 0xffff ? 2 : 1;
      next += last > 0xffff ? 2 : 1;
    }
  }

  earliestSecond(fingerprint: string): number {
    return this.earliest.get(fingerprint) ?? Number.POSITIVE_INFINITY;
  }
}

/** `is_agent_written`, given the index built from all agent text. */
export function isAgentWritten(promptEpochSeconds: number, promptText: string, agentText: AgentTextIndex): boolean {
  const fingerprint = provenanceFingerprint(promptText);
  if (fingerprint && agentText.earliestSecond(fingerprint) < promptEpochSeconds) return true;
  return opensWithRoleAssignment(promptText);
}
