import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import pc from 'picocolors';
import { claudeConfigDirectory, isPluginInstalled } from '../utils/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

/**
 * `npx claude-mem migrate-memory`
 *
 * One-time transfer of Claude Code's native auto-memory (the per-project
 * `~/.claude/projects/<encoded-cwd>/memory/*.md` notes) into claude-mem.
 *
 * Mechanism: for each native memory note we POST its contents to the worker's
 * existing observation-ingest endpoint (POST /api/sessions/observations) — the
 * SAME endpoint the PostToolUse hook uses. claude-mem's normal generator then
 * compresses each note into a real observation. No new compression path, no
 * server-beta, no Postgres.
 *
 * Two details matter:
 *  - Project attribution comes ONLY from the payload `cwd`, so we recover each
 *    project's real path (see recoverProjectCwd) and pass it as cwd.
 *  - The note is dated with the file's mtime via the optional `timestampEpoch`
 *    field, so the migrated observation lands when the note was written, not now.
 *
 * Non-destructive: native files are read, never modified or deleted.
 */

interface MigrateOptions {
  dryRun: boolean;
  project?: string;
}

interface NativeProject {
  encodedName: string;
  memoryDir: string;
  cwd: string;
  displayName: string;
  files: string[]; // absolute paths of topic .md files (MEMORY.md index excluded)
}

function parseArgs(extra: string[]): MigrateOptions {
  const opts: MigrateOptions = { dryRun: extra.includes('--dry-run') };
  const pIdx = extra.indexOf('--project');
  if (pIdx !== -1) {
    const value = extra[pIdx + 1];
    if (!value || value.startsWith('-')) {
      console.error(pc.red('Flag --project requires a value.'));
      process.exit(1);
    }
    opts.project = value;
  }
  return opts;
}

/**
 * Recover the original absolute cwd for an encoded `~/.claude/projects` dir.
 *
 * Claude Code encodes a project's absolute path by replacing both '/' and '.'
 * with '-', which is lossy (a literal '-' in a name like "claude-mem" is
 * indistinguishable from a path separator). We recover the true path in three
 * tiers, most-reliable first:
 *   1. Read any session transcript (`*.jsonl`) in the project dir and extract its
 *      `"cwd"` field — this is the exact, unambiguous original path.
 *   2. Greedy filesystem probe: walk the dash-separated tokens, preferring a
 *      separator but merging tokens into a dashed segment when only the merged
 *      directory exists on disk.
 *   3. Naive '-' -> '/' as a last resort (project no longer on disk).
 */
function recoverProjectCwd(projectDir: string, encodedName: string): string {
  // Tier 1 — exact, from a session transcript.
  try {
    const jsonl = readdirSync(projectDir).find(f => f.endsWith('.jsonl'));
    if (jsonl) {
      const content = readFileSync(join(projectDir, jsonl), 'utf8');
      const match = content.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (match && match[1]) return match[1];
    }
  } catch {
    // fall through to filesystem probing
  }

  // Tier 2/3 — probe the filesystem to resolve '-' vs '/' ambiguity.
  return probeDecode(encodedName);
}

