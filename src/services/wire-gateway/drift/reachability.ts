// SPDX-License-Identifier: Apache-2.0
//
// Reachability for `wire status` (plan Phase 9 tasks 2-5): whether an address
// answers as this gateway, directly or through the proxy an agent would use.
// Ported from magpie internal/agent/reach.go:37-315 (probe cache, reverse
// proxies that answer as magpie) and codex_proxy.go:18-251 (which proxy a
// request takes, NO_PROXY matching, probing through it), plus
// internal/netproxy/scutil.go (macOS system proxy); MIT, Copyright (c) 2026
// yetone.
//
// Probes never run in a relayed request's path. The daemon's GET /wire/status
// reads cached answers and starts stale ones in the background; the CLI waits.

import { spawn } from 'child_process';
import { isIP } from 'net';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { requestDirectly } from '../direct-http.js';
import { WIRE_GATEWAY_IDENTITY_NAME } from '../router.js';
import { isLoopbackAddress } from '../network-guard.js';

/** An answer is reused this long; older ones are asked again (magpie reachAge). */
export const PROBE_ANSWER_MAXIMUM_AGE_MS = 20_000;
/** Our own address must answer identity within this (plan Phase 9 task 4). */
export const DIRECT_IDENTITY_PROBE_TIMEOUT_MS = 2_000;
/** A probe through a proxy gets magpie's 3 s (codex_proxy.go realProxyProbe). */
export const PROXIED_IDENTITY_PROBE_TIMEOUT_MS = 3_000;
const IDENTITY_RESPONSE_MAXIMUM_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Probe cache (magpie reach.go probed / probedNow)

export type ProbeAnswer<T> = { known: true; value: T } | { known: false };

interface CachedProbeAnswer {
  answeredAt: number;
  value: unknown;
  hasAnswer: boolean;
  refreshing: Promise<unknown> | null;
}

export class ProbeAnswerCache {
  private readonly answers = new Map<string, CachedProbeAnswer>();
  private readonly maximumAgeMs: number;
  private readonly now: () => number;

