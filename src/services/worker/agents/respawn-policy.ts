// src/services/worker/agents/respawn-policy.ts
import { logger } from '../../../utils/logger.js';
import type { ObserverOutputClass } from '../../../sdk/output-classifier.js';

/**
 * Output classes that MAY be configured exempt from the respawn window.
 * 'xml' is valid (never reaches the counter); 'poisoned' is always-immediate
 * and is intentionally NOT exemptable.
 */
export const EXEMPTABLE_CLASSES = ['idle', 'prose'] as const satisfies readonly ObserverOutputClass[];
export type ExemptableClass = typeof EXEMPTABLE_CLASSES[number];

const EXEMPTABLE_SET = new Set<string>(EXEMPTABLE_CLASSES);

/** Sole string→ExemptableClass narrowing site (parse-don't-validate). */
export function isExemptableClass(x: string): x is ExemptableClass {
  return EXEMPTABLE_SET.has(x);
}

// Bounds + defaults (no-hardcoded-magic-numbers). Defaults mirror SettingsDefaults.
export const RESPAWN_THRESHOLD_BOUNDS = { min: 1, max: 100 } as const;
export const RESPAWN_WINDOW_MS_BOUNDS = { min: 1000, max: 3_600_000 } as const;
export const DEFAULT_RESPAWN_THRESHOLD = 3;          // was INVALID_OUTPUT_RESPAWN_THRESHOLD (#2485)
export const DEFAULT_RESPAWN_WINDOW_MS = 60_000;     // 1 min — trips ~1-bad/15s wedge in ~45s; lets blips decay
export const DEFAULT_EXEMPT_CLASSES: readonly ExemptableClass[] = ['idle'];

export interface RespawnPolicy {
  readonly exemptClasses: ReadonlySet<ExemptableClass>;
  readonly threshold: number;
  readonly windowMs: number;
}

export interface FailureWindow {
  windowStart: number;
  badCount: number;
}

export function freshWindow(): FailureWindow {
  return { windowStart: 0, badCount: 0 };
}

function parseBoundedInt(
  raw: string,
  bounds: { min: number; max: number },
  fallback: number,
  name: string,
): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < bounds.min || n > bounds.max) {
    logger.warn('SYSTEM', `Invalid ${name}, using default`, {
      value: raw, min: bounds.min, max: bounds.max, fallback,
    });
    return fallback;
  }
  return n;
}

export function parseRespawnPolicy(
  exemptRaw: string,
  thresholdRaw: string,
  windowMsRaw: string,
): RespawnPolicy {
  const tokens = exemptRaw.split(',').map(t => t.trim()).filter(Boolean);
  const exemptClasses = new Set<ExemptableClass>();
  for (const tok of tokens) {
    if (isExemptableClass(tok)) {
      exemptClasses.add(tok);
    } else {
      logger.warn('SYSTEM', `Unknown exempt output class "${tok}" — ignored`, { value: tok });
    }
  }
  return {
    exemptClasses: exemptClasses.size > 0
      ? exemptClasses
      : new Set<ExemptableClass>(DEFAULT_EXEMPT_CLASSES),
    threshold: parseBoundedInt(
      thresholdRaw, RESPAWN_THRESHOLD_BOUNDS, DEFAULT_RESPAWN_THRESHOLD,
      'CLAUDE_MEM_INVALID_OUTPUT_RESPAWN_THRESHOLD',
    ),
    windowMs: parseBoundedInt(
      windowMsRaw, RESPAWN_WINDOW_MS_BOUNDS, DEFAULT_RESPAWN_WINDOW_MS,
      'CLAUDE_MEM_INVALID_OUTPUT_WINDOW_MS',
    ),
  };
}
