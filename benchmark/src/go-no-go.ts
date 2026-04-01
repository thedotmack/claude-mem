import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentResult } from './analysis/aggregator.js';

// --- Error Classes ---

export class GoNoGoReadError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
  ) {
    super(`Go/No-Go check failed to read ${filePath}: ${reason}`);
    this.name = 'GoNoGoReadError';
  }
}

// --- Interfaces ---

export interface GoNoGoCriterion {
  name: string;
  passed: boolean;
  value: string;
  threshold: string;
  details: string;
}

export interface GoNoGoResult {
  passed: boolean;
  criteria: GoNoGoCriterion[];
}

// --- Helpers ---

async function readJsonFileSafe<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function fileExistsSafe(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listDirectoriesSafe(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath);
    const directories: string[] = [];
    for (const entry of entries) {
      try {
        const entryStat = await stat(join(dirPath, entry));
        if (entryStat.isDirectory()) {
          directories.push(entry);
        }
      } catch {
        // Skip entries we cannot stat
      }
    }
    return directories;
  } catch {
    return [];
  }
}

/**
 * Determines the completion status of an agent by checking for sentinel files
 * in the agent's results directory.
 */
async function detectAgentCompletionStatus(
  agentDir: string,
): Promise<string> {
  if (await fileExistsSafe(join(agentDir, 'DONE.md'))) return 'DONE';
  if (await fileExistsSafe(join(agentDir, 'CRASHED.md'))) return 'CRASHED';
  if (await fileExistsSafe(join(agentDir, 'KILLED.md'))) return 'KILLED';
  return 'INCOMPLETE';
}

// --- Industry Prompt Detection ---

/**
 * Prompts 17-20 are the industry comparison prompts.
 * Agent IDs for these contain the prompt number prefix (17, 18, 19, 20).
 */
const INDUSTRY_PROMPT_PREFIXES = ['17-', '18-', '19-', '20-'];

function isIndustryPromptAgent(agentId: string): boolean {
  for (const prefix of INDUSTRY_PROMPT_PREFIXES) {
    // Agent IDs follow the pattern: cmem-17-xxx or vanilla-17-xxx
    // Or based on prompt_id from agent-result.json
    if (agentId.includes(prefix)) return true;
  }
  return false;
}

// --- Criteria Checkers ---

/**
 * Criterion 1: >= 90% of Phase 1 agents complete without crashing.
 * Reads all agent directories and checks for DONE.md vs CRASHED.md/KILLED.md.
 */
async function checkCompletionRate(
  resultsDir: string,
  agentDirectories: string[],
): Promise<GoNoGoCriterion> {
  let completedCount = 0;
  let totalCount = 0;

  for (const agentId of agentDirectories) {
    const agentDir = join(resultsDir, agentId);
    const completionStatus = await detectAgentCompletionStatus(agentDir);
    totalCount++;
    if (completionStatus === 'DONE') {
      completedCount++;
    }
  }

  const completionRate = totalCount > 0 ? completedCount / totalCount : 0;
  const passed = completionRate >= 0.90;

  return {
    name: 'Agent completion rate >= 90%',
    passed,
    value: `${completedCount}/${totalCount} (${(completionRate * 100).toFixed(1)}%)`,
    threshold: '>= 90%',
    details: passed
      ? `${completedCount} of ${totalCount} agents completed successfully`
      : `Only ${completedCount} of ${totalCount} agents completed. Need at least ${Math.ceil(totalCount * 0.9)} completions.`,
  };
}

/**
 * Criterion 2: Calibration agreement >= 75%.
 * Reads calibration-report.json from results directory.
 */
