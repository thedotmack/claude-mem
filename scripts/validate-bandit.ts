// scripts/validate-bandit.ts
/**
 * Offline bandit validation script.
 * Reads bandit state from SQLite and compares with OraClaw optimize_bandit.
 * Run manually: bun scripts/validate-bandit.ts
 */
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const db = new Database(DB_PATH, { readonly: true });

// 1. Read bandit state
const experiments = db.query('SELECT * FROM bandit_experiments').all() as any[];
const arms = db.query('SELECT * FROM bandit_arms ORDER BY experiment_id, pulls DESC').all() as any[];

if (experiments.length === 0) {
  console.log('No experiments registered. Enable bandit first.');
  process.exit(0);
}

for (const exp of experiments) {
  console.log(`\n=== Experiment: ${exp.id} ===`);
  console.log(`Description: ${exp.description}`);
  console.log(`Reward signals: ${exp.reward_signals}`);

  const expArms = arms.filter((a: any) => a.experiment_id === exp.id);
  if (expArms.length === 0) {
    console.log('No arms yet.\n');
    continue;
  }

  console.log('\nArm stats:');
  console.log('| Arm | Alpha | Beta | Pulls | Reward | Est. Rate |');
  console.log('|-----|-------|------|-------|--------|-----------|');

  const estimated: number[] = [];
  const actual: number[] = [];

  for (const arm of expArms) {
    const est = arm.alpha / (arm.alpha + arm.beta);
    const act = arm.pulls > 0 ? arm.total_reward / arm.pulls : 0;
    estimated.push(est);
    actual.push(act);
    console.log(`| ${arm.arm_id} | ${arm.alpha.toFixed(1)} | ${arm.beta.toFixed(1)} | ${arm.pulls} | ${arm.total_reward.toFixed(1)} | ${est.toFixed(3)} |`);
  }

  // Pearson correlation
  if (estimated.length >= 2) {
    const n = estimated.length;
    const meanE = estimated.reduce((a, b) => a + b, 0) / n;
    const meanA = actual.reduce((a, b) => a + b, 0) / n;
    let num = 0, denomE = 0, denomA = 0;
    for (let i = 0; i < n; i++) {
      const de = estimated[i] - meanE;
      const da = actual[i] - meanA;
      num += de * da;
      denomE += de * de;
      denomA += da * da;
    }
    const denom = Math.sqrt(denomE) * Math.sqrt(denomA);
    const r = denom === 0 ? 0 : num / denom;
    console.log(`\nPearson r = ${r.toFixed(4)}`);
    console.log(r > 0.3 ? 'LEARNING (r > 0.3)' : r > 0.1 ? 'WEAK SIGNAL (0.1 < r < 0.3)' : 'NO SIGNAL (r < 0.1)');
  }

  // Exploration check
  const totalPulls = expArms.reduce((s: number, a: any) => s + a.pulls, 0);
  const underExplored = expArms.filter((a: any) => a.pulls < 5);
  if (underExplored.length > 0) {
    console.log(`\nWARNING: ${underExplored.length} arms with < 5 pulls (under-explored)`);
  }
  console.log(`Total pulls: ${totalPulls}`);
}

// 2. OraClaw comparison (format arms for optimize_bandit)
console.log('\n=== OraClaw comparison data ===');
console.log('Run in Claude Code:');
for (const exp of experiments) {
  const expArms = arms.filter((a: any) => a.experiment_id === exp.id);
  const oraclawArms = expArms.map((a: any) => ({
    id: a.arm_id,
    name: a.arm_id,
    pulls: a.pulls,
    totalReward: a.total_reward
  }));
  console.log(`mcp__oraclaw__optimize_bandit({ arms: ${JSON.stringify(oraclawArms)}, algorithm: 'thompson' })`);
}

db.close();
