import { describe, expect, it } from 'bun:test';
import type { Request, WorkProductKind } from '../../../src/ui/my-work/src/data';
import {
  DELIVERABLE_GROUP, deliverableName, deliverablesInOpeningOrder, isCardDeliverable,
} from '../../../src/ui/my-work/src/lib/deliverables';
import { openTasksFirst } from '../../../src/ui/my-work/src/lib/tasks';

/**
 * Phase 5 fix round (pro-max-v16, Q16): the request card's and the drawer's deliverable rules, and the workstream task
 * order, with no browser. The worker bundles lib/deliverables.ts too (src/services/work-view/overview.ts counts the
 * card's deliverables with isCardDeliverable), so these rules run on both sides.
 */
type Product = Request['workProduct'][number];
const product = (kind: WorkProductKind, label: string, href?: string, extra: Partial<Product> = {}): Product => ({ kind, label, ...(href === undefined ? {} : { href }), ...extra });

describe('deliverableName', () => {
  it('keeps the recorded title whenever it says more than its address’s host', () => {
    expect(deliverableName(product('PR', 'Phase 7 fix report', 'https://github.com/thedotmack/claude-mem/pull/6229'))).toBe('Phase 7 fix report');
    expect(deliverableName(product('Doc', 'notes.md', '/api/deliverables/1/notes.md'))).toBe('notes.md');
    expect(deliverableName(product('Commit', 'abc1234 fix the card', undefined))).toBe('abc1234 fix the card');
  });

  it('names a GitHub pull request or commit from its address when the title is only the host', () => {
    expect(deliverableName(product('PR', 'github.com', 'https://github.com/thedotmack/claude-mem/pull/6229'))).toBe('claude-mem #6229');
    expect(deliverableName(product('Commit', 'github.com', 'https://github.com/thedotmack/claude-mem/commit/0123456789abcdef0123456789abcdef01234567')))
      .toBe('claude-mem @0123456');
  });

  it('invents nothing where the address names no pull request or commit', () => {
    expect(deliverableName(product('Page', 'example.com', 'https://example.com/index.html'))).toBe('example.com');
    expect(deliverableName(product('Link', 'github.com', 'https://github.com/thedotmack/claude-mem/issues/12'))).toBe('github.com');
    // A "www." address is not GitHub's pull request shape, so the recorded title stays as it is.
    expect(deliverableName(product('PR', 'github.com', 'https://www.github.com/thedotmack/claude-mem/pull/1'))).toBe('github.com');
  });
});

describe('DELIVERABLE_GROUP', () => {
  it('puts pull requests, commits and branches under Code, and everything a person opens to read under Docs and pages', () => {
    expect(DELIVERABLE_GROUP).toEqual({
      PR: 'code', Commit: 'code', Branch: 'code', Page: 'docs-and-pages', Deck: 'docs-and-pages', Doc: 'docs-and-pages', File: 'docs-and-pages', Link: 'docs-and-pages',
    });
  });
});

describe('deliverablesInOpeningOrder', () => {
  it('lists what opens first, by kind, then what has nothing to open, and commits last, keeping recorded order within a kind', () => {
    const products = [
      product('Commit', 'first commit', 'https://github.com/o/r/commit/1111111'),
      product('Doc', 'local notes'),
      product('Branch', 'feature/cards', undefined),
      product('Doc', 'report one', '/api/deliverables/1/one.md'),
      product('PR', 'the PR', 'https://github.com/o/r/pull/1'),
      product('Commit', 'second commit', undefined),
      product('Page', 'the page', 'https://example.com'),
      product('Doc', 'report two', '/api/deliverables/2/two.md'),
    ];
    const before = [...products];
    expect(deliverablesInOpeningOrder(products).map((each) => each.label)).toEqual([
      'the PR', 'the page', 'report one', 'report two', 'local notes', 'feature/cards', 'first commit', 'second commit',
    ]);
    expect(products).toEqual(before);
  });
});

describe('isCardDeliverable', () => {
  it('keeps commits and branches in the drawer unless claude-mem kept them as deliverables', () => {
    expect(isCardDeliverable(product('Commit', 'a commit', 'https://github.com/o/r/commit/1111111'))).toBe(false);
    expect(isCardDeliverable(product('Branch', 'a branch'))).toBe(false);
    expect(isCardDeliverable(product('Commit', 'kept', undefined, { deliverable: true }))).toBe(true);
    for (const kind of ['PR', 'Page', 'Deck', 'Doc', 'File', 'Link'] as const) expect(isCardDeliverable(product(kind, kind))).toBe(true);
  });
});

describe('openTasksFirst', () => {
  it('lists open tasks before done ones, each group in its recorded order, without changing the list it was given', () => {
    const tasks = [{ name: 'a', done: true }, { name: 'b', done: false }, { name: 'c', done: true }, { name: 'd', done: false }];
    const before = structuredClone(tasks);
    expect(openTasksFirst(tasks).map((task) => task.name)).toEqual(['b', 'd', 'a', 'c']);
    expect(tasks).toEqual(before);
    expect(openTasksFirst([])).toEqual([]);
  });
});
