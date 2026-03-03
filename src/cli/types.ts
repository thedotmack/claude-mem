/**
 * Claude-Mem CLI Type Definitions
 */

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  message: string;
  severity: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
  fixable?: boolean;
}

export interface RepairResult {
  issue: string;
  fixed: boolean;
  message: string;
  error?: Error;
}

export interface WorkerStatus {
  running: boolean;
  pid?: number;
  port?: number;
  uptime?: string;
  version?: string;
}

export interface CLIOptions {
  verbose: boolean;
  json: boolean;
  fix: boolean;
}
