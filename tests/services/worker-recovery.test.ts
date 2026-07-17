import { describe, expect, it } from 'bun:test';
import {
  recoverUnhealthyWorker,
  selectOwnedChromaRoots,
  type WindowsProcessSnapshot,
} from '../../src/services/infrastructure/WorkerRecovery.js';

const DATA_DIR = 'C:\\Users\\tester\\.claude-mem\\chroma';

function orphanedChromaTree(): WindowsProcessSnapshot[] {
  return [
    {
      pid: 200,
      parentPid: 100,
      name: 'uv.exe',
      commandLine: '"C:\\Users\\tester\\.local\\bin\\uv.exe" tool uvx --from chroma-mcp==0.2.6 chroma-mcp --client-type persistent --data-dir C:/Users/tester/.claude-mem/chroma',
    },
    {
      pid: 201,
      parentPid: 200,
      name: 'chroma-mcp.exe',
      commandLine: '"C:\\cache\\chroma-mcp.exe" --client-type persistent --data-dir C:/Users/tester/.claude-mem/chroma',
    },
    {
      pid: 202,
      parentPid: 201,
      name: 'python.exe',
      commandLine: '"C:\\cache\\python.exe" "C:\\cache\\chroma-mcp.exe" --client-type persistent --data-dir C:/Users/tester/.claude-mem/chroma',
    },
  ];
}

describe('Windows worker recovery', () => {
  it('selects only the root of the claude-mem-owned orphaned Chroma tree', () => {
    const unrelated: WindowsProcessSnapshot = {
      pid: 300,
      parentPid: 1,
      name: 'python.exe',
      commandLine: 'python chroma-mcp --data-dir C:/other-product/chroma',
    };

    expect(selectOwnedChromaRoots([...orphanedChromaTree(), unrelated], DATA_DIR).map(process => process.pid))
      .toEqual([200]);
  });

  it('kills an orphaned Chroma tree and confirms the stuck worker port is reusable', async () => {
    const killed: number[] = [];
    const result = await recoverUnhealthyWorker(39180, 'C:\\plugin\\worker-service.cjs', {
      platform: 'win32',
      chromaDataDir: DATA_DIR,
      readWorkerPid: () => null,
      listWindowsProcesses: async () => orphanedChromaTree(),
      getManagedProcesses: () => [],
      killProcessTree: async pid => { killed.push(pid); },
      unregisterManagedProcess: () => {},
      removeWorkerPidFile: () => {},
      isPidAlive: () => true,
      captureProcessStartToken: () => null,
      waitForPortFree: async () => true,
    });

    expect(result).toBe(true);
    expect(killed).toEqual([200]);
  });

  it('reclaims a creation-token-verified hung worker before its Chroma tree', async () => {
    const killed: number[] = [];
    const worker: WindowsProcessSnapshot = {
      pid: 150,
      parentPid: 1,
      name: 'bun.exe',
      commandLine: 'bun.exe C:\\plugin\\worker-service.cjs --daemon',
    };

    const result = await recoverUnhealthyWorker(39180, 'C:\\plugin\\worker-service.cjs', {
      platform: 'win32',
      chromaDataDir: DATA_DIR,
      readWorkerPid: () => ({
        pid: 150,
        port: 39180,
        startedAt: '2026-07-17T00:00:00.000Z',
        startToken: 'worker-creation-token',
      }),
      listWindowsProcesses: async () => [worker, ...orphanedChromaTree()],
      getManagedProcesses: () => [],
      killProcessTree: async pid => { killed.push(pid); },
      unregisterManagedProcess: () => {},
      removeWorkerPidFile: () => {},
      isPidAlive: pid => pid === 150,
      captureProcessStartToken: pid => pid === 150 ? 'worker-creation-token' : null,
      waitForPortFree: async () => true,
    });

    expect(result).toBe(true);
    expect(killed).toEqual([150, 200]);
  });

  it('falls back to exact worker command ownership when Windows cannot read the creation token', async () => {
    const killed: number[] = [];
    const workerScript = 'C:\\plugin\\worker-service.cjs';
    const result = await recoverUnhealthyWorker(39180, workerScript, {
      platform: 'win32',
      chromaDataDir: DATA_DIR,
      readWorkerPid: () => ({
        pid: 150,
        port: 39180,
        startedAt: '2026-07-17T00:00:00.000Z',
        startToken: 'stored-token',
      }),
      listWindowsProcesses: async () => [{
        pid: 150,
        parentPid: 1,
        name: 'bun.exe',
        commandLine: `bun.exe ${workerScript} --daemon`,
      }],
      getManagedProcesses: () => [],
      killProcessTree: async pid => { killed.push(pid); },
      unregisterManagedProcess: () => {},
      removeWorkerPidFile: () => {},
      isPidAlive: () => true,
      captureProcessStartToken: () => null,
      waitForPortFree: async () => true,
    });

    expect(result).toBe(true);
    expect(killed).toEqual([150]);
  });

  it('never kills a reused worker PID whose creation token does not match', async () => {
    const killed: number[] = [];
    const result = await recoverUnhealthyWorker(39180, 'C:\\plugin\\worker-service.cjs', {
      platform: 'win32',
      chromaDataDir: DATA_DIR,
      readWorkerPid: () => ({
        pid: 150,
        port: 39180,
        startedAt: '2026-07-17T00:00:00.000Z',
        startToken: 'old-token',
      }),
      listWindowsProcesses: async () => [{
        pid: 150,
        parentPid: 1,
        name: 'notepad.exe',
        commandLine: 'notepad.exe',
      }],
      getManagedProcesses: () => [],
      killProcessTree: async pid => { killed.push(pid); },
      unregisterManagedProcess: () => {},
      removeWorkerPidFile: () => {},
      isPidAlive: () => true,
      captureProcessStartToken: () => 'new-token',
      waitForPortFree: async () => false,
    });

    expect(result).toBe(false);
    expect(killed).toEqual([]);
  });
});