function probeDecode(encoded: string): string {
  const tokens = encoded.split('-'); // leading '' represents the root slash
  let path = '';
  let i = tokens[0] === '' ? 1 : 0;

  while (i < tokens.length) {
    let matched = false;
    // Shortest-first: prefer treating each '-' as a path separator, only merging
    // tokens into a dashed segment when the shorter candidate isn't on disk.
    for (let j = i + 1; j <= tokens.length; j++) {
      const segment = tokens.slice(i, j).join('-');
      const candidate = `${path}/${segment}`;
      if (existsSync(candidate)) {
        path = candidate;
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Nothing on disk from here down — keep the remaining tokens as a single
      // dashed segment so a leaf like "claude-mem" survives when the project
      // directory has been deleted/moved.
      path = `${path}/${tokens.slice(i).join('-')}`;
      break;
    }
  }

  return path || '/';
}

function discoverNativeProjects(): NativeProject[] {
  const projectsRoot = join(claudeConfigDirectory(), 'projects');
  if (!existsSync(projectsRoot)) return [];

  const result: NativeProject[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(projectsRoot, entry.name);
    const memoryDir = join(projectDir, 'memory');
    if (!existsSync(memoryDir)) continue;

    // Topic notes only — MEMORY.md is just an index of links to the topic files
    // and carries no content of its own, so it's redundant to ingest.
    const files = readdirSync(memoryDir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      .map(f => join(memoryDir, f));
    if (files.length === 0) continue;

    const cwd = recoverProjectCwd(projectDir, entry.name);
    result.push({
      encodedName: entry.name,
      memoryDir,
      cwd,
      displayName: basename(cwd),
      files,
    });
  }
  return result;
}

const SKIP_PROJECT_PHRASE = 'session-memory'; // worker auto-skips file paths containing this

async function postObservation(
  port: string | number,
  project: NativeProject,
  filePath: string,
): Promise<{ ok: boolean; status?: string; reason?: string; error?: string }> {
  const fileName = basename(filePath);
  const content = readFileSync(filePath, 'utf8');
  const mtimeMs = statSync(filePath).mtimeMs;

  // Deterministic per-project session id so re-runs land in the same session and
  // the worker's content-hash dedupe collapses identical re-generated rows
  // instead of duplicating them.
  const contentSessionId = `native-memory-import:${project.encodedName}`;

  // Frame the note so the compressor knows it's durable migrated memory, not an
  // ephemeral file read.
  const toolResponse =
    `Imported from Claude Code native auto-memory for this project (source file: ${fileName}). ` +
    `This is a long-term memory note the user previously saved:\n\n${content}`;

  const url = `http://127.0.0.1:${port}/api/sessions/observations`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        tool_name: 'Read',
        tool_input: { file_path: filePath },
        tool_response: toolResponse,
        cwd: project.cwd,
        platformSource: 'claude-code',
        timestampEpoch: Math.floor(mtimeMs),
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { status?: string; reason?: string };
    return { ok: true, status: data.status, reason: data.reason };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isConnRefused(error: string | undefined): boolean {
  return !!error && error.includes('ECONNREFUSED');
}

export async function runMigrateNativeMemoryCommand(extraArgs: string[] = []): Promise<void> {
  if (!isPluginInstalled()) {
    console.error(pc.red('claude-mem is not installed.'));
    console.error(`Run: ${pc.bold('npx claude-mem install')}`);
    process.exit(1);
  }

  const opts = parseArgs(extraArgs);

  let projects = discoverNativeProjects();
  if (opts.project) {
    projects = projects.filter(p => p.displayName === opts.project || p.encodedName === opts.project);
  }

  if (projects.length === 0) {
    console.log(pc.dim('No Claude Code native auto-memory found to migrate.'));
    console.log(pc.dim(`Looked in: ${join(claudeConfigDirectory(), 'projects', '*', 'memory')}`));
    return;
  }

  const totalFiles = projects.reduce((n, p) => n + p.files.length, 0);
  console.log();
  console.log(pc.bold(`Found native auto-memory in ${projects.length} project(s), ${totalFiles} note(s):`));
  for (const p of projects) {
    console.log(`  ${pc.cyan(p.displayName)} ${pc.dim(`(${p.cwd})`)}`);
    for (const f of p.files) {
      const note = p.cwd.includes(SKIP_PROJECT_PHRASE) ? pc.yellow(' [would be skipped: session-memory path]') : '';
      console.log(`    ${pc.dim('•')} ${basename(f)}${note}`);
    }
  }
  console.log();

  if (opts.dryRun) {
    console.log(pc.dim('Dry run — nothing was written. Re-run without --dry-run to migrate.'));
    return;
  }

  const port = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');

  let queued = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of projects) {
    for (const filePath of project.files) {
      const result = await postObservation(port, project, filePath);
      if (!result.ok) {
        if (isConnRefused(result.error)) {
          console.error(pc.red('\nWorker is not running.'));
          console.error(`Start it with: ${pc.bold('npx claude-mem start')}, then re-run this command.`);
          process.exit(1);
        }
        failed++;
        console.log(`  ${pc.red('✗')} ${project.displayName}/${basename(filePath)} — ${result.error}`);
        continue;
      }
      if (result.status === 'skipped') {
        skipped++;
        console.log(`  ${pc.yellow('-')} ${project.displayName}/${basename(filePath)} ${pc.dim(`(skipped: ${result.reason})`)}`);
        continue;
      }
      queued++;
      console.log(`  ${pc.green('✓')} ${project.displayName}/${basename(filePath)} ${pc.dim('queued')}`);
    }
  }

  console.log();
  console.log(pc.bold('Migration queued:'));
  console.log(`  ${pc.green(`${queued} queued`)}${skipped ? pc.yellow(`, ${skipped} skipped`) : ''}${failed ? pc.red(`, ${failed} failed`) : ''}`);
  console.log(
    pc.dim(
      'Notes are compressed into observations in the background by the worker. ' +
      'They will appear in search within a moment (the worker needs a working Claude provider).',
    ),
  );
  console.log(pc.dim('Native memory files were left untouched (auto-memory is disabled by default, so they will not grow).'));
}
