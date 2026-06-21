import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, renameSync, copyFileSync, unlinkSync, rmdirSync } from 'fs';
import { join, basename } from 'path';
import pc from 'picocolors';
import { claudeConfigDirectory, isPluginInstalled } from '../utils/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';

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
 * After a project's notes are confirmed ingested (the worker's queue for that
 * session drains), the original native files are ARCHIVED out of Claude Code's
 * active memory location into ~/.claude-mem/migrated/<encoded-project>/ so the
 * native memory is preserved but no longer live. Archiving never happens until
 * ingestion is confirmed, and `--keep-source` skips it entirely.
 */

interface MigrateOptions {
  dryRun: boolean;
  keepSource: boolean;
  project?: string;
}

interface NativeProject {
  encodedName: string;
  memoryDir: string;
  cwd: string;
  project: string; // claude-mem project name resolved from cwd (git-root/worktree aware)
  displayName: string;
  files: string[]; // absolute paths of topic .md files (MEMORY.md index excluded)
}

function parseArgs(extra: string[]): MigrateOptions {
  const opts: MigrateOptions = {
    dryRun: extra.includes('--dry-run'),
    keepSource: extra.includes('--keep-source'),
  };
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
      // Each line is a standalone JSON object. Parse lines and read the
      // top-level `cwd` field — never a regex over the whole file, which could
      // match a nested `"cwd"` embedded in a tool_input/tool_response blob and
      // misattribute the entire project's migrated observations.
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as { cwd?: unknown };
          if (typeof entry.cwd === 'string' && entry.cwd) return entry.cwd;
        } catch {
          // not valid JSON on its own — skip this line
        }
      }
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
    // Resolve the claude-mem project name the same way the worker does, so the
    // migrated observations are attributed exactly as live capture would.
    const project = getProjectContext(cwd).primary || basename(cwd);
    result.push({
      encodedName: entry.name,
      memoryDir,
      cwd,
      project,
      displayName: project,
      files,
    });
  }
  return result;
}

const SKIP_PROJECT_PHRASE = 'session-memory'; // worker auto-skips file paths containing this

async function postObservation(
  port: string | number,
  contentSessionId: string,
  project: NativeProject,
  filePath: string,
): Promise<{ ok: boolean; status?: string; reason?: string; error?: string }> {
  const fileName = basename(filePath);
  const content = readFileSync(filePath, 'utf8');

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Initialize a session before posting observations — mirrors what the live hook
 * does on session start. Without this, the SDK agent receives a lone
 * continuation message with no observer-role context and returns an idle/non-XML
 * response, so NOTHING gets stored. The framing prompt tells the agent these are
 * saved memory notes to record.
 */
async function initSession(
  port: string | number,
  contentSessionId: string,
  project: string,
  promptText: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `http://127.0.0.1:${port}/api/sessions/init`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentSessionId, project, prompt: promptText, platformSource: 'claude-code' }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Poll until the worker has actually STORED this session's observations AND the
 * count has settled. queueLength reaching 0 is not enough — an idle/dropped batch
 * also drains to 0 with nothing stored (which previously caused source files to
 * be archived without their memory being saved). And a single note can yield
 * MORE than one observation across consecutive agent turns, so returning at the
 * first stored row would backdate only some of them. We therefore require: the
 * queue drained, at least one observation stored, and the stored count unchanged
 * across two consecutive checks (settled). Returns confirmed=false on timeout, in
 * which case the caller must NOT archive.
 */
async function waitForStored(
  port: string | number,
  contentSessionId: string,
  timeoutMs = 240_000,
): Promise<{ confirmed: boolean; stored: number }> {
  const url = `http://127.0.0.1:${port}/api/sessions/status?contentSessionId=${encodeURIComponent(contentSessionId)}`;
  const start = Date.now();
  await sleep(1500);
  let lastStored = 0;
  let prevStored = -1;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { status?: string; queueLength?: number; storedObservations?: number };
        if (typeof data.storedObservations === 'number') lastStored = data.storedObservations;
        const drained = data.status === 'not_found' || data.queueLength === 0;
        // Settled = drained, ≥1 stored, and the count hasn't changed since the
        // previous poll (no more trailing observations on the way).
        if (drained && lastStored >= 1 && lastStored === prevStored) {
          return { confirmed: true, stored: lastStored };
        }
        prevStored = drained ? lastStored : -1;
      }
    } catch {
      // transient — keep polling
    }
    await sleep(2000);
  }
  return { confirmed: false, stored: lastStored };
}

