import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Command, CommanderError } from 'commander';
import { doctorCommand, repairCommand, configCommand, shellCommand } from '../commands/system/index.js';
import { logsCommand } from '../commands/worker/index.js';
import { backupCommand, statsCommand, searchCommand, cleanCommand, exportCommand, importCommand } from '../commands/data/index.js';
import { healthChecker } from '../services/health-check.js';
import { repairService } from '../services/repair-service.js';
import { configService } from '../services/config-service.js';
import { logService } from '../services/log-service.js';
import { backupService } from '../services/backup-service.js';
import { statsService } from '../services/stats-service.js';
import { searchService } from '../services/search-service.js';
import { cleanService } from '../services/clean-service.js';
import { exportService } from '../services/export-service.js';
import { importService } from '../services/import-service.js';

class ExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const serviceTouches: string[] = [];
const restoreFns: Array<() => void> = [];

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    if (value === undefined) return 'undefined';
    return JSON.stringify(value);
  }).join(' ');
}

function stubMethod(target: Record<string, any>, method: string, label: string, implementation: (...args: any[]) => any): void {
  const original = target[method];
  restoreFns.push(() => {
    target[method] = original;
  });

  target[method] = mock((...args: any[]) => {
    serviceTouches.push(label);
    return implementation(...args);
  });
}

