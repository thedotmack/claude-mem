// SPDX-License-Identifier: Apache-2.0

import { isIPv4, isIPv6 } from 'node:net';
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
// command is pasted into a shell, so the value must be a hostname, an IPv4
// literal, or a bracketed IPv6 literal, with an optional port — no whitespace,
// quotes, userinfo, path, or query. Domains are still trusted here; the point
// is to refuse values that cannot be a host at all.
//
// A label is 1-63 characters (RFC 1035). Underscores are allowed because Docker
// service and container names (`claude_mem`, `project_service_1`) resolve on
// Docker networks. One trailing dot (a fully qualified name) is allowed.
const HOSTNAME_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
// Ports 1-65535: the TCP port space; port 0 cannot be connected to.
const MAX_TCP_PORT = 65535;

function isValidHostname(host: string): boolean {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name.length > 0 && name.split('.').every((label) => HOSTNAME_LABEL.test(label));
}

function isValidPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false;
  const value = Number(port);
  return value >= 1 && value <= MAX_TCP_PORT;
}

export function isValidAdvertisedHost(rawHost: string): boolean {
  const value = rawHost.trim();
  let host: string;
  let port: string | null = null;
  if (value.startsWith('[')) {
    const closeBracketIndex = value.indexOf(']');
    if (closeBracketIndex === -1) return false;
    host = value.slice(1, closeBracketIndex);
    const rest = value.slice(closeBracketIndex + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return false;
      port = rest.slice(1);
    }
    // The character check keeps zone IDs (`%eth0`) out of the shell command.
    if (!/^[0-9a-f:.]+$/i.test(host) || !isIPv6(host)) return false;
  } else {
    const lastColonIndex = value.lastIndexOf(':');
    if (lastColonIndex > -1) {
      host = value.slice(0, lastColonIndex);
      port = value.slice(lastColonIndex + 1);
    } else {
      host = value;
    }
    if (!isIPv4(host) && !isValidHostname(host)) return false;
  }
  return port === null || isValidPort(port);
}

export function hasForwardedClientHeaders(req: Request): boolean {
  return Boolean(
    req.header('forwarded')
      || req.header('x-forwarded-for')
      || req.header('x-forwarded-host')
      || req.header('x-real-ip')
  );
}
