#!/usr/bin/env node
/**
 * Claude-Mem → Grok Bot Memory mid-attach JIT (Phase 1 hack-on-Memory).
 *
 * Product shape (Alex’s only — do not contradict):
 *   1. markdown files = buckets (editable)
 *   2. mtime = cache bust
 *   3. folder tree = CCS (L1 seat-level first)
 *   4. Claude-Mem = JIT compiler
 *
 * Authorized Phase 1 path (Alex YES 2026-09-10 ~1:18pm PT):
 *   Listen to markdown timeline bucket(s) after edit (mtime), compile a rich
 *   timeline INDEX (not the #3953 thin MAX_LINES=2 pointer), land via the
 *   existing Memory mid-attach transport:
 *
 *     GET /api/context/inject  (Allowed params only: projects, platformSource)
 *       → <agentDataRoot>/ccs/seats/<agentId>/TIMELINE.md   (L1 seat bucket)
 *       → agents/<id>/memory/log/zz-claude-mem-inject.md
 *       → host WatchedDirectory → getFrozenSectionUpdatesForTurn()
 *       → <instructions_update> "## Memory"
 *
 * CCS L1 tree (shape stamp). One clear default, under the agent-data tree
 * so bots can edit it:
 *
 *     <agentDataRoot>/ccs/seats/<agentId>/TIMELINE.md   ← Phase 1 source
 *     <agentDataRoot>/ccs/seats/<agentId>/PRIVATE.md    ← may exist; never written
 *     <agentDataRoot>/ccs/house/                        ← reserved, inherit later
 *     <agentDataRoot>/ccs/groups/                       ← reserved
 *
 * Override the `ccs/` root with CLAUDE_MEM_CCS_ROOT if needed. L1 pilot
 * compiles one seat TIMELINE.md only. Allowlist (Orifice / Grok Memory),
 * not house-wide * as the product.
 *
 * Host has no native `ccs_timeline` section (closed freeze list). That is an
 * implement hack, not a product rewrite. Native registry is a later upgrade.
 *
 * Slide-off window is ~50–100 newest rows. Every index row keeps the
 * observation ID so deep fetch (`get_observations`) still works. Host chat
 * is left alone. No new inject query params, no parallel memory API, no
 * tool plane, no listening socket.
 *
 * Default seat list is the explicit Orifice/pilot allowlist.
 * `CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS=*` (or `all`) is optional infra.
 *
 * Usage:
 *   node scripts/grok-bot-session-inject.mjs --once     # one refresh pass
 *   node scripts/grok-bot-session-inject.mjs --watch    # daemon
 *   node scripts/grok-bot-session-inject.mjs --status   # what is on disk now
 *   node scripts/grok-bot-session-inject.mjs --clear    # remove inject + bucket
 *   ... --dry-run                                       # never write
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Host caps a memory fact at 500 chars after whitespace collapse. Stay under. */
const HOST_MAX_FACT_CHARS = 500;
const INJECT_TAG = '[claude-mem]';
const INJECT_LOG_BASENAME = 'zz-claude-mem-inject.md';
const TIMELINE_BUCKET_BASENAME = 'TIMELINE.md';
const PRIVATE_BUCKET_BASENAME = 'PRIVATE.md';
const PROFILE_BASENAME = 'profile.md';
const CCS_DIRNAME = 'ccs';
const CCS_SEATS_DIRNAME = 'seats';
const CCS_HOUSE_DIRNAME = 'house';
const CCS_GROUPS_DIRNAME = 'groups';

/**
 * Slide-off window for the compiled INDEX. #3953 defaulted to 2 packed
 * pointer lines; Phase 1 is a rich index of ~50–100 rows, each with an ID.
 */
const DEFAULT_INDEX_WINDOW = 80;
const MAX_INDEX_WINDOW = 100;

/**
 * Compact index rows so more of the window can survive the host's ~4000-char
 * Memory recall budget. The host freeze list is the implement hack; native
 * `ccs_timeline` is the later upgrade. Stay well under HOST_MAX_FACT_CHARS.
 */
