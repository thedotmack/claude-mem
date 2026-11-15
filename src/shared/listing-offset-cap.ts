/**
 * The deepest `offset` a listing route serves, on both planes: the worker's
 * SQLite feeds (DataRoutes), the server's viewer feeds (ServerViewerRoutes)
 * and the /v1 jobs listings (ServerV1PostgresRoutes). OFFSET is parameterized,
 * so a large value is not injection; it is one read-scoped request making the
 * database scan and discard that many rows on a shared connection. Rows past
 * it are reachable only through a filter that narrows the listing; a keyset
 * cursor would lift the cap, and none exists yet.
 */
export const MAX_LISTING_OFFSET = 10_000;

/**
 * The largest `limit` a listing or search route serves in one request, on both
 * planes: the worker's SQLite feeds (DataRoutes) and its search routes
 * (SearchRoutes). A request above it is clamped, not rejected: the caller asked
 * for more than a page and gets a full page, while one request can no longer
 * point SQLite at a whole table. The feeds enforce it today; the search routes
 * did not, so `?limit=999999999` there scanned every row before slicing.
 */
export const MAX_LISTING_LIMIT = 100;

/** The 400 message for an `offset` above MAX_LISTING_OFFSET. */
export const LISTING_OFFSET_CAP_MESSAGE =
  `offset must be at most ${MAX_LISTING_OFFSET}; narrow the listing with filters to reach older rows`;

export type OffsetCappedPage<P extends { hasMore: boolean }> =
  P | (P & { hasMore: false; offsetCapReached: true; maxOffset: number });

/**
 * A page whose next offset (`offset + limit`) would pass MAX_LISTING_OFFSET
 * says so with `offsetCapReached` instead of `hasMore`: the route rejects that
 * next request, so a viewer that kept paging would end on an error it cannot
 * retry. The viewer reads this through `offsetCapOf` and shows that the list
 * stops at the newest MAX_LISTING_OFFSET items.
 */
export function capListingPage<P extends { hasMore: boolean }>(page: P, offset: number, limit: number): OffsetCappedPage<P> {
  if (page.hasMore && offset + limit > MAX_LISTING_OFFSET) {
    return { ...page, hasMore: false, offsetCapReached: true, maxOffset: MAX_LISTING_OFFSET };
  }
  return page;
}
