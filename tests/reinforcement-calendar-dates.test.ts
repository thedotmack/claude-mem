import { expect, it } from 'bun:test';
import { parseReinforcementDates } from '../src/services/reinforcement/strength.js';
import { blendedScore, rankByStrength } from '../src/services/reinforcement/rank.js';

it('admits only real canonical ISO calendar days from stored history', () => {
  expect(parseReinforcementDates(JSON.stringify(['not-a-day', '2026-02-30', '2026-13-01', '2026-01-01T12:00:00Z', '2024-02-29', '2026-06-10'])))
    .toEqual(['2024-02-29', '2026-06-10']);
});

it('does not rank invalid history as newly reinforced memory', () => {
  const today = new Date('2026-06-17T12:00:00Z');
  const row = { created_at_epoch: Date.parse('2020-01-01'), reinforcement_dates: JSON.stringify(['not-a-day']) };
  expect(blendedScore(row, today, 1)).toBe(blendedScore({ ...row, reinforcement_dates: '[]' }, today, 1));
  const newest = { id: 1, created_at_epoch: Date.parse('2026-06-17'), reinforcement_dates: '[]' };
  const recent = { id: 2, created_at_epoch: Date.parse('2026-06-16'), reinforcement_dates: '[]' };
  expect(rankByStrength([newest, recent, { ...row, id: 3 }], 2, 1, today).map(item => item.id)).toEqual([1, 2]);
});
