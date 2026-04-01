import { readdir, readFile, mkdir, writeFile, cp, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import type { Prompt } from '../types.js';
import type { SmokeResults } from './smoke-runner.js';

// --- Error Classes ---

export class JudgeApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(`Claude API returned status ${statusCode}: ${responseBody}`);
    this.name = 'JudgeApiError';
  }
}

export class JudgeRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super(
      `Claude API rate limited${retryAfterSeconds ? `, retry after ${retryAfterSeconds}s` : ''}`,
    );
    this.name = 'JudgeRateLimitError';
  }
}

export class JudgeTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Claude API request timed out after ${timeoutMs}ms`);
    this.name = 'JudgeTimeoutError';
  }
}

export class JudgeMalformedResponseError extends Error {
  constructor(
    public readonly rawResponse: string,
    public readonly reason: string,
  ) {
    super(`Failed to parse judge response: ${reason}`);
    this.name = 'JudgeMalformedResponseError';
  }
}

export class JudgeRefusalError extends Error {
  constructor(public readonly rawResponse: string) {
    super('Judge refused to evaluate the project');
    this.name = 'JudgeRefusalError';
  }
}

// --- Interfaces ---

export interface JudgeScores {
  functionality: number;
  code_quality: number;
  ux: number;
  completeness: number;
  reasoning: {
    functionality: string;
    code_quality: string;
    ux: string;
    completeness: string;
  };
}

export interface JudgeResult {
  agentId: string;
  promptId: string;
  scores: JudgeScores;
  blinded: boolean;
  judgeModel: string;
  timestamp: string;
}

// --- Blinding ---

const AGENT_ID_PATTERNS = [
  /cmem-\d+-[\w-]+/g,
  /vanilla-\d+-[\w-]+/g,
  /claude-mem/gi,
  /claude_mem/gi,
  /claudemem/gi,
];

const MEMORY_FILE_NAMES = ['MEMORY.md', 'memory.md'];

/**
 * Copies a project directory to a temp location with all identifying
 * information stripped (agent IDs, claude-mem references, MEMORY.md files).
 */
export async function blindProject(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  // Copy the entire directory
  await cp(sourceDir, targetDir, { recursive: true });

  // Remove .claude-mem directories
  await removeDirectoryIfExists(join(targetDir, '.claude-mem'));

  // Remove MEMORY.md files
  for (const memFile of MEMORY_FILE_NAMES) {
    await removeFileIfExists(join(targetDir, memFile));
  }

  // Walk all files and strip identifying content
  await stripIdentifyingContent(targetDir);
}

async function removeDirectoryIfExists(dirPath: string): Promise<void> {
  try {
    const dirStat = await stat(dirPath);
    if (dirStat.isDirectory()) {
      await rm(dirPath, { recursive: true, force: true });
    }
  } catch {
    // Directory doesn't exist, nothing to do
  }
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // File doesn't exist, nothing to do
  }
}

async function stripIdentifyingContent(dirPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      await stripIdentifyingContent(fullPath);
      continue;
    }

    if (!entryStat.isFile()) continue;

    // Only process text-like files (skip binaries)
    if (isLikelyBinaryExtension(entry)) continue;

    try {
      let content = await readFile(fullPath, 'utf-8');
      let modified = false;

      for (const pattern of AGENT_ID_PATTERNS) {
        const newContent = content.replace(pattern, '[REDACTED]');
        if (newContent !== content) {
          content = newContent;
          modified = true;
        }
      }

      // Remove references to ~/.claude-mem/
      const claudeMemPathPattern = /~\/\.claude-mem\/?[^\s"]*/g;
      const newContent = content.replace(claudeMemPathPattern, '[REDACTED_PATH]');
      if (newContent !== content) {
        content = newContent;
        modified = true;
      }

      if (modified) {
        await writeFile(fullPath, content);
      }
    } catch {
      // Skip files we can't read as text
    }
  }
}

function isLikelyBinaryExtension(filename: string): boolean {
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.zip', '.gz', '.tar', '.br', '.zst',
    '.pdf', '.doc', '.docx',
    '.exe', '.dll', '.so', '.dylib',
    '.db', '.sqlite', '.sqlite3',
    '.wasm',
    '.mp3', '.mp4', '.wav', '.avi', '.mov',
  ]);
  const lowerName = filename.toLowerCase();
  for (const ext of binaryExtensions) {
    if (lowerName.endsWith(ext)) return true;
  }
  return false;
}

// --- File Listing ---

async function listProjectFiles(
  dirPath: string,
  basePath: string = dirPath,
): Promise<string[]> {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return files;
  }

  for (const entry of entries) {
    // Skip node_modules, .git, etc.
    if (entry === 'node_modules' || entry === '.git' || entry === '.next') continue;

    const fullPath = join(dirPath, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      const subFiles = await listProjectFiles(fullPath, basePath);
      files.push(...subFiles);
    } else {
      files.push(relative(basePath, fullPath));
    }
  }

  return files.sort();
}

// --- Judge Prompt Construction ---

function constructJudgePrompt(
  rubricContent: string,
  prompt: Prompt,
  projectFiles: string[],
  smokeResults: SmokeResults,
  fewShotExamples?: string,
): string {
  const fileListingSection = projectFiles.length > 0
    ? projectFiles.map((f) => `  - ${f}`).join('\n')
    : '  (no files found)';

  const smokeTestSection = smokeResults.results.length > 0
    ? smokeResults.results
        .map(
          (r) =>
            `  - ${r.name}: ${r.passed ? 'PASSED' : 'FAILED'} (expected: ${r.expected}, actual: ${r.actual}${r.error ? `, error: ${r.error}` : ''})`,
        )
        .join('\n')
    : '  (no smoke tests)';

  const fewShotSection = fewShotExamples
    ? `\n## Calibration Examples\nHere are examples of previously scored projects for reference:\n${fewShotExamples}\n`
    : '';

  return `You are an expert code reviewer evaluating a software project built by an AI agent.

## Evaluation Rubric
${rubricContent}

## Task Specification
Title: ${prompt.frontmatter.title}
Category: ${prompt.frontmatter.category}

${prompt.body}
${fewShotSection}
## Project Files
${fileListingSection}

## Smoke Test Results
Total: ${smokeResults.total}, Passed: ${smokeResults.passed}, Failed: ${smokeResults.failed}, Skipped: ${smokeResults.skipped}
${smokeTestSection}

## Instructions
Evaluate this project on the 4 dimensions defined in the rubric. For each dimension, provide:
1. A score from 1 to 9 (odd numbers match the anchor descriptions; even numbers are between anchors)
2. A brief reasoning (1-2 sentences) explaining the score

Respond with ONLY a JSON object in this exact format (no markdown fencing, no extra text):
{
  "functionality": <score>,
  "code_quality": <score>,
  "ux": <score>,
  "completeness": <score>,
  "reasoning": {
    "functionality": "<reasoning>",
    "code_quality": "<reasoning>",
    "ux": "<reasoning>",
    "completeness": "<reasoning>"
  }
}`;
}

