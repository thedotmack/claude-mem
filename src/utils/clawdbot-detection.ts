/**
 * Clawdbot/Moltbot Environment Detection
 * 
 * Detects when claude-mem is running in a Clawdbot/moltbot environment
 * to enable compatibility mode and avoid conflicts with Clawdbot's
 * native memory management.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

export interface ClawdbotEnvironment {
  detected: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  detectionMethod: string;
  workspacePath?: string;
  features: {
    hasMemoryMd: boolean;
    hasAgentsMd: boolean;
    hasSoulMd: boolean;
    hasHeartbeatMd: boolean;
  };
}

/**
 * Clawdbot/moltbot workspace signature files.
 * Presence of 2+ indicates a moltbot-managed workspace.
 */
const MOLTBOT_SIGNATURES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'HEARTBEAT.md',
  'TOOLS.md',
  'USER.md',
  'WORKLEDGER.md',
  'MEMORY.md',
] as const;

/**
 * Clawdbot environment variables that indicate runtime context.
 */
const CLAWDBOT_ENV_VARS = [
  'CLAWDBOT_GATEWAY_TOKEN',
  'CLAWDBOT_GATEWAY_PORT',
  'CLAWDBOT_PATH_BOOTSTRAPPED',
  'CLAWDBOT_AGENT',
] as const;

/**
 * Detect Clawdbot/moltbot environment.
 * 
 * Detection priority:
 * 1. Environment variables (highest confidence)
 * 2. ~/.clawdbot/clawdbot.json config file
 * 3. Workspace signature files (AGENTS.md, SOUL.md, etc.)
 * 
 * @param workingDir - Current working directory to check for workspace files
 * @returns Detection result with confidence level and features
 */
export function detectClawdbotEnvironment(workingDir: string = process.cwd()): ClawdbotEnvironment {
  const result: ClawdbotEnvironment = {
    detected: false,
    confidence: 'none',
    detectionMethod: 'none',
    features: {
      hasMemoryMd: false,
      hasAgentsMd: false,
      hasSoulMd: false,
      hasHeartbeatMd: false,
    },
  };

  // 1. Check environment variables (highest priority)
  for (const envVar of CLAWDBOT_ENV_VARS) {
    if (process.env[envVar]) {
      result.detected = true;
      result.confidence = 'high';
      result.detectionMethod = `env:${envVar}`;
      logger.debug(`Clawdbot detected via env var: ${envVar}`);
      break;
    }
  }

  // 2. Check for Clawdbot config file
  const clawdbotConfigPath = join(homedir(), '.clawdbot', 'clawdbot.json');
  if (!result.detected && existsSync(clawdbotConfigPath)) {
    result.detected = true;
    result.confidence = 'high';
    result.detectionMethod = 'config:~/.clawdbot/clawdbot.json';
    logger.debug('Clawdbot detected via config file');
  }

  // 3. Check workspace signature files
  let signatureCount = 0;
  for (const signature of MOLTBOT_SIGNATURES) {
    const filePath = join(workingDir, signature);
    if (existsSync(filePath)) {
      signatureCount++;
      
      // Track specific features
      if (signature === 'MEMORY.md') result.features.hasMemoryMd = true;
      if (signature === 'AGENTS.md') result.features.hasAgentsMd = true;
      if (signature === 'SOUL.md') result.features.hasSoulMd = true;
      if (signature === 'HEARTBEAT.md') result.features.hasHeartbeatMd = true;
    }
  }

  // 2+ signatures = moltbot workspace
  if (signatureCount >= 2 && !result.detected) {
    result.detected = true;
    result.confidence = signatureCount >= 4 ? 'high' : 'medium';
    result.detectionMethod = `workspace:${signatureCount}_signatures`;
    result.workspacePath = workingDir;
    logger.debug(`Clawdbot detected via ${signatureCount} workspace signatures`);
  } else if (signatureCount === 1 && !result.detected) {
    // Single signature = weak signal
    result.confidence = 'low';
    result.detectionMethod = `workspace:1_signature`;
  }

  if (result.detected) {
    logger.info(`Clawdbot environment detected (${result.confidence} confidence via ${result.detectionMethod})`);
  }

  return result;
}

/**
 * Check if claude-mem should operate in Clawdbot compatibility mode.
 * 
 * In compatibility mode:
 * - Avoids duplicating memory that Clawdbot already manages
 * - Respects Clawdbot's MEMORY.md as the source of truth
 * - Can optionally sync observations to Clawdbot's memory format
 * 
 * @param env - Detection result from detectClawdbotEnvironment()
 * @returns true if compatibility mode should be enabled
 */
export function shouldUseCompatibilityMode(env: ClawdbotEnvironment): boolean {
  // Enable compatibility mode if:
  // 1. Clawdbot is detected with high/medium confidence
  // 2. Clawdbot has its own MEMORY.md
  return env.detected && 
         (env.confidence === 'high' || env.confidence === 'medium') &&
         env.features.hasMemoryMd;
}

/**
 * Get Clawdbot workspace path from environment or detection.
 * 
 * @returns Workspace path or undefined if not detected
 */
export function getClawdbotWorkspacePath(): string | undefined {
  // Check CLAWDBOT_WORKSPACE env var first
  if (process.env.CLAWDBOT_WORKSPACE) {
    return process.env.CLAWDBOT_WORKSPACE;
  }
  
  // Check PWD if in Clawdbot env
  if (process.env.CLAWDBOT_PATH_BOOTSTRAPPED) {
    return process.cwd();
  }

  return undefined;
}