/**
 * Authoritatively date this session's stored observations by the source file's
 * mtime, after storage. This is the reliable dating path: the enqueue-time hint
 * doesn't survive the agent's idle turns, so we correct it here. Returns the
 * number of observations updated.
 */
async function backdateSession(
  port: string | number,
  contentSessionId: string,
  epochMs: number,
): Promise<number> {
  const url = `http://127.0.0.1:${port}/api/sessions/backdate`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentSessionId, timestampEpoch: epochMs }),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { updated?: number };
    return typeof data.updated === 'number' ? data.updated : 0;
  } catch {
    return 0;
  }
}

/**
 * Move every file out of a project's native memory dir into
 * ~/.claude-mem/migrated/<encoded-project>/, then remove the now-empty dir.
 * Uses rename, falling back to copy+unlink across filesystem boundaries.
 */
function archiveProject(project: NativeProject, dataDir: string): { moved: number; dest: string } {
  const dest = join(dataDir, 'migrated', project.encodedName);
  mkdirSync(dest, { recursive: true });

  let moved = 0;
  for (const name of readdirSync(project.memoryDir)) {
    const from = join(project.memoryDir, name);
    const to = join(dest, name);
    try {
      renameSync(from, to);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'EXDEV') {
        copyFileSync(from, to);
        unlinkSync(from);
      } else {
        throw error;
      }
    }
    moved++;
  }

  // Best-effort: drop the emptied memory dir so discovery won't re-find it.
  try {
    rmdirSync(project.memoryDir);
  } catch {
    // leave it if not empty / not removable
  }

  return { moved, dest };
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
    // displayName is just the project name (often a folder basename), so two
    // distinct checkouts can share it (e.g. client-a/myapp and client-b/myapp).
    // Warn rather than silently migrating both, and show the encoded names so
    // the user can re-run with an exact --project <encodedName> if needed.
    if (projects.length > 1) {
      console.log(pc.yellow(`Warning: --project ${opts.project} matched ${projects.length} projects:`));
      for (const p of projects) {
        console.log(`  ${pc.cyan(p.cwd)} ${pc.dim(`(${p.encodedName})`)}`);
      }
      console.log(pc.dim('All of the above will be migrated. Re-run with --project <encoded-name> to target just one.'));
      console.log();
    }
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

  // Resolve from the user's settings FILE, not SettingsDefaultsManager.get()
  // which returns compiled defaults and ignores a configured non-default port.
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const port = settings.CLAUDE_MEM_WORKER_PORT;
  const dataDir = settings.CLAUDE_MEM_DATA_DIR;

  let stored = 0;
  let skipped = 0;
  let failed = 0;
  let archivedProjects = 0;
  // Sessions we successfully dated, kept for a final re-date sweep: a busy worker
  // can emit a second observation for a note long after its initial backdate, so
  // we re-apply the date once everything has been processed.
  const datedSessions: Array<{ contentSessionId: string; mtimeMs: number }> = [];

  for (const project of projects) {
    let confirmedFiles = 0;

    // One session per file: gives each note its own observation to confirm and
    // its own source date, and lets us archive a project only once every one of
    // its notes is verified stored.
    for (const filePath of project.files) {
      const fileName = basename(filePath);
      const contentSessionId = `native-memory-import:${project.encodedName}:${fileName}`;
      const mtimeMs = statSync(filePath).mtimeMs;

      // Initialize the session first so the agent compresses the note instead of
      // returning an idle response (the batch would otherwise be dropped).
      const framing =
        `Importing a saved memory note from Claude Code's native auto-memory for the "${project.project}" project ` +
        `(source file: ${fileName}). It is a long-term memory note the user previously saved (a preference, ` +
        `convention, or project fact). Record what the note says as an observation.`;
      const init = await initSession(port, contentSessionId, project.project, framing);
      if (!init.ok) {
        if (isConnRefused(init.error)) {
          console.error(pc.red('\nWorker is not running.'));
          console.error(`Start it with: ${pc.bold('npx claude-mem start')}, then re-run this command.`);
          process.exit(1);
        }
        failed++;
        console.log(`  ${pc.red('✗')} ${project.displayName}/${fileName} — session init failed: ${init.error}`);
        continue;
      }

      const result = await postObservation(port, contentSessionId, project, filePath);
      if (!result.ok) {
        if (isConnRefused(result.error)) {
          console.error(pc.red('\nWorker is not running.'));
          console.error(`Start it with: ${pc.bold('npx claude-mem start')}, then re-run this command.`);
          process.exit(1);
        }
        failed++;
        console.log(`  ${pc.red('✗')} ${project.displayName}/${fileName} — ${result.error}`);
        continue;
      }
      if (result.status === 'skipped') {
        skipped++;
        console.log(`  ${pc.yellow('-')} ${project.displayName}/${fileName} ${pc.dim(`(skipped: ${result.reason})`)}`);
        continue;
      }

      process.stdout.write(pc.dim(`    …compressing ${project.displayName}/${fileName}`));
      const { confirmed } = await waitForStored(port, contentSessionId);
      if (!confirmed) {
        failed++;
        console.log(`\r  ${pc.yellow('!')} ${project.displayName}/${fileName}: not confirmed stored in time — left in place            `);
        continue;
      }

      // Date the stored observation(s) by the note's mtime (authoritative).
      const updated = await backdateSession(port, contentSessionId, Math.floor(mtimeMs));
      datedSessions.push({ contentSessionId, mtimeMs });
      stored++;
      confirmedFiles++;
      const dated = updated > 0 ? `, dated ${new Date(mtimeMs).toISOString().slice(0, 10)}` : '';
      console.log(`\r  ${pc.green('✓')} ${project.displayName}/${fileName}: stored${dated}            `);
    }

    // Archive the whole project's native memory dir only when EVERY note was
    // confirmed stored — never move a source file before its memory is safely in.
    if (!opts.keepSource && project.files.length > 0) {
      if (confirmedFiles === project.files.length) {
        const { moved, dest } = archiveProject(project, dataDir);
        archivedProjects++;
        console.log(`  ${pc.green('📦')} ${project.displayName}: archived ${moved} file(s) → ${pc.dim(dest)}`);
      } else {
        console.log(`  ${pc.yellow('!')} ${project.displayName}: ${confirmedFiles}/${project.files.length} notes confirmed — leaving native files in place`);
      }
    }
  }

  // Final re-date sweep: catch any trailing observations the agent emitted for a
  // note after its initial backdate (idempotent; cheap UPDATE per session).
  if (datedSessions.length > 0) {
    await sleep(5000);
    for (const d of datedSessions) {
      await backdateSession(port, d.contentSessionId, Math.floor(d.mtimeMs));
    }
  }

  console.log();
  console.log(pc.bold('Migration complete:'));
  console.log(`  ${pc.green(`${stored} note(s) migrated`)}${skipped ? pc.yellow(`, ${skipped} skipped`) : ''}${failed ? pc.red(`, ${failed} failed/unconfirmed`) : ''}`);
  if (!opts.keepSource) {
    console.log(`  ${pc.cyan(`${archivedProjects} project(s) archived`)} ${pc.dim(`to ${join(dataDir, 'migrated')}`)}`);
  } else {
    console.log(pc.dim('  Source files kept in place (--keep-source).'));
  }
}