async function checkCalibrationAgreement(
  resultsDir: string,
): Promise<GoNoGoCriterion> {
  const calibrationReportPath = join(resultsDir, 'calibration-report.json');
  const report = await readJsonFileSafe<{
    agreementPercentage?: number;
    passed?: boolean;
    totalProjects?: number;
  }>(calibrationReportPath);

  if (!report) {
    return {
      name: 'Calibration agreement >= 75%',
      passed: false,
      value: 'N/A',
      threshold: '>= 75%',
      details: 'calibration-report.json not found in results directory',
    };
  }

  // Handle vacuously true case (no calibration projects)
  if (report.totalProjects === 0) {
    return {
      name: 'Calibration agreement >= 75%',
      passed: true,
      value: '100% (vacuously true, 0 projects)',
      threshold: '>= 75%',
      details: 'No calibration projects available; passing vacuously',
    };
  }

  const agreement = report.agreementPercentage ?? 0;
  const passed = agreement >= 75;

  return {
    name: 'Calibration agreement >= 75%',
    passed,
    value: `${agreement.toFixed(1)}%`,
    threshold: '>= 75%',
    details: passed
      ? `Calibration agreement at ${agreement.toFixed(1)}% across ${report.totalProjects} projects`
      : `Calibration agreement at ${agreement.toFixed(1)}% is below the 75% threshold`,
  };
}

/**
 * Criterion 3: At least 1 industry comparison prompt completes.
 * Checks if any of prompts 17-20 have DONE status.
 */
async function checkIndustryPromptCompletion(
  resultsDir: string,
  agentDirectories: string[],
): Promise<GoNoGoCriterion> {
  const industryAgents: string[] = [];
  const completedIndustryAgents: string[] = [];

  for (const agentId of agentDirectories) {
    if (isIndustryPromptAgent(agentId)) {
      industryAgents.push(agentId);
      const agentDir = join(resultsDir, agentId);
      const completionStatus = await detectAgentCompletionStatus(agentDir);
      if (completionStatus === 'DONE') {
        completedIndustryAgents.push(agentId);
      }
    }
  }

  // Also check agent-result.json files for prompt_id in 17-20 range
  if (industryAgents.length === 0) {
    for (const agentId of agentDirectories) {
      const resultPath = join(resultsDir, agentId, 'agent-result.json');
      const agentResult = await readJsonFileSafe<AgentResult>(resultPath);
      if (agentResult) {
        for (const prefix of INDUSTRY_PROMPT_PREFIXES) {
          if (agentResult.prompt_id.startsWith(prefix)) {
            industryAgents.push(agentId);
            if (agentResult.completion_status === 'DONE') {
              completedIndustryAgents.push(agentId);
            }
            break;
          }
        }
      }
    }
  }

  const passed = completedIndustryAgents.length >= 1;

  return {
    name: 'At least 1 industry comparison prompt completes',
    passed,
    value: `${completedIndustryAgents.length}/${industryAgents.length} industry agents completed`,
    threshold: '>= 1 completed',
    details: passed
      ? `Industry agents completed: ${completedIndustryAgents.join(', ')}`
      : industryAgents.length === 0
        ? 'No industry comparison agents (prompts 17-20) found in results'
        : `No industry comparison agents completed. Found: ${industryAgents.join(', ')}`,
  };
}

/**
 * Criterion 4: Smoke test framework executes without errors.
 * Checks if smoke-results.json exists for completed agents.
 */
async function checkSmokeTestFramework(
  resultsDir: string,
  agentDirectories: string[],
): Promise<GoNoGoCriterion> {
  let completedAgentsCount = 0;
  let agentsWithSmokeResults = 0;
  const missingSmoke: string[] = [];

  for (const agentId of agentDirectories) {
    const agentDir = join(resultsDir, agentId);
    const completionStatus = await detectAgentCompletionStatus(agentDir);

    if (completionStatus === 'DONE') {
      completedAgentsCount++;
      const smokeResultsPath = join(agentDir, 'smoke-results.json');
      if (await fileExistsSafe(smokeResultsPath)) {
        agentsWithSmokeResults++;
      } else {
        missingSmoke.push(agentId);
      }
    }
  }

  // Pass if all completed agents have smoke results (or if there are no completed agents)
  const passed = completedAgentsCount === 0 || agentsWithSmokeResults === completedAgentsCount;

  return {
    name: 'Smoke test framework executes without errors',
    passed,
    value: `${agentsWithSmokeResults}/${completedAgentsCount} completed agents have smoke results`,
    threshold: '100% of completed agents',
    details: passed
      ? completedAgentsCount === 0
        ? 'No completed agents to verify'
        : `All ${completedAgentsCount} completed agents have smoke-results.json`
      : `Missing smoke-results.json for: ${missingSmoke.join(', ')}`,
  };
}

