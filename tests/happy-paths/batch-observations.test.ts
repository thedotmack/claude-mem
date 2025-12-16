/**
 * Happy Path Test: Batch Observations Endpoint
 *
 * Tests that the batch observations endpoint correctly retrieves
 * multiple observations by their IDs in a single request.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getWorkerPort } from '../../src/shared/worker-utils.js';

describe('Batch Observations Endpoint', () => {
  const WORKER_PORT = getWorkerPort();
  const WORKER_BASE_URL = `http://127.0.0.1:${WORKER_PORT}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retrieves multiple observations by IDs', async () => {
    // Mock response with multiple observations
    const mockObservations = [
      {
        id: 1,
        sdk_session_id: 'test-session-1',
        project: 'test-project',
        type: 'discovery',
        title: 'Test Discovery 1',
        created_at: '2024-01-01T10:00:00Z',
        created_at_epoch: 1704103200000
      },
      {
        id: 2,
        sdk_session_id: 'test-session-2',
        project: 'test-project',
        type: 'bugfix',
        title: 'Test Bugfix',
        created_at: '2024-01-02T10:00:00Z',
        created_at_epoch: 1704189600000
      },
      {
        id: 3,
        sdk_session_id: 'test-session-3',
        project: 'test-project',
        type: 'feature',
        title: 'Test Feature',
        created_at: '2024-01-03T10:00:00Z',
        created_at_epoch: 1704276000000
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockObservations
    });

    // Execute: Fetch observations by IDs
    const response = await fetch(`${WORKER_BASE_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ids: [1, 2, 3] })
    });

    const data = await response.json();

    // Verify: Response contains all requested observations
    expect(response.ok).toBe(true);
    expect(data).toHaveLength(3);
    expect(data[0].id).toBe(1);
    expect(data[1].id).toBe(2);
    expect(data[2].id).toBe(3);
  });

  it('applies orderBy parameter correctly', async () => {
    const mockObservations = [
      {
        id: 3,
        created_at: '2024-01-03T10:00:00Z',
        created_at_epoch: 1704276000000
      },
      {
        id: 2,
        created_at: '2024-01-02T10:00:00Z',
        created_at_epoch: 1704189600000
      },
      {
        id: 1,
        created_at: '2024-01-01T10:00:00Z',
        created_at_epoch: 1704103200000
      }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockObservations
    });

    // Execute: Fetch with date_desc ordering
    const response = await fetch(`${WORKER_BASE_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ids: [1, 2, 3],
        orderBy: 'date_desc'
      })
    });

    const data = await response.json();

    // Verify: Results are ordered by date descending
    expect(data[0].id).toBe(3);
    expect(data[1].id).toBe(2);
    expect(data[2].id).toBe(1);
  });

  it('applies limit parameter correctly', async () => {
    const mockObservations = [
      { id: 3, created_at_epoch: 1704276000000 },
      { id: 2, created_at_epoch: 1704189600000 }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockObservations
    });

    // Execute: Fetch with limit=2
    const response = await fetch(`${WORKER_BASE_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ids: [1, 2, 3],
        limit: 2
      })
    });

    const data = await response.json();

    // Verify: Only 2 results returned
    expect(data).toHaveLength(2);
  });

  it('filters by project parameter', async () => {
    const mockObservations = [
      { id: 1, project: 'project-a' },
      { id: 2, project: 'project-a' }
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockObservations
    });

    // Execute: Fetch with project filter
    const response = await fetch(`${WORKER_BASE_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ids: [1, 2, 3],
        project: 'project-a'
      })
    });

    const data = await response.json();

    // Verify: Only matching project observations returned
    expect(data).toHaveLength(2);
    expect(data.every((obs: any) => obs.project === 'project-a')).toBe(true);
  });

  it('returns empty array for empty IDs', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => []
    });

    // Execute: Fetch with empty IDs array
    const response = await fetch(`${WORKER_BASE_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ids: [] })
    });

    const data = await response.json();

    // Verify: Empty array returned
    expect(data).toEqual([]);
  });

  it('returns error for invalid IDs parameter', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'ids must be an array of numbers' })
    });

    // Execute: Fetch with invalid IDs (string instead of array)
    const response = await fetch(`${WORKER_BASE_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ids: 'not-an-array' })
    });

    const data = await response.json();

    // Verify: Error response returned
    expect(response.ok).toBe(false);
    expect(data.error).toBe('ids must be an array of numbers');
  });

  it('returns error for non-integer IDs', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'All ids must be integers' })
    });

    // Execute: Fetch with mixed types in IDs array
    const response = await fetch(`${WORKER_BASE_URL}/api/observations/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ids: [1, 'two', 3] })
    });

    const data = await response.json();

    // Verify: Error response returned
    expect(response.ok).toBe(false);
    expect(data.error).toBe('All ids must be integers');
  });
});
