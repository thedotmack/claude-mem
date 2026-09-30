
import { describe, it, expect } from 'bun:test';
import { CorpusStore } from '../../../src/services/worker/knowledge/CorpusStore.js';
import { AppError } from '../../../src/services/server/ErrorHandler.js';

/**
 * A corpus name outside [a-zA-Z0-9._-] is bad client input, not a server fault.
 * The store must reject it with a 400 AppError so BaseRouteHandler.handleError
 * returns a clean 400 and never routes it to error tracking as a 500 exception.
 */
describe('CorpusStore name validation', () => {
  const badNames = ['bad name', 'has/slash', 'café', 'a b c', '../escape'];

  for (const name of badNames) {
    it(`throws a 400 AppError from read() for "${name}"`, () => {
      const store = new CorpusStore();
      let thrown: unknown;
      try {
        store.read(name);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).statusCode).toBe(400);
    });

    it(`throws a 400 AppError from delete() for "${name}"`, () => {
      const store = new CorpusStore();
      let thrown: unknown;
      try {
        store.delete(name);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).statusCode).toBe(400);
    });
  }

  it('accepts a valid name (read returns null when absent, no throw)', () => {
    const store = new CorpusStore();
    expect(store.read('valid.name_1-2')).toBeNull();
  });
});