const DEFAULT_INDEX_LINE_CHARS = 160;

/**
 * The host ranks recalled log facts by
 *   log2(importance) + createdAt / (30 days)
 * and importance comes only from a line prefix: `[episode] ` = 1.5,
 * `[note] ` = 0.5, anything else = 1. log2(1.5) is worth ~17.5 days of
 * recency, so on a seat whose log is already full of episode summaries a
 * plain-tier line loses every slot in the 4000-char recall budget and never
 * reaches the prompt at all. Orifice is exactly that seat. Episode tier is
 * therefore the default.
 */
const TIER_PREFIXES = { episode: '[episode] ', plain: '', note: '[note] ' };

const FILE_HEADER = [
  '# Memory log',
  '',
  '<!-- Written by claude-mem grok-bot-session-inject (Phase 1 JIT).',
  '     Rich timeline INDEX compiled from the CCS L1 seat bucket',
  '     (<agentDataRoot>/ccs/seats/<agentId>/TIMELINE.md). Landed here so the host Memory',
  '     mid-attach (`<instructions_update>`) picks it up — same transport as #3953.',
  '     Dated facts, one observation per line as "- (YYYY-MM-DD) <fact>".',
  '     Each row keeps its observation ID for get_observations. Safe to read.',
  '     This file is a compiled cache; edit the bucket, not this file. -->',
  '',
].join('\n');

const BUCKET_HEADER = [
  '# Timeline bucket',
  '',
  '<!-- CCS L1 seat bucket (editable). Path: ccs/seats/<seat-id>/TIMELINE.md.',
  '     Claude-Mem is the JIT compiler: mtime change → recompile →',
  '     zz-claude-mem-inject.md → host Memory mid-attach.',
  '     Row grammar: ID TIME TYPE TITLE. Keep the observation ID on every row.',
  '     Sibling PRIVATE.md is reserved (this compiler never writes it).',
  '     Do not rename this file to profile.md. -->',
  '',
].join('\n');

/**
 * Legend / format glyph boilerplate and the closing call-to-action: pure noise
 * once this is a memory fact, and the trailer would otherwise sort as the
 * newest row and crowd out a real observation.
 */
const DROP_PREFIXES = ['Legend:', 'Format:', 'Fetch details:', 'Access '];

/** Observation index row from /api/context/inject: `17399 1:18p ○ title`. */
export const OBSERVATION_ROW_RE = /^(\d+)\s+\S+/;
/** Session-summary row: `S10489 …`. */
export const SUMMARY_ROW_RE = /^(S\d+)\s+\S+/;

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

/**
 * Phase 1 window. Legacy MAX_LINES=2 is the #3953 pointer and is not the
 * end state — treat it as unset so a leftover pilot json cannot pin us
 * back to two packed lines. Explicit WINDOW still wins, including small
 * values for tests.
 */
