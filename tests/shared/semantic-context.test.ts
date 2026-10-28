import { describe, expect, it } from 'bun:test';
import { renderSemanticContext } from '../../src/shared/semantic-context.js';

describe('renderSemanticContext', () => {
  it('renders a header, then title, date and narrative per item', () => {
    expect(renderSemanticContext([
      { title: 'Retry limit raised', narrative: 'Raised it to five.', date: '2026-10-04' },
      { title: null, narrative: null, date: '' },
    ])).toBe([
      '## Relevant Past Work (semantic match)\n',
      '### Retry limit raised (2026-10-04)',
      'Raised it to five.',
      '',
      '### Observation ()',
      '',
    ].join('\n'));
  });

  it('is empty for no items', () => {
    expect(renderSemanticContext([])).toBe('');
  });
});
