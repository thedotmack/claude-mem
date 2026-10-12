import path from 'path';
import { homedir } from 'os';

/** Kimi Code data root: $KIMI_CODE_HOME when set, else ~/.kimi-code. */
export function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code');
}

export function kimiConfigPath(): string {
  return path.join(kimiCodeHome(), 'config.toml');
}

export function kimiMcpJsonPath(): string {
  return path.join(kimiCodeHome(), 'mcp.json');
}
