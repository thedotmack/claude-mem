import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SmokeResults } from './smoke-runner.js';
import type { JudgeScores } from './llm-judge.js';
import {
  constructJudgePrompt,
  parseJudgeResponse,
  callClaudeApi,
  listProjectFiles,
  blindProject,
} from './llm-judge.js';
import type { Prompt } from '../types.js';

// --- Error Classes ---

export class CalibrationError extends Error {
  constructor(public readonly reason: string) {
    super(`Calibration failed: ${reason}`);
    this.name = 'CalibrationError';
  }
}

export class CalibrationDataNotFoundError extends Error {
  constructor(public readonly calibrationDir: string) {
    super(`Calibration data directory not found: ${calibrationDir}`);
    this.name = 'CalibrationDataNotFoundError';
  }
}

// --- Interfaces ---

export interface CalibrationEntry {
  projectName: string;
  humanScores: JudgeScores;
  llmScores: JudgeScores | null;
  agreement: { [dimension: string]: boolean };
}

export interface CalibrationReport {
  totalProjects: number;
  agreementPercentage: number;
  perDimension: { [dimension: string]: number };
  passed: boolean;
  iterations: number;
  entries: CalibrationEntry[];
}

// --- Agreement Calculation ---

const SCORE_DIMENSIONS = [
  'functionality',
  'code_quality',
  'ux',
  'completeness',
] as const;

type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/**
 * Compares human scores against LLM scores with a +/-1 tolerance per dimension.
 * Returns a mapping of dimension -> boolean (true = agreement).
 */
export function calculateAgreement(
  humanScores: JudgeScores,
  llmScores: JudgeScores,
): { [dimension: string]: boolean } {
  const agreement: { [dimension: string]: boolean } = {};

  for (const dim of SCORE_DIMENSIONS) {
    const humanScore = humanScores[dim] as number;
    const llmScore = llmScores[dim] as number;
    agreement[dim] = Math.abs(humanScore - llmScore) <= 1;
  }

  return agreement;
}

/**
 * Calculates overall agreement percentage from a set of calibration entries.
 */
function calculateOverallAgreement(entries: CalibrationEntry[]): {
  agreementPercentage: number;
  perDimension: { [dimension: string]: number };
} {
  if (entries.length === 0) {
    return {
      agreementPercentage: 100,
      perDimension: Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d, 100])),
    };
  }

  const perDimension: { [dimension: string]: number } = {};
  let totalAgreements = 0;
  let totalComparisons = 0;

  for (const dim of SCORE_DIMENSIONS) {
    const agreementCount = entries.filter(
      (e) => e.agreement[dim] === true,
    ).length;
    perDimension[dim] = (agreementCount / entries.length) * 100;
    totalAgreements += agreementCount;
    totalComparisons += entries.length;
  }

  const agreementPercentage =
    totalComparisons > 0 ? (totalAgreements / totalComparisons) * 100 : 100;

  return { agreementPercentage, perDimension };
}

// --- Calibration Data Loading ---

interface CalibrationProject {
  projectName: string;
  projectDir: string;
  humanScores: JudgeScores;
  prompt: Prompt;
  smokeResults: SmokeResults;
}

