import { describe, it, expect, mock } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'bugfix' }, { id: 'discovery' }, { id: 'refactor' }],
      }),
    }),
  },
}));

import { parseAgentXml } from '../../src/sdk/parser.js';

function expectObservation(raw: string) {
  const result = parseAgentXml(raw);
  if (!result.valid) throw new Error(`expected valid observation, got reason: ${result.reason}`);
  if (result.kind !== 'observation') throw new Error(`expected observation, got ${result.kind}`);
  return result.data;
}

describe('parseAgentXml — observations', () => {
  it('returns a populated observation when title is present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Found a bug in auth module</title>
      <narrative>The token refresh logic skips expired tokens.</narrative>
    </observation>`;

    const result = expectObservation(xml);

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

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBeNull();
    expect(result[0].narrative).toBe('Patched the null pointer dereference in session handler.');
  });

  it('returns a populated observation when only facts are present', () => {
    const xml = `<observation>
      <type>discovery</type>
      <facts><fact>File limit is hardcoded to 5</fact></facts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].facts).toEqual(['File limit is hardcoded to 5']);
  });

  it('returns a populated observation when only concepts are present', () => {
    const xml = `<observation>
      <type>refactor</type>
      <concepts><concept>dependency-injection</concept></concepts>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].concepts).toEqual(['dependency-injection']);
  });

  it('filters out ghost observations where all content fields are null (#1625)', () => {
    const xml = `<observation>
      <type>bugfix</type>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(false);
  });

  it('filters out ghost observation with empty tags but no text content (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title></title>
      <narrative>   </narrative>
      <facts></facts>
      <concepts></concepts>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(false);
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

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Real observation');
  });

  it('filters out observation with only a subtitle (excluded from survival criteria) (#1625)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <subtitle>Only a subtitle, no real content</subtitle>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(false);
  });

  it('uses first mode type as fallback when type is missing', () => {
    const xml = `<observation>
      <title>Missing type field</title>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('bugfix');
  });

  it('returns a fail-fast result when no observation/summary blocks are present', () => {
    const result = parseAgentXml('Some text without any observations.');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/unknown root|empty/);
    }
  });

  it('parses files_read and files_modified arrays correctly', () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title>File read tracking</title>
      <files_read><file>src/utils.ts</file><file>src/parser.ts</file></files_read>
      <files_modified><file>src/utils.ts</file></files_modified>
    </observation>`;

    const result = expectObservation(xml);

    expect(result).toHaveLength(1);
    expect(result[0].files_read).toEqual(['src/utils.ts', 'src/parser.ts']);
    expect(result[0].files_modified).toEqual(['src/utils.ts']);
  });
});

describe('parseAgentXml — fence tolerance (#2233 Part A)', () => {
  it('parses plain XML input correctly (no fence)', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>Plain XML input</title>
      <narrative>No fence wrapper present.</narrative>
    </observation>`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Plain XML input');
  });

  it('parses fenced XML with language tag (```xml ... ```)', () => {
    const xml = '```xml\n<observation>\n  <type>discovery</type>\n  <title>Fenced with lang</title>\n  <narrative>Wrapped in xml-tagged code fence.</narrative>\n</observation>\n```';

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Fenced with lang');
    expect(result.observations[0].narrative).toBe('Wrapped in xml-tagged code fence.');
  });

  it('parses fenced XML without language tag (``` ... ```)', () => {
    const xml = '```\n<observation>\n  <type>bugfix</type>\n  <title>Bare fence</title>\n  <narrative>Wrapped in language-less fence.</narrative>\n</observation>\n```';

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Bare fence');
    expect(result.observations[0].narrative).toBe('Wrapped in language-less fence.');
  });

  it('does not falsely strip when XML appears mid-text without fences', () => {
    const xml = `Some intro prose.
<observation>
  <type>refactor</type>
  <title>Mid-text observation</title>
  <narrative>No fences anywhere in the input.</narrative>
</observation>
Trailing prose.`;

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Mid-text observation');
    expect(result.observations[0].narrative).toBe('No fences anywhere in the input.');
  });

  it('does not strip inner triple-backtick lines when payload is not a full fenced wrapper', () => {
    // Regression for CodeRabbit review on PR #2282: stripCodeFences() used to
    // greedily remove the first ``` and last ``` anywhere in the input, which
    // could mangle content that contains internal fenced examples or surrounds
    // the XML with prose. The fence-stripper must only fire when the entire
    // payload is a single fenced block.
    const xml = 'Lead-in text with ```inline``` markers.\n' +
      '<observation>\n' +
      '  <type>discovery</type>\n' +
      '  <title>Body with ``` inside narrative</title>\n' +
      '  <narrative>Snippet: ```\nfoo\n``` end of snippet.</narrative>\n' +
      '</observation>\n' +
      'Trailing ``` prose with another ``` mark.';

    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Body with ``` inside narrative');
    // Narrative should still contain the inner ``` markers — i.e. the
    // stripper did not eat them.
    expect(result.observations[0].narrative).toContain('```');
  });
});
