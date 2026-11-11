import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as hookSettings from '../../../src/shared/hook-settings.js';
import * as oauthToken from '../../../src/shared/oauth-token.js';
import * as projectName from '../../../src/utils/project-name.js';
import * as workerUtils from '../../../src/shared/worker-utils.js';
import {
  getOrCreateInstallId,
  loadTelemetryConfig,
  recordTelemetryDecision,
  resolveTelemetryConsent,
  saveTelemetryConfig,
} from '../../../src/services/telemetry/consent.js';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { CONTEXT_OUTPUT_LIMIT } from '../../../src/services/context/ContextBudget.js';

// Keep consent persistence and the hook output real; only the worker boundary
// and checkout settings are supplied by this fixture.
const originals = {
  settings: { ...hookSettings }, oauth: { ...oauthToken },
  project: { ...projectName }, worker: { ...workerUtils },
};
let showBanner = false;
let workerUnavailable = false;
let workerFailure: Error | null = null;
let colorFailure: Error | null = null;
let terminal = 'context from worker';
let excludedProjects = '';
mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: String(showBanner),
    CLAUDE_MEM_EXCLUDED_PROJECTS: excludedProjects,
    CLAUDE_MEM_PRO_FALLBACK_AT: '',
  }),
}));
mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => null }));
mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({ primary: 'notice-project', allProjects: ['notice-project'], isWorktree: false }),
}));
mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (path: string) => {
    if (path.includes('colors=true') && colorFailure) throw colorFailure;
    if (workerFailure) throw workerFailure;
    return path.includes('colors=true') ? terminal : 'context from worker';
  },
  getWorkerPort: () => 37777,
  getViewerBaseUrl: () => 'http://localhost:37777',
  isWorkerFallback: () => workerUnavailable,
  isWorkerUnavailableError: originals.worker.isWorkerUnavailableError,
  consumeWorkerOutageNotice: async () => 'claude-mem worker is unavailable',
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => originals.settings);
  mock.module('../../../src/shared/oauth-token.js', () => originals.oauth);
  mock.module('../../../src/utils/project-name.js', () => originals.project);
  mock.module('../../../src/shared/worker-utils.js', () => originals.worker);
});

