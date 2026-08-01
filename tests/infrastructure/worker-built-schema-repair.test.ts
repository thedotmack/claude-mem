import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import net from 'net';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { replayV7RebuildOnSummaries } from '../fixtures/session-store-v7-fixture.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const WORKER_SOURCE = path.join(REPO_ROOT, 'src/services/worker-service.ts');

function bunInPath(): boolean {
  const result = Bun.spawnSync(
    [process.platform === 'win32' ? 'where.exe' : 'which', 'bun'],
    { stderr: 'ignore', stdout: 'ignore' },
  );
  return result.exitCode === 0;
}

let esbuildModule: typeof import('esbuild') | null = null;
let esbuildLoadError: string | null = null;
try {
  esbuildModule = await import('esbuild');
} catch (err) {
  esbuildLoadError = err instanceof Error ? err.message : String(err);
}

const BUN_AVAILABLE = bunInPath();
const SKIP_REASON: string | null =
  !BUN_AVAILABLE ? 'bun not found in PATH — built-worker test requires bun runtime' :
  !esbuildModule ? `esbuild not available: ${esbuildLoadError}` :
  null;

if (SKIP_REASON) {
  console.log(`[worker-built-schema-repair] SKIP: ${SKIP_REASON}`);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function seedDamagedDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    new SessionStore(db);
    replayV7RebuildOnSummaries(db);
  } finally {
    db.close();
  }
}

async function pollHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200 || res.status === 503) {
        return true;
      }
    } catch {
      // connection refused or timeout — keep polling
    }
    await new Promise<void>(r => setTimeout(r, 300));
  }
  return false;
}

