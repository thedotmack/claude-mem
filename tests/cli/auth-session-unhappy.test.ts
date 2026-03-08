import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockLogger: Record<string, any> = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  failure: () => {},
  dataIn: () => {},
  formatTool: () => 'MockTool',
};

let currentRawInput: any;
let currentHandlerExecute: (input: any) => Promise<any>;
let ensureWorkerRunningValue = true;
let workerPort = 37777;

mock.module('../../src/utils/logger.js', () => ({
  logger: mockLogger,
}));

mock.module('../../src/cli/stdin-reader.js', () => ({
  readJsonFromStdin: () => Promise.resolve(currentRawInput),
}));

mock.module('../../src/cli/adapters/index.js', () => ({
  getPlatformAdapter: () => ({
    normalizeInput: (raw: any) => ({ ...(raw ?? {}) }),
    formatOutput: (result: any) => result,
  }),
}));

mock.module('../../src/cli/handlers/index.js', () => ({
  getEventHandler: () => ({
    execute: (input: any) => currentHandlerExecute(input),
  }),
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(ensureWorkerRunningValue),
  getWorkerPort: () => workerPort,
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/test-settings.json',
}));

import { hookCommand } from '../../src/cli/hook-command.js';
import { sessionCompleteHandler } from '../../src/cli/handlers/session-complete.js';
import { HOOK_EXIT_CODES } from '../../src/shared/hook-constants.js';

describe('CLI auth/session unhappy paths', () => {
  const originalFetch = global.fetch;

  let warnMock: ReturnType<typeof mock>;
  let errorMock: ReturnType<typeof mock>;
  let infoMock: ReturnType<typeof mock>;
  let debugMock: ReturnType<typeof mock>;
  let failureMock: ReturnType<typeof mock>;
  let dataInMock: ReturnType<typeof mock>;

  beforeEach(() => {
    currentRawInput = { sessionId: 'session-123', cwd: '/tmp/project' };
    currentHandlerExecute = async () => ({ continue: true, suppressOutput: true });
    ensureWorkerRunningValue = true;
    workerPort = 37777;

    warnMock = mock(() => {});
    errorMock = mock(() => {});
    infoMock = mock(() => {});
    debugMock = mock(() => {});
    failureMock = mock(() => {});
    dataInMock = mock(() => {});

    mockLogger.warn = warnMock;
    mockLogger.error = errorMock;
    mockLogger.info = infoMock;
    mockLogger.debug = debugMock;
    mockLogger.failure = failureMock;
    mockLogger.dataIn = dataInMock;
    mockLogger.formatTool = () => 'MockTool';

    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns a blocking error for an expired credential', async () => {
    currentHandlerExecute = async () => {
      throw new Error('HTTP error status: 401 - access token expired');
    };

    const exitCode = await hookCommand('claude-code', 'session-init', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.BLOCKING_ERROR);
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0][1])).toContain('401');
    expect(String(errorMock.mock.calls[0][1]).toLowerCase()).toContain('expired');
  });

  it('fails gracefully when a credential is missing entirely', async () => {
    currentHandlerExecute = async () => {
      throw new Error('HTTP error status: 401 - missing API key');
    };

    const exitCode = await hookCommand('claude-code', 'session-init', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.BLOCKING_ERROR);
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0][1]).toLowerCase()).toContain('missing api key');
  });

  it('explains malformed credential errors without crashing', async () => {
    currentHandlerExecute = async () => {
      throw new SyntaxError('Malformed credential JSON: unexpected end of input');
    };

    const exitCode = await hookCommand('claude-code', 'session-init', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.BLOCKING_ERROR);
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0][1])).toContain('Malformed credential JSON');
  });

  it('does not retry forever when a stale session is revoked server-side', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('session revoked', { status: 401 })));
    global.fetch = fetchMock as typeof global.fetch;

    const result = await sessionCompleteHandler.execute({ sessionId: 'stale-session-401' } as any);

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/sessions/complete');
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][1])).toContain('Failed to complete session');
    expect(warnMock.mock.calls[0][2]).toMatchObject({ status: 401, body: 'session revoked' });
  });
});
