/**
 * Session Registry Routes
 *
 * Provides API endpoints for browsing raw JSONL session files:
 *   GET /api/session-registry/list                      – list sessions (with filters)
 *   GET /api/session-registry/:id/events                – read session events
 *   GET /api/session-registry/:id/stats                 – aggregate token/tool stats
 *   GET /api/session-registry/:id/subagents             – subagent list for a session
 *   GET /api/session-registry/:id/raw-event/:eventId    – single raw JSONL record
 *
 * Sources scanned:
 *   ~/.claude/projects (Claude Code sessions)
 *   ~/.openclaw/agents (OpenClaw sessions)
 *   ~/.codex/sessions (Codex sessions)
 *
 * Ported from CC-sesh-master/serve-dashboard.py (Python → TypeScript).
 */

import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME_DIR = os.homedir();
const PROJECTS_DIR = path.join(HOME_DIR, '.claude', 'projects');
const OPENCLAW_DIR = path.join(HOME_DIR, '.openclaw', 'agents');
const CODEX_DIR = path.join(HOME_DIR, '.codex', 'sessions');

const MAX_TOOL_RESULT_LEN = 2048;
const MAX_TOOL_INPUT_LEN = 1024;
const MAX_TEXT_LEN = 10240;
const TAIL_READ_BYTES = 512 * 1024; // 512 KB
const REBUILD_INTERVAL_MS = 30_000;
const MODEL_CONTEXT_DEFAULT = 200_000;
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'opus-4': 200_000,
  'sonnet-4': 200_000,
  'haiku-4': 200_000,
  'sonnet-3': 200_000,
  'haiku-3': 200_000,
  'opus-3': 200_000,
  'o3': 200_000,
  'o4-mini': 200_000,
  'gpt-4.1': 1_047_576,
  'gpt-4o': 128_000,
  'gpt-5': 200_000,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface RegistrySession {
  sessionId: string;
  project: string;
  source: 'claude' | 'openclaw' | 'codex';
  slug: string;
  status: 'active' | 'completed';
  model: string;
  version: string;
  mtime: number;
  size: number;
  eventCount: number;
  cwd: string;
  gitBranch: string;
  subagentCount: number;
  duration: number;
  contextPct: number;
  _path?: string;
}

export interface RegistrySubagent {
  id: string;
  parentId: string;
  agentType: string;
  slug: string;
  model: string;
  status: 'active' | 'completed';
  mtime: number;
  size?: number;
  eventCount?: number;
  filename?: string;
  ephemeral?: boolean;
  spawnStatus?: string;
  runId?: string;
  childSessionKey?: string;
  timestamp?: string;
}

export interface RegistryEvent {
  type: string;
  uuid: string;
  timestamp: string;
  [key: string]: unknown;
}

// ─── Helper: read tail of a file ─────────────────────────────────────────────

function readTailLines(filePath: string, bytes: number): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const readBytes = Math.min(size, bytes);
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    // Discard first line if we didn't start at position 0 (may be partial)
    if (size > bytes) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Helper: read head of a file ─────────────────────────────────────────────

const HEAD_READ_BYTES = 8192; // 8 KB – enough for ~8 typical JSONL lines

function readHeadLines(filePath: string, size: number, bytes: number = HEAD_READ_BYTES): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const readBytes = Math.min(size, bytes);
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, 0);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    // If we didn't read the whole file the last line may be partial – drop it
    if (size > bytes && lines.length > 0) lines.pop();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function parseTimestampSec(ts: unknown): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts > 1e12 ? ts / 1000 : ts;
  }
  if (typeof ts !== 'string' || !ts) return null;
  const parsedMs = Date.parse(ts);
  if (Number.isNaN(parsedMs)) return null;
  return parsedMs / 1000;
}

function asNum(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractContextInputTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as Record<string, unknown>;
  return (
    asNum(u.input_tokens) +
    asNum(u.input) +
    asNum(u.cache_read_input_tokens) +
    asNum(u.cache_creation_input_tokens) +
    asNum(u.cached_input_tokens) +
    asNum(u.cacheRead) +
    asNum(u.cacheWrite)
  );
}

function getContextSize(model: string): number {
  if (!model) return MODEL_CONTEXT_DEFAULT;
  const lower = model.toLowerCase();
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) return size;
  }
  return MODEL_CONTEXT_DEFAULT;
}

function getContextPct(model: string, inputTokens: number): number {
  if (!inputTokens) return 0;
  const contextSize = getContextSize(model);
  if (!contextSize) return 0;
  return Math.round((inputTokens / contextSize) * 100);
}

// ─── SessionIndex ─────────────────────────────────────────────────────────────

class SessionIndex {
  private sessions: Map<string, RegistrySession & { _path: string }> = new Map();
  private subagents: Map<string, RegistrySubagent[]> = new Map();
  private subagentPaths: Map<string, string> = new Map();
  private projects: Set<string> = new Set();
  private lastRebuild = 0;
  private rebuilding = false;

  needsRebuild(): boolean {
    return Date.now() - this.lastRebuild > REBUILD_INTERVAL_MS;
  }

  ensureFresh(): void {
    if (this.needsRebuild() && !this.rebuilding) {
      this.rebuild();
    }
  }

