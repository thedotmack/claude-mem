import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The logger writes to paths.logsDir(), which honors CLAUDE_MEM_DATA_DIR saved
// in ~/.claude-mem/settings.json. GET /api/logs (the viewer's Console) must
// read the same file. Runs in a subprocess so HOME and the import-time data
// dir resolution are isolated from this test process.
const FIXED_NOW = Date.parse('2026-03-14T12:00:00.000Z');
const fixture = String.raw`
  // Pin the clock so the route's "today" matches the fixture's file name.
  Date.now = () => ${FIXED_NOW};
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [${FIXED_NOW}])); } };
  import { LogsRoutes } from './src/services/worker/http/routes/LogsRoutes.ts';
  const handlers = {};
  new LogsRoutes().setupRoutes({ get: (p, h) => { handlers[p] = h; }, post: (p, h) => { handlers[p] = h; } });
  const body = await new Promise((resolve, reject) => {
    const res = { status() { return this; }, json: resolve };
    handlers['/api/logs']({ query: {} }, res, reject);
  });
  console.log(JSON.stringify(body));
`;

describe('GET /api/logs data directory', () => {
  it('reads today\'s log from a CLAUDE_MEM_DATA_DIR saved in settings.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-logs-data-dir-'));
    try {
      const home = join(root, 'home');
      const dataDir = join(root, 'custom-data');
      mkdirSync(join(home, '.claude-mem'), { recursive: true });
      writeFileSync(join(home, '.claude-mem', 'settings.json'), JSON.stringify({ CLAUDE_MEM_DATA_DIR: dataDir }));
      mkdirSync(join(dataDir, 'logs'), { recursive: true });
      const day = new Date(FIXED_NOW).toISOString().split('T')[0];
      const logFile = join(dataDir, 'logs', `claude-mem-${day}.log`);
      writeFileSync(logFile, '[INFO ] [SYSTEM] worker line\n');

      const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.CLAUDE_MEM_DATA_DIR;
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../../..'), env, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const body = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);

      expect(body.path).toBe(logFile);
      expect(body.exists).toBe(true);
      expect(body.logs).toContain('worker line');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
