// #3378: adoption.errors (Array<{worktree, error}>) was passed as a logger
// CONTEXT value; logger.ts renders context values with a template literal
// (`${k}=${v}`), so the warning printed 'errors=[object Object]'. The log
// site now passes formatAdoptionErrors(adoption.errors).
import { describe, it, expect } from 'bun:test';
import { formatAdoptionErrors } from '../../../src/services/infrastructure/WorktreeAdoption.js';

describe('formatAdoptionErrors (#3378 [object Object] log fix)', () => {
  it('renders actual worktree paths and error text', () => {
    const formatted = formatAdoptionErrors([
      { worktree: '/repos/app/.worktrees/feat-x', error: 'database is locked' },
      { worktree: '/repos/app/.worktrees/feat-y', error: 'no such table: observations' },
    ]);
    expect(formatted).toBe(
      '/repos/app/.worktrees/feat-x: database is locked; /repos/app/.worktrees/feat-y: no such table: observations'
    );
  });

  it('survives the logger context template-literal rendering without [object Object]', () => {
    const value = formatAdoptionErrors([{ worktree: '/w', error: 'boom' }]);
    // Exactly how logger.ts renders a context entry: `${k}=${v}`.
    const rendered = `${'errors'}=${value}`;
    expect(rendered).toBe('errors=/w: boom');
    expect(rendered).not.toContain('[object Object]');
  });

  it('renders an empty error list as an empty string', () => {
    expect(formatAdoptionErrors([])).toBe('');
  });
});