  rebuild(): void {
    this.rebuilding = true;
    try {
      const sessions = new Map<string, RegistrySession & { _path: string }>();
      const subagents = new Map<string, RegistrySubagent[]>();
      const subagentPaths = new Map<string, string>();
      const projects = new Set<string>();

      // ── ~/.claude/projects/ ──────────────────────────────────────
      if (fs.existsSync(PROJECTS_DIR)) {
        for (const projName of fs.readdirSync(PROJECTS_DIR)) {
          const projDir = path.join(PROJECTS_DIR, projName);
          if (!fs.statSync(projDir).isDirectory()) continue;
          if (projName.toLowerCase().includes('observer')) continue;

          let display = projName;
          if (display.startsWith('-home-dev-')) display = display.slice(10);
          else if (display.startsWith('-home-dev')) display = display.slice(9) || 'home';
          display = display.replace(/-/g, '/') || 'home';

          this.scanSessionDir(projDir, display, 'claude', sessions, subagents, subagentPaths, projects);
        }
      }

      // ── ~/.openclaw/agents/*/sessions/ ──────────────────────────
      if (fs.existsSync(OPENCLAW_DIR)) {
        for (const agentName of fs.readdirSync(OPENCLAW_DIR)) {
          const sessDir = path.join(OPENCLAW_DIR, agentName, 'sessions');
          if (!fs.existsSync(sessDir) || !fs.statSync(sessDir).isDirectory()) continue;
          const display = 'openclaw/' + agentName;
          this.scanSessionDir(sessDir, display, 'openclaw', sessions, subagents, subagentPaths, projects);
        }
      }

      // ── ~/.codex/sessions/ ──────────────────────────────────────
      if (fs.existsSync(CODEX_DIR)) {
        this.scanCodexSessions(CODEX_DIR, sessions, projects);
      }

      this.sessions = sessions;
      this.subagents = subagents;
      this.subagentPaths = subagentPaths;
      this.projects = projects;
      this.lastRebuild = Date.now();
    } finally {
      this.rebuilding = false;
    }
  }

  private scanSessionDir(
    dir: string,
    display: string,
    source: 'claude' | 'openclaw',
    sessions: Map<string, RegistrySession & { _path: string }>,
    subagents: Map<string, RegistrySubagent[]>,
    subagentPaths: Map<string, string>,
    projects: Set<string>,
  ): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch { return; }