async function loadCalibrationProjects(
  calibrationDir: string,
): Promise<CalibrationProject[]> {
  let entries: string[];
  try {
    entries = await readdir(calibrationDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new CalibrationError(
      `Failed to read calibration directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const projects: CalibrationProject[] = [];

  for (const entry of entries.sort()) {
    const projectDir = join(calibrationDir, entry);
    let entryStat;
    try {
      entryStat = await stat(projectDir);
    } catch {
      continue;
    }

    if (!entryStat.isDirectory()) continue;

    // Read human-scores.json
    const humanScoresPath = join(projectDir, 'human-scores.json');
    let humanScoresContent: string;
    try {
      humanScoresContent = await readFile(humanScoresPath, 'utf-8');
    } catch {
      // Skip projects without human scores
      continue;
    }

    let humanScores: JudgeScores;
    try {
      humanScores = JSON.parse(humanScoresContent) as JudgeScores;
    } catch {
      throw new CalibrationError(
        `Invalid human-scores.json in ${entry}: malformed JSON`,
      );
    }

    // Read prompt.json for the task specification
    const promptPath = join(projectDir, 'prompt.json');
    let prompt: Prompt;
    try {
      const promptContent = await readFile(promptPath, 'utf-8');
      prompt = JSON.parse(promptContent) as Prompt;
    } catch {
      // Use a minimal default prompt if not provided
      prompt = {
        frontmatter: {
          id: entry,
          title: entry,
          category: 'web',
          timeout_hint: '4h',
          industry_baseline: {
            source: 'none',
            reference_cost_usd: null,
            reference_duration_seconds: null,
            reference_architecture: null,
          },
          smoke_tests: [],
        },
        body: 'Calibration project',
        filePath: '',
      };
    }

    // Read smoke-results.json
    const smokeResultsPath = join(projectDir, 'smoke-results.json');
    let smokeResults: SmokeResults;
    try {
      const smokeResultsContent = await readFile(smokeResultsPath, 'utf-8');
      smokeResults = JSON.parse(smokeResultsContent) as SmokeResults;
    } catch {
      // Default empty smoke results
      smokeResults = {
        agentId: entry,
        promptId: entry,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        results: [],
      };
    }

    projects.push({
      projectName: entry,
      projectDir,
      humanScores,
      prompt,
      smokeResults,
    });
  }

  return projects;
}

// --- Few-Shot Example Generation ---

function generateFewShotExamples(entries: CalibrationEntry[]): string {
  // Pick entries where there was disagreement to calibrate the judge
  const disagreements = entries.filter((e) =>
    SCORE_DIMENSIONS.some((dim) => !e.agreement[dim]),
  );

  if (disagreements.length === 0) return '';

  const examples = disagreements.slice(0, 3).map((entry) => {
    const scoreLines = SCORE_DIMENSIONS.map((dim) => {
      const humanVal = entry.humanScores[dim] as number;
      const llmVal = entry.llmScores ? (entry.llmScores[dim] as number) : 'N/A';
      const agreed = entry.agreement[dim] ? 'OK' : 'DISAGREED';
      return `    ${dim}: human=${humanVal}, llm=${llmVal} (${agreed})`;
    }).join('\n');

    return `Project "${entry.projectName}":\n${scoreLines}\n  Correct scores (human): functionality=${entry.humanScores.functionality}, code_quality=${entry.humanScores.code_quality}, ux=${entry.humanScores.ux}, completeness=${entry.humanScores.completeness}`;
  });

  return examples.join('\n\n');
}

// --- Public API ---

const PASSING_AGREEMENT_THRESHOLD = 75;
const MAX_CALIBRATION_ITERATIONS = 3;

/**
 * Runs the calibration pipeline:
 *
 * 1. Loads calibration projects with human scores
 * 2. Runs LLM judge on each project
 * 3. Compares LLM vs human scores (allowing +/-1 tolerance)
 * 4. If agreement < 75%, generates few-shot examples and re-calibrates (up to 3 iterations)
 * 5. Returns a detailed report
 *
 * Handles empty/missing calibration data gracefully — returns passed=true (vacuously true).
 */
export async function runCalibration(
  calibrationDir: string,
  rubricPath: string,
  apiKey: string,
  model: string,
): Promise<CalibrationReport> {
  // Load calibration projects
  const projects = await loadCalibrationProjects(calibrationDir);

  // Handle empty calibration data gracefully
  if (projects.length === 0) {
    return {
      totalProjects: 0,
      agreementPercentage: 100,
      perDimension: Object.fromEntries(
        SCORE_DIMENSIONS.map((d) => [d, 100]),
      ),
      passed: true,
      iterations: 0,
      entries: [],
    };
  }

  // Read rubric
  const rubricContent = await readFile(rubricPath, 'utf-8');

  let entries: CalibrationEntry[] = [];
  let fewShotExamples: string | undefined;
  let iteration = 0;

  while (iteration < MAX_CALIBRATION_ITERATIONS) {
    iteration++;
    entries = [];

    for (const project of projects) {
      let llmScores: JudgeScores | null = null;
      let agreement: { [dimension: string]: boolean } = {};

      try {
        // List files in the project
        const projectFiles = await listProjectFiles(project.projectDir);

        // Construct judge prompt (same as real eval)
        const judgePrompt = constructJudgePrompt(
          rubricContent,
          project.prompt,
          projectFiles,
          project.smokeResults,
          fewShotExamples,
        );

        // Call Claude API
        const responseText = await callClaudeApi(judgePrompt, apiKey, model);

        // Parse response
        llmScores = parseJudgeResponse(responseText);

        // Calculate agreement
        agreement = calculateAgreement(project.humanScores, llmScores);
      } catch (error) {
        // If judge fails on a calibration project, mark all dimensions as disagreement
        agreement = Object.fromEntries(
          SCORE_DIMENSIONS.map((d) => [d, false]),
        );
      }

      entries.push({
        projectName: project.projectName,
        humanScores: project.humanScores,
        llmScores,
        agreement,
      });
    }

    const { agreementPercentage, perDimension } =
      calculateOverallAgreement(entries);

    if (agreementPercentage >= PASSING_AGREEMENT_THRESHOLD) {
      return {
        totalProjects: projects.length,
        agreementPercentage,
        perDimension,
        passed: true,
        iterations: iteration,
        entries,
      };
    }

    // Generate few-shot examples from disagreements for the next iteration
    fewShotExamples = generateFewShotExamples(entries);
  }

  // Final report after exhausting iterations
  const { agreementPercentage, perDimension } =
    calculateOverallAgreement(entries);

  return {
    totalProjects: projects.length,
    agreementPercentage,
    perDimension,
    passed: agreementPercentage >= PASSING_AGREEMENT_THRESHOLD,
    iterations: iteration,
    entries,
  };
}
