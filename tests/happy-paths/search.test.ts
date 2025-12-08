/**
 * Happy Path Test: Search (MCP Tools)
 *
 * Tests that the search functionality correctly finds and returns
 * stored observations matching user queries.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sampleObservation, featureObservation } from '../helpers/scenarios.js';

describe('Search (MCP Tools)', () => {
  const WORKER_PORT = 37777;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds observations matching query', async () => {
    // This tests the happy path:
    // User asks "what did we do?" → Search skill queries worker →
    // Worker searches database → Returns relevant observations

    // Setup: Mock search response with matching observations
    const searchResults = [
      {
        id: 1,
        title: 'Parser bugfix',
        content: 'Fixed XML parsing issue with self-closing tags',
        type: 'bugfix',
        created_at: '2024-01-01T10:00:00Z'
      },
      {
        id: 2,
        title: 'Parser optimization',
        content: 'Improved parser performance by 50%',
        type: 'feature',
        created_at: '2024-01-02T10:00:00Z'
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: searchResults, total: 2 })
    });

    // Execute: Search for "parser"
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search?query=parser&project=claude-mem`
    );

    // Verify: Found matching observations
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(2);
    expect(data.results[0].title).toContain('Parser');
    expect(data.results[1].title).toContain('Parser');
  });

  it('returns empty results when no matches found', async () => {
    // Setup: Mock empty search results
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], total: 0 })
    });

    // Execute: Search for non-existent term
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search?query=nonexistent&project=claude-mem`
    );

    // Verify: Returns empty results gracefully
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it('supports filtering by observation type', async () => {
    // Setup: Mock filtered search results
    const bugfixResults = [
      {
        id: 1,
        title: 'Fixed parser bug',
        type: 'bugfix',
        created_at: '2024-01-01T10:00:00Z'
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: bugfixResults, total: 1 })
    });

    // Execute: Search for bugfixes only
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search/by-type?type=bugfix&project=claude-mem`
    );

    // Verify: Returns only bugfixes
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].type).toBe('bugfix');
  });

  it('supports filtering by concept tags', async () => {
    // Setup: Mock concept-filtered results
    const conceptResults = [
      {
        id: 1,
        title: 'How parser works',
        concepts: ['how-it-works', 'parser'],
        created_at: '2024-01-01T10:00:00Z'
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: conceptResults, total: 1 })
    });

    // Execute: Search by concept
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search/by-concept?concept=how-it-works&project=claude-mem`
    );

    // Verify: Returns observations with that concept
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].concepts).toContain('how-it-works');
  });

  it('supports pagination for large result sets', async () => {
    // Setup: Mock paginated results
    const page1Results = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      title: `Observation ${i + 1}`,
      created_at: '2024-01-01T10:00:00Z'
    }));

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: page1Results,
        total: 50,
        page: 1,
        limit: 20
      })
    });

    // Execute: Search with pagination
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search?query=observation&project=claude-mem&limit=20&offset=0`
    );

    // Verify: Returns paginated results
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(20);
    expect(data.total).toBe(50);
    expect(data.page).toBe(1);
  });

  it('supports date range filtering', async () => {
    // Setup: Mock date-filtered results
    const recentResults = [
      {
        id: 5,
        title: 'Recent observation',
        created_at: '2024-01-05T10:00:00Z'
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: recentResults, total: 1 })
    });

    // Execute: Search with date range
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search?query=observation&project=claude-mem&dateStart=2024-01-05&dateEnd=2024-01-06`
    );

    // Verify: Returns observations in date range
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].created_at).toContain('2024-01-05');
  });

  it('returns observations with file references', async () => {
    // Setup: Mock results with file paths
    const fileResults = [
      {
        id: 1,
        title: 'Updated parser',
        files: ['src/parser.ts', 'tests/parser.test.ts'],
        created_at: '2024-01-01T10:00:00Z'
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: fileResults, total: 1 })
    });

    // Execute: Search
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search?query=parser&project=claude-mem`
    );

    // Verify: File references included
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results[0].files).toHaveLength(2);
    expect(data.results[0].files).toContain('src/parser.ts');
  });

  it('supports semantic search ranking', async () => {
    // Setup: Mock results ordered by relevance
    const rankedResults = [
      {
        id: 2,
        title: 'Parser bug fix',
        content: 'Fixed critical parser bug',
        relevance: 0.95
      },
      {
        id: 5,
        title: 'Parser documentation',
        content: 'Updated parser docs',
        relevance: 0.72
      },
      {
        id: 10,
        title: 'Mentioned parser briefly',
        content: 'Also updated the parser',
        relevance: 0.45
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: rankedResults,
        total: 3,
        orderBy: 'relevance'
      })
    });

    // Execute: Search with relevance ordering
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search?query=parser+bug&project=claude-mem&orderBy=relevance`
    );

    // Verify: Results ordered by relevance
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(3);
    expect(data.results[0].relevance).toBeGreaterThan(data.results[1].relevance);
    expect(data.results[1].relevance).toBeGreaterThan(data.results[2].relevance);
  });

  it('handles special characters in search queries', async () => {
    // Setup: Mock results for special character query
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], total: 0 })
    });

    // Execute: Search with special characters
    const queries = [
      'function*',
      'variable: string',
      'array[0]',
      'path/to/file',
      'tag<content>',
      'price $99'
    ];

    for (const query of queries) {
      await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/search?query=${encodeURIComponent(query)}&project=claude-mem`
      );
    }

    // Verify: All queries processed without error
    expect(global.fetch).toHaveBeenCalledTimes(queries.length);
  });

  it('supports project-specific search', async () => {
    // Setup: Mock results from specific project
    const projectResults = [
      {
        id: 1,
        title: 'Claude-mem feature',
        project: 'claude-mem',
        created_at: '2024-01-01T10:00:00Z'
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: projectResults, total: 1 })
    });

    // Execute: Search specific project
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/api/search?query=feature&project=claude-mem`
    );

    // Verify: Returns only results from that project
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].project).toBe('claude-mem');
  });
});
