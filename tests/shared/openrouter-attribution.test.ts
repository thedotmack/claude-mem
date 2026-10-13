// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  OPENROUTER_APP_CATEGORIES,
  OPENROUTER_APP_TITLE,
  OPENROUTER_APP_URL,
  openRouterAttributionHeaders,
} from '../../src/shared/openrouter-attribution.js';

// OpenRouter's recognized category slugs. Unrecognized values are dropped
// silently, so a typo here would cost the app its categories with no error.
const RECOGNIZED_CATEGORIES = new Set([
  'cli-agent', 'ide-extension', 'cloud-agent', 'programming-app', 'native-app-builder',
  'creative-writing', 'video-gen', 'image-gen', 'audio-gen',
  'writing-assistant', 'general-chat', 'personal-agent', 'legal',
  'roleplay', 'game',
]);

describe('OpenRouter app identity', () => {
  // This is the one value that must never drift. OpenRouter keys the public
  // leaderboard on the referer URL, so changing it mints a brand-new app and
  // strands every token the existing entry (app id 2605040) has earned.
  // Deliberately no rank here — the daily rank moves and would rot.
  it('pins the app URL that owns the ranking', () => {
    expect(OPENROUTER_APP_URL).toBe('https://github.com/thedotmack/claude-mem');
  });

  it('sends the title as the display name', () => {
    expect(OPENROUTER_APP_TITLE).toBe('Claude-Mem');
  });
});

describe('openRouterAttributionHeaders', () => {
  it('falls back to the claude-mem app identity when unconfigured', () => {
    const h = openRouterAttributionHeaders(undefined, undefined);
    expect(h['HTTP-Referer']).toBe(OPENROUTER_APP_URL);
    expect(h['X-OpenRouter-Title']).toBe(OPENROUTER_APP_TITLE);
  });

  it('treats empty strings as unset', () => {
    const h = openRouterAttributionHeaders('', '');
    expect(h['HTTP-Referer']).toBe(OPENROUTER_APP_URL);
    expect(h['X-OpenRouter-Title']).toBe(OPENROUTER_APP_TITLE);
  });

  it('lets a user attribute their own traffic elsewhere', () => {
    const h = openRouterAttributionHeaders('https://example.com', 'My Fork');
    expect(h['HTTP-Referer']).toBe('https://example.com');
    expect(h['X-OpenRouter-Title']).toBe('My Fork');
  });

  it('uses the canonical header name, not the X-Title alias', () => {
    const h = openRouterAttributionHeaders();
    expect(h).toHaveProperty('X-OpenRouter-Title');
    expect(h).not.toHaveProperty('X-Title');
  });

  it('always sends categories, even for a custom site URL', () => {
    expect(openRouterAttributionHeaders('https://example.com')['X-OpenRouter-Categories'])
      .toBe(OPENROUTER_APP_CATEGORIES);
  });
});

describe('OPENROUTER_APP_CATEGORIES', () => {
  const all = OPENROUTER_APP_CATEGORIES.split(',');

  it('sends at most 2 categories per request', () => {
    expect(all.length).toBeLessThanOrEqual(2);
  });

  it('uses only categories OpenRouter recognizes', () => {
    for (const c of all) expect(RECOGNIZED_CATEGORIES).toContain(c);
  });

  it('claims no media-generation or roleplay category', () => {
    for (const c of ['video-gen', 'image-gen', 'audio-gen', 'roleplay', 'game']) {
      expect(all).not.toContain(c);
    }
  });

  it('claims no category twice', () => {
    expect(new Set(all).size).toBe(all.length);
  });

  it('has no stray whitespace', () => {
    expect(OPENROUTER_APP_CATEGORIES).toBe(all.map((c) => c.trim()).join(','));
  });
});
