import type { Request } from '../data.ts'

// Relative import with the .ts extension, like src/live: the mapper test loads this under node --test, which has no path alias.
/**
 * What the front of a card links (R5.12): the things a person opens — bucket
 * copies claude-mem kept, published pages, decks and documents, pull
 * requests. Commits and branches are history, so they stay in the drawer.
 */
export function isCardDeliverable(product: Request['workProduct'][number]): boolean {
  return product.deliverable === true || !['Commit', 'Branch'].includes(product.kind)
}
