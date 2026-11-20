// Whether display text repeats the owner's own words. My Work shows such text freely, but a shared page never
// carries it (R17.5): a request's first title can be its opening prompt's first sentence (request-judge.mjs
// ownTitle), and an ask or a goal can echo the quotes behind it.

const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** True when `text`, cut marks, case, punctuation and markdown aside, appears inside any of `words`. */
export function repeatsOwnerWords(text: string, words: readonly string[]): boolean {
  const wanted = plain(text.replace(/…$/, ''))
  return !!wanted && words.some((said) => plain(said).includes(wanted))
}
