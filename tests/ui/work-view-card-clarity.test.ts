import { describe, expect, it } from 'bun:test';
import { presentWork } from '../../src/ui/work-view/presentation.js';
import { requestCards, requestPage } from '../../src/ui/work-view/request-views.js';

const now = 1_800_000_000_000;
const state = { view: 'cards', range: 'day', filter: 'all', changed: new Set(), unread: new Set() };
const original = 'Make the request cards easier to understand.';

function row(extras: Record<string, unknown> = {}) {
  return presentWork({ humanRequests: [{
    id: 'request-one', title: original, original: { text: original, url: '/api/work-view/evidence/prompt/1' },
    projects: ['sample'], agentIds: [], updatedAtEpoch: now, workstreams: [],
    items: [{ id: 'item-one', kind: 'work-state', status: 'unknown', title: 'Card update',
      progress: { text: 'The source update is available.' }, nextStep: { text: 'Check the source evidence.' }, lastUpdateEpoch: now }],
    ...extras,
  }] }, [], now).rows[0];
}

async function inspect(html: string) {
  const result = { text: '', linkLabel: '', unsafeElements: [] as string[], hasErrorHandler: false, promptIds: [] as string[] };
  await new HTMLRewriter()
    .onDocument({ text(chunk) { result.text += `${chunk.text} `; } })
    .on('a', { element(node) { if (node.getAttribute('href')?.startsWith('#request')) result.linkLabel = node.getAttribute('aria-label') || ''; } })
    .on('img, script', { element(node) { result.unsafeElements.push(node.tagName); } })
    .on('[onerror]', { element() { result.hasErrorHandler = true; } })
    .on('button[data-evidence-kind="prompt"]', { element(node) { result.promptIds.push(node.getAttribute('data-evidence-id') || ''); } })
    .transform(new Response(html)).text();
  // HTMLRewriter exposes entity spelling; assertions use the text a reader sees.
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = (value: string) => value.replace(/&(?:#(\d+)|(amp|lt|gt|quot|apos));/g,
    (_, numeric, named) => numeric ? String.fromCodePoint(Number(numeric)) : entities[named]);
  result.text = decode(result.text).replace(/\s+/g, ' ').trim();
  result.linkLabel = decode(result.linkLabel);
  return result;
}
const card = (value = row()) => inspect(requestCards([value], state));

describe('request card clarity', () => {
  it('identifies fallback text as a recorded update and keeps its source next step', async () => {
    const rendered = await card(row({ humanCopy: { state: 'unavailable' } }));
    expect(rendered.text).toContain('Latest recorded update The source update is available.');
    expect(rendered.text).toContain('Recorded next step Check the source evidence.');
    expect(rendered.text).not.toContain('Latest update');
  });

  for (const copyState of ['current', 'outdated']) {
    it(`uses the available ${copyState} human summary without relabeling it as raw source`, async () => {
      const rendered = await card(row({ humanCopy: { state: copyState, title: 'Clear request title', summary: 'A readable summary.', next: 'Review the revised cards.' } }));
      expect(rendered.text).toContain('Latest update A readable summary.');
      expect(rendered.text).toContain('Next step Review the revised cards.');
      expect(rendered.text).not.toContain('Latest recorded update');
      expect(rendered.text).not.toContain('Recorded next step');
      expect(rendered.text).not.toContain('The source update is available.');
      expect(rendered.text.includes('Summary updating')).toBe(copyState === 'outdated');
    });
  }

  it('omits an uninformative next step without removing the request action or mutating source text', async () => {
    for (const next of ['', 'Follow the latest recorded activity.', '  FOLLOW THE LATEST RECORDED ACTIVITY!!!  ']) {
      const value = { ...row(), next };
      const rendered = await card(value);
      expect(rendered.text).not.toContain('Recorded next step');
      expect(rendered.text.toLowerCase()).not.toContain('follow the latest recorded activity');
      expect(rendered.linkLabel).toBe(`Open request: ${value.title}`);
      expect(value.next).toBe(next);
    }
  });

  it('shows the update once when the next step repeats it with case, spacing, or trailing punctuation changes', async () => {
    const value = { ...row(), activity: 'The draft is ready.', next: '  THE   DRAFT IS READY…!? ' };
    const rendered = await card(value);
    expect(rendered.text).toContain('The draft is ready.');
    expect(rendered.text).not.toContain('Recorded next step');
    expect(rendered.text).not.toContain('THE DRAFT IS READY');
    expect(value.next).toBe('  THE   DRAFT IS READY…!? ');
    expect((await card({ ...value, next: 'Check the draft against the original request.' })).text)
      .toContain('Recorded next step Check the draft against the original request.');
  });

  it('does not infer a lifecycle from prose that mentions completion or an owner decision', async () => {
    const value = { ...row(), activity: 'The result is done.', next: 'Awaiting owner approval.' };
    const rendered = await card(value);
    expect(value.status).toBe('unknown');
    expect(rendered.text).toContain('Update recorded');
    expect(rendered.text).not.toContain('Needs you');
    expect(rendered.text).not.toContain('Ready to check');
    expect(rendered.linkLabel).toBe(`Open request: ${value.title}`);
  });

  for (const [status, action] of [['ready', 'Review result'], ['needs', 'Read handoff'], ['working', 'Open request'], ['unknown', 'Open request']]) {
    it(`offers ${action.toLowerCase()} for the recorded ${status} state`, async () => {
      const value = { ...row(), status };
      const rendered = await card(value);
      expect(rendered.linkLabel).toBe(`${action}: ${value.title}`);
      expect(rendered.text).toContain(action);
    });
  }

  it('names the whole-card link with its action and title while safely displaying source characters', async () => {
    const value = { ...row(), title: 'Review "Cards" <img src=x onerror="steal()"> & notes', activity: 'A long update with <script>untrusted()</script> text.', next: 'Read the evidence first.' };
    const rendered = await card(value);
    expect(rendered.linkLabel).toBe(`Open request: ${value.title}`);
    expect(rendered.linkLabel).not.toContain(value.activity);
    expect(rendered.linkLabel).not.toContain(value.next);
    expect(rendered.text).toContain(value.title);
    expect(rendered.text).toContain(value.activity);
    expect(rendered.unsafeElements).toEqual([]);
    expect(rendered.hasErrorHandler).toBe(false);
  });

  it('keeps the complete original request available in the detail view when the card title is shortened', async () => {
    const fullRequest = `${original} ${'Keep the source evidence available and preserve the existing review flow. '.repeat(8)}`.trim();
    const value = row({ title: fullRequest, original: { text: fullRequest, url: '/api/work-view/evidence/prompt/1' } });
    expect(value.title.length).toBeLessThan(fullRequest.length);
    expect(value.original.text).toBe(fullRequest);
    const detail = await inspect(requestPage(value, { ...state, requestId: value.id, from: 'cards' }));
    expect(detail.text).toContain(`Original request ${fullRequest}`);
    expect(detail.promptIds).toContain('1');
  });
});