    for (const fname of entries) {
      if (!fname.endsWith('.jsonl')) continue;
      const sid = fname.slice(0, -6);
      if (!UUID_RE.test(sid)) continue;

      const filePath = path.join(dir, fname);
      let stat: fs.Stats;
      try { stat = fs.statSync(filePath); } catch { continue; }

      if (stat.size === 0) continue;

      const meta = this.extractMetadata(filePath, stat.size);
      if (!meta) continue;

      projects.add(display);
      const ageSec = (Date.now() - stat.mtimeMs) / 1000;
      const active = ageSec < 120 && !meta.hasStop;

      // On-disk subagents
      const subDir = path.join(dir, sid, 'subagents');
      const subList: RegistrySubagent[] = [];
      if (fs.existsSync(subDir)) {
        for (const sf of fs.readdirSync(subDir)) {
          if (!sf.endsWith('.jsonl')) continue;
          const saPath = path.join(subDir, sf);
          const sa = this.extractSubagentInfo(saPath, sid);
          if (sa) {
            subList.push(sa);
            subagentPaths.set(sf.slice(0, -6), saPath);
          }
        }
        subList.sort((a, b) => b.mtime - a.mtime);
      }
      if (subList.length) subagents.set(sid, subList);

      sessions.set(sid, {
        sessionId: sid,
        project: display,
        source,
        slug: meta.slug,
        status: active ? 'active' : 'completed',
        model: meta.model,
        version: meta.version,
        mtime: stat.mtimeMs / 1000,
        size: stat.size,
        eventCount: meta.eventCount,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        subagentCount: subList.length + (meta.inlineSubagentCount || 0),
        duration: meta.firstTs ? Math.max(0, Math.round(stat.mtimeMs / 1000 - meta.firstTs)) : 0,
        contextPct: getContextPct(meta.model, meta.lastInputTokens),
        _path: filePath,
      });
    }
  }

  private extractMetadata(filePath: string, size: number): {
    slug: string; model: string; version: string; cwd: string;
    gitBranch: string; hasStop: boolean; eventCount: number;
    inlineSubagentCount: number;
    firstTs: number;
    lastInputTokens: number;
  } | null {
    const result = {
      slug: '', model: '', version: '', cwd: '', gitBranch: '',
      hasStop: false, eventCount: Math.max(1, Math.floor(size / 500)),
      inlineSubagentCount: 0,
      firstTs: 0,
      lastInputTokens: 0,
    };

    let isOpenclaw = false;

    try {
      // Head scan: read first HEAD_READ_BYTES only (avoids full-file read)
      const headLines = readHeadLines(filePath, size).filter(l => l.trim());

      for (let i = 0; i < Math.min(8, headLines.length); i++) {
        try {
          const obj = JSON.parse(headLines[i]);
          const t = obj.type || '';
          if (!result.firstTs) {
            const ts = parseTimestampSec(obj.timestamp);
            if (ts) result.firstTs = ts;
          }
          if (!result.slug) result.slug = obj.slug || '';
          if (!result.cwd) result.cwd = obj.cwd || '';
          if (!result.gitBranch) result.gitBranch = obj.gitBranch || '';
          if (t === 'assistant' && !result.model) result.model = obj.message?.model || '';
          if (t === 'session') {
            if (!result.cwd) result.cwd = obj.cwd || '';
            if (!result.version) result.version = String(obj.version || '');
            isOpenclaw = true;
          }
          if (t === 'message') {
            const msg = obj.message || {};
            if (msg.role === 'assistant' && !result.model) {
              const m = msg.model || '';
              if (m && m !== 'delivery-mirror') result.model = m;
            }
          }
          if (!result.version && typeof obj.version === 'string') result.version = obj.version;
        } catch { /* skip invalid JSON */ }
      }

      // Tail scan: read last TAIL_READ_BYTES only
      const tailAllLines = size > HEAD_READ_BYTES
        ? readTailLines(filePath, TAIL_READ_BYTES)
        : headLines;
      const tailLines = tailAllLines.filter(l => l.trim());
      for (let i = tailLines.length - 1; i >= Math.max(0, tailLines.length - 16); i--) {
        try {
          const obj = JSON.parse(tailLines[i]);
          const t = obj.type || '';
          if (t === 'system' && obj.subtype === 'stop_hook_summary') result.hasStop = true;
          if (!result.lastInputTokens) {
            let usage: unknown;
            if (t === 'assistant') {
              usage = obj.message?.usage;
            } else if (t === 'message') {
              const msg = obj.message || {};
              if (msg.role === 'assistant') usage = msg.usage;
            }
            const inputTokens = extractContextInputTokens(usage);
            if (inputTokens > 0) result.lastInputTokens = inputTokens;
          }
          if (!result.model) {
            if (t === 'assistant') result.model = obj.message?.model || '';
            else if (t === 'message') {
              const m = (obj.message || {}).model || '';
              if (m && m !== 'delivery-mirror') result.model = m;
            }
          }
          if (!result.slug && obj.slug) result.slug = obj.slug;
          if (result.lastInputTokens && (result.model || result.slug)) break;
        } catch { /* skip */ }
      }

      // Count inline subagents for openclaw sessions (requires full scan)
      if (isOpenclaw) {
        let count = 0;
        const fullText = fs.readFileSync(filePath, 'utf-8');
        for (const line of fullText.split('\n')) {
          if (line.includes('sessions_spawn') && line.includes('"accepted"')) count++;
        }
        result.inlineSubagentCount = count;
      }

    } catch {
      return null;
    }

    return result;
  }

  private extractSubagentInfo(filePath: string, parentId: string): RegistrySubagent | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return null; }
    if (stat.size === 0) return null;

    const fname = path.basename(filePath, '.jsonl');
    let agentType = 'task-agent';
    if (fname.includes('prompt_suggestion')) agentType = 'prompt_suggestion';
    else if (fname.includes('compact')) agentType = 'compact';

    const info: RegistrySubagent = {
      id: fname, parentId, agentType,
      slug: '', model: '',
      status: (Date.now() - stat.mtimeMs) / 1000 < 120 ? 'active' : 'completed',
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      eventCount: Math.max(1, Math.floor(stat.size / 500)),
      filename: path.basename(filePath),
    };

    try {
      // Only need first 5 lines – read a small head portion
      const headLines = readHeadLines(filePath, stat.size).filter(l => l.trim());
      for (let i = 0; i < Math.min(5, headLines.length); i++) {
        try {
          const obj = JSON.parse(headLines[i]);
          if (!info.slug) info.slug = obj.slug || '';
          if (!info.model && obj.type === 'assistant') info.model = obj.message?.model || '';
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }

    return info;
  }

  private scanCodexSessions(
    baseDir: string,
    sessions: Map<string, RegistrySession & { _path: string }>,
    projects: Set<string>,
  ): void {
    const walkDir = (dir: string): void => {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        let stat: fs.Stats;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
          if (stat.size === 0) continue;
          const meta = this.extractCodexMetadata(fullPath, stat.size);
          if (!meta) continue;

          const sid = 'codex-' + (meta.id || path.basename(fullPath, '.jsonl'));
          const cwd = meta.cwd || '';
          const homePrefix = HOME_DIR + '/';
          const rel = cwd.startsWith(homePrefix) ? cwd.slice(homePrefix.length).replace(/\/$/, '') : '';
          const display = rel ? 'codex/' + rel : 'codex';
          projects.add(display);

          const ageSec = (Date.now() - stat.mtimeMs) / 1000;
          const active = ageSec < 120 && !meta.hasComplete;

          sessions.set(sid, {
            sessionId: sid,
            project: display,
            source: 'codex',
            slug: meta.slug,
            status: active ? 'active' : 'completed',
            model: meta.model,
            version: meta.version,
            mtime: stat.mtimeMs / 1000,
            size: stat.size,
            eventCount: meta.eventCount,
            cwd,
            gitBranch: meta.gitBranch,
            subagentCount: 0,
            duration: meta.firstTs ? Math.max(0, Math.round(stat.mtimeMs / 1000 - meta.firstTs)) : 0,
            contextPct: getContextPct(meta.model, meta.lastInputTokens),
            _path: fullPath,
          });
        }
      }
    };
    walkDir(baseDir);
  }

  private extractCodexMetadata(filePath: string, size: number): {
    id: string; slug: string; model: string; version: string;
    cwd: string; gitBranch: string; hasComplete: boolean;
    eventCount: number;
    firstTs: number;
    lastInputTokens: number;
  } | null {
    const result = {
      id: '', slug: '', model: '', version: '', cwd: '', gitBranch: '',
      hasComplete: false, eventCount: Math.max(1, Math.floor(size / 500)),
      firstTs: 0,
      lastInputTokens: 0,
    };

    // 16 KB is generous for 30 typical Codex JSONL lines
    const HEAD_CODEX_BYTES = 16384;

    try {
      // Head scan: read first HEAD_CODEX_BYTES only
      const headLines = readHeadLines(filePath, size, HEAD_CODEX_BYTES).filter(l => l.trim());

      for (let i = 0; i < Math.min(30, headLines.length); i++) {
        try {
          const obj = JSON.parse(headLines[i]);
          const t = obj.type || '';
          const payload = obj.payload || {};
          if (!result.firstTs) {
            const ts = parseTimestampSec(obj.timestamp);
            if (ts) result.firstTs = ts;
          }
          if (typeof payload !== 'object') continue;
          const pt = payload.type || '';

          if (t === 'session_meta') {
            result.id = payload.id || '';
            result.cwd = payload.cwd || '';
            result.version = payload.cli_version || '';
            const git = payload.git || {};
            if (typeof git === 'object') result.gitBranch = git.branch || '';
          } else if (t === 'turn_context' && !result.model) {
            result.model = payload.model || '';
          } else if (t === 'event_msg' && pt === 'user_message' && !result.slug) {
            const text2 = (payload.message || '').trim();
            if (text2) result.slug = text2.slice(0, 80).replace(/\n/g, ' ').trim();
          } else if (t === 'response_item' && pt === 'message' && payload.role === 'user' && !result.slug) {
            const content = Array.isArray(payload.content) ? payload.content : [];
            for (const block of content) {
              if (block?.type === 'input_text') {
                const txt = (block.text || '').trim();
                if (txt && !txt.startsWith('#') && !txt.startsWith('<') && txt.length <= 500) {
                  result.slug = txt.slice(0, 80).replace(/\n/g, ' ').trim();
                  break;
                }
              }
            }
          }
        } catch { /* skip */ }
      }

      // Tail scan: read last TAIL_READ_BYTES only
      const tailAllLines = size > HEAD_CODEX_BYTES
        ? readTailLines(filePath, TAIL_READ_BYTES)
        : headLines;
      const tailLines = tailAllLines.filter(l => l.trim());
      for (let i = tailLines.length - 1; i >= Math.max(0, tailLines.length - 16); i--) {
        try {
          const obj = JSON.parse(tailLines[i]);
          const payload = obj.payload || {};
          const payloadType = payload?.type;
          if (obj.type === 'event_msg' && payloadType === 'task_complete') result.hasComplete = true;
          if (!result.model && obj.type === 'turn_context') result.model = payload?.model || '';
          if (!result.lastInputTokens) {
            if (obj.type === 'turn_context') {
              const inputTokens = extractContextInputTokens(payload?.total_token_usage);
              if (inputTokens > 0) result.lastInputTokens = inputTokens;
            } else if (obj.type === 'event_msg' && payloadType === 'token_count') {
              const inputTokens = extractContextInputTokens(payload?.info?.total_token_usage);
              if (inputTokens > 0) result.lastInputTokens = inputTokens;
            }
          }
          if (result.hasComplete && result.model && result.lastInputTokens) break;
        } catch { /* skip */ }
      }

    } catch { return null; }

    return result;
  }

  // ── Query interface ─────────────────────────────────────────────────────────

  getSessions(opts: {
    project?: string; status?: string; search?: string;
    source?: string; offset?: number; limit?: number;
  }): {
    sessions: Omit<RegistrySession, '_path'>[];
    total: number; projects: string[]; sources: string[];
    offset: number; limit: number;
  } {
    this.ensureFresh();

    let items = Array.from(this.sessions.values()) as (RegistrySession & { _path: string })[];

    const allProjects = Array.from(this.projects).sort();
    const sources = [...new Set(items.map(s => s.source))].sort();

    if (opts.source) items = items.filter(s => s.source === opts.source);
    if (opts.project) items = items.filter(s => s.project === opts.project);
    if (opts.status && opts.status !== 'all') items = items.filter(s => s.status === opts.status);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      items = items.filter(s =>
        s.slug.toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
      );
    }

    items.sort((a, b) => b.mtime - a.mtime);
    const total = items.length;
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 50, 200);
    const page = items.slice(offset, offset + limit);

    const sessions = page.map(({ _path: _p, ...rest }) => rest);
    return { sessions, total, projects: allProjects, sources, offset, limit };
  }

  getSessionPath(sessionId: string): string | null {
    this.ensureFresh();
    const s = this.sessions.get(sessionId);
    if (s) return s._path;

    const saPath = this.subagentPaths.get(sessionId);
    if (saPath) return saPath;

    // Filesystem fallback for claude sessions
    if (!SAFE_ID_RE.test(sessionId)) return null;
    if (fs.existsSync(PROJECTS_DIR)) {
      for (const d of fs.readdirSync(PROJECTS_DIR)) {
        const candidate = path.resolve(PROJECTS_DIR, d, sessionId + '.jsonl');
        if (candidate.startsWith(path.resolve(PROJECTS_DIR) + path.sep) && fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  getSubagents(sessionId: string): RegistrySubagent[] {
    this.ensureFresh();
    return this.subagents.get(sessionId) ?? [];
  }
}

// ─── SessionEventReader ────────────────────────────────────────────────────────

const SKIP_TYPES = new Set([
  'file-history-snapshot', 'queue-operation',
  'session', 'thinking_level_change', 'custom',
]);

function isCodexPath(p: string): boolean {
  return p.startsWith(CODEX_DIR);
}

function parseEvent(line: string): RegistryEvent | null {
  if (!line.trim()) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line); } catch { return null; }

  const t = raw.type as string;
  if (!t || SKIP_TYPES.has(t)) return null;

  // OpenClaw type="message" format
  if (t === 'message') {
    const msg = (raw.message || {}) as Record<string, unknown>;
    const role = msg.role as string;
    const roleMap: Record<string, string> = { user: 'user', assistant: 'assistant', toolResult: 'user' };
    const mapped = roleMap[role];
    if (!mapped) return null;

    const result: RegistryEvent = {
      type: mapped,
      uuid: (raw.id as string) || '',
      timestamp: (raw.timestamp as string) || '',
    };

    if (role === 'user') {
      result.userType = 'external';
      const content = msg.content;
      if (typeof content === 'string') {
        result.text = content.slice(0, MAX_TEXT_LEN);
        result.truncated = content.length > MAX_TEXT_LEN;
      } else if (Array.isArray(content)) {
        const texts = content.filter((b: unknown) => (b as Record<string,unknown>)?.type === 'text')
          .map((b: unknown) => ((b as Record<string,unknown>).text as string || '').slice(0, MAX_TEXT_LEN));
        if (texts.length) {
          const joined = texts.join('\n');
          result.text = joined.slice(0, MAX_TEXT_LEN);
          result.truncated = joined.length > MAX_TEXT_LEN;
        }
      }
    } else if (role === 'toolResult') {
      result.userType = 'external';
      const content = msg.content;
      let full = '';
      if (Array.isArray(content)) full = content.filter((b: unknown) => (b as Record<string,unknown>)?.type === 'text').map((b: unknown) => (b as Record<string,unknown>).text as string).join('\n');
      else if (typeof content === 'string') full = content;
      const details = (msg.details || {}) as Record<string, unknown>;
      const isErr = (details.exitCode as number) !== 0 && details.exitCode !== undefined;
      result.tool_results = [{
        tool_use_id: msg.toolCallId as string || '',
        type: 'tool_result',
        content: full.slice(0, MAX_TOOL_RESULT_LEN),
        truncated: full.length > MAX_TOOL_RESULT_LEN,
        ...(isErr ? { is_error: true } : {}),
      }];
    } else if (role === 'assistant') {
      let model = (msg.model as string) || '';
      if (model === 'delivery-mirror') model = '';
      result.model = model;
      result.usage = msg.usage || {};
      result.stop_reason = msg.stop_reason || '';
      const texts: string[] = [];
      const toolUses: unknown[] = [];
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text') texts.push((b.text as string || '').slice(0, MAX_TEXT_LEN));
          else if (b.type === 'toolCall') {
            const inp = JSON.stringify(b.arguments || {});
            toolUses.push({ type: 'tool_use', id: b.id, name: b.name, input: inp.slice(0, MAX_TOOL_INPUT_LEN), truncated: inp.length > MAX_TOOL_INPUT_LEN });
          } else if (b.type === 'thinking') result.hasThinking = true;
        }
      }
      if (texts.length) result.text = texts.join('\n');
      if (toolUses.length) result.tool_uses = toolUses;
    }
    return result;
  }

  // Claude Code native format
  const result: RegistryEvent = {
    type: t,
    uuid: (raw.uuid as string) || '',
    timestamp: (raw.timestamp as string) || '',
  };

  if (t === 'user') {
    const msg = (raw.message || {}) as Record<string, unknown>;
    const content = msg.content;
    result.userType = raw.userType || 'external';
    if (typeof content === 'string') {
      result.text = content.slice(0, MAX_TEXT_LEN);
      result.truncated = content.length > MAX_TEXT_LEN;
    } else if (Array.isArray(content)) {
      const texts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text') texts.push((b.text as string || '').slice(0, MAX_TEXT_LEN));
        else if (b.type === 'tool_result') {
          const rc = b.content;
          let full = '';
          if (Array.isArray(rc)) full = rc.filter((i: unknown) => (i as Record<string,unknown>)?.type === 'text').map((i: unknown) => (i as Record<string,unknown>).text as string).join('\n');
          else if (typeof rc === 'string') full = rc;
          toolResults.push({
            tool_use_id: b.tool_use_id || '',
            type: 'tool_result',
            content: full.slice(0, MAX_TOOL_RESULT_LEN),
            truncated: full.length > MAX_TOOL_RESULT_LEN,
            ...(b.is_error ? { is_error: true } : {}),
          });
        }
      }
      if (texts.length) { const j = texts.join('\n'); result.text = j.slice(0, MAX_TEXT_LEN); result.truncated = j.length > MAX_TEXT_LEN; }
      if (toolResults.length) result.tool_results = toolResults;
    }
  } else if (t === 'assistant') {
    const msg = (raw.message || {}) as Record<string, unknown>;
    result.model = msg.model || '';
    result.usage = msg.usage || {};
    result.stop_reason = msg.stop_reason || '';
    const texts: string[] = [];
    const toolUses: unknown[] = [];
    for (const block of (msg.content as unknown[] || [])) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text') texts.push((b.text as string || '').slice(0, MAX_TEXT_LEN));
      else if (b.type === 'tool_use') {
        const inp = JSON.stringify(b.input || {});
        toolUses.push({ type: 'tool_use', id: b.id, name: b.name, input: inp.slice(0, MAX_TOOL_INPUT_LEN), truncated: inp.length > MAX_TOOL_INPUT_LEN });
      } else if (b.type === 'thinking') result.hasThinking = true;
    }
    if (texts.length) result.text = texts.join('\n');
    if (toolUses.length) result.tool_uses = toolUses;
  } else if (t === 'system') {
    result.subtype = raw.subtype || '';
    result.level = raw.level || '';
  } else if (t === 'progress') {
    const data = (raw.data || {}) as Record<string, unknown>;
    result.progress = { type: data.type || '', content: String(data.content || '').slice(0, 200) };
  }

  return result;
}

