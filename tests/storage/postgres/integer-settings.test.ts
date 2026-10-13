import { expect, test } from 'bun:test';
import { parsePostgresConfig } from '../../../src/storage/postgres/config.js';
for (const value of ['5ms', '1.5', '1e3', '9007199254740993']) {
  test(`rejects malformed pool count ${value}`, () => expect(parsePostgresConfig({env: {CLAUDE_MEM_SERVER_DATABASE_URL:'postgres://localhost/test', CLAUDE_MEM_POSTGRES_POOL_MAX:value}})?.max).toBe(10));
}
test('accepts padded decimal pool count', () => expect(parsePostgresConfig({env: {CLAUDE_MEM_SERVER_DATABASE_URL:'postgres://localhost/test', CLAUDE_MEM_POSTGRES_POOL_MAX:' 12 '}})?.max).toBe(12));
