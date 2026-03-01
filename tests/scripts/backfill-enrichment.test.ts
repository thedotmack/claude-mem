/**
 * Backfill pipeline tests (Task 10)
 *
 * Tests for the backfill-enrichment script's core logic:
 * - Extraction prompt construction
 * - JSON response parsing and validation
 * - Entity type validation with fallback
 * - Event date validation (ISO8601)
 * - Checkpoint resume (skip already-enriched rows)
 * - DB update with enrichment data
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Import backfill utilities (will be created in GREEN phase)
// ---------------------------------------------------------------------------

import {
  buildExtractionPrompt,
  parseExtractionResponse,
  validateEntityTypes,
  validateEventDate,
  getUnenrichedObservations,
  updateObservationEnrichment,
} from '../../src/scripts/backfill-enrichment.js';

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// buildExtractionPrompt
// ---------------------------------------------------------------------------

describe('buildExtractionPrompt', () => {
  it('should include title in prompt', () => {
    const prompt = buildExtractionPrompt({
      title: 'Auth migration',
      subtitle: null,
      narrative: 'Migrating from JWT to OAuth2',
      facts: '["fact-1"]',
      concepts: '["how-it-works"]',
    });
    expect(prompt).toContain('Auth migration');
  });

  it('should include narrative in prompt', () => {
    const prompt = buildExtractionPrompt({
      title: 'Test',
      subtitle: null,
      narrative: 'Redis cache invalidation strategy',
      facts: '[]',
      concepts: '[]',
    });
    expect(prompt).toContain('Redis cache invalidation strategy');
  });

  it('should include facts in prompt', () => {
    const prompt = buildExtractionPrompt({
      title: 'Test',
      subtitle: null,
      narrative: null,
      facts: '["uses Redis for caching","expiry set to 1h"]',
      concepts: '[]',
    });
    expect(prompt).toContain('uses Redis for caching');
  });

  it('should request JSON output', () => {
    const prompt = buildExtractionPrompt({
      title: 'Test',
      subtitle: null,
      narrative: 'Test narrative',
      facts: '[]',
      concepts: '[]',
    });
    expect(prompt).toContain('topics');
    expect(prompt).toContain('entities');
    expect(prompt).toContain('event_date');
    expect(prompt).toContain('JSON');
  });

  it('should handle null narrative gracefully', () => {
    const prompt = buildExtractionPrompt({
      title: 'Test',
      subtitle: null,
      narrative: null,
      facts: '["fact-1"]',
      concepts: '[]',
    });
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseExtractionResponse
// ---------------------------------------------------------------------------

describe('parseExtractionResponse', () => {
  it('should parse valid JSON response', () => {
    const json = JSON.stringify({
      topics: ['auth', 'migration'],
      entities: [{ name: 'Alice', type: 'person' }],
      event_date: '2026-03-15',
    });
    const result = parseExtractionResponse(json);
    expect(result).not.toBeNull();
    expect(result!.topics).toEqual(['auth', 'migration']);
    expect(result!.entities).toEqual([{ name: 'Alice', type: 'person' }]);
    expect(result!.event_date).toBe('2026-03-15');
  });

  it('should return null for malformed JSON', () => {
    const result = parseExtractionResponse('{broken json');
    expect(result).toBeNull();
  });

  it('should return null for JSON without topics', () => {
    const result = parseExtractionResponse(JSON.stringify({ entities: [] }));
    expect(result).toBeNull();
  });

  it('should return null for JSON with non-array topics', () => {
    const result = parseExtractionResponse(JSON.stringify({ topics: 'auth', entities: [] }));
    expect(result).toBeNull();
  });

  it('should extract JSON from markdown code block', () => {
    const response = '```json\n{"topics":["auth"],"entities":[],"event_date":null}\n```';
    const result = parseExtractionResponse(response);
    expect(result).not.toBeNull();
    expect(result!.topics).toEqual(['auth']);
  });

  it('should default event_date to null when missing', () => {
    const json = JSON.stringify({ topics: ['test'], entities: [] });
    const result = parseExtractionResponse(json);
    expect(result).not.toBeNull();
    expect(result!.event_date).toBeNull();
  });

  it('should default entities to empty array when missing', () => {
    const json = JSON.stringify({ topics: ['test'] });
    const result = parseExtractionResponse(json);
    expect(result).not.toBeNull();
    expect(result!.entities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateEntityTypes
// ---------------------------------------------------------------------------

describe('validateEntityTypes', () => {
  it('should pass through valid entity types', () => {
    const entities = [
      { name: 'Alice', type: 'person' },
      { name: 'Redis', type: 'system' },
    ];
    const result = validateEntityTypes(entities);
    expect(result).toEqual(entities);
  });

  it('should fall back invalid types to component', () => {
    const entities = [
      { name: 'Widget', type: 'banana' },
      { name: 'Alice', type: 'person' },
    ];
    const result = validateEntityTypes(entities);
    expect(result).toEqual([
      { name: 'Widget', type: 'component' },
      { name: 'Alice', type: 'person' },
    ]);
  });

  it('should handle empty array', () => {
    expect(validateEntityTypes([])).toEqual([]);
  });

  it('should validate all 5 entity types', () => {
    const entities = [
      { name: 'A', type: 'person' },
      { name: 'B', type: 'system' },
      { name: 'C', type: 'team' },
      { name: 'D', type: 'technology' },
      { name: 'E', type: 'component' },
    ];
    const result = validateEntityTypes(entities);
    expect(result).toEqual(entities);
  });
});

// ---------------------------------------------------------------------------
// validateEventDate
// ---------------------------------------------------------------------------

describe('validateEventDate (backfill)', () => {
  it('should accept valid ISO8601 date', () => {
    expect(validateEventDate('2026-03-15')).toBe('2026-03-15');
  });

  it('should return null for invalid date format', () => {
    expect(validateEventDate('March 15th')).toBeNull();
  });

  it('should return null for null input', () => {
    expect(validateEventDate(null)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(validateEventDate('')).toBeNull();
  });

  it('should return null for invalid month/day', () => {
    expect(validateEventDate('2026-13-45')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

describe('getUnenrichedObservations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT 'default',
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        narrative TEXT,
        facts TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        priority TEXT DEFAULT 'informational',
        topics TEXT,
        entities TEXT,
        event_date TEXT,
        pinned INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    const insert = db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts,
        files_read, files_modified, topics, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Unenriched observation
    insert.run('sess-1', 'proj', 'discovery', 'Unenriched', 'Narrative',
      '["fact"]', '["how-it-works"]', '[]', '[]', null, new Date().toISOString(), Date.now());

    // Already enriched observation
    insert.run('sess-1', 'proj', 'discovery', 'Enriched', 'Narrative',
      '["fact"]', '["how-it-works"]', '[]', '[]', '["auth"]', new Date().toISOString(), Date.now());
  });

  afterEach(() => {
    db.close();
  });

  it('should return only unenriched observations', () => {
    const rows = getUnenrichedObservations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Unenriched');
  });

  it('should respect limit parameter', () => {
    // Add more unenriched
    const insert = db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts,
        files_read, files_modified, topics, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 10; i++) {
      insert.run('sess-1', 'proj', 'discovery', `Obs ${i}`, 'Narrative',
        '[]', '[]', '[]', '[]', null, new Date().toISOString(), Date.now());
    }
    const rows = getUnenrichedObservations(db, 5);
    expect(rows).toHaveLength(5);
  });
});

describe('updateObservationEnrichment', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT 'default',
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        narrative TEXT,
        facts TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        priority TEXT DEFAULT 'informational',
        topics TEXT,
        entities TEXT,
        event_date TEXT,
        pinned INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts,
        files_read, files_modified, created_at, created_at_epoch)
      VALUES ('sess-1', 'proj', 'discovery', 'Test', 'Narrative', '[]', '[]', '[]', '[]', ?, ?)
    `).run(new Date().toISOString(), Date.now());
  });

  afterEach(() => {
    db.close();
  });

  it('should update observation with enrichment data', () => {
    updateObservationEnrichment(db, 1, {
      topics: ['auth', 'migration'],
      entities: [{ name: 'Alice', type: 'person' }],
      event_date: '2026-03-15',
    });

    const row = db.prepare('SELECT topics, entities, event_date FROM observations WHERE id = 1').get() as Record<string, unknown>;
    expect(JSON.parse(row.topics as string)).toEqual(['auth', 'migration']);
    expect(JSON.parse(row.entities as string)).toEqual([{ name: 'Alice', type: 'person' }]);
    expect(row.event_date).toBe('2026-03-15');
  });

  it('should coerce empty arrays to NULL', () => {
    updateObservationEnrichment(db, 1, {
      topics: [],
      entities: [],
      event_date: null,
    });

    const row = db.prepare('SELECT topics, entities, event_date FROM observations WHERE id = 1').get() as Record<string, unknown>;
    expect(row.topics).toBeNull();
    expect(row.entities).toBeNull();
    expect(row.event_date).toBeNull();
  });
});
