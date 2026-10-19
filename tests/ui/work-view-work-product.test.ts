import { describe, expect, it } from 'bun:test';
import { howItLanded, productSummary, workProduct } from '../../src/ui/work-view/request-views.js';

const products = [
  { kind: 'image', title: 'hero.png', path: '/w/hero.png', fileUrl: '/api/work-view/file/observation/3/0', available: true },
  { kind: 'pull-request', title: 'Add <work> product', url: 'https://github.com/o/r/pull/42' },
  { kind: 'image', title: 'old.png', path: '/w/old.png', fileUrl: '/api/work-view/file/observation/4/0', available: false },
  { kind: 'link', title: 'bad', url: 'javascript:alert(1)' },
];

describe('work product', () => {
  it('shows thumbnails for images, links for the rest, and nothing unsafe', () => {
    const html = workProduct({ workProduct: products });
    expect(html).toContain('<img src="/api/work-view/file/observation/3/0"');
    expect(html).toContain('href="https://github.com/o/r/pull/42"');
    expect(html).not.toContain('<work>');
    expect(html).toContain('File moved or deleted');
    expect(html).not.toContain('/api/work-view/file/observation/4/0');
    expect(html).not.toContain('javascript:');
    expect(workProduct({ workProduct: [] })).toBe('');
  });

  it('summarizes what a request made in one card line', () => {
    expect(productSummary({ workProduct: products })).toContain('2 Images · Pull request · Link');
    expect(productSummary({})).toBe('');
  });
});

describe('how it landed', () => {
  it('shows each judgment with its evidence and the why of each change', () => {
    const html = howItLanded({ progress: { outcome: {
      landed: { text: 'Released in v14.0.0.', evidence: ['PR #4845'] },
      usage: { level: 'no-evidence', text: 'No usage recorded yet.', evidence: [] },
      value: { level: 'high', text: 'Replaced the manual standup.', evidence: ['obs 101'] },
      regressions: [{ text: 'Summaries vanished.', fixedBy: 'PR #4850', evidence: [] }, { text: 'Slow load.', fixedBy: null, evidence: [] }],
      changes: [{ what: 'Restored cards', why: 'Owner asked to restore the approved design.', evidence: ['ce3636c05'] }],
    } } });
    expect(html).toContain('No evidence of use');
    expect(html).toContain('High value');
    expect(html).toContain('Fixed by PR #4850');
    expect(html).toContain('Not fixed yet');
    expect(html).toContain('Owner asked to restore the approved design.');
    expect(howItLanded({ progress: { percent: 50 } })).toBe('');
  });
});
