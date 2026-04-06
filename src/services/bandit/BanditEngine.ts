import { Database } from 'bun:sqlite';
import { betaSample } from './sampling.js';
import { logger } from '../../utils/logger.js';
import type { Experiment, Arm, ExperimentSummary, BanditConfig } from './types.js';

const DEFAULT_MIN_PULLS = 3;

export class BanditEngine {
  private db!: Database;
  private experiments: Map<string, Experiment> = new Map();
  private arms: Map<string, Map<string, Arm>> = new Map();
  private config: BanditConfig = {
    enabled: false,
    candidateModels: [],
    minPullsBeforeExploit: DEFAULT_MIN_PULLS,
    logSelections: true,
  };

  init(db: Database): void {
    this.db = db;
    this.loadFromDb();
  }

  setConfig(config: Partial<BanditConfig>): void {
    Object.assign(this.config, config);
  }

  registerExperiment(experiment: Experiment): void {
    if (this.experiments.has(experiment.id)) return;

    this.experiments.set(experiment.id, experiment);
    if (!this.arms.has(experiment.id)) {
      this.arms.set(experiment.id, new Map());
    }

    this.db.prepare(
      'INSERT OR IGNORE INTO bandit_experiments (id, description, reward_signals, created_at_epoch) VALUES (?, ?, ?, ?)'
    ).run(experiment.id, experiment.description, JSON.stringify(experiment.rewardSignals), experiment.createdAt);
  }

  selectArm(experimentId: string, candidateArms: string[]): string {
    const expArms = this.arms.get(experimentId);
    if (!expArms) {
      throw new Error(`Experiment '${experimentId}' not registered`);
    }

    // Ensure all candidates exist
    for (const armId of candidateArms) {
      if (!expArms.has(armId)) {
        this.createArm(experimentId, armId);
      }
    }

    let selected: string;

    // Round-robin phase: if any candidate has fewer pulls than minimum, pick the least-pulled
    const minPulls = this.config.minPullsBeforeExploit;
    const underExplored = candidateArms.filter(id => {
      const arm = expArms.get(id)!;
      return arm.pulls < minPulls;
    });

    if (underExplored.length > 0) {
      underExplored.sort((a, b) => expArms.get(a)!.pulls - expArms.get(b)!.pulls);
      selected = underExplored[0];
      if (this.config.logSelections) {
        const arm = expArms.get(selected)!;
        logger.debug('BANDIT', `round-robin select`, {
          experiment: experimentId, selected, pulls: arm.pulls, minPulls
        });
      }
    } else {
      // Thompson Sampling: sample from each arm's Beta distribution
      let bestArm = candidateArms[0];
      let bestSample = -1;

      for (const armId of candidateArms) {
        const arm = expArms.get(armId)!;
        const theta = betaSample(arm.alpha, arm.beta);
        if (theta > bestSample) {
          bestSample = theta;
          bestArm = armId;
        }
      }

      selected = bestArm;

      if (this.config.logSelections) {
        const arm = expArms.get(selected)!;
        logger.debug('BANDIT', `thompson select`, {
          experiment: experimentId, selected,
          alpha: arm.alpha, beta: arm.beta,
          estimated: (arm.alpha / (arm.alpha + arm.beta)).toFixed(3),
          pulls: arm.pulls
        });
      }
    }

    // Increment pulls on selection (not on reward)
    const arm = expArms.get(selected)!;
    arm.pulls += 1;
    arm.updatedAt = Date.now();
    this.db.prepare(
      'UPDATE bandit_arms SET pulls = ?, updated_at_epoch = ? WHERE experiment_id = ? AND arm_id = ?'
    ).run(arm.pulls, arm.updatedAt, experimentId, selected);

    return selected;
  }

  recordReward(experimentId: string, armId: string, reward: 0 | 1): void {
    const expArms = this.arms.get(experimentId);
    if (!expArms) return;

    let arm = expArms.get(armId);
    if (!arm) {
      this.createArm(experimentId, armId);
      arm = expArms.get(armId)!;
    }

    if (reward === 1) {
      arm.alpha += 1;
    } else {
      arm.beta += 1;
    }
    arm.totalReward += reward;
    arm.updatedAt = Date.now();

    this.db.prepare(
      'UPDATE bandit_arms SET alpha = ?, beta = ?, total_reward = ?, updated_at_epoch = ? WHERE experiment_id = ? AND arm_id = ?'
    ).run(arm.alpha, arm.beta, arm.totalReward, arm.updatedAt, experimentId, armId);

    if (this.config.logSelections) {
      logger.debug('BANDIT', `reward`, {
        experiment: experimentId, arm: armId, reward,
        newAlpha: arm.alpha, newBeta: arm.beta
      });
    }
  }

  getArmStats(experimentId: string): Arm[] {
    const expArms = this.arms.get(experimentId);
    if (!expArms) return [];
    return Array.from(expArms.values());
  }

  getExperimentSummary(experimentId: string): ExperimentSummary {
    const arms = this.getArmStats(experimentId);
    const totalPulls = arms.reduce((sum, a) => sum + a.pulls, 0);

    let pearsonR: number | null = null;
    const armsWithPulls = arms.filter(a => a.pulls > 0);
    if (armsWithPulls.length >= 2) {
      const estimated = armsWithPulls.map(a => a.alpha / (a.alpha + a.beta));
      const actual = armsWithPulls.map(a => a.pulls > 0 ? a.totalReward / a.pulls : 0);
      pearsonR = pearsonCorrelation(estimated, actual);
    }

    return { arms, totalPulls, pearsonR };
  }

  private createArm(experimentId: string, armId: string): void {
    const arm: Arm = {
      experimentId, armId,
      alpha: 1.0, beta: 1.0,
      pulls: 0, totalReward: 0,
      updatedAt: Date.now()
    };

    const expArms = this.arms.get(experimentId)!;
    expArms.set(armId, arm);

    this.db.prepare(
      'INSERT OR IGNORE INTO bandit_arms (experiment_id, arm_id, alpha, beta, pulls, total_reward, updated_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(arm.experimentId, arm.armId, arm.alpha, arm.beta, arm.pulls, arm.totalReward, arm.updatedAt);
  }

  private loadFromDb(): void {
    const experiments = this.db.query('SELECT * FROM bandit_experiments').all() as any[];
    for (const row of experiments) {
      this.experiments.set(row.id, {
        id: row.id,
        description: row.description,
        rewardSignals: JSON.parse(row.reward_signals),
        createdAt: row.created_at_epoch,
      });
      if (!this.arms.has(row.id)) {
        this.arms.set(row.id, new Map());
      }
    }

    const arms = this.db.query('SELECT * FROM bandit_arms').all() as any[];
    for (const row of arms) {
      const expArms = this.arms.get(row.experiment_id);
      if (!expArms) continue;
      expArms.set(row.arm_id, {
        experimentId: row.experiment_id,
        armId: row.arm_id,
        alpha: row.alpha,
        beta: row.beta,
        pulls: row.pulls,
        totalReward: row.total_reward,
        updatedAt: row.updated_at_epoch,
      });
    }
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX) * Math.sqrt(denomY);
  return denom === 0 ? 0 : num / denom;
}