function parseCodexEvent(line: string, lineNum: number): RegistryEvent | null {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line); } catch { return null; }

  const t = raw.type as string;
  const payload = (raw.payload || {}) as Record<string, unknown>;
  if (typeof payload !== 'object') return null;
  const pt = payload.type as string;
  const ts = (raw.timestamp as string) || '';
  const uuid = `codex-${lineNum}`;

  if (t === 'session_meta' || t === 'turn_context') return null;
  if (t === 'event_msg' && ['token_count', 'agent_reasoning', 'agent_message', 'user_message', 'context_compacted'].includes(pt)) return null;

  if (t === 'event_msg') {
    if (pt === 'task_started' || pt === 'task_complete') {
      return { type: 'system', uuid, timestamp: ts, subtype: pt, level: '' };
    }
    return null;
  }

  if (t === 'response_item') {
    const role = payload.role as string;
    const content = payload.content as unknown[];

    if (pt === 'message' && role === 'user') {
      const texts: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'input_text') texts.push((b.text as string || '').slice(0, MAX_TEXT_LEN));
        }
      }
      if (!texts.length) return null;
      const firstText = texts[0];
      if (firstText.startsWith('# AGENTS.md') || firstText.startsWith('# Collaboration Mode') || firstText.startsWith('<environment_context>')) return null;
      const joined = texts.join('\n');
      return { type: 'user', uuid, timestamp: ts, userType: 'external', text: joined.slice(0, MAX_TEXT_LEN), truncated: joined.length > MAX_TEXT_LEN };
    }
    if (pt === 'message' && role === 'developer') return null;
    if (pt === 'message' && role === 'assistant') {
      const texts = Array.isArray(content) ? content.filter((b: unknown) => (b as Record<string,unknown>)?.type === 'output_text').map((b: unknown) => ((b as Record<string,unknown>).text as string || '').slice(0, MAX_TEXT_LEN)) : [];
      const ev: RegistryEvent = { type: 'assistant', uuid, timestamp: ts, model: '', usage: {}, stop_reason: '' };
      if (texts.length) ev.text = texts.join('\n');
      return ev;
    }
    if (pt === 'function_call') {
      const args = payload.arguments as string || '{}';
      const trunc = typeof args === 'string' && args.length > MAX_TOOL_INPUT_LEN;
      return { type: 'assistant', uuid, timestamp: ts, model: '', usage: {}, stop_reason: '', tool_uses: [{ type: 'tool_use', id: payload.call_id || '', name: payload.name || '', input: (typeof args === 'string' ? args : JSON.stringify(args)).slice(0, MAX_TOOL_INPUT_LEN), truncated: trunc }] };
    }
    if (pt === 'function_call_output') {
      const output = (payload.output as string) || '';
      return { type: 'user', uuid, timestamp: ts, userType: 'tool_result', tool_results: [{ tool_use_id: payload.call_id || '', type: 'tool_result', content: output.slice(0, MAX_TOOL_RESULT_LEN), truncated: output.length > MAX_TOOL_RESULT_LEN }] };
    }
    if (pt === 'custom_tool_call') {
      const inp = (payload.input as string) || '';
      return { type: 'assistant', uuid, timestamp: ts, model: '', usage: {}, stop_reason: '', tool_uses: [{ type: 'tool_use', id: payload.call_id || '', name: payload.name || '', input: inp.slice(0, MAX_TOOL_INPUT_LEN), truncated: inp.length > MAX_TOOL_INPUT_LEN }] };
    }
    if (pt === 'custom_tool_call_output') {
      const output = (payload.output as string) || '';
      return { type: 'user', uuid, timestamp: ts, userType: 'tool_result', tool_results: [{ tool_use_id: payload.call_id || '', type: 'tool_result', content: output.slice(0, MAX_TOOL_RESULT_LEN), truncated: output.length > MAX_TOOL_RESULT_LEN }] };
    }
    if (pt === 'reasoning') {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const summaryText = summary.filter((i: unknown) => (i as Record<string,unknown>)?.type === 'summary_text').map((i: unknown) => (i as Record<string,unknown>).text as string).join('\n');
      const ev: RegistryEvent = { type: 'assistant', uuid, timestamp: ts, model: '', usage: {}, stop_reason: '', hasThinking: true };
      if (summaryText) ev.text = summaryText.slice(0, MAX_TEXT_LEN);
      return ev;
    }
  }

  return null;
}

