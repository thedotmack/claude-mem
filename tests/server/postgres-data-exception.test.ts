import { describe, expect, it } from 'bun:test';
import { isPostgresDataException } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';

describe('isPostgresDataException', () => {
  it('matches SQLSTATE class 22 only', () => {
    expect(isPostgresDataException(Object.assign(new Error('x'), { code: '22P05' }))).toBe(true);
    expect(isPostgresDataException(Object.assign(new Error('x'), { code: '22007' }))).toBe(true);
    expect(isPostgresDataException(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isPostgresDataException(Object.assign(new Error('x'), { code: '08006' }))).toBe(false);
    expect(isPostgresDataException(new Error('no code'))).toBe(false);
    expect(isPostgresDataException(null)).toBe(false);
  });
});
