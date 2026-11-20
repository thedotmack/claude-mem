import type { ReactNode } from 'react'

/**
 * Puts a node where a translated sentence has its `{slot}`, so a time, a command or a control can sit inside the
 * sentence and each language keeps its own word order. The one helper for this: the refresh line, the ticker and the
 * Sort label use it.
 */
export function sentenceWith(sentence: string, slot: string, node: ReactNode): ReactNode {
  const [before, after = ''] = sentence.split(`{${slot}}`)
  return <>{before}{node}{after}</>
}