function readEvents(filePath: string, after?: string, limit = 100): RegistryEvent[] {
  let size: number;
  try { size = fs.statSync(filePath).size; } catch { return []; }

  const isCodex = isCodexPath(filePath);

  if (isCodex) return readCodexEvents(filePath, size, after, limit);
  if (after) return readAfterCursor(filePath, size, after, limit);
  return readTail(filePath, size, limit);
}

function readTail(filePath: string, size: number, limit: number): RegistryEvent[] {
  const events: RegistryEvent[] = [];
  try {
    const text = size > TAIL_READ_BYTES
      ? readTailLines(filePath, TAIL_READ_BYTES).join('\n')
      : fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      const ev = parseEvent(line.trim());
      if (ev && !SKIP_TYPES.has(ev.type)) events.push(ev);
    }
  } catch (e) {
    logger.error('SESSION_REGISTRY', 'Error reading tail', {}, e as Error);
  }
  return events.slice(-limit);
}

function readAfterCursor(filePath: string, size: number, after: string, limit: number): RegistryEvent[] {
  const events: RegistryEvent[] = [];
  let found = false;

  const processLines = (lines: string[]): boolean => {
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!found) {
        try {
          const obj = JSON.parse(line);
          if (obj.uuid === after || obj.id === after) { found = true; }
        } catch { /* skip */ }
        continue;
      }
      const ev = parseEvent(line.trim());
      if (ev && !SKIP_TYPES.has(ev.type)) {
        events.push(ev);
        if (events.length >= limit) return true;
      }
    }
    return false;
  };

  try {
    if (size > TAIL_READ_BYTES) {
      const tailLines = readTailLines(filePath, TAIL_READ_BYTES);
      if (processLines(tailLines) || found) return events;
    }
    // Full scan
    const text = fs.readFileSync(filePath, 'utf-8');
    found = false;
    events.length = 0;
    processLines(text.split('\n'));
  } catch (e) {
    logger.error('SESSION_REGISTRY', 'Error reading after cursor', {}, e as Error);
  }
  return events;
}

