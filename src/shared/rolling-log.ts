import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PathDiscovery } from '../services/path-discovery.js';

let logPath: string | null = null;

function ensureLogPath(): string {
  if (logPath) {
    return logPath;
  }

  const discovery = PathDiscovery.getInstance();
  const logsDir = discovery.getLogsDirectory();

  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  logPath = join(logsDir, 'rolling-memory.log');
  return logPath;
}

export type RollingLogLevel = 'debug' | 'info' | 'warn' | 'error';

export function rollingLog(
  level: RollingLogLevel,
  message: string,
  payload: Record<string, unknown> = {}
): void {
  try {
    const file = ensureLogPath();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...payload
    };
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging should never throw user-facing errors
  }
}
