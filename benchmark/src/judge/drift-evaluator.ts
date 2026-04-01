import type { AgentState } from './state-reader.js';

// --- Types ---

export type DriftStage =
  | 'planning'
  | 'scaffolding'
  | 'building'
  | 'integration'
  | 'polish';

export type DriftScore =
  | 'on-track'
  | 'minor-deviation'
  | 'major-drift'
  | 'unrecoverable';

export interface DriftAssessment {
  agentId: string;
  stage: DriftStage;
  score: DriftScore;
  reasoning: string;
  elapsedMinutes: number;
  fileCount: number;
  lastActivityMinutesAgo: number;
}

// --- Stage Detection ---

/**
 * Determines the expected stage based on elapsed minutes since container start.
 *
 * - 0-15 min -> planning
 * - 15-60 min -> scaffolding
 * - 1-3 hrs (60-180 min) -> building
 * - 3-5 hrs (180-300 min) -> integration
 * - 5+ hrs (300+ min) -> polish
 */
export function detectStage(elapsedMinutes: number): DriftStage {
  if (elapsedMinutes < 15) return 'planning';
  if (elapsedMinutes < 60) return 'scaffolding';
  if (elapsedMinutes < 180) return 'building';
  if (elapsedMinutes < 300) return 'integration';
  return 'polish';
}

// --- Expected File Counts Per Stage ---

/**
 * Returns the minimum expected file count for a given stage.
 * These are conservative thresholds -- below this is suspicious.
 */
function minimumExpectedFileCount(stage: DriftStage): number {
  switch (stage) {
    case 'planning':
      return 0;
    case 'scaffolding':
      return 3;
    case 'building':
      return 8;
    case 'integration':
      return 15;
    case 'polish':
      return 20;
  }
}

// --- Drift Scoring ---

/**
 * Evaluates an agent's drift based on its current state.
 *
 * Drift scoring rules:
 * - on-track: activity within last 5 min, file count increasing for stage
 * - minor-deviation: activity within last 15 min but slower than expected
 * - major-drift: no activity for 15-30 min, or file count doesn't match stage
 * - unrecoverable: no activity for 30+ min, or container exited with error
 *
 * The evaluator does NOT auto-kill. It only assesses and logs.
 */
export function evaluateDrift(agentState: AgentState): DriftAssessment {
  const elapsedMinutes = agentState.elapsedSeconds / 60;
  const stage = detectStage(elapsedMinutes);

  const now = new Date();
  const lastActivityMinutesAgo = agentState.lastActivityTime
    ? (now.getTime() - agentState.lastActivityTime.getTime()) / 60_000
    : Infinity;

  // Check for terminal states first
  if (agentState.isDone) {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'on-track',
      reasoning: 'Agent completed successfully (DONE.md present)',
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo:
        lastActivityMinutesAgo === Infinity ? -1 : lastActivityMinutesAgo,
    };
  }

  if (agentState.isKilled) {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'unrecoverable',
      reasoning: 'Agent was killed by operator (KILLED.md present)',
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo:
        lastActivityMinutesAgo === Infinity ? -1 : lastActivityMinutesAgo,
    };
  }

  if (agentState.isCrashed) {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'unrecoverable',
      reasoning: 'Agent crashed (CRASHED.md present)',
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo:
        lastActivityMinutesAgo === Infinity ? -1 : lastActivityMinutesAgo,
    };
  }

  // Container exited without any sentinel file
  if (
    agentState.containerStatus === 'exited' ||
    agentState.containerStatus === 'dead'
  ) {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'unrecoverable',
      reasoning: `Container ${agentState.containerStatus} without completion marker`,
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo:
        lastActivityMinutesAgo === Infinity ? -1 : lastActivityMinutesAgo,
    };
  }

  // Evaluate running agents
  const minFiles = minimumExpectedFileCount(stage);
  const fileCountBelowExpected = agentState.fileCount < minFiles;

  // Unrecoverable: no activity for 30+ min while running
  if (lastActivityMinutesAgo >= 30) {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'unrecoverable',
      reasoning: `No activity for ${Math.round(lastActivityMinutesAgo)} minutes while container is running`,
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo,
    };
  }

  // Major drift: no activity for 15-30 min, or file count doesn't match stage
  if (lastActivityMinutesAgo >= 15) {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'major-drift',
      reasoning: `No activity for ${Math.round(lastActivityMinutesAgo)} minutes`,
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo,
    };
  }

  if (fileCountBelowExpected && stage !== 'planning') {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'major-drift',
      reasoning: `File count ${agentState.fileCount} below expected minimum ${minFiles} for ${stage} stage`,
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo,
    };
  }

  // Minor deviation: activity within 15 min but slower than expected
  if (lastActivityMinutesAgo >= 5) {
    return {
      agentId: agentState.agentId,
      stage,
      score: 'minor-deviation',
      reasoning: `Activity ${Math.round(lastActivityMinutesAgo)} minutes ago, slower than expected`,
      elapsedMinutes,
      fileCount: agentState.fileCount,
      lastActivityMinutesAgo,
    };
  }

  // On-track: activity within last 5 min, file count adequate
  return {
    agentId: agentState.agentId,
    stage,
    score: 'on-track',
    reasoning: 'Active and progressing normally',
    elapsedMinutes,
    fileCount: agentState.fileCount,
    lastActivityMinutesAgo,
  };
}