function readCodexEvents(filePath: string, size: number, after?: string, limit = 100): RegistryEvent[] {
  const events: RegistryEvent[] = [];

  if (after && after.startsWith('codex-')) {
    const afterLine = parseInt(after.split('-')[1] ?? '-1', 10);
    let found = false;
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!found) { if (i === afterLine) found = true; continue; }
        const ev = parseCodexEvent(lines[i].trim(), i);
        if (ev && !SKIP_TYPES.has(ev.type)) { events.push(ev); if (events.length >= limit) break; }
      }
    } catch { /* ignore */ }
    return events;
  }

  try {
    // Always perform a full read so that cursor IDs (codex-<lineNum>) are stable
    // absolute line numbers regardless of file size. This ensures after=codex-N
    // pagination is always correct.
    const text = fs.readFileSync(filePath, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const ev = parseCodexEvent(lines[i].trim(), i);
      if (ev && !SKIP_TYPES.has(ev.type)) events.push(ev);
    }
  } catch { /* ignore */ }

  return events.slice(-limit);
}

function getRawEvent(filePath: string, eventUuid: string): unknown | null {
  try {
    if (eventUuid.startsWith('codex-')) {
      const targetLine = parseInt(eventUuid.split('-')[1] ?? '-1', 10);
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      if (targetLine >= 0 && targetLine < lines.length) {
        return JSON.parse(lines[targetLine].trim());
      }
      return null;
    }
    const size = fs.statSync(filePath).size;
    const checkLines = (lines: string[]): unknown | null => {
      for (const line of lines) {
        try {
          const obj = JSON.parse(line.trim());
          if (obj.uuid === eventUuid || obj.id === eventUuid) return obj;
        } catch { /* skip */ }
      }
      return null;
    };
    if (size > TAIL_READ_BYTES) {
      const result = checkLines(readTailLines(filePath, TAIL_READ_BYTES));
      if (result) return result;
    }
    return checkLines(fs.readFileSync(filePath, 'utf-8').split('\n'));
  } catch { return null; }
}

