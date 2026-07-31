// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from 'bun:test';
import { paths } from '../../src/shared/paths.js';

describe('worker instance path isolation (CLAUDE_MEM_WORKER_PORT)', () => {
  afterEach(() => {
    delete process.env.CLAUDE_MEM_WORKER_PORT;
  });

  it('legacy unsuffixed paths when the env override is absent', () => {
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    expect(paths.workerPid().endsWith('worker.pid')).toBe(true);
    expect(paths.supervisorRegistry().endsWith('supervisor.json')).toBe(true);
  });

  it('port-suffixed paths when the env override is set, so two workers coexist', () => {
    process.env.CLAUDE_MEM_WORKER_PORT = '37791';
    expect(paths.workerPid().endsWith('worker-37791.pid')).toBe(true);
    expect(paths.supervisorRegistry().endsWith('supervisor-37791.json')).toBe(true);
  });
});
