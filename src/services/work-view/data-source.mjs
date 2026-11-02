// Bun's native SQLite reader; source data is never opened for writing.
import { Database as DatabaseSync } from 'bun:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { reduceWorkState } from './work-state-reduce.mjs';
import { activitySignature, buildAgentView, readAgentRecords, readEvidence } from './agent-view.mjs';
import { ledgerSignature, openSuggestions, readLedger } from './request-groups.mjs';
import { recordedFile, bucketFileAvailable } from './work-product.mjs';

// reduceWorkState lives in work-state-reduce.mjs so my-focus.mjs can replay rows without importing this module.
export { reduceWorkState } from './work-state-reduce.mjs';
// Kept here for the callers that already import it from the data source.
export { readFocus, readFocusAreas } from './my-focus.mjs';

const normalizedKey = (value) => String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// Expand the same inherited read keys as SessionStore.getProjectReadKeys. A
// worktree's older lists may be stored under a previously merged project key.
export function resolveReadScope(database, requestedKeys) {
  const keys = [...new Set(requestedKeys.map((key) => key.trim()).filter(Boolean))];
  if (!keys.length) return [];
  const marks = keys.map(() => '?').join(',');
  const queries = [
    `SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${marks})`,
    `SELECT project FROM observations WHERE project COLLATE NOCASE IN (${marks})`,
    `SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${marks})`,
    `SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${marks})`,
    `SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${marks})`,
    `SELECT project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${marks})`,
    `SELECT project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${marks})`,
  ];
  // Minimal fixtures and older databases may not have the merge schema. The
  // explicit requested projects remain useful without inherited keys.
  try {
    const rows = database.prepare(queries.join(' UNION ')).all(...queries.flatMap(() => keys));
    return [...new Set([...keys, ...rows.map((row) => row.key).filter(Boolean)])];
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return keys;
    throw error;
  }
}

export class WorkStateSource {
  constructor({
    databasePath = process.env.CLAUDE_MEM_DB ?? join(homedir(), '.claude-mem', 'claude-mem.db'),
    currentProject = '',
    parentProject = currentProject,
    titleCachePath = null,
    ledgerDir = null,
    pollIntervalMs = 1000,
    localDeviceId = '',
  } = {}) {
    this.databasePath = databasePath;
    this.currentProject = currentProject;
    this.parentProject = parentProject;
    this.pollIntervalMs = pollIntervalMs;
    this.localDeviceId = localDeviceId;
    this.titleCachePath = titleCachePath;
    this.titleCache = {};
    this.titleCacheSignature = null;
    this.ledgerDir = ledgerDir;
    this.ledger = null;
    this.ledgerSignature = null;
    this.database = null;
    this.databaseIdentity = null;
    this.cachedState = reduceWorkState([], { currentProject, currentProjectScope: [parentProject, currentProject] });
    this.agentView = buildAgentView(this.cachedState, {});
    this.agentRevision = 0;
    this.activitySignature = null;
    this.activityCheckedAt = null;
    this.signature = null;
    this.source = {
      kind: 'claude-mem-work-state', mode: 'read-only-sqlite', connected: false,
      pollIntervalMs, lastCheckedAt: null, lastUpdatedAt: null, error: null,
    };
  }

  openDatabase() {
    // stat prevents creating a database if the configured file does not exist.
    const stat = statSync(this.databasePath);
    const identity = `${stat.dev}:${stat.ino}`;
    if (!this.database || identity !== this.databaseIdentity) {
      this.close();
      this.database = new DatabaseSync(this.databasePath, { readonly: true, create: false });
      this.database.exec('PRAGMA query_only = ON');
      this.database.exec('PRAGMA busy_timeout = 1500');
      this.columns = new Set(this.database.prepare('PRAGMA table_info(work_state_entries)').all().map(column => column.name));
      this.databaseIdentity = identity;
      this.signature = null;
      this.activitySignature = null;
      this.activityCheckedAt = null;
    }
    return this.database;
  }

