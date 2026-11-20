import { describe, expect, it } from 'bun:test';
import { observationEmbeddingParts } from '../../src/storage/postgres/observation-embeddings.js';
import { ChromaSync } from '../../src/services/sync/ChromaSync.js';

// The worker (ChromaSync documents) and the server (embedding parts) must
// embed the same texts under the same names for the same observation, so
// search by meaning finds the same things in both and vectors carried over
// from Chroma line up with the server's parts. Each fixture runs through
// both; a divergence fails here rather than surfacing as a search difference.
//
// Ranking is not part of this contract: the worker ranks by Chroma, within a
// 90-day window (CLAUDE_MEM_SEARCH_RECENCY_DAYS), and fills an empty category
// from SQLite; the server fuses keyword and vector ranks.
// That difference is measured, not asserted, in
// rich-murphey/claude-mem-search-eval.

interface ObservationFixture {
  name: string;
  narrative?: string | null;
  text?: string | null;
  facts?: string[];
  title?: string | null;
  subtitle?: string | null;
}

const observations: ObservationFixture[] = [
  { name: 'narrative and facts', narrative: 'The gateway moved.', facts: ['DNS changed', 'TLS renewed'] },
  { name: 'blank facts are skipped and the rest renumbered', narrative: 'n', facts: ['a', '', '  ', 'd'] },
  { name: 'legacy text', text: 'imported legacy text', facts: ['f'] },
  { name: 'title and subtitle when nothing else', title: 'A title', subtitle: 'a subtitle' },
  { name: 'the Untitled placeholder is dropped', title: 'Untitled', subtitle: 'only the subtitle' },
];

function workerParts(fixture: ObservationFixture): Array<{ part: string; text: string }> {
  const docs = (new ChromaSync('contract') as any).formatObservationDocs({
    id: 7,
    memory_session_id: 'm',
    project: 'contract',
    merged_into_project: null,
    platform_source: 'claude',
    text: fixture.text ?? null,
    type: 'discovery',
    title: fixture.title ?? null,
    subtitle: fixture.subtitle ?? null,
    facts: JSON.stringify(fixture.facts ?? []),
    narrative: fixture.narrative ?? null,
    concepts: JSON.stringify([]),
    files_read: JSON.stringify([]),
    files_modified: JSON.stringify([]),
    prompt_number: 1,
    created_at_epoch: 0,
  });
  return docs.map((doc: { id: string; document: string }) => ({ part: doc.id.replace(/^obs_7_/, ''), text: doc.document }));
}

function serverParts(fixture: ObservationFixture): Array<{ part: string; text: string }> {
  return observationEmbeddingParts('discovery', {
    ...(fixture.narrative != null ? { narrative: fixture.narrative } : {}),
    ...(fixture.text != null ? { legacy: { text: fixture.text } } : {}),
    ...(fixture.facts ? { facts: fixture.facts } : {}),
    ...(fixture.title != null ? { title: fixture.title } : {}),
    ...(fixture.subtitle != null ? { subtitle: fixture.subtitle } : {}),
    // Chroma's documents carry only the structured fields, so the server's
    // extra content part (for rows without narrative or facts) is left out.
  }, '');
}

describe('worker and server embed the same parts', () => {
  for (const fixture of observations) {
    it(`observation: ${fixture.name}`, () => {
      expect(serverParts(fixture)).toEqual(workerParts(fixture));
    });
  }

  it('summary: one part per non-empty field, in the same order', () => {
    const summary = {
      request: 'r', investigated: null, learned: 'l', completed: 'c', next_steps: null, notes: 'n',
    };
    const docs = (new ChromaSync('contract') as any).formatSummaryDocs({
      id: 9, memory_session_id: 'm', project: 'contract', merged_into_project: null, platform_source: 'claude',
      prompt_number: 1, created_at_epoch: 0, ...summary,
    });
    const worker = docs.map((doc: { id: string; document: string }) => ({ part: doc.id.replace(/^summary_9_/, ''), text: doc.document }));
    expect(observationEmbeddingParts('summary', summary, 'rendered content')).toEqual(worker);
  });
});