const envKeys = ['CLAUDE_MEM_DATA_DIR', 'DO_NOT_TRACK', 'CLAUDE_MEM_TELEMETRY', 'CLAUDE_MEM_INTERNAL'] as const;
let previousEnv: Record<string, string | undefined>;
let dataDir: string;
beforeEach(() => {
  previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  dataDir = mkdtempSync(join(tmpdir(), 'context-telemetry-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CLAUDE_MEM_TELEMETRY;
  delete process.env.CLAUDE_MEM_INTERNAL;
  showBanner = false;
  workerUnavailable = false;
  workerFailure = null;
  colorFailure = null;
  terminal = 'context from worker';
  excludedProjects = '';
});
afterEach(() => {
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function sessionStart(platform = 'claude-code', sessionSource?: 'resume') {
  const { contextHandler } = await import('../../../src/cli/handlers/context.js');
  return contextHandler.execute({ sessionId: 'first-session', cwd: '/work/notice-project', platform, sessionSource });
}
const docs = 'https://docs.claude-mem.ai/telemetry';

describe('marketplace first-session telemetry disclosure', () => {
  it('shows what is sent and how to opt out once, in the user field only, without recording consent', async () => {
    const first = await sessionStart();
    const wire = claudeCodeAdapter.formatOutput(first) as Record<string, unknown>;
    expect(wire.systemMessage).toContain(docs);
    expect(first.systemMessage).toContain('redacted error messages and stack traces');
    expect(first.systemMessage).toContain('npx claude-mem telemetry disable');
    expect(first.systemMessage).toContain('DO_NOT_TRACK=1');
    expect(first.systemMessage).toContain('CLAUDE_MEM_TELEMETRY=0');
    expect(first.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(resolveTelemetryConsent(process.env, loadTelemetryConfig())).toBe(true);
    expect(loadTelemetryConfig()?.enabled).toBeUndefined();
    expect(loadTelemetryConfig()?.installId).toBe('');
    expect((await sessionStart()).systemMessage).toBeUndefined();
  });

  it('also discloses an install bootstrapped by the worker and preserves its identifiers', async () => {
    saveTelemetryConfig({ installId: 'existing-install', anonymousId: 'existing-anonymous', decidedAt: '' });
    expect((await sessionStart()).systemMessage).toContain(docs);
    expect(loadTelemetryConfig()).toMatchObject({ installId: 'existing-install', anonymousId: 'existing-anonymous', decidedAt: '' });
    expect(getOrCreateInstallId()).toBe('existing-install');
    expect((await sessionStart()).systemMessage).toBeUndefined();
  });

  it('keeps the disclosure record when later creating an ID or recording a choice', async () => {
    await sessionStart();
    const firstConfig = JSON.parse(readFileSync(join(dataDir, 'telemetry.json'), 'utf8'));
    expect(typeof firstConfig.noticeShownAt).toBe('string');
    expect(getOrCreateInstallId()).not.toBe('');
    recordTelemetryDecision(false);
    const after = JSON.parse(readFileSync(join(dataDir, 'telemetry.json'), 'utf8'));
    expect(after.noticeShownAt).toBe(firstConfig.noticeShownAt);
    expect(after.enabled).toBe(false);
  });

  it.each([false, true])('does not repeat the installer disclosure after an explicit choice: %s', async enabled => {
    saveTelemetryConfig({ enabled, installId: 'chosen-install', decidedAt: '2026-11-01T00:00:00Z' });
    const before = readFileSync(join(dataDir, 'telemetry.json'), 'utf8');
    expect((await sessionStart()).systemMessage).toBeUndefined();
    expect(readFileSync(join(dataDir, 'telemetry.json'), 'utf8')).toBe(before);
  });

  it.each([
    ['DO_NOT_TRACK', '1'], ['CLAUDE_MEM_TELEMETRY', '0'], ['CLAUDE_MEM_TELEMETRY', '1'],
  ])('honors the explicit environment decision %s=%s', async (key, value) => {
    process.env[key] = value;
    expect((await sessionStart()).systemMessage).toBeUndefined();
    expect(loadTelemetryConfig()).toBeNull();
  });

  it('does not consume the Claude Code disclosure on a different host or an excluded/internal session', async () => {
    expect((await sessionStart('codex')).systemMessage).toBeUndefined();
    expect((await sessionStart('claude-code', 'resume')).systemMessage).toBeUndefined();
    excludedProjects = 'notice-project';
    expect((await sessionStart()).systemMessage).toBeUndefined();
    excludedProjects = '';
    process.env.CLAUDE_MEM_INTERNAL = '1';
    expect((await sessionStart()).systemMessage).toBeUndefined();
    delete process.env.CLAUDE_MEM_INTERNAL;
    expect(loadTelemetryConfig()).toBeNull();
    expect((await sessionStart()).systemMessage).toContain(docs);
  });

  it('delivers the disclosure even when the first worker read is unavailable', async () => {
    workerUnavailable = true;
    const first = await sessionStart();
    expect(first.systemMessage).toContain('claude-mem worker is unavailable');
    expect(first.systemMessage).toContain(docs);
    expect(first.hookSpecificOutput?.additionalContext).toBe('');
    workerUnavailable = false;
    expect((await sessionStart()).systemMessage).toBeUndefined();
  });

  it.each(['fetch failed', 'Worker request timed out'])('discloses when the actual worker call rejects: %s', async message => {
    workerFailure = new Error(message);
    const first = await sessionStart();
    expect(first.systemMessage).toContain(docs);
    expect(first.systemMessage).toContain('claude-mem worker is unavailable');
    expect(first.hookSpecificOutput?.additionalContext).toBe('');
    workerFailure = null;
    expect((await sessionStart()).systemMessage).toBeUndefined();
  });

  it('keeps completed model context when only the terminal worker read rejects', async () => {
    showBanner = true;
    colorFailure = new Error('ECONNRESET');
    const result = await sessionStart();
    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(result.systemMessage).toContain(docs);
    expect(result.systemMessage).toContain('claude-mem worker is unavailable');
  });

  it('does not hide programming errors or change another host\'s error handling', async () => {
    workerFailure = new TypeError('invalid context decoder');
    await expect(sessionStart()).rejects.toThrow('invalid context decoder');
    expect(loadTelemetryConfig()).toBeNull();
    workerFailure = new Error('ECONNRESET');
    await expect(sessionStart('antigravity-cli')).rejects.toThrow('ECONNRESET');
    expect(loadTelemetryConfig()).toBeNull();
  });

  it('keeps the context and notice available when the disclosure record cannot be written', async () => {
    // A real filesystem failure, without changing the general consent writer:
    // the config path is a directory, so writing telemetry.json fails EISDIR.
    const configPath = join(dataDir, 'telemetry.json');
    mkdirSync(configPath);
    const first = await sessionStart();
    expect(first.systemMessage).toContain(docs);
    expect(first.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(existsSync(`${configPath}.lock`)).toBe(false);
    expect(() => recordTelemetryDecision(false)).toThrow();
    expect(existsSync(`${configPath}.lock`)).toBe(false);

    rmSync(configPath, { recursive: true });
    expect((await sessionStart()).systemMessage).toContain(docs);
    expect((await sessionStart()).systemMessage).toBeUndefined();
  });

  it('keeps context available under lock contention and does not report a saved choice', async () => {
    const lock = join(dataDir, 'telemetry.json.lock');
    mkdirSync(lock);
    const result = await sessionStart();
    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(result.systemMessage).toContain(docs);
    expect(() => recordTelemetryDecision(false)).toThrow('Telemetry configuration is locked');
    expect(loadTelemetryConfig()).toBeNull();
    rmSync(lock, { recursive: true });
    recordTelemetryDecision(false);
    expect(loadTelemetryConfig()?.enabled).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it('reserves space for the disclosure in the full terminal field', async () => {
    showBanner = true;
    terminal = Array.from({ length: 300 }, (_, i) => `  #${i + 1}  10:00 ${'observation '.repeat(8)}`).join('\n');
    const result = await sessionStart();
    expect(result.systemMessage).toContain(docs);
    expect(result.systemMessage?.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(result.systemMessage).toContain('#300  10:00');
    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
  });
});