async function pollReadiness(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/readiness`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200) {
        return true;
      }
    } catch {
      // connection refused or still initializing — keep polling
    }
    await new Promise<void>(r => setTimeout(r, 300));
  }
  return false;
}

async function removeTempDir(dirPath: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() >= deadline || !(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EBUSY')) {
        throw err;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }
}

describe('worker-built-schema-repair (#3446)', () => {
  it.skipIf(SKIP_REASON !== null)('a worker bundled from head source boots against a damaged DB and repairs discovery_tokens', async () => {
    const bundleDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-wbundle-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-wdata-'));
    const bundlePath = path.join(bundleDir, 'worker-service.cjs');
    const dbPath = path.join(dataDir, 'claude-mem.db');
    const port = await findFreePort();
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let closeLogWriter: (() => Promise<void>) | null = null;
    let drainPromise: Promise<void> | null = null;
    let assertionError: unknown = null;

    try {
      await esbuildModule!.build({
        entryPoints: [WORKER_SOURCE],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        outfile: bundlePath,
        logLevel: 'error',
        external: [
          'bun:sqlite',
          'zod',
          'cohere-ai',
          'ollama',
          '@chroma-core/default-embed',
          'onnxruntime-node',
          'better-auth',
          'better-auth/node',
          'better-auth/plugins',
          '@better-auth/api-key',
        ],
        define: {
          '__DEFAULT_PACKAGE_VERSION__': '"0.0.0-test"',
          'import.meta.url': '__IMPORT_META_URL__',
        },
        banner: {
          js: [
            'var __filename = __filename || require("node:path").resolve(process.argv[1] || "");',
            'var __dirname = __dirname || require("node:path").dirname(__filename);',
            'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;',
          ].join('\n'),
        },
      });

      writeFileSync(
        path.join(dataDir, 'settings.json'),
        JSON.stringify({ CLAUDE_MEM_WORKER_PORT: String(port), CLAUDE_MEM_CHROMA_ENABLED: 'false' }),
      );

      seedDamagedDb(dbPath);
      {
        const check = new Database(dbPath, { readonly: true, create: false });
        try {
          const colNames = (check.query('PRAGMA table_info(session_summaries)').all() as Array<{ name: string }>).map(c => c.name);
          const v11Row = check.prepare('SELECT version FROM schema_versions WHERE version = 11').get();
          expect(colNames).not.toContain('discovery_tokens');
          expect(v11Row).not.toBeNull();
        } finally {
          check.close();
        }
      }

      const logFile = Bun.file(path.join(dataDir, 'worker.log'));
      const logWriter = logFile.writer();
      closeLogWriter = async () => { await logWriter.end(); };

      proc = Bun.spawn(
        ['bun', bundlePath, '--daemon'],
        {
          env: {
            ...process.env,
            CLAUDE_MEM_DATA_DIR: dataDir,
            CLAUDE_CONFIG_DIR: dataDir,
            CLAUDE_MEM_WORKER_PORT: String(port),
            CLAUDE_MEM_CHROMA_ENABLED: 'false',
            CLAUDE_MEM_MODES_DIR: path.join(REPO_ROOT, 'plugin', 'modes'),
          },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      );

      if (proc.stderr) {
        const reader = proc.stderr.getReader();
        const drainStderr = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              logWriter.write(value);
            }
          } catch { /* pipe closed */ } finally {
            try { logWriter.flush(); } catch {}
          }
        };
        drainPromise = drainStderr();
        drainPromise.catch(() => {});
      }

      const healthy = await pollHealth(port, 30000);
      const ready = healthy && await pollReadiness(port, 45000);

      try {
        if (!healthy || !ready) {
          try {
            const logsDir = path.join(dataDir, 'logs');
            const { readdirSync: readdir } = await import('fs');
            const logFiles = readdir(logsDir).filter(f => f.startsWith('claude-mem-'));
            if (logFiles.length > 0) {
              const logPath = path.join(logsDir, logFiles[logFiles.length - 1]);
              const logContent = await Bun.file(logPath).text().catch(() => '(no log)');
              console.error('[DEBUG] Worker log (last 3000):', logContent.slice(-3000));
            } else {
              console.error('[DEBUG] No log files found in', logsDir);
            }
          } catch (err) {
            console.error('[DEBUG] Could not read log dir:', err);
          }
        }
        expect(healthy).toBe(true);
        expect(ready).toBe(true);

        const importResponse = await fetch(`http://127.0.0.1:${port}/api/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessions: [{
              content_session_id: 'built-worker-content',
              memory_session_id: 'built-worker-schema-repair',
              project: dataDir,
              platform_source: 'claude',
              user_prompt: 'schema repair',
              started_at: new Date().toISOString(),
              started_at_epoch: Date.now(),
              completed_at: null,
              completed_at_epoch: null,
              status: 'completed',
            }],
            summaries: [{
              memory_session_id: 'built-worker-schema-repair',
              project: dataDir,
              request: 'built worker summary insert',
              investigated: 'schema repair',
              learned: 'the repaired column is writable',
              completed: 'worker boot',
              next_steps: null,
              files_read: null,
              files_edited: null,
              notes: null,
              prompt_number: 1,
              discovery_tokens: 7,
              created_at: new Date().toISOString(),
              created_at_epoch: Date.now(),
            }],
          }),
        });
        const importBodyText = await importResponse.text();
        if (!importResponse.ok) {
          throw new Error(`Built worker summary import failed (${importResponse.status}): ${importBodyText}`);
        }
        const importBody = JSON.parse(importBodyText) as { success: boolean; stats: { summariesImported: number } };
        expect(importBody.success).toBe(true);
        expect(importBody.stats.summariesImported).toBe(1);

        try {
          await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          // connection closed before response is valid
        }

        await Promise.race([
          proc.exited,
          new Promise<void>(r => setTimeout(r, 5000)),
        ]);

        const postBoot = new Database(dbPath, { readonly: true, create: false });
        try {
          const colNames = (postBoot.query('PRAGMA table_info(session_summaries)').all() as Array<{ name: string }>).map(c => c.name);
          expect(colNames).toContain('discovery_tokens');
          const summary = postBoot.prepare('SELECT request, discovery_tokens FROM session_summaries WHERE memory_session_id = ?').get('built-worker-schema-repair') as { request: string; discovery_tokens: number } | undefined;
          expect(summary).toEqual({ request: 'built worker summary insert', discovery_tokens: 7 });
        } finally {
          postBoot.close();
        }
      } catch (err) {
        assertionError = err;
      }
    } finally {
      try { proc?.kill(); } catch {}
      if (proc) {
        await Promise.race([
          proc.exited,
          new Promise<void>(r => setTimeout(r, 3000)),
        ]);
      }
      try {
        if (drainPromise !== null) await drainPromise;
      } catch {}
      try {
        if (closeLogWriter !== null) await closeLogWriter();
      } catch {}
      await removeTempDir(bundleDir);
      await removeTempDir(dataDir);
    }

    if (assertionError !== null) {
      throw assertionError;
    }
  }, 90000);
});
