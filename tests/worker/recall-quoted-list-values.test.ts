import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { ProgressiveMemorySearch } from '../../src/services/worker/ProgressiveMemorySearch.js';
import { projectMemoryContent } from '../../src/shared/progressive-search.js';
import { formatMcpPayload } from '../../src/servers/mcp-text-format.js';

describe('quoted legacy list values in selected memory details', () => {
  let store: SessionStore;
  const project = 'legacy-quoted-lists';
  let id: number;
  const fact = 'Deploy only after the queue drains.';

  beforeEach(() => {
    store = new SessionStore(':memory:');
    const memory = store.getOrCreateManualSession(project);
    const now = new Date();
    id = store.importObservation({ memory_session_id: memory, project, type: 'decision',
      title: 'Legacy deployment fact', subtitle: null, text: null, narrative: null,
      facts: JSON.stringify(fact), concepts: JSON.stringify('deployment'),
      files_read: JSON.stringify('src/config.ts'), files_modified: JSON.stringify('src/deploy.ts'),
      prompt_number: 1, discovery_tokens: 0, created_at: now.toISOString(), created_at_epoch: now.getTime(),
      metadata: '{"private":"PRIVATE_METADATA"}',
    }).id;
  });
  afterEach(() => store.close());

  it('renders imported SQLite evidence in selected MCP details without changing storage', () => {
    const rows = store.getObservationsByIds([id]);
    const text = formatMcpPayload('observations', rows).content[0].text;
    expect(text).toContain(`- ${fact}`);
    expect(text).toContain('Concepts: deployment');
    expect(text).toContain('Files read: src/config.ts');
    expect(text).toContain('Files changed: src/deploy.ts');
    expect(text).not.toContain('PRIVATE_METADATA');
    expect(store.getObservationById(id)?.facts).toBe(JSON.stringify(fact));
  });

  it('keeps the same evidence through the complete dumb-search selection path', async () => {
    const manager = new SearchManager(new SessionSearch(store.db), store, null,
      new FormattingService(), new TimelineService());
    const result = await new ProgressiveMemorySearch(manager, store).run({ query: 'deployment', project,
      limit: 1, maxDetails: 1, depthBefore: 0, depthAfter: 0 });
    expect(result.step).toBe(3);
    expect(result.observations.map(row => row.id)).toEqual([String(id)]);
    expect(result.observations[0].content).toContain(fact);
    expect(result.observations[0].content).toContain('Files changed: src/deploy.ts');
  });

  it('applies the existing UTF-8 fact budget and reports clipping for quoted text', () => {
    const projected = projectMemoryContent({ facts: JSON.stringify('😀'.repeat(1000)) });
    expect(projected.text).toBe('- ' + '😀'.repeat(400));
    expect(projected.truncated).toBe(true);
    expect(projected.text).not.toContain('\ufffd');
  });

  it('keeps array and plain-text fallbacks while excluding non-string values', () => {
    expect(projectMemoryContent({ facts: ['one', null, 2, 'two'], concepts: 'plain concept',
      files_read: JSON.stringify(['src/a.ts', false]) }).text)
      .toBe('- one\n- two\n\nFiles read: src/a.ts\n\nConcepts: plain concept');
    for (const raw of ['null', 'true', '42', '{"secret":"PRIVATE_OBJECT"}']) {
      expect(projectMemoryContent({ facts: raw, concepts: raw, files_read: raw }).text).toBe('');
    }
    const literalNote = '{"facts":"This is a JSON example in note prose."}';
    expect(projectMemoryContent(literalNote).text).toBe(literalNote);
  });
});
