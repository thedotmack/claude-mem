export const MY_RULES_LIST: 'my-rules';
/** Who set a saved rule, every value the worker records. */
export const RULE_SET_BY: readonly SavedRule['setBy'][];
/** Every status a saved rule can have. */
export const SAVED_RULE_STATUSES: readonly SavedRule['status'][];
export function isMyRulesList(name: unknown): boolean;
export function ruleIdForPreference(preference: string): string;
export interface SavedRule {
  ruleId: string; scopeId: string; scopeTier: 'everywhere' | 'project' | 'situation'; scopeName: string;
  when: string; then: string; setBy: 'owner' | 'approved' | 'learned';
  status: 'on' | 'off' | 'suggested' | 'replaced' | 'dismissed'; kind: string; source: string;
  timesSeen: number; latestAt: string | null; quotes: { at: string | null; quote: string; kind: string }[];
  /** Known quote count before saving, retained when a device only has a partial row. */
  quotesTotal?: number;
  /** Quotes omitted from the saved row, even if the local story still supplies them. */
  quotesOmitted?: number;
  replacedBy: string | null; replacedAt: string | null; savedAt: string | null;
}
export function ruleRowFields(rule: Omit<SavedRule, 'scopeId' | 'kind' | 'savedAt'>): Record<string, string | number | null>;
/** `importLine` (an `@path` line) is appended after the rules, so Claude Code loads that file with them. */
export function renderRulesFile(rules: SavedRule[], now?: number, options?: { importLine?: string }): { markdown: string; approvedCount: number };
