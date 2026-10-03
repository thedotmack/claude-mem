import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

function generateForTrackedFile(folder: string, filename: string): string | undefined {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-git-paths-'));
  try {
    const checkout = join(root, 'repo');
    const dataDir = join(root, 'data');
    const directory = join(checkout, folder);
    mkdirSync(directory, { recursive: true });
    mkdirSync(dataDir);
    writeFileSync(join(directory, filename), 'tracked fixture\n');
    execFileSync('git', ['init', '-q', checkout]);
    execFileSync('git', ['-C', checkout, 'config', 'core.quotePath', 'true']);
    execFileSync('git', ['-C', checkout, 'add', '--', `${folder}/${filename}`]);
    const modulePath = join(import.meta.dir, '../src/cli/claude-md-commands.ts');
    const projectModule = join(import.meta.dir, '../src/utils/project-name.ts');
    const source = `
      import { Database } from 'bun:sqlite';
      import { getProjectContext } from ${JSON.stringify(projectModule)};
      import { generateClaudeMd } from ${JSON.stringify(modulePath)};
      const db = new Database(${JSON.stringify(join(dataDir, 'claude-mem.db'))});
      db.exec('CREATE TABLE observations (id INTEGER, project TEXT, title TEXT, subtitle TEXT, narrative TEXT, facts TEXT, type TEXT, created_at TEXT, created_at_epoch INTEGER, files_modified TEXT, files_read TEXT, discovery_tokens INTEGER)');
      db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        1, getProjectContext(process.cwd()).primary, 'Tracked fixture observation', null, null, null,
        'discovery', '2026-10-03T12:00:00.000Z', 1791028800000,
        ${JSON.stringify(JSON.stringify([`${folder}/${filename}`]))}, null, 10);
      db.close();
      process.exitCode = await generateClaudeMd(false);
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', source],
      cwd: checkout,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: join(root, 'config'),
        CLAUDE_MEM_TELEMETRY: '0', DO_NOT_TRACK: '1' },
    });
    expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toMatchObject({ exitCode: 0 });
    const output = join(directory, 'CLAUDE.md');
    return existsSync(output) ? readFileSync(output, 'utf8') : undefined;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('CLAUDE.md generation from native git filenames', () => {
  it('generates context for tracked non-ASCII folders under Git default quoting', () => {
    expect(generateForTrackedFile('日本語', 'file.ts')).toContain('Tracked fixture observation');
  });

  it.skipIf(process.platform === 'win32')('generates context when a tracked filename contains a newline', () => {
    expect(generateForTrackedFile('plain', 'first\nsecond.ts')).toContain('Tracked fixture observation');
  });

  it.skipIf(process.platform === 'win32')('generates context for tracked folders containing a newline', () => {
    expect(generateForTrackedFile('first\nsecond', 'file.ts')).toContain('Tracked fixture observation');
  });

  it.skipIf(process.platform === 'win32')('generates context for tracked folders containing a double quote', () => {
    expect(generateForTrackedFile('quoted"folder', 'file.ts')).toContain('Tracked fixture observation');
  });

  it('preserves ordinary tracked folders with spaces', () => {
    expect(generateForTrackedFile('plain folder', 'file.ts')).toContain('Tracked fixture observation');
  });
});
