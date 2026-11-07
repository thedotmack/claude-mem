import { describe, expect, it } from 'bun:test';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';

type Deferred = { promise: Promise<boolean>; resolve(value: boolean): void };
function deferred(): Deferred {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(r => { resolve = r; });
  return { promise, resolve };
}

describe('welcome hint observation check with an isolated reader', () => {
  it('does not remember a positive read that a delete overtook', async () => {
    let removalGeneration = 0;
    const contextCache = {
      recordLiveRender: () => {},
      warmVariant: () => {},
      removalGenerationNow: () => removalGeneration,
    };
    const reads: Deferred[] = [];
    const contextReader = {
      hasObservations: () => { const read = deferred(); reads.push(read); return read.promise; },
    };
    const routes = new SearchRoutes({ getSessionStore: () => ({}) } as any, contextCache as any, null, contextReader as any);
    const check = () => (routes as any).projectsHaveObservations({}, ['app']) as Promise<boolean>;

    // Request A reads before the delete and resumes after it.
    const requestA = check();
    removalGeneration++;
    // Request B starts after the delete and sees the project empty.
    const requestB = check();
    reads[1].resolve(false);
    expect(await requestB).toBe(false);
    reads[0].resolve(true);
    expect(await requestA).toBe(true);

    // A's stale positive must not skip the next read.
    const requestC = check();
    expect(reads).toHaveLength(3);
    reads[2].resolve(false);
    expect(await requestC).toBe(false);
  });
});
