/**
 * Parser enrichment field tests (Task 4)
 *
 * Tests that the XML parser correctly extracts topics, entities, and event_date
 * from observation XML blocks. Entities use a custom attribute-based XML format:
 * <entity type="person|system|team|technology|component">name</entity>
 */

import { describe, it, expect, vi } from 'vitest';

// Mock ModeManager before importing parser
vi.mock('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [
          { id: 'discovery', label: 'Discovery', description: 'Discovery', emoji: '', work_emoji: '' },
          { id: 'bugfix', label: 'Bugfix', description: 'Bugfix', emoji: '', work_emoji: '' },
          { id: 'decision', label: 'Decision', description: 'Decision', emoji: '', work_emoji: '' },
        ],
        observation_concepts: [
          { id: 'how-it-works', label: 'How It Works', description: 'How It Works' },
        ],
      }),
    }),
  },
}));

import { parseObservations } from '../../src/sdk/parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapObservation(fields: string): string {
  return `<observation>${fields}</observation>`;
}

// ---------------------------------------------------------------------------
// Topics extraction
// ---------------------------------------------------------------------------

describe('parseObservations — topics extraction', () => {
  it('should extract topics array from XML', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>Auth migration</title>
      <topics>
        <topic>authentication</topic>
        <topic>migration</topic>
        <topic>deployment</topic>
      </topics>
    `);
    const result = parseObservations(xml);
    expect(result).toHaveLength(1);
    expect(result[0].topics).toEqual(['authentication', 'migration', 'deployment']);
  });

  it('should return empty array when topics block is missing', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>No topics</title>
    `);
    const result = parseObservations(xml);
    expect(result).toHaveLength(1);
    expect(result[0].topics).toEqual([]);
  });

  it('should return empty array when topics block is empty', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>Empty topics</title>
      <topics></topics>
    `);
    const result = parseObservations(xml);
    expect(result).toHaveLength(1);
    expect(result[0].topics).toEqual([]);
  });

  it('should trim whitespace from topic values', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <topics>
        <topic>  auth  </topic>
        <topic>
          migration
        </topic>
      </topics>
    `);
    const result = parseObservations(xml);
    expect(result[0].topics).toEqual(['auth', 'migration']);
  });
});

// ---------------------------------------------------------------------------
// Entities extraction
// ---------------------------------------------------------------------------

describe('parseObservations — entities extraction', () => {
  it('should extract entities with name and type from XML', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>Sprint planning</title>
      <entities>
        <entity type="person">Alice</entity>
        <entity type="team">Backend</entity>
        <entity type="system">Kubernetes</entity>
      </entities>
    `);
    const result = parseObservations(xml);
    expect(result).toHaveLength(1);
    expect(result[0].entities).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'Backend', type: 'team' },
      { name: 'Kubernetes', type: 'system' },
    ]);
  });

  it('should return empty array when entities block is missing', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>No entities</title>
    `);
    const result = parseObservations(xml);
    expect(result).toHaveLength(1);
    expect(result[0].entities).toEqual([]);
  });

  it('should return empty array when entities block is empty', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <entities></entities>
    `);
    const result = parseObservations(xml);
    expect(result[0].entities).toEqual([]);
  });

  it('should fall back invalid entity type to "component"', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <entities>
        <entity type="banana">SomeWidget</entity>
        <entity type="person">Alice</entity>
        <entity type="">Unknown</entity>
      </entities>
    `);
    const result = parseObservations(xml);
    expect(result[0].entities).toEqual([
      { name: 'SomeWidget', type: 'component' },
      { name: 'Alice', type: 'person' },
      { name: 'Unknown', type: 'component' },
    ]);
  });

  it('should handle all valid entity types', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <entities>
        <entity type="person">Alice</entity>
        <entity type="system">Redis</entity>
        <entity type="team">DevOps</entity>
        <entity type="technology">TypeScript</entity>
        <entity type="component">SessionStore</entity>
      </entities>
    `);
    const result = parseObservations(xml);
    expect(result[0].entities).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'Redis', type: 'system' },
      { name: 'DevOps', type: 'team' },
      { name: 'TypeScript', type: 'technology' },
      { name: 'SessionStore', type: 'component' },
    ]);
  });

  it('should trim whitespace from entity names', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <entities>
        <entity type="person">  Alice  </entity>
        <entity type="team">
          Backend
        </entity>
      </entities>
    `);
    const result = parseObservations(xml);
    expect(result[0].entities).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'Backend', type: 'team' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// event_date extraction
