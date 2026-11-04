/**
 * CLAUDE_MEM_PROVIDER_BY_SOURCE: a map from a session's platform source to the
 * provider that writes its observations, e.g. {"codex":"codex","claude":"claude"}.
 * Written as a JSON string (the default form) or, by hand in settings.json, as
 * a plain JSON object. Empty is off. Keys are normalized platform sources, so
 * "Codex CLI" and "codex" name the same entry.
 *
 * One parse for both the settings validation and worker dispatch.
 */

import { normalizePlatformSource } from './platform-source.js';
import type { SelectableProvider } from '../services/worker/provider-dispatch.js';

export const PROVIDER_BY_SOURCE_SETTING = 'CLAUDE_MEM_PROVIDER_BY_SOURCE';
export const SELECTABLE_PROVIDERS: readonly SelectableProvider[] = ['claude', 'gemini', 'openrouter', 'codex', 'openai-compatible'];

export type ProviderBySourceParse =
  | { ok: true; map: Map<string, SelectableProvider> }
  | { ok: false; error: string };

/** Every provider the map names. A malformed value names none, because dispatch ignores it. */
export function providersMappedBySource(raw: unknown): SelectableProvider[] {
  const parsed = parseProviderBySource(raw);
  return parsed.ok ? [...parsed.map.values()] : [];
}

export function parseProviderBySource(raw: unknown): ProviderBySourceParse {
  const map = new Map<string, SelectableProvider>();
  if (raw === undefined || raw === null) return { ok: true, map };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return { ok: true, map };
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `${PROVIDER_BY_SOURCE_SETTING} must be empty or a JSON object such as {"codex":"codex","claude":"claude"}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${PROVIDER_BY_SOURCE_SETTING} must be a JSON object mapping a source to a provider` };
  }
  for (const [source, provider] of Object.entries(parsed)) {
    if (source.trim() === '') {
      return { ok: false, error: `${PROVIDER_BY_SOURCE_SETTING} has an empty source name` };
    }
    if (typeof provider !== 'string' || !(SELECTABLE_PROVIDERS as readonly string[]).includes(provider)) {
      return { ok: false, error: `${PROVIDER_BY_SOURCE_SETTING} maps "${source}" to an unknown provider; use one of: ${SELECTABLE_PROVIDERS.join(', ')}` };
    }
    const key = normalizePlatformSource(source);
    if (map.has(key)) {
      return { ok: false, error: `${PROVIDER_BY_SOURCE_SETTING} names the source "${key}" more than once` };
    }
    map.set(key, provider as SelectableProvider);
  }
  return { ok: true, map };
}
