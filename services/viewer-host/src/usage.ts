/**
 * Hosted My Work usage. The page posts here; we forward three events to the
 * same PostHog project as the local worker. No browser SDK, so there is no
 * session recording and no autocapture. No `$set` and `$process_person_profile:
 * false`, on a random id that is not the cmem user id — that user id is already
 * an identified person on the website.
 *
 * POSTHOG_API_KEY overrides the publishable project key. POSTHOG_HOST overrides
 * the ingestion host (default https://us.i.posthog.com).
 */

export const VIEWER_USAGE_PATH = '/api/viewer-usage';
export const VIEWER_ANON_COOKIE = 'cmem_viewer_anon';
/** Same publishable token as src/services/telemetry/common.ts TELEMETRY_PUBLIC_KEY. */
export const FALLBACK_POSTHOG_KEY = 'phc_BKJAeNbpj932N9qEiU6qhutZEiu6LLfRpXfTbLM9MLaG';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const VIEWS = new Set(['setup', 'work', 'rules', 'suggested', 'past-focus']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostHogCapture {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
}

export function posthogTarget(env: NodeJS.ProcessEnv = process.env): { apiKey: string; host: string } {
  const apiKey = (env.POSTHOG_API_KEY ?? '').trim() || FALLBACK_POSTHOG_KEY;
  const host = ((env.POSTHOG_HOST ?? '').trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '');
  return { apiKey, host };
}

export function requestHostname(request: Request): string {
  const raw = (request.headers.get('host') || new URL(request.url).hostname).split(':')[0].trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(raw) ? raw : 'unknown';
}

export function anonymousDistinctId(cookieHeader: string | null, minted: string): { id: string; setCookie: boolean } {
  const existing = readCookie(cookieHeader, VIEWER_ANON_COOKIE);
  if (existing && UUID.test(existing)) return { id: existing, setCookie: false };
  return { id: minted, setCookie: true };
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The PostHog event for a valid body, or null when the body is not one of the three hosted events. */
export function hostedUsageEvent(body: unknown, hostname: string, pageUrl: string): { event: string; properties: Record<string, unknown> } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  const base = {
    $process_person_profile: false,
    viewer_host: 'hosted',
    hostname,
    $current_url: pageUrl,
  };
  if (body.event === 'pageview' && keys.length === 1) {
    return { event: '$pageview', properties: base };
  }
  if (body.event === 'opened' && keys.length === 2 && typeof body.view === 'string' && VIEWS.has(body.view)) {
    return { event: 'work_view_opened', properties: { ...base, view: body.view } };
  }
  if (
    body.event === 'switched'
    && keys.length === 3
    && typeof body.view === 'string'
    && typeof body.previousView === 'string'
    && VIEWS.has(body.view)
    && VIEWS.has(body.previousView)
  ) {
    return { event: 'work_view_switched', properties: { ...base, view: body.view, previous_view: body.previousView } };
  }
  return null;
}

export function anonCookie(id: string, secure: boolean): string {
  return `${VIEWER_ANON_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
}

/** POST one event. Never throws; a failed ingest still answers the page. */
export async function sendPostHogEvent(
  capture: PostHogCapture,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<void> {
  const { apiKey, host } = posthogTarget(env);
  await fetchImpl(`${host}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      event: capture.event,
      distinct_id: capture.distinctId,
      properties: capture.properties,
    }),
  });
}
