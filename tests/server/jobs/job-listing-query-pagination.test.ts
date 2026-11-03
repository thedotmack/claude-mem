import { describe, expect, it } from 'bun:test';
import type { Request } from 'express';
import {
  parseJobListingQuery,
  parseGenericJobListingQuery,
  JOB_LIST_MAX_OFFSET,
  JOB_LIST_DEFAULT_LIMIT,
  JOB_LIST_MAX_LIMIT,
} from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';

function mockReq(query: Record<string, string | undefined>): Request {
  return { query } as unknown as Request;
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

    it('clamps large offset to JOB_LIST_MAX_OFFSET', () => {
      const parsed = parseJobListingQuery(mockReq({ offset: '9007199254740991' }));
      expect(parsed.offset).toBe(JOB_LIST_MAX_OFFSET);
      expect(parsed.offset).toBe(10_000);
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
    it('clamps large offset to JOB_LIST_MAX_OFFSET', () => {
      const parsed = parseGenericJobListingQuery(mockReq({ offset: '999999999999' }));
      expect(parsed.offset).toBe(JOB_LIST_MAX_OFFSET);
      expect(parsed.offset).toBe(10_000);
    });

    it('clamps negative offset to 0', () => {
      const parsed = parseGenericJobListingQuery(mockReq({ offset: '-10' }));
      expect(parsed.offset).toBe(0);
    });
  });
});