/**
 * Criterion 5: JSON output validates against schema for all completed agents.
 * Reads each agent-result.json and checks for required fields.
 */
async function checkSchemaValidation(
  resultsDir: string,
  agentDirectories: string[],
): Promise<GoNoGoCriterion> {
  let completedAgentsCount = 0;
  let validAgents = 0;
  const invalidAgents: string[] = [];

  const requiredFields = [
    'schema_version',
    'agent_id',
    'arm',
    'prompt_id',
    'prompt_category',
    'model_version',
    'tokens',
    'cost_usd',
    'wall_clock_seconds',
    'completion_status',
    'smoke_tests',
    'rubric_scores',
    'judge_blinded',
    'industry_baseline',
    'raw_log_sha256',
  ];

  for (const agentId of agentDirectories) {
    const agentDir = join(resultsDir, agentId);
    const completionStatus = await detectAgentCompletionStatus(agentDir);

    if (completionStatus !== 'DONE') continue;
    completedAgentsCount++;

    const resultPath = join(agentDir, 'agent-result.json');
    const agentResult = await readJsonFileSafe<Record<string, unknown>>(resultPath);

    if (!agentResult) {
      invalidAgents.push(`${agentId} (missing agent-result.json)`);
      continue;
    }

    const missingFields = requiredFields.filter(
      (field) => !(field in agentResult),
    );

    if (missingFields.length > 0) {
      invalidAgents.push(`${agentId} (missing: ${missingFields.join(', ')})`);
    } else {
      validAgents++;
    }
  }

  const passed = completedAgentsCount === 0 || validAgents === completedAgentsCount;

  return {
    name: 'JSON output validates against schema for all completed agents',
    passed,
    value: `${validAgents}/${completedAgentsCount} valid`,
    threshold: '100% of completed agents',
    details: passed
      ? completedAgentsCount === 0
        ? 'No completed agents to validate'
        : `All ${completedAgentsCount} completed agents have valid agent-result.json`
      : `Invalid agents: ${invalidAgents.join('; ')}`,
  };
}

/**
 * Criterion 6: Telegram monitoring received all expected judge cycles.
 * Checks for .judge-heartbeat file and judge-log.jsonl entries.
 */
async function checkJudgeMonitoring(
  resultsDir: string,
  agentDirectories: string[],
): Promise<GoNoGoCriterion> {
  // Check for judge heartbeat file
  const heartbeatPath = join(resultsDir, '.judge-heartbeat');
  const hasHeartbeat = await fileExistsSafe(heartbeatPath);

  // Check for judge-log.jsonl entries across agents
  let agentsWithJudgeLog = 0;
  let totalJudgeEntries = 0;

  for (const agentId of agentDirectories) {
    const judgeLogPath = join(resultsDir, agentId, 'judge-log.jsonl');
    try {
      const logContent = await readFile(judgeLogPath, 'utf-8');
      const entries = logContent
        .split('\n')
        .filter((line) => line.trim().length > 0);
      if (entries.length > 0) {
        agentsWithJudgeLog++;
        totalJudgeEntries += entries.length;
      }
    } catch {
      // No judge log for this agent
    }
  }

  const passed = hasHeartbeat && agentsWithJudgeLog > 0;

  return {
    name: 'Telegram monitoring received all expected judge cycles',
    passed,
    value: `heartbeat=${hasHeartbeat ? 'yes' : 'no'}, ${agentsWithJudgeLog} agents with judge logs, ${totalJudgeEntries} total entries`,
    threshold: 'heartbeat present + judge logs exist',
    details: passed
      ? `Judge heartbeat present, ${totalJudgeEntries} log entries across ${agentsWithJudgeLog} agents`
      : !hasHeartbeat
        ? 'Judge heartbeat file (.judge-heartbeat) not found in results directory'
        : 'No judge-log.jsonl entries found for any agent',
  };
}

