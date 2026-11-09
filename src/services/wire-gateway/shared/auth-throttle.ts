// SPDX-License-Identifier: Apache-2.0
//
// Failed remote key throttle (plan Phase 16 task 2). Ported from magpie (MIT,
// Copyright (c) 2026 yetone) at e297a8ab2: internal/gateway/auththrottle.go.
//
// One token bucket shared by every caller of the team listener. It is charged
// only after a key was looked up and found wrong (or none came): every key is
// looked up (a SHA-256 digest and a map lookup, client-keys.ts `verify`), so a
// valid key never touches the bucket and a flood of wrong keys can only turn
// later wrong keys into 429s; it never locks a real member out. It shapes
// answers only: no request costs more than a digest, throttled or not.
// Keying it per address would be pointless behind a reverse proxy (Fly's
// edge, or one on the host), where every caller arrives as the proxy's
// address.

/** Wrong (or missing) remote keys tolerated before 429s begin (magpie authFailBurst; the plan's number). */
export const AUTH_FAIL_BURST = 50;
/** One more wrong key is allowed per this long (magpie authFailRefill; the plan's 1/s). */
export const AUTH_FAIL_REFILL_MS = 1_000;

export interface AuthFailVerdict {
  /** The caller is now answered 429 instead of 401. */
  throttled: boolean;
  /** Whole seconds until a token frees (the Retry-After value); 0 when not throttled. */
  retryAfterSeconds: number;
}

export class FailedKeyThrottle {
  private tokens = AUTH_FAIL_BURST;
  private lastRefillAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Charge one refused remote authentication. When no token is left the
   * failure is not charged again while the bucket is empty (magpie
   * `tooManyAuthFails`).
   */
  chargeFailure(): AuthFailVerdict {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { throttled: false, retryAfterSeconds: 0 };
    }
    return this.throttledVerdict();
  }

  private refill(): void {
    const now = this.now();
    if (this.lastRefillAt === null) this.lastRefillAt = now;
    this.tokens = Math.min(AUTH_FAIL_BURST, this.tokens + (now - this.lastRefillAt) / AUTH_FAIL_REFILL_MS);
    this.lastRefillAt = now;
  }

  private throttledVerdict(): AuthFailVerdict {
    return { throttled: true, retryAfterSeconds: Math.floor(((1 - this.tokens) * AUTH_FAIL_REFILL_MS) / 1000) + 1 };
  }
}
