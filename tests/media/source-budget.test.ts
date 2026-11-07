import { expect, it } from 'bun:test';
import { createSourceByteBudget } from '../../src/services/media/source-budget.js';
import { MediaError } from '../../src/shared/media-contract.js';

it('callers that do not fit wait first come first served, and each release admits the next', async () => {
  const budget = createSourceByteBudget(100);
  const releaseFirst = await budget.reserve(70);
  const order: string[] = [];
  const second = budget.reserve(50).then(release => { order.push('second'); return release; });
  const third = budget.reserve(10).then(release => { order.push('third'); return release; });
  await Bun.sleep(5);
  // The 10-byte caller fits but does not overtake the 50-byte caller ahead of it.
  expect(order).toEqual([]);
  expect(budget.waitingCount).toBe(2);
  releaseFirst();
  const [releaseSecond, releaseThird] = await Promise.all([second, third]);
  expect(order).toEqual(['second', 'third']);
  expect(budget.heldBytes).toBe(60);
  releaseSecond();
  releaseSecond(); // a second call is a no-op
  releaseThird();
  expect(budget.heldBytes).toBe(0);
});

it('a reservation larger than the whole budget fails source_too_large instead of waiting forever', async () => {
  const budget = createSourceByteBudget(100);
  await expect(budget.reserve(101)).rejects.toBeInstanceOf(MediaError);
  expect(budget.waitingCount).toBe(0);
});
