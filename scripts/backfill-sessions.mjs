#!/usr/bin/env node
/**
 * backfill-sessions.mjs — Backfill claude-mem from Claude Code JSONL session files.
 *
 * Reads JSONL session logs from ~/.claude/projects/, extracts meaningful events
 * (file edits, bash commands, user prompts), and imports them into claude-mem
 * via the worker /api/import endpoint.
 *
 * Part of the claude-mem plugin. Works on any system without modification.
 *
 * Usage:
 *   node backfill-sessions.mjs --list                   # List available projects
 *   node backfill-sessions.mjs --all --dry-run          # Preview all projects
 *   node backfill-sessions.mjs --project=myapp          # Import single project
 *   node backfill-sessions.mjs --all                    # Import all projects
 *   node backfill-sessions.mjs --project=api --after=2026-01-01 --dry-run
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { request } from 'node:http';

// --- Environment guard ---

if (!process.env.HOME) {
  console.error('Error: $HOME environment variable is not set.');
  process.exit(1);
}

// --- Worker port resolution ---

/**
 * Resolve the claude-mem worker port.
 * Priority: env var > settings.json > default 37777.
 */
function resolveWorkerPort() {
  if (process.env.CLAUDE_MEM_WORKER_PORT) {
    return parseInt(process.env.CLAUDE_MEM_WORKER_PORT, 10);
  }

  const settingsPath = join(process.env.HOME, '.claude-mem/settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.CLAUDE_MEM_WORKER_PORT) {
        return parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
      }
    } catch {
      // Fall through to default.
    }
  }

  return 37777;
}

const WORKER_PORT = resolveWorkerPort();
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const PROJECTS_BASE = join(process.env.HOME, '.claude/projects');

// --- Dynamic path helpers ---

/**
 * Convert a filesystem path to the Claude Code directory name format.
 * e.g. "/home/alice" -> "-home-alice"
 */
function pathToDirName(fsPath) {
  return fsPath.replace(/[\\/]/g, '-');
}

/**
 * Get the home prefix used in Claude Code project directory names.
 * e.g. $HOME="/home/alice" -> "-home-alice-"
 */
function getHomePrefix() {
  return pathToDirName(process.env.HOME) + '-';
}

/**
 * Compute which directories to skip — parent-prefix dirs and observer dirs.
 * A dir is a "parent prefix" if it is a prefix of another dir in the set.
 * e.g. "-home-alice-sites" is a prefix of "-home-alice-sites-myapp".
 */
function computeSkipDirs(allDirNames) {
  const skip = new Set();
  const sorted = [...allDirNames].sort();

  for (let i = 0; i < sorted.length; i++) {
    const candidate = sorted[i] + '-';
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startsWith(candidate)) {
        skip.add(sorted[i]);
        break;
      }
    }
  }

  // Always skip observer session dirs.
  for (const name of allDirNames) {
    if (name.endsWith('-claude-mem-observer-sessions')) {
      skip.add(name);
    }
  }

  return skip;
}

// --- Project discovery ---

/**
 * Derive a short project name from a Claude Code project directory name.
 * Strips the $HOME-based prefix dynamically.
 * e.g. "-home-alice-sites-myapp" -> "myapp" (if -home-alice-sites- is a prefix dir)
 *      "-home-alice-myproject"   -> "myproject"
 */
function deriveProjectName(dirName, homePrefix, skipDirs) {
  // Try stripping skip-dir prefixes (longest first) for deeper nesting.
  const prefixes = [...skipDirs]
    .map(d => d + '-')
    .sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (dirName.startsWith(prefix)) {
      return dirName.slice(prefix.length);
    }
  }

  // Fall back to stripping the home prefix.
  if (dirName.startsWith(homePrefix)) {
    return dirName.slice(homePrefix.length);
  }

  // Last resort: strip leading dash.
  return dirName.startsWith('-') ? dirName.slice(1) : dirName;
}

/**
 * Scan ~/.claude/projects/ and return an array of discovered projects.
 */