function getStats(filePath: string): Record<string, unknown> {
  const stats: Record<string, unknown> = {
    model: '', version: '', cwd: '', gitBranch: '',
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    tool_calls: {} as Record<string, number>,
    event_counts: {} as Record<string, number>,
    first_timestamp: '', last_timestamp: '', duration_seconds: 0,
  };
  const tokens = stats.tokens as Record<string, number>;
  const toolCalls = stats.tool_calls as Record<string, number>;
  const eventCounts = stats.event_counts as Record<string, number>;

  let firstTs = '', lastTs = '';

  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line); } catch { continue; }

      const et = raw.type as string;
      if (!et) continue;
      eventCounts[et] = (eventCounts[et] || 0) + 1;

      let ts = raw.timestamp as string | number;
      if (ts) {
        if (typeof ts === 'number') {
          ts = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
        }
        if (!firstTs) firstTs = ts as string;
        lastTs = ts as string;
      }

      if (!stats.cwd && raw.cwd) stats.cwd = raw.cwd;
      if (!stats.gitBranch && raw.gitBranch) stats.gitBranch = raw.gitBranch;
      if (!stats.version && typeof raw.version === 'string') stats.version = raw.version;

      const msg = (raw.message || {}) as Record<string, unknown>;

      if (et === 'assistant') {
        if (!stats.model && msg.model) stats.model = msg.model;
        const usage = (msg.usage || {}) as Record<string, number>;
        tokens.input += usage.input_tokens || 0;
        tokens.output += usage.output_tokens || 0;
        tokens.cache_read += usage.cache_read_input_tokens || 0;
        tokens.cache_creation += usage.cache_creation_input_tokens || 0;
        for (const block of (msg.content as unknown[] || [])) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') { const n = (b.name as string) || 'unknown'; toolCalls[n] = (toolCalls[n] || 0) + 1; }
        }
      } else if (et === 'message') {
        const role = msg.role as string;
        if (role === 'assistant') {
          const m = msg.model as string || '';
          if (!stats.model && m && m !== 'delivery-mirror') stats.model = m;
          const usage = (msg.usage || {}) as Record<string, number>;
          tokens.input += usage.input_tokens || usage.input || 0;
          tokens.output += usage.output_tokens || usage.output || 0;
          tokens.cache_read += usage.cache_read_input_tokens || usage.cacheRead || 0;
          tokens.cache_creation += usage.cache_creation_input_tokens || usage.cacheWrite || 0;
          for (const block of (msg.content as unknown[] || [])) {
            const b = block as Record<string, unknown>;
            if (b.type === 'toolCall') { const n = (b.name as string) || 'unknown'; toolCalls[n] = (toolCalls[n] || 0) + 1; }
          }
        }
      } else if (['session_meta', 'turn_context', 'response_item', 'event_msg'].includes(et)) {
        const payload = (raw.payload || {}) as Record<string, unknown>;
        const pt = payload.type as string;
        if (et === 'session_meta') {
          if (!stats.cwd) stats.cwd = payload.cwd || '';
          if (!stats.version) stats.version = payload.cli_version || '';
          const git = (payload.git || {}) as Record<string, string>;
          if (!stats.gitBranch) stats.gitBranch = git.branch || '';
        } else if (et === 'turn_context' && !stats.model) {
          stats.model = payload.model || '';
        } else if (et === 'event_msg' && pt === 'token_count') {
          const info = (payload.info || {}) as Record<string, unknown>;
          const usage = (info.total_token_usage || {}) as Record<string, number>;
          if (usage.input_tokens) tokens.input = usage.input_tokens;
          if (usage.output_tokens) tokens.output = usage.output_tokens + (usage.reasoning_output_tokens || 0);
          if (usage.cached_input_tokens) tokens.cache_read = usage.cached_input_tokens;
        } else if (et === 'response_item' && (pt === 'function_call' || pt === 'custom_tool_call')) {
          const n = (payload.name as string) || 'unknown';
          toolCalls[n] = (toolCalls[n] || 0) + 1;
        }
      }
    }
  } catch (e) {
    logger.error('SESSION_REGISTRY', 'Error reading stats', {}, e as Error);
  }

  stats.first_timestamp = firstTs;
  stats.last_timestamp = lastTs;
  if (firstTs && lastTs) {
    try {
      const t1 = new Date(firstTs).getTime();
      const t2 = new Date(lastTs).getTime();
      stats.duration_seconds = Math.max(0, Math.round((t2 - t1) / 1000));
    } catch { /* ignore */ }
  }

  return stats;
}

