// SPDX-License-Identifier: Apache-2.0
//
// Endless Mode's switches, apart from its stage so the memory-injection stage
// can ask whether a conversation's session-start rows go into the timeline.

import type { WireGatewayRoute } from '../routes.js';

/**
 * Endless Mode's setting, read by the gateway at start (config.ts validates
 * it; changing it needs `claude-mem wire restart`). A route's
 * `features.endlessMode` is read live.
 */
export const ENDLESS_MODE_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE';

/** How each observation shows in the timeline (endless-timeline-row-format.ts), read at gateway start. */
export const ENDLESS_ROW_FORMAT_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT';

/** Whether Endless Mode is on for a route: its own `features.endlessMode`, else the setting (off by default, D9). */
export function endlessModeEnabledFor(route: WireGatewayRoute, settings: Readonly<Record<string, string>>): boolean {
  return route.features?.endlessMode ?? settings[ENDLESS_MODE_SETTING] === 'true';
}