export function resolveIndexWindow(windowRaw, maxLinesRaw, fallback = DEFAULT_INDEX_WINDOW) {
  const pick = windowRaw != null && String(windowRaw).trim() !== ''
    ? windowRaw
    : (maxLinesRaw != null && String(maxLinesRaw).trim() !== '' && Number(maxLinesRaw) > 2
      ? maxLinesRaw
      : fallback);
  const parsed = Number(pick);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), MAX_INDEX_WINDOW);
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
export function loadConfig(env = process.env) {
  const settings = readJson(path.join(dataDir(), 'settings.json'), {});
  const local = readJson(path.join(dataDir(), 'grok-bot-session-inject.json'), {});
  const pick = key => env[key] ?? local[key] ?? settings[key];
  const num = (key, fallback) => {
    const raw = Number(pick(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };

  const agentIdsRaw = String(pick('CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS') ?? '').trim();
  const agentIdsAuto = agentIdsRaw === '*' || agentIdsRaw.toLowerCase() === 'all';
  const agentIds = agentIdsAuto
    ? []
    : splitCsv(agentIdsRaw).filter(id => AGENT_ID_RE.test(id));

  const window = resolveIndexWindow(
    pick('CLAUDE_MEM_GROK_BOT_INJECT_WINDOW'),
    pick('CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINES'),
  );
  const agentDataRoot = discoverAgentDataRoot(env);

  return {
    enabled: String(pick('CLAUDE_MEM_GROK_BOT_INJECT_ENABLED') ?? '').toLowerCase() === 'true',
    /** When true, every live seat in transcript-watch.json is included (and new seats are ensured). */
    agentIdsAuto,
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
    /** Slide-off window: newest N observation rows in the compiled INDEX. */
    window,
    /** Back-compat alias used by older call sites / tests. */
    maxLines: window,
    maxLineChars: Math.min(num('CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS', DEFAULT_INDEX_LINE_CHARS), HOST_MAX_FACT_CHARS - 20),
    timeoutMs: num('CLAUDE_MEM_GROK_BOT_INJECT_TIMEOUT_MS', 8_000),
    // mtime poll used when inotify watches are unavailable (this box runs out
    // of watch descriptors regularly). Two statSync calls per agent per tick.
    pollMs: num('CLAUDE_MEM_GROK_BOT_INJECT_POLL_MS', 10_000),
    agentDataRoot,
    /**
     * Default CCS root lives under the agent-data tree so bots can edit
     * TIMELINE.md. CLAUDE_MEM_CCS_ROOT overrides (e.g. a data-dir-relative
     * `ccs/` if a seat wants that instead).
     */
    ccsRoot: String(pick('CLAUDE_MEM_CCS_ROOT') ?? '').trim() || path.join(agentDataRoot, CCS_DIRNAME),
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
export function projectsForAgent(cfg, agentId) {
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

export function slugGrokBotProject(name) {
  const base = String(name ?? '').replace(/\/+$/, '').split('/').pop() || '';
  const cleaned = base.replace(/[^\w\s-]/gu, '');
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const generic = new Set(['', 'root', 'box', 'home', 'user', 'work', 'workspace', 'tmp', 'uploads', 'outputs', 'claude']);
  return 'cmem_work_' + (generic.has(slug) ? 'root' : slug);
}

export function listLiveAgents(agentDataRoot) {
  const agentsDir = path.join(agentDataRoot, 'agents');
  if (!existsSync(agentsDir)) return [];
  const out = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !AGENT_ID_RE.test(entry.name)) continue;
    const profilePath = path.join(agentsDir, entry.name, 'profile.json');
    if (!existsSync(profilePath)) continue;
    let name = entry.name;
    try {
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
      if (typeof profile?.name === 'string' && profile.name.trim()) name = profile.name.trim();
    } catch { /* keep id */ }
    out.push({ id: entry.name, name });
  }
  return out;
}

/**
 * Keep transcript-watch in sync with live seats: prune deleted, add missing.
 * Preserves existing project names so diaries do not jump buckets on rename.
 * Only runs in AGENT_IDS=* / all mode.
 */
export function ensureWatchesForLiveAgents(cfg, { log = () => {} } = {}) {
  const watchCfg = readJson(cfg.watchConfigFile, null);
  if (!watchCfg || !Array.isArray(watchCfg.watches)) return { added: 0, pruned: 0 };

  const live = listLiveAgents(cfg.agentDataRoot);
  const liveIds = new Set(live.map(a => a.id));
  const before = watchCfg.watches.length;

  const kept = [];
  const seen = new Set();
  let pruned = 0;
  for (const watch of watchCfg.watches) {
    if (watch?.name !== 'grok-bot') {
      kept.push(watch);
      continue;
    }
    const agentId = String(watch?.agentId ?? '').trim();
    if (!agentId || agentId === '*') {
      pruned += 1;
      continue;
    }
    if (!liveIds.has(agentId)) {
      pruned += 1;
      continue;
    }
    kept.push(watch);
    seen.add(agentId);
  }

  let added = 0;
  for (const agent of live) {
    if (seen.has(agent.id)) continue;
    const project = slugGrokBotProject(agent.name);
    const workspace = path.join(cfg.agentDataRoot, '.cmem-projects', project);
    const transcriptDir = path.join(cfg.agentDataRoot, 'agent-transcripts', agent.id);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    kept.push({
      name: 'grok-bot',
      schema: 'grok-bot',
      path: path.join(transcriptDir, '*.jsonl'),
      workspace,
      project,
      startAtEnd: true,
      agentId: agent.id,
    });
    seen.add(agent.id);
    added += 1;
    log(`watch+ ${agent.name} (${agent.id}) -> ${project}`);
  }

  if (added || pruned || kept.length !== before) {
    watchCfg.watches = kept;
    watchCfg.version = watchCfg.version || 1;
    writeFileAtomic(cfg.watchConfigFile, `${JSON.stringify(watchCfg, null, 2)}\n`);
  }
  return { added, pruned };
}

/** Resolve the seat list for this pass. Auto mode = every live watched seat. */
export function resolveAgentIds(cfg, { log = () => {} } = {}) {
  if (cfg.agentIdsAuto) {
    ensureWatchesForLiveAgents(cfg, { log });
    const watches = readJson(cfg.watchConfigFile, {})?.watches ?? [];
    const ids = [];
    for (const watch of watches) {
      if (watch?.name !== 'grok-bot') continue;
      const agentId = String(watch?.agentId ?? '').trim();
      if (!AGENT_ID_RE.test(agentId)) continue;
      if (!existsSync(path.join(cfg.agentDataRoot, 'agents', agentId))) continue;
      if (!ids.includes(agentId)) ids.push(agentId);
    }
    return ids;
  }
  return cfg.agentIds;
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

function isBoilerplate(line) {
  if (!line) return true;
  if (DROP_PREFIXES.some(prefix => line.startsWith(prefix))) return true;
  if (line.startsWith('<!--') || line === '-->') return true;
  if (line.startsWith('# Timeline bucket')) return true;
  if (line.startsWith('# Memory log')) return true;
  return false;
}

/**
 * Parse editable-bucket / inject markdown into index rows.
 * Observation and summary rows keep their source ID (Phase 0 packet intent).
 */
export function parseTimelineRows(text) {
  const rows = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (isBoilerplate(line)) continue;
    if (line.startsWith('###')) continue;
    if (line.startsWith('#') && !OBSERVATION_ROW_RE.test(line) && !SUMMARY_ROW_RE.test(line)) continue;
    if (line.startsWith('Mode:') || line.startsWith('Stats:')) continue;

    if (OBSERVATION_ROW_RE.test(line) || SUMMARY_ROW_RE.test(line)) {
      const id = (OBSERVATION_ROW_RE.exec(line) || SUMMARY_ROW_RE.exec(line))[1];
      rows.push({ id, raw: collapse(line) });
      continue;
    }
    if (/^No previous sessions found/i.test(line)) {
      rows.push({ id: null, raw: collapse(line) });
    }
  }
  return rows;
}

/**
 * Newest-first slide-off. Inject/bucket markdown is oldest-first under day
 * headers, so the last parsed row is the freshest.
 */
export function slideWindow(rows, window) {
  const size = resolveIndexWindow(window, undefined, DEFAULT_INDEX_WINDOW);
  const newestFirst = rows.slice().reverse();
  const kept = newestFirst.slice(0, size);
  return { kept, omitted: Math.max(0, newestFirst.length - kept.length) };
}

/**
 * Compile markdown-bucket / inject text into host-parseable INDEX facts.
 *
 * One observation per line (rich index, not a packed 2-line pointer).
 * Newest first. Slide-off drops the oldest rows past `window`.
 * Every kept observation/summary row still carries its ID.
 */
export function injectTextToFactLines(text, {
  projects,
  window,
  maxLines,
  maxLineChars,
  tier = 'episode',
  now = new Date(),
} = {}) {
  const date = todayStamp(now);
  // Index rows stay compact so more of the window can attach. The lead fact
  // is allowed the host's full 500-char cap so stats + the ID fetch hint
  // are not sliced off.
  const headerMax = Math.min(HOST_MAX_FACT_CHARS - 20, Math.max(maxLineChars ?? DEFAULT_INDEX_LINE_CHARS, 460));
  const emitHeader = body => factLine(date, body, headerMax, tier);
  const emit = body => factLine(date, body, maxLineChars, tier);
  const windowSize = resolveIndexWindow(window, maxLines);
  const lines = String(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !isBoilerplate(line));

  const meta = [];
  for (const line of lines) {
    const isInjectHeader = line.startsWith('# [') && !line.startsWith('##');
    if (isInjectHeader || line.startsWith('Mode:') || line.startsWith('Stats:')) {
      meta.push(line);
    }
  }

  const parsed = parseTimelineRows(text);
  const { kept, omitted } = slideWindow(parsed, windowSize);

  const primary = projects[projects.length - 1] ?? 'unknown';
  const stats = meta
    .map(line => line.replace(/^#\s*/, ''))
    // The inject header carries a fetch clock. Keeping it would make the
    // fact block differ on every poll, so the host would see a "memory
    // changed" delta — and re-announce it on the next turn — for a timestamp
    // and nothing else. Facts already carry a date. mtime = cache bust.
    .map(line => line.replace(/\s*recent context,.*$/, '').trim())
    .filter(Boolean)
    .join(' · ');

  const head = [
    `Claude-Mem timeline index for ${primary}`,
    stats,
    `${kept.length} rows; fetch get_observations by ID`,
    omitted > 0 ? `+${omitted} older in bucket` : '',
  ]
    .filter(Boolean)
    .join(' — ');

  const out = [emitHeader(head)];
  for (const row of kept) {
    out.push(emit(row.raw));
  }
  return out;
}

export function factBlock(contents) {
  return String(contents ?? '')
    .split('\n')
    .filter(line => line.startsWith('- ('))
    .join('\n');
}

/** True when the compiled INDEX (not the file header) actually changed. */
export function shouldRewriteInject(existingContents, nextContents) {
  return factBlock(existingContents) !== factBlock(nextContents);
}

/** Stable identity of the editable bucket: observation rows only, no clocks. */
export function bucketRowPayload(text) {
  return parseTimelineRows(text)
    .map(row => row.raw)
    .join('\n');
}

// ------------------------------------------------------------- disk write ----

export function injectLogPath(agentDataRoot, agentId) {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`Refusing inject path for non-UUID agent id: ${agentId}`);
  }
  return path.join(agentDataRoot, 'agents', agentId, 'memory', 'log', INJECT_LOG_BASENAME);
}

/** `ccs/seats/<seat-id>/` — L1 seat folder. house/ and groups/ are siblings, later. */
export function seatBucketDir(ccsRoot, agentId) {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`Refusing bucket path for non-UUID agent id: ${agentId}`);
  }
  return path.join(ccsRoot, CCS_SEATS_DIRNAME, agentId);
}

/** Primary L1 timeline bucket. Concrete default: `<agentDataRoot>/ccs/seats/<id>/TIMELINE.md`. */
export function timelineBucketPath(ccsRoot, agentId) {
  return path.join(seatBucketDir(ccsRoot, agentId), TIMELINE_BUCKET_BASENAME);
}

/** Reserved sibling. This compiler never writes or compiles it. */
export function privateBucketPath(ccsRoot, agentId) {
  return path.join(seatBucketDir(ccsRoot, agentId), PRIVATE_BUCKET_BASENAME);
}

function refuseProfile(basename) {
  if (String(basename).toLowerCase() === PROFILE_BASENAME) {
    throw new Error('Refusing write to profile.md');
  }
}

function refusePrivate(basename) {
  if (String(basename).toUpperCase() === PRIVATE_BUCKET_BASENAME) {
    throw new Error('Refusing write to PRIVATE.md');
  }
}

/** Mirrors the awareness pusher guard: never escape memory/log, never profile.md. */
export function assertSafeInjectPath(agentDataRoot, agentId, filePath) {
  const expectedDir = path.resolve(path.join(agentDataRoot, 'agents', agentId, 'memory', 'log'));
  const resolved = path.resolve(filePath);
  refuseProfile(path.basename(resolved));
  if (path.dirname(resolved) !== expectedDir) {
    throw new Error('Refusing inject write outside agent memory/log');
  }
  if (path.basename(resolved) !== INJECT_LOG_BASENAME) {
    throw new Error(`Refusing inject write to a file this shim does not own: ${path.basename(resolved)}`);
  }
}

export function assertSafeBucketPath(ccsRoot, agentId, filePath) {
  const expectedDir = path.resolve(seatBucketDir(ccsRoot, agentId));
  const resolved = path.resolve(filePath);
  const base = path.basename(resolved);
  refuseProfile(base);
  refusePrivate(base);
  if (path.dirname(resolved) !== expectedDir) {
    throw new Error('Refusing bucket write outside CCS L1 seat folder');
  }
  // house/ and groups/ are reserved; the dirname check already excludes them.
  if (resolved.includes(`${path.sep}${CCS_HOUSE_DIRNAME}${path.sep}`)
    || resolved.includes(`${path.sep}${CCS_GROUPS_DIRNAME}${path.sep}`)) {
    throw new Error('Refusing bucket write under ccs/house or ccs/groups');
  }
  if (base !== TIMELINE_BUCKET_BASENAME) {
    throw new Error(`Refusing bucket write to a file this compiler does not own: ${base}`);
  }
}

function writeFileAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, filePath);
}

