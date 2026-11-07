import { describe, expect, it } from 'bun:test';
import { createGate, SESSION_COOKIE } from '../src/gate.js';
import { signToken } from '../src/token.js';
import { FALLBACK_POSTHOG_KEY, hostedUsageEvent, posthogTarget } from '../src/usage.js';

const SECRET = 'x'.repeat(40);
const OWNER = 'user-owner';
const PUBLIC_ORIGIN = 'https://work.cmem.ai';
const now = () => 1_700_000_000;

function sessionCookie(): string {
  const token = signToken(SECRET, { sub: OWNER, aud: 'session', exp: now() + 3600 });
  return `${SESSION_COOKIE}=${token}`;
}

describe('hosted viewer usage', () => {
  it('reads the PostHog key from POSTHOG_API_KEY and falls back to the public project key', () => {
    expect(posthogTarget({}).apiKey).toBe(FALLBACK_POSTHOG_KEY);
    expect(posthogTarget({ POSTHOG_API_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com/' }).host).toBe('https://eu.i.posthog.com');
    expect(posthogTarget({ POSTHOG_API_KEY: '  phc_test  ' }).apiKey).toBe('phc_test');
  });

  it('accepts only the pageview, open, and switch, with no person profile', () => {
    const page = 'https://work.cmem.ai/';
    expect(hostedUsageEvent({ event: 'pageview' }, 'work.cmem.ai', page)).toEqual({
      event: '$pageview',
      properties: {
        $process_person_profile: false,
        viewer_host: 'hosted',
        hostname: 'work.cmem.ai',
        $current_url: page,
      },
    });
    expect(hostedUsageEvent({ event: 'opened', view: 'work' }, 'work.cmem.ai', page)?.event).toBe('work_view_opened');
    expect(hostedUsageEvent({ event: 'switched', view: 'rules', previousView: 'work' }, 'work.cmem.ai', page)?.properties.previous_view).toBe('work');
    expect(hostedUsageEvent({ event: 'opened', view: 'timeline' }, 'work.cmem.ai', page)).toBeNull();
    expect(hostedUsageEvent({ event: 'opened', view: 'work', title: 'secret' }, 'work.cmem.ai', page)).toBeNull();
    expect(hostedUsageEvent({ event: 'pageview' }, 'work.cmem.ai', page)?.properties.$set).toBeUndefined();
  });

  it('posts the hosted events to PostHog and not to the worker', async () => {
    const posts: { url: string; body: string }[] = [];
    const upstream: string[] = [];
    const gate = createGate({
      ownerUserId: OWNER,
      secret: SECRET,
      upstreamOrigin: 'http://127.0.0.1:9',
      publicOrigin: PUBLIC_ORIGIN,
      signInUrl: 'https://cmem.ai/work',
      now: () => now() * 1000,
      mintAnonymousId: () => '11111111-1111-4111-8111-111111111111',
      env: { POSTHOG_API_KEY: 'phc_hosted', POSTHOG_HOST: 'https://us.i.posthog.com' },
      fetchImpl: async (input) => {
        upstream.push(String(input));
        return new Response('nope', { status: 500 });
      },
      posthogFetch: async (input, init) => {
        posts.push({ url: String(input), body: String(init?.body ?? '') });
        return new Response('ok', { status: 200 });
      },
    });

    const headers = {
      cookie: sessionCookie(),
      origin: PUBLIC_ORIGIN,
      host: 'work.cmem.ai',
      'content-type': 'application/json',
    };
    const opened = await gate(new Request(`${PUBLIC_ORIGIN}/api/viewer-usage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: 'opened', view: 'work' }),
    }));
    expect(opened.status).toBe(204);
    expect(upstream).toHaveLength(0);
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(posts[0].body) as { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown> };
    expect(posts[0].url).toBe('https://us.i.posthog.com/capture/');
    expect(payload.api_key).toBe('phc_hosted');
    expect(payload.event).toBe('work_view_opened');
    expect(payload.distinct_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(payload.properties.viewer_host).toBe('hosted');
    expect(payload.properties.hostname).toBe('work.cmem.ai');
    expect(payload.properties.$process_person_profile).toBe(false);
    expect(payload.properties.$set).toBeUndefined();
    expect(opened.headers.get('set-cookie')).toContain('cmem_viewer_anon=11111111-1111-4111-8111-111111111111');

    const pageview = await gate(new Request(`${PUBLIC_ORIGIN}/api/viewer-usage`, {
      method: 'POST',
      headers: { ...headers, cookie: `${headers.cookie}; cmem_viewer_anon=${payload.distinct_id}` },
      body: JSON.stringify({ event: 'pageview' }),
    }));
    expect(pageview.status).toBe(204);
    expect(JSON.parse(posts[1].body).event).toBe('$pageview');
    expect(pageview.headers.get('set-cookie')).toBeNull();
  });

  it('mints a real anonymous id when none is injected', async () => {
    const posts: string[] = [];
    const gate = createGate({
      ownerUserId: OWNER,
      secret: SECRET,
      upstreamOrigin: 'http://127.0.0.1:9',
      publicOrigin: PUBLIC_ORIGIN,
      signInUrl: 'https://cmem.ai/work',
      now: () => now() * 1000,
      env: { POSTHOG_API_KEY: 'phc_hosted' },
      posthogFetch: async (_input, init) => {
        posts.push(String(init?.body ?? ''));
        return new Response('ok', { status: 200 });
      },
    });

    const response = await gate(new Request(`${PUBLIC_ORIGIN}/api/viewer-usage`, {
      method: 'POST',
      headers: { cookie: sessionCookie(), origin: PUBLIC_ORIGIN, host: 'work.cmem.ai', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'pageview' }),
    }));
    expect(response.status).toBe(204);
    expect(posts).toHaveLength(1);
    const distinctId = (JSON.parse(posts[0]) as { distinct_id: string }).distinct_id;
    expect(distinctId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(response.headers.get('set-cookie')).toContain(`cmem_viewer_anon=${distinctId}`);
  });
});
