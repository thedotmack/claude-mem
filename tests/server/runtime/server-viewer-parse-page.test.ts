import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { parsePage } from '../../../src/server/runtime/ServerViewerRoutes.js';

function createMockRes(): { res: Response; statusSpy: ReturnType<typeof mock>; jsonSpy: ReturnType<typeof mock> } {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  const res = { status: statusSpy } as unknown as Response;
  return { res, statusSpy, jsonSpy };
}

// The viewer feed endpoints page with LIMIT/OFFSET, so an offset cap is what
// stops one request from driving an arbitrarily deep Postgres scan — the same
// bound the jobs listing already enforces.
describe('ServerViewerRoutes parsePage offset bound', () => {
  it('caps a runaway offset with a 400', () => {
    const { res, statusSpy, jsonSpy } = createMockRes();
    const page = parsePage({ query: { offset: String(Number.MAX_SAFE_INTEGER) } } as unknown as Request, res, 50);
    expect(page).toBeNull();
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: 'BadRequest' }));
  });

  it('keeps offsets inside the cap and defaults a missing offset to 0', () => {
    const atCap = createMockRes();
    expect(parsePage({ query: { offset: '10000' } } as unknown as Request, atCap.res, 50)).toEqual({ limit: 50, offset: 10000 });
    expect(atCap.statusSpy).not.toHaveBeenCalled();

    const noOffset = createMockRes();
    expect(parsePage({ query: {} } as unknown as Request, noOffset.res, 50)).toEqual({ limit: 50, offset: 0 });
  });

  it('still answers 400 for a limit outside 1..MAX_PAGE_SIZE', () => {
    const { res, statusSpy } = createMockRes();
    expect(parsePage({ query: { limit: '101' } } as unknown as Request, res, 50)).toBeNull();
    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});
