// SPDX-License-Identifier: Apache-2.0

/**
 * LLM judge with a mandatory disk cache (`.gold-cache.json`). Every uncached
 * call goes through createSdkJudge() (Agent SDK) and costs subscription quota,
 * so the cache is checked first and the spent-call counter is reported.
 *
 * The SDK import is lazy: `--no-judge` runs never load the Agent SDK.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { JUDGE_CACHE_PATH } from './common.js';

type JudgeFn = (prompt: string) => Promise<string>;

interface CacheFile {
  version: 1;
  entries: Record<string, unknown>;
}

export class CachedJudge {
  private entries: Record<string, unknown>;
  private judge: JudgeFn | null = null;
  /** LLM calls actually spent this run. */
  callsSpent = 0;
  cacheHits = 0;

  constructor() {
    this.entries = existsSync(JUDGE_CACHE_PATH)
      ? (JSON.parse(readFileSync(JUDGE_CACHE_PATH, 'utf-8')) as CacheFile).entries ?? {}
      : {};
  }

  private async getJudge(): Promise<JudgeFn> {
    if (!this.judge) {
      const { createSdkJudge } = await import('../../../src/services/reinforcement/dedup-judge.js');
      this.judge = createSdkJudge();
    }
    return this.judge;
  }

  private key(kind: string, payload: string): string {
    return `${kind}:v1:${createHash('sha256').update(payload).digest('hex').slice(0, 24)}`;
  }

  private async ask<T>(kind: string, payload: string, prompt: string, parse: (answer: string) => T): Promise<T> {
    const key = this.key(kind, payload);
    if (key in this.entries) {
      this.cacheHits++;
      return this.entries[key] as T;
    }
    const judge = await this.getJudge();
    const answer = await judge(prompt);
    this.callsSpent++;
    const value = parse(answer);
    this.entries[key] = value;
    this.save();
    return value;
  }

  /** Gold-set confirmation: which candidate observation ids are relevant to the prompt. */
  async confirmRelevant(promptText: string, candidates: Array<{ id: number; title: string | null; narrative: string | null }>): Promise<number[]> {
    const payload = promptText + '|' + candidates.map(c => c.id).join(',');
    const listed = candidates
      .map(c => `- id=${c.id} — ${(c.title ?? '').slice(0, 120)}: ${(c.narrative ?? '').slice(0, 400)}`)
      .join('\n');
    const prompt = [
      'You are auditing a developer-memory system. Below is a real user prompt from a past coding',
      'session and candidate memory observations. Select the observations whose content is relevant',
      'to the prompt — i.e. they would help answer it or continue that work. Reply with a JSON array',
      ' of ids only, e.g. [12, 45]. Reply [] if none are relevant.',
      '',
      'USER PROMPT:',
      '"""',
      promptText.slice(0, 2000),
      '"""',
      '',
      'CANDIDATE OBSERVATIONS:',
      listed,
    ].join('\n');
    const valid = new Set(candidates.map(c => c.id));
    const ids = await this.ask<number[]>('gold', payload, prompt, parseIdArray);
    return ids.filter(id => valid.has(id));
  }

  /** Eval metric: how many of the k retrieved observations are relevant to the prompt (0..k). */
  async relevanceCount(promptText: string, items: Array<{ id: number; title: string | null; narrative: string | null }>): Promise<number> {
    if (items.length === 0) return 0;
    const payload = promptText + '|' + items.map(c => c.id).join(',');
    const listed = items
      .map((c, i) => `${i + 1}. ${(c.title ?? '').slice(0, 120)}: ${(c.narrative ?? '').slice(0, 400)}`)
      .join('\n');
    const prompt = [
      'You are auditing a developer-memory system. Below is a real user prompt from a past coding',
      'session and the memory observations the system would inject for it. Count how many of the',
      `observations (0..${items.length}) are genuinely relevant to the prompt. Reply with JSON only:`,
      '{"relevant": <number>}.',
      '',
      'USER PROMPT:',
      '"""',
      promptText.slice(0, 2000),
      '"""',
      '',
      'RETRIEVED OBSERVATIONS:',
      listed,
    ].join('\n');
    const n = await this.ask<number>('rel5', payload, prompt, parseRelevanceCount);
    return Math.max(0, Math.min(items.length, n));
  }

  private save(): void {
    writeFileSync(JUDGE_CACHE_PATH, JSON.stringify({ version: 1, entries: this.entries } satisfies CacheFile, null, 2));
  }
}

function parseIdArray(answer: string): number[] {
  const m = answer.match(/\[[\s\d,]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function parseRelevanceCount(answer: string): number {
  const m = answer.match(/"relevant"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}
