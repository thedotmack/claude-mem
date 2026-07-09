// CMEM Viewer — DB-row normalization adapter.
// Ported from /tmp/cmem-redesign/cmem-viewer/live-data.js:24-148.
// Input rows are the production DB shapes (types.ts: Observation/Summary/UserPrompt),
// possibly with already-parsed values. Output is the normalized viewer shape.

import type { Observation, Summary, UserPrompt } from '../types';
import type {
  ViewerData,
  ViewerObservation,
  ViewerPrompt,
  ViewerSession
} from './viewer-types';

// A list column may arrive as an array (already parsed), a JSON/CSV string, or null.
type ListInput = string | string[] | null | undefined;

// Worker rows store epochs in ms (sample data uses seconds) — normalize to seconds.
export const toSec = (e: number | string | null | undefined): number => {
  const n = Number(e);
  if (!n || Number.isNaN(n)) return Math.floor(Date.now() / 1000);
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
};

// facts / concepts / files_* columns are JSON strings (or NULL on legacy rows).
export const parseList = (v: ListInput): string[] => {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (v === null || v === undefined || v === '') return [];
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      if (Array.isArray(p)) return p.filter(Boolean).map(String);
    } catch {
      /* not JSON — fall through to CSV */
    }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

export const truncate = (s: string | null | undefined, n: number): string => {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

// Rows may carry already-parsed list values or extra fields not on the strict DB type.
type ObservationRow = Observation & {
  session_id?: string;
  facts?: ListInput;
  concepts?: ListInput;
  files_read?: ListInput;
  files_modified?: ListInput;
};

export function normObservation(row: ObservationRow): ViewerObservation {
  const narrative = row.narrative || row.text || '';
  return {
    id: row.id,
    session_id: row.memory_session_id || row.session_id || 'unknown-session',
    project: row.project || 'unknown',
    type: row.type || 'feature',
    title: row.title || truncate(narrative, 80) || 'Untitled observation',
    subtitle: row.subtitle || '',
    narrative,
    facts: parseList(row.facts),
    concepts: parseList(row.concepts),
    files_read: parseList(row.files_read),
    files_modified: parseList(row.files_modified),
    at: toSec(row.created_at_epoch != null ? row.created_at_epoch : row.created_at)
  };
}

// Normalized summary — internal shape used by buildData to enrich sessions.
export interface NormalizedSummary {
  session_id: string;
  project: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  at: number;
}

type SummaryRow = Summary & { memory_session_id?: string };

export function normSummary(row: SummaryRow): NormalizedSummary {
  return {
    session_id: row.session_id || row.memory_session_id || 'unknown-session',
    project: row.project || 'unknown',
    request: row.request || '',
    investigated: row.investigated || '',
    learned: row.learned || '',
    completed: row.completed || '',
    next_steps: row.next_steps || '',
    at: toSec(row.created_at_epoch)
  };
}

type PromptRow = UserPrompt & { session_id?: string; text?: string };

export function normPrompt(row: PromptRow): ViewerPrompt {
  return {
    id: 'prompt-' + row.id,
    session_id: row.content_session_id || row.session_id || 'unknown-session',
    project: row.project || 'unknown',
    text: row.prompt_text || row.text || '',
    n: row.prompt_number || 0,
    at: toSec(row.created_at_epoch)
  };
}

export interface NormalizedRaw {
  observations: ViewerObservation[];
  summaries: NormalizedSummary[];
  prompts: ViewerPrompt[];
}

// ---------- data shaping ----------
// Build the viewer's { sessions, prompts, observations } from normalized rows.
// Sessions are synthesized for every memory_session_id seen in observations;
// summaries enrich them when present.
export function buildData(raw: NormalizedRaw): ViewerData {
  const observations = raw.observations;

  const sumBySession: Record<string, NormalizedSummary> = {};
  raw.summaries.forEach((s) => {
    const prev = sumBySession[s.session_id];
    if (!prev || s.at >= prev.at) sumBySession[s.session_id] = s;
  });

  const promptBySession: Record<string, ViewerPrompt> = {};
  raw.prompts.forEach((p) => {
    if (!p.text) return;
    const prev = promptBySession[p.session_id];
    if (!prev || (p.n || Infinity) < (prev.n || Infinity) || p.at < prev.at) {
      promptBySession[p.session_id] = p;
    }
  });

  const obsBySession: Record<string, ViewerObservation[]> = {};
  observations.forEach((o) => {
    (obsBySession[o.session_id] = obsBySession[o.session_id] || []).push(o);
  });

  const sessions: ViewerSession[] = Object.keys(obsBySession).map((sid) => {
    const list = obsBySession[sid];
    let started = Infinity;
    let ended = -Infinity;
    list.forEach((o) => {
      if (o.at < started) started = o.at;
      if (o.at > ended) ended = o.at;
    });
    const sum = sumBySession[sid];
    const pr = promptBySession[sid];
    return {
      id: sid,
      project: (sum && sum.project) || list[0].project,
      started: started === Infinity ? toSec(null) : started,
      ended: ended === -Infinity ? toSec(null) : ended,
      request: (sum && sum.request) || (pr && truncate(pr.text, 110)) || list[0].title,
      investigated: (sum && sum.investigated) || '',
      learned: (sum && sum.learned) || '',
      completed: (sum && sum.completed) || '',
      next_steps: (sum && sum.next_steps) || '',
      hasSummary: !!sum
    };
  });

  return {
    sessions,
    prompts: Object.values(promptBySession).map((p) => ({ ...p, text: truncate(p.text, 400) })),
    observations,
    seedNotes: []
  };
}