async function runMalformedInput(command: Command, argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit;

  console.log = ((...args: unknown[]) => {
    stdout.push(`${formatConsoleArgs(args)}\n`);
  }) as typeof console.log;

  console.error = ((...args: unknown[]) => {
    stderr.push(`${formatConsoleArgs(args)}\n`);
  }) as typeof console.error;

  process.stdout.write = ((chunk: any) => {
    stdout.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: any) => {
    stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  (process as any).exit = ((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as typeof process.exit;

  const program = new Command();
  program.name('claude-mem');
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => stdout.push(str),
    writeErr: (str) => stderr.push(str),
    outputError: (str, write) => write(str),
  });
  program.addCommand(command);

  let exitCode = 0;

  try {
    await program.parseAsync(['node', 'claude-mem', ...argv]);
  } catch (error) {
    if (error instanceof ExitCalled) {
      exitCode = error.code;
    } else if (error instanceof CommanderError) {
      exitCode = error.exitCode;
    } else {
      throw error;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    (process as any).exit = originalExit;
  }

  const output = stripAnsi(`${stdout.join('')}${stderr.join('')}`);
  return { exitCode, output };
}

describe('CLI malformed input smoke tests', () => {
  beforeEach(() => {
    serviceTouches.length = 0;
    restoreFns.length = 0;

    stubMethod(healthChecker as any, 'runAllChecks', 'healthChecker.runAllChecks', async () => []);
    stubMethod(healthChecker as any, 'getSummary', 'healthChecker.getSummary', () => ({ healthy: true, errors: 0, warnings: 0 }));
    stubMethod(repairService as any, 'repairAll', 'repairService.repairAll', async () => []);

    stubMethod(configService as any, 'get', 'configService.get', () => undefined);
    stubMethod(configService as any, 'set', 'configService.set', () => true);
    stubMethod(configService as any, 'getSettings', 'configService.getSettings', () => ({}));
    stubMethod(configService as any, 'reset', 'configService.reset', () => undefined);
    stubMethod(configService as any, 'validate', 'configService.validate', () => ({ valid: true, errors: [] }));

    stubMethod(logService as any, 'getLogFiles', 'logService.getLogFiles', () => []);
    stubMethod(logService as any, 'getTotalSize', 'logService.getTotalSize', () => 0);
    stubMethod(logService as any, 'cleanOldLogs', 'logService.cleanOldLogs', () => ({ deleted: 0, freed: 0 }));
    stubMethod(logService as any, 'followLogs', 'logService.followLogs', async function* () {});
    stubMethod(logService as any, 'readLogs', 'logService.readLogs', async () => []);

    stubMethod(backupService as any, 'listBackups', 'backupService.listBackups', () => []);
    stubMethod(backupService as any, 'createBackup', 'backupService.createBackup', async () => ({ success: true, path: 'stub.zip', size: 0, files: [] }));

    stubMethod(statsService as any, 'isDatabaseAccessible', 'statsService.isDatabaseAccessible', () => false);
    stubMethod(statsService as any, 'getDatabaseStats', 'statsService.getDatabaseStats', () => null);
    stubMethod(statsService as any, 'getActivityStats', 'statsService.getActivityStats', () => null);
    stubMethod(statsService as any, 'getTopProjects', 'statsService.getTopProjects', () => []);
    stubMethod(statsService as any, 'getObservationTypes', 'statsService.getObservationTypes', () => []);

    stubMethod(searchService as any, 'getProjects', 'searchService.getProjects', () => []);
    stubMethod(searchService as any, 'getRecent', 'searchService.getRecent', () => []);
    stubMethod(searchService as any, 'search', 'searchService.search', () => []);

    stubMethod(cleanService as any, 'analyze', 'cleanService.analyze', () => ({ sessions: 0, observations: 0, logs: 0, spaceEstimate: 0 }));
    stubMethod(cleanService as any, 'clean', 'cleanService.clean', () => ({ cleaned: true, errors: [] }));

    stubMethod(exportService as any, 'export', 'exportService.export', () => ({ success: true, count: 0 }));

    stubMethod(importService as any, 'validate', 'importService.validate', () => ({ valid: false, errors: ['stub'], count: 0 }));
    stubMethod(importService as any, 'importJSON', 'importService.importJSON', () => ({ success: true, imported: 0, errors: [] }));
  });

  afterEach(() => {
    while (restoreFns.length > 0) {
      restoreFns.pop()?.();
    }
  });

  const cases: Array<{ name: string; command: Command; argv: string[]; expected: string }> = [
    {
      name: 'doctor rejects unknown flags',
      command: doctorCommand,
      argv: ['doctor', '--definitely-not-a-real-flag'],
      expected: 'unknown option',
    },
    {
      name: 'repair rejects unknown flags',
      command: repairCommand,
      argv: ['repair', '--definitely-not-a-real-flag'],
      expected: 'unknown option',
    },
    {
      name: 'config rejects invalid typed values',
      command: configCommand,
      argv: ['config', 'set', 'CLAUDE_MEM_WORKER_PORT', 'not-a-number'],
      expected: 'Port must be a number between 1024 and 65535',
    },
    {
      name: 'shell rejects unsupported shells before install',
      command: shellCommand,
      argv: ['shell', 'install', 'powershell'],
      expected: 'Unsupported shell: powershell',
    },
    {
      name: 'logs rejects unknown flags',
      command: logsCommand,
      argv: ['logs', '--definitely-not-a-real-flag'],
      expected: 'unknown option',
    },
    {
      name: 'backup rejects unknown flags',
      command: backupCommand,
      argv: ['backup', '--definitely-not-a-real-flag'],
      expected: 'unknown option',
    },
    {
      name: 'stats rejects unknown flags',
      command: statsCommand,
      argv: ['stats', '--definitely-not-a-real-flag'],
      expected: 'unknown option',
    },
    {
      name: 'search rejects missing required query',
      command: searchCommand,
      argv: ['search'],
      expected: 'missing required argument',
    },
    {
      name: 'clean rejects unknown flags',
      command: cleanCommand,
      argv: ['clean', '--definitely-not-a-real-flag'],
      expected: 'unknown option',
    },
    {
      name: 'export rejects malformed dates',
      command: exportCommand,
      argv: ['export', '--since', 'not-a-date'],
      expected: 'Invalid date: not-a-date',
    },
    {
      name: 'import rejects missing required files',
      command: importCommand,
      argv: ['import'],
      expected: 'missing required argument',
    },
  ];

  for (const smokeCase of cases) {
    it(smokeCase.name, async () => {
      const { exitCode, output } = await runMalformedInput(smokeCase.command, smokeCase.argv);

      expect(exitCode).toBeGreaterThan(0);
      expect(output).toContain(smokeCase.expected);
      expect(output).not.toMatch(/^\s*at\s+/m);
      expect(output).not.toContain('UnhandledPromiseRejection');
      expect(output.trim().length).toBeGreaterThan(0);
      expect(serviceTouches).toEqual([]);
    });
  }
});
