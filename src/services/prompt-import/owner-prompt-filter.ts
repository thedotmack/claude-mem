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
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function opensInLowercase(text: string): boolean {
  const first = text.slice(0, 1);
  return first !== '' && first === first.toLowerCase() && first !== first.toUpperCase();
}

/** The fingerprint to look for in agent text, or null when the prompt is not checked that way. */
export function provenanceFingerprint(promptText: string): string | null {
  const normalized = normalize(promptText);
  // Agents do not open a prompt in lowercase; the owner usually does, so those are kept.
  if (normalized.length < MINIMUM_CHECKABLE_LENGTH || opensInLowercase(promptText)) return null;
  // Only the opening counts: the owner often types a line and then pastes an agent's report below it.
  return normalized.slice(0, FINGERPRINT_LENGTH);
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
      if (fingerprint.length !== FINGERPRINT_LENGTH || this.earliest.has(fingerprint)) continue;
      this.earliest.set(fingerprint, Number.POSITIVE_INFINITY);
      let hash = 0;
      for (let index = 0; index < fingerprint.length; index++) hash = charHashStep(hash, fingerprint.charCodeAt(index));
      const bucket = this.byHash.get(hash);
      if (bucket) bucket.push(fingerprint); else this.byHash.set(hash, [fingerprint]);
    }
    for (let index = 0; index < FINGERPRINT_LENGTH - 1; index++) this.highPower = Math.imul(this.highPower, HASH_BASE) >>> 0;
  }

  get empty(): boolean { return this.earliest.size === 0; }

  /** One piece of agent-authored text, written at `epochSeconds`. */
  add(epochSeconds: number, rawText: string): void {
    if (this.empty || rawText.length < FINGERPRINT_LENGTH) return;
    const chunk = normalize(rawText);
    if (chunk.length < FINGERPRINT_LENGTH) return;
    let hash = 0;
    for (let index = 0; index < FINGERPRINT_LENGTH; index++) hash = charHashStep(hash, chunk.charCodeAt(index));
    for (let start = 0; ; start++) {
      const bucket = this.byHash.get(hash);
      if (bucket) {
        for (const fingerprint of bucket) {
          if (epochSeconds < this.earliest.get(fingerprint)! && chunk.startsWith(fingerprint, start)) {
            this.earliest.set(fingerprint, epochSeconds);
          }
        }
      }
      const next = start + FINGERPRINT_LENGTH;
      if (next >= chunk.length) break;
      const outgoing = Math.imul(chunk.charCodeAt(start), this.highPower) >>> 0;
      hash = charHashStep((hash - outgoing) >>> 0, chunk.charCodeAt(next));
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
