// SPDX-License-Identifier: Apache-2.0
//
// How Endless Mode's timeline shows each observation
// (CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT). The worker renders the row
// (POST /api/wire/tool-observations); the gateway only names the format.
// - `timeline`: the session-start timeline's one-line row, `<id> <time> <icon> <title>`.
// - `observation`: that line, then the observation as get_observations shows
//   it (subtitle, facts, files), without its narrative.
// - `observation-with-narrative`: the same with the narrative.

export const ENDLESS_TIMELINE_ROW_FORMATS = ['timeline', 'observation', 'observation-with-narrative'] as const;
export type EndlessTimelineRowFormat = typeof ENDLESS_TIMELINE_ROW_FORMATS[number];
export const DEFAULT_ENDLESS_TIMELINE_ROW_FORMAT: EndlessTimelineRowFormat = 'timeline';

/** The format a setting names; throws on any other value (an unknown format must never fall back silently). */
export function endlessTimelineRowFormatOf(value: string | undefined): EndlessTimelineRowFormat {
  if (value === undefined || value === '') return DEFAULT_ENDLESS_TIMELINE_ROW_FORMAT;
  if ((ENDLESS_TIMELINE_ROW_FORMATS as readonly string[]).includes(value)) return value as EndlessTimelineRowFormat;
  throw new Error(`unknown Endless Mode row format "${value}": use one of ${ENDLESS_TIMELINE_ROW_FORMATS.join(', ')}`);
}
