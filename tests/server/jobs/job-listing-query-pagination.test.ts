import { describe, expect, it } from 'bun:test';
import type { Request } from 'express';
import {
  parseJobListingQuery,
  parseGenericJobListingQuery,
  JOB_LIST_MAX_OFFSET,
  JOB_LIST_DEFAULT_LIMIT,
  JOB_LIST_MAX_LIMIT,
} from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { AppError } from '../../../src/services/server/ErrorHandler.js';

function mockReq(query: Record<string, string | undefined>): Request {
  return { query } as unknown as Request;
}

function expectInvalidPagination(parse: () => unknown): void {
  let thrown: unknown;
  try {
    parse();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).statusCode).toBe(400);
  expect((thrown as AppError).code).toBe('INVALID_PAGINATION');
}

describe('job listing query pagination bounds', () => {
  describe('parseJobListingQuery', () => {
    it('defaults limit to JOB_LIST_DEFAULT_LIMIT and offset to 0 when omitted', () => {
      const parsed = parseJobListingQuery(mockReq({}));
      expect(parsed.limit).toBe(JOB_LIST_DEFAULT_LIMIT);
      expect(parsed.offset).toBe(0);
      expect(parsed.status).toBeNull();
    });

    it('clamps negative offset to 0', () => {
      const parsed = parseJobListingQuery(mockReq({ offset: '-50' }));
      expect(parsed.offset).toBe(0);
    });

    it('keeps an offset at JOB_LIST_MAX_OFFSET', () => {
      const parsed = parseJobListingQuery(mockReq({ offset: String(JOB_LIST_MAX_OFFSET) }));
      expect(parsed.offset).toBe(10_000);
    });

    it('rejects an offset above JOB_LIST_MAX_OFFSET instead of clamping it', () => {
      expectInvalidPagination(() => parseJobListingQuery(mockReq({ offset: '10001' })));
      expectInvalidPagination(() => parseJobListingQuery(mockReq({ offset: '9007199254740991' })));
    });

    it('preserves a valid offset within range', () => {
      const parsed = parseJobListingQuery(mockReq({ offset: '250' }));
      expect(parsed.offset).toBe(250);
    });

    it('clamps limit between 1 and JOB_LIST_MAX_LIMIT', () => {
      expect(parseJobListingQuery(mockReq({ limit: '0' })).limit).toBe(1);
      expect(parseJobListingQuery(mockReq({ limit: '500' })).limit).toBe(JOB_LIST_MAX_LIMIT);
    });
  });

  describe('parseGenericJobListingQuery', () => {
    it('keeps an offset at JOB_LIST_MAX_OFFSET', () => {
      const parsed = parseGenericJobListingQuery(mockReq({ offset: String(JOB_LIST_MAX_OFFSET) }));
      expect(parsed.offset).toBe(10_000);
    });

    it('rejects an offset above JOB_LIST_MAX_OFFSET instead of clamping it', () => {
      expectInvalidPagination(() => parseGenericJobListingQuery(mockReq({ offset: '10001' })));
      expectInvalidPagination(() => parseGenericJobListingQuery(mockReq({ offset: '999999999999' })));
    });

    it('clamps negative offset to 0', () => {
      const parsed = parseGenericJobListingQuery(mockReq({ offset: '-10' }));
      expect(parsed.offset).toBe(0);
    });
  });
});