function discoverProjects() {
  if (!existsSync(PROJECTS_BASE)) {
    console.error(`Projects directory not found: ${PROJECTS_BASE}`);
    process.exit(1);
  }

  const entries = readdirSync(PROJECTS_BASE, { withFileTypes: true });
  const allDirNames = entries.filter(e => e.isDirectory()).map(e => e.name);
  const skipDirs = computeSkipDirs(allDirNames);
  const homePrefix = getHomePrefix();

  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (skipDirs.has(entry.name)) continue;

    const dirPath = join(PROJECTS_BASE, entry.name);
    const jsonlFiles = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;

    projects.push({
      dirName: entry.name,
      dirPath,
      projectName: deriveProjectName(entry.name, homePrefix, skipDirs),
      fileCount: jsonlFiles.length,
    });
  }

  // Sort by file count descending.
  projects.sort((a, b) => b.fileCount - a.fileCount);
  return projects;
}

// --- CLI argument parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: false,
    afterDate: null,
    sessionId: null,
    minTools: 5,
    verbose: false,
    list: false,
    all: false,
    project: null,
  };

  for (const arg of args) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--all') opts.all = true;
    else if (arg.startsWith('--project=')) opts.project = arg.slice(10);
    else if (arg.startsWith('--after=')) {
      opts.afterDate = new Date(arg.slice(8));
      if (isNaN(opts.afterDate.getTime())) {
        console.error(`Error: Invalid date "${arg.slice(8)}". Use YYYY-MM-DD format.`);
        process.exit(1);
      }
    }
    else if (arg.startsWith('--session=')) opts.sessionId = arg.slice(10);
    else if (arg.startsWith('--min-tools=')) opts.minTools = parseInt(arg.slice(12), 10);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node backfill-sessions.mjs [options]

Options:
  --list             List available projects with session counts
  --all              Process all discovered projects
  --project=<name>   Process a single project (e.g., --project=myapp)
  --dry-run          Preview what would be imported without sending to API
  --after=YYYY-MM-DD Only process sessions after this date
  --session=<uuid>   Process a single session file (requires --project)
  --min-tools=N      Minimum tool calls to include a session (default: 5)
  --verbose, -v      Show detailed output per session
  --help, -h         Show this help message

Examples:
  node backfill-sessions.mjs --list
  node backfill-sessions.mjs --all --dry-run
  node backfill-sessions.mjs --project=myapp
  node backfill-sessions.mjs --project=api --after=2026-01-01 --dry-run