/**
 * Criterion 7: Cost per agent within 2x of estimates (sanity check, not hard gate).
 * Compares actual cost vs expected cost range.
 * This is a soft criterion — it warns but does not block the gate.
 */
async function checkCostSanity(
  resultsDir: string,
  agentDirectories: string[],
): Promise<GoNoGoCriterion> {
  // Expected cost per agent from Phase 1 planning: ~$2-5 per agent
  const EXPECTED_COST_PER_AGENT_USD = 5.0;
  const COST_MULTIPLIER_THRESHOLD = 2.0;
  const maxAcceptableCostPerAgent =
    EXPECTED_COST_PER_AGENT_USD * COST_MULTIPLIER_THRESHOLD;

  let totalCost = 0;
  let agentsWithCost = 0;
  const costlyAgents: string[] = [];

  for (const agentId of agentDirectories) {
    const resultPath = join(resultsDir, agentId, 'agent-result.json');
    const agentResult = await readJsonFileSafe<AgentResult>(resultPath);

    if (agentResult && typeof agentResult.cost_usd === 'number') {
      totalCost += agentResult.cost_usd;
      agentsWithCost++;

      if (agentResult.cost_usd > maxAcceptableCostPerAgent) {
        costlyAgents.push(
          `${agentId} ($${agentResult.cost_usd.toFixed(2)})`,
        );
      }
    }
  }

  const averageCost = agentsWithCost > 0 ? totalCost / agentsWithCost : 0;
  // Soft gate: always passes, but reports if cost is high
  const passed = true;

  return {
    name: 'Cost per agent within 2x of estimates (soft gate)',
    passed,
    value: agentsWithCost > 0
      ? `avg $${averageCost.toFixed(2)}/agent, total $${totalCost.toFixed(2)}`
      : 'No cost data available',
    threshold: `<= $${maxAcceptableCostPerAgent.toFixed(2)}/agent (soft)`,
    details: costlyAgents.length > 0
      ? `WARNING: ${costlyAgents.length} agents exceeded 2x cost threshold: ${costlyAgents.join(', ')}`
      : agentsWithCost > 0
        ? `All ${agentsWithCost} agents within cost expectations`
        : 'No agent-result.json files with cost data found',
  };
}

// --- Public API ---

/**
 * Runs all 7 Phase 1 Go/No-Go criteria checks against a results directory.
 *
 * Criteria from CEO plan v2:
 * 1. >= 90% of Phase 1 agents complete without crashing
 * 2. Calibration agreement >= 75%
 * 3. At least 1 industry comparison prompt completes
 * 4. Smoke test framework executes without errors
 * 5. JSON output validates against schema for all completed agents
 * 6. Telegram monitoring received all expected judge cycles
 * 7. Cost per agent within 2x of estimates (soft gate)
 *
 * Returns a structured result with pass/fail for each criterion and an
 * overall passed boolean (true only if all criteria pass).
 */
export async function checkPhaseOneGate(
  resultsDir: string,
): Promise<GoNoGoResult> {
  // Discover all agent directories in the results directory
  const agentDirectories = await listDirectoriesSafe(resultsDir);

  // Run all 7 criteria checks
  const criteria = await Promise.all([
    checkCompletionRate(resultsDir, agentDirectories),
    checkCalibrationAgreement(resultsDir),
    checkIndustryPromptCompletion(resultsDir, agentDirectories),
    checkSmokeTestFramework(resultsDir, agentDirectories),
    checkSchemaValidation(resultsDir, agentDirectories),
    checkJudgeMonitoring(resultsDir, agentDirectories),
    checkCostSanity(resultsDir, agentDirectories),
  ]);

  return {
    passed: criteria.every((c) => c.passed),
    criteria,
  };
}
