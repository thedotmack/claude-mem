// src/services/bandit/types.ts

export interface Experiment {
  id: string;
  description: string;
  rewardSignals: string[];
  createdAt: number;
}

export interface Arm {
  experimentId: string;
  armId: string;
  alpha: number;
  beta: number;
  pulls: number;
  totalReward: number;
  updatedAt: number;
}

export interface BanditConfig {
  enabled: boolean;
  candidateModels: string[];
  minPullsBeforeExploit: number;
  logSelections: boolean;
}

export interface ExperimentSummary {
  arms: Arm[];
  totalPulls: number;
  pearsonR: number | null;
}
