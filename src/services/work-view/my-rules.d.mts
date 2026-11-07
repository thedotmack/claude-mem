export const MY_RULES_LIST: 'my-rules';
export function isMyRulesList(name: unknown): boolean;
export function ruleIdForPreference(preference: string): string;
export interface SavedRule {
  ruleId: string; scopeId: string; scopeTier: 'everywhere' | 'project' | 'situation'; scopeName: string;
  when: string; then: string; setBy: 'owner' | 'approved' | 'learned';
  status: 'on' | 'off' | 'suggested' | 'replaced' | 'dismissed'; kind: string; source: string;
  timesSeen: number; latestAt: string | null; quotes: { at: string | null; quote: string; kind: string }[];
  replacedBy: string | null; replacedAt: string | null; savedAt: string | null;
}
export function ruleRowFields(rule: Omit<SavedRule, 'scopeId' | 'kind' | 'savedAt'>): Record<string, string | number | null>;
export function renderRulesFile(rules: SavedRule[], now?: number): { markdown: string; approvedCount: number };
