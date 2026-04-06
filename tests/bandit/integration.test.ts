import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BanditEngine } from '../../src/services/bandit/BanditEngine.js';
import { FeedbackRecorder } from '../../src/services/bandit/FeedbackRecorder.js';

describe('Bandit integration', () => {
  let db: Database;
  let engine: BanditEngine;
  let recorder: FeedbackRecorder;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT '', created_at_epoch INTEGER DEFAULT 0,
      memory_session_id TEXT DEFAULT '', project TEXT DEFAULT ''
    )`);
    db.run(`CREATE TABLE observation_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL,
      signal TEXT NOT NULL, source TEXT NOT NULL,
      project TEXT, created_at_epoch INTEGER NOT NULL
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
      description: 'Model selection per obs type',
      rewardSignals: ['semantic_inject_hit', 'search_accessed'],
      createdAt: Date.now()
    });
    recorder = new FeedbackRecorder(db, engine);
  });

  it('full cycle: select arm → store observation → feedback → bandit learns', () => {
    // 1. Bandit selects a model
    const candidates = ['discovery:model-a', 'discovery:model-b'];
    const selected = engine.selectArm('model-per-obs-type', candidates);
    const selectedModel = selected.split(':').slice(1).join(':');

    // 2. Observation is stored with the model
    db.run(
      "INSERT INTO observations (id, type, generated_by_model) VALUES (1, 'discovery', ?)",
      [selectedModel]
    );

    // 3. Later, the observation gets reused (semantic injection hit)
    recorder.recordFeedback([1], 'semantic_inject_hit', 'semantic_inject');

    // 4. Bandit state should reflect the reward
    const stats = engine.getArmStats('model-per-obs-type');
    const selectedArmStats = stats.find(a => a.armId === selected);
    expect(selectedArmStats).toBeTruthy();
    expect(selectedArmStats!.alpha).toBeGreaterThan(1);

    // 5. Feedback was recorded in DB
    const feedback = db.query('SELECT * FROM observation_feedback').all();
    expect(feedback.length).toBe(1);

    // 6. Relevance count was incremented
    const obs = db.query('SELECT relevance_count FROM observations WHERE id = 1').get() as any;
    expect(obs.relevance_count).toBe(1);
  });

  it('bandit converges: arm with higher reward rate gets selected more', () => {
    const candidates = ['test:arm-a', 'test:arm-b'];

    // Warm up: force equal exploration
    for (const arm of candidates) {
      engine.selectArm('model-per-obs-type', candidates);
      for (let i = 0; i < 5; i++) {
        engine.recordReward('model-per-obs-type', arm, Math.random() < (arm.includes('arm-a') ? 0.7 : 0.3) ? 1 : 0);
      }
    }

    // Run 100 selections after warmup
    const selections = { 'test:arm-a': 0, 'test:arm-b': 0 };
    for (let i = 0; i < 100; i++) {
      const sel = engine.selectArm('model-per-obs-type', candidates);
      selections[sel as keyof typeof selections]++;
      const reward = sel === 'test:arm-a' ? (Math.random() < 0.7 ? 1 : 0) : (Math.random() < 0.3 ? 1 : 0);
      engine.recordReward('model-per-obs-type', sel, reward as 0 | 1);
    }

    // arm-a (70% success) should be selected significantly more than arm-b (30%)
    expect(selections['test:arm-a']).toBeGreaterThan(selections['test:arm-b']);
  });
});
