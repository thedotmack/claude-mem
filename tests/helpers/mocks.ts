/**
 * Reusable mock factories for testing dependencies.
 */
import { vi } from 'vitest';

/**
 * Mock fetch that succeeds with a JSON response
 */
export const mockFetchSuccess = (data: any = { success: true }) => {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data)
  });
};

/**
 * Mock fetch that fails with worker down error
 */
export const mockFetchWorkerDown = () => {
  return vi.fn().mockRejectedValue(
    new Error('ECONNREFUSED')
  );
};

/**
 * Mock fetch that returns 500 error
 */
export const mockFetchServerError = () => {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Internal Server Error' }),
    text: async () => 'Internal Server Error'
  });
};

/**
 * Mock database operations
 */
export const mockDb = {
  createSDKSession: vi.fn().mockReturnValue(1),
  addObservation: vi.fn().mockReturnValue(1),
  getObservationById: vi.fn(),
  getObservations: vi.fn().mockReturnValue([]),
  searchObservations: vi.fn().mockReturnValue([]),
  markSessionCompleted: vi.fn(),
  getSession: vi.fn(),
  getSessions: vi.fn().mockReturnValue([]),
};

/**
 * Mock SDK agent
 */
export const mockSdkAgent = {
  startSession: vi.fn(),
  stopSession: vi.fn(),
  processObservation: vi.fn(),
  generateSummary: vi.fn(),
};

/**
 * Mock session manager
 */
export const mockSessionManager = {
  queueObservation: vi.fn(),
  queueSummarize: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  completeSession: vi.fn(),
};

/**
 * Helper to reset all mocks
 */
export const resetAllMocks = () => {
  vi.clearAllMocks();
  Object.values(mockDb).forEach(mock => mock.mockClear());
  Object.values(mockSdkAgent).forEach(mock => mock.mockClear());
  Object.values(mockSessionManager).forEach(mock => mock.mockClear());
};
