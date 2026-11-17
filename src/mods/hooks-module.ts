/**
 * claude-mem's hooks module: Claude Code loads the bundle of this file
 * (plugin/hooks/hooks-module.js, named by `modules` in plugin/hooks/hooks.json)
 * and calls `register`. Claude Code versions without mods ignore `modules`.
 *
 * A plugin has one hooks module (Claude Code refuses a second path under
 * `modules`), so every claude-mem mod registers its hooks through this file.
 * It also allows one hook per event without a matcher: auto-clear has
 * `session.start`, so another mod that needs it registers under a matcher.
 *
 * Claude Code reads what a hooks module hooks and calls off its source, so
 * `register` is a function declaration, every hook is `on("<event>", hook)`,
 * and `$` is only ever spelled `$.<namespace>.<method>(…)` with literal names:
 * it is never passed to a helper.
 */
import type { On as AutoClearOn } from './auto-clear/mod-api.js';
import { registerAutoClear } from './auto-clear/register.js';
import type { On as SessionStartCardOn } from './session-start-card/mod-api.js';
import { registerSessionStartCard } from './session-start-card/register.js';

export function register(on: AutoClearOn & SessionStartCardOn): void {
  registerAutoClear(on);
  registerSessionStartCard(on);
}
