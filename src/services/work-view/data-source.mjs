// Bun's native SQLite reader; source data is never opened for writing.
import { Database as DatabaseSync } from 'bun:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { activitySignature, buildAgentView, readAgentRecords, readEvidence } from './agent-view.mjs';
import { goalsAddedSince, ledgerSignature, readLedger } from './request-groups.mjs';
import { recordedFile } from './work-product.mjs';

const CLOSED = new Set(['done', 'dropped']);
const normalizedKey = (value) => String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const iso = (epoch) => epoch == null ? null : new Date(epoch).toISOString();
const isClosed = (status) => status != null && CLOSED.has(String(status).toLowerCase());
const effectiveStatus = (status) => status == null || status === '' ? 'unknown' : String(status).toLowerCase();
const listId = (project, name) => JSON.stringify([normalizedKey(project), name]);
const taskId = (parentId, name) => JSON.stringify([parentId, name]);

// Entries are patches, not full records. This is the same append/merge behavior
// as claude-mem's WorkStateRenderer: state and named tasks are separate maps.
export function reduceWorkState(entries, { currentProject, currentProjectScope = [], eventLimit = Infinity, localDeviceId = '' } = {}) {
  const scope = new Set(currentProjectScope.map(normalizedKey));
  const listsById = new Map();
  const events = [];
  let revision = 0;
  // Match sqlite/work-state.ts:getWorkStateEntries. Imported rows replay at
  // their original write time, not the later local rowid assigned on arrival.
  const device = row => row.origin_device_id ?? localDeviceId;
  for (const row of [...entries].sort((a, b) => {
    const timeAndDevice = a.created_at_epoch - b.created_at_epoch
      || (device(a) < device(b) ? -1 : device(a) > device(b) ? 1 : 0);
    if (timeAndDevice) return timeAndDevice;
    const left = BigInt(a.origin_local_id ?? a.id), right = BigInt(b.origin_local_id ?? b.id);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    revision = Math.max(revision, row.id);
    const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid work-state entry');
    const id = listId(row.scope_project ?? row.project, row.list_name);
    let list = listsById.get(id);
    if (!list) {
      list = { id, project: row.scope_project ?? row.project, name: row.list_name, fields: {}, tasksByName: new Map(), updatedAtEpoch: 0, stateUpdatedAtEpoch: null, latestEntryId: 0 };
      listsById.set(id, list);
    }
    const taskName = fields.task == null || fields.task === '' ? null : String(fields.task);
    let target = list;
    if (taskName !== null) {
      target = list.tasksByName.get(taskName);
      if (!target) {
        target = { id: taskId(id, taskName), name: taskName, fields: {}, updatedAtEpoch: 0, latestEntryId: 0 };
        list.tasksByName.set(taskName, target);
      }
    } else {
      list.stateUpdatedAtEpoch = row.created_at_epoch;
    }
    const changes = [];
    for (const [key, value] of Object.entries(fields)) {
      const hadPrevious = Object.hasOwn(target.fields, key);
      const previous = target.fields[key];
      if (key !== 'task' && ((value === null && hadPrevious) || (value !== null && (!hadPrevious || previous !== value)))) {
        changes.push({ field: key, ...(hadPrevious ? { previous } : {}), value, hadPrevious });
      }
      if (value === null) delete target.fields[key];
      else target.fields[key] = value;
    }
    target.updatedAtEpoch = row.created_at_epoch;
    target.latestEntryId = row.id;
    list.updatedAtEpoch = row.created_at_epoch;
    list.latestEntryId = row.id;
    events.push({
      id: row.id, project: list.project, originProject: row.project, listName: row.list_name, listId: id,
      task: taskName, taskId: taskName === null ? null : target.id,
      type: taskName === null ? 'state' : 'task', fields, changes,
      status: taskName === null ? (target.fields.status == null ? 'open' : String(target.fields.status).toLowerCase()) : effectiveStatus(target.fields.status),
      at: iso(row.created_at_epoch), atEpoch: row.created_at_epoch,
      sourceOrder: [row.created_at_epoch, device(row), String(row.origin_local_id ?? row.id)],
      inCurrentScope: scope.has(normalizedKey(row.project)),
    });
  }
  const lists = [...listsById.values()].sort((a, b) => b.latestEntryId - a.latestEntryId).map((list) => {
    const tasks = [...list.tasksByName.values()].map((task) => ({
      ...task, status: effectiveStatus(task.fields.status), isOpen: !isClosed(task.fields.status), updatedAt: iso(task.updatedAtEpoch),
    }));
    const stateIsOpen = Object.keys(list.fields).some((key) => key !== 'task') && !isClosed(list.fields.status);
    const { tasksByName, ...record } = list;
    return {
      ...record, status: isClosed(list.fields.status) ? String(list.fields.status).toLowerCase() : 'open',
      isOpen: stateIsOpen || tasks.some((task) => task.isOpen),
      inCurrentScope: scope.has(normalizedKey(list.project)),
      updatedAt: iso(list.updatedAtEpoch), stateUpdatedAt: iso(list.stateUpdatedAtEpoch), tasks,
    };
  });
  const projectsById = new Map();
  for (const list of lists) {
    const key = normalizedKey(list.project);
    const project = projectsById.get(key) ?? { id: list.project, name: list.project, lists: 0, openLists: 0, tasks: 0, doing: 0, inCurrentScope: list.inCurrentScope, lastUpdatedAt: list.updatedAt };
    project.lists++;
    project.openLists += Number(list.isOpen);
    project.tasks += list.tasks.length;
    project.doing += list.tasks.filter((task) => task.isOpen && task.status === 'doing').length;
    projectsById.set(key, project);
  }
  const projects = [...projectsById.values()];
  const tasks = lists.flatMap((list) => list.tasks);
  const summary = {
    projects: projects.length, lists: lists.length, openLists: lists.filter((list) => list.isOpen).length,
    tasks: tasks.length, openTasks: tasks.filter((task) => task.isOpen).length,
    todo: tasks.filter((task) => task.status === 'todo').length,
    doing: tasks.filter((task) => task.status === 'doing').length,
    done: tasks.filter((task) => task.status === 'done').length,
    dropped: tasks.filter((task) => task.status === 'dropped').length,
    unknown: tasks.filter((task) => task.status === 'unknown').length,
  };
  return {
    schemaVersion: 1, revision,
    entryCount: entries.length, currentProject, currentProjectScope, summary, projects, lists,
    events: events.slice(-eventLimit).reverse(),
    lastUpdatedAt: events.length ? events.at(-1).at : null,
  };
}

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
    }
    return this.database;
  }

  read() {
    this.source.lastCheckedAt = new Date().toISOString();
    try {
      const database = this.openDatabase();
      const revision = database.prepare(`SELECT COUNT(*) AS count, MAX(id) AS id${this.columns.has('sync_rev') ? ', SUM(CAST(sync_rev AS INTEGER)) AS synced_revision' : ''} FROM work_state_entries`).get();
      const signature = `${revision.count}:${revision.id ?? 0}:${revision.synced_revision ?? 0}:${this.localDeviceId}`;
      this.readTitleCache();
      this.readLedger();
      const activity = `${activitySignature(database)}|titles:${this.titleCacheSignature}|ledger:${this.ledgerSignature}`;
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
    return {
      ...this.agentView,
      ...this.goalLinks(),
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

  /** Join the request-progress alignment onto requests and goals, the way the
   * prototype's goalsSnapshot() does. A request's `goals` is absent until it is
   * aligned (Goal not linked yet), [] when it serves none, else its goals. */
  goalLinks() {
    const alignment = this.ledger?.alignment;
    const goals = this.agentView.goals;
    if (!alignment || !goals) return {};
    const byGoal = new Map([...goals.priorities, ...goals.openAsks].map((goal) => [goal.task, goal]));
    // "Serves none" holds until a goal is added; then the group is asked again.
    const unaligned = new Set(goalsAddedSince(alignment, [...byGoal.keys()]).length ? [] : alignment.unaligned ?? []);
    const humanRequests = (this.agentView.humanRequests ?? []).map((request) => {
      if (!request.groupId) return request;
      const links = (alignment.links?.[request.groupId] ?? []).filter((link) => byGoal.has(link.goal)).map((link) => {
        const goal = byGoal.get(link.goal);
        return { goalId: goal.id, goal: link.goal, title: goal.title, kind: goal.kind, evidence: link.evidence };
      });
      if (links.length) return { ...request, goals: links };
      return unaligned.has(request.groupId) ? { ...request, goals: [] } : request;
    });
    return { humanRequests, goals: { ...goals, alignedAt: alignment.alignedAt ?? null } };
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

  close() {
    this.database?.close();
    this.database = null;
    this.databaseIdentity = null;
  }
}