`);
      process.exit(0);
    }
  }
  return opts;
}

// --- JSONL parsing ---

/**
 * Parse a JSONL file into an array of entries.
 * Skips lines that fail JSON parsing.
 */
function parseJsonl(filePath) {
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];

  const entries = [];
  for (const line of content.split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

// --- Session extraction ---

/** Tools that modify files - these become observations. */
const MODIFY_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** Tools that are read-only discovery - skip for observations. */
const SKIP_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Skill', 'AskUserQuestion', 'WebFetch',
  'WebSearch', 'EnterPlanMode', 'ExitPlanMode', 'TodoRead', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'NotebookRead',
]);

/**
 * Determine whether a Bash tool call is meaningful enough to record.
 * Covers a wide range of development tools and frameworks.
 */
function isSignificantBash(input) {
  const cmd = (input?.command || '').trim();
  if (!cmd) return false;

  const trivialPrefixes = [
    'ls ', 'cat ', 'head ', 'tail ', 'echo ', 'pwd', 'which ', 'type ',
    'file ', 'wc ', 'stat ', 'whoami', 'hostname', 'date', 'uname',
    'pip3 list', 'pip list', 'npm list', 'node -v', 'php -v',
  ];
  const lowerCmd = cmd.toLowerCase();
  if (trivialPrefixes.some(p => lowerCmd.startsWith(p))) return false;

  const significantPatterns = [
    // VCS.
    /^git\s+(commit|push|merge|rebase|checkout|branch|stash|tag|cherry-pick|reset|revert|bisect|pull|clone|init|remote|submodule)/i,
    // Package managers.
    /^(npm|yarn|pnpm|bun)\s+(run|build|install|test|add|remove|create|exec|dlx)/i,
    /^(pip3?|pipx|uv)\s+(install|uninstall|freeze)/i,
    /^(cargo|rustup)\s+(build|test|run|install|add|new|init|publish|clippy|fmt)/i,
    /^(composer)\s+(require|install|update|remove|create-project|dump-autoload)/i,
    /^(bundle|gem)\s+(install|exec|add|update|build)/i,
    /^(go)\s+(build|test|run|install|get|mod|generate|vet)/i,
    // Framework CLIs.
    /^(ddev|drush|wp|artisan|rails|django-admin|manage\.py|next|nuxt|vite|astro|gatsby|nx|turbo)\s/i,
    // Infrastructure.
    /^(docker|docker-compose|podman)\s+(build|run|exec|compose|push|pull|up|down|stop|start|restart)/i,
    /^(terraform|tofu)\s+(init|plan|apply|destroy|import|state)/i,
    /^(kubectl|helm|minikube|kind)\s/i,
    /^(aws|gcloud|az)\s/i,
    // Testing.
    /^(pytest|jest|mocha|vitest|phpunit|rspec|cypress|playwright)\s/i,
    /^npx\s+(jest|vitest|mocha|cypress|playwright)/i,
    // Database.
    /^(mysql|psql|sqlite3|mongosh|redis-cli)\s/i,
    // Build tools.
    /^(make|cmake|gradle|mvn|ant|sbt|lein)\s/i,
    // Script execution.
    /^(python3?|ruby|php|node|bun|deno|tsx|ts-node)\s/i,
    // Piped commands (investigation).
    /\|\s*(grep|sort|awk|sed|xargs|jq|yq|tee)\s/,
    // HTTP tools.
    /^(curl|wget|httpie|http)\s/i,
  ];
  return significantPatterns.some(p => p.test(cmd));
}

/**
 * Extract auto-concepts from file paths.
 * Framework-agnostic: detects languages, file types, and common patterns.
 */
function extractConcepts(files) {
  const concepts = new Set();
  for (const f of files) {
    // Languages.
    if (/\.(js|mjs|cjs)$/.test(f)) concepts.add('javascript');
    if (/\.(ts|tsx)$/.test(f)) concepts.add('typescript');
    if (/\.(jsx)$/.test(f)) concepts.add('react');
    if (/\.py$/.test(f)) concepts.add('python');
    if (/\.rb$/.test(f)) concepts.add('ruby');
    if (/\.go$/.test(f)) concepts.add('go');
    if (/\.(rs)$/.test(f)) concepts.add('rust');
    if (/\.(java|kt|scala)$/.test(f)) concepts.add('java');
    if (/\.php$/.test(f)) concepts.add('php');
    if (/\.(swift|m)$/.test(f)) concepts.add('swift');
    if (/\.(c|cpp|cc|cxx|h|hpp)$/.test(f)) concepts.add('c-cpp');
    if (/\.(sh|bash|zsh)$/.test(f)) concepts.add('shell');

    // Patterns.
    if (/\.(css|scss|sass|less|styl)$/.test(f)) concepts.add('css');
    if (/\.(html|twig|ejs|hbs|pug|njk|jinja2?|erb|blade\.php|svelte|vue|astro)$/.test(f)) concepts.add('template');
    if (/\.sql$/.test(f)) concepts.add('sql');
    if (/\.(json|ya?ml|toml|ini|env|cfg)$/.test(f)) concepts.add('config');
    if (/[Dd]ocker/.test(f) || /docker-compose/.test(f)) concepts.add('docker');
    if (/migrat/i.test(f)) concepts.add('migration');
    if (/\.(test|spec)\.(js|ts|py|rb|php|go|rs|java)/.test(f) || /test/i.test(f)) concepts.add('testing');
    if (/\.(md|mdx|rst|txt|adoc)$/.test(f)) concepts.add('documentation');
  }
  return [...concepts];
}

/**
 * Truncate a string to maxLen characters.
 */
function truncate(str, maxLen = 200) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * Extract text content from a message content field (string or content array).
 */
function cleanMetaTags(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractText(content) {
  if (typeof content === 'string') return cleanMetaTags(content);
  if (!Array.isArray(content)) return '';
  const raw = content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
  return cleanMetaTags(raw);
}

/**
 * Strip the project root path from a file path for shorter display.
 * Uses the session's cwd when available, falls back to $HOME stripping.
 */
function stripProjectRoot(filePath, cwd) {
  if (cwd && filePath.startsWith(cwd)) {
    const stripped = filePath.slice(cwd.length);
    // Remove leading slash.
    return stripped.startsWith('/') ? stripped.slice(1) : stripped;
  }
  // Fallback: strip $HOME prefix.
  const home = process.env.HOME || '';
  if (home && filePath.startsWith(home)) {
    return filePath.slice(home.length + 1);
  }
  return filePath;
}

/**
 * Process a single JSONL session file and return structured import data.
 */
function processSession(filePath, opts, projectName) {
  const entries = parseJsonl(filePath);
  if (entries.length === 0) return { skipped: 'no_user' };

  // Find the first user entry for session metadata.
  const firstUser = entries.find(
    e => e.type === 'user' && e.sessionId && e.message?.role === 'user'
  );
  if (!firstUser) return { skipped: 'no_user' };

  const sessionId = firstUser.sessionId;
  const memorySessionId = `backfill-${sessionId}`;
  const gitBranch = firstUser.gitBranch || '';
  const cwd = firstUser.cwd || '';
  const sessionTimestamp = firstUser.timestamp || new Date().toISOString();
  const sessionEpoch = new Date(sessionTimestamp).getTime();

  // Date filter.
  if (opts.afterDate && sessionEpoch < opts.afterDate.getTime()) return { skipped: 'date' };

  // Collect all tool_use items from assistant entries.
  const toolCalls = [];
  const filesRead = new Set();
  const filesModified = new Set();

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (item.type !== 'tool_use') continue;
      toolCalls.push({
        name: item.name,
        input: item.input || {},
        timestamp: entry.timestamp,
        id: item.id,
      });

      // Track files.
      const fp = item.input?.file_path || item.input?.path;
      if (fp) {
        if (MODIFY_TOOLS.has(item.name)) filesModified.add(fp);
        if (item.name === 'Read' || item.name === 'Glob') filesRead.add(fp);
      }
      // Track Grep paths.
      if (item.name === 'Grep' && item.input?.path) filesRead.add(item.input.path);
    }
  }

  // Filter: skip sessions with too few tool calls.
  if (toolCalls.length < opts.minTools) return { skipped: 'too_small' };

  // Extract user prompts.
  let promptNumber = 0;
  const prompts = [];
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    const msg = entry.message;
    if (!msg || msg.role !== 'user') continue;

    // Only real user text, not tool_result entries.
    const text = extractText(msg.content);
    if (!text) continue;

    // Skip meta/skill injection prompts and system-injected content.
    if (text.startsWith('Base directory for this skill:')) continue;
    if (text.startsWith('Launching skill:')) continue;
    if (text.startsWith('<local-command-caveat>')) continue;
    if (text.startsWith('<command-message>')) continue;
    if (text.startsWith('[Request interrupted by user')) continue;
    if (text.startsWith('# /van')) continue;
    if (text === '' || text.length < 3) continue;

    prompts.push({
      content_session_id: sessionId,
      prompt_number: promptNumber,
      prompt_text: truncate(text, 2000),
      created_at: entry.timestamp || sessionTimestamp,
      created_at_epoch: new Date(entry.timestamp || sessionTimestamp).getTime(),
    });
    promptNumber++;
  }

  // Build observations from meaningful tool calls.
  const observations = [];
  for (const tc of toolCalls) {
    if (SKIP_TOOLS.has(tc.name)) continue;

    let shouldInclude = false;
    let obsType = 'change';
    let title = '';
    let narrative = '';
    let obsFilesModified = [];

    if (MODIFY_TOOLS.has(tc.name)) {
      shouldInclude = true;
      const fp = tc.input.file_path || '';
      const shortPath = stripProjectRoot(fp, cwd);
      title = `${tc.name} ${shortPath}`;

      if (tc.name === 'Edit') {
        const oldStr = truncate(tc.input.old_string, 100);
        const newStr = truncate(tc.input.new_string, 100);
        narrative = `Edited ${shortPath}: replaced "${oldStr}" with "${newStr}"`;
      } else {
        narrative = `Wrote file ${shortPath}`;
      }
      obsFilesModified = fp ? [fp] : [];
    } else if (tc.name === 'Bash' && isSignificantBash(tc.input)) {
      shouldInclude = true;
      obsType = 'feature';
      const cmd = truncate(tc.input.command, 200);
      title = `Bash: ${tc.input.description || cmd.slice(0, 60)}`;
      narrative = `Executed: ${cmd}`;
    } else if (tc.name === 'Task') {
      shouldInclude = true;
      obsType = 'feature';
      title = `Task: ${truncate(tc.input.description || tc.input.prompt || '', 60)}`;
      narrative = `Delegated task: ${truncate(tc.input.prompt || '', 200)}`;
    }

    if (!shouldInclude) continue;

    const allFiles = [...new Set([...filesModified, ...obsFilesModified])];

    observations.push({
      memory_session_id: memorySessionId,
      project: projectName,
      text: null,
      type: obsType,
      title: truncate(title, 120),
      subtitle: gitBranch ? `Branch: ${gitBranch}` : null,
      facts: null,
      narrative: truncate(narrative, 500),
      concepts: JSON.stringify(extractConcepts(allFiles)),
      files_read: null,
      files_modified: JSON.stringify(obsFilesModified),
      prompt_number: 0,
      discovery_tokens: 0,
      created_at: tc.timestamp || sessionTimestamp,
      created_at_epoch: new Date(tc.timestamp || sessionTimestamp).getTime(),
    });
  }

  // Build session record.
  const firstPromptText = prompts.length > 0 ? prompts[0].prompt_text : '(no prompt)';
  const session = {
    content_session_id: sessionId,
    memory_session_id: memorySessionId,
    project: projectName,
    user_prompt: truncate(firstPromptText, 500),
    started_at: sessionTimestamp,
    started_at_epoch: sessionEpoch,
    completed_at: null,
    completed_at_epoch: null,
    status: 'completed',
  };

  // Build summary.
  const allModified = [...filesModified].map(f => stripProjectRoot(f, cwd));
  const allRead = [...filesRead].map(f => stripProjectRoot(f, cwd));
  const summary = {
    memory_session_id: memorySessionId,
    project: projectName,
    request: truncate(firstPromptText, 500),
    investigated: null,
    learned: null,
    completed: allModified.length > 0
      ? `Modified ${allModified.length} file(s): ${truncate(allModified.join(', '), 400)}`
      : 'No files modified',
    next_steps: null,
    files_read: JSON.stringify(allRead.slice(0, 50)),
    files_edited: JSON.stringify(allModified.slice(0, 50)),
    notes: `Branch: ${gitBranch || 'unknown'}, Tool calls: ${toolCalls.length}`,
    prompt_number: 0,
    discovery_tokens: 0,
    created_at: sessionTimestamp,
    created_at_epoch: sessionEpoch,
  };

  return {
    session,
    observations,
    summary,
    prompts,
    meta: {
      sessionId,
      file: basename(filePath),
      toolCalls: toolCalls.length,
      observations: observations.length,
      prompts: prompts.length,
      filesModified: filesModified.size,
      gitBranch,
      date: sessionTimestamp.slice(0, 10),
    },
  };
}

// --- API interaction ---

/**
 * POST JSON data to the claude-mem worker API.
 * Uses built-in http.request (no external deps).
 */
function postToApi(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(path, WORKER_URL);

    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`API ${res.statusCode}: ${responseBody}`));
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            resolve({ raw: responseBody });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Check if the claude-mem worker is running.
 */
async function checkWorkerHealth() {
  try {
    const result = await postToApi('/api/stats', {});
    return true;
  } catch {
    // Try a GET request instead.
    return new Promise((resolve) => {
      const url = new URL('/api/stats', WORKER_URL);
      const req = request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(res.statusCode < 400));
        }
      );
      req.on('error', () => resolve(false));
      req.end();
    });
  }
}

// --- Batch import ---

/**
 * Import sessions one at a time.
 * Each session is imported individually because the observations/summaries
 * have a FK constraint on memory_session_id. If a session already exists
 * (duplicate content_session_id), we skip its observations/summary to avoid
 * FK violations (the existing session has a different memory_session_id).
 */
async function importAll(results) {
  const totalStats = {
    sessionsImported: 0, sessionsSkipped: 0,
    summariesImported: 0, summariesSkipped: 0,
    observationsImported: 0, observationsSkipped: 0,
    promptsImported: 0, promptsSkipped: 0,
  };

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const progress = `[${(i + 1).toString().padStart(3)}/${results.length}]`;

    // Step 1: Import the session first to check if it's a duplicate.
    const sessionPayload = {
      sessions: [r.session],
      observations: [],
      summaries: [],
      prompts: [],
    };

    let sessionResponse;
    try {
      sessionResponse = await postToApi('/api/import', sessionPayload);
    } catch (err) {
      process.stdout.write(`${progress} ERROR session ${r.meta.file}: ${err.message}\n`);
      continue;
    }

    const sessionImported = (sessionResponse.stats?.sessionsImported || 0) > 0;

    if (!sessionImported) {
      // Session already exists with different memory_session_id.
      // Skip observations/summary to avoid FK constraint violation.
      totalStats.sessionsSkipped++;
      totalStats.observationsSkipped += r.observations.length;
      totalStats.summariesSkipped++;
      totalStats.promptsSkipped += r.prompts.length;
      process.stdout.write(`${progress} SKIP ${r.meta.date} ${r.meta.gitBranch || '-'} (session exists)\n`);
      continue;
    }

    totalStats.sessionsImported++;

    // Step 2: Import observations, summary, and prompts for this session.
    const dataPayload = {
      sessions: [],
      observations: r.observations,
      summaries: [r.summary],
      prompts: r.prompts,
    };

    try {
      const dataResponse = await postToApi('/api/import', dataPayload);
      const stats = dataResponse.stats || {};

      totalStats.summariesImported += stats.summariesImported || 0;
      totalStats.summariesSkipped += stats.summariesSkipped || 0;
      totalStats.observationsImported += stats.observationsImported || 0;
      totalStats.observationsSkipped += stats.observationsSkipped || 0;
      totalStats.promptsImported += stats.promptsImported || 0;
      totalStats.promptsSkipped += stats.promptsSkipped || 0;

      process.stdout.write(
        `${progress} OK   ${r.meta.date} ${(r.meta.gitBranch || '-').padEnd(28)} ` +
        `+${stats.observationsImported || 0} obs, ${r.prompts.length} prompts\n`
      );
    } catch (err) {
      process.stdout.write(`${progress} ERROR data ${r.meta.file}: ${err.message}\n`);
    }
  }

  return totalStats;
}

// --- Per-project processing ---

/**
 * Process all sessions for a single project and return results + stats.
 */
function processProjectSessions(project, opts) {
  const { dirPath, projectName } = project;

  let files;
  if (opts.sessionId) {
    const target = join(dirPath, `${opts.sessionId}.jsonl`);
    try {
      statSync(target);
      files = [target];
    } catch {
      console.error(`  Session file not found: ${target}`);
      return { results: [], skippedTooSmall: 0, skippedNoData: 0, skippedByDate: 0, errors: 0 };
    }
  } else {
    files = readdirSync(dirPath)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(dirPath, f))
      .sort();
  }

  const results = [];
  let skippedTooSmall = 0;
  let skippedNoData = 0;
  let skippedByDate = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const result = processSession(file, opts, projectName);
      if (result.skipped) {
        if (result.skipped === 'date') skippedByDate++;
        else if (result.skipped === 'too_small') skippedTooSmall++;
        else skippedNoData++;
        continue;
      }
      results.push(result);
      if (opts.verbose) {
        console.log(
          `  [${result.meta.date}] ${result.meta.file} - ` +
          `${result.meta.toolCalls} tools, ${result.meta.observations} obs, ` +
          `${result.meta.prompts} prompts, ${result.meta.filesModified} files ` +
          `(${result.meta.gitBranch || 'no branch'})`
        );
      }
    } catch (err) {
      errors++;
      if (opts.verbose) {
        console.error(`  ERROR processing ${basename(file)}: ${err.message}`);
      }
    }
  }

  return { results, skippedTooSmall, skippedNoData, skippedByDate, errors };
}

// --- Main ---

async function main() {
  const opts = parseArgs();
  const projects = discoverProjects();

  console.log('=== claude-mem Backfill from JSONL Sessions ===\n');

  // --list: show available projects and exit.
  if (opts.list) {
    console.log(`Found ${projects.length} projects in ${PROJECTS_BASE}\n`);
    console.log('  Project Name'.padEnd(50) + 'Sessions  Directory');
    console.log('  ' + '-'.repeat(80));
    for (const p of projects) {
      console.log(
        `  ${p.projectName.padEnd(48)}${p.fileCount.toString().padStart(5)}    ${p.dirName}`
      );
    }
    console.log(`\nUse --project=<name> or --all to process sessions.`);
    return;
  }

  // Determine which projects to process.
  let selectedProjects;
  if (opts.project) {
    const match = projects.find(
      p => p.projectName === opts.project || p.dirName === opts.project
    );
    if (!match) {
      console.error(`Project "${opts.project}" not found. Use --list to see available projects.`);
      process.exit(1);
    }
    selectedProjects = [match];
  } else if (opts.all) {
    selectedProjects = projects;
  } else {
    // No project flag: show usage hint.
    console.log(`Found ${projects.length} projects. Specify which to process:\n`);
    for (const p of projects.slice(0, 10)) {
      console.log(`  --project=${p.projectName.padEnd(45)} (${p.fileCount} sessions)`);
    }
    if (projects.length > 10) {
      console.log(`  ... and ${projects.length - 10} more (use --list to see all)`);
    }
    console.log(`\n  --all                                                (all ${projects.length} projects)`);
    return;
  }

  if (opts.afterDate) console.log(`Filtering: after ${opts.afterDate.toISOString().slice(0, 10)}`);
  console.log(`Minimum tool calls: ${opts.minTools}`);
  console.log('');

  // Process each selected project.
  const allResults = [];
  const grandTotals = {
    projects: 0,
    files: 0,
    results: 0,
    skippedTooSmall: 0,
    skippedNoData: 0,
    skippedByDate: 0,
    errors: 0,
  };

  for (const project of selectedProjects) {
    console.log(`--- ${project.projectName} (${project.fileCount} files) ---`);

    const { results, skippedTooSmall, skippedNoData, skippedByDate, errors } =
      processProjectSessions(project, opts);

    grandTotals.projects++;
    grandTotals.files += project.fileCount;
    grandTotals.results += results.length;
    grandTotals.skippedTooSmall += skippedTooSmall;
    grandTotals.skippedNoData += skippedNoData;
    grandTotals.skippedByDate += skippedByDate;
    grandTotals.errors += errors;

    const obs = results.reduce((s, r) => s + r.observations.length, 0);
    const prm = results.reduce((s, r) => s + r.prompts.length, 0);
    console.log(
      `  ${results.length} sessions, ${obs} observations, ${prm} prompts` +
      (skippedTooSmall ? `, ${skippedTooSmall} too small` : '') +
      (skippedNoData ? `, ${skippedNoData} no data` : '') +
      (skippedByDate ? `, ${skippedByDate} by date` : '') +
      (errors ? `, ${errors} errors` : '')
    );

    allResults.push(...results);
  }

  // Grand totals.
  const totalObs = allResults.reduce((sum, r) => sum + r.observations.length, 0);
  const totalPrompts = allResults.reduce((sum, r) => sum + r.prompts.length, 0);

  console.log(`\n=== Totals across ${grandTotals.projects} project(s) ===`);
  console.log(`Sessions:     ${allResults.length} with data`);
  console.log(`Observations: ${totalObs}`);
  console.log(`Prompts:      ${totalPrompts}`);
  console.log(`Skipped:      ${grandTotals.skippedTooSmall} too small, ${grandTotals.skippedNoData} no data, ${grandTotals.skippedByDate} by date`);
  if (grandTotals.errors > 0) console.log(`Errors:       ${grandTotals.errors}`);

  if (allResults.length === 0) {
    console.log('\nNothing to import.');
    return;
  }

  if (opts.dryRun) {
    console.log('\n--- DRY RUN: No data sent to API ---');
    console.log('\nTop sessions by observation count:');
    const sorted = [...allResults].sort((a, b) => b.observations.length - a.observations.length);
    for (const r of sorted.slice(0, 15)) {
      console.log(
        `  ${r.meta.date} | ${r.session.project.padEnd(12)} | ` +
        `${r.meta.observations.toString().padStart(3)} obs | ` +
        `${r.meta.filesModified.toString().padStart(2)} files | ` +
        `${(r.meta.gitBranch || '-').padEnd(30)} | ` +
        `${truncate(r.session.user_prompt, 50)}`
      );
    }
    return;
  }

  // Check worker health.
  console.log('\nChecking claude-mem worker...');
  const healthy = await checkWorkerHealth();
  if (!healthy) {
    console.error(`Worker not running at ${WORKER_URL}. Start it first.`);
    process.exit(1);
  }
  console.log('Worker is running.\n');

  // Import.
  console.log('Importing...');
  const stats = await importAll(allResults);

  console.log('\n=== Import Complete ===');
  console.log(`Sessions:     ${stats.sessionsImported} imported, ${stats.sessionsSkipped} skipped`);
  console.log(`Observations: ${stats.observationsImported} imported, ${stats.observationsSkipped} skipped`);
  console.log(`Summaries:    ${stats.summariesImported} imported, ${stats.summariesSkipped} skipped`);
  console.log(`Prompts:      ${stats.promptsImported} imported, ${stats.promptsSkipped} skipped`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
