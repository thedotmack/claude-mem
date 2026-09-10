/**
 * Closed-set skill identity for skill_invoked telemetry.
 *
 * First-party ids are pinned to plugin/skills/<name>/. Sibling copies of the
 * same skill (cursor / cowork / grok-bot mem-search) collapse to that one
 * id. Third-party names never leave the machine — they become skill_id other
 * with skill_source third_party.
 *
 * Pure module: no I/O, never throws, never returns caller-supplied free text.
 */

export const FIRST_PARTY_SKILL_IDS = [
  'babysit',
  'ccs-align',
  'cloud-sync',
  'design-is',
  'do',
  'how-it-works',
  'knowledge-agent',
  'learn-codebase',
  'make-plan',
  'mem-search',
  'mode-creator',
  'oh-my-issues',
  'pathfinder',
  'smart-explore',
  'standup',
  'timeline-report',
  'version-bump',
  'weekly-digests',
  'what-the',
  'wowerpoint',
] as const;

export type FirstPartySkillId = (typeof FIRST_PARTY_SKILL_IDS)[number];
export type SkillId = FirstPartySkillId | 'other';
export type SkillSource = 'first_party' | 'third_party';
export type SkillTrigger = 'tool' | 'prompt';

export type SkillClassification = {
  skill_id: SkillId;
  skill_source: SkillSource;
};

const FIRST_PARTY_SKILL_ID_SET: ReadonlySet<string> = new Set(FIRST_PARTY_SKILL_IDS);

const OTHER_SKILL: SkillClassification = {
  skill_id: 'other',
  skill_source: 'third_party',
};

/**
 * Normalize a host-supplied skill token to a closed allowlist id.
 *
 * - Non-strings / empty → other + third_party
 * - Trim + lowercase
 * - Strip a leading `/` so slash tokens and Skill names share a path
 * - If the token contains `:`, keep the last segment (`claude-mem:mem-search`
 *   and `cowork:mem-search` both become `mem-search`)
 * - Never return the original string
 */
export function classifySkillId(raw: unknown): SkillClassification {
  const token = normalizeSkillToken(raw);
  if (!token) return OTHER_SKILL;
  if (FIRST_PARTY_SKILL_ID_SET.has(token)) {
    return { skill_id: token as FirstPartySkillId, skill_source: 'first_party' };
  }
  return OTHER_SKILL;
}

/**
 * Skill tool hosts put the skill name on `tool_input.skill`. Anything else
 * (including SlashCommand) is out of scope here — slash mapping is
 * `firstPartySkillFromSlashPrompt`.
 */
export function skillNameFromToolInput(toolName: string, toolInput: unknown): unknown {
  if (toolName !== 'Skill') return undefined;
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  return (toolInput as { skill?: unknown }).skill;
}

/**
 * Leading `/token` of a user prompt, only when it is a first-party skill.
 * Unknown `/foo` returns null so the session-init path emits nothing (and
 * never a third-party name). The rest of the prompt is ignored.
 */
export function firstPartySkillFromSlashPrompt(prompt: unknown): FirstPartySkillId | null {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const token = trimmed.split(/\s/, 1)[0] ?? '';
  const classified = classifySkillId(token);
  if (classified.skill_source !== 'first_party') return null;
  return classified.skill_id as FirstPartySkillId;
}

function normalizeSkillToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let token = raw.trim().toLowerCase();
  if (!token) return null;
  token = token.replace(/^\/+/, '');
  const colon = token.lastIndexOf(':');
  if (colon !== -1) {
    token = token.slice(colon + 1).replace(/^\/+/, '');
  }
  return token || null;
}
