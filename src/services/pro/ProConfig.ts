/**
 * ProConfig
 *
 * Manages Claude-Mem Pro configuration and user detection.
 * Pro configuration is stored in ~/.claude-mem/pro.json
 *
 * Configuration is set by the /pro-setup skill which:
 * 1. Validates the setup token with mem-pro API
 * 2. Stores the configuration locally
 * 3. Enables cloud sync
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { logger } from '../../utils/logger.js';

export interface ProUserConfig {
  userId: string;
  setupToken: string;
  apiUrl: string;
  pineconeNamespace: string;
  configuredAt: number;
  expiresAt: number;
  planTier: 'pro' | 'enterprise';
}

const PRO_CONFIG_PATH = join(homedir(), '.claude-mem', 'pro.json');

/**
 * Load Pro user configuration from disk
 * Returns null if not a Pro user or config is invalid/expired
 */
export function loadProConfig(): ProUserConfig | null {
  try {
    if (!existsSync(PRO_CONFIG_PATH)) {
      return null;
    }

    const content = readFileSync(PRO_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as ProUserConfig;

    // Validate required fields
    if (!config.userId || !config.setupToken || !config.apiUrl) {
      logger.warn('PRO_CONFIG', 'Invalid Pro config: missing required fields');
      return null;
    }

    // Check if expired
    if (config.expiresAt && Date.now() > config.expiresAt) {
      logger.warn('PRO_CONFIG', 'Pro config expired', {
        expiresAt: new Date(config.expiresAt).toISOString()
      });
      return null;
    }

    logger.info('PRO_CONFIG', 'Loaded Pro user config', {
      userId: config.userId.substring(0, 8) + '...',
      planTier: config.planTier
    });

    return config;
  } catch (error) {
    logger.error('PRO_CONFIG', 'Failed to load Pro config', {}, error as Error);
    return null;
  }
}

/**
 * Save Pro user configuration to disk
 */
export function saveProConfig(config: ProUserConfig): void {
  try {
    const dir = dirname(PRO_CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(PRO_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

    logger.info('PRO_CONFIG', 'Saved Pro user config', {
      userId: config.userId.substring(0, 8) + '...',
      planTier: config.planTier
    });
  } catch (error) {
    logger.error('PRO_CONFIG', 'Failed to save Pro config', {}, error as Error);
    throw error;
  }
}

/**
 * Remove Pro configuration (for logout/downgrade)
 */
export function removeProConfig(): void {
  try {
    if (existsSync(PRO_CONFIG_PATH)) {
      const { unlinkSync } = require('fs');
      unlinkSync(PRO_CONFIG_PATH);
      logger.info('PRO_CONFIG', 'Removed Pro config');
    }
  } catch (error) {
    logger.error('PRO_CONFIG', 'Failed to remove Pro config', {}, error as Error);
  }
}

/**
 * Check if user is a Pro user
 */
export function isProUser(): boolean {
  const config = loadProConfig();
  return config !== null;
}

/**
 * Validate setup token with mem-pro API
 * Returns user info if valid, throws error if invalid
 */
export async function validateSetupToken(
  apiUrl: string,
  setupToken: string
): Promise<{
  userId: string;
  pineconeNamespace: string;
  planTier: 'pro' | 'enterprise';
  expiresAt: number;
}> {
  const response = await fetch(`${apiUrl}/api/pro/validate-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ setupToken })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token validation failed: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Setup Pro user from setup token
 * Validates token and saves configuration
 */
export async function setupProUser(
  apiUrl: string,
  setupToken: string
): Promise<ProUserConfig> {
  logger.info('PRO_CONFIG', 'Setting up Pro user', { apiUrl });

  // Validate token with API
  const validation = await validateSetupToken(apiUrl, setupToken);

  // Create config
  const config: ProUserConfig = {
    userId: validation.userId,
    setupToken,
    apiUrl,
    pineconeNamespace: validation.pineconeNamespace,
    configuredAt: Date.now(),
    expiresAt: validation.expiresAt,
    planTier: validation.planTier
  };

  // Save config
  saveProConfig(config);

  logger.info('PRO_CONFIG', 'Pro user setup complete', {
    userId: config.userId.substring(0, 8) + '...',
    planTier: config.planTier
  });

  return config;
}
