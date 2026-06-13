// Client-side, simulated agent synthesis — no server endpoint.
// Reads only in-memory data.
//
// Ported from /tmp/cmem-redesign/cmem-viewer/search-agent.jsx:7-109
// (scoreObservation 21-28, searchMemory 31-64, synthesizeAnswer 67-109).
// There is no /api/search or /api/agent endpoint; scoring and answer
// "synthesis" run entirely against the loaded ViewerData in memory.

import { fmtDayLabel } from '../utils/format.js';
import type { ViewerData, ViewerObservation } from './viewer-types.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'how', 'what', 'why', 'does',
  'did', 'is', 'are', 'was', 'were', 'do', 'we', 'our', 'you', 'your', 'when',
  'where', 'that', 'this', 'about', 'work', 'works',
]);

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function scoreText(tokens: string[], text: string | undefined | null, weight: number): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let s = 0;
  tokens.forEach((t) => {
    if (lower.includes(t)) s += weight;
  });
  return s;
}

export function scoreObservation(tokens: string[], o: ViewerObservation): number {
  return (
    scoreText(tokens, o.title, 3) +
    scoreText(tokens, (o.concepts || []).join(' '), 3) +
    scoreText(tokens, o.subtitle, 2) +
    scoreText(tokens, (o.facts || []).join(' '), 2) +
    scoreText(tokens, o.narrative, 1) +
    scoreText(tokens, (o.files_read || []).concat(o.files_modified || []).join(' '), 2)
  );
}

/** A [file, count] pair surfaced by instant search. */
export type SearchFile = [string, number];

export interface SearchResults {
  observations: ViewerObservation[];
  files: SearchFile[];
  concepts: string[];
}

// Instant string-match search across the memory DB (in-memory only).
export function searchMemory(query: string, data: ViewerData): SearchResults {
  const tokens = tokenize(query);
  const raw = query.trim().toLowerCase();
  if (!raw) return { observations: [], files: [], concepts: [] };

  const scored = data.observations
    .map((o) => ({ o, s: scoreObservation(tokens.length ? tokens : [raw], o) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.o.at - a.o.at);

  const fileSet = new Map<string, number>();
  data.observations.forEach((o) => {
    (o.files_read || []).concat(o.files_modified || []).forEach((f) => {
      if (f.toLowerCase().includes(raw) || tokens.some((t) => f.toLowerCase().includes(t))) {
        fileSet.set(f, (fileSet.get(f) || 0) + 1);
      }
    });
  });

  const conceptSet = new Map<string, number>();
  data.observations.forEach((o) => {
    (o.concepts || []).forEach((c) => {
      if (c.includes(raw) || tokens.some((t) => c.includes(t))) {
        conceptSet.set(c, (conceptSet.get(c) || 0) + 1);
      }
    });
  });

  return {
    observations: scored.slice(0, 5).map((x) => x.o),
    files: [...fileSet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    concepts: [...conceptSet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]),
  };
}

// ---------- Answer block model ----------
export interface ParagraphBlock {
  kind: 'p';
  text: string;
}
export interface BulletsBlock {
  kind: 'bullets';
  items: string[];
}
export interface CiteBlock {
  kind: 'cite';
  ids: number[];
}
export type AnswerBlock = ParagraphBlock | BulletsBlock | CiteBlock;

export interface SynthesizedAnswer {
  cited: number[];
  blocks: AnswerBlock[];
}

// ---------- Agent answer synthesis (simulated background session) ----------
// Local/simulated — no server agent endpoint. Scores in-memory observations
// and assembles a fake "answer" from their fields.
export function synthesizeAnswer(query: string, data: ViewerData): SynthesizedAnswer {
  const tokens = tokenize(query);
  const scored = data.observations
    .map((o) => ({ o, s: scoreObservation(tokens, o) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.o.at - a.o.at)
    .slice(0, 5);

  if (scored.length === 0) {
    return {
      cited: [],
      blocks: [
        {
          kind: 'p',
          text: `I went through all ${data.observations.length.toLocaleString()} observations and nothing matches “${query}” yet. Either we haven’t worked on this, or it’s phrased differently in memory.`,
        },
        {
          kind: 'p',
          text: 'Try a concept chip from the filter bar, or rephrase with a file name or identifier — exact symbols match best.',
        },
      ],
    };
  }

  const top = scored.map((x) => x.o);
  const projects = [...new Set(top.map((o) => o.project))];
  const latest = top.reduce((a, b) => (a.at > b.at ? a : b));
  const latestDay = fmtDayLabel(latest.at);
  const sessionsById = Object.fromEntries(data.sessions.map((s) => [s.id, s]));
  const latestSession = sessionsById[latest.session_id];

  const bullets: string[] = [];
  top.forEach((o) => {
    const best = (o.facts || [])
      .map((f) => ({ f, s: scoreText(tokens, f, 1) }))
      .sort((a, b) => b.s - a.s)[0];
    if (best) bullets.push(best.f);
  });

  const blocks: AnswerBlock[] = [
    {
      kind: 'p',
      text: `I found ${top.length} ${top.length === 1 ? 'memory' : 'memories'} about “${query}” across ${projects.join(' and ')} — most recently “${latest.title}” from ${
        latestDay.lead.toLowerCase() === 'today' || latestDay.lead.toLowerCase() === 'yesterday'
          ? latestDay.lead.toLowerCase()
          : latestDay.rest
      }.`,
    },
    { kind: 'bullets', items: bullets.slice(0, 4) },
  ];
  if (latestSession && latestSession.next_steps) {
    blocks.push({ kind: 'p', text: `Open thread from that work: ${latestSession.next_steps}` });
  }
  blocks.push({ kind: 'cite', ids: top.map((o) => o.id) });
  return { cited: top.map((o) => o.id), blocks };
}
