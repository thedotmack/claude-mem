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
  it('retains valid facts, concepts and files from mixed and plain-text stored metadata', () => {
    const mixed = (value: string) => JSON.stringify([null, 4, { invalid: true }, value]);
    const observations = [
      { ...base, facts: mixed('VALID FACT'), concepts: mixed('VALID CONCEPT'),
        files_read: mixed('/owned/src/read.ts'), files_modified: mixed('/owned/src/changed.ts') },
      { ...base, id: 2, facts: '用户身份定位', concepts: '记忆检索' },
    ];
    const html = observations.map(observation => renderToStaticMarkup(
      <ObservationCard observation={observation} viewMode="facts" onDeleted={() => {}} />,
    )).join('');
    expect([...html.matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1])).toEqual(['VALID FACT', '用户身份定位']);
    for (const text of ['VALID CONCEPT', '记忆检索', 'src/read.ts', 'src/changed.ts']) expect(html).toContain(text);
    expect(html).not.toContain('[object Object]');
  });
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
describe('observation file paths', () => {
  const filesShown = (files: string[]) => {
    const html = renderToStaticMarkup(<ObservationCard observation={{ ...base, facts: '["a fact"]',
      files_read: JSON.stringify(files), files_modified: JSON.stringify(files) }}
      onDeleted={() => {}} viewMode="facts" />);
    return [...html.matchAll(/(read|modified):<\/span> ([^<]*)/g)].map(match => `${match[1]}: ${match[2]}`);
  };
  it('shortens a Windows path the same way as a POSIX path', () => {
    expect(filesShown(['C:\\Users\\me\\code\\app\\src\\server\\index.ts', 'C:\\Users\\me\\code\\app\\README.md']))
      .toEqual(filesShown(['/Users/me/code/app/src/server/index.ts', '/Users/me/code/app/README.md']));
    expect(filesShown(['C:\\Users\\me\\code\\app\\src\\server\\index.ts'])).toEqual([
      'read: src/server/index.ts',
      'modified: src/server/index.ts',
    ]);
  });
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