  read({ maxActivityAgeMs = 0 } = {}) {
    this.source.lastCheckedAt = new Date().toISOString();
    try {
      const database = this.openDatabase();
      const revision = database.prepare(`SELECT COUNT(*) AS count, MAX(id) AS id${this.columns.has('sync_rev') ? ', SUM(CAST(sync_rev AS INTEGER)) AS synced_revision' : ''} FROM work_state_entries`).get();
      const signature = `${revision.count}:${revision.id ?? 0}:${revision.synced_revision ?? 0}:${this.localDeviceId}`;
      const previousTitles = this.titleCacheSignature;
      const previousLedger = this.ledgerSignature;
      this.readTitleCache();
      this.readLedger();
      const now = Date.now();
      // Only background polling opts into this window. Direct reads (including
      // review writes) must still notice evidence edits that retain row IDs.
      // Owner edits and generated copy bypass it, even during a busy session.
      const reuseActivity = this.source.connected && signature === this.signature
        && previousTitles === this.titleCacheSignature && previousLedger === this.ledgerSignature
        && this.activityCheckedAt !== null && now >= this.activityCheckedAt
        && now - this.activityCheckedAt < maxActivityAgeMs;
      const activity = reuseActivity ? this.activitySignature
        : `${activitySignature(database)}|titles:${this.titleCacheSignature}|ledger:${this.ledgerSignature}`;
      if (signature !== this.signature || activity !== this.activitySignature || !this.source.connected) {
        database.exec('BEGIN');
        try {
          if (signature !== this.signature || !this.source.connected) {
            const originColumns = ['origin_device_id', 'origin_local_id'].filter(column => this.columns.has(column));
            const entries = database.prepare(`SELECT id, project, list_name, fields, created_at_epoch${originColumns.length ? `, ${originColumns.join(', ')}` : ''} FROM work_state_entries`).all();
            const currentProjectScope = resolveReadScope(database, [this.parentProject, this.currentProject]);
            const requested = new Set([this.parentProject, this.currentProject].map(normalizedKey));
            // Match worker's scope_project only for directly requested legacy keys.
            const scopedEntries = entries.map((entry) => requested.has(normalizedKey(entry.project)) ? { ...entry, scope_project: this.currentProject } : entry);
            this.cachedState = reduceWorkState(scopedEntries, { currentProject: this.currentProject, currentProjectScope, localDeviceId: this.localDeviceId });
          }
          this.agentRevision++;
          this.agentView = { ...buildAgentView(this.cachedState, readAgentRecords(database, { workState: this.cachedState, ledger: this.ledger }), { titleCache: this.titleCache, ledger: this.ledger }), revision: this.agentRevision };
          // Hash full linked evidence without sending its potentially large raw
          // text in every snapshot. A review covers the source disclosure too.
          const evidenceHashes = new Map();
          for (const request of this.agentView.humanRequests) {
            const refs = new Map();
            const add = ref => {
              if (ref && ['work-state', 'observation', 'prompt', 'summary', 'session'].includes(ref.kind)
                && Number.isSafeInteger(ref.id) && ref.id > 0) refs.set(`${ref.kind}:${ref.id}`, ref);
            };
            const addUrl = url => {
              const match = /^\/api\/work-view\/evidence\/([\w-]+)\/(\d+)$/.exec(url ?? '');
              if (match) add({ kind: match[1], id: Number(match[2]) });
            };
            addUrl(request.original?.url);
            for (const update of request.scopeUpdates) addUrl(update.url);
            for (const item of request.items) {
              addUrl(item.url);
              addUrl(item.request?.url);
              addUrl(item.request?.original?.url);
              for (const field of [item.nextStep, item.outcome]) {
                if (field?.source === 'session-summary') add({ kind: 'summary', id: field.sourceId });
              }
              for (const ref of item.sourceRefs ?? []) add(ref);
            }
            for (const activity of [...request.activity, ...request.workstreams.flatMap(stream => stream.activity)]) add(activity.sourceRef);
            request.sourceContentHashes = [...refs].sort(([a], [b]) => a.localeCompare(b)).map(([key, ref]) => {
              if (!evidenceHashes.has(key)) {
                evidenceHashes.set(key, createHash('sha256').update(JSON.stringify(readEvidence(database, ref.kind, ref.id))).digest('hex'));
              }
              return { ...ref, hash: evidenceHashes.get(key) };
            });
          }
          this.signature = signature;
          this.activitySignature = activity;
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }
      if (!reuseActivity) this.activityCheckedAt = now;
      this.source.connected = true;
      this.source.error = null;
      this.source.lastUpdatedAt = this.cachedState.lastUpdatedAt;
    } catch (error) {
      this.source.connected = false;
      // Do not expose paths, SQL, environment, or any raw worker reply.
      this.source.error = /ENOENT/.test(String(error.code)) ? 'Local work-state database is unavailable.' : 'Local work-state database could not be read. Retrying.';
      this.close();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      ...this.cachedState, generatedAt: new Date().toISOString(),
      agentView: this.agentsSnapshot(),
      source: { ...this.source, stale: !this.source.connected && this.cachedState.entryCount > 0 },
    };
  }

  readTitleCache() {
    let signature = 'missing';
    try {
      if (!this.titleCachePath) throw new Error('Cache disabled');
      const stat = statSync(this.titleCachePath);
      signature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (signature === this.titleCacheSignature) return;
      if (stat.size > 1024 * 1024) throw new Error('Cache too large');
      const parsed = JSON.parse(readFileSync(this.titleCachePath, 'utf8'));
      this.titleCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.titleCache = {};
    }
    this.titleCacheSignature = signature;
  }

  readLedger() {
    const signature = this.ledgerDir ? ledgerSignature(this.ledgerDir) : 'disabled';
    if (signature === this.ledgerSignature) return;
    try { this.ledger = this.ledgerDir ? readLedger(this.ledgerDir) : null; }
    catch { this.ledger = null; }
    this.ledgerSignature = signature;
  }

  agentsSnapshot() {
    const now = Date.now();
    // The judge's suggestions ("Looks like part of <request>"), each on the card of the conversation it is about.
    const suggestions = openSuggestions(this.ledger);
    const humanRequests = (this.agentView.humanRequests ?? []).map((request) => {
      const suggestion = suggestions.find((entry) => entry.requestId !== request.groupId && (request.conversationKeys ?? []).includes(entry.conversationKey));
      return suggestion ? { ...request, suggestion } : request;
    });
    return {
      ...this.agentView,
      humanRequests,
      suggestions,
      teamMode: process.env.WORK_STATE_TEAM_MODE === '1',
      // Progress reviews and the build story come from the request-progress
      // skill; they are assessments, separate from recorded lifecycle.
      story: this.ledger ? { reviews: Object.values(this.ledger.progress), story: this.ledger.story, groups: Object.keys(this.ledger.groups.groups).length } : null,
      // The automatic refresh's last run (refresh.json): running, ok, failed or waiting-for-agent.
      refresh: this.ledger?.refresh ?? null,
      // Age labels change with the clock without declaring a task or session
      // live. Stored session status remains separate from recent activity.
      agents: this.agentView.agents.map((agent) => ({ ...agent, presence: {
        ...agent.presence,
        // A recorded finish is evidence, not an age label: the clock never changes it.
        status: agent.presence.status === 'finished' ? 'finished' : !agent.presence.lastActivityAt ? 'unknown' : now - Date.parse(agent.presence.lastActivityAt) <= 15 * 60 * 1000 ? 'recent' : 'quiet',
      } })),
      source: { ...this.source, kind: 'claude-mem-recorded-agent-activity', lastUpdatedAt: this.agentView.agents[0]?.presence.lastActivityAt ?? null, stale: !this.source.connected && this.agentView.agents.length > 0 },
    };
  }

  evidence(kind, id) {
    try { return readEvidence(this.openDatabase(), kind, id); }
    catch { return null; }
  }

  /** The local file a recorded work product names, or null. */
  file(kind, id, index) {
    try { return recordedFile((sql, params) => this.openDatabase().prepare(sql).all(...params), kind, id, index); }
    catch { return null; }
  }

  /** The bucket copy a deliverables row names, while it still exists; null when the row is unknown, the copy is gone, or the table does not exist yet. */
  deliverable(id) {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    try {
      const row = this.openDatabase().prepare('SELECT id, title, kind, bucket_path FROM deliverables WHERE id = ?').all(id)[0];
      return row && bucketFileAvailable({ bucketPath: row.bucket_path }) ? { id: row.id, title: row.title, kind: row.kind, path: row.bucket_path } : null;
    } catch { return null; }
  }

  close() {
    this.database?.close();
    this.database = null;
    this.databaseIdentity = null;
  }
}
