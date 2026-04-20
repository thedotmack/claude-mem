import { describe, it, expect, mock } from 'bun:test';

// Mock ModeManager before importing parser (it's used at module load time)
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'bugfix' }, { id: 'discovery' }, { id: 'refactor' }],
      }),
    }),
  },
}));

import { parseObservations } from '../../src/sdk/parser.js';

describe('parseObservations', () => {
  it('returns a populated observation when title is present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Found a bug in auth module</title>
      <narrative>The token refresh logic skips expired tokens.</narrative>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Found a bug in auth module');
    expect(result[0].type).toBe('discovery');
    expect(result[0].narrative).toBe('The token refresh logic skips expired tokens.');
  });

  it('returns a populated observation when only narrative is present (no title)', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <narrative>Patched the null pointer dereference in session handler.</narrative>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBeNull();
    expect(result[0].narrative).toBe('Patched the null pointer dereference in session handler.');
  });

  it('returns a populated observation when only facts are present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <facts><fact>File limit is hardcoded to 5</fact></facts>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].facts).toEqual(['File limit is hardcoded to 5']);
  });

  it('returns a populated observation when only concepts are present', () => {
    const xml = `<observation>
      <type>refactor</type>
      <concepts><concept>dependency-injection</concept></concepts>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['dependency-injection']);
  });

  // Regression test for issue #1625:
  // Ghost observations (all content fields null/empty) must be filtered out.
  it('filters out ghost observations where all content fields are null (#1625)', () => {
    const xml = `<observation>
      <type>bugfix</type>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(0);
  });

  it('filters out ghost observation with empty tags but no text content (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title></title>
      <narrative>   </narrative>
      <facts></facts>
      <concepts></concepts>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(0);
  });

  it('filters out multiple ghost observations while keeping valid ones (#1625)', () => {
    const xml = `
      <observation><type>bugfix</type></observation>
      <observation>
        <type>discovery</type>
        <title>Real observation</title>
      </observation>
      <observation><type>refactor</type><title></title><narrative>  </narrative></observation>
    `;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Real observation');
  });

  // Subtitle alone is explicitly excluded from the content guard (see parser comment).
  // An observation with only a subtitle is too thin to be useful and must be filtered.
  it('filters out observation with only a subtitle (excluded from survival criteria) (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <subtitle>Only a subtitle, no real content</subtitle>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(0);
  });

  it('uses first mode type as fallback when type is missing', () => {
    const xml = `<observation>
      <title>Missing type field</title>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    // First type in mocked mode is 'bugfix'
    expect(result[0].type).toBe('bugfix');
  });

  it('returns empty array when no observation blocks are present', () => {
    const result = parseObservations('Some text without any observations.');
    expect(result).toHaveLength(0);
  });

  it('parses files_read and files_modified arrays correctly', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title>File read tracking</title>
      <files_read><file>src/utils.ts</file><file>src/parser.ts</file></files_read>
      <files_modified><file>src/utils.ts</file></files_modified>
    </observation>`;

    const result = parseObservations(xml);

    expect(result).toHaveLength(1);
    expect(result[0].files_read).toEqual(['src/utils.ts', 'src/parser.ts']);
    expect(result[0].files_modified).toEqual(['src/utils.ts']);
  });
});
