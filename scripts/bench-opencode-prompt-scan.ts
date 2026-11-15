// Compare peak memory for native OpenCode prompt/provenance reads in fresh Bun processes.
// bun scripts/bench-opencode-prompt-scan.ts create /tmp/opencode-prompt-bench.db
// bun scripts/bench-opencode-prompt-scan.ts scan /tmp/opencode-prompt-bench.db [absolute-reader-module]
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, path, modulePath] = process.argv.slice(2);
if (!path || !['create', 'scan'].includes(mode)) {
  throw new Error('Usage: bun scripts/bench-opencode-prompt-scan.ts create|scan <fixture-path> [absolute-reader-module]');
}
if (mode === 'create') {
  if (existsSync(path)) throw new Error('Refusing to replace an existing benchmark database: ' + path);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=OFF;
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
    INSERT INTO session VALUES ('session', '/benchmark/project', NULL);`);
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 30000; i++) {
      const id = String(i).padStart(8, '0');
      message.run(id, 'session', 1730000000000 + i, '{"role":"assistant"}');
      for (let j = 0; j < 2; j++) part.run(id + '-' + j, id,
        JSON.stringify({ type: 'text', text: id + ':' + j + ':' + 'abcdefghijklmnopqrstuvwxyz '.repeat(76) }));
    }
  })();
  db.close();
  console.log(JSON.stringify({ rows: 60000, bytes: statSync(path).size }));
} else {
  const moduleUrl = modulePath ? pathToFileURL(modulePath).href
    : new URL('../src/services/prompt-import/readers.ts', import.meta.url).href;
  const { createOpenCodeReader } = await import(moduleUrl);
  const hash = createHash('sha256');
  let messages = 0;
  const start = performance.now();
  await createOpenCodeReader().readAgentText(
    { path, bytes: statSync(path).size, mtimeMs: Date.now(), holdsPrompts: true },
    (at, text) => { messages++; hash.update(String(at)); hash.update('\0'); hash.update(text); hash.update('\0'); },
  );
  console.log(JSON.stringify({ milliseconds: performance.now() - start,
    maxRssKiB: process.resourceUsage().maxRSS, messages, sha256: hash.digest('hex') }));
}