// --- Response Parsing ---

function parseJudgeResponse(responseText: string): JudgeScores {
  // Try to extract JSON from the response
  let jsonText = responseText.trim();

  // Strip markdown code fences if present
  const jsonBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    jsonText = jsonBlockMatch[1].trim();
  }

  // Try to find a JSON object in the text
  const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
  if (!jsonObjectMatch) {
    throw new JudgeMalformedResponseError(
      responseText,
      'No JSON object found in response',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObjectMatch[0]);
  } catch (parseError) {
    throw new JudgeMalformedResponseError(
      responseText,
      `Invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new JudgeMalformedResponseError(
      responseText,
      'Parsed value is not an object',
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required numeric fields
  const dimensions = ['functionality', 'code_quality', 'ux', 'completeness'] as const;
  for (const dim of dimensions) {
    if (typeof obj[dim] !== 'number' || obj[dim] < 1 || obj[dim] > 9) {
      throw new JudgeMalformedResponseError(
        responseText,
        `Missing or invalid score for "${dim}" (must be 1-9, got ${JSON.stringify(obj[dim])})`,
      );
    }
  }

  // Validate reasoning
  if (typeof obj.reasoning !== 'object' || obj.reasoning === null) {
    throw new JudgeMalformedResponseError(
      responseText,
      'Missing "reasoning" object',
    );
  }

  const reasoning = obj.reasoning as Record<string, unknown>;
  for (const dim of dimensions) {
    if (typeof reasoning[dim] !== 'string') {
      throw new JudgeMalformedResponseError(
        responseText,
        `Missing reasoning for "${dim}"`,
      );
    }
  }

  // Check for refusal indicators
  const responseTextLower = responseText.toLowerCase();
  if (
    responseTextLower.includes('i cannot evaluate') ||
    responseTextLower.includes('i refuse to')
  ) {
    throw new JudgeRefusalError(responseText);
  }

  return {
    functionality: obj.functionality as number,
    code_quality: obj.code_quality as number,
    ux: obj.ux as number,
    completeness: obj.completeness as number,
    reasoning: {
      functionality: reasoning.functionality as string,
      code_quality: reasoning.code_quality as string,
      ux: reasoning.ux as string,
      completeness: reasoning.completeness as string,
    },
  };
}

// --- Claude API ---

const DEFAULT_API_TIMEOUT_MS = 120_000;

async function callClaudeApi(
  judgePrompt: string,
  apiKey: string,
  model: string,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: judgePrompt }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new JudgeTimeoutError(timeoutMs);
    }
    throw new JudgeApiError(
      0,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader
      ? parseInt(retryAfterHeader, 10)
      : null;
    throw new JudgeRateLimitError(
      retryAfterSeconds && !isNaN(retryAfterSeconds) ? retryAfterSeconds : null,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new JudgeApiError(response.status, body);
  }

  const responseJson = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = responseJson.content?.find((block) => block.type === 'text');
  if (!textBlock?.text) {
    throw new JudgeMalformedResponseError(
      JSON.stringify(responseJson),
      'No text content in API response',
    );
  }

  return textBlock.text;
}

// --- Public API ---

/**
 * Evaluates an agent's project using the Claude API as an LLM judge.
 *
 * 1. Blinds the project by copying to a temp dir and stripping identifiers
 * 2. Constructs a judge prompt with rubric, spec, file listing, and smoke results
 * 3. Calls the Claude API
 * 4. Parses the structured response into dimension scores + reasoning
 * 5. Writes results to the results directory
 */
export async function evaluateAgent(
  agentId: string,
  prompt: Prompt,
  projectDir: string,
  smokeResults: SmokeResults,
  rubricPath: string,
  apiKey: string,
  model: string,
  resultsDir?: string,
  fewShotExamples?: string,
): Promise<JudgeResult> {
  // Read rubric
  const rubricContent = await readFile(rubricPath, 'utf-8');

  // Blind the project
  const blindedDir = join(
    tmpdir(),
    `benchmark-judge-${agentId}-${Date.now()}`,
  );
  await blindProject(projectDir, blindedDir);

  try {
    // List project files
    const projectFiles = await listProjectFiles(blindedDir);

    // Construct judge prompt
    const judgePrompt = constructJudgePrompt(
      rubricContent,
      prompt,
      projectFiles,
      smokeResults,
      fewShotExamples,
    );

    // Call Claude API
    const responseText = await callClaudeApi(judgePrompt, apiKey, model);

    // Parse response
    const scores = parseJudgeResponse(responseText);

    const judgeResult: JudgeResult = {
      agentId,
      promptId: prompt.frontmatter.id,
      scores,
      blinded: true,
      judgeModel: model,
      timestamp: new Date().toISOString(),
    };

    // Write results
    if (resultsDir) {
      const agentResultsDir = join(resultsDir, agentId);
      await mkdir(agentResultsDir, { recursive: true });
      await writeFile(
        join(agentResultsDir, 'judge-scores.json'),
        JSON.stringify(judgeResult, null, 2),
      );
    }

    return judgeResult;
  } finally {
    // Clean up blinded directory
    await rm(blindedDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Exported for use by calibration module
export {
  constructJudgePrompt,
  parseJudgeResponse,
  callClaudeApi,
  listProjectFiles,
};
