import { appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Usage data structure from Claude Agent SDK result messages
 */
export interface UsageData {
  timestamp: string;
  sessionDbId: number;
  claudeSessionId: string;
  project: string;
  promptNumber: number;
  model: string;
  sessionId: string; // SDK session ID
  uuid: string; // SDK message UUID
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

/**
 * Logger for capturing usage metrics to JSONL files
 */
export class UsageLogger {
  private logDir: string;
  private logFile: string;

  constructor() {
    this.logDir = join(homedir(), '.claude-mem', 'usage-logs');
    // Create a daily log file
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    this.logFile = join(this.logDir, `usage-${date}.jsonl`);
  }

  /**
   * Log usage data from SDK result message
   */
  logUsage(data: UsageData): void {
    try {
      const line = JSON.stringify(data) + '\n';
      appendFileSync(this.logFile, line, 'utf-8');
    } catch (error) {
      console.error('Failed to log usage data:', error);
    }
  }

  /**
   * Get the current log file path
   */
  getLogFilePath(): string {
    return this.logFile;
  }
}