// ---------------------------------------------------------------------------

describe('parseObservations — event_date extraction', () => {
  it('should extract valid ISO8601 date', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>Deadline moved</title>
      <event_date>2026-03-15</event_date>
    `);
    const result = parseObservations(xml);
    expect(result[0].event_date).toBe('2026-03-15');
  });

  it('should return null when event_date is missing', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>No date</title>
    `);
    const result = parseObservations(xml);
    expect(result[0].event_date).toBeNull();
  });

  it('should return null for invalid date format', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <event_date>March 15th</event_date>
    `);
    const result = parseObservations(xml);
    expect(result[0].event_date).toBeNull();
  });

  it('should return null for empty event_date', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <event_date></event_date>
    `);
    const result = parseObservations(xml);
    expect(result[0].event_date).toBeNull();
  });

  it('should return null for date with invalid month/day', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <event_date>2026-13-45</event_date>
    `);
    const result = parseObservations(xml);
    expect(result[0].event_date).toBeNull();
  });

  it('should accept edge-case valid dates', () => {
    const xml1 = wrapObservation(`<type>discovery</type><event_date>2026-01-01</event_date>`);
    const xml2 = wrapObservation(`<type>discovery</type><event_date>2026-12-31</event_date>`);
    expect(parseObservations(xml1)[0].event_date).toBe('2026-01-01');
    expect(parseObservations(xml2)[0].event_date).toBe('2026-12-31');
  });
});

// ---------------------------------------------------------------------------
// Full observation with all enrichment fields
// ---------------------------------------------------------------------------

describe('parseObservations — full enrichment integration', () => {
  it('should parse all enrichment fields alongside existing fields', () => {
    const xml = wrapObservation(`
      <type>decision</type>
      <priority>important</priority>
      <title>Auth migration deadline</title>
      <subtitle>Sprint planning outcome</subtitle>
      <narrative>Alice mentioned the auth migration is blocked by backend team. Deadline moved to March 15th.</narrative>
      <facts>
        <fact>Auth migration deadline moved to March 15th</fact>
        <fact>Backend team is blocking</fact>
      </facts>
      <concepts>
        <concept>how-it-works</concept>
      </concepts>
      <files_read>
        <file>src/auth/config.ts</file>
      </files_read>
      <files_modified>
        <file>src/auth/middleware.ts</file>
      </files_modified>
      <topics>
        <topic>authentication</topic>
        <topic>migration</topic>
      </topics>
      <entities>
        <entity type="person">Alice</entity>
        <entity type="team">Backend</entity>
      </entities>
      <event_date>2026-03-15</event_date>
    `);
    const result = parseObservations(xml);
    expect(result).toHaveLength(1);
    const obs = result[0];

    // Existing fields still work
    expect(obs.type).toBe('decision');
    expect(obs.priority).toBe('important');
    expect(obs.title).toBe('Auth migration deadline');
    expect(obs.subtitle).toBe('Sprint planning outcome');
    expect(obs.narrative).toContain('Alice mentioned');
    expect(obs.facts).toEqual(['Auth migration deadline moved to March 15th', 'Backend team is blocking']);
    expect(obs.concepts).toEqual(['how-it-works']);
    expect(obs.files_read).toEqual(['src/auth/config.ts']);
    expect(obs.files_modified).toEqual(['src/auth/middleware.ts']);

    // New enrichment fields
    expect(obs.topics).toEqual(['authentication', 'migration']);
    expect(obs.entities).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'Backend', type: 'team' },
    ]);
    expect(obs.event_date).toBe('2026-03-15');
  });
});
