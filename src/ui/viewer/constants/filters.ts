/**
 * Filter constants for the viewer search and filter UI
 */
export const OBSERVATION_TYPES = [
  'bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision'
] as const;

export const OBSERVATION_CONCEPTS = [
  'how-it-works', 'why-it-exists', 'what-changed',
  'problem-solution', 'gotcha', 'pattern', 'trade-off'
] as const;

export const OBSERVATION_PRIORITIES = [
  'critical', 'important', 'informational'
] as const;

export const ITEM_KINDS = [
  'observations', 'sessions', 'prompts'
] as const;

export const ITEM_KIND_LABELS: Record<typeof ITEM_KINDS[number], string> = {
  observations: 'Observations',
  sessions: 'Summaries',
  prompts: 'Prompts',
};
