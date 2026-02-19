/**
 * Tests for useAnalytics hook
 *
 * Tests the pure fetch logic and exported helpers since vitest runs without a browser
 * environment. We test the fetchAnalytics pure function directly (no DOM/React needed).
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { fetchAnalytics } from '../../../src/ui/viewer/hooks/useAnalytics';
import type { AnalyticsData } from '../../../src/ui/viewer/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockAnalyticsData: AnalyticsData = {
  workTokens: 775900,
  readTokens: 50700,
  savingsTokens: 8200,
  observationCount: 109,
  sessionCount: 7,
  timeRange: { days: 30, cutoffEpoch: 1234567890 },
  project: null,
};

const mockAnalyticsDataWithProject: AnalyticsData = {
  workTokens: 100000,
  readTokens: 5000,
  savingsTokens: 1000,
  observationCount: 20,
  sessionCount: 3,
  timeRange: { days: 7, cutoffEpoch: 9876543210 },
  project: 'my-project',
};

// ---------------------------------------------------------------------------
// fetchAnalytics tests
// ---------------------------------------------------------------------------

describe('fetchAnalytics', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches analytics with default 30-day range when no days specified', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAnalyticsData),
    });

    const result = await fetchAnalytics('', 30);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/analytics');
    expect(url).toContain('days=30');
    expect(result).toEqual(mockAnalyticsData);
  });

  it('includes project in query string when project is non-empty', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAnalyticsDataWithProject),
    });

    await fetchAnalytics('my-project', 7);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('project=my-project');
    expect(url).toContain('days=7');
  });

  it('omits project param when project is empty string', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAnalyticsData),
    });

    await fetchAnalytics('', 30);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('project=');
  });

  it('omits days param when timeRange is null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAnalyticsData),
    });

    await fetchAnalytics('', null);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('days=');
  });

  it('throws when API returns non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
    });

    await expect(fetchAnalytics('', 30)).rejects.toThrow();
  });

  it('forwards AbortSignal to fetch when provided', async () => {
    const controller = new AbortController();

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAnalyticsData),
    });

    await fetchAnalytics('', 30, controller.signal);

    const fetchInit = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(fetchInit?.signal).toBe(controller.signal);
  });

  it('rejects when signal is aborted before fetch completes', async () => {
    const controller = new AbortController();
    controller.abort();

    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockAnalyticsData),
      });
    });

    await expect(fetchAnalytics('', 30, controller.signal)).rejects.toThrow();
  });

  it('returns data with correct shape from API', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAnalyticsData),
    });

    const result = await fetchAnalytics('', 30);

    expect(result).toHaveProperty('workTokens');
    expect(result).toHaveProperty('readTokens');
    expect(result).toHaveProperty('savingsTokens');
    expect(result).toHaveProperty('observationCount');
    expect(result).toHaveProperty('sessionCount');
    expect(result).toHaveProperty('timeRange');
    expect(result).toHaveProperty('project');
    expect(result.timeRange).toHaveProperty('days');
    expect(result.timeRange).toHaveProperty('cutoffEpoch');
  });

  it('encodes project with special characters in URL', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAnalyticsData),
    });

    await fetchAnalytics('my project/with spaces', 30);

    const url = fetchMock.mock.calls[0][0] as string;
    // URL should be properly encoded
    expect(url).toContain('project=');
    expect(url).not.toContain('my project/with spaces');
  });
});

// ---------------------------------------------------------------------------
// Auto-refresh and visibility structural tests
// ---------------------------------------------------------------------------

describe('useAnalytics auto-refresh', () => {
  let hookSource: string;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const hookPath = path.resolve(
      __dirname,
      '../../../src/ui/viewer/hooks/useAnalytics.ts'
    );
    hookSource = fs.readFileSync(hookPath, 'utf8');
  });

  it('hook source contains setInterval for polling', () => {
    expect(hookSource).toContain('setInterval');
    expect(hookSource).toContain('clearInterval');
  });

  it('hook source contains POLL_INTERVAL constant', () => {
    expect(hookSource).toContain('POLL_INTERVAL');
    expect(hookSource).toContain('60_000');
  });

  it('hook source pauses polling on visibilitychange', () => {
    expect(hookSource).toContain('visibilitychange');
    expect(hookSource).toContain('document.hidden');
  });

  it('hook source cleans up visibilitychange listener on unmount', () => {
    expect(hookSource).toContain('removeEventListener');
  });
});

// ---------------------------------------------------------------------------
// Module structure tests
// ---------------------------------------------------------------------------

describe('useAnalytics module structure', () => {
  it('exports fetchAnalytics function', async () => {
    const mod = await import('../../../src/ui/viewer/hooks/useAnalytics');
    expect(typeof mod.fetchAnalytics).toBe('function');
  });

  it('exports useAnalytics as default or named export', async () => {
    const mod = await import('../../../src/ui/viewer/hooks/useAnalytics');
    expect(typeof mod.useAnalytics).toBe('function');
  });
});
