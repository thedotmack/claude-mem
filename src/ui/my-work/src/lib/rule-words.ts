// A rule's words for people, said one way wherever a rule is listed: My Rules and Find work.
import { interpolate } from '@/lib/i18n'
import type { OwnerRule, RuleScope } from '@/data-rules'
import type { Translate } from '@/components/bits'

/** "When the work is a plan: keep it…" reads as one sentence, so its second half starts lower case. */
export const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** A rule as one line: "When {when}: {then}", or its then alone where no when was recorded. */
export const ruleLineWords = (rule: Pick<OwnerRule, 'when' | 'then'>, t: Translate) => rule.when.trim()
  ? interpolate(t('When {when}: {then}'), { when: rule.when.trim(), then: lowerFirst(rule.then.trim()) })
  : rule.then.trim()

/** Where a rule applies: Everywhere, "In {repo}", or the situation's own name. */
export const ruleScopeWords = (scope: RuleScope, t: Translate) => scope.tier === 'everywhere' ? t('Everywhere')
  : scope.tier === 'project' ? interpolate(t('In {name}'), { name: scope.name }) : scope.name
