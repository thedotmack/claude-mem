#!/usr/bin/env node
/**
 * Claude-Mem -> Grok Bot silent session inject.
 *
 * Pulls the worker's existing session-inject text (GET /api/context/inject,
 * Allowed query params only) and lands it in a Grok Bot agent's own memory
 * log as parseable fact lines. The sand host already watches that folder, so
 * the next cold / non-resume turn picks the change up through its mid-epoch
 * frozen-section path (`getFrozenSectionUpdatesForTurn` ->
 * `promptWithInstructionsUpdate`) and the agent sees the context without
 * anybody calling a memory tool.
 *
 * This process binds no port. It only makes outbound HTTP to the local
 * claude-mem worker, and only ever writes one file it owns:
 *
 *     <agent-data>/agents/<agentId>/memory/log/zz-claude-mem-inject.md
 *
 * Sibling of GrokBotAwarenessPusher: awareness lines are `- <date> [awareness]`
 * and deliberately do NOT match the host's fact grammar. Inject lines here use
 * the host's `- (YYYY-MM-DD) <fact>` grammar precisely because they are meant
 * to reach the prompt.
 *
 * Usage:
 *   node scripts/grok-bot-session-inject.mjs --once     # one refresh pass
 *   node scripts/grok-bot-session-inject.mjs --watch    # daemon
 *   node scripts/grok-bot-session-inject.mjs --status   # what is on disk now
 *   node scripts/grok-bot-session-inject.mjs --clear    # remove injected file
 *   ... --dry-run                                       # never write
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Host caps a memory fact at 500 chars after whitespace collapse. Stay under. */
const HOST_MAX_FACT_CHARS = 500;
const INJECT_TAG = '[claude-mem]';
const INJECT_LOG_BASENAME = 'zz-claude-mem-inject.md';

/**
 * The host ranks recalled log facts by
 *   log2(importance) + createdAt / (30 days)
 * and importance comes only from a line prefix: `[episode] ` = 1.5,
 * `[note] ` = 0.5, anything else = 1. log2(1.5) is worth ~17.5 days of
 * recency, so on a seat whose log is already full of episode summaries a
 * plain-tier line loses every slot in the 4000-char recall budget and never
 * reaches the prompt at all. Orifice is exactly that seat. Episode tier is
 * therefore the default: a session-context digest is a session-level summary,
 * which is what that tier ranks. Drop to `plain` on a quiet seat where the
 * feed does not need to outrank the agent's own episodes.
 */
const TIER_PREFIXES = { episode: '[episode] ', plain: '', note: '[note] ' };

const FILE_HEADER = [
  '# Memory log',
  '',
  '<!-- Written by claude-mem grok-bot-session-inject. Rewritten in place on every refresh.',
  '     Content is the worker\'s GET /api/context/inject text for this agent\'s project(s),',
  '     reshaped into the host fact grammar so the next cold turn picks it up.',
  '     Dated facts, one per line as "- (YYYY-MM-DD) <fact>". Safe to read, grep, and edit. -->',
  '',
].join('\n');

/**
 * Legend / format glyph boilerplate and the closing call-to-action: pure noise
 * once this is a memory fact, and the trailer would otherwise sort as the
 * newest row and crowd out a real observation.
 */
const DROP_PREFIXES = ['Legend:', 'Format:', 'Fetch details:', 'Access '];

// ---------------------------------------------------------------- config ----

function homeDir() {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
}

