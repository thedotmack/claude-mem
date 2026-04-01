import Docker from 'dockerode';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SmokeTest } from '../types.js';

// --- Error Classes ---

export class SmokeTestExecutionError extends Error {
  constructor(
    public readonly testName: string,
    public readonly reason: string,
  ) {
    super(`Smoke test "${testName}" execution failed: ${reason}`);
    this.name = 'SmokeTestExecutionError';
  }
}

export class SmokeTestTimeoutError extends Error {
  constructor(
    public readonly testName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Smoke test "${testName}" timed out after ${timeoutMs}ms`);
    this.name = 'SmokeTestTimeoutError';
  }
}

// --- Interfaces ---

export interface SmokeTestResult {
  name: string;
  command: string;
  expected: string;
  passed: boolean;
  actual: string;
  error?: string;
}

export interface SmokeResults {
  agentId: string;
  promptId: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: SmokeTestResult[];
}

// --- Expected-Clause Evaluation ---

/**
 * Parses and evaluates the `expected` mini-DSL from smoke test YAML.
 *
 * Supported clauses:
 *   - `status:CODE` — checks that `stdout` contains the HTTP status code
 *   - `contains:STRING` — checks that `stdout` contains the string (case-insensitive)
 *   - `exit_0` — checks that the exit code is 0
 */
export function evaluateExpected(
  expectedClause: string,
  stdout: string,
  exitCode: number,
): { passed: boolean; actual: string } {
  if (expectedClause.startsWith('status:')) {
    const expectedStatusCode = expectedClause.slice('status:'.length);
    // For curl -w '%{http_code}' style output, the status code appears in stdout
    const containsStatus = stdout.includes(expectedStatusCode);
    return {
      passed: containsStatus,
      actual: `stdout=${stdout.trim()}`,
    };
  }

  if (expectedClause.startsWith('contains:')) {
    const expectedSubstring = expectedClause.slice('contains:'.length);
    const containsMatch = stdout.toLowerCase().includes(expectedSubstring.toLowerCase());
    return {
      passed: containsMatch,
      actual: `stdout=${stdout.trim().slice(0, 200)}`,
    };
  }

  if (expectedClause === 'exit_0') {
    return {
      passed: exitCode === 0,
      actual: `exit_code=${exitCode}`,
    };
  }

  return {
    passed: false,
    actual: `unknown expected clause: ${expectedClause}`,
  };
}

// --- Docker Exec ---

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/**
 * Executes a command inside a running Docker container and returns stdout + exit code.
 */
async function execInContainer(
  docker: Docker,
  containerId: string,
  command: string,
  timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; exitCode: number }> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['sh', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SmokeTestTimeoutError(command, timeoutMs));
    }, timeoutMs);

    exec.start({ hijack: true, stdin: false }, (startError, stream) => {
      if (startError || !stream) {
        clearTimeout(timer);
        reject(
          new SmokeTestExecutionError(
            command,
            startError?.message ?? 'No stream returned from exec',
          ),
        );
        return;
      }

      const outputChunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        outputChunks.push(chunk);
      });

      stream.on('end', async () => {
        clearTimeout(timer);
        try {
          const inspectData = await exec.inspect();
          const rawOutput = Buffer.concat(outputChunks).toString('utf-8');
          // Docker multiplexed streams include 8-byte headers per frame.
          // Strip non-printable control characters for cleaner output.
          const stdout = rawOutput.replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, '');
          resolve({
            stdout,
            exitCode: inspectData.ExitCode ?? -1,
          });
        } catch (inspectError) {
          reject(
            new SmokeTestExecutionError(
              command,
              inspectError instanceof Error ? inspectError.message : String(inspectError),
            ),
          );
        }
      });

      stream.on('error', (streamError: Error) => {
        clearTimeout(timer);
        reject(new SmokeTestExecutionError(command, streamError.message));
      });
    });
  });
}

// --- Public API ---

/**
 * Runs smoke tests from prompt YAML frontmatter against a running Docker container.
 *
 * If `smokeTests` is empty, returns zeroed-out results with no failures.
 */
export async function runSmokeTests(
  agentId: string,
  promptId: string,
  smokeTests: SmokeTest[],
  containerId: string,
  resultsDir?: string,
): Promise<SmokeResults> {
  // Handle empty smoke_tests gracefully
  if (smokeTests.length === 0) {
    const emptyResults: SmokeResults = {
      agentId,
      promptId,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };

    if (resultsDir) {
      await writeSmokeResults(resultsDir, agentId, emptyResults);
    }

    return emptyResults;
  }

  const docker = new Docker();
  const results: SmokeTestResult[] = [];

  for (const smokeTest of smokeTests) {
    let result: SmokeTestResult;
    try {
      const { stdout, exitCode } = await execInContainer(
        docker,
        containerId,
        smokeTest.command,
      );
      const evaluation = evaluateExpected(smokeTest.expected, stdout, exitCode);
      result = {
        name: smokeTest.name,
        command: smokeTest.command,
        expected: smokeTest.expected,
        passed: evaluation.passed,
        actual: evaluation.actual,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result = {
        name: smokeTest.name,
        command: smokeTest.command,
        expected: smokeTest.expected,
        passed: false,
        actual: '',
        error: errorMessage,
      };
    }
    results.push(result);
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed && !r.error).length;
  const skippedCount = results.filter((r) => !!r.error).length;

  const smokeResults: SmokeResults = {
    agentId,
    promptId,
    total: smokeTests.length,
    passed: passedCount,
    failed: failedCount,
    skipped: skippedCount,
    results,
  };

  if (resultsDir) {
    await writeSmokeResults(resultsDir, agentId, smokeResults);
  }

  return smokeResults;
}

/**
 * Writes smoke test results to `{resultsDir}/{agentId}/smoke-results.json`.
 */
async function writeSmokeResults(
  resultsDir: string,
  agentId: string,
  smokeResults: SmokeResults,
): Promise<void> {
  const agentDir = join(resultsDir, agentId);
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'smoke-results.json'),
    JSON.stringify(smokeResults, null, 2),
  );
}
