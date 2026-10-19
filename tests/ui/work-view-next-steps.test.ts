import { describe, expect, it } from 'bun:test';
import { nextSteps, requestPage } from '../../src/ui/work-view/request-views.js';

describe('next steps and human handoffs', () => {
  const base = { id: 'one', title: 'Recorded request', status: 'working', activity: 'Reading the code.', next: 'Verify the changed view.', workstreams: [], contributors: [] };

  it('separates recorded work from a human handoff without inventing one', () => {
    const working = nextSteps(base);
    expect(working).toContain('What’s next');
    expect(working).toContain('Verify the changed view.');
    expect(working).not.toContain('next-step-human');
    for (const status of ['ready', 'needs']) {
      const html = nextSteps({ ...base, status });
      expect(html).toContain('next-step-human');
      expect(html).toContain('>You</span>');
    }
  });

  it('treats a local check as the human action, rather than new agent work', () => {
    const html = nextSteps({ ...base, status: 'ready', review: { checked: true } });
    expect(html).toContain('You checked this version.');
    expect(html).not.toContain('Verify the changed view.');
  });

  it('does not repeat a generated review instruction as the agent next step', () => {
    const html = nextSteps({ ...base, status: 'ready', nextSource: 'fallback', next: 'Read the reported result and recorded evidence.' });
    expect(html).toContain('This request is reported complete.');
    expect(html).toContain('Review the result and recorded evidence.');
    expect(html).not.toContain('Read the reported result and recorded evidence.');
  });

  it('keeps an unclassified plan neutral even when its wording sounds like a human decision', () => {
    const html = nextSteps({ ...base, status: 'needs', nextSource: 'summary', humanCopy: true, copyState: 'current', next: 'Choose whether to deploy the release.' });
    expect(html).toContain('<div class="next-step-neutral">');
    const agent = html.slice(html.indexOf('next-step-agent'), html.indexOf('next-step-human'));
    expect(agent).toContain('Waiting for your input.');
    expect(agent).not.toContain('Choose whether');
  });

  it('omits repeated and generic next steps and preserves escaped source text', () => {
    expect(nextSteps({ ...base, next: base.activity })).toBe('');
    expect(nextSteps({ ...base, next: 'Follow the latest recorded activity.' })).toBe('');
    expect(nextSteps({ ...base, next: '<script>doWork()</script>' })).toContain('&lt;script&gt;');
  });

  it('keeps the original and timing available after the main update', () => {
    const html = requestPage({ ...base, original: { text: 'Original request', url: '/api/work-view/evidence/prompt/1' } }, {});
    expect(html.indexOf('Where it stands')).toBeLessThan(html.indexOf('Request context &amp; original'));
    expect(html).toContain('data-detail-key="request:one:context"');
    expect(html).toContain('data-evidence-kind="prompt"');
    expect(html).toContain('data-request-elapsed="one"');
  });
});