  constructor(options: { maximumAgeMs?: number; now?: () => number } = {}) {
    this.maximumAgeMs = options.maximumAgeMs ?? PROBE_ANSWER_MAXIMUM_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  private refresh<T>(key: string, probe: () => Promise<T>): Promise<T> {
    const entry = this.answers.get(key) ?? { answeredAt: 0, value: undefined, hasAnswer: false, refreshing: null };
    if (entry.refreshing) return entry.refreshing as Promise<T>;
    const refreshing = probe().then(
      (value) => {
        this.answers.set(key, { answeredAt: this.now(), value, hasAnswer: true, refreshing: null });
        return value;
      },
      (error: unknown) => {
        // A probe that throws is a probe that failed; the caller's probe decides what failing means.
        const current = this.answers.get(key);
        if (current) current.refreshing = null;
        throw error;
      },
    );
    entry.refreshing = refreshing;
    this.answers.set(key, entry);
    return refreshing;
  }

  private isFresh(entry: CachedProbeAnswer | undefined): entry is CachedProbeAnswer {
    return entry !== undefined && entry.hasAnswer && this.now() - entry.answeredAt <= this.maximumAgeMs;
  }

  /** The last answer, if any; a stale or missing one is asked again in the background and never waited for. */
  cached<T>(key: string, probe: () => Promise<T>): ProbeAnswer<T> {
    const entry = this.answers.get(key);
    if (!this.isFresh(entry)) {
      this.refresh(key, probe).catch(() => undefined);
    }
    return entry?.hasAnswer ? { known: true, value: entry.value as T } : { known: false };
  }

  /** A fresh answer, asked now (and waited for) when there is none. */
  async fresh<T>(key: string, probe: () => Promise<T>): Promise<T> {
    const entry = this.answers.get(key);
    if (this.isFresh(entry)) return entry.value as T;
    return this.refresh(key, probe);
  }
}

/** How a status evaluation reads probes: waiting (CLI) or from the cache only (the daemon). */
export type ProbeLookup = <T>(key: string, probe: () => Promise<T>) => Promise<ProbeAnswer<T>>;

export function probeLookupFor(cache: ProbeAnswerCache, mode: 'wait' | 'cached-only'): ProbeLookup {
  if (mode === 'wait') {
    return async <T>(key: string, probe: () => Promise<T>): Promise<ProbeAnswer<T>> => ({ known: true, value: await cache.fresh(key, probe) });
  }
  return async <T>(key: string, probe: () => Promise<T>): Promise<ProbeAnswer<T>> => cache.cached(key, probe);
}

// ---------------------------------------------------------------------------
// Identity probes

function answersAsThisGateway(statusCode: number, bodyText: string): boolean {
  if (statusCode !== 200) return false;
  try {
    return (JSON.parse(bodyText) as { name?: unknown }).name === WIRE_GATEWAY_IDENTITY_NAME;
  } catch {
    // Not JSON: not us.
    return false;
  }
}

/**
 * Whether `GET <baseUrl>/` answers as this gateway, asked without any proxy
 * (direct-http.ts says why a fetch cannot be used).
 */
export async function probeIdentityDirectly(baseUrl: string, timeoutMs: number = DIRECT_IDENTITY_PROBE_TIMEOUT_MS): Promise<boolean> {
  const response = await requestDirectly({
    url: `${baseUrl.replace(/\/+$/, '')}/`,
    timeoutMs,
    maximumResponseBytes: IDENTITY_RESPONSE_MAXIMUM_BYTES,
  });
  return response !== null && answersAsThisGateway(response.statusCode, response.bodyText);
}

/**
 * Whether `GET <baseUrl>/` sent through `proxyUrl` is answered by this
 * gateway. A SOCKS proxy is asked as an HTTP one at the same address, as
 * Codex's reqwest (built without SOCKS) asks it (magpie realProxyProbe).
 */
export async function probeIdentityThroughProxy(baseUrl: string, proxyUrl: string, timeoutMs: number = PROXIED_IDENTITY_PROBE_TIMEOUT_MS): Promise<boolean> {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    return false;
  }
  if (proxy.protocol.startsWith('socks')) proxy = new URL(`http://${proxy.host}`);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/`, {
      proxy: proxy.href,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit & { proxy: string });
    return answersAsThisGateway(response.status, await response.text());
  } catch {
    // The proxy refused, timed out, or answered with something that is not us.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Which proxy a request for the gateway takes (magpie codex_proxy.go)

export interface SystemProxySettings {
  /** The proxy for http:// URLs (macOS "Web proxy (HTTP)"), or "". */
  http: string;
}

export interface ProxyRoute {
  proxyUrl: string;
  /** Where it is set: `HTTP_PROXY`, `ALL_PROXY`, or the system's proxy settings. */
  source: string;
}

function parseIpv4(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

/** Whether an IPv4/IPv6 CIDR or address entry covers `ip` (IPv6: exact address or /128 only). */
function noProxyEntryCoversAddress(entry: string, ip: string): boolean {
  const [network, prefixText] = entry.split('/');
  const normalizedNetwork = network.replace(/^\[|\]$/g, '').toLowerCase();
  if (prefixText === undefined) return normalizedNetwork === ip.toLowerCase();
  const prefix = Number(prefixText);
  const networkValue = parseIpv4(normalizedNetwork);
  const ipValue = parseIpv4(ip);
  if (networkValue !== null && ipValue !== null) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const divisor = 2 ** (32 - prefix);
    return Math.floor(networkValue / divisor) === Math.floor(ipValue / divisor);
  }
  return prefix === 128 && normalizedNetwork === ip.toLowerCase();
}

/**
 * hyper-util's NoProxy.contains as Codex uses it (magpie reqwestNoProxy): an
 * address is exempt only through an IP or a CIDR that holds it, a name
 * through itself or a domain it is under. Generalized for other agents: `*`
 * exempts everything, as curl and Node's proxy agents read it.
 */
export function noProxyExempts(host: string, noProxyList: string): boolean {
  const bareHost = host.replace(/^\[|\]$/g, '');
  const hostIsAddress = isIP(bareHost) !== 0;
  for (const rawEntry of noProxyList.split(',')) {
    const entry = rawEntry.trim();
    if (entry === '') continue;
    if (entry === '*') return true;
    if (hostIsAddress) {
      if (noProxyEntryCoversAddress(entry, bareHost)) return true;
      continue;
    }
    const domain = entry.replace(/^\./, '').toLowerCase();
    const lowerHost = bareHost.toLowerCase();
    if (lowerHost === domain || lowerHost.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * The proxy a request for `targetUrl` goes through, or null when it goes
 * direct: HTTP(S)_PROXY first, else the system's proxy for http://, else
 * ALL_PROXY; NO_PROXY goes around all of them (magpie codexProxyFor).
 */
export function proxyRouteFor(
  targetUrl: string,
  environmentVariables: Readonly<Record<string, string | undefined>>,
  systemProxy: SystemProxySettings | null,
): ProxyRoute | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  const firstSet = (...names: string[]): { name: string; value: string } | null => {
    for (const name of names) {
      const value = environmentVariables[name]?.trim();
      if (value) return { name, value };
    }
    return null;
  };
  const schemeVariables = url.protocol === 'https:' ? ['HTTPS_PROXY', 'https_proxy'] : ['HTTP_PROXY', 'http_proxy'];
  let route: ProxyRoute | null = null;
  const fromScheme = firstSet(...schemeVariables);
  if (fromScheme) route = { proxyUrl: fromScheme.value, source: schemeVariables[0] };
  if (!route && url.protocol === 'http:' && systemProxy?.http) route = { proxyUrl: systemProxy.http, source: "the system's proxy settings" };
  if (!route) {
    const fromAll = firstSet('ALL_PROXY', 'all_proxy');
    if (fromAll) route = { proxyUrl: fromAll.value, source: 'ALL_PROXY' };
  }
  if (!route) return null;
  const noProxy = firstSet('NO_PROXY', 'no_proxy')?.value ?? '';
  return noProxyExempts(url.hostname, noProxy) ? null : route;
}

/** `scutil --proxy` output → the http:// entry (magpie netproxy/scutil.go parseScutil). */
export function parseScutilProxyOutput(output: string): SystemProxySettings {
  const values = new Map<string, string>();
  let inList = false;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (inList) {
      if (line === '}') inList = false;
      continue;
    }
    const separator = line.indexOf(' : ');
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 3);
    if (key === 'ExceptionsList') {
      inList = true;
      continue;
    }
    values.set(key, value);
  }
  if (values.get('HTTPEnable') !== '1' || !values.get('HTTPProxy')) return { http: '' };
  const host = values.get('HTTPProxy')!;
  const port = values.get('HTTPPort');
  const hostForUrl = isIP(host) === 6 ? `[${host}]` : host;
  return { http: `http://${hostForUrl}${port ? `:${port}` : ''}` };
}

const SCUTIL_TIMEOUT_MS = 2_000;

/** macOS's proxy settings through scutil; null elsewhere or when scutil cannot be read. */
export function readMacSystemProxySettings(platform: NodeJS.Platform = process.platform): Promise<SystemProxySettings | null> {
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('scutil', ['--proxy'], { stdio: ['ignore', 'pipe', 'ignore'], env: sanitizeEnv(process.env), timeout: SCUTIL_TIMEOUT_MS });
    } catch {
      // scutil missing: no system proxy known.
      resolve(null);
      return;
    }
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? parseScutilProxyOutput(output) : null));
  });
}

/** Whether an http(s) URL names this machine's loopback (or localhost). */
export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || isLoopbackAddress(host);
  } catch {
    return false;
  }
}
