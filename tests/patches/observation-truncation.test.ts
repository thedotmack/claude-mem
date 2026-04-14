import { beforeEach, describe, expect, it, mock } from 'bun:test';

let capturedRequests: Array<{ apiPath: string; options: RequestInit | undefined }>;
let workerReady: boolean;
let excludedProjects: string[];

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(workerReady),
  workerHttpRequest: (apiPath: string, options?: RequestInit) => {
    capturedRequests.push({ apiPath, options });
    return Promise.resolve({ ok: true, status: 200 });
  },
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: () => '',
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: excludedProjects }),
  },
}));

mock.module('../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/user-settings.json',
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: (cwd: string, projects: string[]) => projects.includes(cwd),
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    formatTool: (toolName: string) => toolName,
    dataIn: () => {},
    debug: () => {},
    warn: () => {},
  },
}));

const observationModulePromise = import('../../src/cli/handlers/observation.js');

beforeEach(() => {
  capturedRequests = [];
  workerReady = true;
  excludedProjects = [];
});

describe('Observation truncation patch', () => {
  it('truncates non-lightweight tool input and response before posting to the worker', async () => {
    const { observationHandler } = await observationModulePromise;

    await observationHandler.execute({
      sessionId: 'session-1',
      cwd: '/tracked/project',
      toolName: 'Edit',
      toolInput: 'i'.repeat(50 * 1024 + 1_234),
      toolResponse: 'r'.repeat(100 * 1024 + 2_222),
      platform: 'claude-code',
    } as any);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].apiPath).toBe('/api/sessions/observations');

    const payload = JSON.parse(String(capturedRequests[0].options?.body));
    expect(payload.tool_input).toContain('1,234 chars omitted');
    expect(payload.tool_input.length).toBeLessThan(50 * 1024 + 1_234);
    expect(payload.tool_response).toContain('2,222 chars omitted');
    expect(payload.tool_response.length).toBeLessThan(100 * 1024 + 2_222);
  });

  it('uses the lightweight 1KB cap and drops tool responses for low-value tools', async () => {
    const { observationHandler } = await observationModulePromise;

    await observationHandler.execute({
      sessionId: 'session-2',
      cwd: '/tracked/project',
      toolName: 'Read',
      toolInput: 'a'.repeat(2_048),
      toolResponse: 'b'.repeat(20_000),
      platform: 'claude-code',
    } as any);

    const payload = JSON.parse(String(capturedRequests[0].options?.body));
    expect(payload.tool_input).toContain('1,024 chars omitted');
    expect(payload.tool_response).toBe('');
  });

  it('skips posting when the project is excluded from tracking', async () => {
    const { observationHandler } = await observationModulePromise;
    excludedProjects = ['/tracked/project'];

    const result = await observationHandler.execute({
      sessionId: 'session-3',
      cwd: '/tracked/project',
      toolName: 'Edit',
      toolInput: 'small input',
      toolResponse: 'small response',
      platform: 'claude-code',
    } as any);

    expect(result.continue).toBe(true);
    expect(capturedRequests).toHaveLength(0);
  });
});
