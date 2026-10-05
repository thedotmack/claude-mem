import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ObservationCard } from '../../../src/ui/viewer/components/ObservationCard.js';
import type { Observation } from '../../../src/ui/viewer/types.js';
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
});
