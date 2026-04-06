import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BanditEngine } from '../../src/services/bandit/BanditEngine.js';

describe('BanditEngine', () => {
  let db: Database;
  let engine: BanditEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE IF NOT EXISTS bandit_experiments (
      id TEXT PRIMARY KEY, description TEXT NOT NULL,
      reward_signals TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS bandit_arms (
      experiment_id TEXT NOT NULL, arm_id TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 1.0, beta REAL NOT NULL DEFAULT 1.0,
      pulls INTEGER NOT NULL DEFAULT 0, total_reward REAL NOT NULL DEFAULT 0.0,
      updated_at_epoch INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, arm_id),
      FOREIGN KEY (experiment_id) REFERENCES bandit_experiments(id) ON DELETE CASCADE
    )`);
    engine = new BanditEngine();
    engine.init(db);
  });

  describe('registerExperiment', () => {
    it('registers and persists an experiment', () => {
      engine.registerExperiment({
        id: 'test-exp',
        description: 'Test experiment',
        rewardSignals: ['semantic_inject_hit'],
        createdAt: Date.now()
      });
      const row = db.query('SELECT * FROM bandit_experiments WHERE id = ?').get('test-exp') as any;
      expect(row).toBeTruthy();
      expect(row.id).toBe('test-exp');
      expect(JSON.parse(row.reward_signals)).toEqual(['semantic_inject_hit']);
    });

    it('is idempotent for same experiment id', () => {
      const exp = { id: 'test-exp', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now() };
      engine.registerExperiment(exp);
      engine.registerExperiment(exp);
      const count = db.query('SELECT COUNT(*) as c FROM bandit_experiments').get() as any;
      expect(count.c).toBe(1);
    });
  });

  describe('selectArm', () => {
    it('returns one of the candidate arms', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      const candidates = ['arm-a', 'arm-b', 'arm-c'];
      const selected = engine.selectArm('exp1', candidates);
      expect(candidates).toContain(selected);
    });

    it('creates unknown arms with Beta(1,1)', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      engine.selectArm('exp1', ['new-arm']);
      const stats = engine.getArmStats('exp1');
      const arm = stats.find(a => a.armId === 'new-arm');
      expect(arm).toBeTruthy();
      expect(arm!.alpha).toBe(1.0);
      expect(arm!.beta).toBe(1.0);
    });

    it('round-robins when arms have fewer pulls than minPullsBeforeExploit', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      const candidates = ['arm-a', 'arm-b'];
      const selections = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const selected = engine.selectArm('exp1', candidates);
        selections.add(selected);
        engine.recordReward('exp1', selected, 1);
      }
      expect(selections.size).toBe(2);
    });
  });

  describe('recordReward', () => {
    it('updates alpha on success', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      engine.selectArm('exp1', ['arm-a']);
      engine.recordReward('exp1', 'arm-a', 1);
      const stats = engine.getArmStats('exp1');
      const arm = stats.find(a => a.armId === 'arm-a')!;
      expect(arm.alpha).toBe(2.0);
      expect(arm.beta).toBe(1.0);
      expect(arm.pulls).toBe(1);
      expect(arm.totalReward).toBe(1);
    });

    it('updates beta on failure', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      engine.selectArm('exp1', ['arm-a']);
      engine.recordReward('exp1', 'arm-a', 0);
      const stats = engine.getArmStats('exp1');
      const arm = stats.find(a => a.armId === 'arm-a')!;
      expect(arm.alpha).toBe(1.0);
      expect(arm.beta).toBe(2.0);
    });

    it('persists to SQLite', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      engine.selectArm('exp1', ['arm-a']);
      engine.recordReward('exp1', 'arm-a', 1);
      const row = db.query('SELECT * FROM bandit_arms WHERE arm_id = ?').get('arm-a') as any;
      expect(row.alpha).toBe(2.0);
      expect(row.pulls).toBe(1);
    });
  });

  describe('getExperimentSummary', () => {
    it('returns summary with arms and total pulls', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      engine.selectArm('exp1', ['arm-a', 'arm-b']);
      engine.recordReward('exp1', 'arm-a', 1);
      engine.recordReward('exp1', 'arm-b', 0);
      const summary = engine.getExperimentSummary('exp1');
      expect(summary.arms.length).toBe(2);
      expect(summary.totalPulls).toBe(2);
    });
  });

  describe('persistence across restart', () => {
    it('loads state from DB on init', () => {
      engine.registerExperiment({
        id: 'exp1', description: 'Test', rewardSignals: ['hit'], createdAt: Date.now()
      });
      engine.selectArm('exp1', ['arm-a']);
      engine.recordReward('exp1', 'arm-a', 1);
      engine.recordReward('exp1', 'arm-a', 1);
      engine.recordReward('exp1', 'arm-a', 0);

      const engine2 = new BanditEngine();
      engine2.init(db);
      const stats = engine2.getArmStats('exp1');
      const arm = stats.find(a => a.armId === 'arm-a')!;
      expect(arm.alpha).toBe(3.0);
      expect(arm.beta).toBe(2.0);
      expect(arm.pulls).toBe(3);
    });
  });
});
