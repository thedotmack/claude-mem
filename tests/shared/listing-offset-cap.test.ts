import { describe, expect, it } from 'bun:test';
import { LISTING_OFFSET_CAP_MESSAGE, MAX_LISTING_OFFSET, listingOffsetCapMessage } from '../../src/shared/listing-offset-cap.js';

// The cap decision was re-derived by each listing plane, and one plane (the
// advisor feed) forgot it. Pin the shared decision so the constant, the
// comparison and the message cannot drift apart again.
describe('listingOffsetCapMessage', () => {
  it('serves any offset up to and including the cap', () => {
    expect(listingOffsetCapMessage(undefined)).toBeNull();
    expect(listingOffsetCapMessage(0)).toBeNull();
    expect(listingOffsetCapMessage(MAX_LISTING_OFFSET)).toBeNull();
  });

  it('reports the shared message above the cap', () => {
    expect(listingOffsetCapMessage(MAX_LISTING_OFFSET + 1)).toBe(LISTING_OFFSET_CAP_MESSAGE);
    expect(listingOffsetCapMessage(Number.MAX_SAFE_INTEGER)).toBe(LISTING_OFFSET_CAP_MESSAGE);
  });

  it('honors a plane-specific cap', () => {
    expect(listingOffsetCapMessage(11, 10)).toBe(LISTING_OFFSET_CAP_MESSAGE);
    expect(listingOffsetCapMessage(10, 10)).toBeNull();
  });

  it('does not cap a value the caller has not normalized', () => {
    // Callers normalize first (absent → 0, garbage → 0); a non-finite value is
    // their defect to fix, not a reason to claim the offset was capped.
    expect(listingOffsetCapMessage(Number.NaN)).toBeNull();
  });
});