function scanInlineSubagents(filePath: string, sessionId: string): RegistrySubagent[] {
  const calls = new Map<string, Record<string, unknown>>();
  const results = new Map<string, Record<string, unknown>>();

  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.includes('sessions_spawn')) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line); } catch { continue; }

      const msg = (raw.message || {}) as Record<string, unknown>;
      const role = msg.role as string;
      const content = msg.content as unknown[];
      const ts = (raw.timestamp as string) || '';

      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'toolCall' && b.name === 'sessions_spawn') {
            const cid = (b.id as string) || '';
            const args = (b.arguments || {}) as Record<string, unknown>;
            calls.set(cid, { task: args.task || '', model: args.model || '', mode: args.mode || 'run', timestamp: ts });
          }
        }
      }
      if (role === 'toolResult' && msg.toolName === 'sessions_spawn') {
        const tcid = (msg.toolCallId as string) || '';
        let rc = '';
        if (Array.isArray(content)) rc = content.filter((b: unknown) => (b as Record<string,unknown>)?.type === 'text').map((b: unknown) => (b as Record<string,unknown>).text as string).join('');
        else if (typeof content === 'string') rc = content;
        if (rc) {
          try {
            const parsed = JSON.parse(rc);
            results.set(tcid, { status: parsed.status || '', childSessionKey: parsed.childSessionKey || '', runId: parsed.runId || '', error: parsed.error || '' });
          } catch { /* ignore */ }
        }
      }
    }
  } catch { return []; }

  const subagents: RegistrySubagent[] = [];
  for (const [tcid, result] of results) {
    if (result.status !== 'accepted') continue;
    const call = calls.get(tcid) || {};
    const childKey = (result.childSessionKey as string) || '';
    const parts = childKey.split(':');
    const saId = parts.length >= 4 ? parts[parts.length - 1] : childKey;
    const task = (call.task as string) || '';
    const slug = task.slice(0, 60).replace(/\n/g, ' ').trim() + (task.length > 60 ? '...' : '');
    subagents.push({
      id: 'oc-spawn-' + saId.slice(0, 12),
      parentId: sessionId,
      agentType: 'openclaw-spawn',
      slug,
      model: (call.model as string) || '',
      status: 'completed',
      mtime: 0,
      ephemeral: true,
      spawnStatus: result.status as string,
      runId: result.runId as string || '',
      childSessionKey: childKey,
      timestamp: (call.timestamp as string) || '',
    });
  }
  return subagents;
}

// ─── Global index instance ────────────────────────────────────────────────────

const sessionIndex = new SessionIndex();

// ─── Route handler class ──────────────────────────────────────────────────────

export class SessionRegistryRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/session-registry/list', this.wrapHandler(this.handleList.bind(this)));
    app.get('/api/session-registry/:id/events', this.wrapHandler(this.handleEvents.bind(this)));
    app.get('/api/session-registry/:id/stats', this.wrapHandler(this.handleStats.bind(this)));
    app.get('/api/session-registry/:id/subagents', this.wrapHandler(this.handleSubagents.bind(this)));
    app.get('/api/session-registry/:id/raw-event/:eventId', this.wrapHandler(this.handleRawEvent.bind(this)));
  }

  private handleList(req: Request, res: Response): void {
    const { project, status, search, source, offset, limit } = req.query;
    const data = sessionIndex.getSessions({
      project: project as string | undefined,
      status: status as string | undefined,
      search: search as string | undefined,
      source: source as string | undefined,
      offset: offset ? parseInt(offset as string, 10) : 0,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });
    res.json(data);
  }

  private handleEvents(req: Request, res: Response): void {
    const { id } = req.params;
    const filePath = sessionIndex.getSessionPath(id);
    if (!filePath) { this.notFound(res, 'Session not found'); return; }
    const { after, limit } = req.query;
    const rawLimit = limit ? parseInt(limit as string, 10) : 100;
    const clampedLimit = (!Number.isFinite(rawLimit) || rawLimit < 1) ? 100 : Math.min(rawLimit, 500);
    const events = readEvents(filePath, after as string | undefined, clampedLimit);
    res.json({ events, sessionId: id });
  }

  private handleStats(req: Request, res: Response): void {
    const { id } = req.params;
    const filePath = sessionIndex.getSessionPath(id);
    if (!filePath) { this.notFound(res, 'Session not found'); return; }
    res.json(getStats(filePath));
  }

  private handleSubagents(req: Request, res: Response): void {
    const { id } = req.params;
    const diskSubagents = sessionIndex.getSubagents(id);
    const filePath = sessionIndex.getSessionPath(id);
    const inline = filePath ? scanInlineSubagents(filePath, id) : [];
    const all = [...diskSubagents, ...inline];
    res.json({ sessionId: id, subagents: all, total: all.length });
  }

  private handleRawEvent(req: Request, res: Response): void {
    const { id, eventId } = req.params;
    const filePath = sessionIndex.getSessionPath(id);
    if (!filePath) { this.notFound(res, 'Session not found'); return; }
    const event = getRawEvent(filePath, eventId);
    if (!event) { this.notFound(res, 'Event not found'); return; }
    res.json(event);
  }
}
