/**
 * Duplicate collapse for memory query results.
 *
 * The claude-mem worker can persist the same observation many times (e.g. a
 * boilerplate "media prompt session initiated" record re-emitted every turn,
 * or a re-run tool result), differing only by `id` / `memory_session_id` /
 * timestamps. Those near-identical rows flood search output and burn tokens,
 * so this module collapses observations that carry the SAME content.
 *
 * The content fingerprint is built only from content-bearing fields
 * (`narrative`, `title`, `facts`, `subtitle`, `text`) — never from identity or
 * position fields (`id`, session id, timestamps, hashes), so two observations
 * that merely share a generated title but differ in narrative are KEPT.
 * @module dsh-claude-mem/dedupe
 */

import type { MemObservation } from './types.js'

/** Normalize a free-form string for comparison: trim, lowercase, collapse whitespace. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Join a possibly-undefined list of strings, order-preserved and normalized. */
function joinList(values: readonly string[] | undefined): string {
  if (values === undefined || values.length === 0) return ''
  return values.map(v => normalize(v)).join('\u0000')
}

/**
 * Content fingerprint of one observation. Duplicate observations (identical
 * narrative/title/facts but different ids) share the same fingerprint.
 */
export function observationFingerprint(obs: MemObservation): string {
  const parts = [
    normalize(obs.title),
    normalize(obs.subtitle ?? ''),
    normalize(obs.text ?? ''),
    normalize(obs.narrative ?? ''),
    joinList(obs.facts),
  ].filter(part => part.length > 0)
  return parts.join('\u0001')
}

/**
 * Collapse duplicate observations, keeping the FIRST occurrence for each
 * content fingerprint (the lowest id — the earliest copy — is the canonical
 * one). Order is preserved; entries whose content fingerprint is empty are
 * never dropped (nothing to compare against means we cannot prove duplication).
 */
export function dedupeObservations(items: readonly MemObservation[]): MemObservation[] {
  const seen = new Set<string>()
  const result: MemObservation[] = []
  for (const item of items) {
    const key = observationFingerprint(item)
    // An empty fingerprint means we have no content to compare; keep it rather
    // than risk dropping a distinct entry.
    if (key === '' || !seen.has(key)) {
      if (key !== '') seen.add(key)
      result.push(item)
    }
  }
  return result
}

/**
 * Remove exact-duplicate lines from a worker-rendered result body, without
 * disturbing structure. Used for the `content` text path (the worker's
 * pre-rendered index table), where we lack the per-observation narrative and
 * can only collapse lines that render byte-for-byte identically (modulo the
 * leading `#id` token). Content that is not an index table is returned as-is.
 */
export function dedupeRenderedTable(content: string): string {
  const lines = content.split('\n')
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    // Only fold index rows of the form "| #id | time | type | title | read |".
    // A duplicate is two rows whose content cells (type + title + read) match;
    // the id cell always differs and the time cell is often a ditto marker ("″"),
    // so both are excluded from the key.
    const cells = splitTableRow(line)
    if (cells === null) {
      out.push(line)
      continue
    }
    // cells = [id, time, type, title, read, ...] — drop id (0) and time (1).
    const key = cells.slice(2).map(normalizeCell).join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out.join('\n')
}

/** Split a markdown table row into its cells, or null if it is not such a row. */
function splitTableRow(line: string): string[] | null {
  if (!line.startsWith('|') || !line.endsWith('|')) return null
  // Strip the leading and trailing pipe, then split on inner pipes.
  const inner = line.slice(1, -1)
  return inner.split('|').map(cell => cell.trim())
}

/** Normalize a cell's text; a ditto/time marker collapses to empty (time-agnostic). */
function normalizeCell(cell: string): string {
  const c = cell.trim().toLowerCase().replace(/\s+/g, ' ')
  // Ditto / same-as-above markers ("″", "\"", "“", "do.") and standalone time
  // values are identity-irrelevant — treat them as empty.
  if (c === '' || c === '″' || c === '"' || c === '“' || /^\d{1,2}:\d{2}\s*(am|pm)?$/.test(c)) return ''
  return c
}
