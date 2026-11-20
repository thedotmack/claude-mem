/**
 * Signed tokens shared with cmem.ai (claude-mem-pro src/lib/viewer-host/link.ts
 * mints the same format). `v1.<payload>.<signature>`, both base64url; the
 * signature is HMAC-SHA256 over `v1.<payload>` with VIEWER_LINK_SECRET.
 *
 *   link     minted by cmem.ai for a signed-in user, lives 2 minutes, carried
 *            once in /auth?t=… and traded for a session.
 *   session  minted here, lives in an HttpOnly cookie.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenAudience = 'link' | 'session';

export interface TokenClaims {
  sub: string;
  aud: TokenAudience;
  /** Expiry, epoch seconds. */
  exp: number;
}

const encode = (bytes: Buffer | string) => Buffer.from(bytes).toString('base64url');

function signature(secret: string, signedPart: string): Buffer {
  return createHmac('sha256', secret).update(signedPart).digest();
}

export function signToken(secret: string, claims: TokenClaims): string {
  const signedPart = `v1.${encode(JSON.stringify(claims))}`;
  return `${signedPart}.${encode(signature(secret, signedPart))}`;
}

/** The claims, or null when the token is malformed, forged, for another audience, or expired. */
export function verifyToken(secret: string, token: string, audience: TokenAudience, nowSeconds = Math.floor(Date.now() / 1000)): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = signature(secret, `${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  const { sub, aud, exp } = (claims ?? {}) as Partial<TokenClaims>;
  if (typeof sub !== 'string' || !sub || aud !== audience || typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (exp <= nowSeconds) return null;
  return { sub, aud, exp };
}

/**
 * One account's own signing key, derived from the master secret cmem.ai and the
 * router hold (VIEWER_LINK_SECRET / CMEM_VIEWER_LINK_SECRET). An account's machine
 * holds only this key, so it can never mint a session another account's machine
 * accepts. 43 base64url characters (32 bytes), above the 32-character minimum in
 * index.ts. claude-mem-pro src/lib/viewer-host/link.ts derives the same key and
 * pins the same test vector.
 */
export function perUserViewerLinkSecret(masterSecret: string, userId: string): string {
  return createHmac('sha256', masterSecret).update(`cmem-viewer-link-secret:v1:${userId}`).digest('base64url');
}

/**
 * The Fly app that holds one account's viewer machine: the prefix plus the first
 * 24 hex characters of HMAC-SHA256(masterSecret, "cmem-viewer-app-name:v1:" + userId).
 * Keyed, so nobody without the master secret can work out which app belongs to
 * which user. 24 hex characters are 96 bits, which cannot collide in practice, and
 * keep the name well inside a DNS label's 63 characters. Derived from the user id,
 * so tokens never carry it. claude-mem-pro derives the same name and pins the same
 * test vector.
 */
export function replicaFlyAppNameForUser(masterSecret: string, appNamePrefix: string, userId: string): string {
  return appNamePrefix + createHmac('sha256', masterSecret).update(`cmem-viewer-app-name:v1:${userId}`).digest('hex').slice(0, 24);
}
