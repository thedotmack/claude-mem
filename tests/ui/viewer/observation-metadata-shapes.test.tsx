import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ObservationCard } from '../../../src/ui/viewer/components/ObservationCard.js';
import type { Observation } from '../../../src/ui/viewer/types.js';
import { parseStoredStringList } from '../../../src/ui/viewer/utils/stored-string-list.js';
const base = { id: 1, project: 'owned', type: 'discovery', title: 'OWNED EVIDENCE',
  subtitle: 'Still readable', created_at_epoch: 1, facts: '[]', concepts: '[]',
  files_read: '[]', files_modified: '[]' } as Observation;
describe('observation metadata recovery', () => {
  for (const raw of ['null', '{"wrong":"shape"}', 'truncated[', '[null,4,{"bad":1},"src/good.ts"]']) {
    it(`keeps the observation readable when stored metadata is ${raw}`, () => {
      const html = renderToStaticMarkup(<ObservationCard observation={{ ...base,
        facts: raw, concepts: raw, files_read: raw, files_modified: raw }} onDeleted={() => {}} />);
      expect(html).toContain('OWNED EVIDENCE');
      expect(html).toContain('Still readable');
    });
  }
  // #3423: facts and concepts stored outside the JSON-array contract are still
  // content. The card must offer its facts view for them, not drop them.
  for (const stored of [
    { label: 'plain-text CJK', facts: '用户身份定位', concepts: '记忆检索' },
    { label: 'a JSON string scalar', facts: '"一个事实"', concepts: '"一个概念"' },
  ]) {
    it(`offers the facts view for ${stored.label} facts and concepts`, () => {
      const html = renderToStaticMarkup(<ObservationCard observation={{ ...base,
        facts: stored.facts, concepts: stored.concepts }} onDeleted={() => {}} />);
      expect(html).toContain('OWNED EVIDENCE');
      expect(html).toContain('<span>facts</span>');
    });
  }
});
describe('parseStoredStringList', () => {
  it('keeps the non-blank strings of a JSON array', () => {
    expect(parseStoredStringList('["a","  ",3,null,{"b":1},"c"]')).toEqual(['a', 'c']);
  });
  it('keeps a JSON string scalar as one entry', () => {
    expect(parseStoredStringList('"一个事实"')).toEqual(['一个事实']);
    expect(parseStoredStringList('"  "')).toEqual([]);
  });
  it('keeps text that is not JSON as one entry (#3423)', () => {
    expect(parseStoredStringList('用户身份定位')).toEqual(['用户身份定位']);
    expect(parseStoredStringList('truncated[')).toEqual(['truncated[']);
    expect(parseStoredStringList('   ')).toEqual([]);
  });
  it('gives nothing for missing values and non-string JSON', () => {
    for (const raw of [null, undefined, '', 'null', '42', 'true', '{"wrong":"shape"}']) {
      expect(parseStoredStringList(raw)).toEqual([]);
    }
  });
});