function dataDir() {
  return process.env.CLAUDE_MEM_DATA_DIR?.trim() || path.join(homeDir(), '.claude-mem');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function resolveTier(raw) {
  const tier = String(raw ?? 'episode').trim().toLowerCase();
  return tier in TIER_PREFIXES ? tier : 'episode';
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function hasAgentsAndTranscripts(dir) {
  return existsSync(path.join(dir, 'agents')) && existsSync(path.join(dir, 'agent-transcripts'));
}

/** Same precedence as GrokBotInstaller.discoverGrokBotAgentDataRoot, plus ~/agent-data. */
function discoverAgentDataRoot(env) {
  const override = env.GROK_BOT_AGENT_DATA?.trim();
  if (override) return path.resolve(override);
  const home = homeDir();
  const xdg = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');
  const candidates = [
    path.join(home, 'agent-data'),
    path.join(home, 'sand-data'),
    path.join(home, '.grok-bot'),
    path.join(xdg, 'grok-bot'),
    path.join(home, 'Library', 'Application Support', 'Grok Bot'),
    path.join(home, 'Library', 'Application Support', 'GrokBot'),
    path.join(home, 'Library', 'Application Support', 'xAI', 'Grok Bot'),
    '/home/box',
  ];
  for (const dir of candidates) {
    if (dir && dir !== '/' && hasAgentsAndTranscripts(dir)) return dir;
  }
  return home;
}

/**
 * Config precedence: env > <data>/grok-bot-session-inject.json > <data>/settings.json.
 * The dedicated file keeps pilot wiring out of the live settings.json the
 * worker owns and rewrites.
 */
function loadConfig(env = process.env) {
  const settings = readJson(path.join(dataDir(), 'settings.json'), {});
  const local = readJson(path.join(dataDir(), 'grok-bot-session-inject.json'), {});
  const pick = key => env[key] ?? local[key] ?? settings[key];
  const num = (key, fallback) => {
    const raw = Number(pick(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };

  const agentIds = splitCsv(pick('CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS')).filter(id => AGENT_ID_RE.test(id));

  return {
    enabled: String(pick('CLAUDE_MEM_GROK_BOT_INJECT_ENABLED') ?? '').toLowerCase() === 'true',
    agentIds,
    /** `agentId=projA,projB;agentId2=projC` — overrides transcript-watch.json. */
    projectsByAgent: parseProjectMap(pick('CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT')),
    workerPort: String(pick('CLAUDE_MEM_WORKER_PORT') ?? 37700).trim(),
    /**
     * Unset by default. The house read rule is "do not silently drop other
     * hosts unless the user asked for grok-only memory", and passing
     * platformSource=grok-bot narrows inject to grok-bot-authored sessions.
     * Set it only when a seat really wants a grok-only feed.
     */
    platformSource: String(pick('CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE') ?? '').trim(),
    intervalMs: num('CLAUDE_MEM_GROK_BOT_INJECT_INTERVAL_MS', 120_000),
    minGapMs: num('CLAUDE_MEM_GROK_BOT_INJECT_MIN_GAP_MS', 20_000),
    tier: resolveTier(pick('CLAUDE_MEM_GROK_BOT_INJECT_TIER')),
    // Each emitted line spends its own length out of the host's 4000-char
    // recall budget, evicting that much of the agent's own memory. Keep it
    // small: the point is a pointer into claude-mem, not a second memory.
    maxLines: num('CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINES', 2),
    maxLineChars: Math.min(num('CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS', 460), HOST_MAX_FACT_CHARS - 20),
    timeoutMs: num('CLAUDE_MEM_GROK_BOT_INJECT_TIMEOUT_MS', 8_000),
    // mtime poll used when inotify watches are unavailable (this box runs out
    // of watch descriptors regularly). Two statSync calls per agent per tick.
    pollMs: num('CLAUDE_MEM_GROK_BOT_INJECT_POLL_MS', 10_000),
    agentDataRoot: discoverAgentDataRoot(env),
    stateFile: path.join(dataDir(), 'state', 'grok-bot-session-inject.json'),
    watchConfigFile: path.join(dataDir(), 'transcript-watch.json'),
  };
}

function parseProjectMap(raw) {
  const map = new Map();
  for (const entry of String(raw ?? '').split(';')) {
    const [agentId, projects] = entry.split('=');
    if (!agentId || !projects) continue;
    const id = agentId.trim();
    if (!AGENT_ID_RE.test(id)) continue;
    const list = splitCsv(projects);
    if (list.length > 0) map.set(id.toLowerCase(), list);
  }
  return map;
}

/**
 * Agent -> project comes from the transcript-watch config the Grok Bot
 * installer already writes, so there is exactly one mapping on the box.
 */
function projectsForAgent(cfg, agentId) {
  const override = cfg.projectsByAgent.get(agentId.toLowerCase());
  if (override) return override;
  const watches = readJson(cfg.watchConfigFile, {})?.watches ?? [];
  const projects = [];
  for (const watch of watches) {
    if (String(watch?.agentId ?? '').toLowerCase() !== agentId.toLowerCase()) continue;
    const project = String(watch?.project ?? '').trim();
    if (project && !projects.includes(project)) projects.push(project);
  }
  return projects;
}

// ------------------------------------------------------------- inject io ----

async function fetchInjectOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`worker inject ${res.status}: ${body.slice(0, 200)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInject(cfg, projects) {
  // Allowed params only: projects (comma, last = primary) + platformSource.
  const params = new URLSearchParams({ projects: projects.join(',') });
  if (cfg.platformSource) params.set('platformSource', cfg.platformSource);
  const url = `http://127.0.0.1:${cfg.workerPort}/api/context/inject?${params.toString()}`;

  // The worker lazy-respawns, so a refused connection usually means "between
  // instances", not "gone". Retry briefly before giving up on this pass.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return { url, body: await fetchInjectOnce(url, cfg.timeoutMs) };
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
  throw lastError;
}

// ------------------------------------------------------------ formatting ----

function collapse(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function todayStamp(now) {
  return now.toISOString().slice(0, 10);
}

function factLine(date, body, maxChars, tier) {
  const line = `- (${date}) ${TIER_PREFIXES[tier] ?? ''}${INJECT_TAG} ${collapse(body)}`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

/**
 * Reshape inject text into host-parseable fact lines.
 *
 * Newest-first throughout, and deliberately few: every line spends its own
 * length out of the agent's 4000-char recall budget, so this is a pointer
 * into claude-mem (project, stats, the freshest observation IDs, how to fetch
 * the rest), not a second copy of the memory.
 */
export function injectTextToFactLines(text, { projects, maxLines, maxLineChars, tier = 'episode', now = new Date() }) {
  const date = todayStamp(now);
  const emit = body => factLine(date, body, maxLineChars, tier);
  const lines = String(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !DROP_PREFIXES.some(prefix => line.startsWith(prefix)));

  const meta = [];
  const rows = [];
  for (const line of lines) {
    // `# [project] ...` is the inject header; `### Sep 8, 2026` are date
    // sections that belong with the rows they head.
    const isHeader = line.startsWith('#') && !line.startsWith('##');
    if (isHeader || line.startsWith('Mode:') || line.startsWith('Stats:')) meta.push(line);
    else rows.push(collapse(line));
  }

  const primary = projects[projects.length - 1] ?? 'unknown';
  const head = [
    `Claude-Mem session context for ${primary}`,
    meta
      .map(line => line.replace(/^#\s*/, ''))
      // The inject header carries a fetch clock. Keeping it would make the
      // fact block differ on every poll, so the host would see a "memory
      // changed" delta — and re-announce it on the next turn — for a timestamp
      // and nothing else. Facts already carry a date.
      .map(line => line.replace(/\s*recent context,.*$/, '').trim())
      .filter(Boolean)
      .join(' · '),
    'fetch detail with the claude-mem tools (get_observations by ID)',
  ]
    .filter(Boolean)
    .join(' — ');

  const out = [emit(head)];
  const budget = Math.max(0, maxLines - 1);
  if (rows.length === 0) return out;
  if (budget === 0) return out;

  // Newest first, so a truncated feed loses the oldest rows.
  const newestFirst = rows.slice().reverse();
  let used = 0;
  for (let line = 0; line < budget && used < newestFirst.length; line += 1) {
    const chunk = [];
    let length = 0;
    while (used < newestFirst.length) {
      const row = newestFirst[used];
      const next = chunk.length === 0 ? row.length : length + 3 + row.length;
      if (chunk.length > 0 && next > maxLineChars - 60) break;
      chunk.push(row);
      length = next;
      used += 1;
    }
    if (chunk.length === 0) break;
    const omitted = line === budget - 1 ? newestFirst.length - used : 0;
    const tail = omitted > 0 ? ` (+${omitted} older rows in claude-mem)` : '';
    out.push(emit(`${chunk.join(' | ')}${tail}`));
  }
  return out;
}

// ------------------------------------------------------------- disk write ----

export function injectLogPath(agentDataRoot, agentId) {
  return path.join(agentDataRoot, 'agents', agentId, 'memory', 'log', INJECT_LOG_BASENAME);
}

/** Mirrors the awareness pusher guard: never escape memory/log, never profile.md. */
function assertSafeInjectPath(agentDataRoot, agentId, filePath) {
  const expectedDir = path.resolve(path.join(agentDataRoot, 'agents', agentId, 'memory', 'log'));
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== expectedDir) {
    throw new Error('Refusing inject write outside agent memory/log');
  }
  if (path.basename(resolved) !== INJECT_LOG_BASENAME) {
    throw new Error(`Refusing inject write to a file this shim does not own: ${path.basename(resolved)}`);
  }
}

function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, filePath);
}

function loadState(cfg) {
  return readJson(cfg.stateFile, {});
}

function saveState(cfg, state) {
  mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  writeFileAtomic(cfg.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------- passes ----

async function refreshAgent(cfg, agentId, { dryRun = false, log = () => {} } = {}) {
  const projects = projectsForAgent(cfg, agentId);
  if (projects.length === 0) {
    return { agentId, status: 'skipped', reason: 'no project mapped for agent' };
  }

  const agentDir = path.join(cfg.agentDataRoot, 'agents', agentId);
  if (!existsSync(agentDir)) {
    return { agentId, status: 'skipped', reason: `agent dir missing: ${agentDir}` };
  }

  const { url, body } = await fetchInject(cfg, projects);
  const factLines = injectTextToFactLines(body, {
    projects,
    maxLines: cfg.maxLines,
    maxLineChars: cfg.maxLineChars,
    tier: cfg.tier,
  });
  const contents = `${FILE_HEADER}${factLines.join('\n')}\n`;

  const filePath = injectLogPath(cfg.agentDataRoot, agentId);
  assertSafeInjectPath(cfg.agentDataRoot, agentId, filePath);

  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  // Header stamps a fetch time, so compare the fact block, not the whole file.
  const changed = factBlock(existing) !== factBlock(contents);

  if (!changed) {
    return { agentId, projects, url, status: 'unchanged', filePath, factLines: factLines.length };
  }
  if (dryRun) {
    return { agentId, projects, url, status: 'would-write', filePath, factLines: factLines.length, preview: factLines };
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, contents);
  log(`wrote ${factLines.length} inject facts for ${agentId} (${projects.join(',')}) -> ${filePath}`);

  const state = loadState(cfg);
  state[agentId] = {
    projects,
    filePath,
    factLines: factLines.length,
    bytes: Buffer.byteLength(contents),
    writtenAt: new Date().toISOString(),
  };
  saveState(cfg, state);

  return { agentId, projects, url, status: 'written', filePath, factLines: factLines.length, preview: factLines };
}

function factBlock(contents) {
  return contents
    .split('\n')
    .filter(line => line.startsWith('- ('))
    .join('\n');
}

async function runOnce(cfg, opts) {
  const results = [];
  for (const agentId of cfg.agentIds) {
    try {
      results.push(await refreshAgent(cfg, agentId, opts));
    } catch (error) {
      results.push({ agentId, status: 'error', reason: error?.message ?? String(error) });
    }
  }
  return results;
}

// ----------------------------------------------------------------- watch ----

function runWatch(cfg) {
  const log = message => console.log(`[grok-inject ${new Date().toISOString()}] ${message}`);
  log(`watching ${cfg.agentIds.length} agent(s); worker :${cfg.workerPort}; interval ${cfg.intervalMs}ms; root ${cfg.agentDataRoot}`);

  let lastRunAt = 0;
  let pending = null;
  let running = false;

  const kick = async reason => {
    if (running) return;
    const since = Date.now() - lastRunAt;
    if (since < cfg.minGapMs) {
      if (pending === null) {
        pending = setTimeout(() => {
          pending = null;
          void kick(reason);
        }, cfg.minGapMs - since);
      }
      return;
    }
    running = true;
    lastRunAt = Date.now();
    try {
      for (const result of await runOnce(cfg, { log })) {
        if (result.status === 'error') log(`ERROR ${result.agentId}: ${result.reason}`);
        else if (result.status === 'skipped') log(`skip ${result.agentId}: ${result.reason}`);
      }
    } finally {
      running = false;
    }
  };

  // Turn activity: the host touches the agent's store while a turn runs, and
  // appends to the transcript when it lands. Either is a cue to refresh, so the
  // delta is already staged for the agent's next cold turn.
  const activityPaths = [];
  for (const agentId of cfg.agentIds) {
    for (const dir of [
      path.join(cfg.agentDataRoot, 'agents', agentId),
      path.join(cfg.agentDataRoot, 'agent-transcripts', agentId),
    ]) {
      if (!existsSync(dir)) continue;
      activityPaths.push(dir);
      try {
        watch(dir, { persistent: true }, () => void kick('activity'));
      } catch (error) {
        // Boxes run out of inotify descriptors; the mtime poll below covers it.
        log(`WARN cannot watch ${dir} (${error?.code ?? error?.message}) — falling back to mtime poll`);
      }
    }
  }

  const mtimes = new Map();
  const pollActivity = () => {
    for (const dir of activityPaths) {
      let stamp;
      try {
        stamp = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (mtimes.get(dir) !== stamp) {
        const first = !mtimes.has(dir);
        mtimes.set(dir, stamp);
        if (!first) void kick('mtime');
      }
    }
  };
  pollActivity();
  setInterval(pollActivity, cfg.pollMs).unref?.();

  setInterval(() => void kick('interval'), cfg.intervalMs).unref?.();
  void kick('startup');
  setInterval(() => {}, 1 << 30); // keep the loop alive
}

// ------------------------------------------------------------------ main ----

function printStatus(cfg) {
  console.log(JSON.stringify({
    enabled: cfg.enabled,
    agentDataRoot: cfg.agentDataRoot,
    workerPort: cfg.workerPort,
    agents: cfg.agentIds.map(agentId => {
      const filePath = injectLogPath(cfg.agentDataRoot, agentId);
      const exists = existsSync(filePath);
      return {
        agentId,
        projects: projectsForAgent(cfg, agentId),
        filePath,
        exists,
        facts: exists ? factBlock(readFileSync(filePath, 'utf8')).split('\n').filter(Boolean).length : 0,
      };
    }),
    state: loadState(cfg),
  }, null, 2));
}

function clearAgents(cfg) {
  for (const agentId of cfg.agentIds) {
    const filePath = injectLogPath(cfg.agentDataRoot, agentId);
    assertSafeInjectPath(cfg.agentDataRoot, agentId, filePath);
    rmSync(filePath, { force: true });
    console.log(`removed ${filePath}`);
  }
  const state = loadState(cfg);
  for (const agentId of cfg.agentIds) delete state[agentId];
  saveState(cfg, state);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const cfg = loadConfig();
  const dryRun = args.has('--dry-run');

  if (args.has('--status')) return printStatus(cfg);

  if (!cfg.enabled && !args.has('--force')) {
    console.error('grok-bot-session-inject is disabled. Set CLAUDE_MEM_GROK_BOT_INJECT_ENABLED=true (or pass --force).');
    process.exitCode = 78; // EX_CONFIG
    return;
  }
  if (cfg.agentIds.length === 0) {
    console.error('No allowlisted agents. Set CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS.');
    process.exitCode = 78;
    return;
  }

  if (args.has('--clear')) return clearAgents(cfg);
  if (args.has('--watch')) return runWatch(cfg);

  const results = await runOnce(cfg, { dryRun, log: message => console.log(message) });
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.status === 'error')) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  await main();
}
