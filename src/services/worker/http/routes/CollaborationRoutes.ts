/**
 * Collaboration Routes
 *
 * Multi-agent collaboration endpoints: mailbox, file locks, plans,
 * agent controls, observation CRUD, and status.
 */

import express, { Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../../../utils/logger.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

const CONTROLS_PATH = join(homedir(), '.claude-mem', 'agent-controls.json');

const DEFAULT_CONTROLS = {
  leader: 'claude-code',
  leader_mode: 'auto',
  active_project: null,
  projects: [],
  notifications: { windows_toast: true, telegram: { enabled: false }, discord: { enabled: false } },
  backup: { local_dir: join(homedir(), '.claude-mem', 'backups'), remote_dir: null, auto_sync: false, retention_days: 30 },
  agents: {
    'claude-code': { listening: true, polling_interval: 300, model: 'claude-opus-4-6', reasoning: 'extended', permissions: 'full' },
    'codex': { listening: true, polling_interval: 30, model: 'gpt-5.4', reasoning: 'standard', permissions: 'sandboxed' },
    'claude-app': { listening: true, model: 'claude-sonnet-4-6', reasoning: 'extended', permissions: 'read-plan' }
  }
};

function loadControls(): any {
  try {
    if (existsSync(CONTROLS_PATH)) {
      return JSON.parse(readFileSync(CONTROLS_PATH, 'utf-8'));
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CONTROLS };
}

function saveControls(controls: any): void {
  const tmpPath = CONTROLS_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(controls, null, 2));
  const { renameSync } = require('fs');
  renameSync(tmpPath, CONTROLS_PATH);
}

export class CollaborationRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private sseBroadcaster: SSEBroadcaster
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // ===== Mailbox =====
    app.get('/api/mailbox/:agent', this.handleGetMailbox.bind(this));
    app.post('/api/mailbox', this.handleSendMessage.bind(this));
    app.patch('/api/mailbox/:id/read', this.handleMarkRead.bind(this));

    // ===== File Locks =====
    app.get('/api/locks', this.handleGetLocks.bind(this));
    app.post('/api/lock', this.handleAcquireLock.bind(this));
    app.delete('/api/lock', this.handleReleaseLock.bind(this));
    app.delete('/api/locks/expired', this.handleClearExpiredLocks.bind(this));

    // ===== Observation CRUD =====
    app.post('/api/observations/create', this.handleCreateObservation.bind(this));
    app.patch('/api/observations/:id', this.handleUpdateObservation.bind(this));

    // ===== Plans =====
    app.get('/api/plans', this.handleGetPlans.bind(this));
    app.get('/api/plans/:id', this.handleGetPlan.bind(this));
    app.post('/api/plans', this.handleCreatePlan.bind(this));
    app.patch('/api/plans/:id', this.handleUpdatePlan.bind(this));

    // ===== Agent Controls =====
    app.get('/api/controls', this.handleGetControls.bind(this));
    app.patch('/api/controls', this.handleUpdateControls.bind(this));
    app.patch('/api/controls/:agent', this.handleUpdateAgentControls.bind(this));

    // ===== Status =====
    app.get('/api/status', this.handleGetStatus.bind(this));
    app.patch('/api/status/:agent', this.handleAgentHeartbeat.bind(this));

    // ===== Projects =====
    app.post('/api/projects/rename', this.handleRenameProject.bind(this));
    app.post('/api/projects/delete', this.handleDeleteProject.bind(this));

    // ===== Admin =====
    app.post('/api/admin/backup', this.handleCreateBackup.bind(this));
    app.get('/api/admin/export', this.handleExport.bind(this));
  }

  // ==========================================
  // Mailbox
  // ==========================================

  private handleGetMailbox = this.wrapHandler((req: Request, res: Response): void => {
    const agent = req.params.agent;
    const db = this.dbManager.getConnection();
    const messages = db.prepare(
      'SELECT * FROM messages WHERE to_agent = ? AND read = 0 ORDER BY created_at_epoch DESC'
    ).all(agent);
    res.json({ messages });
  });

  private handleSendMessage = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['from', 'to', 'subject'])) return;

    const { from, to, subject, body, urgent } = req.body;
    const now = Date.now();
    const db = this.dbManager.getConnection();

    const result = db.prepare(`
      INSERT INTO messages (from_agent, to_agent, subject, body, urgent, read, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(from, to, subject, body || '', urgent ? 1 : 0, new Date(now).toISOString(), now);

    const id = Number(result.lastInsertRowid);

    this.sseBroadcaster.broadcast({
      type: 'message_created',
      id,
      from,
      to,
      subject,
      urgent: !!urgent
    });

    res.json({ id, created_at_epoch: now });
  });

  private handleMarkRead = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const now = Date.now();
    const db = this.dbManager.getConnection();
    db.prepare('UPDATE messages SET read = 1, read_at = ?, read_at_epoch = ? WHERE id = ?')
      .run(new Date(now).toISOString(), now, id);

    res.json({ success: true });
  });

  // ==========================================
  // File Locks
  // ==========================================

  private handleGetLocks = this.wrapHandler((_req: Request, res: Response): void => {
    const db = this.dbManager.getConnection();
    const now = Date.now();
    const locks = db.prepare('SELECT * FROM file_locks WHERE expires_at_epoch > ?').all(now);
    res.json({ locks });
  });

  private handleAcquireLock = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['path', 'agent'])) return;

    const { path: filePath, agent } = req.body;
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 minutes
    const db = this.dbManager.getConnection();

    // Check for existing non-expired lock
    const existing = db.prepare(
      'SELECT * FROM file_locks WHERE file_path = ? AND expires_at_epoch > ?'
    ).get(filePath, now) as any;

    if (existing && existing.locked_by !== agent) {
      res.status(409).json({
        error: 'File is locked',
        locked_by: existing.locked_by,
        expires_at_epoch: existing.expires_at_epoch
      });
      return;
    }

    // Upsert lock
    db.prepare(`
      INSERT INTO file_locks (file_path, locked_by, locked_at, locked_at_epoch, expires_at_epoch)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        locked_by = excluded.locked_by,
        locked_at = excluded.locked_at,
        locked_at_epoch = excluded.locked_at_epoch,
        expires_at_epoch = excluded.expires_at_epoch
    `).run(filePath, agent, new Date(now).toISOString(), now, expiresAt);

    res.json({ locked: true, expires_at_epoch: expiresAt });
  });

  private handleReleaseLock = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['path'])) return;

    const { path: filePath, agent } = req.body;
    const db = this.dbManager.getConnection();

    if (agent) {
      db.prepare('DELETE FROM file_locks WHERE file_path = ? AND locked_by = ?').run(filePath, agent);
    } else {
      db.prepare('DELETE FROM file_locks WHERE file_path = ?').run(filePath);
    }

    res.json({ released: true });
  });

  private handleClearExpiredLocks = this.wrapHandler((_req: Request, res: Response): void => {
    const db = this.dbManager.getConnection();
    const result = db.prepare('DELETE FROM file_locks WHERE expires_at_epoch <= ?').run(Date.now());
    res.json({ cleared: Number(result.changes) });
  });

  // ==========================================
  // Observation CRUD
  // ==========================================

  private handleCreateObservation = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['type', 'title', 'project'])) return;

    const { type, title, subtitle, narrative, facts, concepts, files_read, files_modified,
            project, author, metadata, confidence } = req.body;

    const now = Date.now();
    const db = this.dbManager.getConnection();

    // Create a synthetic session for external observations if needed
    const sessionId = `collab-${author || 'external'}-${now}`;

    // Ensure a session exists
    const existingSession = db.prepare(
      'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
    ).get(sessionId) as any;

    if (!existingSession) {
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, 'active')
      `).run(sessionId, project, new Date(now).toISOString(), now);
    }

    // Get the memory_session_id (may be null for external sessions)
    const session = db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = ?'
    ).get(sessionId) as any;

    const memSessionId = session?.memory_session_id || sessionId;

    // Merge confidence into metadata
    const metadataObj = metadata ? (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) : {};
    if (confidence) metadataObj.confidence = confidence;

    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, subtitle, narrative,
        facts, concepts, files_read, files_modified, author, metadata,
        created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memSessionId, project, type, title, subtitle || null, narrative || null,
      facts ? JSON.stringify(facts) : null,
      concepts ? JSON.stringify(concepts) : null,
      files_read ? JSON.stringify(files_read) : null,
      files_modified ? JSON.stringify(files_modified) : null,
      author || 'external',
      Object.keys(metadataObj).length > 0 ? JSON.stringify(metadataObj) : null,
      new Date(now).toISOString(), now
    );

    const id = Number(result.lastInsertRowid);

    this.sseBroadcaster.broadcast({
      type: 'observation_created',
      id,
      observationType: type,
      title,
      author: author || 'external'
    });

    res.json({ id, created_at_epoch: now });
  });

  private handleUpdateObservation = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const db = this.dbManager.getConnection();

    // Get current state for history
    const current = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as any;
    if (!current) {
      this.notFound(res, 'Observation not found');
      return;
    }

    // Save history for rollback
    const now = Date.now();
    db.prepare(`
      INSERT INTO observation_history (observation_id, previous_data, changed_by, change_type, created_at, created_at_epoch)
      VALUES (?, ?, ?, 'update', ?, ?)
    `).run(id, JSON.stringify(current), req.body.changed_by || 'unknown', new Date(now).toISOString(), now);

    // Build dynamic update
    const updates: string[] = [];
    const values: any[] = [];
    const allowedFields = ['title', 'subtitle', 'narrative', 'type', 'metadata', 'author'];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(typeof req.body[field] === 'object' ? JSON.stringify(req.body[field]) : req.body[field]);
      }
    }

    if (updates.length === 0) {
      this.badRequest(res, 'No fields to update');
      return;
    }

    values.push(id);
    db.prepare(`UPDATE observations SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json({ success: true, id });
  });

  // ==========================================
  // Plans
  // ==========================================

  private handleGetPlans = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getConnection();
    const project = req.query.project as string | undefined;
    const query = project
      ? 'SELECT * FROM plans WHERE project = ? ORDER BY created_at_epoch DESC'
      : 'SELECT * FROM plans ORDER BY created_at_epoch DESC';
    const plans = project ? db.prepare(query).all(project) : db.prepare(query).all();
    res.json({ plans });
  });

  private handleGetPlan = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getConnection();
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!plan) {
      this.notFound(res, 'Plan not found');
      return;
    }
    res.json(plan);
  });

  private handleCreatePlan = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['id', 'title'])) return;

    const { id, title, description, goals, phases, notes, project, created_by } = req.body;
    const now = Date.now();
    const db = this.dbManager.getConnection();

    db.prepare(`
      INSERT INTO plans (id, title, description, status, goals, phases, notes, project, created_by,
        created_at, created_at_epoch, updated_at, updated_at_epoch)
      VALUES (?, ?, ?, 'drafting', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, title, description || null,
      goals ? JSON.stringify(goals) : null,
      phases ? JSON.stringify(phases) : null,
      notes || null, project || null, created_by || null,
      new Date(now).toISOString(), now, new Date(now).toISOString(), now
    );

    this.sseBroadcaster.broadcast({ type: 'plan_created', id, title });

    res.json({ id, created_at_epoch: now });
  });

  private handleUpdatePlan = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getConnection();
    const existing = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!existing) {
      this.notFound(res, 'Plan not found');
      return;
    }

    const updates: string[] = [];
    const values: any[] = [];
    const allowedFields = ['title', 'description', 'status', 'goals', 'phases', 'notes'];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        const val = req.body[field];
        values.push(typeof val === 'object' ? JSON.stringify(val) : val);
      }
    }

    if (updates.length === 0) {
      this.badRequest(res, 'No fields to update');
      return;
    }

    const now = Date.now();
    updates.push('updated_at = ?', 'updated_at_epoch = ?');
    values.push(new Date(now).toISOString(), now, req.params.id);

    db.prepare(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json({ success: true, id: req.params.id });
  });

  // ==========================================
  // Agent Controls
  // ==========================================

  private handleGetControls = this.wrapHandler((_req: Request, res: Response): void => {
    res.json(loadControls());
  });

  private handleUpdateControls = this.wrapHandler((req: Request, res: Response): void => {
    const controls = loadControls();
    Object.assign(controls, req.body);
    saveControls(controls);
    res.json(controls);
  });

  private handleUpdateAgentControls = this.wrapHandler((req: Request, res: Response): void => {
    const agent = req.params.agent;
    const controls = loadControls();

    if (!controls.agents) controls.agents = {};
    if (!controls.agents[agent]) controls.agents[agent] = {};

    Object.assign(controls.agents[agent], req.body);
    saveControls(controls);

    res.json({ agent, config: controls.agents[agent] });
  });

  // ==========================================
  // Status
  // ==========================================

  private handleGetStatus = this.wrapHandler((_req: Request, res: Response): void => {
    const db = this.dbManager.getConnection();
    const controls = loadControls();
    const now = Date.now();

    // Get active locks
    const locks = db.prepare('SELECT * FROM file_locks WHERE expires_at_epoch > ?').all(now);

    // Get unread messages per agent
    const unreadCounts = db.prepare(`
      SELECT to_agent, COUNT(*) as count FROM messages WHERE read = 0 GROUP BY to_agent
    `).all();

    // Get pending tasks (observations with type='task' and metadata containing task_status='pending')
    const pendingTasks = db.prepare(`
      SELECT * FROM observations WHERE type = 'task'
      AND metadata LIKE '%"task_status":"pending"%'
      ORDER BY created_at_epoch DESC LIMIT 20
    `).all();

    // Get recent observations (last 20)
    const recentObservations = db.prepare(
      'SELECT id, type, title, author, created_at_epoch FROM observations ORDER BY created_at_epoch DESC LIMIT 20'
    ).all();

    res.json({
      controls,
      locks,
      unread_messages: unreadCounts,
      pending_tasks: pendingTasks,
      recent_observations: recentObservations,
      timestamp: now
    });
  });

  private handleAgentHeartbeat = this.wrapHandler((req: Request, res: Response): void => {
    const agent = req.params.agent;
    const controls = loadControls();

    if (!controls.agents) controls.agents = {};
    if (!controls.agents[agent]) controls.agents[agent] = {};

    controls.agents[agent].last_heartbeat = Date.now();
    controls.agents[agent].status = 'active';
    if (req.body.current_task) controls.agents[agent].current_task = req.body.current_task;
    if (req.body.tokens_used_today !== undefined) controls.agents[agent].tokens_used_today = req.body.tokens_used_today;
    if (req.body.context_window_pct !== undefined) controls.agents[agent].context_window_pct = req.body.context_window_pct;

    saveControls(controls);
    res.json({ agent, status: 'active' });
  });

  // ==========================================
  // Admin
  // ==========================================

  private handleCreateBackup = this.wrapHandler((_req: Request, res: Response): void => {
    const { copyFileSync, mkdirSync } = require('fs');
    const controls = loadControls();
    const backupDir = controls.backup?.local_dir || join(homedir(), '.claude-mem', 'backups');

    mkdirSync(backupDir, { recursive: true });

    const dbPath = join(homedir(), '.claude-mem', 'claude-mem.db');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `claude-mem-${timestamp}.db`);

    copyFileSync(dbPath, backupPath);

    // Also backup controls
    if (existsSync(CONTROLS_PATH)) {
      copyFileSync(CONTROLS_PATH, join(backupDir, `agent-controls-${timestamp}.json`));
    }

    res.json({ backup_path: backupPath, timestamp });
  });

  // ==========================================
  // Projects
  // ==========================================

  private handleRenameProject = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['oldName', 'newName'])) return;

    const { oldName, newName } = req.body;
    const db = this.dbManager.getConnection();

    // Update project name across all tables
    const tables = [
      { table: 'observations', column: 'project' },
      { table: 'session_summaries', column: 'project' },
      { table: 'sdk_sessions', column: 'project' },
    ];

    let totalUpdated = 0;
    for (const { table, column } of tables) {
      try {
        const result = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newName, oldName);
        totalUpdated += result.changes;
      } catch {
        // Table may not exist in older schemas
      }
    }

    // Update controls if active_project matches
    const controls = loadControls();
    if (controls.active_project === oldName) {
      controls.active_project = newName;
      saveControls(controls);
    }

    this.sseBroadcaster.broadcast({
      type: 'project_renamed',
      oldName,
      newName,
      timestamp: Date.now()
    });

    res.json({ success: true, oldName, newName, updated: totalUpdated });
  });

  private handleDeleteProject = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['name'])) return;

    const { name } = req.body;
    const db = this.dbManager.getConnection();

    // Delete project data across all tables
    const tables = [
      { table: 'observations', column: 'project' },
      { table: 'session_summaries', column: 'project' },
      { table: 'sdk_sessions', column: 'project' },
    ];

    let totalDeleted = 0;
    for (const { table, column } of tables) {
      try {
        const result = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(name);
        totalDeleted += result.changes;
      } catch {
        // Table may not exist in older schemas
      }
    }

    // Clear active_project if it matches
    const controls = loadControls();
    if (controls.active_project === name) {
      controls.active_project = null;
      saveControls(controls);
    }

    this.sseBroadcaster.broadcast({
      type: 'project_deleted',
      name,
      timestamp: Date.now()
    });

    res.json({ success: true, name, deleted: totalDeleted });
  });

  private handleExport = this.wrapHandler((_req: Request, res: Response): void => {
    const db = this.dbManager.getConnection();

    const observations = db.prepare('SELECT * FROM observations ORDER BY created_at_epoch DESC').all();
    const messages = db.prepare('SELECT * FROM messages ORDER BY created_at_epoch DESC').all();
    const plans = db.prepare('SELECT * FROM plans ORDER BY created_at_epoch DESC').all();
    const summaries = db.prepare('SELECT * FROM session_summaries ORDER BY created_at_epoch DESC').all();
    const controls = loadControls();

    res.json({
      version: 1,
      exported_at: new Date().toISOString(),
      observations,
      messages,
      plans,
      summaries,
      controls
    });
  });
}
