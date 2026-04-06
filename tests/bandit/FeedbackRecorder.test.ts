import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { FeedbackRecorder } from '../../src/services/bandit/FeedbackRecorder.js';
import { BanditEngine } from '../../src/services/bandit/BanditEngine.js';

describe('FeedbackRecorder', () => {
  let db: Database;
  let recorder: FeedbackRecorder;
  let engine: BanditEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT '',
      created_at_epoch INTEGER DEFAULT 0,
      memory_session_id TEXT DEFAULT '',
      project TEXT DEFAULT ''
    )`);
    db.run(`CREATE TABLE observation_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL,
      signal TEXT NOT NULL,
      source TEXT NOT NULL,
      project TEXT,
      created_at_epoch INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE bandit_experiments (
      id TEXT PRIMARY KEY, description TEXT NOT NULL,
      reward_signals TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE bandit_arms (
      experiment_id TEXT NOT NULL, arm_id TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 1.0, beta REAL NOT NULL DEFAULT 1.0,
      pulls INTEGER NOT NULL DEFAULT 0, total_reward REAL NOT NULL DEFAULT 0.0,
      updated_at_epoch INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, arm_id)
    )`);

    engine = new BanditEngine();
    engine.init(db);
    engine.registerExperiment({
      id: 'model-per-obs-type',
      description: 'Model selection by observation type',
      rewardSignals: ['semantic_inject_hit', 'search_accessed'],
      createdAt: Date.now()
    });

    recorder = new FeedbackRecorder(db, engine);
  });

  describe('recordFeedback', () => {
    it('inserts feedback rows into observation_feedback', () => {
      db.run("INSERT INTO observations (id, type, generated_by_model) VALUES (1, 'discovery', 'claude-opus-4-6')");
      db.run("INSERT INTO observations (id, type, generated_by_model) VALUES (2, 'change', 'claude-sonnet-4-5')");

      recorder.recordFeedback([1, 2], 'semantic_inject_hit', 'semantic_inject');

      const rows = db.query('SELECT * FROM observation_feedback ORDER BY observation_id').all() as any[];
      expect(rows.length).toBe(2);
      expect(rows[0].observation_id).toBe(1);
      expect(rows[0].signal).toBe('semantic_inject_hit');
      expect(rows[0].source).toBe('semantic_inject');
    });

    it('increments relevance_count on observations', () => {
      db.run("INSERT INTO observations (id, type, generated_by_model, relevance_count) VALUES (1, 'discovery', 'claude-opus-4-6', 0)");

      recorder.recordFeedback([1], 'semantic_inject_hit', 'semantic_inject');

      const obs = db.query('SELECT relevance_count FROM observations WHERE id = 1').get() as any;
      expect(obs.relevance_count).toBe(1);
    });

    it('notifies BanditEngine for observations with generated_by_model', () => {
      db.run("INSERT INTO observations (id, type, generated_by_model) VALUES (1, 'discovery', 'claude-opus-4-6')");

      recorder.recordFeedback([1], 'semantic_inject_hit', 'semantic_inject');

      const stats = engine.getArmStats('model-per-obs-type');
      const arm = stats.find(a => a.armId === 'discovery:claude-opus-4-6');
      expect(arm).toBeTruthy();
      expect(arm!.alpha).toBe(2.0);
    });

    it('skips bandit notification for observations without generated_by_model', () => {
      db.run("INSERT INTO observations (id, type) VALUES (1, 'discovery')");

      recorder.recordFeedback([1], 'semantic_inject_hit', 'semantic_inject');

      const stats = engine.getArmStats('model-per-obs-type');
      expect(stats.length).toBe(0);
    });

    it('handles empty observation IDs gracefully', () => {
      recorder.recordFeedback([], 'semantic_inject_hit', 'semantic_inject');
      const count = db.query('SELECT COUNT(*) as c FROM observation_feedback').get() as any;
      expect(count.c).toBe(0);
    });
  });
});
