import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { resolvePythonCommand } from '../../src/services/work-view/python.js';

describe('work-view Python discovery', () => {
  for (const scenario of [
    { name: 'keeps python3 on POSIX', platform: 'linux', available: 'python3', rejected: null, expected: { command: 'python3', args: [] }, tried: ['python3'] },
    { name: 'uses python when python3 is missing', platform: 'win32', available: 'python', rejected: null, expected: { command: 'python', args: [] }, tried: ['python3', 'python'] },
    { name: 'skips a Store alias that starts but exits unsuccessfully', platform: 'win32', available: 'python', rejected: 'python3', expected: { command: 'python', args: [] }, tried: ['python3', 'python'] },
    { name: 'uses the Python 3 launcher after rejected interpreters', platform: 'win32', available: 'py', rejected: 'python', expected: { command: 'py', args: ['-3'] }, tried: ['python3', 'python', 'py'] },
  ] as const) {
    it(scenario.name, async () => {
      const tried: string[] = [];
      const fakeSpawn = ((command: string, args: string[]) => {
        tried.push(command);
        expect(args.slice(-2)).toEqual(['-c', 'import sys; sys.exit(sys.version_info < (3, 9))']);
        if (command === 'py') expect(args[0]).toBe('-3');
        if (command !== scenario.available && command !== scenario.rejected) throw Object.assign(new Error('not installed'), { code: 'ENOENT' });
        const child: any = new EventEmitter();
        child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
        child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
        queueMicrotask(() => child.emit('close', command === scenario.available ? 0 : 1));
        return child;
      }) as any;
      expect(await resolvePythonCommand(fakeSpawn, scenario.platform)).toEqual(scenario.expected);
      expect(tried).toEqual(scenario.tried);
    });
  }

  it('reports all candidates when no supported interpreter is installed', async () => {
    const fakeSpawn = (() => { throw Object.assign(new Error('not installed'), { code: 'ENOENT' }); }) as any;
    await expect(resolvePythonCommand(fakeSpawn, 'win32')).rejects.toThrow('Python 3.9 or newer on PATH (tried python3, python, py -3)');
  });
});
