import { describe, expect, test } from 'bun:test';
import { parsePostgresConfig, type PostgresConfig } from '../../../src/storage/postgres/config.js';
import { logger } from '../../../src/utils/logger.js';

const BASE_URL = 'postgres://localhost/test';

function sslFor(env: Record<string, string>, url = BASE_URL): PostgresConfig['ssl'] {
  return parsePostgresConfig({ env: { CLAUDE_MEM_SERVER_DATABASE_URL: url, ...env } })!.ssl;
}

const EXPECTED_SSL_BY_MODE: Array<[string, PostgresConfig['ssl']]> = [
  ['disable', false],
  ['allow', { rejectUnauthorized: false }],
  ['prefer', { rejectUnauthorized: false }],
  ['require', { rejectUnauthorized: false }],
  ['verify-ca', { rejectUnauthorized: true }],
  ['verify-full', { rejectUnauthorized: true }],
];

describe('Postgres sslmode mapping', () => {
  for (const [mode, expected] of EXPECTED_SSL_BY_MODE) {
    test(`URL sslmode=${mode}`, () => {
      expect(sslFor({}, `${BASE_URL}?sslmode=${mode}`)).toEqual(expected);
    });
    test(`PGSSLMODE=${mode}`, () => {
      expect(sslFor({ PGSSLMODE: mode })).toEqual(expected);
    });
    test(`CLAUDE_MEM_POSTGRES_SSL=${mode}`, () => {
      expect(sslFor({ CLAUDE_MEM_POSTGRES_SSL: mode })).toEqual(expected);
    });
  }

  test('no mode anywhere means SSL off', () => {
    expect(sslFor({})).toBe(false);
  });

  test('URL sslmode wins over PGSSLMODE', () => {
    expect(sslFor({ PGSSLMODE: 'disable' }, `${BASE_URL}?sslmode=verify-full`)).toEqual({ rejectUnauthorized: true });
  });

  test('CLAUDE_MEM_POSTGRES_SSL wins over the URL', () => {
    expect(sslFor({ CLAUDE_MEM_POSTGRES_SSL: 'verify-full' }, `${BASE_URL}?sslmode=disable`)).toEqual({ rejectUnauthorized: true });
  });

  test('mode matching ignores case and surrounding spaces', () => {
    expect(sslFor({ PGSSLMODE: ' Verify-Full ' })).toEqual({ rejectUnauthorized: true });
  });

  test('an unknown mode warns and falls back to SSL off', () => {
    const originalWarn = logger.warn;
    const warnings: string[] = [];
    logger.warn = ((_component: string, message: string) => {
      warnings.push(message);
    }) as typeof logger.warn;
    try {
      expect(sslFor({ PGSSLMODE: 'verify-everything' })).toBe(false);
    } finally {
      logger.warn = originalWarn;
    }
    expect(warnings.some(warning => warning.includes('verify-everything'))).toBe(true);
  });
});
