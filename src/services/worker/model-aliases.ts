import type { SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';

/**
 * `$TIER` alias resolution (#2289).
 *
 * Lets users write a portable tier alias in CLAUDE_MEM_MODEL (e.g.
 * `$TIER:fast`) that resolves to a provider-appropriate concrete model at
 * request time. Resolution happens at request time (not settings-load time)
 * so users can edit settings without restarting the worker.
 *
 * Pure function: does not mutate `settings`. Non-tier input passes through
 * unchanged (e.g. `claude-haiku-4-5-20251001`).
 */
const TIER_PATTERN = /^\$TIER:(fast|smart|simple|summary)$/;

export function resolveTierAlias(model: string, settings: SettingsDefaults): string {
  const match = TIER_PATTERN.exec(model);
  if (!match) return model;

  switch (match[1]) {
    case 'fast':
      return settings.CLAUDE_MEM_TIER_FAST_MODEL || 'haiku';
    case 'smart':
      return settings.CLAUDE_MEM_TIER_SMART_MODEL || 'sonnet';
    case 'simple':
      return settings.CLAUDE_MEM_TIER_SIMPLE_MODEL || 'haiku';
    case 'summary':
      // Summary tier falls back to the configured default model when no
      // explicit summary model is set (matches existing summary-routing).
      return settings.CLAUDE_MEM_TIER_SUMMARY_MODEL || settings.CLAUDE_MEM_MODEL;
    default:
      return model;
  }
}
