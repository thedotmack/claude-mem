/**
 * Client for the Claude-Mem install advisor on cmem.ai
 * (/api/installer/plan | fix | outcome). Every call has a 5s budget and any
 * error means "no advice": the caller falls back to the scripted Phase 1
 * remediation. Answers are re-validated here: a step's `command` is printed
 * only if it passes isAllowedAdvisorCommand, and user-facing text is plain,
 * single-spaced and capped.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cmemProOrigin } from '../../shared/cmem-gateway.js';
import { resolveDataDir } from '../../shared/paths.js';
import { isAllowedAdvisorCommand, isKnownFixId } from './fix-catalog.js';

export const ADVISOR_TIMEOUT_MS = 5_000;
const LAST_ADVICE_FILE = 'last-advice.json';
const LAST_ADVICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

export type AdvisorSource = 'rules' | 'cache' | 'model';

export interface AdvisorStep {
  id: string;
  command: string | null;
  forTheUser: string | null;
  humanActionRequired: 'sign-in' | null;
  when: string | null;
}

export interface AdvisorAnswer {
  adviceId: string;
  source: AdvisorSource;
  fixId: string | null;
  steps: AdvisorStep[];
  notes: string;
  /** Commands the server sent that failed the local allowlist (never printed). */
  droppedCommands: number;
}

export type AdvisorEndpoint = 'plan' | 'fix' | 'outcome';

export function advisorUrl(endpoint: AdvisorEndpoint): string {
  return `${cmemProOrigin()}/api/installer/${endpoint}`;
}

/** POST JSON; resolves to the parsed body, or null on any error, non-2xx or timeout. */
export async function postAdvisor(endpoint: AdvisorEndpoint, body: unknown, timeoutMs = ADVISOR_TIMEOUT_MS): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(advisorUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // [ANTI-PATTERN IGNORED]: the advisor is optional; callers print the scripted remediation instead.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

export function parseAdvisorAnswer(body: unknown): AdvisorAnswer | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.advice_id !== 'string' || !TOKEN_RE.test(b.advice_id)) return null;
  if (b.source !== 'rules' && b.source !== 'cache' && b.source !== 'model') return null;
  if (!Array.isArray(b.steps)) return null;
  let dropped = 0;
  const steps: AdvisorStep[] = [];
  for (const raw of b.steps.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || !TOKEN_RE.test(s.id)) continue;
    let command: string | null = null;
    if (s.command !== undefined && s.command !== null) {
      if (isAllowedAdvisorCommand(s.command)) command = (s.command as string).trim();
      else dropped++;
    }
    steps.push({
      id: s.id,
      command,
      forTheUser: plainText(s.for_the_user, 300),
      humanActionRequired: s.human_action_required === 'sign-in' ? 'sign-in' : null,
      when: plainText(s.when, 120),
    });
  }
  return {
    adviceId: b.advice_id,
    source: b.source,
    fixId: isKnownFixId(b.fix_id) ? b.fix_id : null,
    steps,
    notes: plainText(b.notes, 1200) ?? '',
    droppedCommands: dropped,
  };
}

export function saveLastAdvice(adviceId: string, now: number = Date.now()): void {
  try {
    mkdirSync(resolveDataDir(), { recursive: true });
    writeFileSync(join(resolveDataDir(), LAST_ADVICE_FILE), JSON.stringify({ advice_id: adviceId, at: new Date(now).toISOString() }) + '\n');
  } catch {
    // [ANTI-PATTERN IGNORED]: without the file only the outcome report is lost; the advice was printed.
  }
}

/** The advice this machine followed in the last 24h, if any. */
export function readLastAdvice(now: number = Date.now()): string | null {
  try {
    const path = join(resolveDataDir(), LAST_ADVICE_FILE);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { advice_id?: unknown; at?: unknown };
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
    if (typeof raw.advice_id !== 'string' || !TOKEN_RE.test(raw.advice_id)) return null;
    if (!Number.isFinite(at) || now - at > LAST_ADVICE_MAX_AGE_MS) return null;
    return raw.advice_id;
  } catch {
    // [ANTI-PATTERN IGNORED]: a corrupt file means no advice to report on.
    return null;
  }
}

export function clearLastAdvice(): void {
  try {
    rmSync(join(resolveDataDir(), LAST_ADVICE_FILE), { force: true });
  } catch {
    // [ANTI-PATTERN IGNORED]: a stale file only makes the next outcome report skip; nothing depends on it.
  }
}

/** Tell the advisor how a step it suggested went. Best-effort, never throws. */
export async function reportAdviceOutcome(adviceId: string, stepId: string, outcome: 'ok' | 'error'): Promise<boolean> {
  const answer = await postAdvisor('outcome', { advice_id: adviceId, step_id: stepId, outcome });
  return answer !== null;
}
