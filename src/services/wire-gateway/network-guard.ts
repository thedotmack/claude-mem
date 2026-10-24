// SPDX-License-Identifier: Apache-2.0
//
// Loopback-mode network guard. Ported from magpie (MIT, Copyright (c) 2026
// yetone) at e297a8ab2: internal/gateway/lan.go (`local`, `proxied`,
// `forwardHeaders`, `rebound`, `fromBrowser`, `ownHost`) and cors.go
// (`foreignPage`). The gateway never emits CORS headers, so a page that is
// let through still cannot read a reply.

import { hostname as osHostname } from 'os';
import { isIP } from 'net';

/**
 * What a proxy or tunnel adds to a request it passes on (cloudflared, ngrok,
 * Tailscale serve/funnel, frp, Caddy, nginx). An agent calling the gateway
 * sends none of them. magpie lan.go `forwardHeaders`.
 */
export const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'tailscale-user-login',
] as const;

/** The names container runtimes give the host. magpie lan.go `containerHostNames`. */
const CONTAINER_HOST_NAMES = new Set([
  'host.docker.internal',
  'gateway.docker.internal',
  'host.containers.internal',
  'host.orb.internal',
  'docker.for.mac.localhost',
]);

export interface NetworkGuardContext {
  /** Peer address from server.requestIP(req); null when the socket is gone. */
  peerAddress: string | null;
  /** The address the gateway listens on (CLAUDE_MEM_WIRE_GATEWAY_HOST). */
  listenHost: string;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1') return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is how a dual-stack socket reports an IPv4 peer.
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

/** Strip a port and IPv6 brackets from a Host header value, lowercase, drop a trailing dot. */
function hostWithoutPort(hostHeader: string): string {
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else if (host.split(':').length === 2) {
    host = host.slice(0, host.indexOf(':'));
  }
  return host.replace(/\.$/, '');
}

/**
 * The Host names this computer: an IP literal, localhost, *.localhost, a
 * container runtime's name for the host, the listen host, or this machine's
 * own name. A DNS-rebinding page always arrives under a web site's name.
 * magpie lan.go `ownHost`.
 */
export function isOwnHost(hostHeader: string, listenHost: string): boolean {
  const host = hostWithoutPort(hostHeader);
  if (host === '' || isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (CONTAINER_HOST_NAMES.has(host)) return true;
  if (host === hostWithoutPort(listenHost)) return true;
  const machineName = osHostname().toLowerCase().replace(/\.local$/, '');
  return machineName !== '' && (host === machineName || host === `${machineName}.local`);
}

/** The request carries what a browser puts on every request and a page's script can't remove. magpie lan.go `fromBrowser`. */
export function isFromBrowser(headers: Headers): boolean {
  return Boolean(headers.get('origin'))
    || Boolean(headers.get('sec-fetch-site'))
    || Boolean(headers.get('sec-fetch-mode'))
    || (headers.get('user-agent') ?? '').startsWith('Mozilla/');
}

function hostPortOf(host: string, scheme: string): string {
  const lower = host.toLowerCase();
  if (/:\d+$/.test(lower)) return lower;
  return `${lower}:${scheme === 'https' ? '443' : '80'}`;
}

/**
 * An http(s) Origin that is neither on this computer (localhost, *.localhost,
 * a loopback IP) nor the request's own origin. Other schemes (app://, file://,
 * vscode-webview://, chrome-extension://, "null") come from desktop apps and
 * extensions, which no ordinary web page can send, so they pass. magpie
 * cors.go `foreignPage`.
 */
export function isForeignOrigin(origin: string | null, hostHeader: string): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // A browser's Origin always parses; an unreadable http one is no page of ours.
    return origin.toLowerCase().startsWith('http');
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isLoopbackAddress(host)) return false;
  return hostPortOf(url.host, scheme) !== hostPortOf(hostHeader, scheme);
}

/**
 * Loopback-mode admission. Returns why a request is refused (answered 403),
 * or null to let it through. Order: peer, forwarding headers, DNS rebinding,
 * foreign page.
 */
export function checkLoopbackRequest(request: Request, context: NetworkGuardContext): string | null {
  const { headers } = request;

  if (!context.peerAddress || !isLoopbackAddress(context.peerAddress)) {
    return `the claude-mem wire gateway answers this computer only; refused a request from ${context.peerAddress ?? 'an unknown address'}`;
  }

  const forwardingHeader = FORWARDING_HEADERS.find(name => headers.get(name));
  if (forwardingHeader) {
    return `this request came through a proxy or tunnel (it carries ${forwardingHeader}), so the claude-mem wire gateway treats it as from another machine and refuses it`;
  }

  const hostHeader = headers.get('host') ?? '';
  if (isFromBrowser(headers) && !isOwnHost(hostHeader, context.listenHost)) {
    return `the claude-mem wire gateway doesn't answer a browser that reached it as ${hostHeader} (a web site's name pointed at this computer): call it as localhost or 127.0.0.1`;
  }

  const origin = headers.get('origin');
  if (isForeignOrigin(origin, hostHeader)) {
    return `the claude-mem wire gateway doesn't answer the web page ${origin}`;
  }

  return null;
}