/**
 * mtime-stable rewrite: identical bytes → do not touch the file.
 * mtime is the cache-bust signal; churning it on a no-op recompile
 * would make the host re-announce Memory for nothing.
 */
export function writeFileIfChanged(filePath, contents) {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === contents) {
    return { changed: false, filePath };
  }
  writeFileAtomic(filePath, contents);
  return { changed: true, filePath };
}

function loadState(cfg) {
  return readJson(cfg.stateFile, {});
}

function saveState(cfg, state) {
  mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  writeFileAtomic(cfg.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function bucketMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- passes ----

export async function refreshAgent(cfg, agentId, { dryRun = false, log = () => {}, fetchInjectFn = fetchInject } = {}) {
  const projects = projectsForAgent(cfg, agentId);
  if (projects.length === 0) {
    return { agentId, status: 'skipped', reason: 'no project mapped for agent' };
  }

  const agentDir = path.join(cfg.agentDataRoot, 'agents', agentId);
  if (!existsSync(agentDir)) {
    return { agentId, status: 'skipped', reason: `agent dir missing: ${agentDir}` };
  }

  const bucketPath = timelineBucketPath(cfg.ccsRoot, agentId);
  assertSafeBucketPath(cfg.ccsRoot, agentId, bucketPath);
  const filePath = injectLogPath(cfg.agentDataRoot, agentId);
  assertSafeInjectPath(cfg.agentDataRoot, agentId, filePath);

  const state = loadState(cfg);
  const prior = state[agentId] ?? {};
  const existingBucket = existsSync(bucketPath) ? readFileSync(bucketPath, 'utf8') : '';
  const existingPayload = bucketRowPayload(existingBucket);
  // Ownership: if the on-disk rows are not what this compiler last seeded,
  // the human (or another editor) owns the bucket. mtime alone is too coarse
  // on some filesystems; the row payload is the cache-bust identity.
  const userEdited = Boolean(
    existingBucket
    && prior.bucketWrittenPayload
    && existingPayload !== prior.bucketWrittenPayload,
  );

  let url = prior.url ?? null;
  let fetchedBody = null;
  if (!userEdited) {
    try {
      const fetched = await fetchInjectFn(cfg, projects);
      url = fetched.url;
      fetchedBody = fetched.body;
    } catch (error) {
      if (!existingBucket) throw error;
      log(`WARN fetch failed for ${agentId}, compiling existing bucket: ${error?.message ?? error}`);
    }
  }

  let bucketContents = existingBucket;
  let bucketStatus = existingBucket ? 'existing' : 'missing';
  if (!userEdited && fetchedBody != null) {
    const nextBucket = `${BUCKET_HEADER}${String(fetchedBody).trim()}\n`;
    if (bucketRowPayload(existingBucket) !== bucketRowPayload(nextBucket)) {
      if (dryRun) {
        bucketStatus = 'would-write';
        bucketContents = nextBucket;
      } else {
        writeFileIfChanged(bucketPath, nextBucket);
        bucketContents = nextBucket;
        bucketStatus = 'written';
      }
    } else {
      bucketStatus = 'unchanged';
      bucketContents = existingBucket || nextBucket;
    }
  } else if (userEdited) {
    bucketStatus = 'user-edited';
  }

  const compileSource = bucketContents || fetchedBody || '';
  const factLines = injectTextToFactLines(compileSource, {
    projects,
    window: cfg.window ?? cfg.maxLines,
    maxLineChars: cfg.maxLineChars,
    tier: cfg.tier,
  });
  const contents = `${FILE_HEADER}${factLines.join('\n')}\n`;

  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const changed = shouldRewriteInject(existing, contents);

  const stampBucketMtime = () => {
    if (dryRun) return;
    const next = loadState(cfg);
    const stamp = bucketMtimeMs(bucketPath);
    next[agentId] = {
      ...(next[agentId] ?? {}),
      projects,
      filePath,
      bucketPath,
      bucketMtimeMs: stamp,
      bucketWrittenPayload: bucketRowPayload(existsSync(bucketPath) ? readFileSync(bucketPath, 'utf8') : bucketContents),
      factLines: factLines.length,
      window: cfg.window ?? cfg.maxLines,
      bytes: existsSync(filePath) ? Buffer.byteLength(readFileSync(filePath, 'utf8')) : 0,
      writtenAt: new Date().toISOString(),
      url,
    };
    saveState(cfg, next);
  };

  if (!changed) {
    stampBucketMtime();
    return {
      agentId,
      projects,
      url,
      status: 'unchanged',
      filePath,
      bucketPath,
      bucketStatus,
      factLines: factLines.length,
    };
  }
  if (dryRun) {
    return {
      agentId,
      projects,
      url,
      status: 'would-write',
      filePath,
      bucketPath,
      bucketStatus,
      factLines: factLines.length,
      preview: factLines,
    };
  }

  writeFileIfChanged(filePath, contents);
  stampBucketMtime();
  log(`wrote ${factLines.length} index rows for ${agentId} (${projects.join(',')}) -> ${filePath}`);

  return {
    agentId,
    projects,
    url,
    status: 'written',
    filePath,
    bucketPath,
    bucketStatus,
    factLines: factLines.length,
    preview: factLines,
  };
}

async function runOnce(cfg, opts) {
  const results = [];
  const agentIds = resolveAgentIds(cfg, opts);
  for (const agentId of agentIds) {
    try {
      results.push(await refreshAgent(cfg, agentId, opts));
    } catch (error) {
      results.push({ agentId, status: 'error', reason: error?.message ?? String(error) });
    }
  }
  return results;
}

// ----------------------------------------------------------------- watch ----

function runWatch(initialCfg) {
  const log = message => console.log(`[grok-inject ${new Date().toISOString()}] ${message}`);
  let cfg = initialCfg;
  const agentIds = resolveAgentIds(cfg, { log });
  log(`watching ${cfg.agentIdsAuto ? 'AUTO' : agentIds.length} seat(s); worker :${cfg.workerPort}; window ${cfg.window}; root ${cfg.agentDataRoot}; ccs ${cfg.ccsRoot}`);

  let lastRunAt = 0;
  let pending = null;
  let running = false;
  const watchedDirs = new Set();

  const ensureActivityWatches = (ids) => {
    for (const agentId of ids) {
      for (const dir of [
        path.join(cfg.agentDataRoot, 'agents', agentId),
        path.join(cfg.agentDataRoot, 'agent-transcripts', agentId),
        seatBucketDir(cfg.ccsRoot, agentId),
      ]) {
        if (!existsSync(dir) || watchedDirs.has(dir)) continue;
        watchedDirs.add(dir);
        try {
          watch(dir, { persistent: true }, () => void kick('activity'));
        } catch (error) {
          // Boxes run out of inotify descriptors; the mtime poll below covers it.
          log(`WARN cannot watch ${dir} (${error?.code ?? error?.message}) — falling back to mtime poll`);
        }
      }
    }
  };

  const kick = async reason => {
    if (running) return;
    // Reload config each pass so * picks up new hires without a process restart.
    cfg = loadConfig();
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
      const ids = resolveAgentIds(cfg, { log });
      ensureActivityWatches(ids);
      for (const result of await runOnce(cfg, { log })) {
        if (result.status === 'error') log(`ERROR ${result.agentId}: ${result.reason}`);
        else if (result.status === 'skipped') log(`skip ${result.agentId}: ${result.reason}`);
        else if (result.status === 'written') log(`wrote ${result.agentId} (${result.factLines} index rows)`);
      }
    } finally {
      running = false;
    }
  };

  ensureActivityWatches(agentIds);

  // mtime poll fallback when inotify watches are unavailable. Also the
  // product cache-bust: markdown bucket mtime → recompile.
  const mtimes = new Map();
  const pollActivity = () => {
    const dirs = new Set(watchedDirs);
    for (const agentId of resolveAgentIds(cfg)) {
      dirs.add(seatBucketDir(cfg.ccsRoot, agentId));
      const bucket = timelineBucketPath(cfg.ccsRoot, agentId);
      dirs.add(bucket);
    }
    for (const dir of dirs) {
      try {
        const stamp = statSync(dir).mtimeMs;
        const prev = mtimes.get(dir);
        mtimes.set(dir, stamp);
        if (prev !== undefined && stamp !== prev) void kick('mtime');
      } catch { /* path gone */ }
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
    agentIdsAuto: cfg.agentIdsAuto,
    agentDataRoot: cfg.agentDataRoot,
    ccsRoot: cfg.ccsRoot,
    workerPort: cfg.workerPort,
    window: cfg.window,
    agents: resolveAgentIds(cfg).map(agentId => {
      const filePath = injectLogPath(cfg.agentDataRoot, agentId);
      const bucketPath = timelineBucketPath(cfg.ccsRoot, agentId);
      const exists = existsSync(filePath);
      const bucketExists = existsSync(bucketPath);
      return {
        agentId,
        projects: projectsForAgent(cfg, agentId),
        filePath,
        bucketPath,
        exists,
        bucketExists,
        bucketMtimeMs: bucketExists ? bucketMtimeMs(bucketPath) : null,
        facts: exists ? factBlock(readFileSync(filePath, 'utf8')).split('\n').filter(Boolean).length : 0,
      };
    }),
    state: loadState(cfg),
  }, null, 2));
}

function clearAgents(cfg) {
  for (const agentId of resolveAgentIds(cfg)) {
    const filePath = injectLogPath(cfg.agentDataRoot, agentId);
    assertSafeInjectPath(cfg.agentDataRoot, agentId, filePath);
    rmSync(filePath, { force: true });
    console.log(`removed ${filePath}`);
    const bucketPath = timelineBucketPath(cfg.ccsRoot, agentId);
    assertSafeBucketPath(cfg.ccsRoot, agentId, bucketPath);
    rmSync(bucketPath, { force: true });
    console.log(`removed ${bucketPath}`);
  }
  const state = loadState(cfg);
  for (const agentId of resolveAgentIds(cfg)) delete state[agentId];
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
  if (!cfg.agentIdsAuto && cfg.agentIds.length === 0) {
    console.error('No allowlisted agents. Set CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS to a list (Orifice/pilot default) or *.');
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
