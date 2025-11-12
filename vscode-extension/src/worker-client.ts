/**
 * Worker Client for VSCode Extension
 * Communicates with claude-mem worker service via HTTP
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Constants
const HEALTH_CHECK_TIMEOUT_MS = 1000;
const DEFAULT_WORKER_PORT = 37777;

/**
 * Get the worker port number
 * Priority: ~/.claude-mem/settings.json > env var > default
 */
export function getWorkerPort(): number {
  try {
    const settingsPath = path.join(os.homedir(), '.claude-mem', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const port = parseInt(settings.env?.CLAUDE_MEM_WORKER_PORT, 10);
      if (!isNaN(port)) return port;
    }
  } catch {
    // Fall through to env var or default
  }
  return parseInt(process.env.CLAUDE_MEM_WORKER_PORT || String(DEFAULT_WORKER_PORT), 10);
}

/**
 * Check if worker is responsive by trying the health endpoint
 */
export async function isWorkerHealthy(): Promise<boolean> {
  try {
    const port = getWorkerPort();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Session data stored per conversation
 */
export interface SessionData {
  sessionDbId: number;
  conversationId: string;
  project: string;
  promptNumber: number;
}

/**
 * Initialize a new session
 */
export async function initSession(
  sessionDbId: number,
  project: string,
  userPrompt: string,
  promptNumber: number
): Promise<void> {
  const port = getWorkerPort();

  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, userPrompt, promptNumber }),
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to initialize session: ${response.status} ${errorText}`);
  }
}

/**
 * Record an observation (tool usage)
 */
export async function recordObservation(
  sessionDbId: number,
  toolName: string,
  toolInput: string,
  toolResponse: string,
  promptNumber: number,
  cwd?: string
): Promise<void> {
  const port = getWorkerPort();

  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/observations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      prompt_number: promptNumber,
      cwd: cwd || ''
    }),
    signal: AbortSignal.timeout(2000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to record observation: ${response.status} ${errorText}`);
  }
}

/**
 * Generate session summary
 */
export async function generateSummary(
  sessionDbId: number,
  promptNumber: number,
  lastUserMessage?: string
): Promise<void> {
  const port = getWorkerPort();

  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt_number: promptNumber,
      last_user_message: lastUserMessage || ''
    }),
    signal: AbortSignal.timeout(2000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to generate summary: ${response.status} ${errorText}`);
  }
}

/**
 * Mark session as complete
 */
export async function completeSession(sessionDbId: number): Promise<void> {
  const port = getWorkerPort();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/complete`, {
      method: 'POST',
      signal: AbortSignal.timeout(1000)
    });

    if (!response.ok) {
      console.warn(`Failed to complete session: ${response.status}`);
    }
  } catch (err) {
    // Non-critical - worker might be down
    console.warn('Failed to notify worker of session completion:', err);
  }
}

/**
 * Get session status
 */
export async function getSessionStatus(sessionDbId: number): Promise<any> {
  const port = getWorkerPort();

  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/status`, {
    method: 'GET',
    signal: AbortSignal.timeout(1000)
  });

  if (!response.ok) {
    throw new Error(`Failed to get session status: ${response.status}`);
  }

  return response.json();
}

/**
 * Open the viewer UI
 */
export function getViewerUrl(): string {
  const port = getWorkerPort();
  return `http://localhost:${port}`;
}
