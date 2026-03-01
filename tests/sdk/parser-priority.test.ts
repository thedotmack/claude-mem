/**
 * Parser priority field tests
 *
 * Tests that the XML parser correctly extracts the <priority> field from
 * observation XML blocks, with proper validation and defaulting.
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
          { id: 'what-changed', label: 'What Changed', description: 'What Changed' },
          { id: 'problem-solution', label: 'Problem Solution', description: 'Problem Solution' },
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
// Tests
// ---------------------------------------------------------------------------

describe('parseObservations — priority field', () => {
  it('should extract priority=critical from XML', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <priority>critical</priority>
      <title>Critical finding</title>
      <concepts><concept>how-it-works</concept></concepts>
    `);

    const results = parseObservations(xml);
    expect(results).toHaveLength(1);
    expect(results[0].priority).toBe('critical');
  });

  it('should extract priority=important from XML', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <priority>important</priority>
      <title>Important finding</title>
      <concepts><concept>how-it-works</concept></concepts>
    `);

    const results = parseObservations(xml);
    expect(results).toHaveLength(1);
    expect(results[0].priority).toBe('important');
  });

  it('should extract priority=informational from XML', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <priority>informational</priority>
      <title>Routine observation</title>
      <concepts><concept>how-it-works</concept></concepts>
    `);

    const results = parseObservations(xml);
    expect(results).toHaveLength(1);
    expect(results[0].priority).toBe('informational');
  });

  it('should default to informational when priority tag is missing', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <title>No priority tag</title>
      <concepts><concept>how-it-works</concept></concepts>
    `);

    const results = parseObservations(xml);
    expect(results).toHaveLength(1);
    expect(results[0].priority).toBe('informational');
  });

  it('should default to informational when priority value is invalid', () => {
    const xml = wrapObservation(`
      <type>bugfix</type>
      <priority>urgent</priority>
      <title>Invalid priority value</title>
      <concepts><concept>problem-solution</concept></concepts>
    `);

    const results = parseObservations(xml);
    expect(results).toHaveLength(1);
    expect(results[0].priority).toBe('informational');
  });

  it('should default to informational when priority tag is empty', () => {
    const xml = wrapObservation(`
      <type>discovery</type>
      <priority></priority>
      <title>Empty priority</title>
      <concepts><concept>how-it-works</concept></concepts>
    `);

    const results = parseObservations(xml);
    expect(results).toHaveLength(1);
    expect(results[0].priority).toBe('informational');
  });

  it('should handle priority with surrounding whitespace', () => {
    const xml = wrapObservation(`
      <type>decision</type>
      <priority>  critical  </priority>
      <title>Whitespace around priority</title>
      <concepts><concept>how-it-works</concept></concepts>
    `);

    const results = parseObservations(xml);
    expect(results).toHaveLength(1);
    expect(results[0].priority).toBe('critical');
  });

  it('should parse priority for each observation in multi-observation input', () => {
    const xml = `
      ${wrapObservation(`
        <type>discovery</type>
        <priority>critical</priority>
        <title>First</title>
        <concepts><concept>how-it-works</concept></concepts>
      `)}
      ${wrapObservation(`
        <type>bugfix</type>
        <priority>important</priority>
        <title>Second</title>
        <concepts><concept>problem-solution</concept></concepts>
      `)}
      ${wrapObservation(`
        <type>discovery</type>
        <title>Third — no priority</title>
        <concepts><concept>how-it-works</concept></concepts>
      `)}
    `;

    const results = parseObservations(xml);
    expect(results).toHaveLength(3);
    expect(results[0].priority).toBe('critical');
    expect(results[1].priority).toBe('important');
    expect(results[2].priority).toBe('informational');
  });
});
