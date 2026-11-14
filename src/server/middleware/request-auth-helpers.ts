// SPDX-License-Identifier: Apache-2.0

import type { Request } from 'express';

// Shared request-parsing helpers for the server auth middlewares. The SQLite
// (auth.ts) and Postgres (postgres-auth.ts) middlewares both need to parse the
// bearer token and decide whether a request is a trusted loopback request, so
// these live here instead of being copy-pasted in each file.

export function parseBearerToken(header: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function isLocalhost(req: Request): boolean {
  const clientIp = req.ip || req.socket.remoteAddress || '';
  return clientIp === '127.0.0.1'
    || clientIp === '::1'
    || clientIp === '::ffff:127.0.0.1'
    || clientIp === 'localhost';
}

export function hasLoopbackHostHeader(req: Request): boolean {
  const host = parseHostWithoutPort(req.header('host') ?? '');
  return host === '127.0.0.1'
    || host === 'localhost'
    || host === '::1';
}

export function parseHostWithoutPort(rawHost: string): string {
  const host = rawHost.trim().toLowerCase();
  if (host.startsWith('[')) {
    const closeBracketIndex = host.indexOf(']');
    return closeBracketIndex === -1 ? host : host.slice(1, closeBracketIndex);
  }

  const lastColonIndex = host.lastIndexOf(':');
  if (lastColonIndex > -1 && /^\d+$/.test(host.slice(lastColonIndex + 1))) {
    return host.slice(0, lastColonIndex);
  }
  return host;
}

// A Host header we are willing to advertise back to the caller. The connect
// command is pasted into a shell, so the value must be a plain hostname, IPv4
// literal, or bracketed IPv6 literal with an optional port — no whitespace,
// quotes, userinfo, path, or query. Domains are still trusted here; the point
// is to refuse values that cannot be a host at all.
const ADVERTISED_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

export function isValidAdvertisedHost(rawHost: string): boolean {
  return ADVERTISED_HOST.test(rawHost.trim());
}

export function hasForwardedClientHeaders(req: Request): boolean {
  return Boolean(
    req.header('forwarded')
      || req.header('x-forwarded-for')
      || req.header('x-forwarded-host')
      || req.header('x-real-ip')
  );
}
