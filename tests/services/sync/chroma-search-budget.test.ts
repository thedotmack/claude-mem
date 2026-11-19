import { describe, expect, it } from 'bun:test';
import { withinSearchBudget } from '../../../src/services/sync/chroma-search-budget.js';
import { ChromaUnavailableError } from '../../../src/services/worker/search/errors.js';

// #6323: a search stops waiting on Chroma at its shared deadline and falls back
// to SQLite/FTS5, but the read is not cancelled, so a slow-but-healthy
// chroma-mcp is never restarted for being slower than one search can wait.
describe('withinSearchBudget', () => {
  it('returns the read when it answers inside the budget', async () => {
    await expect(withinSearchBudget(async () => 'rows', Date.now() + 1_000)).resolves.toBe('rows');
  });

  it('stops waiting at the deadline with ChromaUnavailableError and leaves the read running', async () => {
    let settled = false;
    let finishRead!: (value: string) => void;
    const read = new Promise<string>(resolve => { finishRead = resolve; }).then(value => { settled = true; return value; });
    const startedAt = Date.now();

    await expect(withinSearchBudget(() => read, Date.now() + 50)).rejects.toBeInstanceOf(ChromaUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(settled).toBe(false);

    finishRead('late rows');
    await expect(read).resolves.toBe('late rows');
  });

  it('does not start another read once the deadline has passed', async () => {
    let started = false;
    await expect(withinSearchBudget(async () => { started = true; return 'rows'; }, Date.now() - 1))
      .rejects.toBeInstanceOf(ChromaUnavailableError);
    expect(started).toBe(false);
  });

  it('waits without a budget when the caller gives no deadline', async () => {
    await expect(withinSearchBudget(async () => 'rows', undefined)).resolves.toBe('rows');
  });

  it('does not leave an abandoned read rejection unhandled', async () => {
    let failRead!: (error: Error) => void;
    const read = new Promise<string>((_resolve, reject) => { failRead = reject; });
    await expect(withinSearchBudget(() => read, Date.now() + 20)).rejects.toBeInstanceOf(ChromaUnavailableError);
    failRead(new Error('chroma-mcp restarted'));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
});
