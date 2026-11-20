// SPDX-License-Identifier: Apache-2.0

/**
 * What a request that never got a response says about the connection, for the
 * message a user reads. #4092: a LAN endpoint (192.168.x) failed instantly
 * from the background worker while the same request worked from a terminal,
 * and the error named neither the code nor the host, so nothing in the report
 * could tell a refused port from a blocked process.
 */
export interface NetworkFailureDetail {
  /** The runtime's error code (Bun: `ConnectionRefused`; Node: `ECONNREFUSED` on `cause`). */
  code?: string;
  /** host[:port] the request was sent to. */
  host?: string;
  /** Set only for an address on the local network (not this machine). */
  localNetworkHint?: string;
}

/** 10/8, 172.16/12, 192.168/16, link-local 169.254/16, and mDNS `.local` names. */
function isLocalNetworkHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.endsWith('.local')) return true;
  return /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function errorCode(cause: unknown): string | undefined {
  const own = (cause as { code?: unknown } | null)?.code;
  if (typeof own === 'string' && own) return own;
  const nested = (cause as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof nested === 'string' && nested ? nested : undefined;
}

export function describeNetworkFailure(cause: unknown, requestUrl?: string): NetworkFailureDetail {
  const code = errorCode(cause);
  let host: string | undefined;
  let hostname: string | undefined;
  try {
    if (requestUrl) {
      const url = new URL(requestUrl);
      host = url.host;
      hostname = url.hostname;
    }
  } catch {
    // Not a URL: the message says what the runtime said, without a host.
  }
  return {
    ...(code ? { code } : {}),
    ...(host ? { host } : {}),
    ...(hostname && isLocalNetworkHostname(hostname)
      ? {
          localNetworkHint: `${host} is on your local network. If the same URL works from a terminal, the background worker may not be allowed to reach it: on macOS, check System Settings > Privacy & Security > Local Network.`,
        }
      : {}),
  };
}

/**
 * True when the failure is a refused connection. The request never left this
 * machine, so nothing can have been billed for it — unlike a reset or a
 * timeout, which can land after the server took the request.
 */
export function isConnectionRefused(detail: NetworkFailureDetail): boolean {
  return detail.code === 'ConnectionRefused' || detail.code === 'ECONNREFUSED';
}

/** " (ConnectionRefused, reaching 192.168.1.20:11434)" for a failure message, or ''. */
export function networkFailureSuffix(detail: NetworkFailureDetail): string {
  const parts = [detail.code, detail.host ? `reaching ${detail.host}` : undefined].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
