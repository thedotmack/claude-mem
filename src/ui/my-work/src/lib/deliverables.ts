import type { Request, WorkProductKind } from '../data.ts'

type Product = Request['workProduct'][number]

// Relative import with the .ts extension, like src/live: the mapper test loads this under node --test, which has no path alias.
/**
 * What the front of a card links (R5.12): the things a person opens — bucket
 * copies claude-mem kept, published pages, decks and documents, pull
 * requests. Commits and branches are history, so they stay in the drawer.
 */
export function isCardDeliverable(product: Product): boolean {
  return product.deliverable === true || !['Commit', 'Branch'].includes(product.kind)
}

/** The parts of a GitHub address that name a pull request or a commit: owner, repository, then the number or the sha. */
const GITHUB_PULL_REQUEST = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/
const GITHUB_COMMIT = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/commit\/([0-9a-f]{7,40})/
/** The digits a commit is known by in git's own short form. */
const SHORT_SHA_LENGTH = 7

/**
 * The name a deliverable shows (c-request-card-deliverables M, c-bits-product-link F: "PR · claude-mem #6229", where
 * the recorded title was only "github.com"). The recorded title, unless it only repeats its address's host; then the
 * address names it where it can (a GitHub pull request or commit), and otherwise the title stays. Real names only where
 * the data has them: nothing is made up.
 */
export function deliverableName(product: Pick<Product, 'label' | 'href'>): string {
  const host = product.href ? /^https?:\/\/([^/?#]+)/.exec(product.href)?.[1] : undefined
  if (!host || (product.label !== host && product.label !== host.replace(/^www\./, ''))) return product.label
  const pullRequest = GITHUB_PULL_REQUEST.exec(product.href ?? '')
  if (pullRequest) return `${pullRequest[1]} #${pullRequest[2]}`
  const commit = GITHUB_COMMIT.exec(product.href ?? '')
  if (commit) return `${commit[1]} @${commit[2].slice(0, SHORT_SHA_LENGTH)}`
  return product.label
}

/**
 * The drawer's deliverable filters (c-bits-product-link M: All, Docs and pages, Code), one per kind. A plain link is
 * something to open and read, so it sits with docs and pages (the review leaves that open).
 */
export type DeliverableGroup = 'docs-and-pages' | 'code'
export const DELIVERABLE_GROUP: Record<WorkProductKind, DeliverableGroup> = {
  PR: 'code', Commit: 'code', Branch: 'code', Page: 'docs-and-pages', Deck: 'docs-and-pages', Doc: 'docs-and-pages', File: 'docs-and-pages', Link: 'docs-and-pages',
}

/**
 * Things a person opens come first (c-bits-product-link M; commits and the branch filled the first screen): first
 * what has somewhere to open, in this order of kinds, then what has not; commits last, where the list folds them into
 * one row. Equal items keep their recorded order.
 */
const OPENING_ORDER: Record<WorkProductKind, number> = { PR: 0, Page: 1, Deck: 2, Doc: 3, File: 4, Link: 5, Branch: 6, Commit: 7 }

export function deliverablesInOpeningOrder<T extends Pick<Product, 'kind' | 'href'>>(products: readonly T[]): T[] {
  const rank = (product: T) => [product.kind === 'Commit' ? 1 : 0, product.href ? 0 : 1, OPENING_ORDER[product.kind]]
  return products
    .map((product, index) => ({ product, index, rank: rank(product) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || a.index - b.index)
    .map(({ product }) => product)
}
